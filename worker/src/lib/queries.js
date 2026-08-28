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

// Phrases that signal an active or recurring buying need, not just "a factory exists".
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

/**
 * Build a set of Tavily queries for a given product + area.
 * @param {{name:string, keywords?:string}} product
 * @param {string} area  e.g. "Pune MIDC" (whole belt) or a specific pocket
 */
export function buildQueries(product, area = 'Pune MIDC') {
  const kw = [product.name, product.keywords].filter(Boolean).join(' ');
  const areas = area === 'Pune MIDC' ? PUNE_MIDC_AREAS : [area];
  const queries = [];

  for (const a of areas) {
    // 1. Direct "who needs this" query
    queries.push(`companies in ${a} Pune requiring ${kw}`);

    // 2. Directory-scoped queries (best structured data per hit)
    for (const site of DIRECTORY_SITES.slice(0, 2)) {
      queries.push(`site:${site} ${kw} ${a} Pune`);
    }

    // 3. Buyer-intent phrase query (rotate one phrase per area to keep query count sane)
    const phrase = INTENT_PHRASES[areas.indexOf(a) % INTENT_PHRASES.length];
    queries.push(`${phrase} ${kw} companies ${a} Pune Maharashtra`);
  }

  // 4. Category-level manufacturer/industrial-association query (no area repeat, one shot)
  queries.push(`manufacturers association members list ${kw} Pune MIDC industrial area`);

  return [...new Set(queries)];
}
