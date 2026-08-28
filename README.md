# Snehal Printers — Product-Specific Lead Generation Pipeline

Single-tenant, standalone (separate from the Stellar Global Supplies platform).
Own Cloudflare account, own D1 database, own Worker, own Pages project.

**Stack:** Cloudflare Workers + D1 + Workers AI (Llama 3.1) + Tavily Search + Cloudflare Pages.
No Supabase, no AWS. Login users are created manually via a script — there is no signup page.

---

## How the pipeline works

1. Product list is scraped from `snehalprinters.in` (or added manually) → stored in D1.
2. For a chosen product + area (defaults to the whole Pune MIDC belt), the worker builds
   **8-12 targeted Tavily search queries** (see `worker/src/lib/queries.js`) that combine:
   - the product + your extra keywords
   - specific MIDC pockets (Bhosari, Chakan, Talawade, Hinjewadi, Ranjangaon, etc.)
   - B2B directory scoping (`site:indiamart.com`, `site:justdial.com`, `site:tradeindia.com`)
   - buyer-intent phrasing ("suppliers near", "requirement for", "corporate gifting", etc.)
3. Every search hit is passed to Workers AI (Llama 3.1 8B) which decides: is this a real
   company, is it actually in the target MIDC area, and how relevant is it to the product
   (0-100 score) — junk (news articles, directories' own homepage, out-of-area hits) is dropped.
4. For surviving hits, the worker scrapes the company's own site (homepage + `/contact`,
   `/about`, etc.) for a real email; if none is found it falls back to a `info@domain.com`
   pattern guess and flags it as "guessed" in the UI.
5. Leads are deduped by domain and saved to D1.
6. Workers AI drafts a short, specific outreach email per lead into an **approval queue** —
   nothing is ever sent automatically. You review/edit/approve in the dashboard, then hit Send.
7. Sending uses **MailChannels** (free from Cloudflare Workers, no extra email provider) — see
   the one-time DNS setup below.

---

## 1. Create the D1 database

```bash
cd worker
wrangler d1 create snehal-leadgen
# copy the returned database_id into worker/wrangler.toml -> [[d1_databases]] -> database_id
wrangler d1 execute snehal-leadgen --remote --file=../d1/schema.sql
```

## 2. Create your login user (manual, no signup UI)

```bash
node scripts/create-user.js "you@snehalprinters.in" "ChooseAStrongPassword" "Your Name"
```

This prints a `wrangler d1 execute` command — run it as shown to insert the user into D1.
Repeat for each teammate who needs access.

## 3. Set secrets (Cloudflare Secrets Store)

This uses the same **Secrets Store** pattern as the main Stellar workers repo (not
`wrangler secret put`). Create a store once (dashboard → Workers & Pages → Secrets Store,
or `wrangler secrets-store secret create`), then add:

- `TAVILY_API_KEY`
- `SENDER_EMAIL` — e.g. `leads@snehalprinters.in` (must have SPF/DKIM set up for MailChannels)

Then edit `worker/wrangler.toml` and replace `REPLACE_WITH_YOUR_SECRETS_STORE_ID` (in both
`[[secrets_store_secrets]]` blocks) with your store's ID, and `database_id` with your D1 ID.

Also set `DASHBOARD_URL` under `[vars]` in `wrangler.toml` to your Pages URL once you have it
(step 6) — it's used in the "please approve" notification email.

Workers AI needs no key — it's bound automatically via `[ai]`.

## 4. Deploy the Worker

```bash
cd worker
npm install
wrangler deploy
```

Note the deployed URL, e.g. `https://snehal-leadgen-api.<subdomain>.workers.dev`.

## 5. Point the frontend at the Worker

Edit `pages/assets/app.js`:
```js
const API_URL = 'https://snehal-leadgen-api.<subdomain>.workers.dev';
```

## 6. Deploy Pages

```bash
cd pages
wrangler pages project create snehal-leadgen-app
wrangler pages deploy .
```

## 7. (Optional but recommended) Enable sending via MailChannels

MailChannels' free Workers relay requires SPF + a domain lockdown TXT record on the sending
domain (`snehalprinters.in` or a subdomain like `leads.snehalprinters.in`), and since your
domain is currently hosted with an Indian registrar and DNS isn't on Cloudflare yet, there's
a migration step first too.

**See [`EMAIL_AND_DNS_SETUP.md`](./EMAIL_AND_DNS_SETUP.md) for the full walkthrough** —
covers moving `snehalprinters.in` DNS to Cloudflare without breaking your existing website/
email, then the exact MailChannels TXT/SPF records to add afterward.

Until that's done, leads and drafts still work fine, you'd just copy-paste the approved
email manually.

---

## Using it day to day

1. Log in.
2. **Settings tab** → set the Gmail address that should receive "N new leads ready for
   approval" emails. Do this first — the daily 10 AM run notifies whoever's set here.
3. **Products tab** → "Re-scan snehalprinters.in for products" once, to pull in 10-20 products
   automatically. Add anything missed (or a specific variant/spec) via the manual field —
   the extra "keywords" field feeds directly into the search prompt, so be specific
   (e.g. "corrugated box printing, food grade, 5-ply" not just "boxes").
4. **Run Pipeline tab** → pick product + area (whole Pune MIDC belt, or a specific pocket like
   "Chakan MIDC" if you want to focus) → Run. Takes 1-3 minutes; a live progress bar shows
   the current step (searching → analyzing → scraping emails → drafting → notifying).
5. **Leads tab** → review what came in, with relevance score and why it matched.
6. **Approval Queue tab** → edit/approve/reject the AI-drafted outreach emails, then Send.
7. **History tab** → every run (manual or the automatic 10 AM one), with leads found and
   emails sent per run.

## Automatic daily run (10:00 AM IST)

`[triggers] crons = ["30 4 * * *"]` in `worker/wrangler.toml` (04:30 UTC = 10:00 AM IST) fires
the `scheduled()` handler in `worker/src/index.js`, which runs lead-gen for **every active
product** across the whole Pune MIDC belt, then emails the address set in Settings once new
outreach drafts are ready for review. Nothing is ever sent without your approval — the cron
only generates drafts and notifies you.

To stop the daily run temporarily, set a product's `active` flag to 0 in D1:
```bash
wrangler d1 execute snehal-leadgen --remote --command="UPDATE products SET active=0 WHERE id=<id>"
```

## Tuning lead quality over time

- If you're getting too many irrelevant hits: raise the relevance threshold in
  `worker/src/index.js` (`analysis.relevance_score < 40` → `< 60`).
- If you're not getting enough leads: add more MIDC pockets to `PUNE_MIDC_AREAS` in
  `worker/src/lib/queries.js`, or add more directory sites to `DIRECTORY_SITES`.
- Product `keywords` field is the single biggest lever on result quality — treat it like a
  mini search brief (materials, use-case, industry it's usually bought for).
- Everything AI decides (company match, area match, relevance) is visible in the Leads table
  so you can spot bad patterns and adjust the prompts in `worker/src/lib/ai.js` directly.

## Project structure

```
snehal-leadgen/
├── worker/                  # Cloudflare Worker (API)
│   ├── src/
│   │   ├── index.js         # router + lead-gen orchestration
│   │   └── lib/
│   │       ├── auth.js      # PBKDF2 login + session tokens (D1-only)
│   │       ├── d1.js
│   │       ├── queries.js   # the crafted Tavily search-query builder
│   │       ├── tavily.js
│   │       ├── ai.js        # Workers AI relevance scoring + email drafting
│   │       ├── scrape.js    # email/phone extraction from company sites
│   │       └── products.js  # scrapes product list from snehalprinters.in
│   └── wrangler.toml
├── pages/                   # Static dashboard (no build step)
│   ├── index.html
│   └── assets/{style.css,app.js}
├── d1/schema.sql
├── scripts/create-user.js   # manual user creation (no signup page, by design)
└── README.md
```
