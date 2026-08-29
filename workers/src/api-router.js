/**
 * Worker 1: API Router (Snehal Printers)
 *
 * Data split:
 *   D1 (env.DB)      → job_queue, workflow_runs, approval_queue
 *   Supabase (env.*) → leads
 *
 * Scope: lead-generation + lead-email-existing workflows only.
 */

import { getClient } from './lib/supabase.js'
import { getD1 }     from './lib/d1.js'
import { ok, err, nowIso } from './lib/utils.js'

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
}

function corsErr(msg, status = 500) {
  return new Response(JSON.stringify({ error: msg }), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  })
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS })
    }

    try {
      const url    = new URL(request.url)
      const path   = url.pathname
      const method = request.method
      const qs     = url.searchParams
      const sb     = getClient(env)
      const d1     = getD1(env)

      if (path.match(/\/workflows\/[a-f0-9-]{36}\/status/) && method === 'GET')
        return handleWorkflowStatus(path, d1)

      const controlMatch = path.match(/\/workflows\/([a-f0-9-]{36})\/(stop|pause|continue)$/)
      if (controlMatch && method === 'POST')
        return handleWorkflowControl(controlMatch[1], controlMatch[2], d1)

      if (path.startsWith('/workflows/') && method === 'POST')
        return handleTrigger(path, request, d1)

      if (path.startsWith('/approvals'))
        return handleApprovals(path, method, request, qs, d1)

      if (path.startsWith('/data'))
        return handleData(path, method, request, qs, sb, d1)

      if (path === '/debug-env' && method === 'GET') {
        const resolve = async (v) => {
          if (!v) return null
          if (typeof v === 'object' && typeof v.get === 'function') {
            try { return await v.get() } catch (e) { return `ERROR: ${e.message}` }
          }
          return String(v)
        }
        const mask = (s) => (s && s.length > 8 && !s.startsWith('ERROR')) ? s.slice(0, 4) + '…' + s.slice(-4) : s

        const [supabaseUrl, supabaseKey, tavilyKey, resendKey, senderEmail, reviewerEmail, apiBaseUrl] =
          await Promise.all([
            resolve(env.SUPABASE_URL),
            resolve(env.SUPABASE_SERVICE_KEY),
            resolve(env.TAVILY_API_KEY),
            resolve(env.RESEND_API_KEY),
            resolve(env.SENDER_EMAIL),
            resolve(env.REVIEWER_EMAIL),
            resolve(env.API_BASE_URL),
          ])

        return new Response(JSON.stringify({
          supabase_url:    mask(supabaseUrl),
          supabase_key:    mask(supabaseKey),
          tavily_key:      mask(tavilyKey),
          resend_key:      mask(resendKey),
          sender_email:    senderEmail,
          reviewer_email:  reviewerEmail,
          api_base_url:    apiBaseUrl,
          has_db_binding:  !!env.DB,
        }), { status: 200, headers: { 'Content-Type': 'application/json', ...CORS } })
      }

      return err('Not found', 404)

    } catch (e) {
      console.error('api-router unhandled error:', e)
      return corsErr(`Internal error: ${e.message}`, 500)
    }
  }
}


// ═══════════════════════════════════════════════════════════════════════════
// WORKFLOW TRIGGER
// ═══════════════════════════════════════════════════════════════════════════

const VALID_WORKFLOW_TYPES = ['lead-generation', 'lead-email-existing']

const FIRST_STEP = {
  'lead-generation':     'lead_select_product',
  'lead-email-existing': 'lead_load_existing',
}

function validateWorkflowInput(wfType, body) {
  if (wfType === 'lead-email-existing' && !body.leadId && !body.lead_id) {
    return 'Missing required field: leadId'
  }
  // lead-generation: location is optional — defaults to Pune/Bhosari/MIDC belt
  return null
}

async function handleTrigger(path, request, d1) {
  const wfType = path.replace('/workflows/', '').split('/')[0]
  if (!VALID_WORKFLOW_TYPES.includes(wfType))
    return err(`Unknown workflow type: ${wfType}. Valid: ${VALID_WORKFLOW_TYPES.join(', ')}`)

  const body = await request.json().catch(() => ({}))

  const validationError = validateWorkflowInput(wfType, body)
  if (validationError) return err(validationError)

  const runId = crypto.randomUUID()
  const now   = nowIso()

  await d1.insert('workflow_runs', {
    id:            runId,
    workflow_type: wfType.replace(/-/g, '_'),
    status:        'running',
    input:         { ...body, workflowRunId: runId },
    started_at:    now,
  })

  await d1.insert('job_queue', {
    id:              crypto.randomUUID(),
    workflow_run_id: runId,
    workflow_type:   wfType.replace(/-/g, '_'),
    step_name:       FIRST_STEP[wfType],
    status:          'pending',
    payload:         { ...body, workflowRunId: runId },
    retry_count:     0,
    created_at:      now,
  })

  return ok({ workflowRunId: runId, status: 'queued', firstStep: FIRST_STEP[wfType] })
}


// ═══════════════════════════════════════════════════════════════════════════
// WORKFLOW CONTROL — stop / pause / continue
// ═══════════════════════════════════════════════════════════════════════════

async function handleWorkflowControl(runId, action, d1) {
  const rows = await d1.select('workflow_runs', { id: runId, _limit: 1 })
  if (!rows.length) return err('Workflow run not found', 404)
  const run = rows[0]
  const now = nowIso()

  if (action === 'stop') {
    await d1.update('workflow_runs', {
      status:       'stopped',
      completed_at: now,
      output:       { stopped: true },
    }, { id: runId })
    await d1.update('job_queue', {
      status:       'stopped',
      completed_at: now,
      error_msg:    'Workflow stopped by user',
    }, { workflow_run_id: runId, status: 'pending' })
    return ok({ message: 'Workflow stopped', runId })
  }

  if (action === 'pause') {
    if (run.status !== 'running') return err(`Workflow is ${run.status} — cannot pause`)
    await d1.update('workflow_runs', { status: 'paused' }, { id: runId })
    return ok({ message: 'Workflow paused', runId })
  }

  if (action === 'continue') {
    if (run.status !== 'paused') return err(`Workflow is ${run.status} — cannot continue`)
    await d1.update('workflow_runs', { status: 'running' }, { id: runId })
    return ok({ message: 'Workflow continued', runId })
  }

  return err(`Unknown action: ${action}`, 404)
}


// ═══════════════════════════════════════════════════════════════════════════
// APPROVALS  — fully in D1
// ═══════════════════════════════════════════════════════════════════════════

async function handleApprovals(path, method, request, qs, d1) {
  const now = nowIso()

  if (method === 'GET' && !path.includes('/approvals/')) {
    const status = qs.get('status') || 'pending'
    const wfType = qs.get('workflow_type') || ''
    const filters = { status, _order: 'created_at DESC', _limit: 50 }
    if (wfType) filters.workflow_type = wfType
    const rows = await d1.select('approval_queue', filters)
    return ok({ approvals: rows, count: rows.length })
  }

  const idMatch = path.match(/\/approvals\/([a-f0-9-]{36})/)
  if (!idMatch) return err('Missing approval ID')
  const approvalId = idMatch[1]

  const rows = await d1.select('approval_queue', { id: approvalId, _limit: 1 })
  if (!rows.length) return err('Approval not found', 404)
  const item = rows[0]

  if (path.endsWith('/email-action'))
    return handleEmailAction(item, approvalId, qs, d1, now)

  if (item.status !== 'pending') return err(`Approval already ${item.status}`)

  const body  = await request.json().catch(() => ({}))
  const note  = body.note  || ''
  const edits = body.edits || {}

  if (path.endsWith('/approve'))    return doApprove(d1, item, approvalId, note, edits, now)
  if (path.endsWith('/reject'))     return doReject(d1, item, approvalId, note, now)

  return err('Unknown approval action', 404)
}

async function doApprove(d1, item, approvalId, note, edits, now) {
  const payload = typeof item.payload === 'string' ? JSON.parse(item.payload) : item.payload
  const runId   = item.workflow_run_id || payload.workflowRunId
  const wfType  = item.workflow_type   || ''

  const merged = (edits && Object.keys(edits).length) ? await persistEdits(d1, item, edits) : payload

  const nextStep = merged._nextStep
  if (nextStep) {
    await d1.insert('job_queue', {
      id:              crypto.randomUUID(),
      workflow_run_id: runId,
      workflow_type:   wfType,
      step_name:       nextStep,
      status:          'pending',
      payload:         { ...merged, approved: true, reviewNote: note },
      retry_count:     0,
      created_at:      now,
    })
  }

  await d1.update('approval_queue', {
    status:        'approved',
    review_note:   note,
    reviewed_at:   now,
    token_used_at: now,
  }, { id: approvalId })

  if (runId) {
    await d1.update('workflow_runs', {
      status: 'running',
      output: { approved: true, note, approvalId },
    }, { id: runId })
  }

  return ok({ message: 'Approved', approvalId })
}

async function doReject(d1, item, approvalId, note, now) {
  const payload = typeof item.payload === 'string' ? JSON.parse(item.payload) : item.payload
  const runId   = item.workflow_run_id || payload.workflowRunId

  await d1.update('approval_queue', {
    status:        'rejected',
    review_note:   note,
    reviewed_at:   now,
    token_used_at: now,
  }, { id: approvalId })

  if (runId) {
    await d1.update('workflow_runs', {
      status:       'failed',
      completed_at: now,
      error_msg:    note || 'Rejected by reviewer',
      output:       { approved: false, note, approvalId },
    }, { id: runId })
  }

  return ok({ message: 'Rejected', approvalId })
}

async function handleEmailAction(item, approvalId, qs, d1, now) {
  const token  = qs.get('token')  || ''
  const action = qs.get('action') || ''

  const htmlPage = (msg, isError) => {
    const colour = isError ? '#DC2626' : '#16A34A'
    const icon   = isError ? '✕' : '✓'
    return new Response(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Snehal Printers Approval</title></head>
<body style="margin:0;padding:40px;font-family:Arial,sans-serif;background:#f1f5f9;text-align:center">
  <div style="max-width:480px;margin:0 auto;background:#fff;border-radius:12px;padding:40px;box-shadow:0 2px 8px rgba(0,0,0,0.08)">
    <div style="font-size:48px;color:${colour}">${icon}</div>
    <h2 style="color:#7C2D12;margin:16px 0 8px">${msg}</h2>
    <p><a href="https://leads.snehalprinters.in/approvals" style="color:#C2410C">View approvals in dashboard</a></p>
  </div>
</body></html>`, { headers: { 'Content-Type': 'text/html' } })
  }

  if (!token || !action)       return htmlPage('Missing token or action.', true)
  if (item.email_token !== token) return htmlPage('Invalid link — token mismatch.', true)
  if (item.token_expires_at && new Date() > new Date(item.token_expires_at))
    return htmlPage('This link has expired. Use the dashboard instead.', true)
  if (item.token_used_at)      return htmlPage('This link has already been used.', false)
  if (item.status !== 'pending') return htmlPage(`Already ${item.status}.`, false)

  if (action === 'approve') {
    await doApprove(d1, item, approvalId, 'Approved via email', {}, now)
    return htmlPage('Approved! The workflow is continuing.', false)
  }
  if (action === 'reject') {
    await doReject(d1, item, approvalId, 'Rejected via email', now)
    return htmlPage('Rejected. Content discarded.', false)
  }
  return htmlPage(`Unknown action: ${action}`, true)
}

async function persistEdits(d1, item, edits) {
  const payload = typeof item.payload === 'string' ? JSON.parse(item.payload) : item.payload
  const merged  = { ...payload }
  // Lead flows store the AI draft under `emailDraft`; the frontend's email
  // editor always submits edits under `edits.email`.
  if (edits.email && merged.emailDraft) {
    merged.emailDraft = { ...merged.emailDraft, ...edits.email }
  }
  await d1.update('approval_queue', { payload: merged }, { id: item.id })
  return merged
}


// ═══════════════════════════════════════════════════════════════════════════
// DATA — leads from Supabase, workflow_runs/dashboard from D1 + Supabase
// ═══════════════════════════════════════════════════════════════════════════

async function handleData(path, method, request, qs, sb, d1) {
  const limit  = parseInt(qs.get('limit')  || '50')
  const offset = parseInt(qs.get('offset') || '0')
  const status = qs.get('status') || ''

  if (method === 'POST') return handleDataAction(path, request, sb, d1)

  // Leads — Supabase
  if (path.includes('/data/leads')) {
    let params = `order=created_at.desc&limit=${limit}&offset=${offset}`
    if (status) params += `&status=eq.${status}`
    const rows = await sb.select('leads', params)
    return ok({ leads: rows, count: rows.length })
  }

  // Workflow runs — D1
  if (path.includes('/data/workflow-runs')) {
    const wfType  = qs.get('workflow_type') || ''
    const filters = { _order: 'started_at DESC', _limit: limit, _offset: offset }
    if (wfType) filters.workflow_type = wfType
    if (status) filters.status = status
    const rows = await d1.select('workflow_runs', filters)
    return ok({ runs: rows, count: rows.length })
  }

  // Dashboard
  if (path.includes('/data/dashboard')) {
    const [leads, pending, runs] = await Promise.all([
      sb.select('leads', 'select=status'),
      d1.select('approval_queue', { status: 'pending', _select: 'id,workflow_type', _limit: 200 }),
      d1.select('workflow_runs',  { _select: 'id,workflow_type,status,started_at,completed_at', _order: 'started_at DESC', _limit: 5 }),
    ])

    const countBy = (rows, field) => rows.reduce((a, r) => {
      const v = r[field] || 'unknown'; a[v] = (a[v] || 0) + 1; return a
    }, {})

    return ok({
      leads:             { total: leads.length, by_status: countBy(leads, 'status') },
      pending_approvals: pending.length,
      workflow_runs:     runs,
    })
  }

  return err('Unknown endpoint', 404)
}

async function handleDataAction(path, request, sb, d1) {
  // No custom POST data-actions for the lead-gen-only build.
  return err('Unknown action', 404)
}


// ═══════════════════════════════════════════════════════════════════════════
// WORKFLOW STATUS — polled by WorkflowProgress component
// ═══════════════════════════════════════════════════════════════════════════

async function handleWorkflowStatus(path, d1) {
  const match = path.match(/\/workflows\/([a-f0-9-]{36})\/status/)
  if (!match) return err('Invalid run ID', 400)
  const runId = match[1]

  const [runs, jobs] = await Promise.all([
    d1.select('workflow_runs', { id: runId, _limit: 1 }),
    d1.select('job_queue', {
      workflow_run_id: runId,
      _order:          'created_at ASC',
      _limit:          50,
    }),
  ])

  if (!runs.length) return err('Workflow run not found', 404)
  const run = runs[0]

  return ok({
    runId,
    status:      run.status,
    startedAt:   run.started_at,
    completedAt: run.completed_at,
    errorMsg:    run.error_msg,
    jobs: jobs.map(j => ({
      id:           j.id,
      step_name:    j.step_name,
      status:       j.status,
      retry_count:  j.retry_count,
      error_msg:    j.error_msg,
      created_at:   j.created_at,
      picked_up_at: j.picked_up_at,
      completed_at: j.completed_at,
    })),
  })
}