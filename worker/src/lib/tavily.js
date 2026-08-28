// File extensions / patterns that are never a company's own marketing site — PDFs,
// office docs, spreadsheets, government/association member-list downloads, image
// files picked up as "results", etc. These get discarded before they ever reach
// the AI qualification step, so they can never become a "lead".
const NON_COMPANY_URL_RE = /\.(pdf|docx?|xlsx?|pptx?|csv|zip|rar)(\?|#|$)/i;

// URL PATH patterns that signal "this is a page listing many companies", not one
// specific company's own site — yellow-pages-style directories, "/companies.htm",
// "/company-list", "/directory", "/members"/"member-list", search-results pages,
// category/browse pages, etc. Different directory *sites* get new domains added
// over time (see DIRECTORY_DOMAINS in scrape.js) — this is the domain-agnostic
// catch-all so a brand-new directory site we haven't named yet still gets caught
// by its URL shape alone (e.g. puneyellowpagesonline.com/companies.htm).
const LISTING_PAGE_URL_RE = /\/(companies|company-list|companylist|business-list|directory|directories|listing|listings|members?|member-list|category|categories|browse|search|results)(\.\w+)?(\/|\?|#|$)/i;

export async function tavilySearch(apiKey, query, { maxResults = 12, days } = {}) {
  const body = {
    api_key: apiKey,
    query,
    search_depth: 'advanced',
    include_answer: false,
    include_raw_content: false,
    max_results: maxResults,
    // Tavily's own filter — belt-and-braces alongside the regex filter below,
    // since include/exclude answers can differ slightly from what actually
    // comes back in `results`.
    exclude_domains: [],
  };
  if (days) body.days = days;

  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`Tavily error ${res.status}: ${await res.text()}`);
  }
  const data = await res.json();
  const results = data.results || []; // [{title, url, content, score}]

  // Hard filter: drop document files AND multi-company listing/directory pages —
  // neither is ever "one specific company's own site".
  return results.filter((r) => r.url && !NON_COMPANY_URL_RE.test(r.url) && !LISTING_PAGE_URL_RE.test(r.url));
}