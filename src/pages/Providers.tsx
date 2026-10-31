import { Scatter, ScatterChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis, ZAxis } from 'recharts'
import { PageHeader, Panel } from '../components/ui'
import { inr, pct } from '../lib/format'
import { seedProviders, useAppStore } from '../store/useAppStore'

export function Providers() {
  const claims = useAppStore((s) => s.claims)
  const names = seedProviders.map((p) => p.name)
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
              <Scatter data={live} fill="#2dd891" />
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
                <tr key={p.name} className="border-t border-line">
                  <td className="px-4 py-3 font-medium">{p.name}</td>
                  <td className="px-4 py-3 font-mono">{p.claims}</td>
                  <td className="px-4 py-3 font-mono">{inr(p.billed)}</td>
                  <td className="px-4 py-3 font-mono">{pct(p.flaggedShare)}</td>
                  <td className="px-4 py-3 font-mono">{p.risk}</td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
