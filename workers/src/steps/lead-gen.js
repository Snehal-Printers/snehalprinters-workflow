/**
 * Lead Generation — Snehal Printers
 *
 * Input: location only (defaults to Pune / Bhosari / Pune MIDC area)
 * Goal: find COMPANIES (any company — our products are generic and every
 *       company needs some form of print) in that location who could buy
 *       Snehal Printers' products.
 *
 * Snehal Printers products (from https://snehalprinters.in/):
 *   Offset Printing, Digital Printing, Estimations & Quotations, Letter Head,
 *   Annual Reports, Challan, Gate Pass, Business Cards, Bill Books,
 *   Business Form, Envelopes, Registers, Delivery Challan,
 *   Newsletters & Periodicals, Flyers & Leaflets, Office Files,
 *   Sales Brochures, Vouchers & Tags, Labels & Stickers, Parking Stickers,
 *   Notepads & Deskpads
 *
 * Because print/stationery is a near-universal business need, this pipeline
 * does NOT filter by industry/buyer-type the way a niche-product pipeline
 * would — it simply finds real, active companies in the target location and
 * pitches Snehal Printers as their print & stationery partner (offset +
 * digital, on demand).
 *
 * Steps:
 *   lead_select_product          → CF AI picks a product angle to lead with for this run
 *   lead_tavily_find_companies   → Tavily finds real companies in the location
 *   lead_cf_extract_company      → CF AI extracts structured company data
 *   lead_check_duplicate         → skip if already in DB
 *   lead_tavily_scrape_website   → Tavily /extract fetches real site pages, regex-pulls emails
 *   lead_cf_extract_email        → picks best on-site email, or falls back to info@domain
 *   lead_save                    → save to Supabase
 *   lead_gen_draft_email         → CF AI drafts product-specific outreach
 *   lead_gen_approval_gate       → email notification + dashboard approval
 *   lead_gen_send_email          → send approved email via Resend (info@snehalprinters.in)
 *
 * Required secrets: SUPABASE_URL, SUPABASE_SERVICE_KEY,
 *   TAVILY_API_KEY,
 *   RESEND_API_KEY,
 *   SENDER_EMAIL (e.g. info@snehalprinters.in), REVIEWER_EMAIL, API_BASE_URL
 * (AI inference uses CF Workers AI binding — no external LLM keys needed)
 */

import { cfAiExtractJson, cfAiExtractJsonStrict } from '../lib/cf-ai.js'
import { getClient }                              from '../lib/supabase.js'
import { nowIso }                                 from '../lib/utils.js'
import { nextJob }                                from '../job-runner.js'

async function resolveSecret(val) {
  if (!val) return undefined
  if (typeof val === 'object' && typeof val.get === 'function') return await val.get()
  return String(val)
}

function parseEmailList(str) {
  if (!str) return []
  return str.split(',').map(s => s.trim()).filter(Boolean)
}

const TAVILY_BASE = 'https://api.tavily.com'

// ── Snehal Printers product catalogue ─────────────────────────────────────

const COMPANY_NAME    = 'Snehal Printers'
const COMPANY_WEBSITE = 'https://snehalprinters.in'
const COMPANY_LOCATION = 'Bhosari, Pune, Maharashtra'

// Default target area — Pune / Bhosari / Pune MIDC belt (rotated per run
// for spread when no location is supplied by the user).
const DEFAULT_LOCATIONS = [
  'Bhosari, Pune',
  'Bhosari MIDC, Pune',
  'Pimpri-Chinchwad, Pune',
  'Pune MIDC',
  'Chakan MIDC, Pune',
  'Hadapsar, Pune',
]

// Products, grouped, with a short pitch each. Rotated per run so different
// outreach emails lead with a different angle instead of listing everything.
const SNEHAL_PRODUCTS = {
  'Corporate Stationery': {
    items: ['Letter Head', 'Envelopes', 'Business Cards', 'Business Form', 'Bill Books', 'Registers', 'Office Files'],
    pitch: 'Letterheads, envelopes, business cards, bill books, registers and office files — offset or digital, printed to your exact branding.',
  },
  'Reports & Marketing Collateral': {
    items: ['Annual Reports', 'Sales Brochures', 'Newsletters & Periodicals', 'Flyers & Leaflets'],
    pitch: 'Annual reports, brochures, newsletters and flyers — high-quality offset printing for material that represents your brand.',
  },
  'Warehouse & Operations Documentation': {
    items: ['Challan', 'Delivery Challan', 'Gate Pass', 'Vouchers & Tags'],
    pitch: 'Challans, delivery challans, gate passes and vouchers — printed in bulk, numbered/customised as needed for daily operations.',
  },
  'Labels, Stickers & Notepads': {
    items: ['Labels & Stickers', 'Parking Stickers', 'Notepads & Deskpads'],
    pitch: 'Labels, stickers (including parking stickers) and branded notepads/deskpads for offices, warehouses, and facilities.',
  },
}

const SKIP_DOMAINS = new Set([
  'linkedin.com','indeed.com','glassdoor.com','naukri.com','justdial.com',
  'wikipedia.org','facebook.com','twitter.com','instagram.com','youtube.com',
  'indiamart.com','tradeindia.com','exportersindia.com','alibaba.com',
  'amazon.in','flipkart.com','google.com','bing.com','yahoo.com',
])


// ── Tavily helpers ────────────────────────────────────────────────────────

async function tavilySearch(env, query, depth = 'basic', maxResults = 7) {
  const apiKey = await resolveSecret(env.TAVILY_API_KEY)
  if (!apiKey) throw new Error('Missing secret: TAVILY_API_KEY')

  const res = await fetch(`${TAVILY_BASE}/search`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ api_key: apiKey, query, search_depth: depth, max_results: maxResults }),
  })
  if (!res.ok) throw new Error(`Tavily ${res.status}: ${await res.text()}`)
  return res.json()
}

async function tavilyExtract(env, urls) {
  const apiKey = await resolveSecret(env.TAVILY_API_KEY)
  if (!apiKey) throw new Error('Missing secret: TAVILY_API_KEY')

  const res = await fetch(`${TAVILY_BASE}/extract`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ api_key: apiKey, urls }),
  })
  if (!res.ok) throw new Error(`Tavily extract ${res.status}: ${await res.text()}`)
  return res.json()
}

function cleanDomain(url) {
  try { return new URL(url).hostname.replace(/^www\./, '') }
  catch { return '' }
}

function extractEmails(text = '') {
  const matches = text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) || []
  // Drop obvious junk (image filenames, tracking pixels, etc.)
  return [...new Set(matches)].filter(e => !/\.(png|jpg|jpeg|gif|svg|webp)$/i.test(e))
}


// ═══════════════════════════════════════════════════════════════════════════
// Step 1: Select Product Angle for This Run
// No industry filtering — every company is a plausible print buyer. This
// step only picks which product group to lead the outreach with, and
// resolves the target location (defaulting to the Pune/Bhosari/MIDC belt).
// ═══════════════════════════════════════════════════════════════════════════

export async function leadSelectProduct(ctx) {
  const { payload, env } = ctx

  const runId = ctx.workflow_run_id || crypto.randomUUID()
  const seed  = parseInt(runId.replace(/-/g, '').slice(0, 8), 16) || 0

  const location = (payload.location || '').trim()
    || DEFAULT_LOCATIONS[seed % DEFAULT_LOCATIONS.length]

  const productKeys     = Object.keys(SNEHAL_PRODUCTS)
  const selectedProduct = productKeys[seed % productKeys.length]
  const productData     = SNEHAL_PRODUCTS[selectedProduct]

  console.log(`[lead_select_product] location=${location} product=${selectedProduct}`)

  await nextJob(ctx, 'lead_tavily_find_companies', {
    location,
    selected_product: selectedProduct,
    product_items:    productData.items,
    product_pitch:    productData.pitch,
  })
}


// ═══════════════════════════════════════════════════════════════════════════
// Step 2: Tavily — Find Real Companies in the Location
// No buyer-type filtering — just active, real companies with a website
// based in/near the target location.
// ═══════════════════════════════════════════════════════════════════════════

export async function leadTavilyFindCompanies(ctx) {
  const { payload, env } = ctx
  const location = payload.location        || 'Bhosari, Pune'
  const product  = payload.selected_product || 'Corporate Stationery'

  const queries = [
    `companies in ${location} official website contact`,
    `manufacturing OR IT OR trading company ${location} Maharashtra office`,
  ]

  const allResults = []
  for (const query of queries) {
    try {
      const result = await tavilySearch(env, query, 'basic', 7)
      allResults.push(...(result.results || []))
    } catch (e) {
      console.warn(`[lead_tavily_find_companies] query failed: ${e.message}`)
    }
  }

  const seen      = new Set()
  const companies = []

  for (const r of allResults) {
    const domain = cleanDomain(r.url)
    if (!domain || seen.has(domain)) continue
    if ([...SKIP_DOMAINS].some(skip => domain.includes(skip))) continue
    seen.add(domain)
    companies.push({
      company_name: (r.title || domain)
        .replace(/ [-|·–—].*$/, '')
        .replace(/\s+(India|Pvt|Ltd|Private|Limited|Inc|Corp|LLP).*$/i, '')
        .trim()
        .slice(0, 80),
      website:     `https://${domain}`,
      description: (r.content || '').slice(0, 400),
      domain,
    })
    if (companies.length >= 3) break
  }

  if (!companies.length) {
    throw new Error(`No companies found in ${location}`)
  }

  const pickPrompt = `${COMPANY_NAME} is a printing press in ${COMPANY_LOCATION} that prints ${product} (${payload.product_pitch}) for ANY business — every company needs some form of print/stationery.

Here are companies found in ${location}:
${companies.map((c, i) => `${i+1}. ${c.company_name} (${c.domain})\n   ${c.description.slice(0, 200)}`).join('\n\n')}

Pick the company that looks like a REAL, currently operating business (not a directory, marketplace, or dead site). Prefer companies with a proper corporate website.

Return JSON:
{
  "selected_index": 0,
  "confidence":     "high | medium | low",
  "reason":         "one sentence why this looks like a real, active company"
}`

  let selectedIdx = 0
  try {
    const pick = await cfAiExtractJson(env, pickPrompt, 'Pick the best real-company lead. Return JSON only.', 200)
    selectedIdx = Math.min(parseInt(pick.selected_index) || 0, companies.length - 1)
    console.log(`[lead_tavily_find_companies] picked idx=${selectedIdx} confidence=${pick.confidence} reason=${pick.reason}`)
  } catch (e) {
    console.warn(`[lead_tavily_find_companies] company selection failed, using first result: ${e.message}`)
  }

  const company = companies[selectedIdx]
  console.log(`[lead_tavily_find_companies] selected=${company.company_name} domain=${company.domain}`)

  await nextJob(ctx, 'lead_cf_extract_company', {
    ...payload,
    company,
    companies,
  })
}


// ═══════════════════════════════════════════════════════════════════════════
// Step 3: CF AI — Extract Structured Company Data
// ═══════════════════════════════════════════════════════════════════════════

export async function leadCfExtractCompany(ctx) {
  const { payload, env } = ctx
  const company  = payload.company || payload.companies?.[0] || {}
  const location = payload.location || ''
  const product  = payload.selected_product || ''

  if (!company.company_name) throw new Error('No company data to extract')

  const prompt = `Extract structured B2B lead data for ${COMPANY_NAME} (a printing press in ${COMPANY_LOCATION} offering offset & digital printing of ${product}).

Raw company info found via web search:
Name: ${company.company_name}
Website: ${company.website}
Description: ${company.description}
Target location: ${location}

Return JSON:
{
  "company_name": "cleaned company name",
  "industry":      "best guess at what this company does, in a few words",
  "website":       "${company.website}",
  "address":       "location/city if inferable, else '${location}'",
  "why_prospect":  "one sentence on why this company likely needs print/stationery supplies"
}`

  const extracted = await cfAiExtractJson(env, prompt,
    'Extract clean structured B2B lead data. Return JSON only.', 400)

  console.log(`[lead_cf_extract_company] extracted=${extracted.company_name}`)

  await nextJob(ctx, 'lead_check_duplicate', {
    ...payload,
    company: {
      ...company,
      company_name: extracted.company_name || company.company_name,
      industry:     extracted.industry     || '',
      address:      extracted.address      || location,
      why_prospect: extracted.why_prospect || '',
    },
  })
}


// ═══════════════════════════════════════════════════════════════════════════
// Step 4: Check Duplicate — skip if already in Supabase (by domain/name)
// ═══════════════════════════════════════════════════════════════════════════

export async function leadCheckDuplicate(ctx) {
  const { payload, env } = ctx
  const company = payload.company || {}
  const sb = getClient(env)

  const domain = cleanDomain(company.website || '')
  let existing = []
  try {
    if (domain) existing = await sb.select('leads', `website=ilike.*${domain}*&limit=1`)
  } catch (e) {
    console.warn(`[lead_check_duplicate] duplicate check failed (non-fatal): ${e.message}`)
  }

  if (existing.length) {
    throw new Error(`Duplicate lead — ${company.company_name} (${domain}) already exists`)
  }

  await nextJob(ctx, 'lead_tavily_scrape_website', { ...payload })
}


// ═══════════════════════════════════════════════════════════════════════════
// Step 5: Tavily Extract — Scrape Website Pages for Contact Email
// ═══════════════════════════════════════════════════════════════════════════

export async function leadTavilyScrapeWebsite(ctx) {
  const { payload, env } = ctx
  const company = payload.company || {}
  const domain  = cleanDomain(company.website || '')

  let foundEmails = []
  let scrapedText = ''

  if (domain) {
    const candidateUrls = [
      `https://${domain}`,
      `https://${domain}/contact`,
      `https://${domain}/contact-us`,
      `https://${domain}/about`,
    ]
    try {
      const result = await tavilyExtract(env, candidateUrls)
      for (const r of (result.results || [])) {
        scrapedText += ' ' + (r.raw_content || '')
      }
      foundEmails = extractEmails(scrapedText)
    } catch (e) {
      console.warn(`[lead_tavily_scrape_website] scrape failed: ${e.message}`)
    }
  }

  console.log(`[lead_tavily_scrape_website] domain=${domain} emails_found=${foundEmails.length}`)

  await nextJob(ctx, 'lead_cf_extract_email', {
    ...payload,
    scraped_emails: foundEmails,
    scraped_text_snippet: scrapedText.slice(0, 1500),
  })
}


// ═══════════════════════════════════════════════════════════════════════════
// Step 6: CF AI — Pick Best Email (fallback to info@domain)
// ═══════════════════════════════════════════════════════════════════════════

export async function leadCfExtractEmail(ctx) {
  const { payload, env } = ctx
  const company = payload.company || {}
  const domain  = cleanDomain(company.website || '')
  const emails  = payload.scraped_emails || []

  let bestEmail = ''

  if (emails.length === 1) {
    bestEmail = emails[0]
  } else if (emails.length > 1) {
    try {
      const prompt = `Pick the single best general/sales contact email for this company from the list below (prefer info@, sales@, contact@, admin@ over personal-looking addresses):
${emails.join('\n')}

Return JSON: { "best_email": "the chosen email" }`
      const pick = await cfAiExtractJson(env, prompt, 'Pick the best contact email. Return JSON only.', 150)
      bestEmail = pick.best_email || emails[0]
    } catch (e) {
      console.warn(`[lead_cf_extract_email] AI pick failed, using first found: ${e.message}`)
      bestEmail = emails[0]
    }
  }

  if (!bestEmail && domain) {
    bestEmail = `info@${domain}`
    console.log(`[lead_cf_extract_email] no on-site email found, falling back to ${bestEmail}`)
  }

  await nextJob(ctx, 'lead_save', {
    ...payload,
    company: { ...company, email: bestEmail },
  })
}


// ═══════════════════════════════════════════════════════════════════════════
// Step 7: Save Lead to Supabase
// ═══════════════════════════════════════════════════════════════════════════

export async function leadSave(ctx) {
  const { payload, env } = ctx
  const company = payload.company || {}
  const sb = getClient(env)

  const row = await sb.insert('leads', {
    id:            crypto.randomUUID(),
    company_name:  company.company_name || 'Unknown',
    industry:      company.industry     || '',
    website:       company.website      || '',
    email:         company.email        || '',
    address:       company.address      || payload.location || '',
    description:   company.why_prospect || '',
    product_focus: payload.selected_product || '',
    status:        'new',
    source:        'lead-generation',
    created_at:    nowIso(),
    updated_at:    nowIso(),
  })

  console.log(`[lead_save] saved lead id=${row?.id} company=${row?.company_name}`)

  await nextJob(ctx, 'lead_gen_draft_email', {
    ...payload,
    lead: row,
  })
}


// ═══════════════════════════════════════════════════════════════════════════
// Step 8: CF AI — Draft Outreach Email
// ═══════════════════════════════════════════════════════════════════════════

export async function leadGenCfDraftEmail(ctx) {
  const { payload, env } = ctx
  const lead    = payload.lead || {}
  const product = payload.selected_product || ''
  const pitch   = payload.product_pitch    || ''

  if (!lead.id || !lead.company_name) throw new Error('Missing lead data in payload')

  const prompt = `Draft a short, warm, professional B2B outreach email from ${COMPANY_NAME} (a printing press based in ${COMPANY_LOCATION}, website ${COMPANY_WEBSITE}) to ${lead.company_name}.

Lead details:
- Company: ${lead.company_name}
- Industry: ${lead.industry || 'unknown'}
- Website: ${lead.website || 'N/A'}
- Why we think they're a fit: ${lead.description || ''}

${COMPANY_NAME} prints, on demand: Offset Printing, Digital Printing, Letter Heads, Business Cards, Bill Books, Registers, Envelopes, Annual Reports, Business Forms, Challans, Gate Passes, Delivery Challans, Newsletters, Flyers & Leaflets, Office Files, Sales Brochures, Vouchers & Tags, Labels & Stickers, Parking Stickers, and Notepads/Deskpads.

Lead with this angle for this email: ${product} — ${pitch}
But mention briefly that we handle all print & stationery needs on demand, not just this category.

Return JSON with exactly these fields:
{
  "subject": "email subject line",
  "body": "full email body with greeting, brief value proposition, CTA to reply or call, and signature from the Snehal Printers Team"
}`

  const draft = await cfAiExtractJsonStrict(env, prompt,
    'You are a friendly, professional B2B copywriter for a printing press. Return valid JSON only.',
    { type: 'object', properties: { subject: { type: 'string' }, body: { type: 'string' } }, required: ['subject', 'body'] },
    1500)

  console.log(`[lead_gen_draft_email] drafted for lead=${lead.id} company=${lead.company_name}`)

  await nextJob(ctx, 'lead_gen_approval_gate', {
    ...payload,
    emailDraft: draft,
  })
}


// ═══════════════════════════════════════════════════════════════════════════
// Step 9: Approval Gate — notify reviewer, pause workflow
// ═══════════════════════════════════════════════════════════════════════════

export async function leadGenApprovalGate(ctx) {
  const { payload, env, d1, workflow_run_id, job } = ctx
  const lead       = payload.lead       || {}
  const emailDraft = payload.emailDraft || {}
  const product    = payload.selected_product || ''

  if (!emailDraft.subject) throw new Error('Missing emailDraft in payload')

  const apiBase   = await resolveSecret(env.API_BASE_URL) || ''
  const dashUrl   = apiBase ? apiBase.replace(/\/api$/, '') + '/approvals' : ''
  const approvalId = crypto.randomUUID()
  const emailToken = crypto.randomUUID().replace(/-/g, '')
  const now        = nowIso()

  const previewHtml = `
    <div style="font-family:Arial,sans-serif;max-width:600px">
      <h2 style="color:#7C2D12">New Lead — ${lead.company_name || ''}</h2>
      <div style="background:#FFF7ED;border:1px solid #FED7AA;border-radius:8px;padding:20px">
        <p><strong>To:</strong> ${lead.email || ''}</p>
        <p><strong>Subject:</strong> ${emailDraft.subject || ''}</p>
        <hr style="border:none;border-top:1px solid #FED7AA"/>
        <div style="white-space:pre-wrap;font-size:13px">${emailDraft.body || ''}</div>
      </div>
    </div>`

  await d1.insert('approval_queue', {
    id:              approvalId,
    workflow_type:   'lead_generation',
    workflow_run_id,
    reference_id:    lead.id || null,
    task_token:      `lead-gen-${workflow_run_id}-${job.id}`,
    payload:         { ...payload, approvalGate: 'save', _nextStep: 'lead_gen_send_email' },
    preview_html:    previewHtml,
    status:          'pending',
    email_token:     emailToken,
    token_expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    created_at:      now,
  })

  await d1.update('job_queue', { status: 'waiting_for_approval' }, { id: job.id })
  if (workflow_run_id) {
    await d1.update('workflow_runs', { status: 'awaiting_approval' }, { id: workflow_run_id })
  }

  console.log(`[lead_gen_approval_gate] approval_id=${approvalId} lead=${lead.id} company=${lead.company_name}`)

  try {
    const reviewerEmails = parseEmailList(await resolveSecret(env.REVIEWER_EMAIL))
    const senderEmail    = await resolveSecret(env.SENDER_EMAIL) || 'info@snehalprinters.in'
    if (reviewerEmails.length && apiBase) {
      await sendLeadApprovalEmail(env, {
        to: reviewerEmails,
        senderEmail,
        approveUrl: `${apiBase}/approvals/${approvalId}/email-action?token=${emailToken}&action=approve`,
        rejectUrl:  `${apiBase}/approvals/${approvalId}/email-action?token=${emailToken}&action=reject`,
        dashUrl,
        lead,
        emailDraft,
        product,
      })
    } else if (reviewerEmails.length) {
      // No API_BASE_URL configured — still notify, but only link to the dashboard.
      await sendLeadApprovalEmail(env, { to: reviewerEmails, senderEmail, dashUrl, lead, emailDraft, product })
    }
  } catch (e) {
    console.warn(`[lead_gen_approval_gate] notification email failed (non-fatal): ${e.message}`)
  }
}


// ═══════════════════════════════════════════════════════════════════════════
// Step 10: Send Approved Email via Resend
// ═══════════════════════════════════════════════════════════════════════════

export async function leadGenSendEmail(ctx) {
  const { payload, env } = ctx
  const lead       = payload.lead       || {}
  const emailDraft = payload.emailDraft || {}
  const senderEmail = await resolveSecret(env.SENDER_EMAIL) || 'info@snehalprinters.in'

  const to      = lead.email || ''
  const subject = emailDraft.subject || 'Print & Stationery Partner — Snehal Printers'
  const body    = emailDraft.body    || ''

  if (!to) throw new Error('No recipient email address for lead')

  const html   = buildEmailHtml(subject, body, senderEmail)
  const result = await sendViaResend(env, { to, from: senderEmail, subject, html })
  console.log(`[lead_gen_send_email] sent to=${to} leadId=${lead.id} resendId=${result.id}`)

  const sb = getClient(env)
  try {
    await sb.update('leads', {
      status:     'emailed',
      updated_at: nowIso(),
    }, `id=eq.${lead.id}`)
  } catch (e) {
    console.warn(`[lead_gen_send_email] status update failed (non-fatal): ${e.message}`)
  }
}


// ═══════════════════════════════════════════════════════════════════════════
// Resend helper — sends from a verified custom domain (info@snehalprinters.in)
// ═══════════════════════════════════════════════════════════════════════════

async function sendViaResend(env, { to, from, subject, html, replyTo }) {
  const apiKey = await resolveSecret(env.RESEND_API_KEY)
  if (!apiKey) throw new Error('Missing secret: RESEND_API_KEY')

  const res = await fetch('https://api.resend.com/emails', {
    method:  'POST',
    headers: {
      Authorization:  `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from:     `Snehal Printers <${from}>`,
      to:       Array.isArray(to) ? to : [to],
      subject,
      html,
      reply_to: replyTo || from,
    }),
  })
  if (!res.ok) {
    const t = await res.text()
    throw new Error(`Resend send failed ${res.status}: ${t}`)
  }
  return res.json()
}

function buildEmailHtml(subject, body, sender) {
  const bodyHtml = body
    .replace(/\n\n/g, '</p><p style="margin:14px 0;color:#292524;line-height:1.7">')
    .replace(/\n/g, '<br>')
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#FFFBF5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
<div style="max-width:580px;margin:32px auto;background:#fff;border-radius:16px;border:1px solid #FDE4C8;overflow:hidden">
  <div style="background:#7C2D12;padding:20px 28px;display:flex;align-items:center;gap:12px">
    <div style="width:36px;height:36px;background:#F97316;border-radius:8px;display:flex;align-items:center;justify-content:center;font-weight:700;color:#fff;font-size:16px">S</div>
    <div>
      <div style="color:#fff;font-weight:700;font-size:15px">Snehal Printers</div>
      <div style="color:#FDBA74;font-size:11px">Offset & Digital Printing · Bhosari, Pune</div>
    </div>
  </div>
  <div style="padding:28px">
    <p style="margin:14px 0;color:#292524;line-height:1.7">${bodyHtml}</p>
  </div>
  <div style="background:#FFFBF5;border-top:1px solid #FDE4C8;padding:16px 28px;text-align:center">
    <p style="margin:0;font-size:11px;color:#A8A29E">
      Snehal Printers · Bhosari, Pune, Maharashtra · snehalprinters.in
    </p>
  </div>
</div>
</body></html>`
}

async function sendLeadApprovalEmail(env, { to, senderEmail, approveUrl, rejectUrl, dashUrl, lead, emailDraft, product }) {
  const bodyPreview = emailDraft.body || ''
  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:Arial,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="padding:28px 16px">
<tr><td align="center">
<table width="580" cellpadding="0" cellspacing="0"
  style="background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08)">
  <tr>
    <td style="background:#7C2D12;padding:20px 28px">
      <div style="color:#FDBA74;font-size:18px;font-weight:bold">Snehal Printers</div>
      <div style="color:#FED7AA;font-size:12px;margin-top:3px">New Lead — Approval Required</div>
    </td>
  </tr>
  <tr>
    <td style="padding:20px 28px 12px">
      <div style="font-size:17px;font-weight:bold;color:#7C2D12">${lead.company_name || 'New Lead'}</div>
      <div style="color:#64748B;font-size:12px;margin-top:4px">
        Product angle: <strong>${product}</strong>
      </div>
    </td>
  </tr>
  <tr>
    <td style="padding:0 28px 16px">
      <table width="100%" style="background:#FFF7ED;border:1px solid #FED7AA;border-radius:8px;padding:0" cellpadding="12" cellspacing="0">
        <tr><td>
          <table width="100%" cellpadding="0" cellspacing="0">
            ${[['Industry', lead.industry],['Website', lead.website],
               ['Email', lead.email],['Location', lead.address]
              ].filter(([,v]) => v).map(([k,v]) => `
              <tr>
                <td style="font-size:12px;color:#64748b;padding:3px 8px 3px 0;width:80px">${k}</td>
                <td style="font-size:13px;color:#292524;font-weight:500;padding:3px 0">${v}</td>
              </tr>`).join('')}
          </table>
        </td></tr>
      </table>
    </td>
  </tr>
  <tr>
    <td style="padding:0 28px 20px">
      <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:16px">
        <p style="margin:0 0 8px;font-size:12px;font-weight:600;color:#64748b">OUTREACH EMAIL DRAFT</p>
        <p style="margin:0 0 6px;font-size:13px"><strong>Subject:</strong> ${emailDraft.subject || ''}</p>
        <div style="white-space:pre-wrap;font-size:13px;color:#334155;line-height:1.6;margin-top:8px">
          ${bodyPreview}
        </div>
      </div>
    </td>
  </tr>
  <tr>
    <td style="padding:0 28px 28px">
      ${approveUrl && rejectUrl ? `
      <table width="100%"><tr>
        <td width="48%" align="center">
          <a href="${approveUrl}"
             style="display:block;background:#16A34A;color:#fff;text-decoration:none;
                    font-size:14px;font-weight:bold;padding:12px 16px;border-radius:8px;text-align:center">
            ✓ &nbsp; Approve & Send Email
          </a>
        </td>
        <td width="4%"></td>
        <td width="48%" align="center">
          <a href="${rejectUrl}"
             style="display:block;background:#DC2626;color:#fff;text-decoration:none;
                    font-size:14px;font-weight:bold;padding:12px 16px;border-radius:8px;text-align:center">
            ✕ &nbsp; Reject Lead
          </a>
        </td>
      </tr></table>` : ''}
      <div style="text-align:center;margin-top:14px;color:#94A3B8;font-size:11px">
        Links expire in 1 hour ·
        ${dashUrl ? `<a href="${dashUrl}" style="color:#C2410C">View in dashboard</a>` : ''}
      </div>
    </td>
  </tr>
  <tr>
    <td style="background:#f8fafc;border-top:1px solid #e2e8f0;padding:12px 28px;text-align:center">
      <div style="color:#94A3B8;font-size:11px">Snehal Printers · Bhosari, Pune · snehalprinters.in</div>
    </td>
  </tr>
</table>
</td></tr>
</table>
</body></html>`

  await sendViaResend(env, {
    to,
    from:    senderEmail,
    subject: `[Lead Approval] ${lead.company_name || 'New Lead'} — ${product}`,
    html,
  })
}
