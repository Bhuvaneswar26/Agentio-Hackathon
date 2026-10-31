import { useMemo, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import {
  AlertCircle,
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  CheckCircle2,
  Clock,
  TrendingUp,
  X,
} from 'lucide-react'
import { EmptyState, PageHeader, QueueBadge, RiskPill } from '../components/ui'
import { inr } from '../lib/format'
import { useQueueMove } from '../lib/useQueueMove'
import { useAppStore } from '../store/useAppStore'
import type { Claim, ClaimQueue } from '../types'

const tabs: Array<{ id: string; label: string; queues?: ClaimQueue[] }> = [
  { id: 'all', label: 'All' },
  { id: 'attention', label: 'Needs action', queues: ['flagged', 'confirmed', 'special'] },
  { id: 'good', label: 'Good claims', queues: ['good', 'dismissed'] },
  { id: 'flagged', label: 'Bad / flagged', queues: ['flagged', 'confirmed'] },
  { id: 'unassessed', label: 'Incomplete', queues: ['unassessed'] },
  { id: 'special', label: 'Special', queues: ['special'] },
  { id: 'intake', label: 'Intake', queues: ['intake'] },
]

type SortKey = 'claim' | 'requested' | 'expected' | 'risk'
type Sort = { key: SortKey; dir: 'asc' | 'desc' }

const sortValue: Record<SortKey, (c: Claim) => string | number> = {
  claim: (c) => c.id,
  requested: (c) => c.requestedAmount,
  expected: (c) => c.expectedSettlement,
  risk: (c) => c.riskScore,
}

function SortHeader({
  label,
  sortKey,
  sort,
  onSort,
  align = 'left',
}: {
  label: string
  sortKey: SortKey
  sort: Sort | null
  onSort: (key: SortKey) => void
  align?: 'left' | 'right' | 'center'
}) {
  const active = sort?.key === sortKey
  const dir = active ? sort?.dir : undefined
  const Icon = dir === 'asc' ? ArrowUp : dir === 'desc' ? ArrowDown : ArrowUpDown
  const alignClass = { left: 'text-left', right: 'text-right', center: 'text-center' }[align]
  return (
    <th
      className={`px-6 py-4 ${alignClass}`}
      aria-sort={dir === 'asc' ? 'ascending' : dir === 'desc' ? 'descending' : 'none'}
    >
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className={`inline-flex items-center gap-1 uppercase tracking-wide transition-colors hover:text-ink ${active ? 'text-ink' : ''}`}
      >
        {label}
        <Icon size={12} className={active ? '' : 'opacity-40'} />
      </button>
    </th>
  )
}

export function Claims() {
  const { claims, filters, setFilters, role } = useAppStore()
  const move = useQueueMove()
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const requestedTab = params.get('tab') ?? 'all'
  const tab = tabs.some((t) => t.id === requestedTab) ? requestedTab : 'all'
  const [sort, setSort] = useState<Sort | null>(null)
  const locked = role === 'executive'

  function selectTab(id: string) {
    setParams(id === 'all' ? {} : { tab: id }, { replace: true })
  }

  function toggleSort(key: SortKey) {
    setSort((current) => {
      if (current?.key !== key) return { key, dir: key === 'claim' ? 'asc' : 'desc' }
      if (current.dir === 'desc') return { key, dir: 'asc' }
      return null
    })
  }

  const counts = useMemo(
    () =>
      Object.fromEntries(
        tabs.map((t) => [
          t.id,
          t.queues ? claims.filter((c) => t.queues?.includes(c.queue)).length : claims.length,
        ]),
      ) as Record<string, number>,
    [claims],
  )

  const filtered = useMemo(() => {
    const q = filters.search.toLowerCase()
    const tabDef = tabs.find((t) => t.id === tab)
    const rows = claims.filter((c) => {
      if (tabDef?.queues && !tabDef.queues.includes(c.queue)) return false
      if (filters.domain !== 'all' && c.domain !== filters.domain) return false
      if (q && !`${c.id} ${c.claimant} ${c.provider} ${c.policyNumber}`.toLowerCase().includes(q)) return false
      return true
    })
    if (!sort) return rows
    const get = sortValue[sort.key]
    const sign = sort.dir === 'asc' ? 1 : -1
    return [...rows].sort((a, b) => {
      const x = get(a)
      const y = get(b)
      return (x < y ? -1 : x > y ? 1 : 0) * sign
    })
  }, [claims, filters, tab, sort])

  const hasFilters = filters.search !== '' || filters.domain !== 'all' || tab !== 'all'

  const statCards = [
    { label: 'Total claims', value: counts.all, tab: 'all', icon: TrendingUp, tile: 'bg-sky-100', color: 'text-sky-600' },
    { label: 'Flagged', value: counts.flagged, tab: 'flagged', icon: AlertCircle, tile: 'bg-orange-100', color: 'text-orange-600' },
    { label: 'Good claims', value: counts.good, tab: 'good', icon: CheckCircle2, tile: 'bg-emerald-100', color: 'text-emerald-600' },
    { label: 'Pending review', value: counts.special, tab: 'special', icon: Clock, tile: 'bg-violet-100', color: 'text-violet-600' },
  ]

  return (
    <div>
      <PageHeader
        eyebrow="Workspace"
        title="Claims desk"
        description="Open a claim to review it, or use the quick actions to mark it good or escalate it. Every change is saved and can be undone."
      />

      <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-4">
        {statCards.map((s) => {
          const Icon = s.icon
          const active = tab === s.tab
          return (
            <button
              key={s.label}
              type="button"
              onClick={() => selectTab(s.tab)}
              aria-pressed={active}
              className={`rounded-xl border bg-white p-4 text-left transition hover:-translate-y-0.5 hover:shadow-md ${
                active ? 'border-ink ring-1 ring-ink/10' : 'border-line'
              }`}
            >
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-xs uppercase tracking-wider text-mute">{s.label}</p>
                  <p className="mt-1 text-2xl font-bold text-ink">{s.value}</p>
                </div>
                <div className={`rounded-lg p-2.5 ${s.tile}`}>
                  <Icon size={18} className={s.color} />
                </div>
              </div>
            </button>
          )
        })}
      </div>

      <div className="mb-6 flex flex-wrap gap-2">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => selectTab(t.id)}
            aria-pressed={tab === t.id}
            className={`inline-flex items-center gap-2 rounded-full px-4 py-2 text-sm font-medium transition-all duration-200 ${
              tab === t.id
                ? 'bg-ink text-white shadow-md'
                : 'border border-line bg-white text-ink hover:-translate-y-0.5 hover:border-ink/40 hover:shadow-sm'
            }`}
          >
            {t.label}
            <span
              className={`rounded-full px-1.5 py-0.5 font-mono text-[11px] ${
                tab === t.id ? 'bg-white/20 text-white' : 'bg-mist text-mute'
              }`}
            >
              {counts[t.id]}
            </span>
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
        {hasFilters ? (
          <button
            type="button"
            onClick={() => {
              setFilters({ search: '', domain: 'all' })
              selectTab('all')
            }}
            className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-line px-4 py-2.5 text-sm text-mute transition hover:border-ink/40 hover:text-ink"
          >
            <X size={14} /> Clear
          </button>
        ) : null}
      </div>

      <p className="mb-2 text-xs text-mute" aria-live="polite">
        Showing {filtered.length} of {claims.length} claims
      </p>

      {filtered.length === 0 ? (
        <EmptyState title="No claims in this view" body="Try another tab or ingest a pack." />
      ) : (
        <div className="overflow-x-auto rounded-xl border border-line bg-white shadow-sm">
          <table className="w-full min-w-[980px] text-left text-sm">
            <thead className="border-b border-line bg-gradient-to-r from-mist to-white text-xs font-semibold uppercase tracking-wide text-mute">
              <tr>
                <SortHeader label="Claim" sortKey="claim" sort={sort} onSort={toggleSort} />
                <th className="px-6 py-4">Domain</th>
                <th className="px-6 py-4">Provider</th>
                <SortHeader label="Requested" sortKey="requested" sort={sort} onSort={toggleSort} align="right" />
                <SortHeader label="Expected" sortKey="expected" sort={sort} onSort={toggleSort} align="right" />
                <SortHeader label="Risk" sortKey="risk" sort={sort} onSort={toggleSort} align="center" />
                <th className="px-6 py-4">Queue</th>
                <th className="px-6 py-4">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {filtered.map((c) => (
                <tr
                  key={c.id}
                  onClick={() => navigate(`/claims/${c.id}`)}
                  className="cursor-pointer transition-colors hover:bg-mist/60"
                >
                  <td className="px-6 py-4">
                    <Link
                      className="font-medium text-ink transition-colors hover:text-brand-dark hover:underline"
                      to={`/claims/${c.id}`}
                      onClick={(e) => e.stopPropagation()}
                    >
                      {c.id}
                    </Link>
                    <p className="mt-1 text-xs text-mute">{c.claimant}</p>
                  </td>
                  <td className="px-6 py-4">
                    <span className="inline-flex items-center rounded-md bg-blue-50 px-2 py-1 text-xs font-medium text-blue-700">
                      {c.domain}
                    </span>
                  </td>
                  <td className="px-6 py-4 text-mute">{c.provider}</td>
                  <td className="px-6 py-4 text-right font-mono font-medium">{inr(c.requestedAmount)}</td>
                  <td className="px-6 py-4 text-right font-mono font-medium text-emerald-700">{inr(c.expectedSettlement)}</td>
                  <td className="px-6 py-4 text-center">
                    <RiskPill score={c.riskScore} />
                  </td>
                  <td className="px-6 py-4">
                    <QueueBadge queue={c.queue} />
                  </td>
                  <td className="px-6 py-4">
                    <div className="flex flex-wrap items-center gap-2" onClick={(e) => e.stopPropagation()}>
                      <Link
                        to={`/claims/${c.id}`}
                        className="rounded-lg border border-line px-3 py-1.5 text-xs font-medium hover:border-ink/40 hover:bg-white"
                      >
                        Open
                      </Link>
                      <Link
                        to={`/claims/${c.id}/investigate`}
                        className="rounded-lg border border-sky-200 bg-sky-50 px-3 py-1.5 text-xs font-medium text-sky-800 hover:bg-sky-100"
                      >
                        Investigate
                      </Link>
                      {!locked && c.queue !== 'good' ? (
                        <button
                          type="button"
                          className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white shadow-sm hover:bg-emerald-700"
                          onClick={() => move(c.id, 'good')}
                        >
                          Mark good
                        </button>
                      ) : null}
                      {!locked && c.queue !== 'special' ? (
                        <button
                          type="button"
                          className="rounded-lg border border-violet-200 px-3 py-1.5 text-xs font-medium text-violet-700 hover:bg-violet-50"
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
