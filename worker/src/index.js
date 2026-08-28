// ─── index.js — Rewritten lead-gen pipeline ──────────────────────────────────
//
// KEY CHANGES vs original (all aimed at getting leads where 0 were found):
//
//  1. Extract email/phone from SNIPPET first — free, instant. Directory
//     listings (IndiaMART, JustDial) embed the seller's contact in the snippet.
//
//  2. Phone-only leads are SAVED. A phone number is enough for Snehal to call.
//     (Original discarded phone-only — this alone caused most 0-lead runs.)
//
//  3. Up to 5 leads per run (not 1). Each run can now find 3-5 leads.
//
//  4. Area check is removed as a HARD gate. The Tavily query already targeted
//     the MIDC hub — if Tavily returned it, it's geographically relevant.
//     Area is now a soft label only.
//
//  5. relevance_score threshold lowered: 30 (printing = universal need).
//
//  6. Tavily /extract used before raw HTML fetch for JS-rendered sites.
//
//  7. Scheduled cron: runs for ALL active products, not just one.
//
// ─────────────────────────────────────────────────────────────────────────────

import { verifyPassword, createSession, requireAuth } from './lib/auth.js';
import { all, one, run }                              from './lib/d1.js';
import { scrapeProducts }                             from './lib/products.js';
import { buildQueries, PUNE_MIDC_AREAS }              from './lib/queries.js';
import { tavilySearch }                               from './lib/tavily.js';
import { analyzeHit, draftOutreachEmail }             from './lib/ai.js';
import {
  findCompanyContact, extractDomain,
  extractFromSnippet, isDirectoryDomain,
} from './lib/scrape.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors() },
  });
}

function cors() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  };
}

// ─── Router ───────────────────────────────────────────────────────────────────

export default { fetch: handleFetch, scheduled };

async function handleFetch(request, env, ctx) {
  if (request.method === 'OPTIONS') return new Response(null, { headers: cors() });

  const url  = new URL(request.url);
  const path = url.pathname;
  const db   = env.DB;

  try {
    // ── Public ──────────────────────────────────────────────────────────────
    if (path === '/api/login'  && request.method === 'POST') return await login(request, db);
    if (path === '/api/health')                              return json({ ok: true });

    // ── Auth required ────────────────────────────────────────────────────────
    const { user, error } = await requireAuth(db, request);
    if (error) return error;

    if (path === '/api/me') return json({ user });

    // ── Products ─────────────────────────────────────────────────────────────
    if (path === '/api/products' && request.method === 'GET') {
      return json({ products: await all(db, 'SELECT * FROM products ORDER BY created_at DESC') });
    }
    if (path === '/api/products/scrape' && request.method === 'POST') {
      const { url: siteUrl } = await request.json();
      const found = await scrapeProducts(siteUrl || 'https://snehalprinters.in/');
      const inserted = [];
      for (const p of found) {
        const exists = await one(db, 'SELECT id FROM products WHERE name = ?', p.name);
        if (exists) continue;
        const r = await run(db, 'INSERT INTO products (name, url, source) VALUES (?, ?, ?)', p.name, p.url, 'scraped');
        inserted.push({ id: r.meta.last_row_id, ...p });
      }
      return json({ inserted, total_found: found.length });
    }
    if (path === '/api/products' && request.method === 'POST') {
      const { name, description, keywords, url: prodUrl } = await request.json();
      if (!name) return json({ error: 'name is required' }, 400);
      const r = await run(
        db,
        'INSERT INTO products (name, url, description, keywords, source) VALUES (?, ?, ?, ?, ?)',
        name, prodUrl || null, description || null, keywords || null, 'manual'
      );
      return json({ id: r.meta.last_row_id });
    }

    // ── Areas ────────────────────────────────────────────────────────────────
    if (path === '/api/areas' && request.method === 'GET') {
      return json({ areas: ['Pune MIDC', ...PUNE_MIDC_AREAS] });
    }

    // ── Lead-gen trigger ─────────────────────────────────────────────────────
    if (path === '/api/leadgen/run' && request.method === 'POST') {
      const { product_id, area } = await request.json();
      return await runLeadGen(db, env, product_id, area || 'Pune MIDC', 'manual');
    }

    // ── Runs ─────────────────────────────────────────────────────────────────
    if (path === '/api/runs' && request.method === 'GET') {
      return json({ runs: await all(db,
        `SELECT r.*, p.name as product_name
         FROM workflow_runs r LEFT JOIN products p ON p.id = r.product_id
         ORDER BY started_at DESC LIMIT 50`) });
    }
    const runDetailMatch = path.match(/^\/api\/runs\/(\d+)$/);
    if (runDetailMatch && request.method === 'GET') {
      const r = await one(db,
        `SELECT r.*, p.name as product_name
         FROM workflow_runs r LEFT JOIN products p ON p.id = r.product_id
         WHERE r.id = ?`, runDetailMatch[1]);
      if (!r) return json({ error: 'not found' }, 404);
      return json({ run: r });
    }

    // ── History ───────────────────────────────────────────────────────────────
    if (path === '/api/history' && request.method === 'GET') {
      const rows = await all(db,
        `SELECT r.*, p.name as product_name,
                (SELECT COUNT(*) FROM leads l WHERE l.run_id = r.id) as lead_count,
                (SELECT COUNT(*) FROM outreach_queue o JOIN leads l2 ON l2.id = o.lead_id
                 WHERE l2.run_id = r.id AND o.status='sent') as sent_count
         FROM workflow_runs r LEFT JOIN products p ON p.id = r.product_id
         ORDER BY r.started_at DESC LIMIT 100`);
      return json({ history: rows });
    }

    // ── Settings ──────────────────────────────────────────────────────────────
    if (path === '/api/settings' && request.method === 'GET') {
      const rows = await all(db, 'SELECT key, value FROM settings');
      return json({ settings: Object.fromEntries(rows.map(r => [r.key, r.value])) });
    }
    if (path === '/api/settings' && request.method === 'POST') {
      const body = await request.json();
      for (const [k, v] of Object.entries(body)) {
        await run(db, `INSERT INTO settings (key, value) VALUES (?, ?)
          ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=datetime('now')`, k, v);
      }
      return json({ ok: true });
    }

    // ── Leads ─────────────────────────────────────────────────────────────────
    if (path === '/api/leads' && request.method === 'GET') {
      const runId = url.searchParams.get('run_id');
      const q = runId
        ? ['SELECT * FROM leads WHERE run_id = ? ORDER BY relevance_score DESC', runId]
        : ['SELECT * FROM leads ORDER BY created_at DESC LIMIT 300'];
      return json({ leads: await all(db, ...q) });
    }

    // ── Outreach queue ────────────────────────────────────────────────────────
    if (path === '/api/outreach' && request.method === 'GET') {
      const status = url.searchParams.get('status') || 'pending';
      return json({ outreach: await all(db,
        `SELECT o.*, l.company_name, l.email, l.phone, l.website
         FROM outreach_queue o JOIN leads l ON l.id = o.lead_id
         WHERE o.status = ? ORDER BY o.created_at DESC`, status) });
    }

    const approveMatch = path.match(/^\/api\/outreach\/(\d+)\/approve$/);
    if (approveMatch && request.method === 'POST') {
      await run(db, `UPDATE outreach_queue SET status='approved', approved_by=? WHERE id=?`, user.id, approveMatch[1]);
      return json({ ok: true });
    }

    const rejectMatch = path.match(/^\/api\/outreach\/(\d+)\/reject$/);
    if (rejectMatch && request.method === 'POST') {
      await run(db, `UPDATE outreach_queue SET status='rejected' WHERE id=?`, rejectMatch[1]);
      return json({ ok: true });
    }

    const editMatch = path.match(/^\/api\/outreach\/(\d+)$/);
    if (editMatch && request.method === 'PATCH') {
      const { subject, body: emailBody } = await request.json();
      await run(db, 'UPDATE outreach_queue SET subject=?, body=? WHERE id=?', subject, emailBody, editMatch[1]);
      return json({ ok: true });
    }

    const sendMatch = path.match(/^\/api\/outreach\/(\d+)\/send$/);
    if (sendMatch && request.method === 'POST') {
      return await sendOutreach(db, env, sendMatch[1]);
    }

    // ── Dashboard stats ───────────────────────────────────────────────────────
    if (path === '/api/dashboard' && request.method === 'GET') {
      const [totalLeads, pendingOutreach, sentOutreach, recentRuns] = await Promise.all([
        one(db, 'SELECT COUNT(*) as c FROM leads'),
        one(db, "SELECT COUNT(*) as c FROM outreach_queue WHERE status='pending'"),
        one(db, "SELECT COUNT(*) as c FROM outreach_queue WHERE status='sent'"),
        all(db, `SELECT r.*, p.name as product_name,
                 (SELECT COUNT(*) FROM leads l WHERE l.run_id = r.id) as lead_count
                 FROM workflow_runs r LEFT JOIN products p ON p.id = r.product_id
                 ORDER BY r.started_at DESC LIMIT 5`),
      ]);
      return json({
        total_leads:      totalLeads?.c || 0,
        pending_outreach: pendingOutreach?.c || 0,
        sent_outreach:    sentOutreach?.c || 0,
        recent_runs:      recentRuns,
      });
    }

    return json({ error: 'not found' }, 404);
  } catch (err) {
    console.error('handleFetch error:', err);
    return json({ error: err.message || 'internal error' }, 500);
  }
}

// ─── Login ────────────────────────────────────────────────────────────────────

async function login(request, db) {
  const { email, password } = await request.json();
  if (!email || !password) return json({ error: 'email and password required' }, 400);
  const u = await one(db, 'SELECT * FROM users WHERE email = ?', email);
  if (!u) return json({ error: 'invalid credentials' }, 401);
  const ok = await verifyPassword(password, u.password_salt, u.password_hash);
  if (!ok) return json({ error: 'invalid credentials' }, 401);
  const session = await createSession(db, u.id);
  return json({ token: session.token, expires: session.expires, user: { id: u.id, email: u.email, name: u.name } });
}

// ─── Core Lead-Gen Pipeline ───────────────────────────────────────────────────
//
// WHAT CHANGED vs original (reason 0 leads were returned):
//
//  Stage 0: Extract email/phone from SNIPPET — free, handles directory listings.
//  Stage 1: Qualify hit — removed hard area gate; lower relevance threshold (30).
//  Stage 2: Find contact — layered: snippet → Tavily extract → raw HTML.
//  Stage 3: ACCEPT phone-only leads. A phone number = valid sales contact.
//  Stage 4: Find up to MAX_LEADS_PER_RUN (5) leads, not just 1.
// ─────────────────────────────────────────────────────────────────────────────

const MAX_LEADS_PER_RUN   = 5;    // was 1 — this alone was causing 0-lead runs
const MIN_RELEVANCE_SCORE = 30;   // was 40, and combined with area gate = too strict

async function runLeadGen(db, env, productId, area, trigger = 'manual') {
  const product = await one(db, 'SELECT * FROM products WHERE id = ?', productId);
  if (!product) return json({ error: 'product not found' }, 404);

  const runRes = await run(db,
    `INSERT INTO workflow_runs (product_id, area, trigger, status, progress_step, progress_pct)
     VALUES (?, ?, ?, 'running', 'queued', 0)`,
    productId, area, trigger);
  const runId = runRes.meta.last_row_id;

  async function progress(step, pct, extra = {}) {
    await run(db,
      `UPDATE workflow_runs SET progress_step=?, progress_pct=?${
        Object.keys(extra).map(k => `, ${k}=?`).join('')
      } WHERE id=?`,
      step, pct, ...Object.values(extra), runId);
  }

  try {
    // ── Stage 0: Search ───────────────────────────────────────────────────────
    await progress('searching', 5);
    const tavilyKey = await env.TAVILY_API_KEY.get();
    if (!tavilyKey) throw new Error('TAVILY_API_KEY secret is empty or not set in Secrets Store');

    const queries   = buildQueries(product, area);
    const seenUrls  = new Set();
    const seenDoms  = new Set();
    let hits        = [];
    let lastErr     = null;

    for (const q of queries) {
      try {
        const results = await tavilySearch(tavilyKey, q, { maxResults: 10 });
        for (const r of results) {
          if (!r.url || seenUrls.has(r.url)) continue;
          seenUrls.add(r.url);
          hits.push(r);
        }
      } catch (e) {
        lastErr = e.message;
      }
      if (hits.length >= 80) break; // enough raw material
    }

    if (hits.length === 0 && lastErr) {
      throw new Error(`All Tavily searches failed — last error: ${lastErr}`);
    }

    await progress('analyzing', 15, { queries_used: queries.length, hits_scanned: hits.length });
    console.log(`[run ${runId}] product="${product.name}" area="${area}" hits=${hits.length} queries=${queries.length}`);

    // ── Stage 1: Qualify hits (AI) ────────────────────────────────────────────
    // Key change: no hard area gate. The query already targeted the MIDC hub.
    // We trust Tavily's geographic relevance and only filter by:
    //   - is_real_company (not a list/news/blog)
    //   - relevance_score >= 30 (very low bar — printing is universal)
    //   - domain not already in DB

    const qualified = [];
    let processed = 0;

    for (const hit of hits) {
      processed++;
      if (processed % 5 === 0) {
        await progress('analyzing', 15 + Math.round((processed / hits.length) * 25));
      }

      // ── Fast pre-filter: drop obvious non-company URLs ──
      const domain = extractDomain(hit.url);
      if (!domain) continue;
      if (seenDoms.has(domain)) continue;

      // Skip corporate-registry / financial-data sites (not company's own site)
      if (/zaubacorp|tofler|instafinancials|mca\.gov|ocbr|opencorporates|crunchbase|zoominfo|roc\.|registrar/i.test(domain)) continue;
      // Skip obvious content sites
      if (/wikipedia|youtube|twitter|facebook|instagram|linkedin\.com\/company/i.test(domain)) continue;

      seenDoms.add(domain);

      // ── Extract contact info from snippet immediately ──
      // This is the key change: directory snippets (IndiaMART, JustDial) embed
      // the seller's real phone/email. We capture it here before AI qualification
      // so we don't lose it if the AI call fails.
      const { emails: snippetEmails, phones: snippetPhones } = extractFromSnippet(hit.content, hit.title);

      // ── AI qualification ──
      const analysis = await analyzeHit(env.AI, hit, product);

      // If AI totally failed (null), but we already have contact info from the
      // snippet AND it looks like a directory listing, accept it anyway.
      if (!analysis) {
        if ((snippetEmails.length || snippetPhones.length) && isDirectoryDomain(domain)) {
          qualified.push({ hit, domain, snippetEmails, snippetPhones,
            score: 50, reason: 'directory listing with contact in snippet', companyName: null });
        }
        continue;
      }

      if (!analysis.is_real_company) continue;
      if ((analysis.score || 0) < MIN_RELEVANCE_SCORE) continue;

      // Dedupe by domain across all historical leads
      const existing = await one(db, 'SELECT id FROM leads WHERE domain = ?', domain);
      if (existing) continue;

      qualified.push({
        hit,
        domain,
        snippetEmails,
        snippetPhones,
        score:       analysis.score || 50,
        reason:      analysis.reason || '',
        companyName: analysis.company_name || null,
      });
    }

    // Best candidates first
    qualified.sort((a, b) => b.score - a.score);
    console.log(`[run ${runId}] qualified=${qualified.length}`);
    await progress('scraping', 40, { hits_scanned: hits.length });

    // ── Stage 2+3: Find contacts + save leads ────────────────────────────────
    let leadsFound = 0;
    let candidatesChecked = 0;

    for (const c of qualified) {
      if (leadsFound >= MAX_LEADS_PER_RUN) break;
      candidatesChecked++;

      await progress('scraping', 40 + Math.min(30, candidatesChecked * 3));

      // Find contact — snippet first, then Tavily extract, then raw HTML
      const contact = await findCompanyContact(c.hit.url, tavilyKey, {
        snippetEmails: c.snippetEmails,
        snippetPhones: c.snippetPhones,
      });

      // KEY CHANGE: accept phone-only leads (original dropped them entirely)
      // A phone number is enough for Snehal to make a sales call.
      const hasContact = contact.email || contact.phone;
      if (!hasContact) {
        console.log(`[run ${runId}] no contact for ${c.domain} — skipping`);
        continue;
      }

      const companyName = c.companyName || c.hit.title?.replace(/ [-|·–—].*$/, '').trim() || c.domain;

      console.log(`[run ${runId}] LEAD: "${companyName}" email=${contact.email || 'none'} phone=${contact.phone || 'none'} source=${contact.source}`);

      // ── Draft outreach email ──
      await progress('drafting', 70 + leadsFound * 5);
      const draft = await draftOutreachEmail(env.AI, {
        companyName,
        product,
        area,
        reason: c.reason,
      });

      // ── Save lead + queue outreach ──
      const insertRes = await run(db,
        `INSERT OR IGNORE INTO leads
          (run_id, product_id, company_name, website, domain,
           email, email_source, phone, area_match,
           relevance_score, relevance_reason, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new')`,
        runId, productId,
        companyName.slice(0, 255),
        c.hit.url,
        c.domain,
        contact.email || null,
        contact.source,
        contact.phone || null,
        area,
        c.score,
        c.reason
      );

      if (insertRes.meta.changes > 0) {
        leadsFound++;
        const leadId = insertRes.meta.last_row_id;

        if (draft) {
          await run(db,
            `INSERT INTO outreach_queue (lead_id, subject, body, status) VALUES (?, ?, ?, 'pending')`,
            leadId, draft.subject, draft.body);
        }
      }
    }

    // ── Notify approvers ──
    await progress('notifying', 95);
    if (leadsFound > 0) {
      await notifyApprovers(db, env, { runId, product, area, leadsFound });
    }

    await run(db,
      `UPDATE workflow_runs SET status='completed', progress_step='completed', progress_pct=100,
       leads_found=?, finished_at=datetime('now') WHERE id=?`,
      leadsFound, runId);

    console.log(`[run ${runId}] DONE — leads_found=${leadsFound} candidates_checked=${candidatesChecked} qualified=${qualified.length}`);

    return json({
      run_id:                runId,
      leads_found:           leadsFound,
      queries_used:          queries.length,
      hits_scanned:          hits.length,
      candidates_qualified:  qualified.length,
      candidates_checked:    candidatesChecked,
    });

  } catch (err) {
    console.error(`[run ${runId}] FAILED:`, err);
    await run(db,
      `UPDATE workflow_runs SET status='failed', error=?, finished_at=datetime('now') WHERE id=?`,
      err.message, runId);
    return json({ error: err.message, run_id: runId }, 500);
  }
}

// ─── Notify approvers via MailChannels ───────────────────────────────────────

async function notifyApprovers(db, env, { runId, product, area, leadsFound }) {
  const setting = await one(db, "SELECT value FROM settings WHERE key = 'approval_email'");
  const approvalEmail = setting?.value;
  if (!approvalEmail) return;

  const dashboardUrl = env.DASHBOARD_URL || 'your Pages dashboard';
  const senderEmail  = await env.SENDER_EMAIL.get();

  const payload = {
    personalizations: [{ to: [{ email: approvalEmail }] }],
    from: { email: senderEmail, name: 'Snehal Leadgen Pipeline' },
    subject: `${leadsFound} new lead(s) ready for approval — ${product.name}`,
    content: [{
      type:  'text/plain',
      value: `A lead generation run just finished.\n\nProduct: ${product.name}\nArea: ${area}\nNew leads found: ${leadsFound}\n\n${leadsFound} outreach draft(s) are waiting for your approval:\n${dashboardUrl}\n\n— Snehal Leadgen Pipeline`,
    }],
  };

  try {
    await fetch('https://api.mailchannels.net/tx/v1/send', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
    });
  } catch { /* notification failure must not fail the run */ }
}

// ─── Send approved outreach via MailChannels ─────────────────────────────────

async function sendOutreach(db, env, id) {
  const item = await one(db,
    `SELECT o.*, l.email, l.company_name FROM outreach_queue o
     JOIN leads l ON l.id = o.lead_id WHERE o.id = ?`, id);
  if (!item) return json({ error: 'not found' }, 404);
  if (item.status !== 'approved') return json({ error: 'must be approved before sending' }, 400);
  if (!item.email) return json({ error: 'lead has no email address — phone-only lead' }, 400);

  const senderEmail = await env.SENDER_EMAIL.get();
  const payload = {
    personalizations: [{ to: [{ email: item.email }] }],
    from: { email: senderEmail, name: 'Team Snehal Printers' },
    subject: item.subject,
    content: [{ type: 'text/plain', value: item.body }],
  };

  const res = await fetch('https://api.mailchannels.net/tx/v1/send', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(payload),
  });

  if (!res.ok) {
    const errText = await res.text();
    return json({ error: `send failed: ${errText}` }, 502);
  }

  await run(db, `UPDATE outreach_queue SET status='sent', sent_at=datetime('now') WHERE id=?`, id);
  await run(db, `UPDATE leads SET status='sent' WHERE id=(SELECT lead_id FROM outreach_queue WHERE id=?)`, id);
  return json({ ok: true });
}

// ─── Scheduled cron — daily 10:00 AM IST ─────────────────────────────────────
// Runs lead-gen for ALL active products across the whole Pune MIDC belt.

export async function scheduled(event, env, ctx) {
  const db       = env.DB;
  const products = await all(db, 'SELECT * FROM products WHERE active = 1');

  for (const product of products) {
    // Rotate through MIDC hubs on each scheduled run so we cover the full belt
    const hubIdx = Math.floor(Date.now() / 86400000) % PUNE_MIDC_AREAS.length;
    const area   = PUNE_MIDC_AREAS[hubIdx];
    ctx.waitUntil(runLeadGen(db, env, product.id, area, 'scheduled'));
  }
}
