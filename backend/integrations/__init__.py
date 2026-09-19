"""Shared plumbing for JENGA's external integrations.

The entire error strategy for this package lives here: one timeout, one
try/except, one fallback. Every external call goes through `safe_call`, so a
dead conference wifi connection degrades to canned demo data instead of an
exception or a hang.

Also home to the Sentry shim (`span`, `emit`), which no-ops without a DSN.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
from contextlib import contextmanager
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


# ------------------------------------------------------------ sentry
# Two products beyond error monitoring: distributed tracing (a span per graph
# node) and structured logs (one record per decision point). Entirely optional
# — without SENTRY_DSN the shim below is a no-op and costs nothing.

SENTRY_ON = False

if os.getenv("SENTRY_DSN"):
    try:
        import sentry_sdk

        sentry_sdk.init(
            dsn=os.environ["SENTRY_DSN"],
            traces_sample_rate=1.0,
            enable_logs=True,
            environment=os.getenv("SENTRY_ENVIRONMENT", "hackathon-demo"),
            release=os.getenv("SENTRY_RELEASE", "jenga-agent@0.1.0"),
        )
        SENTRY_ON = True
        log.warning("sentry: tracing and structured logs enabled")
    except Exception as exc:
        log.warning("sentry: init failed (%s), continuing without it", exc)


class _NullSpan:
    """Stand-in span for when Sentry is off. Swallows everything."""

    def set_data(self, *_a, **_k) -> None: ...
    def set_status(self, *_a, **_k) -> None: ...
    def set_tag(self, *_a, **_k) -> None: ...


@contextmanager
def span(name: str, op: str = "jenga.node", **data):
    """Open a Sentry span, or yield a no-op when Sentry is off."""
    if not SENTRY_ON:
        yield _NullSpan()
        return
    with sentry_sdk.start_span(op=op, name=name) as s:
        for key, value in data.items():
            s.set_data(key, value)
        yield s


@contextmanager
def transaction(name: str, op: str = "jenga.verify", **tags):
    """Root of a trace. One per `verify_submission` call."""
    if not SENTRY_ON:
        yield _NullSpan()
        return
    with sentry_sdk.start_transaction(op=op, name=name) as txn:
        for key, value in tags.items():
            txn.set_tag(key, str(value))
        yield txn


def emit(level: str, message: str, **fields) -> None:
    """Structured log line — always to stdlib, additionally to Sentry when on."""
    getattr(log, level, log.info)("%s | %s", message, fields or "")
    if SENTRY_ON:
        try:
            getattr(sentry_sdk.logger, level)(message, **fields)
        except Exception:  # never let telemetry break the pipeline
            pass


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
