import { describe, expect, it } from "vitest";
import { runPreviewDetection } from "./detectPreview";
import { payloadFromObject } from "./ingest";

describe("provisional local detection preview", () => {
  it("does not invent exclusions or room limits when policy terms are absent", () => {
    const payload = payloadFromObject(
      {
        claim: {
          claimId: "CLM-PREVIEW-1",
          policyNumber: "POL-1",
          requestedAmount: 21000,
        },
        invoiceLines: [
          {
            id: "LINE-1",
            description: "Room rent",
            quantity: 3,
            unitPrice: 7000,
            amount: 21000,
          },
        ],
      },
      "json",
    );

    const result = runPreviewDetection(payload, []);

    expect(
      result.findings.some((finding) =>
        ["limit_breach", "exclusion"].includes(finding.kind),
      ),
    ).toBe(false);
    expect(result.confirmedLeakage).toBe(0);
  });

  it("calculates only from a supplied policy rule and keeps the preview provisional", () => {
    const payload = payloadFromObject(
      {
        claim: {
          claimId: "CLM-PREVIEW-2",
          policyNumber: "POL-2",
          requestedAmount: 21000,
        },
        invoiceLines: [
          {
            id: "LINE-1",
            description: "Room rent",
            quantity: 3,
            unitPrice: 7000,
            amount: 21000,
          },
        ],
        policy: {
          rules: [
            {
              id: "ROOM-CAP",
              name: "Room rent daily limit",
              clause: "Room rent payable up to INR 5000 per day.",
              type: "sublimit",
              value: 5000,
              unit: "INR/day",
            },
          ],
        },
      },
      "json",
    );

    const result = runPreviewDetection(payload, []);
    const finding = result.findings.find(
      (item) => item.kind === "limit_breach",
    );

    expect(finding?.leakageAmount).toBe(6000);
    expect(finding?.certainty).toBe("potential");
    expect(result.confirmedLeakage).toBe(0);
    expect(result.potentialLeakage).toBe(6000);
  });
});
