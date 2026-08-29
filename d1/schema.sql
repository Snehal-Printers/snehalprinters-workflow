-- D1 Schema — Snehal Printers Lead Workflow Engine
-- Run via: wrangler d1 execute snehal-printers-workflows --file=d1/schema.sql
--
-- Tables:
--   job_queue       (step-by-step job queue for the job-runner worker)
--   workflow_runs   (one row per triggered workflow, drives progress UI)
--   approval_queue  (human-in-the-loop approval gates)


-- ── job_queue ────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS job_queue (
  id               TEXT PRIMARY KEY,
  workflow_run_id  TEXT,
  workflow_type    TEXT NOT NULL,
  step_name        TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending','running','done','failed','stopped','waiting_for_approval')),
  payload          TEXT NOT NULL DEFAULT '{}',
  retry_count      INTEGER NOT NULL DEFAULT 0,
  error_msg        TEXT,
  created_at       TEXT NOT NULL,
  picked_up_at     TEXT,
  completed_at     TEXT
);

CREATE INDEX IF NOT EXISTS idx_job_queue_pending
  ON job_queue (status, created_at ASC);

CREATE INDEX IF NOT EXISTS idx_job_queue_run
  ON job_queue (workflow_run_id);


-- ── workflow_runs ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS workflow_runs (
  id            TEXT PRIMARY KEY,
  workflow_type TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'running'
                CHECK (status IN ('running','succeeded','failed','stopped','timed_out','awaiting_approval','paused')),
  input         TEXT DEFAULT '{}',
  output        TEXT,
  error_msg     TEXT,
  started_at    TEXT NOT NULL,
  completed_at  TEXT
);

CREATE INDEX IF NOT EXISTS idx_workflow_runs_status
  ON workflow_runs (status, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_workflow_runs_type
  ON workflow_runs (workflow_type, started_at DESC);


-- ── approval_queue ───────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS approval_queue (
  id               TEXT PRIMARY KEY,
  workflow_type    TEXT NOT NULL,
  workflow_run_id  TEXT,
  reference_id     TEXT,
  task_token       TEXT,
  payload          TEXT DEFAULT '{}',
  preview_html     TEXT DEFAULT '',
  status           TEXT NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending','approved','rejected','expired')),
  review_note      TEXT,
  email_token      TEXT,
  token_expires_at TEXT,
  token_used_at    TEXT,
  reviewed_at      TEXT,
  created_at       TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_approval_queue_status
  ON approval_queue (status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_approval_queue_run
  ON approval_queue (workflow_run_id);

CREATE INDEX IF NOT EXISTS idx_approval_queue_token
  ON approval_queue (email_token)
  WHERE email_token IS NOT NULL;
