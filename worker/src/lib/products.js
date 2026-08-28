import { fetchHtml } from './scrape.js';

// Generic product-listing scraper: looks for common e-commerce/catalog patterns
// (product cards, links containing /product/, h2/h3 titles). Tuned to be
// resilient to markup differences rather than tied to one exact template —
// verify results after first run and use the manual "add product" field for
// anything missed.
export async function scrapeProducts(siteUrl) {
  const html = await fetchHtml(siteUrl, 10000);
  if (!html) return [];

  const products = [];
  const seen = new Set();

  // Pattern 1: <a href="...product...">Name</a>
  const linkRe = /<a[^>]+href=["']([^"']*(?:product|shop|item)[^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = linkRe.exec(html)) !== null) {
    const href = m[1];
    const text = stripTags(m[2]).trim();
    if (text.length < 3 || text.length > 100) continue;
    if (/^(home|shop|cart|checkout|account|login|next|prev|view all)$/i.test(text)) continue;
    const url = resolveUrl(href, siteUrl);
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    products.push({ name: text, url });
  }

  // Pattern 2 fallback: product-ish headings if pattern 1 found too few
  if (products.length < 5) {
    const headingRe = /<h[23][^>]*>([\s\S]*?)<\/h[23]>/gi;
    while ((m = headingRe.exec(html)) !== null) {
      const text = stripTags(m[1]).trim();
      if (text.length < 3 || text.length > 100) continue;
      const key = text.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      products.push({ name: text, url: siteUrl });
    }
  }

  return products.slice(0, 25);
}

function stripTags(html) {
  return html.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ');
}

function resolveUrl(href, base) {
  try {
    return new URL(href, base).toString();
  } catch {
    return href;
  }
}
