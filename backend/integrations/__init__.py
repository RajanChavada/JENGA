"""Shared plumbing for JENGA's external integrations.

The entire error strategy for this package lives here: one timeout, one
try/except, one fallback. Every external call goes through `safe_call`, so a
dead conference wifi connection degrades to canned demo data instead of an
exception or a hang.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()

log = logging.getLogger("jenga.integrations")

DATA_DIR = Path(__file__).resolve().parents[2] / "data"
TIMEOUT = 5.0

#: Set JENGA_OFFLINE=1 to force every external call onto its fallback.
OFFLINE = os.getenv("JENGA_OFFLINE", "").strip().lower() in {"1", "true", "yes", "on"}


def _load(name: str) -> dict:
    try:
        return json.loads((DATA_DIR / name).read_text())
    except Exception as exc:  # pragma: no cover - only if data/ is missing
        log.warning("could not load %s (%s); using empty dataset", name, exc)
        return {}


MOCK_EVIDENCE = _load("mock_evidence.json")
SEED = _load("seed_tasks.json")

#: task_id -> the `expected` block from data/mock_evidence.json.
EXPECTED: dict[str, dict] = {
    s["task_id"]: s.get("expected", {})
    for s in MOCK_EVIDENCE.get("submissions", [])
    if s.get("task_id")
}


def expected_for(task_id: str) -> dict:
    """Ground truth / offline fallback for a task. `{}` if the task isn't in the demo set."""
    return EXPECTED.get(task_id, {})


async def safe_call(label: str, make_coro, fallback):
    """Run an external call, or return `fallback`. Never raises, never hangs.

    Falls back when offline mode is on, the call raises, or it exceeds TIMEOUT.
    """
    if OFFLINE:
        log.warning("%s: JENGA_OFFLINE set, using canned fallback", label)
        return fallback
    try:
        return await asyncio.wait_for(make_coro(), timeout=TIMEOUT)
    except Exception as exc:
        log.warning("%s: call failed (%s: %s), using canned fallback", label, type(exc).__name__, exc)
        return fallback
