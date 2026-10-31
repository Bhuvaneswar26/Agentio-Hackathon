import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { TrendingUp, AlertCircle, CheckCircle2, Clock } from 'lucide-react'
import { EmptyState, PageHeader, QueueBadge } from '../components/ui'
import { inr } from '../lib/format'
import { useQueueMove } from '../lib/useQueueMove'
import { useAppStore } from '../store/useAppStore'
import type { ClaimQueue } from '../types'

const tabs: Array<{ id: string; label: string; queues?: ClaimQueue[] }> = [
  { id: 'all', label: 'All' },
  { id: 'good', label: 'Good claims', queues: ['good', 'dismissed'] },
  { id: 'flagged', label: 'Bad / flagged', queues: ['flagged', 'confirmed'] },
  { id: 'unassessed', label: 'Incomplete', queues: ['unassessed'] },
  { id: 'special', label: 'Special', queues: ['special'] },
  { id: 'intake', label: 'Intake', queues: ['intake'] },
]

export function Claims() {
  const { claims, filters, setFilters, role } = useAppStore()
  const move = useQueueMove()
  const [tab, setTab] = useState('all')
  const locked = role === 'executive'

  const stats = useMemo(() => ({
    total: claims.length,
    good: claims.filter(c => ['good', 'dismissed'].includes(c.queue)).length,
    flagged: claims.filter(c => ['flagged', 'confirmed'].includes(c.queue)).length,
    unassessed: claims.filter(c => c.queue === 'unassessed').length,
    special: claims.filter(c => c.queue === 'special').length,
  }), [claims])

  const filtered = useMemo(() => {
    const q = filters.search.toLowerCase()
    return claims.filter((c) => {
      const tabDef = tabs.find((t) => t.id === tab)
      if (tabDef?.queues && !tabDef.queues.includes(c.queue)) return false
      if (filters.domain !== 'all' && c.domain !== filters.domain) return false
      if (q && !`${c.id} ${c.claimant} ${c.provider} ${c.policyNumber}`.toLowerCase().includes(q)) return false
      return true
    })
  }, [claims, filters, tab])

  return (
    <div>
      <PageHeader
        eyebrow="Workspace"
        title="Claims desk"
        description="Open a claim to review it, or use the quick actions to mark it good or escalate it. Every change is saved and can be undone."
      />

      <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-4">
        <div className="rounded-xl border border-line bg-white p-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs uppercase tracking-wider text-mute">Total claims</p>
              <p className="mt-1 text-2xl font-bold text-ink">{stats.total}</p>
            </div>
            <div className="rounded-lg bg-brand/10 p-2.5">
              <TrendingUp size={18} className="text-brand" />
            </div>
          </div>
        </div>
        <div className="rounded-xl border border-line bg-white p-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs uppercase tracking-wider text-mute">Flagged</p>
              <p className="mt-1 text-2xl font-bold text-ink">{stats.flagged}</p>
            </div>
            <div className="rounded-lg bg-red-100 p-2.5">
              <AlertCircle size={18} className="text-red-600" />
            </div>
          </div>
        </div>
        <div className="rounded-xl border border-line bg-white p-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs uppercase tracking-wider text-mute">Good claims</p>
              <p className="mt-1 text-2xl font-bold text-ink">{stats.good}</p>
            </div>
            <div className="rounded-lg bg-green-100 p-2.5">
              <CheckCircle2 size={18} className="text-green-600" />
            </div>
          </div>
        </div>
        <div className="rounded-xl border border-line bg-white p-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs uppercase tracking-wider text-mute">Pending review</p>
              <p className="mt-1 text-2xl font-bold text-ink">{stats.special}</p>
            </div>
            <div className="rounded-lg bg-amber-100 p-2.5">
              <Clock size={18} className="text-amber-600" />
            </div>
          </div>
        </div>
      </div>

      <div className="mb-6 flex flex-wrap gap-2">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={`rounded-full px-4 py-2 text-sm font-medium transition-all duration-200 ${
              tab === t.id
                ? 'bg-brand text-ink shadow-md'
                : 'bg-white border border-line text-ink hover:border-brand hover:shadow-sm'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="mb-6 flex flex-col gap-3 rounded-xl border border-line bg-white p-4 md:flex-row md:items-end md:gap-2">
        <input
          value={filters.search}
          onChange={(e) => setFilters({ search: e.target.value })}
          placeholder="Search claimant, claim id, provider…"
          className="flex-1 rounded-lg border border-line bg-mist px-4 py-2.5 text-sm outline-none transition-colors focus:border-brand focus:bg-white"
        />
        <select
          value={filters.domain}
          onChange={(e) => setFilters({ domain: e.target.value })}
          className="rounded-lg border border-line bg-mist px-4 py-2.5 text-sm outline-none transition-colors focus:border-brand focus:bg-white"
        >
          <option value="all">All domains</option>
          <option>Health</option>
          <option>Motor</option>
          <option>General</option>
        </select>
      </div>

      {filtered.length === 0 ? (
        <EmptyState title="No claims in this view" body="Try another tab or ingest a pack." />
      ) : (
        <div className="overflow-x-auto rounded-xl border border-line bg-white shadow-sm">
          <table className="w-full min-w-[980px] text-left text-sm">
            <thead className="bg-gradient-to-r from-mist to-white text-xs font-semibold uppercase tracking-wide text-mute border-b border-line">
              <tr>
                <th className="px-6 py-4">Claim</th>
                <th className="px-6 py-4">Domain</th>
                <th className="px-6 py-4">Provider</th>
                <th className="px-6 py-4 text-right">Requested</th>
                <th className="px-6 py-4 text-right">Expected</th>
                <th className="px-6 py-4 text-center">Risk</th>
                <th className="px-6 py-4">Queue</th>
                <th className="px-6 py-4">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {filtered.map((c) => (
                <tr key={c.id} className="transition-colors hover:bg-mist/30">
                  <td className="px-6 py-4">
                    <Link className="font-medium text-brand hover:text-brand-dark transition-colors" to={`/claims/${c.id}`}>
                      {c.id}
                    </Link>
                    <p className="text-xs text-mute mt-1">{c.claimant}</p>
                  </td>
                  <td className="px-6 py-4">
                    <span className="inline-flex items-center rounded-md bg-blue-50 px-2 py-1 text-xs font-medium text-blue-700">
                      {c.domain}
                    </span>
                  </td>
                  <td className="px-6 py-4 text-mute">{c.provider}</td>
                  <td className="px-6 py-4 font-mono text-right font-medium">{inr(c.requestedAmount)}</td>
                  <td className="px-6 py-4 font-mono text-right font-medium text-green-600">{inr(c.expectedSettlement)}</td>
                  <td className="px-6 py-4 text-center">
                    <span className={`inline-flex items-center rounded-full px-3 py-1 text-xs font-semibold ${
                      c.riskScore > 70 ? 'bg-red-100 text-red-700' :
                      c.riskScore > 40 ? 'bg-amber-100 text-amber-700' :
                      'bg-green-100 text-green-700'
                    }`}>
                      {c.riskScore}
                    </span>
                  </td>
                  <td className="px-6 py-4">
                    <QueueBadge queue={c.queue} />
                  </td>
                  <td className="px-6 py-4">
                    <div className="flex flex-wrap items-center gap-2">
                      <Link
                        to={`/claims/${c.id}`}
                        className="rounded-lg border border-line px-3 py-1.5 text-xs font-medium hover:border-brand"
                      >
                        Open
                      </Link>
                      {!locked && c.queue !== 'good' ? (
                        <button
                          type="button"
                          className="rounded-lg bg-brand px-3 py-1.5 text-xs font-medium text-ink shadow-sm hover:bg-brand-dark"
                          onClick={() => move(c.id, 'good')}
                        >
                          Mark good
                        </button>
                      ) : null}
                      {!locked && c.queue !== 'special' ? (
                        <button
                          type="button"
                          className="rounded-lg border border-line px-3 py-1.5 text-xs font-medium hover:border-brand"
                          onClick={() => move(c.id, 'special', 'Escalated from claims workspace')}
                        >
                          Escalate
                        </button>
                      ) : null}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
