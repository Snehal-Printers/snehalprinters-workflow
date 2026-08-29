/**
 * Lead Email Existing — Step Handlers (Snehal Printers)
 * Follow-up outreach to a lead already saved in Supabase.
 *
 * Steps:
 *   lead_load_existing    → fetch lead from Supabase by ID
 *   lead_email_draft_email→ CF Workers AI drafts personalised follow-up email
 *   lead_approval_gate    → email notification + dashboard approval
 *   lead_send_email       → send via Resend (info@snehalprinters.in), update lead status
 *
 * Required secrets: SUPABASE_URL, SUPABASE_SERVICE_KEY,
 *   RESEND_API_KEY,
 *   SENDER_EMAIL (e.g. info@snehalprinters.in), REVIEWER_EMAIL, API_BASE_URL
 */

import { cfAiExtractJsonStrict } from '../lib/cf-ai.js'
import { getClient }             from '../lib/supabase.js'
import { nowIso }                from '../lib/utils.js'
import { nextJob }               from '../job-runner.js'

async function resolveSecret(val) {
  if (!val) return undefined
  if (typeof val === 'object' && typeof val.get === 'function') return await val.get()
  if (typeof val === 'string') return val
  return String(val)
}

function parseEmailList(str) {
  if (!str) return []
  return str.split(',').map(s => s.trim()).filter(Boolean)
}

const SENDER_NAME     = 'Snehal Printers Team'
const COMPANY_WEBSITE = 'https://snehalprinters.in'

const SYSTEM_PROMPT = `You are a friendly, professional B2B copywriter for Snehal Printers, an offset & digital printing press in Bhosari, Pune.
Write concise, personalized follow-up emails that are warm but professional.
Never sound like a mass mailer. Reference the specific company and why Snehal Printers can help them.`


// ═══════════════════════════════════════════════════════════════════════════
// Step 1: Load Existing Lead
// ═══════════════════════════════════════════════════════════════════════════

export async function leadLoadExisting(ctx) {
  const { payload, env } = ctx
  const leadId = payload.leadId || payload.lead_id
  if (!leadId) throw new Error('Missing leadId in payload')

  const sb = getClient(env)
  const rows = await sb.select('leads', `id=eq.${leadId}&limit=1`)
  if (!rows.length) throw new Error(`Lead not found: ${leadId}`)

  const lead = rows[0]
  console.log(`[lead_load_existing] loaded lead=${lead.id} company=${lead.company_name}`)

  await nextJob(ctx, 'lead_email_draft_email', {
    lead,
    leadId: lead.id,
  })
}


// ═══════════════════════════════════════════════════════════════════════════
// Step 2: Draft Follow-up Email with CF Workers AI
// ═══════════════════════════════════════════════════════════════════════════

export async function leadCfDraftEmail(ctx) {
  const { payload, env } = ctx
  const lead = payload.lead || {}
  if (!lead.id || !lead.company_name) throw new Error('Missing lead data in payload')

  const prompt = `Draft a short B2B follow-up email from ${SENDER_NAME} to ${lead.company_name}.

Lead details:
- Company: ${lead.company_name}
- Industry: ${lead.industry || 'unknown'}
- Website: ${lead.website || 'N/A'}
- Notes: ${lead.description || ''}
- Location: ${lead.address || ''}
- Product focus of earlier outreach: ${lead.product_focus || ''}

Snehal Printers offers, on demand:
- Offset & Digital Printing for any volume
- Corporate stationery: Letter Heads, Envelopes, Business Cards, Bill Books, Registers, Office Files
- Reports & marketing collateral: Annual Reports, Brochures, Newsletters, Flyers & Leaflets
- Operations documentation: Challans, Delivery Challans, Gate Passes, Vouchers & Tags
- Labels, Stickers (incl. parking stickers), Notepads & Deskpads
- Website: ${COMPANY_WEBSITE}

Return JSON with exactly these fields:
{
  "subject": "email subject line",
  "body": "full email body with proper greeting, brief follow-up context, value proposition, CTA, and signature from ${SENDER_NAME}"
}`

  const draft = await cfAiExtractJsonStrict(env, prompt, SYSTEM_PROMPT, {
    type: 'object',
    properties: {
      subject: { type: 'string' },
      body:    { type: 'string' },
    },
    required: ['subject', 'body'],
  }, 1500)
  console.log(`[lead_cf_draft_email] drafted for lead=${lead.id} company=${lead.company_name}`)

  await nextJob(ctx, 'lead_approval_gate', {
    lead,
    leadId: lead.id,
    emailDraft: draft,
  })
}


// ═══════════════════════════════════════════════════════════════════════════
// Step 3: Approval Gate for Lead Follow-up Email
// ═══════════════════════════════════════════════════════════════════════════

export async function leadApprovalGate(ctx) {
  const { payload, env, d1, workflow_run_id, job } = ctx
  const lead       = payload.lead       || {}
  const emailDraft = payload.emailDraft || {}
  const leadId     = payload.leadId     || lead.id

  if (!emailDraft.subject) throw new Error('Missing emailDraft in payload')

  const apiBase    = await resolveSecret(env.API_BASE_URL) || ''
  const approvalId = crypto.randomUUID()
  const emailToken = crypto.randomUUID().replace(/-/g, '')
  const now        = nowIso()

  const previewHtml = `
    <div style="font-family:Arial,sans-serif;max-width:600px">
      <h2 style="color:#7C2D12">Follow-up Email — ${lead.company_name || ''}</h2>
      <div style="background:#FFF7ED;border:1px solid #FED7AA;border-radius:8px;padding:20px">
        <p><strong>To:</strong> ${lead.email || ''}</p>
        <p><strong>Subject:</strong> ${emailDraft.subject || ''}</p>
        <hr style="border:none;border-top:1px solid #FED7AA"/>
        <div style="white-space:pre-wrap;font-size:13px">${emailDraft.body || ''}</div>
      </div>
    </div>`

  await d1.insert('approval_queue', {
    id:              approvalId,
    workflow_type:   'lead_email',
    workflow_run_id,
    reference_id:    leadId || null,
    task_token:      `lead-email-${crypto.randomUUID()}`,
    payload:         { lead, leadId, emailDraft, approvalGate: 'save', _nextStep: 'lead_send_email' },
    preview_html:    previewHtml,
    status:          'pending',
    email_token:     emailToken,
    token_expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    created_at:      now,
  })

  console.log(`[lead_approval_gate] approval_id=${approvalId} lead=${leadId}`)

  try {
    const reviewerEmails = parseEmailList(await resolveSecret(env.REVIEWER_EMAIL))
    const senderEmail    = await resolveSecret(env.SENDER_EMAIL) || 'info@snehalprinters.in'
    if (reviewerEmails.length && apiBase) {
      await sendLeadApprovalNotification(env, {
        to: reviewerEmails,
        senderEmail,
        approveUrl: `${apiBase}/approvals/${approvalId}/email-action?token=${emailToken}&action=approve`,
        rejectUrl:  `${apiBase}/approvals/${approvalId}/email-action?token=${emailToken}&action=reject`,
        lead,
        emailDraft,
      })
    }
  } catch (e) {
    console.warn(`[lead_approval_gate] notification email failed: ${e.message}`)
  }

  await d1.update('job_queue', { status: 'waiting_for_approval' }, { id: job.id })
  if (workflow_run_id) {
    await d1.update('workflow_runs', { status: 'awaiting_approval' }, { id: workflow_run_id })
  }
}


// ═══════════════════════════════════════════════════════════════════════════
// Step 4: Send Email (triggered by api-router on approval)
// ═══════════════════════════════════════════════════════════════════════════

export async function leadSendEmail(ctx) {
  const { payload, env } = ctx
  const lead       = payload.lead       || {}
  const emailDraft = payload.emailDraft || {}
  const leadId     = payload.leadId     || lead.id
  const senderEmail = await resolveSecret(env.SENDER_EMAIL) || 'info@snehalprinters.in'

  const to      = lead.email || ''
  const subject = emailDraft.subject || 'Follow-up'
  const body    = emailDraft.body    || ''

  if (!to) throw new Error('No recipient email address for lead')
  if (!leadId) throw new Error('Missing leadId')

  const html   = buildPlainEmailHtml(subject, body)
  const result = await sendViaResend(env, { to, from: senderEmail, subject, html })
  console.log(`[lead_send_email] sent to=${to} leadId=${leadId} resendId=${result.id}`)

  const sb = getClient(env)
  try {
    await sb.update('leads', {
      status:     'emailed',
      updated_at: nowIso(),
    }, `id=eq.${leadId}`)
  } catch (e) {
    console.warn(`[lead_send_email] lead status update failed: ${e.message}`)
  }
}


// ═══════════════════════════════════════════════════════════════════════════
// Resend helper — sends from a verified custom domain (info@snehalprinters.in)
// ═══════════════════════════════════════════════════════════════════════════

async function sendViaResend(env, { to, from, subject, html, replyTo }) {
  const apiKey = await resolveSecret(env.RESEND_API_KEY)
  if (!apiKey) throw new Error('Missing secret: RESEND_API_KEY')

  const res = await fetch('https://api.resend.com/emails', {
    method:  'POST',
    headers: {
      Authorization:  `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from:     `Snehal Printers <${from}>`,
      to:       Array.isArray(to) ? to : [to],
      subject,
      html,
      reply_to: replyTo || from,
    }),
  })
  if (!res.ok) {
    const t = await res.text()
    throw new Error(`Resend send failed ${res.status}: ${t}`)
  }
  return res.json()
}

async function sendLeadApprovalNotification(env, { to, senderEmail, approveUrl, rejectUrl, lead, emailDraft }) {
  const companyName = lead.company_name || ''
  const bodyPreview = emailDraft.body || ''

  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:Arial,sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" style="padding:32px 16px">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0"
        style="background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08)">
        <tr>
          <td style="background:#7C2D12;padding:24px 32px">
            <div style="color:#FDBA74;font-size:20px;font-weight:bold">Snehal Printers</div>
            <div style="color:#FED7AA;font-size:13px;margin-top:4px">Follow-up Email Approval Required</div>
          </td>
        </tr>
        <tr>
          <td style="padding:24px 32px 16px">
            <div style="font-size:20px;font-weight:bold;color:#7C2D12">
              Follow-up Email — ${companyName}
            </div>
            <div style="color:#64748B;font-size:14px;margin-top:6px">
              Email: <strong>${lead.email || ''}</strong>
            </div>
          </td>
        </tr>
        <tr>
          <td style="padding:0 32px 24px">
            <div style="background:#FFF7ED;border:1px solid #FED7AA;border-radius:8px;padding:20px;font-size:14px;color:#334155">
              <p><strong>Company:</strong> ${companyName}</p>
              <p><strong>Industry:</strong> ${lead.industry || ''}</p>
              <p><strong>Website:</strong> ${lead.website || ''}</p>
              <hr style="border:none;border-top:1px solid #FED7AA;margin:12px 0"/>
              <p><strong>Email Subject:</strong> ${emailDraft.subject || ''}</p>
              <div style="white-space:pre-wrap;font-size:13px">${bodyPreview}</div>
            </div>
          </td>
        </tr>
        <tr>
          <td style="padding:0 32px 32px">
            <table width="100%"><tr>
              <td width="48%" align="center">
                <a href="${approveUrl}"
                   style="display:block;background:#16A34A;color:#fff;text-decoration:none;
                          font-size:16px;font-weight:bold;padding:14px 20px;border-radius:8px;text-align:center">
                  ✓ &nbsp; Approve & Send
                </a>
              </td>
              <td width="4%"></td>
              <td width="48%" align="center">
                <a href="${rejectUrl}"
                   style="display:block;background:#DC2626;color:#fff;text-decoration:none;
                          font-size:16px;font-weight:bold;padding:14px 20px;border-radius:8px;text-align:center">
                  ✕ &nbsp; Reject
                </a>
              </td>
            </tr></table>
            <div style="text-align:center;margin-top:16px;color:#94A3B8;font-size:12px">
              Links expire in 1 hour.
            </div>
          </td>
        </tr>
        <tr>
          <td style="background:#f8fafc;border-top:1px solid #e2e8f0;padding:16px 32px;text-align:center">
            <div style="color:#94A3B8;font-size:12px">Snehal Printers · Bhosari, Pune</div>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body></html>`

  await sendViaResend(env, {
    to,
    from:    senderEmail,
    subject: `[Approval] Follow-up Email — ${companyName}`,
    html,
  })
  console.log(`[lead_approval_gate] notification sent to=${to}`)
}

function buildPlainEmailHtml(subject, body) {
  const bodyHtml = body
    .replace(/\n\n/g, `</p><p style="margin:14px 0;color:#292524;line-height:1.7;">`)
    .replace(/\n/g, '<br>')

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#FFFBF5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
<div style="max-width:600px;margin:32px auto;background:#fff;border-radius:16px;border:1px solid #FDE4C8;overflow:hidden">
  <div style="background:#7C2D12;padding:24px 32px">
    <div style="color:#fff;font-weight:700;font-size:16px">Snehal Printers</div>
  </div>
  <div style="padding:32px">
    <p style="margin:14px 0;color:#292524;line-height:1.7">${bodyHtml}</p>
  </div>
  <div style="background:#FFFBF5;border-top:1px solid #FDE4C8;padding:20px 32px;text-align:center">
    <p style="margin:0;font-size:12px;color:#A8A29E">Snehal Printers · snehalprinters.in</p>
  </div>
</div>
</body></html>`
}
