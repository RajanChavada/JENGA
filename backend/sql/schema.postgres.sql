-- Postgres equivalent of sql/schema.sql — a temporary local stand-in used until
-- Snowflake credentials exist (see docs/plan.md "Local Postgres Dev Shim").
-- The app always supplies ids explicitly (crypto.randomUUID()), so unlike the
-- Snowflake schema there's no UUID-generating column default to worry about.
--
-- Run once against a fresh local database:
--   psql "$DATABASE_URL" -f sql/schema.postgres.sql

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS branches (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  name TEXT NOT NULL,
  forked_from_branch_id TEXT REFERENCES branches(id),
  forked_from_ticket_id TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  forked_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS tickets (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  branch_id TEXT NOT NULL REFERENCES branches(id),
  forked_from_id TEXT REFERENCES tickets(id),
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'blocked', -- 'blocked' | 'ready' | 'in_progress' | 'done' | 'cancelled' | 'under_review' | 'disputed'
  planned_start DATE,
  planned_end DATE,
  actual_start DATE,
  actual_end DATE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS dependencies (
  id TEXT PRIMARY KEY,
  branch_id TEXT NOT NULL REFERENCES branches(id),
  parent_ticket_id TEXT NOT NULL REFERENCES tickets(id),
  child_ticket_id TEXT NOT NULL REFERENCES tickets(id)
);

CREATE TABLE IF NOT EXISTS reports (
  id TEXT PRIMARY KEY,
  ticket_id TEXT NOT NULL REFERENCES tickets(id),
  submitted_by_role TEXT NOT NULL,
  report_text TEXT NOT NULL,
  media_url TEXT,
  gptzero_score DOUBLE PRECISION,
  gptzero_flag TEXT,
  owner_decision TEXT,
  decided_at TIMESTAMP,
  submitted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ---------------------------------------------------------------------------
-- JENGA (FastAPI backend) additions. Additive only; safe to re-apply.
-- tickets.status allowed values: 'blocked' | 'ready' | 'in_progress' | 'done'
--   | 'cancelled' | 'under_review' | 'disputed'
-- ---------------------------------------------------------------------------

ALTER TABLE tickets ADD COLUMN IF NOT EXISTS zone TEXT;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS blueprint_x DOUBLE PRECISION;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS blueprint_y DOUBLE PRECISION;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS duration_days INTEGER;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS spec_text TEXT;

-- Delay attribution results from the critical-path engine.
CREATE TABLE IF NOT EXISTS attributions (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id),
  ticket_id TEXT NOT NULL REFERENCES tickets(id),
  slip_days INTEGER,
  float_consumed INTEGER,
  project_slipped_days INTEGER,
  downstream_affected JSONB,
  attribution JSONB,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS purchase_orders (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id),
  ticket_id TEXT REFERENCES tickets(id),
  material TEXT,
  quantity TEXT,
  vendor TEXT,
  delivery_date DATE,
  status TEXT,
  last_action TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- AI verification verdict for a submitted report (verdict JSON shape owned by
-- the FastAPI verify route).
CREATE TABLE IF NOT EXISTS evidence_verdicts (
  id TEXT PRIMARY KEY,
  ticket_id TEXT NOT NULL REFERENCES tickets(id),
  report_id TEXT REFERENCES reports(id),
  verdict JSONB,
  created_at TIMESTAMPTZ DEFAULT now()
);
