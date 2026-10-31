import type {
  Claim,
  ClaimQueue,
  DetectionPayload,
  Finding,
  InvoiceLine,
} from "../types";
import { uid } from "./format";

const ROOM = /room rent|deluxe room|ward|icu/i;
const PHYSIO = /physio|rehabilitation|session/i;

function lineKey(line: InvoiceLine) {
  return `${(line.code || line.description).toLowerCase().replace(/\s+/g, "")}|${line.amount}`;
}

function explicitExclusion(
  line: InvoiceLine,
  rules: DetectionPayload["policy"]["rules"],
) {
  const lineWords =
    `${line.description} ${line.code}`.toLowerCase().match(/[a-z]{4,}/g) ?? [];
  return rules.find((rule) => {
    if (rule.type !== "exclusion") return false;
    const ruleWords =
      `${rule.name} ${rule.clause}`.toLowerCase().match(/[a-z]{4,}/g) ?? [];
    return lineWords.some((word) =>
      ruleWords.some(
        (candidate) => candidate.startsWith(word) || word.startsWith(candidate),
      ),
    );
  });
}

function explicitDailyLimit(
  line: InvoiceLine,
  rules: DetectionPayload["policy"]["rules"],
) {
  if (!ROOM.test(line.description)) return undefined;
  return rules.find(
    (rule) =>
      ["limit", "sublimit"].includes(rule.type) &&
      /(room|icu|ward)/i.test(`${rule.name} ${rule.clause}`) &&
      /day|daily/i.test(`${rule.unit ?? ""} ${rule.clause}`) &&
      Number.isFinite(rule.value),
  );
}

export type PreviewResult = {
  findings: Finding[];
  expectedSettlement: number;
  confirmedLeakage: number;
  potentialLeakage: number;
  riskScore: number;
  queue: ClaimQueue;
  relatedClaimIds: string[];
};

export function runPreviewDetection(
  payload: DetectionPayload,
  existing: Claim[],
): PreviewResult {
  const findings: Finding[] = [];
  const lines = payload.invoiceLines;
  const requested =
    payload.claim.requestedAmount ??
    lines.reduce((s, l) => s + (l.amount || 0), 0);
  const relatedClaimIds: string[] = [];

  if (payload.extraction.missingFields.length && lines.length === 0) {
    findings.push({
      id: uid("F"),
      kind: "insufficient_evidence",
      title: "Cannot assess — incomplete pack",
      explanation:
        "Mandatory fields or line items are missing. No leakage amount was invented.",
      evidence: payload.extraction.missingFields,
      invoiceLineIds: [],
      certainty: "unassessed",
      severity: "medium",
      leakageAmount: 0,
      engine: "ocr",
    });
    return {
      findings,
      expectedSettlement: 0,
      confirmedLeakage: 0,
      potentialLeakage: 0,
      riskScore: 38,
      queue: "unassessed",
      relatedClaimIds,
    };
  }

  const seen = new Map<string, InvoiceLine>();
  for (const line of lines) {
    const key = lineKey(line);
    const prior = seen.get(key);
    if (prior && line.amount > 0) {
      findings.push({
        id: uid("F"),
        kind: "duplicate_line",
        title: `Duplicate line: ${line.description}`,
        explanation: `The same code/amount appears more than once on this invoice. Verify that this is not a legitimate repeat service before payment.`,
        evidence: [prior.id, line.id, line.invoiceRef].filter(Boolean),
        invoiceLineIds: [prior.id, line.id],
        certainty: "potential",
        severity: line.amount > 10000 ? "high" : "medium",
        leakageAmount: line.amount,
        engine: "duplicate",
      });
    } else {
      seen.set(key, line);
    }
  }

  for (const line of lines) {
    const exclusion = explicitExclusion(line, payload.policy.rules);
    if (exclusion) {
      findings.push({
        id: uid("F"),
        kind: "exclusion",
        title: "Excluded consumable billed",
        explanation: `${line.description} appears to match the supplied exclusion “${exclusion.name}”. Verify the clause and item before deciding coverage.`,
        evidence: [line.id, exclusion.clause || exclusion.name],
        invoiceLineIds: [line.id],
        policyClause: "PR-EXC",
        certainty: "potential",
        severity: "medium",
        leakageAmount: line.amount,
        engine: "rules",
      });
    }
    const limitRule = explicitDailyLimit(line, payload.policy.rules);
    if (limitRule?.value !== undefined) {
      const qty = line.quantity || 1;
      const perDay = line.unitPrice || line.amount / qty;
      const limit = limitRule.value;
      const excess = Math.max(0, (perDay - limit) * qty);
      if (excess > 0) {
        findings.push({
          id: uid("F"),
          kind: "limit_breach",
          title: "Room / ICU charge exceeds daily sub-limit",
          explanation: `Provisional calculation: ₹${perDay.toLocaleString("en-IN")} × ${qty} against the supplied limit of ₹${limit.toLocaleString("en-IN")}. Confirm the clause application in the detection engine.`,
          evidence: [line.id, limitRule.clause || limitRule.name],
          invoiceLineIds: [line.id],
          policyClause: "PR-ROOM",
          certainty: "potential",
          severity: "high",
          leakageAmount: excess,
          engine: "rules",
        });
      }
    }
  }

  const invoiceRefs = [
    ...new Set(lines.map((l) => l.invoiceRef).filter(Boolean)),
  ];
  for (const other of existing) {
    const otherInvoices = new Set(
      other.lines.map((l) => l.invoiceRef).filter(Boolean),
    );
    const hit = invoiceRefs.find((ref) => otherInvoices.has(ref));
    const samePersonSameDay =
      payload.claim.claimant &&
      other.claimant === payload.claim.claimant &&
      other.incidentDate === payload.claim.incidentDate &&
      other.id !== payload.claim.claimId;
    if (hit || samePersonSameDay) {
      relatedClaimIds.push(other.id);
      findings.push({
        id: uid("F"),
        kind: hit ? "exact_duplicate" : "near_duplicate",
        title: hit
          ? `Invoice ${hit} already on ${other.id}`
          : `Same claimant and incident date as ${other.id}`,
        explanation: hit
          ? "Exact invoice reference already exists on the desk. Verify the prior claim and payment before treating this as duplicate leakage."
          : PHYSIO.test(payload.claim.claimType || "") ||
              PHYSIO.test(lines[0]?.description || "")
            ? "Looks similar to a prior claim. If this is a prescribed repeat session, keep it as a legitimate lookalike rather than a decline."
            : "Near-duplicate attributes. Review before payout.",
        evidence: [
          other.id,
          hit || `${payload.claim.claimant} ${payload.claim.incidentDate}`,
        ],
        invoiceLineIds: [],
        certainty: "potential",
        severity: hit ? "critical" : "medium",
        leakageAmount: hit ? requested : 0,
        engine: "duplicate",
      });
    }
  }

  const deductible = payload.policy.deductible ?? 0;
  const copay = payload.policy.copayPercent ?? 0;
  const confirmedLeakage = 0;
  const duplicateWhole = findings.some((f) => f.kind === "exact_duplicate");
  const admissible = duplicateWhole
    ? 0
    : Math.max(0, requested - confirmedLeakage);
  const afterDeductible = Math.max(0, admissible - deductible);
  const expectedSettlement = Math.round(afterDeductible * (1 - copay / 100));
  const settlementGap = Math.max(
    0,
    (payload.claim.proposedSettlement ?? requested) - expectedSettlement,
  );

  if (deductible || copay) {
    findings.push({
      id: uid("F"),
      kind: "settlement_error",
      title: "Recalculated settlement vs proposed",
      explanation: `Admissible ₹${admissible.toLocaleString("en-IN")} minus deductible ₹${deductible.toLocaleString("en-IN")} then ${copay}% co-pay → expected ₹${expectedSettlement.toLocaleString("en-IN")}. Gap ₹${settlementGap.toLocaleString("en-IN")} is potential until a handler confirms.`,
      evidence: ["Deterministic settlement engine — not an LLM"],
      invoiceLineIds: [],
      certainty: "potential",
      severity: settlementGap > 20000 ? "high" : "medium",
      leakageAmount: settlementGap,
      engine: "rules",
    });
  }

  const potentialLines = new Map<string, number>();
  let potentialLeakage = duplicateWhole ? requested : 0;
  if (!duplicateWhole) {
    for (const finding of findings) {
      if (
        finding.kind === "settlement_error" ||
        finding.kind === "exact_duplicate"
      )
        continue;
      for (const lineId of finding.invoiceLineIds) {
        potentialLines.set(
          lineId,
          Math.max(potentialLines.get(lineId) ?? 0, finding.leakageAmount),
        );
      }
    }
    potentialLeakage = [...potentialLines.values()].reduce(
      (sum, amount) => sum + amount,
      0,
    );
    if (potentialLeakage === 0) {
      potentialLeakage =
        findings.find((finding) => finding.kind === "settlement_error")
          ?.leakageAmount ?? 0;
    }
  }
  const confirmedTotal = 0;
  const lookalikeOnly =
    findings.length > 0 &&
    findings.every(
      (f) =>
        f.kind === "legitimate_repeat" ||
        (f.kind === "near_duplicate" && f.leakageAmount === 0),
    );
  const queue: ClaimQueue = findings.some(
    (f) => f.kind === "insufficient_evidence",
  )
    ? "unassessed"
    : confirmedTotal > 0
      ? "flagged"
      : lookalikeOnly || findings.length === 0
        ? "good"
        : "flagged";

  const riskScore = Math.min(
    99,
    12 +
      findings.length * 14 +
      Math.round(confirmedTotal / 4000) +
      (duplicateWhole ? 20 : 0),
  );

  return {
    findings,
    expectedSettlement,
    confirmedLeakage: confirmedTotal,
    potentialLeakage,
    riskScore,
    queue,
    relatedClaimIds: [...new Set(relatedClaimIds)],
  };
}
