import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { analyseClaim } from "../lib/investigation";
import { useAppStore } from "./useAppStore";

const text = (file: string) => readFileSync(resolve(__dirname, "../../public/samples/investigation", file), "utf8");
const get = () => useAppStore.getState();
const claim = (id = "CLM-INV-2001") => get().claims.find((c) => c.id === id)!;
const issueWhere = (pred: (i: ReturnType<typeof analyseClaim>["issues"][number]) => boolean, id = "CLM-INV-2001") =>
  analyseClaim(claim(id), get().claims).issues.find(pred)!;

beforeEach(() => {
  get().clearLocalData();
  get().loadDemoData();
  get().setRole("handler");
  get().setAnalystName("Asha Rao");
});

describe("investigation workflow", () => {
  it("loads the three demo scenarios with their findings", () => {
    const ids = get().claims.map((c) => c.id);
    expect(ids).toEqual(expect.arrayContaining(["CLM-INV-2001", "CLM-INV-2002", "CLM-INV-3001"]));
    expect(claim("CLM-INV-2002").findings.some((f) => f.kind === "exact_duplicate")).toBe(true);
  });

  it("opens an investigation once, stamped with the analyst's name and role", () => {
    get().openInvestigation("CLM-INV-2001");
    const first = claim().investigation!;
    expect(first.openedBy).toEqual({ name: "Asha Rao", role: "handler" });
    expect(first.events.length).toBeGreaterThan(5);
    get().openInvestigation("CLM-INV-2001"); // opening again must not rewrite the baseline
    expect(claim().investigation).toBe(first);
  });

  it("records the document, the differences it exposed and the recalculation, without touching earlier events", () => {
    get().openInvestigation("CLM-INV-2001");
    const baseline = claim().investigation!.events;
    const expectedBefore = analyseClaim(claim(), get().claims).calculation.expected;

    get().attachDocument("CLM-INV-2001", { name: "hospital-invoice-INV-88231.txt", text: text("hospital-invoice-INV-88231.txt") });
    const after = claim();
    expect(after.documents).toHaveLength(1);
    expect(after.documents![0].addedBy).toBe("Asha Rao");
    const events = after.investigation!.events;
    expect(events.slice(0, baseline.length)).toEqual(baseline); // append-only
    const added = events.slice(baseline.length);
    expect(added[0].type).toBe("document_added");
    expect(added.some((e) => e.type === "discrepancy_detected")).toBe(true);
    const recalc = added.find((e) => e.type === "calculation_recorded")!;
    expect((recalc.data as { previous: { expected: number } }).previous.expected).toBe(expectedBefore);
  });

  it("rejects an empty document without recording anything", () => {
    get().openInvestigation("CLM-INV-2001");
    const eventsBefore = claim().investigation!.events.length;
    expect(() => get().attachDocument("CLM-INV-2001", { name: "blank.txt", text: "   " })).toThrow(/readable text/);
    expect(claim().investigation!.events).toHaveLength(eventsBefore);
    expect(claim().documents ?? []).toHaveLength(0);
  });

  it("will not record an invalid decision", () => {
    const issue = issueWhere(() => true);
    expect(() => get().recordDecision("CLM-INV-2001", { issueId: issue.id, type: "FALSE_POSITIVE" })).toThrow(/reason/);
    expect(claim().investigation!.decisions).toHaveLength(0);
    expect(() => get().recordDecision("CLM-INV-2001", { issueId: "nope", type: "REQUEST_EVIDENCE" })).toThrow(/no longer part/);
  });

  it("records every decision type with identity, time and reason", () => {
    const [a, b, c, d] = analyseClaim(claim(), get().claims).issues.filter((i) => i.recommendations.length > 0);
    get().recordDecision("CLM-INV-2001", { issueId: a.id, type: "CONFIRM_DISCREPANCY" });
    get().recordDecision("CLM-INV-2001", { issueId: b.id, type: "FALSE_POSITIVE", reason: "Prescribed repeat test" });
    get().recordDecision("CLM-INV-2001", { issueId: c.id, type: "REQUEST_EVIDENCE" });
    get().recordDecision("CLM-INV-2001", { issueId: d.id, type: "ACCEPT_CORRECTION" });
    const decisions = claim().investigation!.decisions;
    expect(decisions.map((x) => x.type)).toEqual(["CONFIRM_DISCREPANCY", "FALSE_POSITIVE", "REQUEST_EVIDENCE", "ACCEPT_CORRECTION"]);
    for (const x of decisions) {
      expect(x.by).toEqual({ name: "Asha Rao", role: "handler" });
      expect(Date.parse(x.at)).not.toBeNaN();
    }
    expect(decisions[1].reason).toBe("Prescribed repeat test");
    expect(decisions[3].recommendationSnapshot).toBeDefined();
  });

  it("keeps the original recommendation and the reason after an override", () => {
    const issue = issueWhere((i) => i.recommendations[0]?.kind === "cap_at_sublimit");
    const original = structuredClone(issue.recommendations[0]);
    get().recordDecision("CLM-INV-2001", { issueId: issue.id, type: "ACCEPT_CORRECTION", overrideAmount: 12000, reason: "Suite pre-approved" });

    const inv = claim().investigation!;
    const decision = inv.decisions.at(-1)!;
    expect(decision.override).toMatchObject({ originalAmount: original.correctedAmount, overriddenAmount: 12000, reason: "Suite pre-approved" });
    expect(decision.recommendationSnapshot).toEqual(original);
    const override = inv.events.find((e) => e.type === "override")!;
    expect((override.data as { originalRecommendation: unknown }).originalRecommendation).toEqual(original);
    // The recommendation the system offers is unchanged by the analyst's override.
    expect(issueWhere((i) => i.id === issue.id).recommendations[0]).toEqual(original);
  });

  it("escalates to the special review queue and records who it went to and why", () => {
    const issue = issueWhere(() => true);
    expect(claim().queue).not.toBe("special");
    get().recordDecision("CLM-INV-2001", { issueId: issue.id, type: "ESCALATE", escalateTo: "SIU", reason: "Same invoice on another policy" });
    const after = claim();
    expect(after.queue).toBe("special");
    expect(after.specialReason).toContain("Special Investigation Unit");
    expect(after.specialReason).toContain("Same invoice on another policy");
    const types = after.investigation!.events.map((e) => e.type);
    expect(types).toEqual(expect.arrayContaining(["decision", "escalation", "queue_changed"]));
    expect(get().audit[0].detail).toContain("Same invoice on another policy");
  });

  it("keeps the older per-finding review status in step with the decision", () => {
    const issue = issueWhere((i) => i.source === "finding");
    get().recordDecision("CLM-INV-2001", { issueId: issue.id, type: "FALSE_POSITIVE", reason: "Legitimate repeat" });
    expect(claim().findings.find((f) => f.id === issue.id)?.reviewStatus).toBe("DISMISSED");
  });

  it("stores notes with the analyst's identity, newest first, and in the audit trail", () => {
    get().addInvestigationNote("CLM-INV-2001", "Called City Care billing");
    get().setRole("supervisor");
    get().addInvestigationNote("CLM-INV-2001", "Supervisor review started");
    get().addInvestigationNote("CLM-INV-2001", "   "); // blank notes are ignored
    const inv = claim().investigation!;
    expect(inv.notes.map((n) => n.text)).toEqual(["Supervisor review started", "Called City Care billing"]);
    expect(inv.notes[0].by).toEqual({ name: "Asha Rao", role: "supervisor" });
    expect(inv.events.filter((e) => e.type === "note")).toHaveLength(2);
  });

  it("falls back to a neutral name when no analyst name is set", () => {
    get().setAnalystName("   ");
    get().openInvestigation("CLM-INV-3001");
    expect(claim("CLM-INV-3001").investigation!.openedBy.name).toBe("Analyst");
  });
});
