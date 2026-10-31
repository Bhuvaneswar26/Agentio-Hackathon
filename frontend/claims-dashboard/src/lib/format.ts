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

export const severityTone: Record<Severity, string> = {
  low: 'bg-mist text-mute',
  medium: 'bg-[#eef8f2] text-[#1a6b4a]',
  high: 'bg-black text-white',
  critical: 'bg-brand text-ink',
}

export function uid(prefix = 'id') {
  return `${prefix}-${Math.random().toString(36).slice(2, 9)}`
}
