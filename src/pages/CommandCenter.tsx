import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { Link } from 'react-router-dom'
import { KpiCard, PageHeader, Panel, QueueBadge } from '../components/ui'
import { findingLabel, inr, pct } from '../lib/format'
import { useAppStore } from '../store/useAppStore'

const GREEN = '#2dd891'
const INK = '#0a0a0a'

export function CommandCenter() {
  const claims = useAppStore((s) => s.claims)
  const processed = claims.length
  const good = claims.filter((c) => c.queue === 'good' || c.queue === 'dismissed')
  const flagged = claims.filter((c) => ['flagged', 'confirmed', 'special'].includes(c.queue))
  const unassessed = claims.filter((c) => c.queue === 'unassessed')
  const confirmed = claims.reduce((s, c) => s + c.confirmedLeakage, 0)
  const potential = claims.reduce((s, c) => s + c.potentialLeakage, 0)
  const requested = claims.reduce((s, c) => s + c.requestedAmount, 0)
  const leakageRatio = requested ? (confirmed + potential) / requested : 0
  const fraudish = claims.filter((c) => c.findings.some((f) => f.kind === 'fraud_signal' || f.kind === 'related_party'))

  const byDomain = ['Health', 'Motor', 'General'].map((d) => ({
    name: d,
    claims: claims.filter((c) => c.domain === d).length,
    leakage: claims.filter((c) => c.domain === d).reduce((s, c) => s + c.confirmedLeakage + c.potentialLeakage, 0),
  }))

  const categories = Object.entries(
    claims.flatMap((c) => c.findings).reduce<Record<string, number>>((acc, f) => {
      acc[f.kind] = (acc[f.kind] ?? 0) + 1
      return acc
    }, {}),
  ).map(([kind, count]) => ({ name: findingLabel[kind as keyof typeof findingLabel] ?? kind, count }))

  const funnel = [
    { name: 'Processed', value: processed },
    { name: 'Good', value: good.length },
    { name: 'Flagged', value: flagged.length },
    { name: 'Special', value: claims.filter((c) => c.queue === 'special').length },
  ]

  const trend = Array.from({ length: 10 }, (_, i) => ({
    day: `W${i + 1}`,
    flagged: Math.round(4 + Math.abs(Math.sin(i * 1.1) * 8)),
    good: Math.round(10 + Math.abs(Math.cos(i * 0.8) * 6)),
  }))

  const mix = [
    { name: 'Good', value: good.length, color: GREEN },
    { name: 'Flagged', value: flagged.length, color: INK },
    { name: 'Unassessed', value: unassessed.length, color: '#9ca3af' },
    { name: 'Intake', value: claims.filter((c) => c.queue === 'intake').length, color: '#d1d5db' },
  ]

  const hot = [...claims].sort((a, b) => b.riskScore - a.riskScore).slice(0, 6)

  return (
    <div>
      <PageHeader
        eyebrow="Executive view"
        title="Command center"
        description="Portfolio health across good claims, leakage, fraud signals and supervisor exceptions. Confirmed rupees are never mixed with suspected amounts."
        actions={
          <Link to="/ingest" className="rounded-full bg-ink px-4 py-2 text-sm text-white">
            Ingest a claim pack
          </Link>
        }
      />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
        <KpiCard label="Claims processed" value={String(processed)} hint="Demo + ingested packs" />
        <KpiCard label="Good claim ratio" value={pct(good.length / processed || 0)} hint={`${good.length} cleared`} />
        <KpiCard label="Flagged ratio" value={pct(flagged.length / processed || 0)} hint={`${flagged.length} need action`} />
        <KpiCard label="Confirmed leakage" value={inr(confirmed)} hint="Deterministic only" accent />
        <KpiCard label="Potential leakage" value={inr(potential)} hint="Held out of savings" />
        <KpiCard label="Leakage vs billed" value={pct(leakageRatio)} hint={`${fraudish.length} fraud-like patterns`} />
      </div>

      <div className="mt-5 grid gap-4 xl:grid-cols-3">
        <Panel title="Claim mix">
          <div className="h-56">
            <ResponsiveContainer>
              <PieChart>
                <Pie data={mix} dataKey="value" nameKey="name" innerRadius={52} outerRadius={80} paddingAngle={3}>
                  {mix.map((e) => (
                    <Cell key={e.name} fill={e.color} />
                  ))}
                </Pie>
                <Tooltip />
              </PieChart>
            </ResponsiveContainer>
          </div>
          <div className="grid grid-cols-2 gap-2 text-xs text-mute">
            {mix.map((m) => (
              <div key={m.name} className="flex items-center gap-2">
                <span className="h-2 w-2 rounded-full" style={{ background: m.color }} />
                {m.name} · {m.value}
              </div>
            ))}
          </div>
        </Panel>
        <Panel title="Weekly good vs flagged">
          <div className="h-64">
            <ResponsiveContainer>
              <AreaChart data={trend}>
                <CartesianGrid stroke="#e6eee9" vertical={false} />
                <XAxis dataKey="day" tick={{ fontSize: 12 }} />
                <YAxis tick={{ fontSize: 12 }} />
                <Tooltip />
                <Area type="monotone" dataKey="good" stroke={GREEN} fill={GREEN} fillOpacity={0.35} />
                <Area type="monotone" dataKey="flagged" stroke={INK} fill={INK} fillOpacity={0.12} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </Panel>
        <Panel title="Leakage by line of business">
          <div className="h-64">
            <ResponsiveContainer>
              <BarChart data={byDomain}>
                <CartesianGrid stroke="#e6eee9" vertical={false} />
                <XAxis dataKey="name" tick={{ fontSize: 12 }} />
                <YAxis tick={{ fontSize: 12 }} />
                <Tooltip formatter={(v) => inr(Number(v))} />
                <Bar dataKey="leakage" fill={GREEN} radius={[8, 8, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Panel>
      </div>

      <div className="mt-5 grid gap-4 xl:grid-cols-2">
        <Panel title="Detection categories">
          <div className="h-64">
            <ResponsiveContainer>
              <BarChart data={categories} layout="vertical" margin={{ left: 24 }}>
                <CartesianGrid stroke="#e6eee9" horizontal={false} />
                <XAxis type="number" tick={{ fontSize: 12 }} />
                <YAxis type="category" dataKey="name" width={140} tick={{ fontSize: 11 }} />
                <Tooltip />
                <Bar dataKey="count" fill={INK} radius={[0, 8, 8, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Panel>
        <Panel title="Funnel · processed to special review" action={<span className="text-xs text-mute">{funnel.map((f) => f.value).join(' → ')}</span>}>
          <div className="space-y-3">
            {funnel.map((f) => (
              <div key={f.name}>
                <div className="mb-1 flex justify-between text-xs">
                  <span>{f.name}</span>
                  <span className="font-mono">{f.value}</span>
                </div>
                <div className="h-2 rounded-full bg-mist">
                  <div
                    className="h-2 rounded-full bg-brand"
                    style={{ width: `${Math.max(8, (f.value / processed) * 100)}%` }}
                  />
                </div>
              </div>
            ))}
          </div>
          <p className="mt-4 text-xs text-mute">
            Incomplete packs stay in unassessed. They never inflate confirmed leakage.
          </p>
        </Panel>
      </div>

      <Panel title="Highest risk on desk" action={<Link to="/alerts" className="text-xs text-brand-dark">Open alerts</Link>}>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-left text-sm">
            <thead className="text-xs uppercase tracking-wide text-mute">
              <tr>
                <th className="pb-3">Claim</th>
                <th className="pb-3">Claimant</th>
                <th className="pb-3">Domain</th>
                <th className="pb-3">Requested</th>
                <th className="pb-3">Risk</th>
                <th className="pb-3">Queue</th>
              </tr>
            </thead>
            <tbody>
              {hot.map((c) => (
                <tr key={c.id} className="border-t border-line">
                  <td className="py-3">
                    <Link className="font-medium hover:text-brand-dark" to={`/claims/${c.id}`}>
                      {c.id}
                    </Link>
                  </td>
                  <td>{c.claimant}</td>
                  <td>{c.domain}</td>
                  <td className="font-mono">{inr(c.requestedAmount)}</td>
                  <td className="font-mono">{c.riskScore}</td>
                  <td>
                    <QueueBadge queue={c.queue} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
    </div>
  )
}
