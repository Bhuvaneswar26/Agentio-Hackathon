import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { allSeedClaims, seedAudit, seedProviders } from '../data/seed'
import { runPreviewDetection } from '../lib/detectPreview'
import { DEFAULT_AGENT_URL, syncReview } from '../lib/api'
import { uid } from '../lib/format'
import type { ExtractedPolicy } from '../lib/policyRag'
import type { AuditEvent, Claim, ClaimQueue, DetectionPayload, IngestJob, Role } from '../types'

type Filters = {
  domain: string
  queue: string
  search: string
}

type AppState = {
  role: Role
  agentUrl: string
  claims: Claim[]
  audit: AuditEvent[]
  jobs: IngestJob[]
  /** Terms read out of a policy document by the engine's RAG pipeline, ready to apply to an ingest. */
  policyFromDocument: { policy: ExtractedPolicy; sourceName: string; at: string } | null
  filters: Filters
  setRole: (role: Role) => void
  setAgentUrl: (url: string) => void
  setPolicyFromDocument: (entry: { policy: ExtractedPolicy; sourceName: string } | null) => void
  setFilters: (partial: Partial<Filters>) => void
  addJob: (job: IngestJob) => void
  updateJob: (id: string, patch: Partial<IngestJob>) => void
  ingestPayloadAsClaim: (payload: DetectionPayload) => string
  addAgentClaim: (claim: Claim) => string
  moveQueue: (claimId: string, queue: ClaimQueue, reason?: string) => void
  addNote: (claimId: string, note: string) => void
  log: (event: Omit<AuditEvent, 'id' | 'at'>) => void
  resetDemo: () => void
}

function payloadToClaim(payload: DetectionPayload, existing: Claim[]): Claim {
  const requested = payload.claim.requestedAmount
    ?? payload.invoiceLines.reduce((s, l) => s + (l.amount || 0), 0)
  const domain = (['Health', 'Motor', 'General'] as const).find((d) => d === payload.claim.domain) ?? 'Health'
  const preview = runPreviewDetection(payload, existing)
  return {
    id: payload.claim.claimId || uid('CLM'),
    policyNumber: payload.claim.policyNumber || 'UNKNOWN',
    claimant: payload.claim.claimant || 'Unknown claimant',
    incidentDate: payload.claim.incidentDate || payload.ingestedAt.slice(0, 10),
    filedDate: payload.claim.filedDate || payload.ingestedAt.slice(0, 10),
    domain,
    claimType: payload.claim.claimType || 'Submitted pack',
    requestedAmount: requested || 0,
    proposedSettlement: payload.claim.proposedSettlement || requested || 0,
    expectedSettlement: preview.expectedSettlement,
    confirmedLeakage: preview.confirmedLeakage,
    potentialLeakage: preview.potentialLeakage,
    provider: payload.claim.provider || 'Unknown provider',
    city: payload.claim.city || '—',
    queue: preview.queue,
    riskScore: preview.riskScore,
    findings: preview.findings,
    lines: payload.invoiceLines,
    policyRules: payload.policy.rules,
    missingFields: payload.extraction.missingFields,
    relatedClaimIds: preview.relatedClaimIds,
    sourceFormat: payload.source.format,
    extractionConfidence: payload.source.confidence,
    notes: 'Local preview detection ran on ingest. Replace with the sister-project agent when it responds.',
  }
}

export const useAppStore = create<AppState>()(
  persist(
    (set, get) => ({
      role: 'handler',
      agentUrl: DEFAULT_AGENT_URL,
      claims: allSeedClaims,
      audit: seedAudit,
      jobs: [],
      policyFromDocument: null,
      filters: { domain: 'all', queue: 'all', search: '' },
      setRole: (role) => set({ role }),
      setAgentUrl: (agentUrl) => set({ agentUrl }),
      setPolicyFromDocument: (entry) =>
        set({ policyFromDocument: entry ? { ...entry, at: new Date().toISOString() } : null }),
      setFilters: (partial) => set({ filters: { ...get().filters, ...partial } }),
      addJob: (job) => set({ jobs: [job, ...get().jobs].slice(0, 20) }),
      updateJob: (id, patch) =>
        set({ jobs: get().jobs.map((j) => (j.id === id ? { ...j, ...patch } : j)) }),
      ingestPayloadAsClaim: (payload) => {
        const claim = payloadToClaim(payload, get().claims)
        const existing = get().claims.find((c) => c.id === claim.id)
        if (existing) claim.id = `${claim.id}-${uid('R').slice(-4)}`
        set({ claims: [claim, ...get().claims] })
        get().log({
          actor: 'Preview detection',
          action: 'Claim pack ingested and scored',
          detail: `${claim.id} · ${claim.findings.length} findings · queue ${claim.queue} · ${payload.source.engine}`,
          claimId: claim.id,
        })
        return claim.id
      },
      addAgentClaim: (incoming) => {
        const claim = { ...incoming }
        if (get().claims.some((c) => c.id === claim.id)) claim.id = `${claim.id}-${uid('R').slice(-4)}`
        set({ claims: [claim, ...get().claims] })
        get().log({
          actor: 'ClaimsGuard engine',
          action: 'Claim analysed by detection engine',
          detail: `${claim.id} · ${claim.findings.length} findings · queue ${claim.queue} · risk ${claim.riskScore}`,
          claimId: claim.id,
        })
        return claim.id
      },
      moveQueue: (claimId, queue, reason) => {
        const target = get().claims.find((c) => c.id === claimId)
        if (target) void syncReview(get().agentUrl, target, queue, get().role, reason)
        set({
          claims: get().claims.map((c) =>
            c.id === claimId
              ? {
                  ...c,
                  queue,
                  specialReason: queue === 'special' ? reason ?? c.specialReason : c.specialReason,
                }
              : c,
          ),
        })
        get().log({
          actor: get().role === 'supervisor' ? 'Supervisor' : 'Claims handler',
          action: `Moved to ${queue}`,
          detail: reason || `Queue changed to ${queue}`,
          claimId,
        })
      },
      addNote: (claimId, note) => {
        set({
          claims: get().claims.map((c) =>
            c.id === claimId
              ? { ...c, notes: note, supervisorNote: get().role === 'supervisor' ? note : c.supervisorNote }
              : c,
          ),
        })
        get().log({ actor: get().role, action: 'Added review note', detail: note, claimId })
      },
      log: (event) =>
        set({
          audit: [{ id: uid('AUD'), at: new Date().toISOString(), ...event }, ...get().audit].slice(0, 200),
        }),
      resetDemo: () =>
        set({
          claims: allSeedClaims,
          audit: seedAudit,
          jobs: [],
          policyFromDocument: null,
          filters: { domain: 'all', queue: 'all', search: '' },
        }),
    }),
    { name: 'claimsguard-ui-v3', version: 3 },
  ),
)

export { seedProviders }
