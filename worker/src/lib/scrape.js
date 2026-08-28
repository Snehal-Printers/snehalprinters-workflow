// Lightweight HTML fetch + regex-based extraction (no DOM parser dependency, Workers-friendly).

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const PHONE_RE = /(?:\+91[\-\s]?)?[6-9]\d{9}\b/g;
const JUNK_EMAIL_DOMAINS = ['example.com', 'sentry.io', 'wixpress.com', 'godaddy.com', 'schema.org'];

// B2B directory/aggregator domains (IndiaMART, JustDial, etc.) are NEVER the actual
// company's own domain — a Tavily hit landing on one of these is a *listing page*,
// not the company's website. We must not pattern-guess "info@indiamart.com" style
// emails, and we should also discard any @indiamart.com / @justdial.com style
// addresses picked up from scraping the listing page itself (those are the
// directory's own system emails, not the seller's).
const DIRECTORY_DOMAINS = ['indiamart.com', 'justdial.com', 'tradeindia.com', 'exportersindia.com', 'sulekha.com', 'yellowpages.in'];

function isDirectoryDomain(domain) {
  return DIRECTORY_DOMAINS.some((d) => domain === d || domain.endsWith('.' + d));
}

export async function fetchHtml(url, timeoutMs = 8000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SnehalLeadBot/1.0)' },
    });
    if (!res.ok) return null;
    return await res.text();
  } catch (e) {
    return null;
  } finally {
    clearTimeout(t);
  }
}

export function extractEmails(html, { excludeDomains = [] } = {}) {
  if (!html) return [];
  const found = [...new Set((html.match(EMAIL_RE) || []).map((e) => e.toLowerCase()))];
  const allExcluded = [...JUNK_EMAIL_DOMAINS, ...DIRECTORY_DOMAINS, ...excludeDomains];
  return found.filter((e) => !allExcluded.some((d) => e.endsWith('@' + d) || e.endsWith('.' + d)) && !e.endsWith('.png') && !e.endsWith('.jpg'));
}

export function extractPhones(html) {
  if (!html) return [];
  return [...new Set(html.match(PHONE_RE) || [])];
}

export function extractTitle(html) {
  if (!html) return null;
  const m = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  return m ? m[1].trim() : null;
}

export function extractDomain(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

// Try homepage + common contact-style pages to maximize chance of finding a real email.
// IMPORTANT: if baseUrl is a directory/aggregator listing page (IndiaMART, JustDial, etc.),
// we do NOT treat that aggregator's domain as "the company's website" — we never guess
// an email on it, and we filter out the aggregator's own system emails from any scrape.
export async function findCompanyEmail(baseUrl) {
  const domain = extractDomain(baseUrl);
  if (!domain) return { email: null, source: null, html: null };

  const onDirectory = isDirectoryDomain(domain);
  const candidates = onDirectory
    ? [baseUrl] // just read the listing page itself, don't guess /contact etc. on the aggregator
    : [baseUrl, `https://${domain}/contact`, `https://${domain}/contact-us`, `https://${domain}/about`, `https://${domain}/about-us`];

  let homepageHtml = null;
  for (const url of candidates) {
    const html = await fetchHtml(url, 6000);
    const emails = extractEmails(html);
    if (emails.length) {
      return { email: emails[0], source: 'scraped', html, allEmails: emails, phones: extractPhones(html) };
    }
    if (url === baseUrl && html) {
      homepageHtml = html; // keep homepage/listing html for phones/title even if no email yet
    }
  }

  if (onDirectory) {
    // Never fabricate "info@indiamart.com" / "info@justdial.com" — there's no real
    // email to guess here. Return what we could find (usually just a phone number)
    // and let the caller decide whether a phone-only lead is still useful.
    return { email: null, source: null, html: homepageHtml, allEmails: [], phones: extractPhones(homepageHtml) };
  }

  // Fallback: pattern guess (only ever done on the company's own real domain)
  const guessed = `info@${domain}`;
  return { email: guessed, source: 'pattern_guess', html: homepageHtml, allEmails: [], phones: extractPhones(homepageHtml) };
}