import type { Claim, DetectionPayload } from "../types";
import { runPreviewDetection } from "./detectPreview";
import { uid } from "./format";

/** Turns an intake payload into a desk claim, scored by the local preview detection. */
export function payloadToClaim(payload: DetectionPayload, existing: Claim[]): Claim {
  const requested =
    payload.claim.requestedAmount ??
    payload.invoiceLines.reduce((s, l) => s + (l.amount || 0), 0);
  const domain =
    (["Health", "Motor", "General"] as const).find(
      (d) => d === payload.claim.domain,
    ) ?? "Health";
  const preview = runPreviewDetection(payload, existing);
  return {
    id: payload.claim.claimId || uid("CLM"),
    policyNumber: payload.claim.policyNumber || "UNKNOWN",
    claimant: payload.claim.claimant || "Unknown claimant",
    incidentDate: payload.claim.incidentDate || payload.ingestedAt.slice(0, 10),
    filedDate: payload.claim.filedDate || payload.ingestedAt.slice(0, 10),
    domain,
    claimType: payload.claim.claimType || "Submitted pack",
    requestedAmount: requested || 0,
    proposedSettlement: payload.claim.proposedSettlement || requested || 0,
    expectedSettlement: preview.expectedSettlement,
    confirmedLeakage: preview.confirmedLeakage,
    potentialLeakage: preview.potentialLeakage,
    provider: payload.claim.provider || "Unknown provider",
    city: payload.claim.city || "—",
    queue: preview.queue,
    riskScore: preview.riskScore,
    findings: preview.findings,
    lines: payload.invoiceLines,
    policyRules: payload.policy.rules,
    missingFields: payload.extraction.missingFields,
    relatedClaimIds: preview.relatedClaimIds,
    sourceFormat: payload.source.format,
    extractionConfidence: payload.source.confidence,
    notes:
      "Local preview detection ran on ingest. Replace with the sister-project agent when it responds.",
  };
}
