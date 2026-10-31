import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { EmptyState, PageHeader, QueueBadge, SeverityBadge } from '../components/ui'
import { findingLabel, inr } from '../lib/format'
import { useAppStore } from '../store/useAppStore'
import type { Certainty, FindingKind } from '../types'

export function Alerts() {
  const claims = useAppStore((s) => s.claims)
  const [kind, setKind] = useState('all')
  const [certainty, setCertainty] = useState('all')
  const [minRisk, setMinRisk] = useState(0)

  const rows = useMemo(() => {
    return claims
      .flatMap((c) => c.findings.map((f) => ({ claim: c, finding: f })))
      .filter((r) => (kind === 'all' ? true : r.finding.kind === kind))
      .filter((r) => (certainty === 'all' ? true : r.finding.certainty === certainty))
      .filter((r) => r.claim.riskScore >= minRisk)
      .sort((a, b) => b.finding.leakageAmount - a.finding.leakageAmount)
  }, [claims, kind, certainty, minRisk])

  const kinds = Array.from(new Set(claims.flatMap((c) => c.findings.map((f) => f.kind))))

  return (
    <div>
      <PageHeader
        eyebrow="Investigation"
        title="Fraud alerts & leakage findings"
        description="Each row is an explainable finding. Confirmed amounts are calculated. Potential amounts stay out of savings. Legitimate repeats are labelled so they are not treated as duplicates."
      />
      <div className="mb-4 flex flex-wrap gap-2">
        <select value={kind} onChange={(e) => setKind(e.target.value)} className="rounded-xl border border-line bg-white px-3 py-2 text-sm">
          <option value="all">All categories</option>
          {kinds.map((k) => (
            <option key={k} value={k}>
              {findingLabel[k as FindingKind]}
            </option>
          ))}
        </select>
        <select value={certainty} onChange={(e) => setCertainty(e.target.value)} className="rounded-xl border border-line bg-white px-3 py-2 text-sm">
          <option value="all">All certainty</option>
          {(['confirmed', 'potential', 'unassessed'] as Certainty[]).map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        <label className="flex items-center gap-2 rounded-xl border border-line bg-white px-3 py-2 text-sm">
          Min risk
          <input type="range" min={0} max={100} value={minRisk} onChange={(e) => setMinRisk(Number(e.target.value))} />
          <span className="font-mono">{minRisk}</span>
        </label>
      </div>

      {rows.length === 0 ? (
        <EmptyState title="No findings for these filters" body="Relax the filters or ingest a new pack." />
      ) : (
        <div className="overflow-x-auto rounded-2xl border border-line bg-white">
          <table className="w-full min-w-[960px] text-left text-sm">
            <thead className="bg-mist text-xs uppercase tracking-wide text-mute">
              <tr>
                <th className="px-4 py-3">Finding</th>
                <th className="px-4 py-3">Claim</th>
                <th className="px-4 py-3">Engine</th>
                <th className="px-4 py-3">Certainty</th>
                <th className="px-4 py-3">Severity</th>
                <th className="px-4 py-3">Amount</th>
                <th className="px-4 py-3">Queue</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ claim, finding }) => (
                <tr key={finding.id} className="border-t border-line align-top">
                  <td className="px-4 py-3">
                    <p className="font-medium">{finding.title}</p>
                    <p className="mt-1 max-w-md text-xs text-mute">{finding.explanation}</p>
                  </td>
                  <td className="px-4 py-3">
                    <Link className="font-medium hover:text-brand-dark" to={`/claims/${claim.id}`}>
                      {claim.id}
                    </Link>
                    <p className="text-xs text-mute">{claim.claimant}</p>
                  </td>
                  <td className="px-4 py-3 font-mono text-xs">{finding.engine}</td>
                  <td className="px-4 py-3 text-xs">{finding.certainty}</td>
                  <td className="px-4 py-3">
                    <SeverityBadge severity={finding.severity} />
                  </td>
                  <td className="px-4 py-3 font-mono">{finding.leakageAmount ? inr(finding.leakageAmount) : '—'}</td>
                  <td className="px-4 py-3">
                    <QueueBadge queue={claim.queue} />
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
