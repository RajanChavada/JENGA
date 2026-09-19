-- JENGA schema — Snowflake is the single system of record (see docs/plan.md
-- for why: hackathon sponsor-track visibility beats OLTP/OLAP purity here).
--
-- Run once against a fresh database:
--   snowsql -f sql/schema.sql
-- or paste into a Snowsight worksheet.

CREATE TABLE IF NOT EXISTS projects (
  id STRING DEFAULT UUID_STRING() PRIMARY KEY,
  name STRING NOT NULL,
  created_at TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP()
);

-- The trunk of a project is the branch row with forked_from_branch_id IS NULL.
CREATE TABLE IF NOT EXISTS branches (
  id STRING DEFAULT UUID_STRING() PRIMARY KEY,
  project_id STRING NOT NULL REFERENCES projects(id),
  name STRING NOT NULL,
  forked_from_branch_id STRING REFERENCES branches(id),
  forked_from_ticket_id STRING,
  status STRING NOT NULL DEFAULT 'active', -- 'active' | 'merged'
  forked_at TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP()
);

CREATE TABLE IF NOT EXISTS tickets (
  id STRING DEFAULT UUID_STRING() PRIMARY KEY,
  project_id STRING NOT NULL REFERENCES projects(id),
  branch_id STRING NOT NULL REFERENCES branches(id),
  -- Set when this row is a fork's copy of an existing trunk ticket; NULL when the
  -- ticket was created fresh inside a branch. Drives the merge conflict check
  -- (lib/branch.ts) and lets merge overwrite the original row by id instead of
  -- juggling id remapping across dependency edges.
  forked_from_id STRING REFERENCES tickets(id),
  title STRING NOT NULL,
  description STRING,
  status STRING NOT NULL DEFAULT 'blocked', -- 'blocked' | 'ready' | 'in_progress' | 'done' | 'cancelled' | 'under_review' | 'disputed'
  planned_start DATE,
  planned_end DATE,
  actual_start DATE,
  actual_end DATE,
  created_at TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP(),
  updated_at TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP()
);

-- DAG edges, scoped per branch: parent must be 'done' before child can leave 'blocked' (AND-join).
CREATE TABLE IF NOT EXISTS dependencies (
  id STRING DEFAULT UUID_STRING() PRIMARY KEY,
  branch_id STRING NOT NULL REFERENCES branches(id),
  parent_ticket_id STRING NOT NULL REFERENCES tickets(id),
  child_ticket_id STRING NOT NULL REFERENCES tickets(id)
);

CREATE TABLE IF NOT EXISTS reports (
  id STRING DEFAULT UUID_STRING() PRIMARY KEY,
  ticket_id STRING NOT NULL REFERENCES tickets(id),
  submitted_by_role STRING NOT NULL, -- 'contractor'
  report_text STRING NOT NULL,
  media_url STRING,
  gptzero_score FLOAT, -- probability the text is AI-generated, per GPTZero
  gptzero_flag STRING, -- 'human' | 'mixed' | 'ai' | 'unavailable'
  owner_decision STRING, -- NULL | 'approved' | 'rejected'
  decided_at TIMESTAMP_NTZ,
  submitted_at TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP()
);

-- ---------------------------------------------------------------------------
-- JENGA (FastAPI backend) additions. Additive only; safe to re-apply.
-- tickets.status allowed values: 'blocked' | 'ready' | 'in_progress' | 'done'
--   | 'cancelled' | 'under_review' | 'disputed'
-- ---------------------------------------------------------------------------

ALTER TABLE IF EXISTS tickets ADD COLUMN IF NOT EXISTS zone STRING;
ALTER TABLE IF EXISTS tickets ADD COLUMN IF NOT EXISTS blueprint_x FLOAT;
ALTER TABLE IF EXISTS tickets ADD COLUMN IF NOT EXISTS blueprint_y FLOAT;
ALTER TABLE IF EXISTS tickets ADD COLUMN IF NOT EXISTS duration_days NUMBER;
ALTER TABLE IF EXISTS tickets ADD COLUMN IF NOT EXISTS spec_text STRING;

-- Delay attribution results from the critical-path engine.
CREATE TABLE IF NOT EXISTS attributions (
  id STRING DEFAULT UUID_STRING() PRIMARY KEY,
  project_id STRING REFERENCES projects(id),
  ticket_id STRING NOT NULL REFERENCES tickets(id),
  slip_days NUMBER,
  float_consumed NUMBER,
  project_slipped_days NUMBER,
  downstream_affected VARIANT,
  attribution VARIANT,
  created_at TIMESTAMP_TZ DEFAULT CURRENT_TIMESTAMP()
);

CREATE TABLE IF NOT EXISTS purchase_orders (
  id STRING DEFAULT UUID_STRING() PRIMARY KEY,
  project_id STRING REFERENCES projects(id),
  ticket_id STRING REFERENCES tickets(id),
  material STRING,
  quantity STRING,
  vendor STRING,
  delivery_date DATE,
  status STRING,
  last_action STRING,
  created_at TIMESTAMP_TZ DEFAULT CURRENT_TIMESTAMP()
);

-- AI verification verdict for a submitted report (verdict JSON shape owned by
-- the FastAPI verify route).
CREATE TABLE IF NOT EXISTS evidence_verdicts (
  id STRING DEFAULT UUID_STRING() PRIMARY KEY,
  ticket_id STRING NOT NULL REFERENCES tickets(id),
  report_id STRING REFERENCES reports(id),
  verdict VARIANT,
  created_at TIMESTAMP_TZ DEFAULT CURRENT_TIMESTAMP()
);
