// Lightweight HTML fetch + regex-based extraction (no DOM parser dependency, Workers-friendly).

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const PHONE_RE = /(?:\+91[\-\s]?)?[6-9]\d{9}\b/g;
const JUNK_EMAIL_DOMAINS = ['example.com', 'sentry.io', 'wixpress.com', 'godaddy.com', 'schema.org'];

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

export function extractEmails(html) {
  if (!html) return [];
  const found = [...new Set((html.match(EMAIL_RE) || []).map((e) => e.toLowerCase()))];
  return found.filter((e) => !JUNK_EMAIL_DOMAINS.some((d) => e.endsWith(d)) && !e.endsWith('.png') && !e.endsWith('.jpg'));
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
export async function findCompanyEmail(baseUrl) {
  const domain = extractDomain(baseUrl);
  if (!domain) return { email: null, source: null, html: null };

  const candidates = [baseUrl, `https://${domain}/contact`, `https://${domain}/contact-us`, `https://${domain}/about`, `https://${domain}/about-us`];

  for (const url of candidates) {
    const html = await fetchHtml(url, 6000);
    const emails = extractEmails(html);
    if (emails.length) {
      return { email: emails[0], source: 'scraped', html, allEmails: emails, phones: extractPhones(html) };
    }
    if (url === baseUrl && html) {
      // keep homepage html for phones/title even if no email yet
      var homepageHtml = html;
    }
  }

  // Fallback: pattern guess
  const guessed = `info@${domain}`;
  return { email: guessed, source: 'pattern_guess', html: homepageHtml || null, allEmails: [], phones: extractPhones(homepageHtml) };
}
