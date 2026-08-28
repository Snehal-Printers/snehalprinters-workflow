import { verifyPassword, createSession, requireAuth } from './lib/auth.js';
import { all, one, run } from './lib/d1.js';
import { scrapeProducts } from './lib/products.js';
import { buildQueries, PUNE_MIDC_AREAS } from './lib/queries.js';
import { tavilySearch } from './lib/tavily.js';
import { analyzeHit, draftOutreachEmail } from './lib/ai.js';
import { findCompanyEmail, extractDomain } from './lib/scrape.js';

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

export default {
  fetch: handleFetch,
  scheduled,
};

async function handleFetch(request, env, ctx) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors() });

    const url = new URL(request.url);
    const path = url.pathname;
    const db = env.DB;

    try {
      // ---- Public ----
      if (path === '/api/login' && request.method === 'POST') return await login(request, db);
      if (path === '/api/health') return json({ ok: true });

      // ---- Everything below requires auth ----
      const { user, error } = await requireAuth(db, request);
      if (error) return error;

      if (path === '/api/me') return json({ user });

      if (path === '/api/products' && request.method === 'GET') {
        return json({ products: await all(db, 'SELECT * FROM products ORDER BY created_at DESC') });
      }

      if (path === '/api/products/scrape' && request.method === 'POST') {
        const { url: siteUrl } = await request.json();
        const found = await scrapeProducts(siteUrl || 'https://snehalprinters.in/');
        const inserted = [];
        for (const p of found) {
          const existing = await one(db, 'SELECT id FROM products WHERE name = ?', p.name);
          if (existing) continue;
          const res = await run(db, 'INSERT INTO products (name, url, source) VALUES (?, ?, ?)', p.name, p.url, 'scraped');
          inserted.push({ id: res.meta.last_row_id, ...p });
        }
        return json({ inserted, total_found: found.length });
      }

      if (path === '/api/products' && request.method === 'POST') {
        const { name, description, keywords, url: prodUrl } = await request.json();
        if (!name) return json({ error: 'name is required' }, 400);
        const res = await run(
          db,
          'INSERT INTO products (name, url, description, keywords, source) VALUES (?, ?, ?, ?, ?)',
          name,
          prodUrl || null,
          description || null,
          keywords || null,
          'manual'
        );
        return json({ id: res.meta.last_row_id });
      }

      if (path === '/api/areas' && request.method === 'GET') {
        return json({ areas: ['Pune MIDC', ...PUNE_MIDC_AREAS] });
      }

      if (path === '/api/leadgen/run' && request.method === 'POST') {
        const { product_id, area } = await request.json();
        return await runLeadGen(db, env, product_id, area || 'Pune MIDC', 'manual');
      }

      if (path === '/api/runs' && request.method === 'GET') {
        return json({ runs: await all(db, 'SELECT r.*, p.name as product_name FROM workflow_runs r LEFT JOIN products p ON p.id = r.product_id ORDER BY started_at DESC LIMIT 50') });
      }

      // Single run detail — used by the frontend to poll live progress while a run is in flight.
      const runDetailMatch = path.match(/^\/api\/runs\/(\d+)$/);
      if (runDetailMatch && request.method === 'GET') {
        const r = await one(
          db,
          'SELECT r.*, p.name as product_name FROM workflow_runs r LEFT JOIN products p ON p.id = r.product_id WHERE r.id = ?',
          runDetailMatch[1]
        );
        if (!r) return json({ error: 'not found' }, 404);
        return json({ run: r });
      }

      // History = every run, with leads + outreach counts, newest first. Powers the History tab.
      if (path === '/api/history' && request.method === 'GET') {
        const rows = await all(
          db,
          `SELECT r.*, p.name as product_name,
                  (SELECT COUNT(*) FROM leads l WHERE l.run_id = r.id) as lead_count,
                  (SELECT COUNT(*) FROM outreach_queue o JOIN leads l2 ON l2.id = o.lead_id WHERE l2.run_id = r.id AND o.status='sent') as sent_count
           FROM workflow_runs r LEFT JOIN products p ON p.id = r.product_id
           ORDER BY r.started_at DESC LIMIT 100`
        );
        return json({ history: rows });
      }

      if (path === '/api/settings' && request.method === 'GET') {
        const rows = await all(db, 'SELECT key, value FROM settings');
        const settings = Object.fromEntries(rows.map((r) => [r.key, r.value]));
        return json({ settings });
      }

      if (path === '/api/settings' && request.method === 'POST') {
        const body = await request.json();
        for (const [key, value] of Object.entries(body)) {
          await run(db, "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=datetime('now')", key, value);
        }
        return json({ ok: true });
      }

      if (path === '/api/leads' && request.method === 'GET') {
        const runId = url.searchParams.get('run_id');
        const q = runId
          ? ['SELECT * FROM leads WHERE run_id = ? ORDER BY relevance_score DESC', runId]
          : ['SELECT * FROM leads ORDER BY created_at DESC LIMIT 200'];
        return json({ leads: await all(db, ...q) });
      }

      if (path === '/api/outreach' && request.method === 'GET') {
        const status = url.searchParams.get('status') || 'pending';
        const items = await all(
          db,
          `SELECT o.*, l.company_name, l.email, l.website FROM outreach_queue o JOIN leads l ON l.id = o.lead_id WHERE o.status = ? ORDER BY o.created_at DESC`,
          status
        );
        return json({ outreach: items });
      }

      const approveMatch = path.match(/^\/api\/outreach\/(\d+)\/approve$/);
      if (approveMatch && request.method === 'POST') {
        await run(db, "UPDATE outreach_queue SET status='approved', approved_by=? WHERE id=?", user.id, approveMatch[1]);
        return json({ ok: true });
      }

      const rejectMatch = path.match(/^\/api\/outreach\/(\d+)\/reject$/);
      if (rejectMatch && request.method === 'POST') {
        await run(db, "UPDATE outreach_queue SET status='rejected' WHERE id=?", rejectMatch[1]);
        return json({ ok: true });
      }

      const editMatch = path.match(/^\/api\/outreach\/(\d+)$/);
      if (editMatch && request.method === 'PATCH') {
        const { subject, body } = await request.json();
        await run(db, 'UPDATE outreach_queue SET subject=?, body=? WHERE id=?', subject, body, editMatch[1]);
        return json({ ok: true });
      }

      const sendMatch = path.match(/^\/api\/outreach\/(\d+)\/send$/);
      if (sendMatch && request.method === 'POST') {
        return await sendOutreach(db, env, sendMatch[1]);
      }

      return json({ error: 'not found' }, 404);
    } catch (err) {
      return json({ error: err.message || 'internal error' }, 500);
    }
}

async function login(request, db) {
  const { email, password } = await request.json();
  if (!email || !password) return json({ error: 'email and password required' }, 400);
  console.log('LOGIN ATTEMPT', JSON.stringify({ email, passwordLen: password.length }));
  const u = await one(db, 'SELECT * FROM users WHERE email = ?', email);
  console.log('USER FOUND', JSON.stringify(u ? { id: u.id, email: u.email, hashLen: u.password_hash.length, saltLen: u.password_salt.length } : null));
  if (!u) return json({ error: 'invalid credentials' }, 401);
  const ok = await verifyPassword(password, u.password_salt, u.password_hash);
  console.log('VERIFY RESULT', ok);
  if (!ok) return json({ error: 'invalid credentials' }, 401);
  const session = await createSession(db, u.id);
  return json({ token: session.token, expires: session.expires, user: { id: u.id, email: u.email, name: u.name } });
}

// ---- Core lead-gen workflow ----
async function runLeadGen(db, env, productId, area, trigger = 'manual') {
  const product = await one(db, 'SELECT * FROM products WHERE id = ?', productId);
  if (!product) return json({ error: 'product not found' }, 404);

  const runRes = await run(
    db,
    "INSERT INTO workflow_runs (product_id, area, trigger, status, progress_step, progress_pct) VALUES (?, ?, ?, 'running', 'queued', 0)",
    productId,
    area,
    trigger
  );
  const runId = runRes.meta.last_row_id;

  async function progress(step, pct) {
    await run(db, 'UPDATE workflow_runs SET progress_step=?, progress_pct=? WHERE id=?', step, pct, runId);
  }

  try {
    await progress('searching', 10);
    const queries = buildQueries(product, area);
    const seenUrls = new Set();
    let hits = [];

    for (const q of queries) {
      try {
        const results = await tavilySearch(env.TAVILY_API_KEY, q, { maxResults: 8 });
        for (const r of results) {
          if (seenUrls.has(r.url)) continue;
          seenUrls.add(r.url);
          hits.push(r);
        }
      } catch (e) {
        // one bad query shouldn't kill the whole run
        continue;
      }
      if (hits.length > 60) break; // cap total work per run
    }

    await run(db, 'UPDATE workflow_runs SET queries_used=?, hits_scanned=? WHERE id=?', queries.length, hits.length, runId);
    await progress('analyzing', 35);

    let leadsFound = 0;
    let processed = 0;

    for (const hit of hits) {
      processed++;
      // progress climbs from 35% -> 90% across analyze+scrape+draft phases
      await progress(processed / hits.length < 0.5 ? 'analyzing' : processed / hits.length < 0.8 ? 'scraping' : 'drafting', 35 + Math.round((processed / Math.max(hits.length, 1)) * 55));
      const analysis = await analyzeHit(env.AI, hit, product, area);
      if (!analysis.is_company || !analysis.is_pune_midc_area) continue;
      if ((analysis.relevance_score || 0) < 40) continue;

      const domain = extractDomain(hit.url);
      if (!domain) continue;

      const existing = await one(db, 'SELECT id FROM leads WHERE domain = ?', domain);
      if (existing) continue; // dedupe by domain across all runs

      const emailInfo = await findCompanyEmail(hit.url);

      const insertRes = await run(
        db,
        `INSERT OR IGNORE INTO leads
          (run_id, product_id, company_name, website, domain, email, email_source, phone, area_match, relevance_score, relevance_reason, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new')`,
        runId,
        productId,
        analysis.company_name || hit.title,
        hit.url,
        domain,
        emailInfo.email,
        emailInfo.source,
        (emailInfo.phones && emailInfo.phones[0]) || null,
        analysis.area_evidence,
        analysis.relevance_score,
        analysis.relevance_reason
      );

      if (insertRes.meta.changes > 0) {
        leadsFound++;
        const leadId = insertRes.meta.last_row_id;

        const draft = await draftOutreachEmail(env.AI, {
          companyName: analysis.company_name || hit.title,
          product,
          area,
          relevanceReason: analysis.relevance_reason,
        });

        await run(
          db,
          `INSERT INTO outreach_queue (lead_id, subject, body, status) VALUES (?, ?, ?, 'pending')`,
          leadId,
          draft.subject,
          draft.body
        );
      }
    }

    await progress('notifying', 95);
    if (leadsFound > 0) {
      await notifyApprovers(db, env, { runId, product, area, leadsFound });
    }

    await run(db, "UPDATE workflow_runs SET status='completed', progress_step='completed', progress_pct=100, leads_found=?, finished_at=datetime('now') WHERE id=?", leadsFound, runId);
    return json({ run_id: runId, leads_found: leadsFound, queries_used: queries.length, hits_scanned: hits.length });
  } catch (err) {
    await run(db, "UPDATE workflow_runs SET status='failed', error=?, finished_at=datetime('now') WHERE id=?", err.message, runId);
    return json({ error: err.message, run_id: runId }, 500);
  }
}

// Emails whoever is set in Settings ("Send approvals to") to say new outreach
// drafts are waiting. Uses MailChannels — same free relay as sendOutreach().
async function notifyApprovers(db, env, { runId, product, area, leadsFound }) {
  const setting = await one(db, "SELECT value FROM settings WHERE key = 'approval_email'");
  const approvalEmail = setting?.value;
  if (!approvalEmail) return; // not configured yet — skip silently, drafts still sit in the queue

  const dashboardUrl = env.DASHBOARD_URL || 'your Pages dashboard';
  const body =
    `A lead generation run just finished.\n\n` +
    `Product: ${product.name}\n` +
    `Area: ${area}\n` +
    `New leads found: ${leadsFound}\n\n` +
    `${leadsFound} outreach email draft(s) are waiting for your approval in the Approval Queue tab: ${dashboardUrl}\n\n` +
    `— Snehal Leadgen Pipeline`;

  const payload = {
    personalizations: [{ to: [{ email: approvalEmail }] }],
    from: { email: env.SENDER_EMAIL, name: 'Snehal Leadgen Pipeline' },
    subject: `${leadsFound} new lead(s) ready for approval — ${product.name}`,
    content: [{ type: 'text/plain', value: body }],
  };

  try {
    await fetch('https://api.mailchannels.net/tx/v1/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch {
    // notification failure shouldn't fail the run — drafts are already saved
  }
}

// ---- Scheduled trigger: every day 10:00 AM IST (see [triggers] in wrangler.toml) ----
// Runs lead-gen for every active product across the whole Pune MIDC belt.
export async function scheduled(event, env, ctx) {
  const db = env.DB;
  const products = await all(db, 'SELECT * FROM products WHERE active = 1');
  for (const product of products) {
    ctx.waitUntil(runLeadGen(db, env, product.id, 'Pune MIDC', 'scheduled'));
  }
}

// MailChannels — free outbound email from Cloudflare Workers, no separate email
// provider needed. Requires SPF/DKIM domain setup once (see README).
async function sendOutreach(db, env, id) {
  const item = await one(
    db,
    `SELECT o.*, l.email, l.company_name FROM outreach_queue o JOIN leads l ON l.id = o.lead_id WHERE o.id = ?`,
    id
  );
  if (!item) return json({ error: 'not found' }, 404);
  if (item.status !== 'approved') return json({ error: 'must be approved before sending' }, 400);
  if (!item.email) return json({ error: 'lead has no email' }, 400);

  const payload = {
    personalizations: [{ to: [{ email: item.email }] }],
    from: { email: env.SENDER_EMAIL, name: 'Team Snehal Printers' },
    subject: item.subject,
    content: [{ type: 'text/plain', value: item.body }],
  };

  const res = await fetch('https://api.mailchannels.net/tx/v1/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const errText = await res.text();
    return json({ error: `send failed: ${errText}` }, 502);
  }

  await run(db, "UPDATE outreach_queue SET status='sent', sent_at=datetime('now') WHERE id=?", id);
  await run(db, "UPDATE leads SET status='sent' WHERE id=(SELECT lead_id FROM outreach_queue WHERE id=?)", id);
  return json({ ok: true });
}