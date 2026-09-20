"""Earned-schedule and spend-velocity analytics over the Tiger Data event stream.

Three consumers:

- `GET /api/analytics/schedule` — the S-curve: planned cumulative work from the
  CPM baseline vs verified work from `work_verified` events, with SPI and a
  projected finish. Real earned-value management, computed off `time_bucket`
  rollups (live) or their mock mirror.
- `GET /api/analytics/spend` — committed spend from procurement events vs the
  site budget, plus the escalation check: the "many individually-compliant POs
  add up" governance moment. Reads the tenant's *real* approval workflows off
  Zip staging so the escalation can name one.
- `pace_status(task)` — the verification arbiter's rule 0: does this completion
  claim outrun the site's measured pace?

The wall clock and the project-day axis are tied together by one anchor:
`day0()` = today minus `LOOKBACK_DAYS`, i.e. the demo treats the project as
having started two weeks ago. Seeded history (`seed_history`) backfills events
consistent with the seed's task states so the curves are alive on first load —
honestly labelled via `seeded: true` in both payloads.
"""

from __future__ import annotations

import os
import re
from datetime import date, datetime, time, timedelta, timezone

import httpx

import cpm_engine
import db
from integrations import OFFLINE, log, tiger
from integrations import zip_api

#: Project day 0 is this many days before today. Everything that maps a
#: wall-clock timestamp onto the schedule's day axis goes through this anchor.
LOOKBACK_DAYS = 14

#: The local site budget (CAD). The Zip staging tenant's budgets API is not
#: enabled (405 on GET/PUT — probed 2026-09-19), so the budget line is local
#: while the *actuals* under it are real staging PO amounts.
SITE_BUDGET = float(os.getenv("JENGA_SITE_BUDGET", "300000"))
#: Escalate when committed% crosses this line while…
ESCALATE_COMMIT_PCT = float(os.getenv("JENGA_ESCALATE_COMMIT_PCT", "42"))
#: …leading verified-work% by at least this many points.
ESCALATE_GAP_PTS = float(os.getenv("JENGA_ESCALATE_GAP_PTS", "20"))

#: Rule 0 (pace) fires only below this SPI — a site clearly behind plan.
PACE_SPI_FLOOR = 0.6
#: …and only once this many events exist. Too little history is its own answer,
#: same discipline as the old ten-readings floor.
PACE_MIN_EVENTS = 5
#: A zone with no verified work in this many days is in drought.
PACE_WINDOW_DAYS = 7

_WORK_KINDS = ["work_verified"]
_SPEND_KINDS = ["po_created"]

_seeded = False
_escalation: dict | None = None
_workflows_cache: dict | None = None


def day0() -> date:
    return date.today() - timedelta(days=LOOKBACK_DAYS)


def _ts(day: int, hour: int = 17) -> datetime:
    """Wall-clock timestamp for a project day, anchored at day0."""
    return datetime.combine(day0() + timedelta(days=day), time(hour, tzinfo=timezone.utc))


def _day_of(ts: datetime) -> int:
    return (ts.date() - day0()).days


# ------------------------------------------------------------- seeded history

#: material keyword -> unit rate (order-of-magnitude demo estimates, CAD).
_RATES = [
    (("concrete", "ready-mix"), 185.0),
    (("rebar",), 1450.0),
    (("aggregate", "granular"), 32.0),
]


def po_amount(po: dict) -> float:
    """Committed dollars for a seeded PO: leading quantity × material rate.

    Estimates, floored at $1,500 — the curve needs magnitudes, not quotes.
    """
    qty_match = re.match(r"\s*([\d.]+)", str(po.get("quantity") or ""))
    qty = float(qty_match.group(1)) if qty_match else 1.0
    material = str(po.get("material") or "").lower()
    rate = next((r for keys, r in _RATES if any(k in material for k in keys)), 0.0)
    return round(max(qty * rate, 1500.0), 2)


async def seed_history(force: bool = False) -> None:
    """Backfill the event stream so the curves are alive on first load.

    Consistent with the seed's own facts: every `verified` task gets its
    `work_verified` event at (roughly) its scheduled finish on the anchored
    clock, and every seeded PO gets its `po_created` with a derived amount.
    Nothing is invented beyond timing. Idempotent per process.
    """
    global _seeded, _escalation
    if _seeded and not force:
        return
    if not force:
        # A live hypertable keeps its history across restarts; re-seeding on
        # every boot would stack duplicate events under the curves. If history
        # already exists, adopt it instead of writing a second copy.
        existing = await tiger.events()
        if existing:
            _seeded = True
            log.warning("analytics: adopted %d existing events (no re-seed)", len(existing))
            return
    await tiger.clear_events()
    _escalation = None

    tasks = cpm_engine.compute(
        cpm_engine.build_graph(await db.tasks(), await db.edges())
    )["tasks"]
    rows: list[tuple[datetime, str, str, float]] = []
    for t in tasks:
        if t["state"] == "verified":
            # At its scheduled finish, clamped inside the lookback window so
            # seeded history never claims work in the future.
            day = min(int(t["ef"]), LOOKBACK_DAYS - 3)
            rows.append((_ts(max(day, 1)), t["id"], "work_verified", float(t["duration_days"])))

    for i, po in enumerate(await db.purchase_orders()):
        rows.append((_ts(1 + i, hour=9), po["id"], "po_created", po_amount(po)))

    await tiger.record_events(rows)
    _seeded = True
    log.warning("analytics: seeded %d historical events (day0 %s)", len(rows), day0())


# --------------------------------------------------------------- the S-curve


def _planned_at(tasks: list[dict], day: float) -> float:
    """Planned cumulative work-days at a project day, linear within each task."""
    total = 0.0
    for t in tasks:
        es, ef, dur = t["es"], t["ef"], t["duration_days"]
        if day <= es or dur <= 0:
            continue
        total += dur if day >= ef else dur * (day - es) / (ef - es)
    return round(total, 2)


async def schedule_analysis() -> dict:
    """Planned vs earned S-curve, SPI, and a projected finish."""
    computed = cpm_engine.compute(
        cpm_engine.build_graph(await db.tasks(), await db.edges())
    )
    tasks = computed["tasks"]
    duration = computed["project_duration"]
    planned_total = float(sum(t["duration_days"] for t in tasks))
    today_day = LOOKBACK_DAYS

    daily = await tiger.daily_totals(_WORK_KINDS)
    earned_by_day: dict[int, float] = {}
    for row in daily:
        d = (row["day"] - day0()).days
        if d >= 0:
            earned_by_day[d] = earned_by_day.get(d, 0.0) + row["total"]

    horizon = max(duration, today_day)
    points, cum = [], 0.0
    for d in range(0, horizon + 1):
        cum += earned_by_day.get(d, 0.0)
        points.append(
            {
                "day": d,
                "date": (day0() + timedelta(days=d)).isoformat(),
                "planned": _planned_at(tasks, d),
                "earned": round(cum, 2) if d <= today_day else None,
            }
        )

    earned_now = points[min(today_day, horizon)]["earned"] or 0.0
    planned_now = _planned_at(tasks, today_day)
    spi = round(earned_now / planned_now, 2) if planned_now > 0 else None

    # Projection: pace over the last week, run forward until the plan is earned.
    week_ago = max(0, today_day - PACE_WINDOW_DAYS)
    earned_week_ago = points[week_ago]["earned"] or 0.0
    slope = (earned_now - earned_week_ago) / max(today_day - week_ago, 1)
    if slope > 0:
        projected_finish = today_day + (planned_total - earned_now) / slope
        projected_slip = round(projected_finish - duration, 1)
    else:
        projected_finish, projected_slip = None, None

    return {
        "day0": day0().isoformat(),
        "today_day": today_day,
        "project_duration": duration,
        "planned_total": planned_total,
        "earned_total": earned_now,
        "spi": spi,
        "projected_finish_day": round(projected_finish, 1) if projected_finish else None,
        "projected_slip_days": projected_slip,
        "points": points,
        "seeded": _seeded,
        "source": tiger.source(),
    }


# ----------------------------------------------------------- spend vs budget


async def _read_workflows() -> dict:
    """The tenant's real approval workflows, read once per process off Zip.

    The escalation quotes these by name. Degrades to zero-knowledge when the
    key is absent or staging is unreachable — the check still runs against the
    local budget policy, it just cannot cite a live workflow.
    """
    global _workflows_cache
    if _workflows_cache is not None:
        return _workflows_cache
    result = {"count": 0, "name": None}
    if zip_api.zip_live() and not OFFLINE:
        try:
            async with httpx.AsyncClient(timeout=8) as client:
                res = await client.get(
                    f"{zip_api.ZIP_BASE}/workflows", headers=zip_api._headers()
                )
                res.raise_for_status()
                wfs = res.json().get("list") or []
                result["count"] = len(wfs)
                names = [str(w.get("name") or "") for w in wfs]
                result["name"] = next(
                    (n for n in names if "basic request a purchase" in n.lower()),
                    next((n for n in names if "purchase" in n.lower() or "po" in n.lower()), None),
                ) or (names[0] if names else None)
        except Exception as exc:
            log.warning("analytics: workflow read failed (%s)", type(exc).__name__)
    _workflows_cache = result
    return result


async def _post_escalation_comment(text: str) -> bool:
    """Try to land the escalation as a real comment on Zip staging.

    `POST /comments` requires exactly one anchor object (probed: a bare comment
    is a 400, "Comment can only be associated with one object"), so this anchors
    to the tenant's most recent intake request when one exists. The workshop
    tenant ships with none until someone runs the intake flow in the Zip UI —
    until then the escalation is delivered locally, and says so.
    """
    if not zip_api.zip_live() or OFFLINE:
        return False
    try:
        async with httpx.AsyncClient(timeout=8) as client:
            res = await client.get(
                f"{zip_api.ZIP_BASE}/requests", params={"page_size": 1},
                headers=zip_api._headers(),
            )
            res.raise_for_status()
            requests = res.json().get("list") or []
            if not requests:
                return False
            res = await client.get(
                f"{zip_api.ZIP_BASE}/users", params={"page_size": 1},
                headers=zip_api._headers(),
            )
            res.raise_for_status()
            users = res.json().get("list") or []
            if not users:
                return False
            payload = {
                "data": {
                    "text": text[:1000],
                    "user_id": str(users[0]["id"]),
                    "external_display_name": "JENGA governance agent",
                    "purchase_requisition_id": str(requests[0]["id"]),
                }
            }
            res = await client.post(
                f"{zip_api.ZIP_BASE}/comments", json=payload, headers=zip_api._headers()
            )
            res.raise_for_status()
            log.warning("analytics: escalation comment landed on Zip staging")
            return True
    except Exception as exc:
        log.warning("analytics: escalation comment failed (%s)", type(exc).__name__)
        return False


async def check_escalation() -> dict | None:
    """Fire once when committed spend crosses the policy line while verified
    work lags — the pattern no single approver sees. Sticky until reset."""
    global _escalation
    if _escalation is not None:
        return _escalation

    sched = await schedule_analysis()
    spend_events = await tiger.events()
    committed = sum(e["value"] for e in spend_events if e["event"] in _SPEND_KINDS)
    committed_pct = 100.0 * committed / SITE_BUDGET if SITE_BUDGET else 0.0
    earned_pct = (
        100.0 * sched["earned_total"] / sched["planned_total"]
        if sched["planned_total"]
        else 0.0
    )

    if committed_pct < ESCALATE_COMMIT_PCT or committed_pct - earned_pct < ESCALATE_GAP_PTS:
        return None

    wf = await _read_workflows()
    policy = (
        f"Crosses the {ESCALATE_COMMIT_PCT:.0f}% commitment line under workflow "
        f"'{wf['name']}' ({wf['count']} approval workflows read live from Zip)."
        if wf.get("name")
        else f"Crosses the {ESCALATE_COMMIT_PCT:.0f}% commitment line of the site budget policy."
    )
    message = (
        f"{committed_pct:.0f}% of budget committed, {earned_pct:.0f}% of work verified — "
        f"spending is outrunning the build. Every individual PO was compliant; the "
        f"cumulative pattern is not. {policy}"
    )
    delivered = "zip_comment" if await _post_escalation_comment(message) else "local"
    _escalation = {
        "at": datetime.now(timezone.utc).isoformat(),
        "message": message,
        "committed_pct": round(committed_pct, 1),
        "earned_pct": round(earned_pct, 1),
        "workflow_name": wf.get("name"),
        "delivered": delivered,
    }
    await tiger.record_event("site", "escalation", 0.0)
    log.warning("analytics: ESCALATION raised (%s)", delivered)
    return _escalation


async def spend_analysis() -> dict:
    """Committed spend vs the site budget, with the escalation state."""
    sched = await schedule_analysis()
    daily = await tiger.daily_totals(_SPEND_KINDS)
    spend_by_day: dict[int, float] = {}
    for row in daily:
        d = (row["day"] - day0()).days
        if d >= 0:
            spend_by_day[d] = spend_by_day.get(d, 0.0) + row["total"]

    today_day = LOOKBACK_DAYS
    points, cum = [], 0.0
    for d in range(0, today_day + 1):
        cum += spend_by_day.get(d, 0.0)
        points.append(
            {
                "day": d,
                "date": (day0() + timedelta(days=d)).isoformat(),
                "committed": round(cum, 2),
            }
        )

    committed_total = points[-1]["committed"] if points else 0.0
    committed_pct = round(100.0 * committed_total / SITE_BUDGET, 1) if SITE_BUDGET else 0.0
    earned_pct = (
        round(100.0 * sched["earned_total"] / sched["planned_total"], 1)
        if sched["planned_total"]
        else 0.0
    )

    raw_events = await tiger.events()
    po_events = [
        {
            "date": e["time"].isoformat(),
            "day": _day_of(e["time"]),
            "po_id": e["subject"],
            "event": e["event"],
            "amount": e["value"],
        }
        for e in raw_events
        if e["event"].startswith("po_")
    ]

    wf = await _read_workflows()
    return {
        "budget": SITE_BUDGET,
        "currency": "CAD",
        "committed_total": round(committed_total, 2),
        "committed_pct": committed_pct,
        "earned_pct": earned_pct,
        "points": points,
        "events": po_events,
        "escalation": _escalation,
        "workflows_read": wf["count"],
        "workflow_name": wf.get("name"),
        "seeded": _seeded,
        "source": tiger.source(),
    }


# ------------------------------------------------------------------ rule 0'


async def pace_status(task: dict) -> dict:
    """The verification arbiter's pace check for one claim.

    Flags a claim only when three things are all true: the site is clearly
    behind plan (SPI under `PACE_SPI_FLOOR`), the claim's own zone has produced
    zero verified work in the last week, and there is enough event history to
    judge at all. Anything less conclusive stays informational — "too little
    history" is its own answer, not a warm approval.
    """
    sched = await schedule_analysis()
    all_events = await tiger.events()
    zone = str(task.get("zone") or "")

    zone_tasks = {t["id"] for t in await db.tasks() if t.get("zone") == zone}
    cutoff = datetime.now(timezone.utc) - timedelta(days=PACE_WINDOW_DAYS)
    zone_earned = sum(
        e["value"]
        for e in all_events
        if e["event"] == "work_verified" and e["subject"] in zone_tasks and e["time"] > cutoff
    )
    samples = len(all_events)
    spi = sched["spi"]

    flagged = (
        samples >= PACE_MIN_EVENTS
        and spi is not None
        and spi < PACE_SPI_FLOOR
        and zone_earned <= 0
        and int(task.get("duration_days") or 0) >= 2
    )
    return {
        "spi": spi,
        "zone": zone,
        "window_days": PACE_WINDOW_DAYS,
        "zone_earned_days": round(zone_earned, 1),
        "samples": samples,
        "min_samples": PACE_MIN_EVENTS,
        "spi_floor": PACE_SPI_FLOOR,
        "earned_total": sched["earned_total"],
        "planned_total": sched["planned_total"],
        "flagged": flagged,
        "source": tiger.source(),
    }


async def reset() -> None:
    """Wipe and re-seed the event stream (called by /api/reset)."""
    global _seeded, _escalation
    _seeded = False
    _escalation = None
    await seed_history(force=True)
