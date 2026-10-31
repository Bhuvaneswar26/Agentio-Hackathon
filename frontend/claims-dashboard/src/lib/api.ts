import type { Claim, ClaimQueue, Role } from '../types'

/** Backend origin derived from the configured detect URL, e.g. http://localhost:8000 */
export function backendOrigin(agentUrl: string): string {
  try {
    return new URL(agentUrl).origin
  } catch {
    return ''
  }
}

export const DEFAULT_AGENT_URL = import.meta.env.VITE_AGENT_URL ?? 'http://localhost:8000/v1/detect'

/** Mirror supervisor decisions on the desk back to the ClaimsGuard engine's review/audit trail (best effort). */
export async function syncReview(agentUrl: string, claim: Claim, queue: ClaimQueue, role: Role, note?: string) {
  if (!claim.analysisId || (queue !== 'confirmed' && queue !== 'dismissed')) return
  const origin = backendOrigin(agentUrl)
  if (!origin) return
  const action = queue === 'confirmed' ? 'CONFIRM' : 'DISMISS'
  await Promise.allSettled(
    claim.findings
      .filter((f) => f.backendId)
      .map((f) =>
        fetch(`${origin}/api/v1/findings/${encodeURIComponent(f.backendId!)}/review`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action, reviewer: role, notes: note }),
        }),
      ),
  )
}
