"""Tiger Data (TimescaleDB) sensor stream: concrete-curing telemetry per ticket.

Two modes. "tiger" writes to the `sensor_metrics` hypertable and reads the
`sensor_metrics_5min` continuous aggregate. "mock" keeps a rolling deque per
ticket in memory so the simulator and the agent behave identically with no
network. Any connection failure flips the process to mock for good.

Exception *types* are logged, never their messages: a connection error's text
carries host and user from the DSN.
"""

from __future__ import annotations

import math
import os
from collections import defaultdict, deque
from datetime import datetime, timedelta, timezone

from integrations import OFFLINE, emit

TIGER_SERVICE_URL = os.getenv("TIGER_SERVICE_URL")
CURING_MIN_TEMP_C = 10.0  # ponytail: ACI 306 early-age minimum; real threshold depends on mix design

#: Readings required before the average is allowed to decide anything — roughly
#: 20 s at the 2 s tick. A verdict resting on five readings over eleven seconds
#: would not survive the obvious question ("how many readings is that based
#: on?"), and answering it badly undoes the whole argument that this evidence
#: source needs a time-series database at all. Ten over twenty seconds is a
#: defensible floor for a two-minute curing window.
SENSOR_MIN_SAMPLES = 10

SQL_LIVE = (
    "SELECT time_bucket(make_interval(secs=>$1), time) AS bucket, sensor_type, avg(reading) "
    "FROM sensor_metrics WHERE ticket_id=$2 AND time > now() - make_interval(secs=>$3) "
    "GROUP BY 1,2 ORDER BY 1"
)
SQL_AGG = (
    "SELECT bucket, sensor_type, avg_reading, min_reading, max_reading "
    "FROM sensor_metrics_5min WHERE ticket_id=$1 AND bucket > now() - make_interval(hours=>$2) "
    "ORDER BY bucket"
)

# Mock storage when there is no DSN, when the demo is forced offline, or when
# the simulator itself is off — the last of those keeps the test suite hermetic,
# since otherwise every `sensor_check` in test_agent.py would dial Tiger Cloud.
# Note the asymmetry with sensors.py: JENGA_OFFLINE=1 mocks the *storage* while
# the simulator keeps running, so the offline demo still has a moving sparkline.
_SENSORS_OFF = os.getenv("JENGA_SENSORS", "1").strip() == "0"
_mode = "mock" if (OFFLINE or _SENSORS_OFF or not TIGER_SERVICE_URL) else "tiger"
_pool = None
#: ticket_id -> deque[(ts, sensor_type, reading)]
_mock: dict[str, deque] = defaultdict(lambda: deque(maxlen=600))
#: ticket_id -> when its curing regime last changed. Readings taken under the
#: previous regime are not observations of the current one, so windows are
#: clamped to this: a slab that has just been hit by a cold snap is not
#: honestly described by an average still carrying two minutes of warm readings.
_regime_since: dict[str, datetime] = {}


def source() -> str:
    return _mode


def mark_regime_change(ticket_id: str) -> None:
    """Start a fresh averaging window for a ticket whose curing regime changed."""
    _regime_since[ticket_id] = datetime.now(timezone.utc)


def effective_window(ticket_id: str, window_s: int) -> int:
    """`window_s`, shortened to the age of the current curing regime.

    Untouched for a ticket that never had a scenario set, and back to the full
    `window_s` once the current regime has been running that long — so a pour
    that was cold from the start reads as a full window of cold, not as a
    handful of samples.

    Rounded up, not truncated. Truncating drops any reading taken in the
    fractional second after the regime changed, which shows up as the card
    flickering to "no telemetry" during the ten seconds the audience is watching
    the sparkline. Rounding up can instead reach under a second past the change,
    which is at most one reading at the 2 s tick — the cheaper error.
    """
    since = _regime_since.get(ticket_id)
    if since is None:
        return window_s
    elapsed = (datetime.now(timezone.utc) - since).total_seconds()
    return max(1, min(window_s, math.ceil(elapsed)))


def _go_mock(exc: Exception) -> None:
    global _mode
    if _mode != "mock":
        emit("warning", "tiger: falling back to mock sensor store", error=type(exc).__name__)
    _mode = "mock"


async def _get_pool():
    global _pool
    if _pool is None:
        import asyncpg

        # asyncpg understands `sslmode` in the DSN, so the string goes in as-is.
        _pool = await asyncpg.create_pool(
            TIGER_SERVICE_URL, min_size=1, max_size=3, command_timeout=5
        )
    return _pool


async def close() -> None:
    """Release the pool. Called from the FastAPI lifespan, after the simulator stops."""
    global _pool
    if _pool is None:
        return
    pool, _pool = _pool, None
    try:
        await pool.close()
    except Exception as exc:
        emit("warning", "tiger: pool close failed", error=type(exc).__name__)


async def insert_readings(rows: list[tuple[datetime, str, str, float]]) -> None:
    """rows: (time, ticket_id, sensor_type, reading)."""
    if _mode == "tiger":
        try:
            pool = await _get_pool()
            await pool.executemany(
                "INSERT INTO sensor_metrics (time, ticket_id, sensor_type, reading) VALUES ($1,$2,$3,$4)",
                rows,
            )
            return
        except Exception as exc:
            _go_mock(exc)
    for ts, ticket_id, sensor_type, reading in rows:
        _mock[ticket_id].append((ts, sensor_type, reading))


def _pivot(rows, key="bucket") -> list[dict]:
    """(bucket, sensor_type, agg...) rows -> one dict per bucket with temp/humidity columns."""
    out: dict = {}
    for r in rows:
        b = r[key]
        d = out.setdefault(b, {"bucket": b.isoformat(), "avg_temp": None, "avg_humidity": None})
        col = "temp" if r["sensor_type"] == "temp_c" else "humidity"
        d[f"avg_{col}"] = float(r["avg"])
        if "min" in r.keys():
            d[f"min_{col}"] = float(r["min"])
            d[f"max_{col}"] = float(r["max"])
    return [out[b] for b in sorted(out)]


def _mock_rows(ticket_id: str, window_s: int, bucket_s: int):
    cutoff = datetime.now(timezone.utc) - timedelta(seconds=window_s)
    acc: dict = defaultdict(list)
    for ts, st, val in _mock.get(ticket_id, ()):
        if ts > cutoff:
            b = datetime.fromtimestamp(int(ts.timestamp()) // bucket_s * bucket_s, tz=timezone.utc)
            acc[(b, st)].append(val)
    return [
        {"bucket": b, "sensor_type": st, "avg": sum(v) / len(v)}
        for (b, st), v in acc.items()
    ]


async def recent_buckets(ticket_id: str, window_s: int = 120, bucket_s: int = 10) -> list[dict]:
    window_s = effective_window(ticket_id, window_s)
    if _mode == "tiger":
        try:
            pool = await _get_pool()
            rows = await pool.fetch(SQL_LIVE, bucket_s, ticket_id, window_s)
            return _pivot(rows)
        except Exception as exc:
            _go_mock(exc)
    return _pivot(_mock_rows(ticket_id, window_s, bucket_s))


async def history_5min(ticket_id: str, hours: int = 1) -> list[dict]:
    """The continuous aggregate. Empty in mock mode — there is no aggregate to read."""
    if _mode != "tiger":
        return []
    try:
        pool = await _get_pool()
        rows = await pool.fetch(SQL_AGG, ticket_id, hours)
        return _pivot(
            [
                {"bucket": r["bucket"], "sensor_type": r["sensor_type"], "avg": r["avg_reading"],
                 "min": r["min_reading"], "max": r["max_reading"]}
                for r in rows
            ]
        )
    except Exception as exc:
        emit("warning", "tiger: history_5min unavailable", error=type(exc).__name__)
        return []


async def curing_status(ticket_id: str, window_s: int = 120) -> dict:
    """Curing verdict input. `window_s` in the result is the window actually measured.

    Callers render that number, so it has to be the effective one;
    `window_requested_s` is kept alongside it so "two minutes of data" and "two
    minutes asked for, forty-five seconds available" stay distinguishable.
    """
    effective = effective_window(ticket_id, window_s)
    temps: list[float] = []
    if _mode == "tiger":
        try:
            pool = await _get_pool()
            rows = await pool.fetch(
                "SELECT reading FROM sensor_metrics WHERE ticket_id=$1 AND sensor_type='temp_c' "
                "AND time > now() - make_interval(secs=>$2)",
                ticket_id, effective,
            )
            temps = [float(r["reading"]) for r in rows]
        except Exception as exc:
            _go_mock(exc)
    if _mode == "mock":
        cutoff = datetime.now(timezone.utc) - timedelta(seconds=effective)
        temps = [v for ts, st, v in _mock.get(ticket_id, ()) if st == "temp_c" and ts > cutoff]
    avg = sum(temps) / len(temps) if temps else None
    return {
        "avg_temp_c": round(avg, 2) if avg is not None else None,
        "min_temp_c": round(min(temps), 2) if temps else None,
        "samples": len(temps),
        # Too few readings is not the same fact as a warm slab, and neither is it
        # a cold one: below the floor this stays False and the arbiter's rule 0
        # cannot fire. Callers distinguish the two by comparing `samples`
        # against `min_samples`.
        "below_threshold": (
            len(temps) >= SENSOR_MIN_SAMPLES
            and avg is not None
            and avg < CURING_MIN_TEMP_C
        ),
        "threshold_c": CURING_MIN_TEMP_C,
        "min_samples": SENSOR_MIN_SAMPLES,
        "window_s": effective,
        "window_requested_s": window_s,
        "source": _mode,
    }
