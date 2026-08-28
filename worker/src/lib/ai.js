const MODEL = '@cf/meta/llama-3.1-8b-instruct-fast';
import { isGenericProduct } from './queries.js';

// Workers AI response shape is normally { response: "..." }, but can occasionally
// come back as something else (nested object, array of tool-call-style chunks,
// etc. depending on model/edge case) — never trust it's a plain string.
function extractResponseText(res) {
  let text = res?.response ?? res?.result?.response ?? '';
  if (typeof text !== 'string') {
    try {
      text = JSON.stringify(text);
    } catch {
      text = '';
    }
  }
  return text;
}

function extractJson(text) {
  if (typeof text !== 'string' || !text) return null;
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
  const generic = isGenericProduct(product);
  const relevanceGuidance = generic
    ? `"${product.name}" is a GENERIC office/printing consumable that almost every operating company buys regularly (regardless of industry). So: if this is clearly a real, operating company (any industry) physically in the target area, score relevance HIGH (70-95) by default — don't require any specific signal that they "need" this product specifically, just that they're a real functioning business who'd plausibly order office printing at some point. Only score low if it's clearly not a real operating company, or clearly not in the area.`
    : `"${product.name}" is a more specialized product. Score relevance based on how plausible it is that a company like this (given its industry/description) would specifically need "${product.name}" — a random unrelated business should score low even if it's real and in-area.`;

  const prompt = `You are a B2B lead-qualification assistant for an industrial printing company (Snehal Printers, Pune).
We sell: "${product.name}"${product.keywords ? ` (related: ${product.keywords})` : ''}.
Target buyers are companies physically located in the ${area} industrial belt near Pune, Maharashtra, India.

Given this raw web search hit, decide if it represents ONE SPECIFIC REAL COMPANY's own website (not a news article, blog, job listing, PDF/document, government or association member-list page, generic directory homepage/search-results page, or any page that just mentions many companies) that could plausibly need to BUY "${product.name}" for its business (packaging, labels, signage, stationery, corporate printing, etc. depending on product).

Reject (is_company: false) anything that is: a downloadable document or file, a list/directory of multiple companies rather than one company's own page, a news/blog article, a job posting, a corporate-registry/company-database page (e.g. Zaubacorp, Tofler, InstaFinancials, MCA/ROC filings, Crunchbase, ZoomInfo, OpenCorporates — these show CIN/director/filing data, not the company's real operating website), or any page you can't confidently attribute to a single named company.

RELEVANCE SCORING GUIDANCE: ${relevanceGuidance}

Title: ${hit.title}
URL: ${hit.url}
Snippet: ${hit.content?.slice(0, 500) || ''}

Respond with ONLY minified JSON, no prose, no markdown:
{"is_company": true|false, "company_name": "string or null", "is_pune_midc_area": true|false, "area_evidence": "short quote/phrase from snippet or null", "relevance_score": 0-100, "relevance_reason": "one short sentence"}`;

  let res;
  try {
    res = await ai.run(MODEL, { messages: [{ role: 'user', content: prompt }], max_tokens: 300 });
  } catch (e) {
    return { is_company: false, company_name: null, is_pune_midc_area: false, area_evidence: null, relevance_score: 0, relevance_reason: `AI call failed: ${e.message}` };
  }
  const text = extractResponseText(res);
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
- Body: 150-200 words, written as THREE short paragraphs (not one block):
  1. Who we are + a specific, non-generic reason we're reaching out to THIS company (their location/industry).
  2. What we can help with re: ${product.name} — concrete, no fluff, no invented stats or client names.
  3. One clear, low-friction call to action (reply or a short call) + sign-off.
- Plain text, no markdown, no bullet points.
- Sign off as "Team Snehal Printers".
- Do NOT invent specific past clients, prices, or claims we can't back up.

Respond with ONLY minified JSON, no prose:
{"subject": "string", "body": "string"}`;

  let res;
  try {
    res = await ai.run(MODEL, { messages: [{ role: 'user', content: prompt }], max_tokens: 500 });
  } catch (e) {
    res = null;
  }
  const text = res ? extractResponseText(res) : '';
  const json = extractJson(text);
  if (!json || !json.subject || !json.body) {
    // No fallback templated email either — if the AI draft failed, the caller
    // should NOT put a generic email into the approval queue. Signal failure.
    return null;
  }
  return json;
}