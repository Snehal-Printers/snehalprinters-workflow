// ─── queries.js — 5 queries per run, max yield per Tavily call ───────────────
//
// CONSTRAINT: Tavily free plan = 1500 searches/month.
// TARGET:     5 searches per run → 300 runs/month.
//
// STRATEGY — each of the 5 queries serves a different purpose:
//
//  Q1: IndiaMART site: query for the specific MIDC hub
//      → Returns listings WITH seller email/phone in the snippet. Best yield.
//      → maxResults=15 to get the most leads from one call.
//
//  Q2: JustDial site: query for the specific MIDC hub
//      → Phone numbers are always in JustDial snippets. Great for phone-only leads.
//
//  Q3: Industry-specific corporate website query
//      → Finds real company websites (not directories). Hub + dominant industry.
//
//  Q4: TradeIndia / ExportersIndia for the product
//      → Structured B2B listings. Good for specialty products.
//
//  Q5: Generic Pune MIDC "Pvt Ltd" company sweep
//      → Catches whatever Q1-Q4 missed. Broad but effective.
//
// Each run rotates the MIDC hub using a daily seed, so across 8 runs we cover
// all 8 hubs without repeating.
// ─────────────────────────────────────────────────────────────────────────────

export const MIDC_HUB_INDUSTRIES = {
  'Bhosari MIDC':          ['pharmaceutical manufacturer', 'auto parts manufacturer', 'engineering company'],
  'Chakan MIDC':           ['automobile manufacturer', 'auto ancillary company', 'logistics company'],
  'Talawade MIDC':         ['IT company', 'electronics manufacturer', 'defence equipment manufacturer'],
  'Pimpri Chinchwad MIDC': ['forging company', 'casting company', 'heavy machinery manufacturer'],
  'Hinjewadi':             ['IT company', 'software company', 'BPO company'],
  'Ranjangaon MIDC':       ['FMCG manufacturer', 'food processing company', 'packaging company'],
  'Chinchwad':             ['auto parts manufacturer', 'machine tool company', 'rubber products manufacturer'],
  'Hadapsar':              ['IT park company', 'export company', 'manufacturing company'],
};

export const PUNE_MIDC_AREAS = Object.keys(MIDC_HUB_INDUSTRIES);

const GENERIC_PRODUCT_KEYWORDS = [
  'letterhead', 'letter head', 'business card', 'visiting card',
  'bill book', 'invoice book', 'voucher', 'tag', 'register',
  'office file', 'stationery', 'notepad', 'deskpad', 'desk pad',
  'envelope', 'gate pass', 'challan', 'delivery challan',
  'label', 'sticker', 'flyer', 'leaflet', 'brochure', 'pamphlet',
  'calendar', 'diary', 'folder', 'id card', 'certificate',
];

export function isGenericProduct(product) {
  const text = `${product.name || ''} ${product.keywords || ''}`.toLowerCase();
  return GENERIC_PRODUCT_KEYWORDS.some((k) => text.includes(k));
}

/**
 * Returns exactly 5 Tavily queries for a product + area.
 *
 * @param {{name:string, keywords?:string}} product
 * @param {string} area  — specific hub (e.g. "Bhosari MIDC") or "Pune MIDC" (auto-rotated)
 * @param {number} runSeed — used to rotate hub when area="Pune MIDC"
 */
export function buildQueries(product, area = 'Pune MIDC', runSeed = 0) {
  const productName = product.name || '';
  const isGeneric   = isGenericProduct(product);

  // Rotate hub per run when "Pune MIDC" is passed (covers all 8 hubs over time)
  const hub = (area === 'Pune MIDC')
    ? PUNE_MIDC_AREAS[runSeed % PUNE_MIDC_AREAS.length]
    : area;

  const industry = (MIDC_HUB_INDUSTRIES[hub] || ['manufacturing company'])[0];

  const queries = [
    // Q1 — IndiaMART listings for this hub (snippet has email+phone — highest yield)
    `site:indiamart.com "${hub}" Pune`,

    // Q2 — JustDial for this hub (phone always in snippet)
    `site:justdial.com "${hub.replace(' MIDC', '')}" Pune companies`,

    // Q3 — Industry corporate website (real company site, not directory)
    isGeneric
      ? `${industry} "${hub}" Pune official website contact email`
      : `${industry} "${hub}" Pune "${productName}" contact email`,

    // Q4 — TradeIndia structured B2B listings
    isGeneric
      ? `site:tradeindia.com Pune MIDC manufacturer`
      : `site:tradeindia.com "${productName}" Pune`,

    // Q5 — Broad Pune MIDC Pvt Ltd sweep (catches whatever Q1-Q4 missed)
    `"Pvt Ltd" OR "Industries" OR "Enterprises" "${hub}" Pune contact`,
  ];

  return queries; // exactly 5
}