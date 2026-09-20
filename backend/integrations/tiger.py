"""Tiger Data (TimescaleDB) site-event stream: the time axis of the whole product.

One narrow table, `site_events (time, subject, event, value)`, holds every
timestamped fact JENGA learns about the site:

- `work_verified`   — a verification approved real work; `value` = days earned.
- `work_disputed` / `work_review` — a verdict that did not credit progress.
- `po_created` / `po_expedited` / `po_delivered` — procurement lifecycle;
  `value` = committed dollars.
- `escalation`      — the governance agent flagged spend outrunning the build.

`analytics.py` turns this stream into the earned-schedule S-curve, the spend
velocity curve, and the pace check the verification arbiter reads.

Two modes. "tiger" writes to the `site_events` hypertable and buckets with
`time_bucket`; "mock" keeps the same rows in memory and buckets in Python so
the demo behaves identically with no network. Any connection failure flips the
process to mock for good.

Exception *types* are logged, never their messages: a connection error's text
carries host and user from the DSN.
"""

from __future__ import annotations

import os
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone

from integrations import OFFLINE, emit

TIGER_SERVICE_URL = os.getenv("TIGER_SERVICE_URL")

#: DDL for the live mode, applied on first write if missing. `create_hypertable`
#: is what makes `time_bucket` fast at scale; harmless to re-run.
SQL_DDL = (
    "CREATE TABLE IF NOT EXISTS site_events ("
    " time TIMESTAMPTZ NOT NULL, subject TEXT NOT NULL,"
    " event TEXT NOT NULL, value DOUBLE PRECISION NOT NULL DEFAULT 0);"
    " SELECT create_hypertable('site_events', 'time', if_not_exists => TRUE);"
)
SQL_INSERT = (
    "INSERT INTO site_events (time, subject, event, value) VALUES ($1,$2,$3,$4)"
)
#: The daily rollup the S-curve and spend curve are built from — a real
#: `time_bucket` in live mode, mirrored bucket-for-bucket by `_mock_daily`.
SQL_DAILY = (
    "SELECT time_bucket('1 day', time) AS bucket, sum(value) AS total "
    "FROM site_events WHERE event = ANY($1) AND time > now() - make_interval(days=>$2) "
    "GROUP BY 1 ORDER BY 1"
)
SQL_RANGE = (
    "SELECT time, subject, event, value FROM site_events "
    "WHERE time > now() - make_interval(days=>$1) ORDER BY time"
)

# Mock storage when there is no DSN, when the demo is forced offline, or when
# storage is explicitly disabled — the last keeps the test suite hermetic.
_SENSORS_OFF = os.getenv("JENGA_SENSORS", "1").strip() == "0"
_mode = "mock" if (OFFLINE or _SENSORS_OFF or not TIGER_SERVICE_URL) else "tiger"
_pool = None
_ddl_applied = False
#: Mock store: (time, subject, event, value), append-only, insertion-ordered.
_events: list[tuple[datetime, str, str, float]] = []


def source() -> str:
    return _mode


def _go_mock(exc: Exception) -> None:
    global _mode
    if _mode != "mock":
        emit("warning", "tiger: falling back to mock event store", error=type(exc).__name__)
    _mode = "mock"


async def _get_pool():
    global _pool, _ddl_applied
    if _pool is None:
        import asyncpg

        # asyncpg understands `sslmode` in the DSN, so the string goes in as-is.
        _pool = await asyncpg.create_pool(
            TIGER_SERVICE_URL, min_size=1, max_size=3, command_timeout=5
        )
    if not _ddl_applied:
        async with _pool.acquire() as con:
            await con.execute(SQL_DDL)
        _ddl_applied = True
    return _pool


async def close() -> None:
    """Release the pool. Called from the FastAPI lifespan."""
    global _pool
    if _pool is None:
        return
    pool, _pool = _pool, None
    try:
        await pool.close()
    except Exception as exc:
        emit("warning", "tiger: pool close failed", error=type(exc).__name__)


async def record_event(
    subject: str, event: str, value: float = 0.0, ts: datetime | None = None
) -> None:
    """Land one timestamped site fact. Never raises — a full store is telemetry,
    not a dependency, and losing one point must not break a verify."""
    await record_events([(ts or datetime.now(timezone.utc), subject, event, float(value))])


async def record_events(rows: list[tuple[datetime, str, str, float]]) -> None:
    """rows: (time, subject, event, value)."""
    if not rows:
        return
    if _mode == "tiger":
        try:
            pool = await _get_pool()
            await pool.executemany(SQL_INSERT, rows)
            return
        except Exception as exc:
            _go_mock(exc)
    _events.extend(rows)


async def clear_events() -> None:
    """Wipe the event stream (tests, /api/reset re-seed).

    Live mode deletes the demo hypertable's rows too: `/api/reset` promises the
    seeded baseline back, and a reset that silently kept old events would redraw
    yesterday's curves over today's demo. Single-project table, so the unscoped
    delete is the honest implementation, not a shortcut.
    """
    if _mode == "tiger":
        try:
            pool = await _get_pool()
            await pool.execute("DELETE FROM site_events")
            return
        except Exception as exc:
            _go_mock(exc)
    _events.clear()


async def events(days: int = 90) -> list[dict]:
    """Every event in the window, oldest first: {time, subject, event, value}."""
    if _mode == "tiger":
        try:
            pool = await _get_pool()
            rows = await pool.fetch(SQL_RANGE, days)
            return [
                {"time": r["time"], "subject": r["subject"], "event": r["event"], "value": float(r["value"])}
                for r in rows
            ]
        except Exception as exc:
            _go_mock(exc)
    cutoff = datetime.now(timezone.utc) - timedelta(days=days)
    return [
        {"time": ts, "subject": s, "event": e, "value": v}
        for ts, s, e, v in _events
        if ts > cutoff
    ]


def _mock_daily(kinds: list[str], days: int) -> list[dict]:
    cutoff = datetime.now(timezone.utc) - timedelta(days=days)
    acc: dict[date, float] = defaultdict(float)
    for ts, _s, e, v in _events:
        if e in kinds and ts > cutoff:
            acc[ts.date()] += v
    return [{"day": d, "total": acc[d]} for d in sorted(acc)]


async def daily_totals(kinds: list[str], days: int = 90) -> list[dict]:
    """Per-day sums for a set of event kinds: [{day: date, total: float}].

    In live mode this is TimescaleDB's `time_bucket` doing the work; the mock
    mirrors it bucket-for-bucket so analytics behave identically offline.
    """
    if _mode == "tiger":
        try:
            pool = await _get_pool()
            rows = await pool.fetch(SQL_DAILY, kinds, days)
            return [{"day": r["bucket"].date(), "total": float(r["total"])} for r in rows]
        except Exception as exc:
            _go_mock(exc)
    return _mock_daily(kinds, days)
