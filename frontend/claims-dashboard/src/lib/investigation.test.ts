import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { investigationDemoClaims } from "../data/investigationDemo";
import type { Actor, Claim, DocumentEvidence } from "../types";
import { correlateClaim } from "./correlation";
import { compareDocument, extractDocument, parseDate } from "./documents";
import {
  analyseClaim,
  buildDecision,
  buildReport,
  eventsForNewDocument,
  latestDecisions,
  openInvestigation,
  reportToHtml,
} from "./investigation";

const analyst: Actor = { name: "Asha Rao", role: "handler" };

function sample(file: string): string {
  return readFileSync(resolve(__dirname, "../../public/samples/investigation", file), "utf8");
}
function doc(id: string, file: string): DocumentEvidence {
  return extractDocument({ id, name: file, text: sample(file), addedBy: analyst.name, addedAt: "2026-10-20T10:00:00Z" });
}

const [claimA, claimB, claimC] = investigationDemoClaims([]);
const invoice = doc("DOC-1", "hospital-invoice-INV-88231.txt");
const discharge = doc("DOC-2", "discharge-summary-rohan-malhotra.txt");
const estimate = doc("DOC-3", "repair-estimate-EST-5521.txt");
const withDocs = (c: Claim, ...docs: DocumentEvidence[]): Claim => ({ ...c, documents: docs });

describe("document extraction", () => {
  it("reads typed fields and keeps the line each came from", () => {
    expect(invoice.kind).toBe("invoice");
    expect(invoice.fields.invoiceNumber?.value).toBe("INV-88231");
    expect(invoice.fields.invoiceNumber?.source).toMatchObject({ documentName: "hospital-invoice-INV-88231.txt", line: 5 });
    expect(invoice.fields.person?.value).toBe("Rohan Malhotra");
    expect(invoice.fields.documentDate?.value).toBe("2026-10-12"); // 12/10/2026 is day-first
    expect(invoice.fields.totalAmount?.value).toBe(57200);
    expect(invoice.fields.totalAmount?.source.snippet).toContain("57,200");
  });

  it("reads line items with quantity and amount, each with a source line", () => {
    expect(invoice.lineItems.map((l) => [l.description, l.quantity, l.amount])).toEqual([
      ["Room rent deluxe", 3, 21000],
      ["Surgeon fees", 1, 18000],
      ["Operation theatre charges", 1, 9000],
      ["CBC blood test", 1, 1500],
      ["Surgical gloves and syringes", 1, 2500],
      ["Pharmacy medicines", 1, 5200],
    ]);
    expect(invoice.lineItems[0].source.line).toBe(9);
    // The title, header row and total are not billed services.
    expect(invoice.lineItems.some((l) => /total|description/i.test(l.description))).toBe(false);
  });

  it("classifies a discharge summary and a repair estimate", () => {
    expect(discharge.kind).toBe("discharge_summary");
    expect(discharge.fields.admissionDate?.value).toBe("2026-10-04");
    expect(discharge.fields.dischargeDate?.value).toBe("2026-10-05");
    expect(discharge.fields.diagnosis?.value).toBe("Acute appendicitis");
    expect(estimate.kind).toBe("repair_estimate");
    expect(estimate.fields.invoiceNumber?.value).toBe("EST-5521");
    expect(estimate.fields.vehicle?.value).toBe("MH12AB1234");
    expect(estimate.fields.totalAmount?.value).toBe(63500);
  });

  it("parses the date formats Indian documents use", () => {
    expect(parseDate("04/10/2026")).toBe("2026-10-04");
    expect(parseDate("4-10-2026")).toBe("2026-10-04");
    expect(parseDate("2026-10-04")).toBe("2026-10-04");
    expect(parseDate("4 Oct 2026")).toBe("2026-10-04");
    expect(parseDate("October 4, 2026")).toBe("2026-10-04");
    expect(parseDate("sometime")).toBeUndefined();
  });
});

describe("document vs claim comparison", () => {
  const claim = withDocs(claimA, invoice, discharge);

  it("finds the difference in amount, the date, the extra service and the extra room days", () => {
    const kinds = [...compareDocument(invoice, claim), ...compareDocument(discharge, claim)].map((d) => `${d.kind}:${d.claimLineId ?? d.field}`);
    expect(kinds).toContain("amount_mismatch:Total amount");
    expect(kinds).toContain("date_mismatch:Invoice date");
    expect(kinds).toContain("service_not_in_document:INV-88231-L8"); // physiotherapy
    expect(kinds).toContain("service_not_in_document:INV-88231-L5"); // the repeated CBC
    expect(kinds).toContain("line_amount_mismatch:INV-88231-L7"); // pharmacy 6,000 vs 5,200
    expect(kinds).toContain("stay_length_mismatch:INV-88231-L1");
  });

  it("states the amounts and keeps a source reference on every document-side value", () => {
    const total = compareDocument(invoice, claim).find((d) => d.kind === "amount_mismatch")!;
    expect(total.claimValue).toBe("₹61,500");
    expect(total.documentValue).toBe("₹57,200");
    expect(total.difference).toBe(-4300);
    expect(total.source).toMatchObject({ documentId: "DOC-1", line: 16 });
    const pharmacy = compareDocument(invoice, claim).find((d) => d.claimLineId === "INV-88231-L7")!;
    expect(pharmacy.difference).toBe(-800);
    expect(pharmacy.source?.snippet).toContain("5,200");
    const stay = compareDocument(discharge, claim).find((d) => d.kind === "stay_length_mismatch")!;
    expect(stay.amountAtRisk).toBe(7000);
  });

  it("reports a different patient and policy when the wrong invoice is attached", () => {
    const kinds = compareDocument(invoice, withDocs(claimB, invoice)).map((d) => d.kind);
    expect(kinds).toContain("name_mismatch");
    expect(kinds).toContain("policy_mismatch");
    expect(kinds).not.toContain("invoice_number_mismatch"); // it is the invoice the claim cites
  });

  it("raises nothing for a document that agrees with the claim", () => {
    const clean: Claim = { ...claimB, requestedAmount: 57200, proposedSettlement: 57200, policyNumber: "HL-55021", claimant: "Rohan Malhotra", lines: claimB.lines.map((l) => ({ ...l, date: "2026-10-12" })) };
    expect(compareDocument(invoice, clean)).toEqual([]);
  });
});

describe("cross-claim correlation", () => {
  const all = [claimA, claimB, claimC];

  it("links two claims under different policies that cite the same invoice from the same provider", () => {
    const [link] = correlateClaim(claimA, all);
    expect(link.claimId).toBe("CLM-INV-2002");
    expect(link.strength).toBe("strong");
    expect(link.crossPolicyInvoice).toBe(true);
    expect(link.headline).toContain("INV-88231");
    expect(link.headline).toContain("HL-55021");
    expect(link.headline).toContain("HL-77310");
    const names = link.attributes.map((a) => a.attribute);
    expect(names).toEqual(expect.arrayContaining(["Invoice number", "Provider", "Identical billed lines"]));
    expect(names).not.toContain("Policy");
    expect(names).not.toContain("Claimant");
  });

  it("is symmetric and leaves unrelated claims alone", () => {
    expect(correlateClaim(claimB, all).map((c) => c.claimId)).toEqual(["CLM-INV-2001"]);
    expect(correlateClaim(claimC, all)).toEqual([]);
  });

  it("does not link claims on a shared provider alone", () => {
    const a = { ...claimC, id: "X1", lines: claimC.lines.map((l) => ({ ...l, invoiceRef: "E-1" })) };
    const b = { ...claimC, id: "X2", claimant: "Someone Else", policyNumber: "MO-1", incidentDate: "2026-01-01", lines: claimC.lines.map((l) => ({ ...l, invoiceRef: "E-2", amount: l.amount + 1 })) };
    expect(correlateClaim(a, [a, b])).toEqual([]);
  });

  it("links the same claimant on the same incident date", () => {
    const b = { ...claimC, id: "X3", lines: [], policyNumber: "MO-9", provider: "Elsewhere" };
    const [link] = correlateClaim(claimC, [claimC, b]);
    expect(link.attributes.map((a) => a.attribute)).toEqual(expect.arrayContaining(["Claimant", "Incident date"]));
  });
});

describe("settlement corrections", () => {
  const analysis = analyseClaim(withDocs(claimA, invoice, discharge), [claimA, claimB, claimC]);

  it("walks the claim to a corrected settlement, step by step", () => {
    const { calculation } = analysis;
    expect(calculation.gross).toBe(61500);
    expect(calculation.steps.map((s) => [s.key, s.before, s.after])).toEqual([
      ["duplicates", 61500, 60000],
      ["unsupported", 60000, 58000],
      ["exclusions", 58000, 55500],
      ["corrections", 55500, 47700],
      ["caps", 47700, 43700],
      ["deductible", 43700, 33700],
      ["copay", 33700, 26960],
    ]);
    expect(calculation.expected).toBe(26960);
    expect(calculation.leakage).toBe(61500 - 26960);
    expect(analysis.leakage.calculated).toBe(34540);
  });

  it("gives every recommendation the original amount, corrected amount, calculation and policy rule", () => {
    for (const r of analysis.recommendations) {
      expect(r.adjustment).toBe(r.correctedAmount - r.originalAmount);
      expect(r.calculation.length).toBeGreaterThan(10);
      expect(r.policyRule.name).toBeTruthy();
      expect(r.policyRule.clause).toBeTruthy();
    }
    const cap = analysis.recommendations.find((r) => r.kind === "cap_at_sublimit")!;
    expect([cap.originalAmount, cap.correctedAmount]).toEqual([14000, 10000]);
    expect(cap.policyRule).toMatchObject({ id: "PR-ROOM", supplied: true });
    expect(cap.calculation).toContain("2 day(s)");
    const ded = analysis.recommendations.find((r) => r.kind === "apply_deductible")!;
    expect([ded.originalAmount, ded.correctedAmount]).toEqual([43700, 33700]);
    expect(ded.policyRule.id).toBe("PR-DED");
    const dup = analysis.recommendations.find((r) => r.kind === "remove_duplicate_line")!;
    expect([dup.originalAmount, dup.correctedAmount]).toEqual([1500, 0]);
    const gloves = analysis.recommendations.find((r) => r.kind === "remove_excluded_item")!;
    expect(gloves.policyRule.id).toBe("PR-EXC");
  });

  it("is honest when the supplied policy has no clause for a correction", () => {
    const unsupported = analysis.recommendations.find((r) => r.kind === "remove_unsupported_line")!;
    expect(unsupported.policyRule.supplied).toBe(false);
    expect(unsupported.basis).toBe("document_evidence");
  });

  it("never takes the same money off twice", () => {
    const removed = new Map<string, number>();
    for (const r of analysis.recommendations.filter((x) => x.inWaterfall && x.invoiceLineIds.length)) {
      for (const id of r.invoiceLineIds.slice(0, 1)) removed.set(id, (removed.get(id) ?? 0) - r.adjustment);
    }
    for (const line of claimA.lines) expect(removed.get(line.id) ?? 0).toBeLessThanOrEqual(line.amount);
    const gap = calcGap(analysis.calculation.gross, analysis.calculation.steps);
    expect(gap).toBeGreaterThanOrEqual(0);
  });

  it("recomputes the motor claim against its repair estimate", () => {
    const motor = analyseClaim(withDocs(claimC, estimate), [claimA, claimB, claimC]);
    expect(motor.calculation.steps.map((s) => [s.key, s.after])).toEqual([
      ["unsupported", 67500],
      ["corrections", 63500],
      ["deductible", 61000],
    ]);
    expect(motor.calculation.expected).toBe(61000);
    expect(motor.leakage.calculated).toBe(23000);
  });

  it("holds only the later claim when an invoice appears on two claims", () => {
    const later = analyseClaim(claimB, [claimA, claimB, claimC]);
    const hold = later.recommendations.find((r) => r.kind === "hold_duplicate_claim")!;
    expect(hold.title).toContain("CLM-INV-2001");
    expect([hold.originalAmount, hold.correctedAmount]).toEqual([57200, 0]);
    expect(hold.inWaterfall).toBe(false);
    expect(later.leakage.crossClaimExposure).toBe(57200);
    expect(analyseClaim(claimA, [claimA, claimB, claimC]).recommendations.some((r) => r.kind === "hold_duplicate_claim")).toBe(false);
  });

  it("gives the earlier claim a linked-claim issue, because the later claim holds the duplicate", () => {
    const issue = analyseClaim(claimA, [claimA, claimB, claimC]).issues.find((i) => i.id === "X:CLM-INV-2002")!;
    expect(issue.severity).toBe("critical");
    expect(issue.explanation).toContain("different policies");
  });

  it("proposes no correction when nothing is wrong", () => {
    const clean: Claim = { ...claimC, findings: [], policyRules: [], proposedSettlement: 1000, requestedAmount: 1000, lines: [{ ...claimC.lines[0], amount: 1000 }] };
    const out = analyseClaim(clean, [clean]);
    expect(out.recommendations).toEqual([]);
    expect(out.calculation.leakage).toBe(0);
  });
});

function calcGap(gross: number, steps: { before: number; after: number }[]) {
  let running = gross;
  for (const s of steps) {
    expect(s.before).toBe(running);
    running = s.after;
  }
  return running;
}

describe("every issue can be decided", () => {
  const claim = withDocs(claimA, invoice, discharge);
  const analysis = analyseClaim(claim, [claimA, claimB, claimC]);

  it("turns findings, document differences and links into decidable issues, each with a unique id", () => {
    const sources = new Set(analysis.issues.map((i) => i.source));
    expect(sources.has("finding") && sources.has("document") && sources.has("correlation")).toBe(true);
    expect(new Set(analysis.issues.map((i) => i.id)).size).toBe(analysis.issues.length);
    // Each recommendation is attached to exactly one issue.
    const attached = analysis.issues.flatMap((i) => i.recommendations.map((r) => r.id));
    expect(new Set(attached).size).toBe(attached.length);
  });

  it("requires a reason for a false positive and for an escalation", () => {
    const issue = analysis.issues[0];
    expect(() => buildDecision({ issue, type: "FALSE_POSITIVE", by: analyst })).toThrow(/reason/);
    expect(() => buildDecision({ issue, type: "FALSE_POSITIVE", by: analyst, reason: "  " })).toThrow(/reason/);
    expect(() => buildDecision({ issue, type: "ESCALATE", by: analyst, reason: "needs SIU" })).toThrow(/who to escalate/);
    expect(() => buildDecision({ issue, type: "ESCALATE", by: analyst, escalateTo: "SIU" })).toThrow(/why/);
    expect(buildDecision({ issue, type: "FALSE_POSITIVE", by: analyst, reason: "Prescribed repeat" }).decision.reason).toBe("Prescribed repeat");
  });

  it("records the analyst, the time and the decision, for each decision type", () => {
    const withRec = analysis.issues.find((i) => i.recommendations.length > 0)!;
    for (const type of ["CONFIRM_DISCREPANCY", "REQUEST_EVIDENCE", "ACCEPT_CORRECTION"] as const) {
      const { decision, events } = buildDecision({ issue: withRec, type, by: analyst });
      expect(decision.by).toEqual(analyst);
      expect(Date.parse(decision.at)).not.toBeNaN();
      expect(events[0]).toMatchObject({ type: "decision", by: analyst });
    }
    const esc = buildDecision({ issue: withRec, type: "ESCALATE", by: analyst, escalateTo: "SIU", reason: "Possible billing ring" });
    expect(esc.events.map((e) => e.type)).toEqual(["decision", "escalation"]);
    expect(esc.decision.escalateTo).toBe("SIU");
  });

  it("cannot accept a correction on an item that has none", () => {
    const none = analysis.issues.find((i) => i.recommendations.length === 0)!;
    expect(() => buildDecision({ issue: none, type: "ACCEPT_CORRECTION", by: analyst })).toThrow(/no recommended correction/);
  });

  it("keeps the original recommendation and the reason when an analyst overrides it", () => {
    const issue = analysis.issues.find((i) => i.recommendations[0]?.kind === "cap_at_sublimit")!;
    const rec = issue.recommendations[0];
    expect(() => buildDecision({ issue, type: "ACCEPT_CORRECTION", by: analyst, overrideAmount: 12000 })).toThrow(/reason/);
    const { decision, events } = buildDecision({ issue, type: "ACCEPT_CORRECTION", by: analyst, overrideAmount: 12000, reason: "Suite upgrade pre-approved" });
    expect(decision.override).toEqual({ originalAmount: rec.correctedAmount, overriddenAmount: 12000, reason: "Suite upgrade pre-approved" });
    expect(decision.recommendationSnapshot).toEqual(rec);
    expect(decision.recommendationSnapshot).not.toBe(rec); // a copy, so it cannot be changed through the live object
    const override = events.find((e) => e.type === "override")!;
    expect((override.data as { originalRecommendation: typeof rec }).originalRecommendation).toEqual(rec);
    // Accepting at exactly the recommended amount is not an override.
    expect(buildDecision({ issue, type: "ACCEPT_CORRECTION", by: analyst, overrideAmount: rec.correctedAmount }).decision.override).toBeUndefined();
  });

  it("uses the latest decision on an issue as its status", () => {
    const issue = analysis.issues[0];
    const first = buildDecision({ issue, type: "REQUEST_EVIDENCE", by: analyst }).decision;
    const second = buildDecision({ issue, type: "CONFIRM_DISCREPANCY", by: analyst }).decision;
    const inv = { ...openInvestigation(analysis, analyst), decisions: [first, second] };
    expect(latestDecisions(inv).get(issue.id)?.type).toBe("CONFIRM_DISCREPANCY");
  });
});

describe("audit trail and report", () => {
  const before = analyseClaim(claimA, [claimA, claimB, claimC]);
  const claim = withDocs(claimA, invoice, discharge);
  const after = analyseClaim(claim, [claimA, claimB, claimC]);

  it("opens with the original calculation, every issue and every recommendation, stamped with who and when", () => {
    const inv = openInvestigation(before, analyst);
    const types = inv.events.map((e) => e.type);
    expect(types[0]).toBe("investigation_opened");
    expect(types).toContain("calculation_recorded");
    expect(types.filter((t) => t === "issue_detected")).toHaveLength(before.issues.length);
    expect(types.filter((t) => t === "recommendation_generated")).toHaveLength(before.recommendations.length);
    expect(types).toContain("correlation_found");
    for (const e of inv.events) {
      expect(e.by).toEqual(analyst);
      expect(Date.parse(e.at)).not.toBeNaN();
    }
    const calc = inv.events.find((e) => e.type === "calculation_recorded")!.data as { stage: string };
    expect(calc.stage).toBe("original");
  });

  it("records new evidence, the differences it exposed, and the recommendations it changed", () => {
    const events = eventsForNewDocument(before, after, { id: "DOC-1", name: "invoice", kind: "invoice", fieldCount: 6, lineItemCount: 6 }, analyst);
    const types = events.map((e) => e.type);
    expect(types[0]).toBe("document_added");
    expect(types).toContain("discrepancy_detected");
    expect(types).toContain("recommendation_generated");
    expect(events.find((e) => e.type === "recommendation_generated" && e.summary.startsWith("Revised"))).toBeDefined();
    const recalc = events.find((e) => e.type === "calculation_recorded")!;
    expect((recalc.data as { previous: { expected: number } }).previous.expected).toBe(before.calculation.expected);
  });

  it("builds a structured report with calculation, recommendations, decisions, overrides and the full trail", () => {
    const issue = after.issues.find((i) => i.recommendations[0]?.kind === "cap_at_sublimit")!;
    const decided = buildDecision({ issue, type: "ACCEPT_CORRECTION", by: analyst, overrideAmount: 12000, reason: "Suite pre-approved" });
    const inv = openInvestigation(after, analyst);
    inv.decisions.push(decided.decision);
    inv.events.push(...decided.events);
    inv.notes.push({ id: "N1", at: "2026-10-20T11:00:00Z", by: analyst, text: "Called the hospital" });
    const report = buildReport({ ...claim, investigation: inv }, [claimA, claimB, claimC], after, analyst);

    expect(report.claim.id).toBe("CLM-INV-2001");
    expect(report.settlement.expected).toBe(26960);
    expect(report.leakage.calculated).toBe(34540);
    expect(report.relatedClaims[0].claimId).toBe("CLM-INV-2002");
    expect(report.documents).toHaveLength(2);
    expect(report.documents[0].fields.totalAmount?.source.line).toBe(16);
    expect(report.overrides).toHaveLength(1);
    expect(report.overrides[0].originalRecommendation?.correctedAmount).toBe(10000);
    expect(report.issues.find((i) => i.id === issue.id)?.status).toBe("ACCEPT_CORRECTION");
    expect(report.issues.filter((i) => i.status === "UNDECIDED").length).toBe(after.issues.length - 1);
    expect(report.notes).toHaveLength(1);
    expect(report.auditTrail.length).toBe(inv.events.length);
    JSON.parse(JSON.stringify(report)); // round-trips as plain JSON
  });

  it("renders a printable report that escapes document text", () => {
    const hostile: Claim = { ...claim, claimant: "<script>alert(1)</script>" };
    const html = reportToHtml(buildReport(hostile, [claimA], analyseClaim(hostile, [claimA]), analyst));
    expect(html).toContain("Claims investigation report: CLM-INV-2001");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>alert");
  });
});
