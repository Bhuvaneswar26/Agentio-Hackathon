import { describe, expect, it } from "vitest";
import {
  payloadFromCsv,
  payloadFromWorkbookSheets,
  validateIntakePayload,
} from "./ingest";

describe("claim intake preflight", () => {
  it("reports an invalid amount with its source row", () => {
    const payload = payloadFromCsv(
      [
        "claimId,policyNumber,claimant,incidentDate,requestedAmount,description,quantity,unitPrice,amount",
        "CLM-TEST-1,POL-1,Sample Person,2026-03-01,not-a-number,Room rent,1,4000,not-a-number",
      ].join("\n"),
    );

    expect(validateIntakePayload(payload)).toContainEqual(
      expect.objectContaining({
        row: "LINE-1",
        field: "amount",
        blocking: true,
      }),
    );
  });

  it("rejects malformed or empty CSV instead of silently ingesting parsed fragments", () => {
    expect(() => payloadFromCsv("claimId,amount\nCLM-1\n")).toThrow(
      /CSV parsing found/,
    );
    expect(() => payloadFromCsv("claimId,amount\n")).toThrow(/no data rows/i);
  });

  it("surfaces arithmetic mismatches for review without blocking intake", () => {
    const payload = payloadFromCsv(
      [
        "claimId,policyNumber,claimant,requestedAmount,description,quantity,unitPrice,amount",
        "CLM-TEST-2,POL-2,Sample Person,1000,Consultation,2,400,1000",
      ].join("\n"),
    );

    expect(validateIntakePayload(payload)).toContainEqual(
      expect.objectContaining({
        field: "arithmetic",
        blocking: false,
      }),
    );
  });

  it("joins recognized claim, invoice, policy and history worksheets", () => {
    const payload = payloadFromWorkbookSheets([
      {
        sheet: "Claim",
        data: [
          ["claimId", "policyNumber", "claimant", "requestedAmount"],
          ["CLM-XLSX-1", "POL-XLSX-1", "Test Person", 1200],
        ],
      },
      {
        sheet: "InvoiceLines",
        data: [
          [
            "description",
            "quantity",
            "unitPrice",
            "amount",
            "provider",
            "invoiceRef",
          ],
          ["Consultation", 1, 1200, 1200, "Test Clinic", "INV-1"],
        ],
      },
      {
        sheet: "Policy",
        data: [
          ["policyNumber", "deductible", "copayPercent", "sumInsured"],
          ["POL-XLSX-1", 100, 10, 50000],
        ],
      },
      {
        sheet: "PolicyRules",
        data: [
          ["id", "name", "clause", "type", "value"],
          [
            "CAP-1",
            "Consultation cap",
            "Consultation limited to 2000 per claim",
            "limit",
            2000,
          ],
        ],
      },
      {
        sheet: "History",
        data: [
          ["claimId", "incidentDate", "amount", "status"],
          ["CLM-OLD-1", "2025-01-01", 700, "paid"],
        ],
      },
    ]);

    expect(payload.claim.claimId).toBe("CLM-XLSX-1");
    expect(payload.invoiceLines).toHaveLength(1);
    expect(payload.policy.deductible).toBe(100);
    expect(payload.policy.rules[0]?.value).toBe(2000);
    expect(payload.history[0]?.claimId).toBe("CLM-OLD-1");
  });
});
