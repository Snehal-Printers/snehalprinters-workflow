// ─── scrape.js — Rewritten for maximum email/phone extraction ────────────────
//
// ROOT CAUSES OF 0 LEADS (original):
//   1. Only accepted scraped/scraped_footer email sources — no fallback.
//      Modern company sites render contact info via JS → scraper got nothing.
//   2. Discarded phone-only leads entirely (phone is valid for sales outreach).
//   3. No snippet-level extraction — IndiaMART/JustDial snippets often contain
//      the real email/phone but were never parsed.
//
// FIX:
//   1. Extract email/phone from Tavily search snippets directly (fastest, free).
//   2. Try Tavily /extract API on the company URL (better than raw fetch for
//      JS-rendered sites — Tavily renders JS before extracting).
//   3. Fall back to raw HTML fetch for static sites.
//   4. Accept phone-only leads — they go into outreach queue for manual follow-up.
//   5. Extract contact info from directory listing pages (IndiaMART, JustDial)
//      — the seller's phone/email is on the listing page itself.
// ─────────────────────────────────────────────────────────────────────────────

const EMAIL_RE   = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
const PHONE_RE   = /(?:\+91[\s\-]?)?[6-9]\d{9}\b/g;
const PHONE_RE2  = /\b0\d{2,4}[\s\-]\d{6,8}\b/g; // landline: 020-12345678

const JUNK_EMAIL_RE = /sentry|example\.|wixpress|godaddy|schema\.org|w3\.org|noreply|no-reply|support@wix|@cloudflare|\.png$|\.jpg$/i;

// Domains that are directory platforms — extract seller contact from their SNIPPET
// rather than scraping the directory domain itself (which would give the directory's
// own system emails, not the seller's).
export const DIRECTORY_DOMAINS = new Set([
  'indiamart.com', 'justdial.com', 'tradeindia.com',
  'exportersindia.com', 'sulekha.com', 'yellowpages.in',
  'dir.indiamart.com',
]);

export function extractDomain(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); }
  catch { return null; }
}

export function isDirectoryDomain(domain) {
  return domain && [...DIRECTORY_DOMAINS].some(d => domain === d || domain.endsWith('.' + d));
}

function cleanEmails(emails) {
  return [...new Set(emails.map(e => e.toLowerCase().trim()))]
    .filter(e => !JUNK_EMAIL_RE.test(e) && e.includes('@') && e.split('@')[1]?.includes('.'));
}

function cleanPhones(phones) {
  return [...new Set(phones.map(p => p.replace(/\s/g, '')))];
}

/** Extract emails from any text/HTML blob */
export function extractEmails(text) {
  if (!text) return [];
  return cleanEmails(text.match(EMAIL_RE) || []);
}

/** Extract Indian mobile + landline numbers from any text/HTML blob */
export function extractPhones(text) {
  if (!text) return [];
  const mobiles   = (text.match(PHONE_RE)  || []);
  const landlines = (text.match(PHONE_RE2) || []);
  return cleanPhones([...mobiles, ...landlines]);
}

/**
 * Extract contact info directly from a Tavily search result snippet.
 * This is the FASTEST path — no HTTP request needed.
 *
 * IndiaMART and JustDial snippets often look like:
 *   "ABC Pharma Pvt Ltd, Bhosari MIDC, Pune. Call: 9876543210. Email: abc@abcpharma.com"
 */
export function extractFromSnippet(snippet, title) {
  if (!snippet) return { emails: [], phones: [], companyName: null };
  const text = `${title || ''} ${snippet}`;
  return {
    emails:      extractEmails(text),
    phones:      extractPhones(text),
    companyName: null, // caller fills this from AI analysis
  };
}

/** Raw HTML fetch — fast, works for static sites */
async function fetchHtml(url, timeoutMs = 8000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal:  controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SnehalLeadBot/1.0; +https://snehalprinters.in)' },
    });
    if (!res.ok) return null;
    return await res.text();
  } catch { return null; }
  finally { clearTimeout(t); }
}

/** Tavily /extract — renders JS, better for modern sites */
async function tavilyExtract(tavilyKey, urls) {
  try {
    const res = await fetch('https://api.tavily.com/extract', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ api_key: tavilyKey, urls }),
    });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.results || []).map(r => r.raw_content || '');
  } catch { return []; }
}

/**
 * Find company email + phone using a layered strategy.
 *
 * Layer 1 (snippet):    Already tried upstream — passed in as snippetContact.
 * Layer 2 (Tavily extract): Renders JS — best for modern sites.
 * Layer 3 (raw fetch):  Static site fallback — /contact, /about, homepage.
 *
 * Returns { email, phone, source } — email and phone can both be null if truly
 * not found (caller decides whether to keep phone-only leads).
 */
export async function findCompanyContact(baseUrl, tavilyKey, { snippetEmails = [], snippetPhones = [] } = {}) {
  const domain = extractDomain(baseUrl);
  if (!domain) return { email: null, phone: null, source: 'none' };

  // If it's a directory domain, we already have what we need from the snippet —
  // don't try to scrape IndiaMART's own pages.
  if (isDirectoryDomain(domain)) {
    return {
      email:  snippetEmails[0]  || null,
      phone:  snippetPhones[0]  || null,
      source: 'directory_snippet',
    };
  }

  // ── Layer 1: Try snippet data first (already extracted, free) ──
  if (snippetEmails.length > 0) {
    return { email: snippetEmails[0], phone: snippetPhones[0] || null, source: 'snippet' };
  }

  // ── Layer 2: Tavily /extract — batched in ONE call (= 1 sub-request total) ──
  if (tavilyKey) {
    const contents = await tavilyExtract(tavilyKey, [baseUrl, `https://${domain}/contact`]);
    for (const content of contents) {
      const emails = extractEmails(content);
      const phones = extractPhones(content);
      if (emails.length > 0) {
        return { email: emails[0], phone: phones[0] || null, source: 'tavily_extract' };
      }
      if (phones.length > 0) snippetPhones = [...snippetPhones, ...phones];
    }
  }

  // ── Layer 3: Raw HTML — homepage only (1 sub-request max per candidate) ──
  const candidateUrls = [baseUrl];

  let foundPhones = [...snippetPhones];

  for (const url of candidateUrls) {
    const html = await fetchHtml(url, 6000);
    if (!html) continue;

    // Footer-first (most reliable email location on most sites)
    const footerMatch = html.match(/<footer[\s\S]*?<\/footer>/i);
    if (footerMatch) {
      const footerEmails = extractEmails(footerMatch[0]);
      if (footerEmails.length) {
        return { email: footerEmails[0], phone: extractPhones(html)[0] || foundPhones[0] || null, source: 'scraped_footer' };
      }
    }

    const emails = extractEmails(html);
    const phones = extractPhones(html);

    if (emails.length) {
      return { email: emails[0], phone: phones[0] || foundPhones[0] || null, source: 'scraped' };
    }
    if (phones.length) foundPhones = [...foundPhones, ...phones];
  }

  // ── Phone-only result ──
  if (foundPhones.length > 0) {
    return { email: null, phone: foundPhones[0], source: 'phone_only' };
  }

  return { email: null, phone: null, source: 'none' };
}