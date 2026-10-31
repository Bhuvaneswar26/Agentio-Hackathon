import { Scatter, ScatterChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis, ZAxis } from 'recharts'
import { EmptyState, PageHeader, Panel, RiskPill } from '../components/ui'
import { inr, palette, pct } from '../lib/format'
import { useAppStore } from '../store/useAppStore'

export function Providers() {
  const claims = useAppStore((s) => s.claims)
  const names = [...new Set(claims.map((c) => c.provider).filter(Boolean))]
  const live = names.map((name) => {
    const subset = claims.filter((c) => c.provider === name)
    const flagged = subset.filter((c) => ['flagged', 'confirmed', 'special'].includes(c.queue)).length
    const billed = subset.reduce((s, c) => s + c.requestedAmount, 0)
    return {
      name,
      claims: subset.length,
      billed,
      flaggedShare: subset.length ? flagged / subset.length : 0,
      risk: subset.length ? Math.round(subset.reduce((s, c) => s + c.riskScore, 0) / subset.length) : 0,
    }
  })

  return (
    <div>
      <PageHeader
        eyebrow="Network"
        title="Provider intelligence"
        description="Compare billed volume against flagged share. Outliers are unusual billing patterns, not automatic fraud conclusions."
      />
      {live.length === 0 ? (
        <EmptyState title="No providers yet" body="Providers appear here once you ingest a claim pack." />
      ) : (
      <>
      <Panel title="Volume vs flagged ratio">
        <div className="h-80">
          <ResponsiveContainer>
            <ScatterChart>
              <CartesianGrid stroke="#e6eee9" />
              <XAxis dataKey="billed" name="Billed" tickFormatter={(v) => `${Math.round(Number(v) / 1000)}k`} />
              <YAxis dataKey="flaggedShare" name="Flagged" tickFormatter={(v) => `${Math.round(Number(v) * 100)}%`} />
              <ZAxis dataKey="claims" range={[60, 220]} />
              <Tooltip
                formatter={(value, name) => {
                  if (name === 'Billed') return inr(Number(value))
                  if (name === 'Flagged') return pct(Number(value))
                  return String(value)
                }}
              />
              <Scatter data={live} fill={palette.flagged} />
            </ScatterChart>
          </ResponsiveContainer>
        </div>
      </Panel>
      <div className="mt-4 overflow-x-auto rounded-2xl border border-line bg-white">
        <table className="w-full min-w-[800px] text-left text-sm">
          <thead className="bg-mist text-xs uppercase tracking-wide text-mute">
            <tr>
              <th className="px-4 py-3">Provider</th>
              <th className="px-4 py-3">Claims</th>
              <th className="px-4 py-3">Billed</th>
              <th className="px-4 py-3">Flagged share</th>
              <th className="px-4 py-3">Avg risk</th>
            </tr>
          </thead>
          <tbody>
            {live
              .sort((a, b) => b.risk - a.risk)
              .map((p) => (
                <tr key={p.name} className="border-t border-line transition-colors hover:bg-mist/60">
                  <td className="px-4 py-3 font-medium">{p.name}</td>
                  <td className="px-4 py-3 font-mono">{p.claims}</td>
                  <td className="px-4 py-3 font-mono">{inr(p.billed)}</td>
                  <td className={`px-4 py-3 font-mono ${p.flaggedShare > 0.5 ? 'font-semibold text-red-700' : p.flaggedShare > 0.25 ? 'text-amber-700' : ''}`}>{pct(p.flaggedShare)}</td>
                  <td className="px-4 py-3">{p.claims ? <RiskPill score={p.risk} /> : <span className="text-mute">—</span>}</td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>
      </>
      )}
    </div>
  )
}
