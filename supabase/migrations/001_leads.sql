-- Snehal Printers — Supabase migration 001
-- Run this in the Supabase SQL Editor (or via `supabase db push`).

CREATE TABLE IF NOT EXISTS leads (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_name    TEXT NOT NULL,
  website         TEXT,
  email           TEXT,
  phone           TEXT,
  industry        TEXT,
  address         TEXT,
  contact_name    TEXT,
  description     TEXT,
  product_focus   TEXT,                 -- which Snehal Printers product angle this lead was pitched
  status          TEXT NOT NULL DEFAULT 'new'
                  CHECK (status IN ('new','emailed','followed_up','converted','rejected')),
  source          TEXT NOT NULL DEFAULT 'lead-generation',
  workflow_run_id UUID,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_leads_email  ON leads(email);
CREATE INDEX IF NOT EXISTS idx_leads_status ON leads(status);

-- ── Row Level Security ───────────────────────────────────────────────────
-- The Cloudflare Workers backend talks to Supabase using the SERVICE ROLE
-- key (never exposed to the browser), so it bypasses RLS entirely — this is
-- what the workers-job-runner and workers/api-router use.
--
-- The frontend talks to Supabase directly ONLY for auth (sign in / sign out)
-- using the ANON key — it never queries the `leads` table directly, so RLS
-- on `leads` can stay locked down to "no anon access" by default.

ALTER TABLE leads ENABLE ROW LEVEL SECURITY;

-- No policies are created for `anon` or `authenticated` roles — this means
-- the anon/browser key can never read or write `leads` directly, even if a
-- bug ever tried to. All lead data flows through the Cloudflare Workers API
-- (which uses the service role key and is protected by Supabase Auth on the
-- frontend + your own network/access controls on the Worker).
