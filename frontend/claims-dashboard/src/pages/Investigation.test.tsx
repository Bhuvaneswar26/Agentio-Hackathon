import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { analyseClaim } from "../lib/investigation";

// The persist layer needs browser storage; give it an in-memory one so it stays quiet.
let useAppStore: typeof import("../store/useAppStore").useAppStore;
let Investigation: typeof import("./Investigation").Investigation;

beforeAll(async () => {
  const data = new Map<string, string>();
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
      removeItem: (k: string) => void data.delete(k),
    },
  });
  ({ useAppStore } = await import("../store/useAppStore"));
  ({ Investigation } = await import("./Investigation"));
});

const sample = (file: string) => readFileSync(resolve(__dirname, "../../public/samples/investigation", file), "utf8");
const get = () => useAppStore.getState();

function page(claimId: string): string {
  // React's server renderer reads a store's *initial* state object. Copy the live state into it so the
  // page renders what a browser would show after the test's setup.
  Object.assign(useAppStore.getInitialState(), useAppStore.getState());
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={[`/claims/${claimId}/investigate`]}>
      <Routes>
        <Route path="/claims/:id/investigate" element={<Investigation />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  get().clearLocalData();
  get().loadDemoData();
  get().setRole("handler");
  get().setAnalystName("Asha Rao");
});

describe("investigation workspace page", () => {
  it("shows every section the workspace needs for a flagged claim", () => {
    get().openInvestigation("CLM-INV-2001");
    get().attachDocument("CLM-INV-2001", { name: "hospital-invoice-INV-88231.txt", text: sample("hospital-invoice-INV-88231.txt") });
    get().attachDocument("CLM-INV-2001", { name: "discharge-summary-rohan-malhotra.txt", text: sample("discharge-summary-rohan-malhotra.txt") });
    const html = page("CLM-INV-2001");

    for (const heading of [
      "Issues and recommended corrections",
      "Settlement calculation",
      "Original claim",
      "Relevant policy terms",
      "Related claims",
      "Supporting documents",
      "Document vs claim differences",
      "Analyst notes",
      "Evidence and audit trail",
    ]) {
      expect(html).toContain(heading);
    }
    // the original claim and the policy terms
    expect(html).toContain("Rohan Malhotra");
    expect(html).toContain("Room rent sub-limit");
    // a related claim, with the attributes that connect it
    expect(html).toContain("CLM-INV-2002");
    expect(html).toContain("different policies");
    expect(html).toContain("Matching attribute");
    // extracted document evidence, with a source reference
    expect(html).toContain("hospital-invoice-INV-88231.txt");
    expect(html).toContain("line 16");
    // discrepancies and the leakage figures
    expect(html).toContain("Total differs");
    expect(html).toContain("₹26,960"); // corrected settlement
    expect(html).toContain("₹34,540"); // calculated leakage
    // a recommendation with original and corrected amounts, calculation and policy rule
    expect(html).toContain("Recommended correction");
    expect(html).toContain("Calculation:");
    expect(html).toContain("Policy rule:");
    expect(html).toContain("no clause in the supplied policy");
    // all five decisions are offered
    for (const label of ["Confirm discrepancy", "False positive", "Request evidence", "Escalate", "Accept correction"]) {
      expect(html).toContain(label);
    }
    expect(html).toContain("Download report (JSON)");
  });

  it("shows who decided what, and keeps an override visible", () => {
    const claim = get().claims.find((c) => c.id === "CLM-INV-2001")!;
    const cap = analyseClaim(claim, get().claims).issues.find((i) => i.recommendations[0]?.kind === "cap_at_sublimit")!;
    get().recordDecision("CLM-INV-2001", { issueId: cap.id, type: "ACCEPT_CORRECTION", overrideAmount: 12000, reason: "Suite pre-approved" });
    const html = page("CLM-INV-2001");
    expect(html).toContain("Accept recommended correction");
    expect(html).toContain("Asha Rao");
    expect(html).toContain("Overrode the recommendation");
    expect(html).toContain("The original recommendation is retained");
    expect(html).toContain("Suite pre-approved");
    expect(html).toContain("1 / ");
  });

  it("explains the cross-policy invoice link from the other claim's side too", () => {
    get().openInvestigation("CLM-INV-2002");
    const html = page("CLM-INV-2002");
    expect(html).toContain("CLM-INV-2001");
    expect(html).toContain("Hold payment");
    expect(html).toContain("₹57,200");
  });

  it("is read-only for decisions in the executive view", () => {
    get().setRole("executive");
    const html = page("CLM-INV-2001");
    expect(html).toContain("Executive view is read-only for decisions");
    expect(html).not.toContain("Record decision");
  });

  it("handles a claim with no documents, no policy terms and no related claims", () => {
    get().clearLocalData();
    get().loadDemoData();
    const html = page("CLM-INV-3001");
    expect(html).toContain("No other claim on the desk shares");
    expect(html).toContain("No supporting documents yet");
  });

  it("says so when the claim is not on the desk", () => {
    expect(page("CLM-NOPE")).toContain("Claim not on the desk");
  });
});
