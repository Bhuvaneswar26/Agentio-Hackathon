import type {
  Claim,
  Correlation,
  Discrepancy,
  DocumentEvidence,
  InvoiceLine,
  PolicyRule,
  Recommendation,
  SettlementCalculation,
  WaterfallStep,
} from "../types";
import { explicitDailyLimit, explicitExclusion, lineKey } from "./detectPreview";
import { inr } from "./format";

export const GENERATED_BY = "ClaimsGuard rules engine v1 (deterministic, not a language model)";

const NO_CLAUSE = (name: string, clause: string): Recommendation["policyRule"] => ({ name, clause, supplied: false });

function rule(r: PolicyRule): Recommendation["policyRule"] {
  return { id: r.id, name: r.name, clause: r.clause, supplied: true };
}

export type SettlementAnalysis = {
  calculation: SettlementCalculation;
  recommendations: Recommendation[];
};

/**
 * Works out what the settlement should be and why, one line at a time.
 *
 * Each billed line is walked through the same fixed order (duplicate, unsupported by the documents,
 * excluded, amount corrected to the document, capped at the sub-limit) and loses money at most once
 * per reason, so the corrections never double count. The deductible and then the co-payment are
 * applied to what is left. Every step is returned as a recommendation with its arithmetic and the
 * policy rule it rests on; where the supplied policy has no clause, the rule says so.
 */
export function analyseSettlement(
  claim: Claim,
  documents: DocumentEvidence[],
  discrepancies: Discrepancy[],
  correlations: Correlation[],
): SettlementAnalysis {
  const recs: Recommendation[] = [];
  const rules = claim.policyRules;
  const lineSum = claim.lines.reduce((s, l) => s + l.amount, 0);
  const gross = claim.requestedAmount > 0 ? claim.requestedAmount : lineSum;
  const proposed = claim.proposedSettlement > 0 ? claim.proposedSettlement : claim.requestedAmount;

  const make = (r: Omit<Recommendation, "id" | "adjustment" | "generatedBy">, target: string): Recommendation => ({
    ...r,
    id: `R:${claim.id}:${r.kind}:${target}`,
    adjustment: r.correctedAmount - r.originalAmount,
    generatedBy: GENERATED_BY,
  });

  // A line is "unsupported" only when every document that lists line items omits it.
  const documentsWithLines = documents.filter((d) => d.lineItems.length > 0);
  const unsupported = new Map<string, Discrepancy>();
  for (const line of claim.lines) {
    const flags = discrepancies.filter((d) => d.kind === "service_not_in_document" && d.claimLineId === line.id);
    if (documentsWithLines.length > 0 && flags.length === documentsWithLines.length) unsupported.set(line.id, flags[0]);
  }
  const amountFixes = (kind: Discrepancy["kind"], lineId: string) =>
    discrepancies.filter((d) => d.kind === kind && d.claimLineId === lineId);

  const totals = { duplicates: 0, unsupported: 0, exclusions: 0, corrections: 0, caps: 0 };
  const calc: Record<keyof typeof totals, string[]> = { duplicates: [], unsupported: [], exclusions: [], corrections: [], caps: [] };
  const firstSeen = new Map<string, InvoiceLine>();

  for (const line of claim.lines) {
    const key = lineKey(line);
    const prior = firstSeen.get(key);
    if (prior && line.amount > 0) {
      totals.duplicates += line.amount;
      calc.duplicates.push(`${line.description}: ${inr(line.amount)}`);
      recs.push(make({
        kind: "remove_duplicate_line",
        title: `Remove duplicate line: ${line.description}`,
        originalAmount: line.amount,
        correctedAmount: 0,
        calculation: `${line.id} repeats ${prior.id} (same code and amount). ${inr(line.amount)} − ${inr(line.amount)} = ${inr(0)}.`,
        policyRule: NO_CLAUSE("One payment per service", "The supplied policy has no duplicate-billing clause; a service is payable once, so the repeated line is not."),
        basis: "policy_terms",
        invoiceLineIds: [line.id, prior.id],
        inWaterfall: true,
      }, line.id));
      continue;
    }
    firstSeen.set(key, line);

    const missing = unsupported.get(line.id);
    if (missing) {
      totals.unsupported += line.amount;
      calc.unsupported.push(`${line.description}: ${inr(line.amount)}`);
      recs.push(make({
        kind: "remove_unsupported_line",
        title: `Remove line not supported by the documents: ${line.description}`,
        originalAmount: line.amount,
        correctedAmount: 0,
        calculation: `${line.description} is claimed at ${inr(line.amount)} but is not listed in the supporting document(s). ${inr(line.amount)} − ${inr(line.amount)} = ${inr(0)}.`,
        policyRule: NO_CLAUSE("Payable against supporting documents", "The supplied policy has no clause for this; the correction rests on the supporting document alone."),
        basis: "document_evidence",
        invoiceLineIds: [line.id],
        inWaterfall: true,
      }, line.id));
      continue;
    }

    const exclusion = explicitExclusion(line, rules);
    if (exclusion) {
      totals.exclusions += line.amount;
      calc.exclusions.push(`${line.description}: ${inr(line.amount)}`);
      recs.push(make({
        kind: "remove_excluded_item",
        title: `Remove excluded item: ${line.description}`,
        originalAmount: line.amount,
        correctedAmount: 0,
        calculation: `${line.description} falls under the exclusion "${exclusion.name}". ${inr(line.amount)} − ${inr(line.amount)} = ${inr(0)}.`,
        policyRule: rule(exclusion),
        basis: "policy_terms",
        invoiceLineIds: [line.id],
        inWaterfall: true,
      }, line.id));
      continue;
    }

    // Past duplicate / unsupported / excluded: the line survives, and may still be trimmed.
    let amount = line.amount;
    let quantity = line.quantity || 1;
    const unit = line.unitPrice || line.amount / quantity;

    for (const fix of amountFixes("line_amount_mismatch", line.id)) {
      const docAmount = fix.difference !== undefined ? line.amount + fix.difference : amount;
      if (docAmount < amount) {
        recs.push(make({
          kind: "correct_line_amount",
          title: `Correct ${line.description} to the documented amount`,
          originalAmount: amount,
          correctedAmount: docAmount,
          calculation: `The document charges ${inr(docAmount)} for this service; the claim charges ${inr(amount)}. Pay the lower: ${inr(amount)} → ${inr(docAmount)}.`,
          policyRule: NO_CLAUSE("Payable against supporting documents", "The supplied policy has no clause for this; the correction rests on the supporting document alone."),
          basis: "document_evidence",
          invoiceLineIds: [line.id],
          inWaterfall: true,
        }, `${line.id}:amount`));
        totals.corrections += amount - docAmount;
        calc.corrections.push(`${line.description}: ${inr(amount)} → ${inr(docAmount)}`);
        amount = docAmount;
      }
    }
    for (const fix of amountFixes("stay_length_mismatch", line.id)) {
      const excessDays = Math.round(fix.amountAtRisk / unit);
      const allowedQty = quantity - excessDays;
      const allowedAmount = allowedQty * unit;
      if (excessDays > 0 && allowedAmount < amount) {
        recs.push(make({
          kind: "correct_line_amount",
          title: `Reduce room days to the documented stay: ${line.description}`,
          originalAmount: amount,
          correctedAmount: allowedAmount,
          calculation: `${quantity} day(s) billed, ${allowedQty} supported by the discharge summary. ${allowedQty} × ${inr(unit)} = ${inr(allowedAmount)} (was ${inr(amount)}).`,
          policyRule: NO_CLAUSE("Payable against supporting documents", "The supplied policy has no clause for this; the correction rests on the discharge summary alone."),
          basis: "document_evidence",
          invoiceLineIds: [line.id],
          inWaterfall: true,
        }, `${line.id}:stay`));
        totals.corrections += amount - allowedAmount;
        calc.corrections.push(`${line.description}: ${quantity} → ${allowedQty} day(s)`);
        amount = allowedAmount;
        quantity = allowedQty;
      }
    }

    const limit = explicitDailyLimit(line, rules);
    if (limit?.value !== undefined) {
      const capped = Math.min(amount, quantity * limit.value);
      if (capped < amount) {
        totals.caps += amount - capped;
        calc.caps.push(`${line.description}: ${inr(amount)} → ${inr(capped)}`);
        recs.push(make({
          kind: "cap_at_sublimit",
          title: `Cap ${line.description} at the daily sub-limit`,
          originalAmount: amount,
          correctedAmount: capped,
          calculation: `${quantity} day(s) × min(${inr(unit)} billed, ${inr(limit.value)} limit) = ${quantity} × ${inr(limit.value)} = ${inr(capped)}. Excess removed: ${inr(amount)} − ${inr(capped)} = ${inr(amount - capped)}.`,
          policyRule: rule(limit),
          basis: "policy_terms",
          invoiceLineIds: [line.id],
          inWaterfall: true,
        }, line.id));
      }
    }
  }

  // ---- the waterfall
  const steps: WaterfallStep[] = [];
  let running = gross;
  const lineStep = (key: keyof typeof totals, label: string) => {
    if (totals[key] <= 0) return;
    steps.push({ key, label, before: running, after: running - totals[key], calculation: `${inr(running)} − ${inr(totals[key])} (${calc[key].join("; ")}) = ${inr(running - totals[key])}` });
    running -= totals[key];
  };
  lineStep("duplicates", "Remove duplicate lines");
  lineStep("unsupported", "Remove lines not in the documents");
  lineStep("exclusions", "Remove excluded items");
  lineStep("corrections", "Correct amounts to the documents");
  lineStep("caps", "Cap at sub-limits");

  const deductible = rules.find((r) => r.type === "deductible" && Number.isFinite(r.value));
  if (deductible?.value !== undefined) {
    const after = Math.max(0, running - deductible.value);
    const text = running < deductible.value
      ? `${inr(running)} is below the ${inr(deductible.value)} deductible, so ${inr(0)} is payable.`
      : `${inr(running)} − ${inr(deductible.value)} deductible = ${inr(after)}.`;
    steps.push({ key: "deductible", label: "Apply deductible", before: running, after, calculation: text });
    recs.push(make({
      kind: "apply_deductible",
      title: "Apply the policy deductible",
      originalAmount: running,
      correctedAmount: after,
      calculation: text,
      policyRule: rule(deductible),
      basis: "policy_terms",
      invoiceLineIds: [],
      inWaterfall: true,
    }, "deductible"));
    running = after;
  }
  const copay = rules.find((r) => r.type === "copay" && Number.isFinite(r.value));
  if (copay?.value !== undefined) {
    const after = Math.round(running * (1 - copay.value / 100));
    const text = `${inr(running)} × (100% − ${copay.value}% co-payment) = ${inr(after)}.`;
    steps.push({ key: "copay", label: "Apply co-payment", before: running, after, calculation: text });
    recs.push(make({
      kind: "apply_copay",
      title: "Apply the policy co-payment",
      originalAmount: running,
      correctedAmount: after,
      calculation: text,
      policyRule: rule(copay),
      basis: "policy_terms",
      invoiceLineIds: [],
      inWaterfall: true,
    }, "copay"));
    running = after;
  }

  const expected = Math.max(0, running);
  const calculation: SettlementCalculation = { gross, steps, expected, proposed, leakage: Math.max(0, proposed - expected) };

  if (proposed !== expected) {
    const policyRules = [deductible, copay].filter((r): r is PolicyRule => Boolean(r));
    recs.push(make({
      kind: "correct_settlement",
      title: "Correct the proposed settlement",
      originalAmount: proposed,
      correctedAmount: expected,
      calculation: steps.length
        ? `${inr(gross)} claimed → ${steps.map((s) => `${s.label.toLowerCase()} ${inr(s.after)}`).join(" → ")}. Corrected settlement ${inr(expected)} against ${inr(proposed)} proposed.`
        : `No adjustment step applies; the corrected settlement is ${inr(expected)} against ${inr(proposed)} proposed.`,
      policyRule: policyRules.length
        ? { name: "Settlement per policy terms", clause: policyRules.map((r) => r.clause).join(" "), supplied: true }
        : NO_CLAUSE("Settlement per policy terms", "The supplied policy has no deductible or co-payment clause."),
      basis: "policy_terms",
      invoiceLineIds: [],
      inWaterfall: false,
    }, "settlement"));
  }

  // ---- the same expense claimed twice: hold the later claim
  for (const c of correlations) {
    const sharedInvoice = c.attributes.find((a) => a.attribute === "Invoice number");
    if (!sharedInvoice || proposed <= 0) continue;
    // The later-filed claim is the suspected duplicate; ties fall to the higher claim id.
    const isLater = claim.filedDate > c.filedDate || (claim.filedDate === c.filedDate && claim.id > c.claimId);
    if (!isLater) continue;
    recs.push(make({
      kind: "hold_duplicate_claim",
      title: `Hold payment: invoice ${sharedInvoice.thisClaim} is already on ${c.claimId}`,
      originalAmount: proposed,
      correctedAmount: 0,
      calculation: `Invoice ${sharedInvoice.thisClaim} was already submitted on ${c.claimId}${c.crossPolicyInvoice ? ` under policy ${c.policyNumber}` : ""} (filed ${c.filedDate}, this claim ${claim.filedDate}). Hold ${inr(proposed)} until the duplicate is ruled out: ${inr(proposed)} − ${inr(proposed)} = ${inr(0)} payable now.`,
      policyRule: NO_CLAUSE("One indemnity per expense", "The supplied policy has no clause on duplicate claims; the same expense cannot be indemnified twice."),
      basis: "cross_claim",
      invoiceLineIds: [],
      inWaterfall: false,
    }, c.claimId));
  }

  return { calculation, recommendations: recs };
}
