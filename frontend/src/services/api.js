import { supabase } from '../lib/supabase'

const BASE = import.meta.env.VITE_API_URL

async function apiRequest(method, path, body, timeout = 30000) {
  const { data: { session } } = await supabase.auth.getSession()
  const headers = { 'Content-Type': 'application/json' }
  if (session?.access_token) headers['Authorization'] = `Bearer ${session.access_token}`

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), timeout)

  try {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    })
    clearTimeout(timeoutId)
    const json = await res.json()
    if (!res.ok) throw new Error(json.error || `API error ${res.status}`)
    return json
  } catch (e) {
    clearTimeout(timeoutId)
    if (e.name === 'AbortError') throw new Error('Request timeout — please try again')
    throw e
  }
}

// ── Workflows ──────────────────────────────────────────────
export const startWorkflow      = (type, payload) =>
  apiRequest('POST', `/workflows/${type}`, payload)

export const getWorkflowStatus  = (runId) =>
  apiRequest('GET', `/workflows/${runId}/status`)

export const stopWorkflow      = (runId) =>
  apiRequest('POST', `/workflows/${runId}/stop`)

export const pauseWorkflow     = (runId) =>
  apiRequest('POST', `/workflows/${runId}/pause`)

export const continueWorkflow  = (runId) =>
  apiRequest('POST', `/workflows/${runId}/continue`)

// ── Approvals ──────────────────────────────────────────────
export const listApprovals = (status = 'pending', workflowType = '') => {
  let qs = `status=${status}`
  if (workflowType) qs += `&workflow_type=${workflowType}`
  return apiRequest('GET', `/approvals?${qs}`)
}

export const approveItem = (id, note = '', edits = {}) =>
  apiRequest('POST', `/approvals/${id}/approve`, { note, edits })

export const rejectItem  = (id, note = '') =>
  apiRequest('POST', `/approvals/${id}/reject`, { note })

// ── Data ───────────────────────────────────────────────────
export const getDashboard    = ()      => apiRequest('GET', '/data/dashboard')
export const getLeads        = (qs='') => apiRequest('GET', `/data/leads?${qs}`)
export const getWorkflowRuns = (qs='') => apiRequest('GET', `/data/workflow-runs?${qs}`)
