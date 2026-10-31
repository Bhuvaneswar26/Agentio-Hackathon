import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { EmptyState, PageHeader, QueueBadge } from '../components/ui'
import { inr } from '../lib/format'
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
  const { claims, filters, setFilters, moveQueue } = useAppStore()
  const [tab, setTab] = useState('all')
  const [reason, setReason] = useState('Supervisor review requested from workspace')

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
        description="Good claims and flagged claims can both be escalated to special review. Incomplete evidence stays unassessed so it cannot be mistaken for fraud."
      />
      <div className="mb-4 flex flex-wrap gap-2">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={`rounded-full px-3 py-1.5 text-sm ${tab === t.id ? 'bg-brand text-ink' : 'bg-white border border-line'}`}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="mb-4 flex flex-wrap gap-2">
        <input
          value={filters.search}
          onChange={(e) => setFilters({ search: e.target.value })}
          placeholder="Search claimant, claim id, provider…"
          className="min-w-56 flex-1 rounded-xl border border-line bg-white px-3 py-2 text-sm outline-none focus:border-brand"
        />
        <select
          value={filters.domain}
          onChange={(e) => setFilters({ domain: e.target.value })}
          className="rounded-xl border border-line bg-white px-3 py-2 text-sm"
        >
          <option value="all">All domains</option>
          <option>Health</option>
          <option>Motor</option>
          <option>General</option>
        </select>
        <input
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          className="min-w-64 flex-1 rounded-xl border border-line bg-white px-3 py-2 text-sm"
          placeholder="Special review reason"
        />
      </div>

      {filtered.length === 0 ? (
        <EmptyState title="No claims in this view" body="Try another tab or ingest a pack." />
      ) : (
        <div className="overflow-x-auto rounded-2xl border border-line bg-white">
          <table className="w-full min-w-[980px] text-left text-sm">
            <thead className="bg-mist text-xs uppercase tracking-wide text-mute">
              <tr>
                <th className="px-4 py-3">Claim</th>
                <th className="px-4 py-3">Domain</th>
                <th className="px-4 py-3">Provider</th>
                <th className="px-4 py-3">Requested</th>
                <th className="px-4 py-3">Expected</th>
                <th className="px-4 py-3">Risk</th>
                <th className="px-4 py-3">Queue</th>
                <th className="px-4 py-3">Escalate</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((c) => (
                <tr key={c.id} className="border-t border-line">
                  <td className="px-4 py-3">
                    <Link className="font-medium hover:text-brand-dark" to={`/claims/${c.id}`}>
                      {c.id}
                    </Link>
                    <p className="text-xs text-mute">{c.claimant}</p>
                  </td>
                  <td className="px-4 py-3">{c.domain}</td>
                  <td className="px-4 py-3">{c.provider}</td>
                  <td className="px-4 py-3 font-mono">{inr(c.requestedAmount)}</td>
                  <td className="px-4 py-3 font-mono">{inr(c.expectedSettlement)}</td>
                  <td className="px-4 py-3 font-mono">{c.riskScore}</td>
                  <td className="px-4 py-3">
                    <QueueBadge queue={c.queue} />
                  </td>
                  <td className="px-4 py-3">
                    {c.queue === 'special' ? (
                      <span className="text-xs text-mute">Already escalated</span>
                    ) : (
                      <button
                        type="button"
                        className="rounded-full bg-ink px-3 py-1 text-xs text-white"
                        onClick={() => moveQueue(c.id, 'special', reason)}
                      >
                        Special review
                      </button>
                    )}
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
