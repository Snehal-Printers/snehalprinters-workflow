import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { getLeads, getWorkflowRuns } from '../services/api'
import { PageHeader, StatusBadge, EmptyState, Skeleton } from '../components/ui'
import { History, Users, ChevronDown, ChevronRight } from 'lucide-react'
import { format } from 'date-fns'

const TABS = [
  { key: 'leads', label: 'Leads',         icon: Users },
  { key: 'runs',  label: 'Workflow Runs', icon: History },
]

export default function HistoryPage() {
  const [tab, setTab] = useState('leads')
  const [openRunId, setOpenRunId] = useState(null)

  const { data: leadsData, isLoading: ll } = useQuery({ queryKey: ['history-leads'], queryFn: () => getLeads(), enabled: tab === 'leads' })
  const { data: runsData,  isLoading: lr } = useQuery({ queryKey: ['history-runs'],  queryFn: () => getWorkflowRuns('limit=100'), enabled: tab === 'runs' })

  const leads = leadsData?.leads || []
  const runs  = runsData?.runs   || []

  const isLoading = { leads: ll, runs: lr }[tab]

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <PageHeader icon={History} title="History" sub="Every lead found and every workflow run, in one place" />

      <div className="flex gap-1 bg-slate-100 rounded-xl p-1 w-fit mb-6 flex-wrap">
        {TABS.map(({ key, label, icon: Icon }) => (
          <button key={key} onClick={() => setTab(key)}
            className={`flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-sm font-medium transition-colors
              ${tab === key ? 'bg-white text-navy shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}>
            <Icon size={13}/> {label}
          </button>
        ))}
      </div>

      {/* Leads table */}
      {tab === 'leads' && (
        <div className="card overflow-hidden">
          <div className="px-5 py-3.5 border-b border-slate-100 flex items-center justify-between">
            <span className="text-sm font-medium text-navy">All Leads ({leads.length})</span>
          </div>
          {isLoading ? <div className="p-4 space-y-2">{Array(6).fill(0).map((_,i)=><Skeleton key={i} className="h-12"/>)}</div>
          : leads.length === 0 ? <EmptyState icon={Users} title="No leads yet"/>
          : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 border-b border-slate-100">
                  <tr>{['Company','Email','Industry','Product Angle','Status','Created'].map(h=>(
                    <th key={h} className="text-left px-4 py-2.5 text-xs font-semibold text-slate-500 uppercase tracking-wide">{h}</th>
                  ))}</tr>
                </thead>
                <tbody className="divide-y divide-slate-50">
                  {leads.map(l=>(
                    <tr key={l.id} className="hover:bg-slate-50 transition-colors">
                      <td className="px-4 py-3 font-medium text-navy">{l.company_name}</td>
                      <td className="px-4 py-3 text-slate-600">{l.email}</td>
                      <td className="px-4 py-3 text-slate-500">{l.industry}</td>
                      <td className="px-4 py-3 text-slate-500">{l.product_focus}</td>
                      <td className="px-4 py-3"><StatusBadge status={l.status}/></td>
                      <td className="px-4 py-3 text-slate-400 text-xs">
                        {format(new Date(l.created_at), 'dd MMM yy')}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Workflow runs */}
      {tab === 'runs' && (
        <div className="card overflow-hidden">
          <div className="px-5 py-3.5 border-b border-slate-100">
            <span className="text-sm font-medium text-navy">Workflow Runs ({runs.length})</span>
          </div>
          {isLoading ? <div className="p-4 space-y-2">{Array(6).fill(0).map((_,i)=><Skeleton key={i} className="h-12"/>)}</div>
          : runs.length === 0 ? <EmptyState icon={History} title="No workflow runs yet"/>
          : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 border-b border-slate-100">
                  <tr>{['Workflow','Status','Started','Duration','Execution'].map(h=>(
                    <th key={h} className="text-left px-4 py-2.5 text-xs font-semibold text-slate-500 uppercase tracking-wide">{h}</th>
                  ))}</tr>
                </thead>
                <tbody className="divide-y divide-slate-50">
                  {runs.map(r=>(
                    <tr key={r.id} className="hover:bg-slate-50 transition-colors">
                      <td className="px-4 py-3 font-medium text-navy capitalize">{r.workflow_type?.replace(/_/g,' ')}</td>
                      <td className="px-4 py-3"><StatusBadge status={r.status}/></td>
                      <td className="px-4 py-3 text-slate-500 text-xs">{format(new Date(r.started_at),'dd MMM yy HH:mm')}</td>
                      <td className="px-4 py-3 text-slate-400 text-xs">
                        {r.completed_at ? `${Math.round((new Date(r.completed_at)-new Date(r.started_at))/1000)}s` : '—'}
                      </td>
                      <td className="px-4 py-3 text-slate-400 text-xs font-mono truncate max-w-xs">
                        <button onClick={() => setOpenRunId(openRunId === r.id ? null : r.id)} className="flex items-center gap-1 hover:text-navy">
                          {openRunId === r.id ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                          <span className="truncate">{r.workflow_type}_{r.id.slice(0, 8)}</span>
                        </button>
                      </td>
                    </tr>
                  ))}
                  {runs.map(r => openRunId === r.id && (
                    <tr key={`${r.id}-details`} className="bg-slate-50/60">
                      <td colSpan={5} className="px-4 py-4">
                        <div className="grid gap-4 md:grid-cols-3 text-xs">
                          <div>
                            <div className="font-semibold text-slate-600 mb-1">Input</div>
                            <pre className="bg-white border border-slate-200 rounded-lg p-3 overflow-auto max-h-56 whitespace-pre-wrap">{JSON.stringify(r.input || {}, null, 2)}</pre>
                          </div>
                          <div>
                            <div className="font-semibold text-slate-600 mb-1">Output</div>
                            <pre className="bg-white border border-slate-200 rounded-lg p-3 overflow-auto max-h-56 whitespace-pre-wrap">{JSON.stringify(r.output || {}, null, 2)}</pre>
                          </div>
                          <div>
                            <div className="font-semibold text-slate-600 mb-1">Error</div>
                            <pre className="bg-white border border-slate-200 rounded-lg p-3 overflow-auto max-h-56 whitespace-pre-wrap">{r.error_msg || 'No error recorded'}</pre>
                          </div>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
