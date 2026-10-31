import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MasterPolicy } from "../lib/masterPolicyApi";
import type { PolicyExtraction } from "../lib/policyRag";

// An in-memory stand-in for the database behind the detection engine.
const db = vi.hoisted(() => ({ rows: [] as MasterPolicy[], fail: false }));

vi.mock("../lib/masterPolicyApi", () => ({
  listMasterPolicies: vi.fn(async () => {
    if (db.fail) throw new Error("engine down");
    return db.rows.map((r) => ({ ...r }));
  }),
  saveMasterPolicy: vi.fn(
    async (_url: string, e: { sourceName: string; extraction: PolicyExtraction; name?: string }) => {
      if (db.fail) throw new Error("engine down");
      const existing = db.rows.find((r) => r.sourceName === e.sourceName);
      const row: MasterPolicy = {
        id: existing?.id ?? `id-${db.rows.length + 1}`,
        name: e.name ?? existing?.name ?? e.extraction.policy.policy_number,
        sourceName: e.sourceName,
        policyNumber: e.extraction.policy.policy_number,
        extraction: e.extraction,
        addedAt: "2026-10-31T00:00:00Z",
      };
      db.rows = [row, ...db.rows.filter((r) => r.id !== row.id)];
      return row;
    },
  ),
  deleteMasterPolicy: vi.fn(async (_url: string, id: string) => {
    if (db.fail) throw new Error("engine down");
    db.rows = db.rows.filter((r) => r.id !== id);
  }),
}));

import { useAppStore } from "./useAppStore";

function extraction(policyNumber: string, deductible: number): PolicyExtraction {
  return {
    success: true,
    policy: { policy_number: policyNumber, deductible },
    facts: [],
    conflicts: [],
    unresolved: [],
    low_confidence: [],
    document: { chunks: 1, clauses_detected: 1, characters: 10 },
    llm_extraction: { status: "SKIPPED" },
  };
}

describe("master policy library", () => {
  beforeEach(() => {
    db.rows = [];
    db.fail = false;
    useAppStore.setState({
      masterPolicies: [],
      masterPoliciesStatus: "idle",
      masterPoliciesError: "",
      policyFromDocument: null,
    });
  });

  it("stores several policies and applies the chosen one", async () => {
    const { addMasterPolicy, selectMasterPolicy } = useAppStore.getState();
    await addMasterPolicy({ sourceName: "a.pdf", text: "A", extraction: extraction("POL-A", 1000) });
    const b = await addMasterPolicy({ sourceName: "b.pdf", text: "B", extraction: extraction("POL-B", 2000) });

    expect(db.rows).toHaveLength(2);
    expect(useAppStore.getState().masterPolicies).toHaveLength(2);

    selectMasterPolicy(b);
    const armed = useAppStore.getState().policyFromDocument;
    expect(armed?.masterId).toBe(b);
    expect(armed?.policy.deductible).toBe(2000);

    selectMasterPolicy(null);
    expect(useAppStore.getState().policyFromDocument).toBeNull();
  });

  it("replaces an entry when the same source file is added again", async () => {
    const { addMasterPolicy, selectMasterPolicy } = useAppStore.getState();
    const id = await addMasterPolicy({ sourceName: "a.pdf", text: "A", extraction: extraction("POL-A", 1000) });
    selectMasterPolicy(id);
    const again = await addMasterPolicy({ sourceName: "a.pdf", text: "A2", extraction: extraction("POL-A", 5000) });

    const state = useAppStore.getState();
    expect(again).toBe(id);
    expect(state.masterPolicies).toHaveLength(1);
    expect(state.policyFromDocument?.policy.deductible).toBe(5000);
  });

  it("clears the armed policy when it is removed", async () => {
    const { addMasterPolicy, selectMasterPolicy, removeMasterPolicy } = useAppStore.getState();
    const id = await addMasterPolicy({ sourceName: "a.pdf", text: "A", extraction: extraction("POL-A", 1000) });
    selectMasterPolicy(id);
    await removeMasterPolicy(id);

    const state = useAppStore.getState();
    expect(db.rows).toHaveLength(0);
    expect(state.masterPolicies).toHaveLength(0);
    expect(state.policyFromDocument).toBeNull();
  });

  it("loads the library from the database", async () => {
    db.rows = [
      { id: "x1", name: "Stored", sourceName: "s.pdf", policyNumber: "POL-S", extraction: extraction("POL-S", 1), addedAt: "" },
    ];
    await useAppStore.getState().loadMasterPolicies();
    const state = useAppStore.getState();
    expect(state.masterPoliciesStatus).toBe("ready");
    expect(state.masterPolicies.map((p) => p.id)).toEqual(["x1"]);
  });

  it("drops an armed policy that no longer exists in the database", async () => {
    useAppStore.setState({
      policyFromDocument: { policy: { policy_number: "GONE" }, sourceName: "gone", masterId: "gone-id", at: "" },
    });
    await useAppStore.getState().loadMasterPolicies();
    expect(useAppStore.getState().policyFromDocument).toBeNull();
  });

  it("keeps the cache and reports an error when the engine is unreachable", async () => {
    db.fail = true;
    await useAppStore.getState().loadMasterPolicies();
    expect(useAppStore.getState().masterPoliciesStatus).toBe("error");
    expect(useAppStore.getState().masterPoliciesError).toContain("engine down");

    await expect(
      useAppStore.getState().addMasterPolicy({ sourceName: "a.pdf", text: "A", extraction: extraction("POL-A", 1) }),
    ).rejects.toThrow("engine down");
    expect(useAppStore.getState().masterPolicies).toHaveLength(0);
  });
});
