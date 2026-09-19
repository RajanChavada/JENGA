"""Curing-sensor simulator: emits temp/humidity for every active ticket every 2 s.

Each ticket runs a random walk toward a target: "normal" -> 18 °C, "cold" -> 4 °C.
The cold scenario drifts 30% per tick so it crosses the 10 °C curing minimum in ~6 s.

`JENGA_SENSORS=0` stops the loop. `JENGA_OFFLINE=1` does not: it mocks the
storage while the simulator keeps running, so the offline demo still moves.
"""

from __future__ import annotations

import asyncio
import os
import random
from datetime import datetime, timezone

import db
from integrations import emit, tiger

TICK_S = 2.0

_mode: dict[str, str] = {}  # ticket -> "normal" | "cold"
_temp: dict[str, float] = {}

_TARGET = {"normal": 18.0, "cold": 4.0}
_DRIFT = {"normal": 0.2, "cold": 0.3}


def set_scenario(ticket_id: str, mode: str) -> None:
    if mode == get_scenario(ticket_id):
        return
    _mode[ticket_id] = mode
    # The regime changed, so the previous regime's readings stop being evidence
    # about this one. Re-posting the same mode is not a change and must not
    # restart the window.
    tiger.mark_regime_change(ticket_id)


def get_scenario(ticket_id: str) -> str:
    return _mode.get(ticket_id, "normal")


async def _tick(now: datetime | None = None) -> None:
    try:
        now = now or datetime.now(timezone.utc)
        rows = []
        for task in await db.tasks():
            if task.get("state") != "active":
                continue
            tid = task["id"]
            mode = get_scenario(tid)
            cur = _temp.get(tid, 18.0)
            cur += (_TARGET[mode] - cur) * _DRIFT[mode] + random.uniform(-0.6, 0.6)
            _temp[tid] = cur
            rows.append((now, tid, "temp_c", round(cur, 2)))
            rows.append((now, tid, "humidity_pct", round(55 + random.uniform(-3, 3), 2)))
        if rows:
            await tiger.insert_readings(rows)
    except Exception as exc:  # the simulator must never take the server down
        emit("warning", "sensor tick failed", error=type(exc).__name__)


async def run(interval_s: float = TICK_S) -> None:
    while True:
        await _tick()
        await asyncio.sleep(interval_s)


def start() -> asyncio.Task | None:
    if os.getenv("JENGA_SENSORS", "1").strip() == "0":
        return None
    return asyncio.create_task(run())


async def stop(task: asyncio.Task | None) -> None:
    """Cancel and await, so shutdown never logs a destroyed-pending task."""
    if task is None:
        return
    task.cancel()
    try:
        await task
    except asyncio.CancelledError:
        pass
