const MODEL = '@cf/meta/llama-3.1-8b-instruct';

function extractJson(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

/**
 * Given a raw Tavily search hit (title/url/content snippet), decide:
 * - is this actually a Pune MIDC-area company (not a blog/news/irrelevant page)
 * - a clean company name
 * - relevance 0-100 for buying `product.name`
 */
export async function analyzeHit(ai, hit, product, area) {
  const prompt = `You are a B2B lead-qualification assistant for an industrial printing company (Snehal Printers, Pune).
We sell: "${product.name}"${product.keywords ? ` (related: ${product.keywords})` : ''}.
Target buyers are companies physically located in the ${area} industrial belt near Pune, Maharashtra, India.

Given this raw web search hit, decide if it represents a real company (not a news article, blog, job listing, or generic directory homepage) that could plausibly need to BUY "${product.name}" for its business (packaging, labels, signage, stationery, corporate printing, etc. depending on product).

Title: ${hit.title}
URL: ${hit.url}
Snippet: ${hit.content?.slice(0, 500) || ''}

Respond with ONLY minified JSON, no prose, no markdown:
{"is_company": true|false, "company_name": "string or null", "is_pune_midc_area": true|false, "area_evidence": "short quote/phrase from snippet or null", "relevance_score": 0-100, "relevance_reason": "one short sentence"}`;

  const res = await ai.run(MODEL, { messages: [{ role: 'user', content: prompt }], max_tokens: 300 });
  const text = res.response || res.result?.response || '';
  const json = extractJson(text);
  if (!json) {
    return { is_company: false, company_name: null, is_pune_midc_area: false, area_evidence: null, relevance_score: 0, relevance_reason: 'AI parse failed' };
  }
  return json;
}

/**
 * Draft a short, specific outreach email for a qualified lead.
 * Kept human-editable — this goes to the approval queue, never auto-sent.
 */
export async function draftOutreachEmail(ai, { companyName, product, area, relevanceReason }) {
  const prompt = `Write a short, specific, non-generic B2B cold email from Snehal Printers (a printing company based in Pune, snehalprinters.in) to a prospective buyer.

Buyer: ${companyName}, located in the ${area} industrial area near Pune.
Product we're offering: ${product.name}${product.keywords ? ` (${product.keywords})` : ''}.
Why we think they're a fit: ${relevanceReason || 'industrial company in the target area'}.

Rules:
- Subject line under 8 words, no clickbait, no emojis.
- Body: 80-120 words max, plain text, no markdown.
- Reference their location/industry naturally, not generically.
- One clear, low-friction call to action (reply or a short call).
- Sign off as "Team Snehal Printers".
- Do NOT invent specific past clients, prices, or claims we can't back up.

Respond with ONLY minified JSON, no prose:
{"subject": "string", "body": "string"}`;

  const res = await ai.run(MODEL, { messages: [{ role: 'user', content: prompt }], max_tokens: 350 });
  const text = res.response || res.result?.response || '';
  const json = extractJson(text);
  if (!json) {
    return {
      subject: `Printing solutions for ${companyName}`,
      body: `Hi team,\n\nWe work with companies in the ${area} area on ${product.name}. Would you be open to a quick chat about your current printing/packaging needs?\n\nTeam Snehal Printers`,
    };
  }
  return json;
}
