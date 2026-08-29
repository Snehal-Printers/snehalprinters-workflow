import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { getDashboard, listApprovals } from '../services/api'
import { StatCard, Skeleton, StatusBadge, PageHeader, EmptyState } from '../components/ui'
import {
  LayoutDashboard, Users, CheckSquare, ArrowRight, History, Mail, Printer
} from 'lucide-react'
import { formatDistanceToNow } from 'date-fns'

const WF_LABELS = {
  lead_generation:     'Lead Generation',
  lead_email_existing: 'Lead Follow-up',
}

export default function Dashboard() {
  const { data, isLoading } = useQuery({
    queryKey: ['dashboard'],
    queryFn: getDashboard,
    refetchInterval: 60_000,
  })
  const { data: approvalsData } = useQuery({
    queryKey: ['pending-approvals-count'],
    queryFn: () => listApprovals('pending'),
    refetchInterval: 30_000,
  })

  const stats = data || {}
  const pendingApprovals = approvalsData?.approvals || []
  const recentRuns = stats.workflow_runs || []

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <PageHeader icon={LayoutDashboard} title="Dashboard" sub="Snehal Printers lead generation overview" />

      {/* Stats row */}
      <div className="grid grid-cols-2 lg:grid-cols-3 gap-4 mb-8">
        {isLoading ? (
          Array(3).fill(0).map((_, i) => <Skeleton key={i} className="h-24" />)
        ) : (
          <>
            <StatCard label="Total Leads"  value={stats.leads?.total ?? 0}     sub={`${stats.leads?.by_status?.emailed ?? 0} emailed`} accent="text-royal" />
            <StatCard label="New Leads"    value={stats.leads?.by_status?.new ?? 0} sub="not yet contacted"                              accent="text-navy" />
            <StatCard label="Awaiting You" value={stats.pending_approvals ?? 0} sub="pending approvals"                                   accent="text-red-600" />
          </>
        )}
      </div>

      {/* Workflow launchers */}
      <h2 className="text-sm font-semibold text-slate-500 uppercase tracking-wider mb-3">Start a Workflow</h2>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-8">
        <Link to="/leads"
          className="card p-5 hover:shadow-panel transition-shadow group flex flex-col gap-3">
          <div className="w-10 h-10 rounded-xl bg-royal flex items-center justify-center">
            <Users size={20} className="text-white" />
          </div>
          <div>
            <div className="font-semibold text-navy text-sm">Find New Leads</div>
            <div className="text-xs text-slate-400 mt-0.5">Tavily search + AI outreach draft</div>
          </div>
          <div className="flex items-center gap-1 text-xs text-slate-400 group-hover:text-royal transition-colors mt-auto">
            Launch <ArrowRight size={12} />
          </div>
        </Link>
        <Link to="/leads?tab=followup"
          className="card p-5 hover:shadow-panel transition-shadow group flex flex-col gap-3">
          <div className="w-10 h-10 rounded-xl bg-navy flex items-center justify-center">
            <Mail size={20} className="text-white" />
          </div>
          <div>
            <div className="font-semibold text-navy text-sm">Follow Up on a Lead</div>
            <div className="text-xs text-slate-400 mt-0.5">AI-drafted personalised follow-up</div>
          </div>
          <div className="flex items-center gap-1 text-xs text-slate-400 group-hover:text-royal transition-colors mt-auto">
            Launch <ArrowRight size={12} />
          </div>
        </Link>
      </div>

      {/* Pending approvals */}
      {pendingApprovals.length > 0 && (
        <div className="mb-8">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold text-slate-500 uppercase tracking-wider">
              Pending Approvals ({pendingApprovals.length})
            </h2>
            <Link to="/approvals" className="text-xs text-royal hover:underline flex items-center gap-1">
              View all <ArrowRight size={12} />
            </Link>
          </div>
          <div className="card divide-y divide-slate-100">
            {pendingApprovals.slice(0, 5).map(item => (
              <div key={item.id} className="flex items-center gap-4 px-5 py-3.5">
                <CheckSquare size={16} className="text-amber flex-shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-navy capitalize">
                    {WF_LABELS[item.workflow_type] || item.workflow_type?.replace(/_/g, ' ')}
                  </div>
                  <div className="text-xs text-slate-400">
                    {formatDistanceToNow(new Date(item.created_at), { addSuffix: true })}
                  </div>
                </div>
                <StatusBadge status="pending" />
                <Link to="/approvals" className="btn-secondary text-xs py-1 px-3">Review</Link>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Lead pipeline */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-8">
        <div className="card p-5">
          <h3 className="text-sm font-semibold text-navy mb-4">Lead Pipeline</h3>
          {isLoading ? (
            <div className="space-y-2">{Array(4).fill(0).map((_,i) => <Skeleton key={i} className="h-6" />)}</div>
          ) : Object.keys(stats.leads?.by_status || {}).length === 0 ? (
            <p className="text-xs text-slate-400">No leads yet — start a Lead Generation run.</p>
          ) : (
            <div className="space-y-2">
              {Object.entries(stats.leads?.by_status || {}).map(([status, count]) => (
                <div key={status} className="flex items-center justify-between">
                  <StatusBadge status={status} />
                  <span className="text-sm font-semibold text-navy">{count}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="card p-5 flex flex-col items-center justify-center text-center">
          <Printer size={22} className="text-slate-300 mb-2" />
          <p className="text-sm font-medium text-navy">Snehal Printers</p>
          <p className="text-xs text-slate-400 mt-1">Bhosari, Pune, Maharashtra</p>
          <a href="https://snehalprinters.in" target="_blank" rel="noopener noreferrer"
             className="text-xs text-royal hover:underline mt-2">snehalprinters.in ↗</a>
        </div>
      </div>

      {/* Recent workflow runs */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold text-slate-500 uppercase tracking-wider">Recent Workflow Runs</h2>
          <Link to="/history" className="text-xs text-royal hover:underline flex items-center gap-1">
            View history <ArrowRight size={12} />
          </Link>
        </div>
        <div className="card overflow-hidden">
          {isLoading ? (
            <div className="p-4 space-y-3">{Array(4).fill(0).map((_,i) => <Skeleton key={i} className="h-14" />)}</div>
          ) : recentRuns.length === 0 ? (
            <div className="p-5">
              <EmptyState icon={History} title="No workflow runs yet" sub="Launch a workflow to see execution details here." />
            </div>
          ) : (
            <div className="divide-y divide-slate-100">
              {recentRuns.map(run => {
                const durationSec = run.completed_at
                  ? Math.round((new Date(run.completed_at) - new Date(run.started_at)) / 1000)
                  : null
                return (
                  <div key={run.id} className="flex items-center gap-4 px-5 py-4">
                    <div className={`w-2 h-2 rounded-full flex-shrink-0 ${
                      run.status === 'succeeded'          ? 'bg-emerald-400'
                      : run.status === 'running'            ? 'bg-blue-400 animate-pulse'
                      : run.status === 'awaiting_approval'  ? 'bg-amber-400'
                      : run.status === 'stopped'            ? 'bg-slate-400'
                      : 'bg-red-400'
                    }`} />
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-navy capitalize">
                        {WF_LABELS[run.workflow_type] || run.workflow_type?.replace(/_/g, ' ')}
                      </div>
                      <div className="text-xs text-slate-400 mt-0.5 flex items-center gap-2">
                        <span>{formatDistanceToNow(new Date(run.started_at), { addSuffix: true })}</span>
                        {durationSec !== null && <span>· {durationSec}s</span>}
                      </div>
                    </div>
                    <StatusBadge status={run.status} />
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
