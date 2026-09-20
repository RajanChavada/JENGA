"""Supply-line radar: Browserbase watches the roads materials travel on.

For every purchase order, trace the delivery route from the vendor's plant to
the site (OSRM public router), pull Ontario 511's live closure/incident feed
(through the same Browserbase Fetch API the hotzone scrape uses, with a plain
HTTP fallback), and flag any event within ~500 m of a route. A flagged route
gets a predicted delivery slip, a CPM *preview* (what the slip would do to the
schedule — computed on a copy, never persisted), and, when the linked task is
critical or the project would slip, a real expedite raised through the existing
Zip path.

Fallbacks, one per integration, all honestly labelled in the payload:
- OSRM unreachable      -> straight-line corridor vendor→site.
- 511 unreachable/empty -> one seeded closure on the aggregate route, and the
                           response says `source: "seeded"`.
- Zip absent/failing    -> the expedite falls back to the local mirror, exactly
                           as everywhere else.

Every check lands in the Tiger event stream (`route_check`, value = predicted
slip days) so corridor risk accumulates history like everything else on site.
"""

from __future__ import annotations

import json
import math
import os
from datetime import datetime, timedelta, timezone

import httpx

import cpm_engine
import db
from browserbase_hotzones import FETCH_URL
from integrations import log, tiger, zip_api

#: The one onboarded site (Eglinton West Station). Mirrors the seed.
SITE = {"name": "Eglinton West Station", "lat": 43.6992, "lng": -79.4356}

#: Seeded vendor plant coordinates (approximate real GTA facilities, chosen so
#: routes traverse the 401/400-series corridors 511 actually reports on).
#: Zip's staging vendor records carry no usable street addresses, so these are
#: honest demo seeds, not geocoded truth.
VENDOR_PLANTS: dict[str, dict] = {
    "Dufferin Concrete": {"lat": 43.7997, "lng": -79.4930},  # Concord/Vaughan plant
    "Harris Rebar": {"lat": 43.2183, "lng": -79.7710},  # Stoney Creek fabrication
    "CRH Canada": {"lat": 43.6486, "lng": -79.7290},  # Mississauga aggregates yard
    "Sika Canada": {"lat": 43.7060, "lng": -79.7599},  # Brampton distribution
}

OSRM_URL = "https://router.project-osrm.org/route/v1/driving"
EVENTS_511 = "https://511on.ca/api/v2/get/event"

#: Greater Toronto + Hamilton bbox — keeps the 511 payload relevant.
BBOX = {"lat_min": 43.0, "lat_max": 44.3, "lng_min": -80.3, "lng_max": -78.6}

#: A closure this close to the route (metres) is *on* the route.
NEAR_M = 500.0

#: POs already acted on this session. A re-check must not raise a second
#: staging PO for the same disruption — the first artifact is the point.
_acted: dict[str, str] = {}


# ------------------------------------------------------------------ geometry


def _haversine_m(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    r = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = math.radians(lat2 - lat1), math.radians(lng2 - lng1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def decode_polyline(encoded: str) -> list[tuple[float, float]]:
    """Google encoded polyline -> [(lat, lng)]. Pure python, no deps."""
    points, index, lat, lng = [], 0, 0, 0
    while index < len(encoded):
        for is_lng in (False, True):
            shift, result = 0, 0
            while True:
                b = ord(encoded[index]) - 63
                index += 1
                result |= (b & 0x1F) << shift
                shift += 5
                if b < 0x20:
                    break
            delta = ~(result >> 1) if result & 1 else result >> 1
            if is_lng:
                lng += delta
            else:
                lat += delta
        points.append((lat / 1e5, lng / 1e5))
    return points


def _min_dist_to_route_m(lat: float, lng: float, route: list[tuple[float, float]]) -> float:
    """Min distance from a point to a route's vertices. OSRM geometry is dense
    (a vertex every ~50-100 m), so vertex distance is accurate enough at a
    500 m threshold without segment projection."""
    return min((_haversine_m(lat, lng, rl, rn) for rl, rn in route), default=float("inf"))


def _straight_corridor(a: dict, b: dict, points: int = 40) -> list[tuple[float, float]]:
    """OSRM-down fallback: interpolate a straight corridor vendor→site."""
    return [
        (
            a["lat"] + (b["lat"] - a["lat"]) * i / (points - 1),
            a["lng"] + (b["lng"] - a["lng"]) * i / (points - 1),
        )
        for i in range(points)
    ]


# ------------------------------------------------------------------- fetches


async def _fetch_route(vendor: dict) -> tuple[list[tuple[float, float]], bool]:
    """Vendor→site driving route off OSRM's public router. Returns
    (points as (lat,lng), live) — live False means the straight-line fallback."""
    url = (
        f"{OSRM_URL}/{vendor['lng']},{vendor['lat']};{SITE['lng']},{SITE['lat']}"
        "?overview=full&geometries=geojson"
    )
    try:
        async with httpx.AsyncClient(timeout=6) as client:
            res = await client.get(url)
            res.raise_for_status()
            coords = res.json()["routes"][0]["geometry"]["coordinates"]
            return [(lat, lng) for lng, lat in coords], True
    except Exception as exc:
        log.warning("routes: OSRM failed (%s) — straight corridor", type(exc).__name__)
        return _straight_corridor(vendor, SITE), False


async def _fetch_511_events() -> tuple[list[dict], str]:
    """Ontario 511 events, GTA-filtered. Returns (events, source).

    Browserbase Fetch first — the agent's hands on the open web, same as the
    hotzone scrape — then plain HTTP, then a seeded closure. `source` is
    'live' for either real fetch path and 'seeded' only for the fallback.
    """
    raw: str | None = None
    key = os.getenv("BROWSERBASE_API_KEY")
    if key:
        try:
            async with httpx.AsyncClient(timeout=12) as client:
                res = await client.post(
                    FETCH_URL,
                    headers={"X-BB-API-Key": key, "Content-Type": "application/json"},
                    json={"url": EVENTS_511, "allowRedirects": True},
                )
                res.raise_for_status()
                raw = str(res.json().get("content") or "")
        except Exception as exc:
            log.warning("routes: browserbase 511 fetch failed (%s)", type(exc).__name__)

    if not raw:
        try:
            async with httpx.AsyncClient(timeout=8) as client:
                res = await client.get(EVENTS_511)
                res.raise_for_status()
                raw = res.text
        except Exception as exc:
            log.warning("routes: direct 511 fetch failed (%s)", type(exc).__name__)
            return _seeded_events(), "seeded"

    try:
        events = json.loads(raw)
        assert isinstance(events, list)
    except Exception:
        log.warning("routes: 511 payload unparseable — seeded fallback")
        return _seeded_events(), "seeded"

    gta = [
        e
        for e in events
        if isinstance(e.get("Latitude"), (int, float))
        and BBOX["lat_min"] <= e["Latitude"] <= BBOX["lat_max"]
        and BBOX["lng_min"] <= e["Longitude"] <= BBOX["lng_max"]
        # 511 keeps cancelled works in the feed with a marker in the text; a
        # cancelled closure is not a risk and must not badge a route.
        and "cancelled" not in str(e.get("Description") or "").lower()
    ]
    return gta, "live"


def _seeded_events() -> list[dict]:
    """One believable closure sitting on the CRH (aggregate) corridor, used only
    when the live feed is unreachable — and the response says so."""
    return [
        {
            "Latitude": 43.6879,
            "Longitude": -79.6100,
            "Description": (
                "SEEDED FALLBACK — Hwy 401 eastbound near Renforth Dr: two right "
                "lanes closed for emergency pavement repair."
            ),
            "RoadwayName": "Hwy 401",
            "IsFullClosure": False,
            "LanesAffected": "2 right lanes",
            "Impact": "Major",
        }
    ]


# ------------------------------------------------------------------ analysis


def _event_points(e: dict) -> list[tuple[float, float]]:
    """Where an event is: its point, plus its polyline when it covers a stretch."""
    pts = [(float(e["Latitude"]), float(e["Longitude"]))]
    encoded = e.get("EncodedPolyline")
    if isinstance(encoded, str) and encoded:
        try:
            pts.extend(decode_polyline(encoded)[:200])
        except Exception:
            pass
    return pts


def _score(closures: list[dict]) -> tuple[str, int]:
    """(risk, predicted slip days) for a route from its on-route closures.

    Calibrated against what the 511 feed actually carries: most GTA events are
    nightly ramp/collector maintenance, which delays a truck minutes, not days.
    Only a full closure of the road itself is `high`; ramp closures and major
    lane restrictions are `medium`; everything else is watch-only `low`.
    """
    if not closures:
        return "clear", 0

    def is_ramp(c: dict) -> bool:
        return "ramp" in c["description"].lower()

    if any(c["full_closure"] and not is_ramp(c) for c in closures):
        return "high", 2
    if any(
        c["full_closure"]
        or str(c["impact"]).lower() in ("major", "high")
        or "all lanes" in c["lanes_affected"].lower()
        for c in closures
    ):
        return "medium", 1
    return "low", 0


async def _cpm_preview(task_id: str, slip_days: int) -> dict | None:
    """What the slip would do to the schedule — computed on a copy, not applied."""
    try:
        graph = cpm_engine.build_graph(await db.tasks(), await db.edges())
        if task_id not in graph:
            return None
        result = cpm_engine.apply_delay(graph, task_id, slip_days)
        return {
            "task_id": task_id,
            "project_slip_days": int(result["project_slipped_days"]),
            "downstream_count": len(result["downstream_affected"]),
        }
    except Exception as exc:
        log.warning("routes: CPM preview failed (%s)", type(exc).__name__)
        return None


async def _act(po: dict, risk: str, slip: int, preview: dict | None, closure: dict) -> tuple[str, str]:
    """Auto-expedite through the existing Zip path when the slip matters.

    Returns (action, detail). Acts at most once per PO per session so repeated
    checks don't stack staging artifacts for the same disruption.
    """
    po_id = po["id"]
    if slip <= 0:
        return "none", ""
    if po_id in _acted:
        return _acted[po_id], "Already handled earlier this session — no duplicate raised."

    # Act only when the slip would actually move work: the project finish moves
    # (the linked task is critical), or downstream tasks shift. A slip a task's
    # own float absorbs is watched, not acted on — expediting it would be noise.
    if not preview or (preview["project_slip_days"] <= 0 and preview["downstream_count"] <= 0):
        return "none", ""

    try:
        base = datetime.fromisoformat(str(po["delivery_date"])).date()
    except (TypeError, ValueError):
        base = datetime.now(timezone.utc).date()
    new_date = (base - timedelta(days=slip)).isoformat()
    reason = (
        f"Route risk: {closure['roadway']} — {closure['description'][:140]} "
        f"Predicted +{slip}d delivery slip against {po.get('linked_task') or 'schedule'}."
    )
    result = await zip_api.expedite_purchase_order(po_id, new_date, reason)
    note = f"{reason} · via Zip API" if result.get("live") else reason
    await db.update_po(po_id, status="rescheduled", delivery_date=new_date, last_action=note)
    await tiger.record_event(po_id, "po_expedited", 0.0)
    detail = result.get("detail") or "Expedite recorded on the local ledger."
    _acted[po_id] = "expedited"
    return "expedited", detail


async def check_routes() -> dict:
    """The whole radar pass: every PO's route, checked against live closures."""
    events, source = await _fetch_511_events()
    pos = await db.purchase_orders()
    routes, any_live_geometry = [], False
    seed_snapped = False

    for po in pos:
        vendor = str(po.get("vendor") or "")
        plant = VENDOR_PLANTS.get(vendor)
        if plant is None:
            continue  # vendor with no seeded plant — nothing honest to draw

        route_pts, live_geo = await _fetch_route(plant)
        any_live_geometry = any_live_geometry or live_geo

        # The seeded closure exists to demonstrate the analysis when 511 is
        # down, so it must actually sit on a route: snap it to the midpoint of
        # the first one traced. Its description already says it is a fallback.
        if source == "seeded" and not seed_snapped and route_pts:
            mid = route_pts[len(route_pts) // 2]
            events[0]["Latitude"], events[0]["Longitude"] = mid[0], mid[1]
            events[0]["IsFullClosure"] = True
            seed_snapped = True

        closures = []
        for e in events:
            near = min(
                (
                    _min_dist_to_route_m(lat, lng, route_pts)
                    for lat, lng in _event_points(e)
                ),
                default=float("inf"),
            )
            if near <= NEAR_M:
                closures.append(
                    {
                        "lat": float(e["Latitude"]),
                        "lng": float(e["Longitude"]),
                        "description": str(e.get("Description") or "")[:300],
                        "roadway": str(e.get("RoadwayName") or "road"),
                        "impact": str(e.get("Impact") or ""),
                        "full_closure": bool(e.get("IsFullClosure")),
                        "lanes_affected": str(e.get("LanesAffected") or ""),
                    }
                )

        risk, slip = _score(closures)
        preview = (
            await _cpm_preview(po["linked_task"], slip)
            if slip > 0 and po.get("linked_task")
            else None
        )

        await tiger.record_event(po["id"], "route_check", float(slip))
        routes.append(
            {
                "po_id": po["id"],
                "vendor": vendor,
                "material": po.get("material") or "",
                "vendor_lat": plant["lat"],
                "vendor_lng": plant["lng"],
                # (lng, lat) pairs — GeoJSON order, ready for a map source.
                "geometry": [[lng, lat] for lat, lng in route_pts],
                "geometry_live": live_geo,
                "closures": closures,
                "risk": risk,
                "predicted_slip_days": slip,
                "cpm_preview": preview,
                "action": "none",
                "action_detail": "",
                "_po": po,
            }
        )

    # Act on the single worst route per pass. Expediting everything at once is
    # noise (and stacks artifacts on the shared staging tenant); the radar's job
    # is to surface the one delivery that actually threatens the schedule.
    def _severity(r: dict) -> tuple:
        p = r["cpm_preview"] or {"project_slip_days": 0, "downstream_count": 0}
        return (r["predicted_slip_days"], p["project_slip_days"], p["downstream_count"])

    candidates = [r for r in routes if r["closures"] and r["predicted_slip_days"] > 0]
    if candidates:
        worst = max(candidates, key=_severity)
        action, detail = await _act(
            worst["_po"],
            worst["risk"],
            worst["predicted_slip_days"],
            worst["cpm_preview"],
            worst["closures"][0],
        )
        worst["action"], worst["action_detail"] = action, detail
    for r in routes:
        r.pop("_po", None)

    log.warning(
        "routes: checked %d routes against %d events (%s) — %d flagged",
        len(routes),
        len(events),
        source,
        sum(1 for r in routes if r["risk"] != "clear"),
    )
    return {
        "source": source,
        "checked_at": datetime.now(timezone.utc).isoformat(),
        "events_scanned": len(events),
        "site": SITE,
        "routes": routes,
    }
