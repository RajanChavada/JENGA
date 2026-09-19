CREATE EXTENSION IF NOT EXISTS timescaledb;

CREATE TABLE IF NOT EXISTS sensor_metrics (
  time        TIMESTAMPTZ NOT NULL,
  ticket_id   TEXT NOT NULL,
  sensor_type TEXT NOT NULL,
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

CREATE TABLE IF NOT EXISTS agent_telemetry (
  time TIMESTAMPTZ NOT NULL, run_id TEXT NOT NULL, ticket_id TEXT NOT NULL,
  node TEXT NOT NULL, latency_ms INTEGER NOT NULL, tokens_in INTEGER, tokens_out INTEGER
);
SELECT create_hypertable('agent_telemetry', 'time', if_not_exists => TRUE);
