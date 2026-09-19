"""Plain-assert checks for the curing-sensor stream and the arbiter's rule 0.

    cd backend && python test_sensors.py

No pytest and no network. The storage is forced to mock, the asyncio loop is
never started, and the simulator is driven tick by tick against a simulated
clock so the averaging windows in the output are the ones a real run would show.
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

# Set before the first import of `integrations`: mock sensor storage, no live
# calls, no shared database. load_dotenv() never overrides an already-set
# variable, so these win over backend/.env.
os.environ["JENGA_SENSORS"] = "0"
os.environ["JENGA_OFFLINE"] = "1"
os.environ["JENGA_STORAGE"] = "memory"

import db  # noqa: E402
import seed as seed_module  # noqa: E402
import sensors  # noqa: E402
from agent import SENSOR_REQUEST, _build_trace, _decide, sensor_check  # noqa: E402
from integrations import DATA_DIR, tiger  # noqa: E402

TICKET = "P-106"
TASKS = {t["id"]: t for t in json.loads((DATA_DIR / "seed_tasks.json").read_text())["tasks"]}

#: A submission the sensors can contradict: legible photo, human-sounding prose.
BASE_STATE = {
    "task": TASKS[TICKET],
    "claim": "South platform pour complete and cured.",
    "strict": True,
    "gptzero": {"ai_probability": 0.04, "flagged": False},
    "vision": {
        "observation": "Formwork is stripped and the slab surface is visible.",
        "matches_claim": True,
        "confidence": 0.9,
        "insufficient": False,
    },
    "historical": {"summary": "Two comparable pours closed on schedule."},
}


async def reset_sim() -> None:
    """Back to a process that has never seen a reading, over a freshly seeded set.

    Re-seeding matters: the simulator only emits for `active` tickets, and case 5
    runs a verify that moves this one to `disputed`.
    """
    tiger._mock.clear()
    tiger._regime_since.clear()
    sensors._mode.clear()
    sensors._temp.clear()
    await seed_module.seed()
    assert any(t["id"] == TICKET and t["state"] == "active" for t in await db.tasks()), \
        f"{TICKET} must be seeded active for the simulator to emit for it"


async def drive(n: int, end: datetime) -> None:
    """`n` ticks one interval apart, the last of them stamped `end`."""
    for i in range(n):
        await sensors._tick(end - timedelta(seconds=sensors.TICK_S * (n - 1 - i)))


def telemetry_card(state: dict) -> dict:
    return next(c for c in _build_trace(state) if c["node"] == "sensor_check")


async def main() -> None:
    print(f"JENGA sensor checks (telemetry={tiger.source()})\n" + "=" * 62)
    await db.init()

    # 1 — a normal pour is not below the curing minimum.
    await reset_sim()
    now = datetime.now(timezone.utc)
    await drive(60, now)
    normal = await tiger.curing_status(TICKET)
    assert normal["samples"] == 60, normal
    assert normal["below_threshold"] is False, normal
    assert normal["window_s"] == normal["window_requested_s"] == 120, normal
    print(f"PASS  60 normal readings -> avg {normal['avg_temp_c']} °C, below_threshold "
          f"{normal['below_threshold']} over {normal['window_s']} s")

    # 2 — the cold scenario crosses the threshold inside 20 ticks (40 s).
    await reset_sim()
    now = datetime.now(timezone.utc)
    sensors.set_scenario(TICKET, "cold")
    # The snap happened 40 s ago on the simulated clock; the real one has not moved.
    tiger._regime_since[TICKET] = now - timedelta(seconds=sensors.TICK_S * 20)
    await drive(20, now)
    cold = await tiger.curing_status(TICKET)
    assert cold["samples"] == 20, cold
    assert cold["below_threshold"] is True, cold
    print(f"PASS  cold scenario, 20 ticks -> avg {cold['avg_temp_c']} °C, below_threshold "
          f"{cold['below_threshold']} over {cold['window_s']} s")

    # 3 — sensor_check reads that state and the arbiter disputes the claim.
    read = await sensor_check({"task": TASKS[TICKET]})
    assert read["sensor"]["below_threshold"] is True, read
    disputed = await _decide({**BASE_STATE, "sensor": read["sensor"]})
    verdict = disputed["verdict"]
    assert verdict["status"] == "DISPUTED", verdict["status"]
    assert disputed["branch"] == "sensor_conflict", disputed["branch"]
    assert "10 °C" in verdict["reasoning"], verdict["reasoning"]
    assert verdict["confidence"] >= 0.9, verdict["confidence"]
    assert verdict["actionable_request"] == SENSOR_REQUEST, verdict["actionable_request"]
    assert verdict["sensor"] == read["sensor"], verdict["sensor"]
    card = telemetry_card({**BASE_STATE, "sensor": read["sensor"], "verdict": verdict})
    assert card["title"] == "4 · Site telemetry" and card["signal"] == "bad", card
    print(f"PASS  'pour cured' + cold telemetry -> {verdict['status']} "
          f"(conf {verdict['confidence']}, branch {disputed['branch']})")
    print(f"      card:   {card['detail']}")
    print(f"      quotes: ...{verdict['reasoning'][-len(SENSOR_REQUEST) - 60:]}")

    # 4 — no telemetry changes nothing. A dead sensor stream must not move a verdict.
    without = await _decide(dict(BASE_STATE))
    empty = await _decide({**BASE_STATE, "sensor": {"samples": 0}})
    assert without["verdict"]["status"] == empty["verdict"]["status"], (
        without["verdict"]["status"], empty["verdict"]["status"])
    assert without["branch"] == empty["branch"] != "sensor_conflict", (
        without["branch"], empty["branch"])
    assert without["verdict"]["reasoning"] == empty["verdict"]["reasoning"]
    blank = telemetry_card({**BASE_STATE, "sensor": {"samples": 0}})
    assert blank["detail"] == "No sensor telemetry for this ticket.", blank
    assert blank["signal"] == "info", blank
    print(f"PASS  no samples -> {empty['verdict']['status']} via {empty['branch']}, "
          f"identical to the pre-sensor verdict")

    # 5 — precedence. Cold telemetry outranks the AI gate: a flagged report about
    # a cold pour is DISPUTED, not the UNDER_REVIEW the gate alone would give.
    flagged = {**BASE_STATE, "gptzero": {"ai_probability": 0.93, "flagged": True}}
    gate_only = await _decide(flagged)
    assert gate_only["verdict"]["status"] == "UNDER_REVIEW", gate_only["verdict"]["status"]
    assert gate_only["branch"] == "ai_gate", gate_only["branch"]
    both = await _decide({**flagged, "sensor": read["sensor"]})
    assert both["verdict"]["status"] == "DISPUTED", both["verdict"]["status"]
    assert both["branch"] == "sensor_conflict", both["branch"]
    assert both["verdict"]["confidence"] >= 0.9, both["verdict"]["confidence"]
    print(f"PASS  cold + AI-flagged, strict -> {both['verdict']['status']} "
          f"(gate alone would give {gate_only['verdict']['status']})")

    # ...and the route-level gate must not put itself back in front of rule 0.
    import main
    from schemas import VerifyRequest

    async def stub_agent(task, report_text=None, image_base64=None, transcript=None, strict=True):
        return dict(both["verdict"], task_id=task["id"])

    main.verify_submission = stub_agent
    routed = await main.verify(
        TICKET, VerifyRequest(report_text=BASE_STATE["claim"]), strict=True
    )
    assert routed["status"] == "DISPUTED", routed["status"]
    assert routed["actionable_request"] == SENSOR_REQUEST, routed["actionable_request"]
    print(f"PASS  route-level gate leaves a sensor dispute alone -> {routed['status']}")

    # 6 — the clamp. Readings from the previous curing regime are not averaged
    # into the current one; without that, a two-minute mean full of warm samples
    # hides a cold snap for over a minute. (This rule is why case 2 works at all.)
    await reset_sim()
    now = datetime.now(timezone.utc)
    await drive(60, now - timedelta(seconds=26))  # warm, ending 26 s ago
    sensors.set_scenario(TICKET, "cold")
    tiger._regime_since[TICKET] = now - timedelta(seconds=24)
    await drive(12, now)  # 12 cold ticks since the snap
    clamped = await tiger.curing_status(TICKET)
    assert clamped["window_s"] == 24, clamped
    assert clamped["window_requested_s"] == 120, clamped
    assert clamped["samples"] == 12, clamped
    assert clamped["below_threshold"] is True, clamped
    tiger._regime_since.clear()  # same readings, no regime floor
    unclamped = await tiger.curing_status(TICKET)
    assert unclamped["window_s"] == 120, unclamped
    assert unclamped["below_threshold"] is False, unclamped
    print(f"PASS  clamped to {clamped['window_s']} s -> avg {clamped['avg_temp_c']} °C "
          f"(below); unclamped {unclamped['window_s']} s -> avg {unclamped['avg_temp_c']} °C (not)")
    print(f"      card:   {telemetry_card({'sensor': clamped})['detail']}")

    # Re-posting a mode is not a regime change and must not restart the window.
    await reset_sim()
    sensors.set_scenario(TICKET, "cold")
    first = tiger._regime_since[TICKET]
    sensors.set_scenario(TICKET, "cold")
    assert tiger._regime_since[TICKET] == first, "re-posting the same mode restarted the window"
    # And a ticket nobody has touched keeps the full window.
    assert tiger.effective_window("P-999", 120) == 120

    print("=" * 62)
    print("All checks passed (6 cases).")


if __name__ == "__main__":
    asyncio.run(main())
