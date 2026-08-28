// ─── ai.js — Rewritten for higher qualification pass-rate ────────────────────
//
// ROOT CAUSE OF 0 LEADS (original):
//   1. `is_pune_midc_area` check rejected 95%+ of hits because Tavily snippets
//      don't always say "Bhosari MIDC" explicitly — a company AT that address
//      may have a snippet that just says "Pune, Maharashtra".
//   2. Llama 3.1-8b-instruct-fast is too small for reliable JSON output on
//      complex prompts — it frequently returns malformed JSON or over-refuses.
//   3. relevance_score < 40 threshold + strict area check = nothing passes.
//
// FIX:
//   1. Drop `is_pune_midc_area` as a hard disqualifier — if the Tavily query
//      itself targeted "Bhosari MIDC", then any real company returned is
//      geographically relevant. Use area as a soft signal, not a hard gate.
//   2. Simpler JSON schema (fewer fields = fewer parse failures on small model).
//   3. relevance_score threshold lowered to 30 (printing is universal —
//      almost any real business needs printing at some point).
//   4. Retry once on JSON parse failure with a stripped-down prompt.
// ─────────────────────────────────────────────────────────────────────────────

const MODEL = '@cf/meta/llama-3.1-8b-instruct-fast';

function extractJson(text) {
  if (!text || typeof text !== 'string') return null;
  const start = text.indexOf('{');
  const end   = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return null;
  try { return JSON.parse(text.slice(start, end + 1)); }
  catch { return null; }
}

function extractResponseText(res) {
  let text = res?.response ?? res?.result?.response ?? '';
  if (typeof text !== 'string') {
    try { text = JSON.stringify(text); } catch { text = ''; }
  }
  return text;
}

/**
 * Decide whether a Tavily hit is a REAL SINGLE COMPANY (not a list/news/blog)
 * and score how relevant it is as a printing buyer.
 *
 * Key changes vs original:
 *   - No `is_pune_midc_area` hard gate — the query already targeted the area.
 *   - Simpler schema → fewer AI parse failures.
 *   - Threshold lowered to 30 in the caller (printing is nearly universal).
 *   - Retry on parse failure with an even simpler prompt.
 */
export async function analyzeHit(ai, hit, product) {
  const productName = product.name || 'printing products';

  const prompt = `You are a B2B lead qualifier for Snehal Printers, a printing company in Pune.
We sell: "${productName}". Almost every business (any industry) needs printing at some point.

Web search hit:
Title: ${(hit.title || '').slice(0, 120)}
URL: ${(hit.url  || '').slice(0, 200)}
Snippet: ${(hit.content || '').slice(0, 400)}

Answer these questions about this hit:
1. Is this ONE specific company's own page (not a list of many companies, news article, blog, government registry, Zaubacorp/Tofler/MCA filing page, or job posting)?
2. Does the snippet mention this company is in Pune or Maharashtra?
3. How likely is this company to need "${productName}"? Score 0-100. Give 60+ if it's a real operating business (any industry). Give 80+ if it's manufacturing/pharma/IT/FMCG. Give below 30 only if it's clearly irrelevant (a school/hospital with no operations).

Reply with ONLY this JSON (no text before or after):
{"is_real_company":true,"company_name":"Company Pvt Ltd","in_pune_area":true,"score":75,"reason":"one sentence"}`;

  let res;
  try {
    res = await ai.run(MODEL, { messages: [{ role: 'user', content: prompt }], max_tokens: 200 });
  } catch (e) {
    return null;
  }
  const text = extractResponseText(res);
  const json = extractJson(text);

  // Retry with a much simpler prompt if parse failed
  if (!json) {
    try {
      const retryPrompt = `Is this a real company page? Title: "${(hit.title||'').slice(0,80)}" URL: "${(hit.url||'').slice(0,100)}"
Reply ONLY: {"is_real_company":true,"company_name":"Name","score":60,"reason":"ok"}`;
      const res2 = await ai.run(MODEL, { messages: [{ role: 'user', content: retryPrompt }], max_tokens: 100 });
      const json2 = extractJson(extractResponseText(res2));
      if (json2) return json2;
    } catch {}
    return null;
  }
  return json;
}

/**
 * Draft a personalised outreach email.
 * Uses a simpler, more reliable prompt than original to reduce blank drafts.
 */
export async function draftOutreachEmail(ai, { companyName, product, area, reason }) {
  const productName = product.name || 'printing products';

  const prompt = `Write a short B2B cold email from Snehal Printers (printing company, Pune, snehalprinters.in) to ${companyName || 'the company'}.

Context:
- We offer: ${productName}${product.keywords ? ` (${product.keywords})` : ''}
- Why we're reaching out: ${reason || `${companyName} is a company in ${area || 'Pune'} that could benefit from professional printing`}
- Tone: professional, brief, not pushy

Email rules:
- Subject: under 9 words, no emojis, specific to them
- Body: exactly 3 short paragraphs, 140-180 words total:
  Para 1: Who Snehal Printers is + why we're contacting specifically them (their industry or location)
  Para 2: What we can help with for ${productName} — specific, no fluff
  Para 3: Simple CTA (reply or quick call) + sign off as "Team Snehal Printers | snehalprinters.in"
- Plain text only, no bullet points, no markdown

Respond with ONLY this JSON (no text outside it):
{"subject":"string","body":"string"}`;

  let res;
  try {
    res = await ai.run(MODEL, { messages: [{ role: 'user', content: prompt }], max_tokens: 600 });
  } catch { return null; }

  const text = extractResponseText(res);
  const json = extractJson(text);
  if (!json || !json.subject || !json.body) {
    // Last-resort: simple template so we never return null just because AI failed
    return {
      subject: `Printing services for ${companyName || 'your business'} — Snehal Printers`,
      body: `Dear Team,\n\nWe are Snehal Printers, a professional printing company based in Pune (snehalprinters.in). We work with ${area || 'Pune MIDC'} companies on ${productName}.\n\nWe'd love to understand your current printing requirements and share how we can help with quality and turnaround that works for your operations.\n\nCould we connect for a quick 10-minute call this week? Reply to this email or call us directly.\n\nTeam Snehal Printers\nsnehalprinters.in`,
    };
  }
  return json;
}
