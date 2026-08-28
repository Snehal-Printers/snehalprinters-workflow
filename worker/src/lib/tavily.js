export async function tavilySearch(apiKey, query, { maxResults = 12, days } = {}) {
  const body = {
    api_key: apiKey,
    query,
    search_depth: 'advanced',
    include_answer: false,
    include_raw_content: false,
    max_results: maxResults,
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
  return data.results || []; // [{title, url, content, score}]
}
