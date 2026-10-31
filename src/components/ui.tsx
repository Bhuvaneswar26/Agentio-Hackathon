import type { ReactNode } from 'react'
import { queueLabel, severityTone } from '../lib/format'
import type { ClaimQueue, Severity } from '../types'

export function KpiCard({
  label,
  value,
  hint,
  accent = false,
}: {
  label: string
  value: string
  hint?: string
  accent?: boolean
}) {
  return (
    <div
      className={`rounded-2xl border p-4 ${
        accent ? 'border-brand bg-brand text-ink' : 'border-line bg-white'
      }`}
    >
      <p className={`text-xs font-medium uppercase tracking-wide ${accent ? 'text-ink/70' : 'text-mute'}`}>
        {label}
      </p>
      <p className="mt-2 font-mono text-2xl font-semibold tracking-tight">{value}</p>
      {hint ? <p className={`mt-1 text-xs ${accent ? 'text-ink/70' : 'text-mute'}`}>{hint}</p> : null}
    </div>
  )
}

export function QueueBadge({ queue }: { queue: ClaimQueue }) {
  const map: Record<ClaimQueue, string> = {
    intake: 'bg-mist text-ink',
    good: 'bg-brand/20 text-[#0b6b45]',
    flagged: 'bg-ink text-white',
    unassessed: 'bg-white border border-line text-mute',
    special: 'bg-brand text-ink',
    confirmed: 'bg-[#111] text-brand',
    dismissed: 'bg-mist text-mute',
  }
  return (
    <span className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium ${map[queue]}`}>
      {queueLabel[queue]}
    </span>
  )
}

export function SeverityBadge({ severity }: { severity: Severity }) {
  return (
    <span className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium ${severityTone[severity]}`}>
      {severity}
    </span>
  )
}

export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow: string
  title: string
  description: string
  actions?: ReactNode
}) {
  return (
    <div className="mb-6 flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
      <div>
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-brand-dark">{eyebrow}</p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight text-ink md:text-3xl">{title}</h1>
        <p className="mt-1 max-w-2xl text-sm text-mute">{description}</p>
      </div>
      {actions}
    </div>
  )
}

export function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <div className="rounded-2xl border border-dashed border-line bg-white px-6 py-16 text-center">
      <p className="font-medium text-ink">{title}</p>
      <p className="mt-1 text-sm text-mute">{body}</p>
    </div>
  )
}

export function Panel({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return (
    <section className="rounded-2xl border border-line bg-white p-4 md:p-5">
      <div className="mb-4 flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-ink">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  )
}
