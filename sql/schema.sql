-- JENGA schema (Postgres). The app always supplies ids explicitly
-- (crypto.randomUUID()), so no table relies on a UUID-generating column default.
--
-- Run once against a fresh database:
--   psql "$DATABASE_URL" -f sql/schema.sql

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
  status TEXT NOT NULL DEFAULT 'blocked',
  planned_start DATE,
  planned_end DATE,
  original_planned_end DATE,
  actual_start DATE,
  actual_end DATE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE tickets ADD COLUMN IF NOT EXISTS original_planned_end DATE;

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
