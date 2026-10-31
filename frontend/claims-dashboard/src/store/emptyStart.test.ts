import { beforeAll, describe, expect, it, vi } from "vitest";
import { allSeedClaims, seedAudit } from "../data/seed";
import type { Claim } from "../types";

// The test environment has no window.localStorage, so the store would skip its persist layer entirely.
let useAppStore: typeof import("./useAppStore").useAppStore;

beforeAll(async () => {
  const data = new Map<string, string>();
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
      removeItem: (k: string) => void data.delete(k),
    },
  });
  ({ useAppStore } = await import("./useAppStore"));
});

describe("empty start", () => {
  it("starts with no claims or audit events", () => {
    const { claims, audit } = useAppStore.getInitialState();
    expect(claims).toEqual([]);
    expect(audit).toEqual([]);
  });

  it("wipes claims, findings, audit and jobs stored by an older version, but keeps settings", () => {
    const migrate = useAppStore.persist.getOptions().migrate!;
    const own = { ...allSeedClaims[0], id: "CLM-MINE-1" } as Claim;
    expect(own.findings.length).toBeGreaterThan(0);
    const stored = {
      role: "supervisor",
      agentUrl: "http://example.test/v1/detect",
      claims: [allSeedClaims[1], own],
      audit: [seedAudit[0], { ...seedAudit[0], id: "AUD-user" }],
      jobs: [{ id: "JOB-1" }],
      policyFromDocument: { sourceName: "x" },
    };
    for (const version of [3, 4]) {
      const next = migrate(stored, version) as typeof stored;
      expect(next.claims).toEqual([]);
      expect(next.audit).toEqual([]);
      expect(next.jobs).toEqual([]);
      expect(next.policyFromDocument).toBeNull();
      expect(next.role).toBe("supervisor");
      expect(next.agentUrl).toBe("http://example.test/v1/detect");
    }
  });

  it("leaves current-version state alone", () => {
    const migrate = useAppStore.persist.getOptions().migrate!;
    const stored = { claims: [allSeedClaims[0]], audit: [] };
    expect(migrate(stored, 5)).toBe(stored);
  });

  it("loads and clears the demo portfolio on request", () => {
    useAppStore.getState().loadDemoData();
    const ids = useAppStore.getState().claims.map((c) => c.id);
    // The demo is the seed portfolio plus the three investigation scenarios.
    expect(ids.length).toBe(allSeedClaims.length + 3);
    expect(ids).toEqual(expect.arrayContaining(["CLM-INV-2001", "CLM-INV-2002", "CLM-INV-3001"]));
    useAppStore.getState().clearLocalData();
    expect(useAppStore.getState().claims).toEqual([]);
  });
});
