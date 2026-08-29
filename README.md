# Snehal Printers — Lead Generation Workflows

A standalone lead-generation + follow-up-email system for **Snehal Printers**
(snehalprinters.in), built on the same stack as Stellar Global Supplies'
workflow engine: React/Vite frontend, Cloudflare Workers + D1 backend,
Supabase for auth + lead storage, Tavily for company research, Cloudflare
Workers AI for all text generation, and Resend for sending mail from
**info@snehalprinters.in**.

Everything here is a **new, separate deployment** — its own D1 database, its
own Supabase project, its own Workers. Nothing is shared with the Stellar
Global Supplies project.

## What it does

1. **Find New Leads** — you give it a location (or leave it blank and it
   defaults to Bhosari / Pune MIDC / Pimpri-Chinchwad / Chakan), and it:
   - searches Tavily for a real, currently-operating company there
   - has no industry filter — every company is treated as a plausible print
     & stationery buyer
   - picks a product angle to lead with (rotates each run across 4 groups
     built from your product list: corporate stationery, reports &
     marketing collateral, ops documentation, labels/stickers/notepads)
   - scrapes the company's own website for a contact email (falls back to
     `info@<domain>` if none found)
   - saves the lead to Supabase
   - drafts a personalised outreach email with Workers AI
   - **pauses for your approval** before sending anything
2. **Follow Up on a Lead** — pick any saved lead, and it drafts a fresh
   follow-up email, again pausing for approval before sending.
3. Full **Workflow Progress**, **Approvals**, and **History** pages to watch
   runs live, review/edit drafts before they go out, and see everything
   that's ever been found or sent.

## Architecture

```
frontend/              React + Vite + Tailwind SPA (Cloudflare Pages)
workers/                Worker 1: API router (frontend ↔ backend, HTTP)
workers-job-runner/     Worker 2: job runner (cron, every 1 min, drives the pipeline)
d1/schema.sql           Cloudflare D1 schema (job_queue, workflow_runs, approval_queue)
supabase/migrations/    Supabase schema (leads table) + auth setup notes
```

Two Workers share one D1 database:
- **api-router** — the frontend calls this over HTTPS to start workflows,
  poll status, list/approve/reject approvals, and read leads.
- **job-runner** — runs on a 1-minute cron, picks up the next pending step
  from `job_queue`, executes it, and inserts the next step. This is what
  actually calls Tavily, Workers AI, and Resend.

Leads live in **Supabase** (Postgres). Everything about *running* the
workflow (job queue, run status, approval gates) lives in **D1** — cheap,
fast, no need to round-trip to Supabase for every step transition.

---

## Setup

### 1. Supabase — auth + leads table

1. Create a new Supabase project (or reuse one, but keep it separate from
   any other client's project).
2. In the SQL Editor, run `supabase/migrations/001_leads.sql`. This creates
   the `leads` table and locks it down with RLS (see the comments in that
   file — the frontend never touches `leads` directly; only the Cloudflare
   Workers backend does, using the service-role key).
3. **Create the one user account directly — no signup flow exists in this
   app.** In the Supabase dashboard: **Authentication → Users → Add user →
   Create new user.** Enter the email and a password directly, and check
   "Auto Confirm User" so no confirmation email is needed. That's the only
   account that will ever be able to log in, unless you create more the
   same way.
4. Grab three values for later:
   - **Project URL** (Settings → API → Project URL)
   - **anon public key** (Settings → API → anon key) — goes in the frontend
   - **service_role key** (Settings → API → service_role key) — goes in the
     Workers as a *secret*, never in the frontend

### 2. Cloudflare D1 — job/run/approval tables

```bash
cd workers
wrangler d1 create snehal-printers-workflows
```

Copy the `database_id` it prints into **both**
`workers/wrangler.toml` and `workers-job-runner/wrangler.toml`
(the `[[d1_databases]]` block — they must point at the same database).

```bash
wrangler d1 execute snehal-printers-workflows --file=../d1/schema.sql --remote
```

### 3. Resend — sending from info@snehalprinters.in

You said you'll send from **info@snehalprinters.in**, not Gmail, so this
uses [Resend](https://resend.com) (works with any custom domain, no OAuth
token refresh to babysit):

1. Sign up at resend.com, add `snehalprinters.in` as a domain (Domains →
   Add Domain).
2. Add the DNS records it gives you (SPF/DKIM, usually 2–3 TXT/CNAME
   records) via your **cPanel → Zone Editor** (or "DNS Zone Editor",
   naming varies by host) for `snehalprinters.in`. Verification usually
   takes a few minutes to a few hours after the records are added.
3. Once verified, create an API key (API Keys → Create API Key). This is
   your `RESEND_API_KEY`.

You do **not** need a Gmail app password, OAuth client, or refresh token —
that entire flow has been removed from this build.

### 4. Tavily — company search

Sign up at [tavily.com](https://tavily.com), grab an API key. Free tier is
enough to run this daily.

### 5. Cloudflare Workers — secrets

From the `workers/` directory, set these once (they're referenced by both
Workers since they share the same account):

```bash
wrangler secret put SUPABASE_URL          # https://YOUR_PROJECT.supabase.co
wrangler secret put SUPABASE_SERVICE_KEY  # the service_role key from step 1
wrangler secret put TAVILY_API_KEY
wrangler secret put RESEND_API_KEY
wrangler secret put SENDER_EMAIL          # info@snehalprinters.in
wrangler secret put REVIEWER_EMAIL        # comma-separated if more than one, e.g. "owner@snehalprinters.in,manager@snehalprinters.in"
wrangler secret put API_BASE_URL          # fill in AFTER step 6 below, then re-run this
```

Then repeat the same `wrangler secret put ...` commands from inside
`workers-job-runner/` — Workers don't share secrets across `wrangler.toml`
files even if they share a D1 database, so both need the full set.

### 6. Deploy the two Workers

```bash
cd workers && npm install && npm run deploy
```

This prints a URL like `https://snehal-printers-workflows.<subdomain>.workers.dev`.
**Set that as `API_BASE_URL`** (step 5) and re-run `wrangler secret put API_BASE_URL`
in both worker directories — the approval-email links need to know this
URL to build working approve/reject buttons.

```bash
cd ../workers-job-runner && npm install && npm run deploy
```

This one runs on a cron (`* * * * *`, every minute) — no public traffic, it
just polls `job_queue`.

### 7. Frontend

```bash
cd frontend
cp .env.example .env.local
# fill in VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY (from step 1)
# and VITE_API_URL (the api-router URL from step 6)
npm install
npm run build
```

Deploy `dist/` to Cloudflare Pages (or any static host). Point
`leads.snehalprinters.in` (or whatever subdomain you like) at it.

**Note:** the approval-confirmation page (`api-router.js`, in
`handleEmailAction`) currently links back to
`https://leads.snehalprinters.in/approvals` as a hardcoded "view in
dashboard" link — update that one line if you use a different subdomain.

### 8. Log in

Go to your deployed frontend, sign in with the email/password you created
directly in Supabase in step 1.3. There's no signup page — that's
intentional, per your request.

---

## Secrets checklist (both Workers need all of these)

| Secret | Example | Notes |
|---|---|---|
| `SUPABASE_URL` | `https://abcd.supabase.co` | |
| `SUPABASE_SERVICE_KEY` | `eyJ...` | service_role, never expose to frontend |
| `TAVILY_API_KEY` | `tvly-...` | |
| `RESEND_API_KEY` | `re_...` | |
| `SENDER_EMAIL` | `info@snehalprinters.in` | must be on a Resend-verified domain |
| `REVIEWER_EMAIL` | `owner@snehalprinters.in,manager@snehalprinters.in` | comma-separated — both get every "approve this lead" email; either can click approve/reject |
| `API_BASE_URL` | `https://snehal-printers-workflows.xxx.workers.dev` | set after first deploy |

No Bedrock, Groq, GitHub, Facebook/Instagram, or Gmail secrets are needed —
those were part of the original Stellar project's other workflows (social
posts, blog PRs, payment follow-ups) which this build doesn't include.

## Running it

- **Find New Leads**: Lead Generation page → "Find New Leads" tab → leave
  location blank (uses the Pune/Bhosari/MIDC belt) or type a specific area
  → Find Lead. Watch it move through the pipeline live.
- **Follow Up on a Lead**: same page → "Follow Up on a Lead" tab → pick a
  saved lead → Draft Follow-up.
- Either way, check the **Approvals** page (or the email link sent to
  `REVIEWER_EMAIL`) to review, optionally edit, then approve to send — or
  reject.
- The job-runner cron only processes one job per minute across the whole
  system, so a run typically takes 2–5 minutes end-to-end depending on how
  many steps it needs.

## Open questions / things you may want to adjust

- **Approval-page link domain** — hardcoded to `leads.snehalprinters.in` in
  `workers/src/api-router.js` (`handleEmailAction`). Change if you use a
  different subdomain.
- **Reply-to** — outreach emails currently reply back to `SENDER_EMAIL`
  itself. If you want replies to land somewhere else, pass a different
  `replyTo` into `sendViaResend(...)` in `lead-gen.js` / `lead-email.js`.
- **Duplicate check** is by domain substring match against Supabase — good
  enough for now, but if you start running this very frequently you may
  want a stricter unique constraint.
