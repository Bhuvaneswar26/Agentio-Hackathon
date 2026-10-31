import type { ClaimQueue, FindingKind, Severity } from '../types'

export function inr(n: number) {
  return `₹${Math.round(n).toLocaleString('en-IN')}`
}

export function pct(n: number, digits = 1) {
  return `${(n * 100).toFixed(digits)}%`
}

export function formatDate(iso: string) {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleDateString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  })
}

export const queueLabel: Record<ClaimQueue, string> = {
  intake: 'Intake',
  good: 'Good claim',
  flagged: 'Flagged',
  unassessed: 'Needs evidence',
  special: 'Special review',
  confirmed: 'Confirmed leakage',
  dismissed: 'Dismissed',
}

export const findingLabel: Record<FindingKind, string> = {
  exact_duplicate: 'Exact duplicate',
  near_duplicate: 'Near duplicate',
  duplicate_line: 'Duplicate line item',
  limit_breach: 'Policy limit breach',
  exclusion: 'Excluded service',
  settlement_error: 'Settlement error',
  provider_anomaly: 'Unusual billing',
  related_party: 'Related-party pattern',
  insufficient_evidence: 'Incomplete evidence',
  legitimate_repeat: 'Legitimate repeat',
  fraud_signal: 'Fraud signal',
}

/**
 * Semantic colours. Green means a good outcome only; red is reserved for the worst outcomes
 * (critical findings, confirmed leakage, high risk). Never reuse the brand green for a warning.
 */
export const palette = {
  good: '#10b981',
  danger: '#dc2626',
  flagged: '#f97316',
  warn: '#f59e0b',
  special: '#8b5cf6',
  info: '#0ea5e9',
  neutral: '#94a3b8',
} as const

export const severityTone: Record<Severity, string> = {
  low: 'bg-sky-100 text-sky-800',
  medium: 'bg-amber-100 text-amber-800',
  high: 'bg-orange-100 text-orange-800 ring-1 ring-inset ring-orange-300',
  critical: 'bg-red-600 text-white',
}

export const severityDot: Record<Severity, string> = {
  low: 'bg-sky-500',
  medium: 'bg-amber-500',
  high: 'bg-orange-500',
  critical: 'bg-red-600',
}

/** Left-edge accent for a finding card, so severity reads before the text does. */
export const severityBorder: Record<Severity, string> = {
  low: 'border-l-sky-400',
  medium: 'border-l-amber-400',
  high: 'border-l-orange-500',
  critical: 'border-l-red-600',
}

export const severityOrder: Severity[] = ['critical', 'high', 'medium', 'low']

export function riskTone(score: number) {
  if (score > 70) return 'bg-red-100 text-red-700'
  if (score > 40) return 'bg-amber-100 text-amber-800'
  return 'bg-emerald-100 text-emerald-700'
}

export function uid(prefix = 'id') {
  return `${prefix}-${Math.random().toString(36).slice(2, 9)}`
}
