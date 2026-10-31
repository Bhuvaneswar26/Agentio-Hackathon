import type {
  Actor,
  Claim,
  Correlation,
  Decision,
  DecisionType,
  Discrepancy,
  EscalationTarget,
  Investigation,
  InvestigationEvent,
  InvestigationEventType,
  Recommendation,
  Severity,
  SettlementCalculation,
  SourceRef,
} from "../types";
import { analyseSettlement } from "./corrections";
import { correlateClaim } from "./correlation";
import { compareDocument } from "./documents";
import { inr, uid } from "./format";

// ------------------------------------------------------------------------------------------ analysis

export type Issue = {
  /** The finding id, discrepancy id, `X:<claim>` for a correlation, or `C:<rec>` for a pure calculation. */
  id: string;
  source: "finding" | "document" | "correlation" | "calculation";
  title: string;
  severity: Severity;
  explanation: string;
  /** Money at stake in this issue. */
  amount: number;
  evidence: Array<{ label: string; source?: SourceRef; claimId?: string }>;
  /** The first recommendation is the one a decision acts on. */
  recommendations: Recommendation[];
};

export type InvestigationAnalysis = {
  correlations: Correlation[];
  discrepancies: Discrepancy[];
  calculation: SettlementCalculation;
  recommendations: Recommendation[];
  issues: Issue[];
  leakage: {
    /** proposed settlement minus corrected settlement. */
    calculated: number;
    /** Payout at risk if the same invoice on another claim turns out to be a duplicate. */
    crossClaimExposure: number;
  };
};

function amountSeverity(amount: number): Severity {
  return amount >= 25000 ? "high" : amount >= 5000 ? "medium" : "low";
}

const FINDING_RECS: Record<string, Recommendation["kind"][]> = {
  duplicate_line: ["remove_duplicate_line"],
  exclusion: ["remove_excluded_item"],
  limit_breach: ["cap_at_sublimit"],
  settlement_error: ["correct_settlement", "apply_deductible", "apply_copay"],
};
/** Whether a recommendation is the correction for this document difference. */
function fixesDiscrepancy(d: Discrepancy, r: Recommendation): boolean {
  if (d.claimLineId === undefined || !r.invoiceLineIds.includes(d.claimLineId)) return false;
  switch (d.kind) {
    case "service_not_in_document":
      return r.kind === "remove_unsupported_line";
    case "line_amount_mismatch":
      return r.kind === "correct_line_amount" && r.id.endsWith(":amount");
    case "stay_length_mismatch":
      return r.kind === "correct_line_amount" && r.id.endsWith(":stay");
    default:
      return false;
  }
}

/**
 * Everything the workspace shows, derived from the claim, its documents and the other claims.
 * Nothing here is stored: it is recomputed, so what the analyst sees always follows the current data.
 */
export function analyseClaim(claim: Claim, all: Claim[]): InvestigationAnalysis {
  const documents = claim.documents ?? [];
  const correlations = correlateClaim(claim, all);
  const discrepancies = documents.flatMap((d) => compareDocument(d, claim));
  const { calculation, recommendations } = analyseSettlement(claim, documents, discrepancies, correlations);

  const used = new Set<string>();
  const take = (predicate: (r: Recommendation) => boolean): Recommendation[] => {
    const found = recommendations.filter((r) => !used.has(r.id) && predicate(r));
    found.forEach((r) => used.add(r.id));
    return found;
  };
  const issues: Issue[] = [];

  for (const f of claim.findings) {
    const kinds = FINDING_RECS[f.kind];
    let recs: Recommendation[] = [];
    if (kinds) {
      recs = take((r) => kinds.includes(r.kind) && (r.invoiceLineIds.length === 0 || r.invoiceLineIds.some((id) => f.invoiceLineIds.includes(id))));
      recs.sort((a, b) => kinds.indexOf(a.kind) - kinds.indexOf(b.kind));
    } else if (f.kind === "exact_duplicate" || f.kind === "near_duplicate" || f.kind === "related_party") {
      recs = take((r) => r.kind === "hold_duplicate_claim" && f.evidence.some((e) => r.id.endsWith(`:${e}`)));
    }
    const primary = recs[0];
    issues.push({
      id: f.id,
      source: "finding",
      title: f.title,
      severity: f.severity,
      explanation: f.explanation,
      amount: primary ? Math.abs(primary.adjustment) : f.leakageAmount,
      evidence: f.evidence.map((label) => ({ label })),
      recommendations: recs,
    });
  }

  for (const d of discrepancies) {
    const recs = take((r) => fixesDiscrepancy(d, r));
    issues.push({
      id: d.id,
      source: "document",
      title: d.title,
      severity: d.severity,
      explanation: d.explanation,
      amount: recs[0] ? Math.abs(recs[0].adjustment) : d.amountAtRisk,
      evidence: [
        { label: `Claim: ${d.claimValue} (${d.claimRef})` },
        { label: `Document: ${d.documentValue}`, source: d.source },
      ],
      recommendations: recs,
    });
  }

  const representedByFinding = (claimId: string) =>
    claim.findings.some((f) => ["exact_duplicate", "near_duplicate", "related_party"].includes(f.kind) && f.evidence.includes(claimId));
  for (const c of correlations) {
    if (c.strength === "weak" || representedByFinding(c.claimId)) continue;
    const recs = take((r) => r.kind === "hold_duplicate_claim" && r.id.endsWith(`:${c.claimId}`));
    issues.push({
      id: `X:${c.claimId}`,
      source: "correlation",
      title: `Linked to ${c.claimId}`,
      severity: c.crossPolicyInvoice ? "critical" : c.strength === "strong" ? "high" : "medium",
      explanation: c.headline,
      amount: recs[0] ? Math.abs(recs[0].adjustment) : 0,
      evidence: c.attributes.map((a) => ({ label: `${a.attribute}: ${a.thisClaim}`, claimId: c.claimId })),
      recommendations: recs,
    });
  }

  // Corrections the engine worked out that no finding or document difference accounts for.
  for (const r of recommendations) {
    if (used.has(r.id) || r.kind === "apply_deductible" || r.kind === "apply_copay") continue;
    used.add(r.id);
    const extras = r.kind === "correct_settlement" ? take((x) => x.kind === "apply_deductible" || x.kind === "apply_copay") : [];
    issues.push({
      id: `C:${r.id}`,
      source: "calculation",
      title: r.title,
      severity: amountSeverity(Math.abs(r.adjustment)),
      explanation: r.calculation,
      amount: Math.abs(r.adjustment),
      evidence: [{ label: `Policy rule: ${r.policyRule.name}` }],
      recommendations: [r, ...extras],
    });
  }

  const order: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3 };
  issues.sort((a, b) => order[a.severity] - order[b.severity] || b.amount - a.amount);

  return {
    correlations,
    discrepancies,
    calculation,
    recommendations,
    issues,
    leakage: {
      calculated: calculation.leakage,
      crossClaimExposure: recommendations.filter((r) => r.kind === "hold_duplicate_claim").reduce((m, r) => Math.max(m, r.originalAmount), 0),
    },
  };
}

// ------------------------------------------------------------------------------------------ events

export function makeEvent(by: Actor, type: InvestigationEventType, summary: string, data?: unknown, at = new Date().toISOString()): InvestigationEvent {
  return { id: uid("EVT"), at, by, type, summary, data };
}

/** The baseline written when an analyst first opens a claim: calculations, issues and recommendations as they stood. */
export function openInvestigation(analysis: InvestigationAnalysis, by: Actor): Investigation {
  const at = new Date().toISOString();
  const events: InvestigationEvent[] = [
    makeEvent(by, "investigation_opened", `Investigation opened by ${by.name} (${by.role})`, undefined, at),
    makeEvent(by, "calculation_recorded", `Original calculation: proposed ${inr(analysis.calculation.proposed)}, corrected ${inr(analysis.calculation.expected)}, leakage ${inr(analysis.calculation.leakage)}`, { stage: "original", calculation: analysis.calculation }, at),
    ...analysis.correlations.map((c) => makeEvent(by, "correlation_found", `Linked to ${c.claimId}: ${c.headline}`, c, at)),
    ...analysis.issues.map((i) => makeEvent(by, "issue_detected", `${i.severity.toUpperCase()}: ${i.title}`, i, at)),
    ...analysis.recommendations.map((r) => makeEvent(by, "recommendation_generated", `${r.title}: ${inr(r.originalAmount)} → ${inr(r.correctedAmount)}`, { recommendation: r, generatedBy: r.generatedBy }, at)),
  ];
  return { openedAt: at, openedBy: by, decisions: [], notes: [], events };
}

/** Events to record after documents were added: the new evidence, the differences found, and what changed. */
export function eventsForNewDocument(
  before: InvestigationAnalysis,
  after: InvestigationAnalysis,
  doc: { id: string; name: string; kind: string; fieldCount: number; lineItemCount: number },
  by: Actor,
): InvestigationEvent[] {
  const known = new Set(before.discrepancies.map((d) => d.id));
  const priorRecs = new Map(before.recommendations.map((r) => [r.id, r]));
  const events: InvestigationEvent[] = [
    makeEvent(by, "document_added", `Document added: ${doc.name} (${doc.kind.replace("_", " ")}, ${doc.fieldCount} fields, ${doc.lineItemCount} line items)`, doc),
  ];
  for (const d of after.discrepancies.filter((x) => !known.has(x.id))) {
    events.push(makeEvent(by, "discrepancy_detected", d.title, d));
  }
  for (const r of after.recommendations) {
    const prior = priorRecs.get(r.id);
    if (prior && prior.correctedAmount === r.correctedAmount && prior.originalAmount === r.originalAmount) continue;
    events.push(makeEvent(by, "recommendation_generated", `${prior ? "Revised" : "New"} recommendation: ${r.title}, ${inr(r.originalAmount)} → ${inr(r.correctedAmount)}`, { recommendation: r, supersedes: prior ?? null, generatedBy: r.generatedBy }));
  }
  if (before.calculation.expected !== after.calculation.expected) {
    events.push(makeEvent(by, "calculation_recorded", `Recalculated after ${doc.name}: corrected settlement ${inr(before.calculation.expected)} → ${inr(after.calculation.expected)}`, { stage: "after_document", previous: before.calculation, calculation: after.calculation }));
  }
  return events;
}

// ------------------------------------------------------------------------------------------ decisions

export type DecisionInput = {
  issue: Issue;
  type: DecisionType;
  by: Actor;
  reason?: string;
  escalateTo?: EscalationTarget;
  /** An amount different from the recommended one, when the analyst accepts but changes the number. */
  overrideAmount?: number;
};

export const decisionLabel: Record<DecisionType, string> = {
  CONFIRM_DISCREPANCY: "Confirm discrepancy",
  FALSE_POSITIVE: "Mark as false positive",
  REQUEST_EVIDENCE: "Request additional evidence",
  ESCALATE: "Escalate",
  ACCEPT_CORRECTION: "Accept recommended correction",
};

export const escalationLabel: Record<EscalationTarget, string> = {
  SENIOR_REVIEWER: "Senior Claims Reviewer",
  SIU: "Special Investigation Unit",
};

/** Validates a decision and returns the record plus the audit events it produces. Throws a readable error if invalid. */
export function buildDecision(input: DecisionInput): { decision: Decision; events: InvestigationEvent[] } {
  const { issue, type, by } = input;
  const reason = input.reason?.trim();
  if (type === "FALSE_POSITIVE" && !reason) throw new Error("Give a reason for marking this as a false positive.");
  if (type === "ESCALATE") {
    if (!input.escalateTo) throw new Error("Choose who to escalate to.");
    if (!reason) throw new Error("Say why this is being escalated.");
  }
  const rec = issue.recommendations[0];
  if (type === "ACCEPT_CORRECTION" && !rec) throw new Error("This item has no recommended correction to accept.");

  let override: Decision["override"];
  if (type === "ACCEPT_CORRECTION" && rec && input.overrideAmount !== undefined && input.overrideAmount !== rec.correctedAmount) {
    if (!Number.isFinite(input.overrideAmount) || input.overrideAmount < 0) throw new Error("Enter a valid corrected amount.");
    if (!reason) throw new Error("Give a reason for changing the recommended amount.");
    override = { originalAmount: rec.correctedAmount, overriddenAmount: input.overrideAmount, reason };
  }

  const at = new Date().toISOString();
  const decision: Decision = {
    id: uid("DEC"),
    issueId: issue.id,
    type,
    at,
    by,
    reason: reason || undefined,
    escalateTo: input.escalateTo,
    recommendationId: type === "ACCEPT_CORRECTION" ? rec?.id : undefined,
    // The recommendation is copied as offered, so a later override can never rewrite what the system said.
    recommendationSnapshot: type === "ACCEPT_CORRECTION" && rec ? structuredClone(rec) : undefined,
    override,
  };

  const events: InvestigationEvent[] = [
    makeEvent(by, "decision", `${decisionLabel[type]}: ${issue.title}${reason ? ` (${reason})` : ""}`, decision, at),
  ];
  if (override && rec) {
    events.push(makeEvent(by, "override", `Recommendation overridden: ${rec.title}, ${inr(override.originalAmount)} recommended, ${inr(override.overriddenAmount)} accepted (${override.reason})`, { originalRecommendation: rec, override }, at));
  }
  if (type === "ESCALATE" && input.escalateTo) {
    events.push(makeEvent(by, "escalation", `Escalated to ${escalationLabel[input.escalateTo]}: ${issue.title}`, { issueId: issue.id, to: input.escalateTo, reason }, at));
  }
  return { decision, events };
}

export function latestDecisions(inv: Investigation | undefined): Map<string, Decision> {
  const map = new Map<string, Decision>();
  for (const d of inv?.decisions ?? []) map.set(d.issueId, d); // decisions are appended, so the last one wins
  return map;
}

// ------------------------------------------------------------------------------------------ report

export type InvestigationReport = ReturnType<typeof buildReport>;

export function buildReport(claim: Claim, all: Claim[], analysis: InvestigationAnalysis, generatedBy: Actor) {
  const inv = claim.investigation;
  const decisions = latestDecisions(inv);
  const overrides = (inv?.decisions ?? []).filter((d) => d.override);
  return {
    reportVersion: "1.0",
    generatedAt: new Date().toISOString(),
    generatedBy,
    note: "Recommendations are produced by a deterministic rules engine, not a language model. The audit trail is append-only.",
    claim: {
      id: claim.id,
      policyNumber: claim.policyNumber,
      claimant: claim.claimant,
      provider: claim.provider,
      city: claim.city,
      domain: claim.domain,
      claimType: claim.claimType,
      incidentDate: claim.incidentDate,
      filedDate: claim.filedDate,
      queue: claim.queue,
      riskScore: claim.riskScore,
      requestedAmount: claim.requestedAmount,
      proposedSettlement: claim.proposedSettlement,
      lines: claim.lines,
    },
    policyTerms: claim.policyRules,
    leakage: {
      calculated: analysis.leakage.calculated,
      crossClaimExposure: analysis.leakage.crossClaimExposure,
      engineConfirmed: claim.confirmedLeakage,
      enginePotential: claim.potentialLeakage,
    },
    settlement: analysis.calculation,
    relatedClaims: analysis.correlations,
    documents: (claim.documents ?? []).map((d) => ({
      id: d.id, name: d.name, kind: d.kind, addedAt: d.addedAt, addedBy: d.addedBy, fields: d.fields, lineItems: d.lineItems,
    })),
    discrepancies: analysis.discrepancies,
    issues: analysis.issues.map((i) => ({
      ...i,
      decision: decisions.get(i.id) ?? null,
      status: decisions.get(i.id)?.type ?? "UNDECIDED",
    })),
    decisions: inv?.decisions ?? [],
    overrides: overrides.map((d) => ({ decisionId: d.id, issueId: d.issueId, by: d.by, at: d.at, originalRecommendation: d.recommendationSnapshot, override: d.override })),
    notes: inv?.notes ?? [],
    auditTrail: inv?.events ?? [],
    relatedClaimsOnDesk: all.length - 1,
  };
}

function esc(value: unknown): string {
  return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** A self-contained, printable version of the report (open it and print to PDF). */
export function reportToHtml(r: InvestigationReport): string {
  const row = (cells: unknown[]) => `<tr>${cells.map((c) => `<td>${esc(c)}</td>`).join("")}</tr>`;
  const table = (head: string[], rows: unknown[][]) =>
    `<table><thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead><tbody>${rows.map(row).join("")}</tbody></table>`;
  const who = (a: Actor) => `${a.name} (${a.role})`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Investigation report ${esc(r.claim.id)}</title>
<style>body{font:14px/1.45 system-ui,sans-serif;margin:32px;color:#111}h1{margin:0}h2{margin:28px 0 8px;border-bottom:2px solid #111;padding-bottom:4px}
table{border-collapse:collapse;width:100%;margin:8px 0}th,td{border:1px solid #ccc;padding:5px 8px;text-align:left;vertical-align:top;font-size:12.5px}th{background:#f3f3f3}
.muted{color:#666}.kpi{display:inline-block;margin:0 24px 8px 0}.kpi b{display:block;font-size:20px}</style></head><body>
<h1>Claims investigation report: ${esc(r.claim.id)}</h1>
<p class="muted">Generated ${esc(r.generatedAt)} by ${esc(who(r.generatedBy))}. ${esc(r.note)}</p>
<h2>Summary</h2>
<div><span class="kpi">Requested<b>${esc(inr(r.claim.requestedAmount))}</b></span><span class="kpi">Proposed settlement<b>${esc(inr(r.settlement.proposed))}</b></span><span class="kpi">Corrected settlement<b>${esc(inr(r.settlement.expected))}</b></span><span class="kpi">Calculated leakage<b>${esc(inr(r.leakage.calculated))}</b></span><span class="kpi">Cross-claim exposure<b>${esc(inr(r.leakage.crossClaimExposure))}</b></span></div>
${table(["Claim", "Policy", "Claimant", "Provider", "Incident", "Filed", "Queue", "Risk"], [[r.claim.id, r.claim.policyNumber, r.claim.claimant, r.claim.provider, r.claim.incidentDate, r.claim.filedDate, r.claim.queue, r.claim.riskScore]])}
<h2>Policy terms</h2>${table(["Rule", "Clause"], r.policyTerms.map((p) => [p.name, p.clause]))}
<h2>Settlement calculation</h2>${table(["Step", "Before", "After", "Calculation"], [["Claimed", "", inr(r.settlement.gross), ""], ...r.settlement.steps.map((s) => [s.label, inr(s.before), inr(s.after), s.calculation])])}
<h2>Related claims</h2>${r.relatedClaims.length ? table(["Claim", "Strength", "Why related", "Matching attributes"], r.relatedClaims.map((c) => [c.claimId, c.strength, c.headline, c.attributes.map((a) => `${a.attribute}: ${a.thisClaim}`).join("; ")])) : "<p class=muted>No related claims.</p>"}
<h2>Document evidence</h2>${r.documents.length ? r.documents.map((d) => `<h3>${esc(d.name)} <span class="muted">(${esc(d.kind)}, added by ${esc(d.addedBy)})</span></h3>${table(["Field", "Value", "Source"], Object.entries(d.fields).filter(([, v]) => v).map(([k, v]) => [k, (v as { value: unknown }).value, `line ${(v as { source: SourceRef }).source.line}: ${(v as { source: SourceRef }).source.snippet}`]))}${d.lineItems.length ? table(["Line item", "Qty", "Amount", "Source"], d.lineItems.map((l) => [l.description, l.quantity ?? "", inr(l.amount), `line ${l.source.line}`])) : ""}`).join("") : "<p class=muted>No documents attached.</p>"}
<h2>Discrepancies</h2>${r.discrepancies.length ? table(["Severity", "Difference", "Claim", "Document", "Source"], r.discrepancies.map((d) => [d.severity, d.title, d.claimValue, d.documentValue, d.source ? `${d.source.documentName} line ${d.source.line}` : "not in document"])) : "<p class=muted>None.</p>"}
<h2>Issues, recommendations and decisions</h2>${table(["Severity", "Issue", "Recommendation (original → corrected)", "Calculation", "Policy rule", "Decision"], r.issues.map((i) => {
    const rec = i.recommendations[0];
    const dec = i.decision;
    return [i.severity, i.title, rec ? `${rec.title}: ${inr(rec.originalAmount)} → ${inr(rec.correctedAmount)}` : "No monetary correction", rec?.calculation ?? "", rec ? `${rec.policyRule.name}${rec.policyRule.supplied ? "" : " (no clause supplied)"}: ${rec.policyRule.clause}` : "", dec ? `${decisionLabel[dec.type]} by ${who(dec.by)} at ${dec.at}${dec.reason ? `: ${dec.reason}` : ""}${dec.override ? `. Overridden ${inr(dec.override.originalAmount)} → ${inr(dec.override.overriddenAmount)}` : ""}` : "Undecided"];
  }))}
<h2>Notes</h2>${r.notes.length ? table(["When", "Who", "Note"], r.notes.map((n) => [n.at, who(n.by), n.text])) : "<p class=muted>None.</p>"}
<h2>Audit trail (${r.auditTrail.length} events)</h2>${table(["When", "Who", "Event", "Detail"], r.auditTrail.map((e) => [e.at, who(e.by), e.type, e.summary]))}
</body></html>`;
}
