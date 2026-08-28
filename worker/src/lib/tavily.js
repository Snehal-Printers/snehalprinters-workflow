// File extensions / patterns that are never a company's own marketing site — PDFs,
// office docs, spreadsheets, government/association member-list downloads, image
// files picked up as "results", etc. These get discarded before they ever reach
// the AI qualification step, so they can never become a "lead".
const NON_COMPANY_URL_RE = /\.(pdf|docx?|xlsx?|pptx?|csv|zip|rar)(\?|#|$)/i;

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

  // Hard filter: drop anything that is a document file, not a webpage.
  return results.filter((r) => r.url && !NON_COMPANY_URL_RE.test(r.url));
}
