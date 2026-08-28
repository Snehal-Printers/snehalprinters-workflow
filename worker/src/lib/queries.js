// This is the "perfect prompt" layer: Tavily is a web-search API, not a directory,
// so lead quality depends entirely on how we phrase queries. We fire several
// targeted variants per run and merge results, rather than one generic query.

// Core Pune MIDC / industrial-belt areas — expand this list as you learn which
// pockets convert best.
export const PUNE_MIDC_AREAS = [
  'Bhosari MIDC',
  'Chakan MIDC',
  'Talawade MIDC',
  'Pimpri Chinchwad MIDC',
  'Hinjewadi',
  'Ranjangaon MIDC',
  'Chinchwad industrial area',
  'Pune MIDC',
];

// B2B directory domains where company name + address + phone are usually
// listed on the page itself, so Tavily's snippet gives us structured-ish data.
const DIRECTORY_SITES = ['indiamart.com', 'justdial.com', 'tradeindia.com', 'exportersindia.com'];

// Phrases that signal an active or recurring buying need — kept for SPECIALTY
// products (packaging, labels, etc.) where "does this company even buy this?"
// genuinely narrows things down.
const INTENT_PHRASES = [
  'suppliers near',
  'manufacturers in',
  'looking for supplier',
  'require',
  'requirement for',
  'vendor list',
  'corporate gifting',
  'bulk order',
  'company profile printing',
];

// Generic office/printing consumables that almost EVERY operating company buys
// (letterheads, business cards, bill books, stationery, files, etc.) — no
// "buyer intent" phrase-matching needed here. For these, the fastest path to a
// lead is just: find real, operating companies in the target area that publish
// a contact email/phone. See isGenericProduct() below.
const GENERIC_PRODUCT_KEYWORDS = [
  'letterhead',
  'letter head',
  'business card',
  'visiting card',
  'bill book',
  'invoice book',
  'voucher',
  'tag',
  'register',
  'office file',
  'stationery',
  'notepad',
  'deskpad',
  'desk pad',
  'envelope',
  'gate pass',
  'challan',
  'delivery challan',
  'label',
  'sticker',
  'parking sticker',
  'newsletter',
  'flyer',
  'leaflet',
  'sales brochure',
  'business form',
  'estimation',
  'quotation',
];

export function isGenericProduct(product) {
  const text = `${product.name || ''} ${product.keywords || ''}`.toLowerCase();
  return GENERIC_PRODUCT_KEYWORDS.some((k) => text.includes(k));
}

/**
 * Build a set of Tavily queries for a given product + area.
 * @param {{name:string, keywords?:string}} product
 * @param {string} area  e.g. "Pune MIDC" (whole belt) or a specific pocket
 */
export function buildQueries(product, area = 'Pune MIDC') {
  const kw = [product.name, product.keywords].filter(Boolean).join(' ');
  const generic = isGenericProduct(product);
  const areas = area === 'Pune MIDC' ? PUNE_MIDC_AREAS : [area];
  const queries = [];

  for (const a of areas) {
    if (generic) {
      // Generic office consumable: skip "does this company need X" phrasing
      // entirely — just find real companies in the area that publish a contact
      // email/phone. Almost any hit here is a legitimate prospect.
      queries.push(`companies in ${a} Pune contact email phone number`);
      queries.push(`Pvt Ltd companies list ${a} Pune with email`);
    } else {
      // Specialty product: keep the more targeted "who actually needs this" phrasing.
      queries.push(`companies in ${a} Pune requiring ${kw}`);
    }

    // Directory-scoped queries (best structured data per hit) — useful either way.
    for (const site of DIRECTORY_SITES.slice(0, 2)) {
      queries.push(generic ? `site:${site} manufacturing companies ${a} Pune` : `site:${site} ${kw} ${a} Pune`);
    }

    // Buyer-intent phrase query — only for specialty products (rotate one
    // phrase per area to keep query count sane).
    if (!generic) {
      const phrase = INTENT_PHRASES[areas.indexOf(a) % INTENT_PHRASES.length];
      queries.push(`${phrase} ${kw} companies ${a} Pune Maharashtra`);
    }
  }

  // Category-level manufacturer/industrial-association query (no area repeat, one shot)
  queries.push(
    generic
      ? `manufacturers association members list Pune MIDC industrial area contact details`
      : `manufacturers association members list ${kw} Pune MIDC industrial area`
  );

  return [...new Set(queries)];
}