# JENGA × Tiger Data — curing sensor stream as a fifth verification source

Date: 2026-09-19. Track: MLH "Best Use of Tiger Data". Also strengthens Rox "Best AI Agent" (conflicting-source resolution with a live physical signal).

## Why this shape

Ticket updates are low-frequency; they do not justify a time-series database. A concrete-curing sensor stream does: readings every 2 s per in-progress ticket, aggregated by a continuous aggregate, consumed by the verification agent. Tiger Cloud is Postgres, so the same instance also holds main's relational tables (projects, tickets, reports). One DSN, one database, relational + time-series. That is the "unified data stack" the track judges for.

## Decision

Option 1 (sensor stream + fifth agent node) is required. Option 3 (agent telemetry hypertable) is a stretch, implemented only if option 1 lands with time to spare.

## Verified facts

- Tiger service `db-87722` (project `km538xwlos`, service `xwat140zqt`, US West Oregon, 0.5 CPU / 2 GiB) exists and is in **Configuring** as of 2026-09-19 evening. Hostname does not resolve yet (NXDOMAIN); expected until status is Running. Credentials file: `/Users/jimmy/Downloads/tiger-cloud-db-87722-credentials.env` (never committed; values copied into `backend/.env`).
- Backend already depends on SQLAlchemy async + asyncpg. Tiger needs no new Python dependency.
- Frontend has no chart library. Sparklines are inline SVG `<polyline>`; no Recharts.
- Our ticket state `active` ↔ main's `in_progress`. That state is the sensor trigger.
- Local fallback: `timescale/timescaledb-ha:pg16` docker image ships both `timescaledb` and `vector` extensions, so it replaces `pgvector/pgvector:pg16` in `docker-compose.yml` without losing the memory feature.

## Architecture

```
sensors.py (asyncio loop, 2 s) ──► sensor_metrics (hypertable)
                                          │ continuous aggregate, 30 s refresh
                                          ▼
                                   sensor_metrics_5min
                                     │              │
        GET /api/sensors/{ticket}  ◄─┘              └─► agent.py::sensor_check ─► arbiter
                 │
        SensorStrip.tsx (sparkline under DAG)      VerdictPanel trace: 5th card
```

All Tiger access goes through one module, `backend/integrations/tiger.py`. Nothing else imports asyncpg for sensors.

## Components

### 1. `backend/sql/tiger.sql` (applied by the T1 schema script, idempotent)

```sql
CREATE EXTENSION IF NOT EXISTS timescaledb;

CREATE TABLE IF NOT EXISTS sensor_metrics (
  time        TIMESTAMPTZ NOT NULL,
  ticket_id   TEXT NOT NULL,
  sensor_type TEXT NOT NULL,            -- 'temp_c' | 'humidity_pct'
  reading     DOUBLE PRECISION NOT NULL
);
SELECT create_hypertable('sensor_metrics', 'time', if_not_exists => TRUE);
CREATE INDEX IF NOT EXISTS sensor_metrics_ticket_time ON sensor_metrics (ticket_id, time DESC);

CREATE MATERIALIZED VIEW IF NOT EXISTS sensor_metrics_5min
WITH (timescaledb.continuous) AS
SELECT time_bucket('5 minutes', time) AS bucket, ticket_id, sensor_type,
       AVG(reading) AS avg_reading, MIN(reading) AS min_reading, MAX(reading) AS max_reading
FROM sensor_metrics GROUP BY bucket, ticket_id, sensor_type
WITH NO DATA;

SELECT add_continuous_aggregate_policy('sensor_metrics_5min',
  start_offset => INTERVAL '1 hour', end_offset => INTERVAL '10 seconds',
  schedule_interval => INTERVAL '30 seconds', if_not_exists => TRUE);

-- stretch (option 3)
CREATE TABLE IF NOT EXISTS agent_telemetry (
  time TIMESTAMPTZ NOT NULL, run_id TEXT NOT NULL, ticket_id TEXT NOT NULL,
  node TEXT NOT NULL, latency_ms INTEGER NOT NULL, tokens_in INTEGER, tokens_out INTEGER
);
SELECT create_hypertable('agent_telemetry', 'time', if_not_exists => TRUE);
```

Demo reality: a 5-minute bucket with a 30 s refresh lag is too slow for a 3-minute pitch. The API therefore reads **both**: the continuous aggregate for history (proves the Tiger feature) and a live `time_bucket('10 seconds', …)` query over the raw hypertable for the last 2 minutes (proves it moves on stage). Both queries are shown in the UI's "SQL" tooltip so judges see the hypertable and the aggregate being used.

### 2. `backend/integrations/tiger.py`

- `TIGER_SERVICE_URL` env var (copied from `TIMESCALE_SERVICE_URL` in the creds file). One `asyncpg` pool, lazily created, `min_size=1, max_size=3`.
- `async insert_readings(rows: list[tuple[datetime, str, str, float]])` — `executemany`.
- `async recent_buckets(ticket_id, window_s=120, bucket_s=10) -> list[{bucket, avg_temp, avg_humidity}]` — raw hypertable, live.
- `async history_5min(ticket_id, hours=1) -> list[...]` — reads `sensor_metrics_5min`.
- `async curing_status(ticket_id) -> {avg_temp_c, min_temp_c, samples, below_threshold, threshold_c: 10.0, window_s: 120, source}`.
- Offline/mock: if `TIGER_SERVICE_URL` unset or first connect fails, a module-level `deque(maxlen=600)` per ticket implements the same four functions in Python; `source` is `"mock"` instead of `"tiger"`. No caller branches on source except the UI badge.
- Threshold constant `CURING_MIN_TEMP_C = 10.0` with a `# ponytail:` note (ACI 306 cold-weather guidance uses 10 °C for early-age concrete; real threshold depends on mix).

### 3. `backend/sensors.py`

- `start(app)` from FastAPI lifespan; single asyncio task; stops on shutdown.
- Every 2 s: for each ticket with status `in_progress`, emit `temp_c` and `humidity_pct`. Baseline temp 18 ± 0.6 °C random walk, humidity 55 ± 3 %.
- Scenario control: `POST /api/sensors/scenario/{ticket_id}` body `{"mode": "normal" | "cold"}`. `cold` drifts temp to 4 °C over ~20 s and holds. Default mode `normal`. Stored in a dict; not persisted.
- Off switch: `JENGA_SENSORS=0` disables the loop (tests, CI).

### 4. `backend/agent.py` — node `sensor_check`

Graph becomes `gptzero_gate → vision_analysis → historical_memory → sensor_check → arbiter`.

- `sensor_check` calls `curing_status(task_id)` and writes `state["sensor"]`. Trace card: title `4 · Site telemetry`, detail one of:
  - no samples → "No sensor telemetry for this ticket." signal `info`
  - ok → "Curing temp avg 18.2 °C over last 2 min (threshold 10 °C)." signal `ok`
  - below → "Curing temp avg 4.1 °C over last 2 min, below 10 °C threshold." signal `bad`
- Arbiter (deterministic) gains one rule, evaluated **before** the existing ones: if `sensor.below_threshold` and the claim text matches `/\b(cur(e|ed|ing)|pour(ed)?|set)\b/i` → `DISPUTED`, confidence `max(existing, 0.9)`, reasoning appended: "Contractor reports the pour as cured; site sensors show a 2-minute average of 4.1 °C against a 10 °C minimum. Claim and telemetry conflict." `actionable_request`: "Provide maturity-meter log or core sample before downstream formwork proceeds."
- Existing semantics untouched otherwise. Arbiter card renumbered `5 · Arbiter`.
- Frontend `synthesizeTrace` fallback gains the same fifth card so offline mode matches.

### 5. API

- `GET /api/sensors/{ticket_id}` → `{live: recent_buckets, history: history_5min, status: curing_status}`.
- `POST /api/sensors/scenario/{ticket_id}` as above.
- Verify endpoint unchanged; verdict JSON gains `sensor` block.

### 6. Frontend

- `frontend/src/components/SensorStrip.tsx`: renders when a task is selected and `status !== 'pending'`. Contents: label "Curing telemetry · Tiger Data", current avg temp, badge `tiger | mock`, inline SVG sparkline of `live` (120 px × 32 px, threshold as dashed line), and a small "cold snap" button that posts the `cold` scenario (demo control, hidden behind `?demo=1` query param is unnecessary; keep visible, it is a hackathon).
- Polls `GET /api/sensors/{id}` every 2 s while mounted. Zustand: `sensors: Record<string, SensorPayload>`, `loadSensors(id)`.
- `VerdictPanel`: trace grid becomes 5 columns on `lg`; evidence grid gains a "Site telemetry" column.
- Impact step (stepper from T8) unchanged.

### 7. Persistence integration with T1/T2

- `DATABASE_URL` in `backend/.env` points at the Tiger DSN once Running. `JENGA_STORAGE=postgres`. Main's relational tables and the hypertables live in the same database.
- `docker-compose.yml` image → `timescale/timescaledb-ha:pg16`, port 5433 unchanged. Same `tiger.sql` applies locally.
- Until Tiger resolves, development proceeds against the local container; switching is a one-line env change.

## Golden demo beat (fits the 5-step stepper)

Submit step: select P-106 "South platform pour", click **cold snap**. Sparkline drops toward 4 °C within 20 s. Submit the demo report that says "pour complete and cured". Verdict: DISPUTED, trace shows card 4 red with the Tiger reading, reasoning quotes both numbers. Impact: Zip PO delay + cascade. Judge asks "where's the time-series?" → hover the badge → shows `sensor_metrics` hypertable and `sensor_metrics_5min` continuous aggregate queries.

## Error handling

- Tiger unreachable at startup → log once, mock backend, `source:"mock"`. Never blocks app start.
- Tiger drops mid-demo → insert failures caught per tick, switch to mock, badge flips. No exceptions escape the loop.
- Continuous aggregate missing (e.g., extension unavailable) → `history_5min` returns `[]`, live path still works.
- Agent: `sensor_check` wrapped in try/except → `{samples: 0}`; verdicts never fail because of telemetry.

## Testing

- `backend/test_sensors.py`: mock backend only. (a) 60 normal readings → `below_threshold False`; (b) cold scenario after 20 ticks → `True`; (c) `sensor_check` + arbiter on SUB with claim "pour cured" and cold status → `DISPUTED` with "10 °C" in reasoning; (d) same claim, no samples → status unchanged from pre-existing behaviour.
- `test_agent.py` existing 10 cases must still pass (sensor node returns "no samples" in offline mode because `JENGA_SENSORS=0` there).
- Manual against Tiger once Running: apply `tiger.sql`, run app for 60 s, `SELECT count(*) FROM sensor_metrics` > 0, `CALL refresh_continuous_aggregate('sensor_metrics_5min', NULL, NULL)` then `SELECT * FROM sensor_metrics_5min LIMIT 5` returns rows.

## Stretch — option 3, `agent_telemetry`

If option 1 is done before 02:00 EDT: in `agent.py`, wrap each node with a timer; after the run, `executemany` one row per node into `agent_telemetry` (tokens from provider usage when available, else NULL). `GET /api/telemetry/summary` returns `time_bucket('1 minute')` avg latency per node over last hour. Small second sparkline in the VerdictPanel header: "pipeline p50 latency". ~40 lines backend, ~30 lines frontend. Cut without regret.

## Out of scope

- Real sensor hardware or MQTT ingestion.
- Compression policies, retention policies, hyperfunctions beyond `time_bucket`.
- Snowflake path in main.

## Still on the user

- Confirm Tiger service reaches **Running**; if the hostname changes, re-download the credentials file.
- Copy `TIMESCALE_SERVICE_URL` into `backend/.env` as `TIGER_SERVICE_URL` and (once ready) as `DATABASE_URL`. Never commit either file.
