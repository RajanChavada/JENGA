"""Plain-assert checks for the site-event stream, the analytics, and rule 0'.

    cd backend && python test_sensors.py

No pytest and no network. Storage is forced to memory, the event store to mock,
and history is written with explicit timestamps so the curves in the output are
the ones a real run would show.
"""

from __future__ import annotations

import asyncio
import os
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

# Set before the first import of `integrations`: mock event storage, no live
# calls, no shared database. load_dotenv() never overrides an already-set
# variable, so these win over backend/.env.
os.environ["JENGA_SENSORS"] = "0"
os.environ["JENGA_OFFLINE"] = "1"
os.environ["JENGA_STORAGE"] = "memory"

import db  # noqa: E402
import seed as seed_module  # noqa: E402
import analytics  # noqa: E402
from agent import PACE_REQUEST, _build_trace, _decide, pace_check  # noqa: E402
from integrations import tiger  # noqa: E402

TICKET = "P-112"  # escalator_well: a zone with no verified work in the seed

#: A submission pace can contradict: legible photo, human prose, "complete".
BASE_STATE = {
    "claim": "Escalator well forming complete, panels stripped and clean.",
    "strict": True,
    "gptzero": {"ai_probability": 0.04, "flagged": False},
    "vision": {
        "observation": "Formwork panels are stripped and the well walls are visible.",
        "matches_claim": True,
        "confidence": 0.9,
        "insufficient": False,
    },
    "historical": {"summary": "Two comparable forming packages closed on schedule."},
}


def now() -> datetime:
    return datetime.now(timezone.utc)


async def reseed(force: bool = True) -> None:
    await seed_module.seed()
    await analytics.reset() if force else analytics.seed_history()


async def drain_earned() -> None:
    """Rebuild history as a clearly-behind site: one small verified event only,
    so SPI lands under the floor and every zone but track_bed is in drought."""
    await tiger.clear_events()
    analytics._escalation = None
    await tiger.record_event("P-101", "work_verified", 2.0, ts=now() - timedelta(days=10))
    # Padding events so the history floor is met without earning anything.
    for i in range(4):
        await tiger.record_event(f"PO-000{i}", "po_created", 1500.0, ts=now() - timedelta(days=9 - i))


def pace_card(state: dict) -> dict:
    return next(c for c in _build_trace(state) if c["node"] == "pace_check")


async def main() -> None:
    print(f"JENGA pace & analytics checks (telemetry={tiger.source()})\n" + "=" * 62)
    await db.init()
    await seed_module.seed()
    task = next(t for t in await db.tasks() if t["id"] == TICKET)
    state = {**BASE_STATE, "task": task}

    # 1 — seeded history produces a live S-curve with sane invariants.
    await analytics.reset()
    sched = await analytics.schedule_analysis()
    assert sched["planned_total"] == 99.0, sched["planned_total"]
    assert sched["earned_total"] == 20.0, sched["earned_total"]  # the 4 verified tasks
    assert sched["spi"] and 0.5 < sched["spi"] <= 1.2, sched["spi"]
    assert sched["points"][0]["planned"] == 0.0
    planned_series = [p["planned"] for p in sched["points"]]
    assert planned_series == sorted(planned_series), "planned curve must be monotonic"
    earned_today = sched["points"][sched["today_day"]]["earned"]
    assert earned_today == 20.0, earned_today
    assert sched["points"][-1]["earned"] is None or sched["today_day"] >= len(sched["points"]) - 1, \
        "earned curve must not claim the future"
    print(f"PASS  seeded S-curve: planned {sched['planned_total']}d, earned {sched['earned_total']}d, "
          f"SPI {sched['spi']}, projected slip {sched['projected_slip_days']}d")

    # 2 — spend analytics: seeded POs commit real derived dollars, no escalation yet.
    spend = await analytics.spend_analysis()
    assert spend["committed_total"] > 50000, spend["committed_total"]
    assert spend["committed_pct"] < analytics.ESCALATE_COMMIT_PCT, spend["committed_pct"]
    assert spend["escalation"] is None, spend["escalation"]
    assert len(spend["events"]) >= 4, len(spend["events"])
    print(f"PASS  seeded spend: ${spend['committed_total']:,.0f} committed "
          f"({spend['committed_pct']}% of budget), earned {spend['earned_pct']}%, no escalation")

    # 3 — healthy pace does not flag, and the arbiter approves.
    read = await pace_check({"task": task})
    assert read["pace"]["flagged"] is False, read["pace"]
    approved = await _decide({**state, "pace": read["pace"]})
    assert approved["verdict"]["status"] == "APPROVED", approved["verdict"]["status"]
    assert approved["branch"] == "approved", approved["branch"]
    card = pace_card({**state, "pace": read["pace"], "verdict": approved["verdict"]})
    assert card["title"] == "4 · Site pace", card
    assert card["signal"] in ("ok", "info"), card
    print(f"PASS  healthy pace (SPI {read['pace']['spi']}) -> {approved['verdict']['status']}; "
          f"card: {card['detail'][:70]}…")

    # 4 — a clearly-behind site flags a completion claim in a drought zone, and
    # the arbiter holds instead of approving.
    await drain_earned()
    slow = await analytics.pace_status(task)
    assert slow["spi"] is not None and slow["spi"] < analytics.PACE_SPI_FLOOR, slow
    assert slow["zone_earned_days"] == 0.0, slow
    assert slow["samples"] >= analytics.PACE_MIN_EVENTS, slow
    assert slow["flagged"] is True, slow
    held = await _decide({**state, "pace": slow})
    v = held["verdict"]
    assert held["branch"] == "pace_conflict", held["branch"]
    assert v["status"] == "UNDER_REVIEW", v["status"]
    assert v["confidence"] <= 0.49, v["confidence"]
    assert PACE_REQUEST.split(" Blueprint")[0] in (v["actionable_request"] or ""), v["actionable_request"]
    assert "outruns" in v["reasoning"], v["reasoning"]
    assert v["pace"] == slow, v["pace"]
    card = pace_card({**state, "pace": slow, "verdict": v, "branch": "pace_conflict"})
    assert card["signal"] == "bad", card
    arb = next(c for c in _build_trace({**state, "pace": slow, "verdict": v, "branch": "pace_conflict"})
               if c["node"] == "arbiter")
    assert "measured pace" in arb["detail"], arb
    print(f"PASS  SPI {slow['spi']} + drought in {slow['zone']} -> {v['status']} "
          f"via {held['branch']}")
    print(f"      card:   {card['detail'][:90]}…")

    # 5 — the history floor. The same slow site with too few events must not
    # flag: "too little history to judge" is its own answer.
    await tiger.clear_events()
    await tiger.record_event("P-101", "work_verified", 2.0, ts=now() - timedelta(days=10))
    sparse = await analytics.pace_status(task)
    assert sparse["samples"] < analytics.PACE_MIN_EVENTS, sparse
    assert sparse["flagged"] is False, sparse
    thin = pace_card({"pace": sparse})
    assert thin["signal"] == "info", thin
    assert "too thin" in thin["detail"], thin
    not_held = await _decide({**state, "pace": sparse})
    assert not_held["branch"] == "approved", not_held["branch"]
    print(f"PASS  {sparse['samples']} events (floor {sparse['min_samples']}) -> flagged "
          f"{sparse['flagged']}, verdict {not_held['verdict']['status']}")

    # 6 — pace only contests completion claims. A progress note on the same slow
    # site sails through: there is no completion assertion to contradict.
    await drain_earned()
    progress = await _decide({
        **state,
        "claim": "Crew is prepping the escalator well; rebar arrives tomorrow.",
        "pace": await analytics.pace_status(task),
    })
    assert progress["branch"] == "approved", progress["branch"]
    print(f"PASS  progress note (no completion claim) -> {progress['verdict']['status']}")

    # 7 — no pace data changes nothing. A dead analytics path must not move a verdict.
    without = await _decide(dict(state))
    empty = await _decide({**state, "pace": {"samples": 0}})
    assert without["verdict"]["status"] == empty["verdict"]["status"]
    assert without["branch"] == empty["branch"] != "pace_conflict"
    blank = pace_card({**state, "pace": {"samples": 0}})
    assert blank["detail"] == "No site-pace history for this project yet.", blank
    assert blank["signal"] == "info", blank
    print(f"PASS  no history -> {empty['verdict']['status']} via {empty['branch']}, "
          f"identical to the pace-free verdict")

    # 8 — the escalation: individually-small POs cumulatively cross the line
    # while earned work lags, fires exactly once, and lands in the event stream.
    await drain_earned()
    for i in range(6):
        await tiger.record_event(
            f"JENGA-T{i}", "po_created", 25000.0, ts=now() - timedelta(hours=6 - i)
        )
    esc = await analytics.check_escalation()
    assert esc is not None, "escalation should fire on committed >> earned"
    assert esc["committed_pct"] >= analytics.ESCALATE_COMMIT_PCT, esc
    assert esc["committed_pct"] - esc["earned_pct"] >= analytics.ESCALATE_GAP_PTS, esc
    assert "outrunning the build" in esc["message"], esc["message"]
    assert esc["delivered"] in ("zip_comment", "local"), esc
    again = await analytics.check_escalation()
    assert again is esc or again == esc, "escalation must be sticky, not re-fired"
    marks = [e for e in await tiger.events() if e["event"] == "escalation"]
    assert len(marks) == 1, marks
    spend2 = await analytics.spend_analysis()
    assert spend2["escalation"] is not None, spend2
    print(f"PASS  escalation fired once: {esc['committed_pct']}% committed vs "
          f"{esc['earned_pct']}% earned ({esc['delivered']})")
    print(f"      msg:    {esc['message'][:96]}…")

    # 9 — reset restores the seeded baseline: escalation cleared, curves back.
    await analytics.reset()
    fresh = await analytics.spend_analysis()
    assert fresh["escalation"] is None, fresh["escalation"]
    assert fresh["committed_pct"] < analytics.ESCALATE_COMMIT_PCT, fresh["committed_pct"]
    sched2 = await analytics.schedule_analysis()
    assert sched2["earned_total"] == 20.0, sched2["earned_total"]
    print(f"PASS  reset -> escalation cleared, earned back to {sched2['earned_total']}d")

    print("=" * 62)
    print("All checks passed (9 cases).")


if __name__ == "__main__":
    asyncio.run(main())
