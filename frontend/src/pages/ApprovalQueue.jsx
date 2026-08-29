import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { listApprovals, approveItem, rejectItem } from '../services/api'
import { PageHeader, StatusBadge, EmptyState, Modal, Spinner } from '../components/ui'
import {
  CheckSquare, Check, X, Eye, Mail, Users, Pencil, RefreshCw,
} from 'lucide-react'
import toast from 'react-hot-toast'
import { formatDistanceToNow } from 'date-fns'

const WF_META = {
  lead_generation:     { label: 'New Lead',        icon: Users, color: 'text-emerald-600', bg: 'bg-emerald-50' },
  lead_email:          { label: 'Follow-up Email', icon: Mail,  color: 'text-blue-600',     bg: 'bg-blue-50'    },
}

function EditableField({ label, value, onChange, multiline = false, rows = 3 }) {
  return (
    <div className="space-y-1">
      <label className="text-xs font-semibold text-slate-500 uppercase tracking-wide">{label}</label>
      {multiline ? (
        <textarea value={value} onChange={e => onChange(e.target.value)} rows={rows}
          className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-navy/20 focus:border-navy resize-y" />
      ) : (
        <input value={value} onChange={e => onChange(e.target.value)}
          className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-navy/20 focus:border-navy" />
      )}
    </div>
  )
}

function EmailEditor({ email, edits, setEdits }) {
  const setField = (field, val) => setEdits(e => ({ ...e, email: { ...(e.email || {}), [field]: val } }))
  return (
    <div className="space-y-4">
      <EditableField label="Subject" value={edits.email?.subject ?? (email.subject || '')} onChange={val => setField('subject', val)} />
      <EditableField label="Body" value={edits.email?.body ?? (email.body || '')} onChange={val => setField('body', val)} multiline rows={14} />
    </div>
  )
}

function EmailPreview({ email }) {
  return (
    <div className="border border-slate-200 rounded-xl overflow-hidden bg-white">
      <div className="bg-slate-50 border-b border-slate-100 px-5 py-3">
        <p className="text-xs text-slate-400 mb-1">Subject</p>
        <p className="text-sm font-semibold text-navy">{email.subject || '(no subject)'}</p>
      </div>
      <div className="px-5 py-4">
        <div className="text-sm text-slate-700 whitespace-pre-wrap leading-relaxed max-h-96 overflow-y-auto">
          {email.body || '(no body)'}
        </div>
      </div>
    </div>
  )
}

function PreviewModal({ item, onClose, onApprove, onReject, loading }) {
  const [note, setNote]         = useState('')
  const [edits, setEdits]       = useState({})
  const [viewMode, setViewMode] = useState('preview')

  const meta    = WF_META[item.workflow_type] || { label: item.workflow_type, icon: CheckSquare }
  const payload = item.payload || {}
  const lead    = payload.lead || null
  const email   = payload.emailDraft || null
  const hasEdits = Object.keys(edits.email || {}).length > 0

  return (
    <Modal open title={`Review — ${lead?.company_name || meta.label}`} onClose={onClose} width="max-w-3xl">
      <div className="space-y-4">
        <div className="flex items-center gap-2 text-xs text-slate-500 bg-slate-50 border border-slate-100 rounded-lg px-3 py-2 flex-wrap">
          <Pencil size={12} className="text-slate-400 flex-shrink-0" />
          Review the draft, switch to Edit to make changes, then approve to send.
          {hasEdits && <span className="ml-auto text-amber-600 font-medium">Unsaved edits</span>}
        </div>

        {lead && (
          <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-4">
            <p className="text-xs font-semibold text-emerald-700 uppercase tracking-wide mb-3">Lead Details</p>
            <div className="grid grid-cols-2 gap-3">
              {[
                ['Company',  lead.company_name],
                ['Industry', lead.industry],
                ['Website',  lead.website],
                ['Email',    lead.email],
                ['Location', lead.address],
                ['Product',  lead.product_focus || payload.selected_product],
              ].filter(([,v]) => v).map(([k,v]) => (
                <div key={k}>
                  <p className="text-xs text-slate-400">{k}</p>
                  <p className="text-sm font-medium text-slate-700 break-all">{v}</p>
                </div>
              ))}
            </div>
            {lead.description && (
              <p className="mt-3 text-xs text-slate-500 italic border-t border-emerald-100 pt-2">{lead.description}</p>
            )}
          </div>
        )}

        {email && (
          <>
            <div className="flex items-center gap-1 bg-slate-100 rounded-xl p-1 w-fit">
              <button onClick={() => setViewMode('preview')}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors
                  ${viewMode === 'preview' ? 'bg-white text-navy shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}>
                <Eye size={12} />Preview
              </button>
              <button onClick={() => setViewMode('edit')}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors
                  ${viewMode === 'edit' ? 'bg-white text-navy shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}>
                <Pencil size={12} />Edit
              </button>
            </div>
            {viewMode === 'edit'
              ? <EmailEditor email={email} edits={edits} setEdits={setEdits} />
              : <EmailPreview email={{ ...email, ...(edits.email || {}) }} />}
          </>
        )}

        {!email && item.preview_html && (
          <div className="p-4 text-sm border border-slate-200 rounded-xl" dangerouslySetInnerHTML={{ __html: item.preview_html }} />
        )}

        <div>
          <label className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Review Note (optional)</label>
          <textarea value={note} onChange={e => setNote(e.target.value)}
            className="w-full mt-1 px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-navy/20 resize-none h-16"
            placeholder="Add a note for the record…" />
        </div>

        <div className="flex gap-3 pt-1">
          <button onClick={() => onApprove(item.id, note, edits)} disabled={loading}
            className="btn-primary flex-1 justify-center py-2.5 bg-emerald-600 hover:bg-emerald-700">
            {loading ? <Spinner size={16}/> : <><Check size={15}/>{hasEdits ? 'Save Edits & Approve' : 'Approve & Send'}</>}
          </button>
          <button onClick={() => onReject(item.id, note)} disabled={loading}
            className="btn-danger flex-1 justify-center py-2.5">
            {loading ? <Spinner size={16}/> : <><X size={15}/>Reject</>}
          </button>
        </div>
      </div>
    </Modal>
  )
}

export default function ApprovalQueue() {
  const qc = useQueryClient()
  const [statusFilter, setStatusFilter] = useState('pending')
  const [preview, setPreview]           = useState(null)
  const [actionLoading, setActionLoading] = useState(false)

  const { data, isLoading, refetch } = useQuery({
    queryKey: ['approvals', statusFilter],
    queryFn:  () => listApprovals(statusFilter),
    refetchInterval: statusFilter === 'pending' ? 15_000 : false,
  })
  const items = data?.approvals || []

  async function handleApprove(id, note, edits = {}) {
    setActionLoading(true)
    try {
      await approveItem(id, note, edits)
      toast.success('Approved — email will be sent shortly')
      setPreview(null)
      qc.invalidateQueries(['approvals'])
      qc.invalidateQueries(['dashboard'])
      qc.invalidateQueries(['pending-approvals-count'])
      qc.invalidateQueries(['leads'])
    } catch (e) {
      toast.error(e.message)
    } finally {
      setActionLoading(false)
    }
  }

  async function handleReject(id, note) {
    setActionLoading(true)
    try {
      await rejectItem(id, note)
      toast.success('Rejected.')
      setPreview(null)
      qc.invalidateQueries(['approvals'])
      qc.invalidateQueries(['pending-approvals-count'])
    } catch (e) {
      toast.error(e.message)
    } finally {
      setActionLoading(false)
    }
  }

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <PageHeader icon={CheckSquare} title="Approvals"
        sub="Review each AI-drafted outreach email before it's sent.">
        <button onClick={() => refetch()} className="btn-secondary"><RefreshCw size={14}/>Refresh</button>
      </PageHeader>

      <div className="flex gap-1 bg-slate-100 rounded-xl p-1 w-fit mb-6">
        {['pending','approved','rejected'].map(s => (
          <button key={s} onClick={() => setStatusFilter(s)}
            className={`px-4 py-1.5 rounded-lg text-sm font-medium transition-colors capitalize
              ${statusFilter === s ? 'bg-white text-navy shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}>
            {s}
          </button>
        ))}
      </div>

      <div className="card overflow-hidden">
        {isLoading ? (
          <div className="flex justify-center py-12"><Spinner size={24}/></div>
        ) : items.length === 0 ? (
          <EmptyState icon={CheckSquare}
            title={statusFilter === 'pending' ? 'No pending approvals' : `No ${statusFilter} items`}
            sub={statusFilter === 'pending' ? 'All clear!' : ''} />
        ) : (
          <div className="divide-y divide-slate-100">
            {items.map(item => {
              const meta = WF_META[item.workflow_type] || { label: item.workflow_type, icon: CheckSquare, color: 'text-slate-600', bg: 'bg-slate-50' }
              const Icon = meta.icon
              const lead = (item.payload || {}).lead
              return (
                <div key={item.id} className="flex items-center gap-4 px-5 py-4 hover:bg-slate-50 transition-colors">
                  <div className={`w-9 h-9 rounded-xl ${meta.bg} flex items-center justify-center flex-shrink-0`}>
                    <Icon size={17} className={meta.color} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-navy">{lead?.company_name || meta.label}</span>
                      <span className="text-xs text-slate-400">{meta.label}</span>
                      <StatusBadge status={item.status} />
                    </div>
                    <div className="text-xs text-slate-400 mt-0.5 flex items-center gap-2">
                      <span>{formatDistanceToNow(new Date(item.created_at), { addSuffix: true })}</span>
                      {item.review_note && <span className="italic truncate max-w-xs">· "{item.review_note}"</span>}
                    </div>
                  </div>
                  {item.status === 'pending' ? (
                    <div className="flex items-center gap-2">
                      <button onClick={() => setPreview(item)} className="btn-secondary text-xs py-1.5">
                        <Eye size={13}/>Review & Edit
                      </button>
                      <button onClick={() => handleApprove(item.id, '', {})}
                        disabled={actionLoading}
                        className="btn-primary text-xs py-1.5 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 disabled:cursor-not-allowed">
                        {actionLoading ? <span className="w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin"/> : <><Check size={13}/>Quick Approve</>}
                      </button>
                    </div>
                  ) : (
                    <button onClick={() => setPreview(item)} className="btn-secondary text-xs py-1.5">
                      <Eye size={13}/>View
                    </button>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>

      {preview && (
        <PreviewModal item={preview} onClose={() => setPreview(null)}
          onApprove={handleApprove} onReject={handleReject} loading={actionLoading} />
      )}
    </div>
  )
}
