// ─── queries.js — Rewritten for maximum lead yield ───────────────────────────
//
// ROOT CAUSE OF 0 LEADS (original):
//   Queries like "companies in Bhosari MIDC Pune contact email phone number"
//   return news articles, association pages, and directories — NOT individual
//   company websites. Tavily is a web-search engine, not a directory.
//
// FIX:
//   1. Target SPECIFIC INDUSTRIES that are dense in each MIDC hub.
//   2. Use IndiaMART / JustDial / TradeIndia via site: queries — these return
//      structured listings WITH company name, phone, email in the snippet.
//   3. Mix "official website" queries (find corporate site) with directory
//      queries (get contact data from snippet directly).
//   4. Add Tavily Extract as a fallback to pull emails from scraped pages.
// ─────────────────────────────────────────────────────────────────────────────

// Each MIDC hub mapped to the dominant industries there.
// More specific = higher quality Tavily results.
export const MIDC_HUB_INDUSTRIES = {
  'Bhosari MIDC':          ['pharmaceutical manufacturer', 'auto parts manufacturer', 'engineering company', 'chemical manufacturer'],
  'Chakan MIDC':           ['automobile manufacturer', 'auto ancillary company', 'logistics company', 'tyre manufacturer'],
  'Talawade MIDC':         ['IT company', 'electronics manufacturer', 'defence equipment manufacturer'],
  'Pimpri Chinchwad MIDC': ['forging company', 'casting company', 'heavy machinery manufacturer', 'pump manufacturer'],
  'Hinjewadi':             ['IT company', 'software company', 'tech startup', 'BPO company'],
  'Ranjangaon MIDC':       ['FMCG manufacturer', 'food processing company', 'packaging company', 'tyre manufacturer'],
  'Chinchwad':             ['auto parts manufacturer', 'machine tool company', 'rubber products manufacturer'],
  'Hadapsar':              ['IT park company', 'export company', 'manufacturing company'],
};

export const PUNE_MIDC_AREAS = Object.keys(MIDC_HUB_INDUSTRIES);

// Directory sites — their search pages return listings WITH email/phone in the
// snippet. We parse the snippet directly, no scraping needed.
const DIRECTORY_SITES = [
  'indiamart.com',
  'justdial.com',
  'tradeindia.com',
  'exportersindia.com',
  'sulekha.com',
];

// Printing products that are needed by almost every business (generic).
// For these, ANY real company in Pune is a valid lead.
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
 * Build Tavily queries for a product + area.
 * Returns an array of query strings, ordered best-first.
 *
 * Strategy:
 *  - Directory site: queries  → get email/phone directly from snippet
 *  - Industry-specific site queries → find real company websites
 *  - JustDial "area" queries → structured local listings
 */
export function buildQueries(product, area = 'Pune MIDC') {
  const productName = product.name || '';
  const keywords    = product.keywords || '';
  const isGeneric   = isGenericProduct(product);

  // Determine which hubs to cover
  const hubs = (area === 'Pune MIDC') ? PUNE_MIDC_AREAS : [area];
  const queries = new Set();

  for (const hub of hubs) {
    const industries = MIDC_HUB_INDUSTRIES[hub] || ['manufacturing company', 'company'];

    // ── Tier 1: Directory site: queries (highest yield — snippet has email+phone) ──
    // IndiaMART listings for this hub
    queries.add(`site:indiamart.com "${hub}" Pune company`);
    queries.add(`site:indiamart.com Pune MIDC manufacturer contact email`);
    // JustDial for local businesses — has phone numbers in snippet
    queries.add(`site:justdial.com ${hub} Pune companies phone`);

    // ── Tier 2: Industry-specific corporate website queries ──
    // Pick top 2 industries for this hub to keep query count sane
    for (const industry of industries.slice(0, 2)) {
      if (isGeneric) {
        // Generic product: just find real companies in this hub
        queries.add(`${industry} ${hub} Pune Maharashtra official website contact`);
        queries.add(`"${hub}" "${industry}" Pune site:in OR site:com`);
      } else {
        // Specialty product: find companies that specifically need it
        queries.add(`${industry} ${hub} Pune "${productName}" requirement contact email`);
        queries.add(`${industry} ${hub} Pune "${productName}" supplier vendor`);
      }
    }

    // ── Tier 3: JustDial area page scrape (real contact data per company) ──
    queries.add(`site:justdial.com ${hub.replace(' MIDC', '')} Pune manufacturers contact`);
  }

  // ── Tier 4: TradeIndia / ExportersIndia product queries (nationwide but filterable) ──
  if (!isGeneric) {
    queries.add(`site:tradeindia.com "${productName}" Pune buyer`);
    queries.add(`site:exportersindia.com "${productName}" Pune Maharashtra`);
  } else {
    queries.add(`site:tradeindia.com Pune MIDC manufacturing companies contact`);
  }

  // ── Tier 5: Direct Google-style company search ──
  // "Pvt Ltd" or "Industries" in Pune MIDC — finds corporate sites directly
  queries.add(`"Pvt Ltd" OR "Industries" OR "Enterprises" Pimpri Pune email contact site:in`);
  queries.add(`manufacturing company Bhosari Pune email contact official website`);
  queries.add(`pharma company Bhosari MIDC Pune contact email phone`);
  queries.add(`IT company Hinjewadi Pune contact email`);

  // ── Tier 6: JustDial broad Pune MIDC search ──
  queries.add(`site:justdial.com MIDC Pune industrial companies phone number`);
  queries.add(`site:indiamart.com Pimpri Chinchwad manufacturer contact`);

  return [...queries].slice(0, 40); // cap at 40 queries to stay within Tavily limits
}
