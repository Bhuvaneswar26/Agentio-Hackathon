import { payloadToClaim } from "../lib/payloadToClaim";
import type { Claim, DetectionPayload, InvoiceLine, PolicyRule } from "../types";
import { healthRules } from "./seed";

/*
 * Three scenarios for the investigation workspace, each with a matching sample document in
 * public/samples/investigation:
 *
 *   CLM-INV-2001  hospital claim. Its invoice and discharge summary disagree with the claim (a repeated
 *                 test, a service the invoice never lists, a higher pharmacy amount, more room days than
 *                 the stay) and its room rate breaches the sub-limit.
 *   CLM-INV-2002  a different claimant under a different policy, citing the same invoice from the same
 *                 hospital as CLM-INV-2001: the same expense claimed twice.
 *   CLM-INV-3001  motor claim whose repair estimate omits a part and prices the paint work lower.
 */

type LineSpec = { code: string; description: string; quantity?: number; unitPrice?: number; amount: number };

function lines(specs: LineSpec[], provider: string, invoiceRef: string, date: string): InvoiceLine[] {
  return specs.map((s, i) => ({
    id: `${invoiceRef}-L${i + 1}`,
    code: s.code,
    description: s.description,
    quantity: s.quantity ?? 1,
    unitPrice: s.unitPrice ?? s.amount,
    amount: s.amount,
    provider,
    invoiceRef,
    date,
  }));
}

const motorRules: PolicyRule[] = [
  { id: "PR-DED", name: "Deductible", clause: "A compulsory deductible of ₹2,500 applies to every own-damage claim.", type: "deductible", value: 2500 },
  { id: "PR-WEAR", name: "Wear and tear exclusion", clause: "Wear and tear, tyres and tubes are excluded.", type: "exclusion" },
  { id: "PR-COV", name: "Own damage cover", clause: "Accidental damage to the insured vehicle is covered.", type: "coverage" },
];

function payload(p: {
  claimId: string;
  policyNumber: string;
  claimant: string;
  domain: "Health" | "Motor";
  claimType: string;
  provider: string;
  city: string;
  incidentDate: string;
  filedDate: string;
  lines: InvoiceLine[];
  rules: PolicyRule[];
  deductible: number;
  copayPercent: number;
}): DetectionPayload {
  const requested = p.lines.reduce((s, l) => s + l.amount, 0);
  return {
    schemaVersion: "1.0",
    ingestedAt: `${p.filedDate}T09:00:00.000Z`,
    source: { format: "json", engine: "investigation-demo", ocrUsed: false, confidence: 0.98, warnings: [] },
    claim: {
      claimId: p.claimId,
      policyNumber: p.policyNumber,
      claimant: p.claimant,
      incidentDate: p.incidentDate,
      filedDate: p.filedDate,
      domain: p.domain,
      claimType: p.claimType,
      requestedAmount: requested,
      proposedSettlement: requested,
      provider: p.provider,
      city: p.city,
    },
    invoiceLines: p.lines,
    policy: { policyNumber: p.policyNumber, deductible: p.deductible, copayPercent: p.copayPercent, rules: p.rules },
    history: [],
    documents: [],
    extraction: { missingFields: [], valid: true },
  };
}

/** Builds the scenarios in filing order, so each is scored against the claims that came before it. */
export function investigationDemoClaims(existing: Claim[]): Claim[] {
  const city = "City Care Hospital";
  const a = payloadToClaim(
    payload({
      claimId: "CLM-INV-2001",
      policyNumber: "HL-55021",
      claimant: "Rohan Malhotra",
      domain: "Health",
      claimType: "Hospitalisation",
      provider: city,
      city: "Mumbai",
      incidentDate: "2026-10-04",
      filedDate: "2026-10-09",
      deductible: 10000,
      copayPercent: 20,
      rules: healthRules(5000, 10000, 20),
      lines: lines(
        [
          { code: "ROOM-DLX", description: "Room rent deluxe (3 days @ ₹7,000/day)", quantity: 3, unitPrice: 7000, amount: 21000 },
          { code: "SURG-FEE", description: "Surgeon fees", amount: 18000 },
          { code: "OT-CHG", description: "Operation theatre charges", amount: 9000 },
          { code: "LAB-CBC", description: "CBC blood test", amount: 1500 },
          { code: "LAB-CBC", description: "CBC blood test", amount: 1500 },
          { code: "CONS-01", description: "Surgical gloves and syringes", amount: 2500 },
          { code: "PHARM", description: "Pharmacy medicines", amount: 6000 },
          { code: "PHYS", description: "Physiotherapy sessions", amount: 2000 },
        ],
        city,
        "INV-88231",
        "2026-10-08",
      ),
    }),
    existing,
  );

  const b = payloadToClaim(
    payload({
      claimId: "CLM-INV-2002",
      policyNumber: "HL-77310",
      claimant: "Sanjay Verma",
      domain: "Health",
      claimType: "Hospitalisation",
      provider: city,
      city: "Mumbai",
      incidentDate: "2026-10-05",
      filedDate: "2026-10-14",
      deductible: 8000,
      copayPercent: 10,
      rules: healthRules(6000, 8000, 10),
      lines: lines(
        [
          { code: "ROOM-DLX", description: "Room rent deluxe (3 days @ ₹7,000/day)", quantity: 3, unitPrice: 7000, amount: 21000 },
          { code: "SURG-FEE", description: "Surgeon fees", amount: 18000 },
          { code: "OT-CHG", description: "Operation theatre charges", amount: 9000 },
          { code: "LAB-CBC", description: "CBC blood test", amount: 1500 },
          { code: "CONS-01", description: "Surgical gloves and syringes", amount: 2500 },
          { code: "PHARM", description: "Pharmacy medicines", amount: 5200 },
        ],
        city,
        "INV-88231",
        "2026-10-13",
      ),
    }),
    [...existing, a],
  );

  const garage = "Orbit Body Shop";
  const c = payloadToClaim(
    payload({
      claimId: "CLM-INV-3001",
      policyNumber: "MO-33018",
      claimant: "Neha Kulkarni",
      domain: "Motor",
      claimType: "Own damage",
      provider: garage,
      city: "Pune",
      incidentDate: "2026-10-11",
      filedDate: "2026-10-13",
      deductible: 2500,
      copayPercent: 0,
      rules: motorRules,
      lines: lines(
        [
          { code: "BUMPER", description: "Front bumper replacement", amount: 22000 },
          { code: "HEADLAMP", description: "Headlamp assembly (left)", amount: 15000 },
          { code: "PAINT", description: "Paint and labour", amount: 18500 },
          { code: "BONNET", description: "Bonnet repair", amount: 12000 },
          { code: "GLASS", description: "Windshield replacement", amount: 16500 },
        ],
        garage,
        "EST-5521",
        "2026-10-13",
      ),
    }),
    [...existing, a, b],
  );

  return [a, b, c];
}

/** Sample documents the workspace offers for each demo claim (served from public/samples/investigation). */
export const DEMO_DOCUMENTS: Record<string, Array<{ name: string; url: string; label: string }>> = {
  "CLM-INV-2001": [
    { name: "hospital-invoice-INV-88231.txt", url: "/samples/investigation/hospital-invoice-INV-88231.txt", label: "Hospital invoice" },
    { name: "discharge-summary-rohan-malhotra.txt", url: "/samples/investigation/discharge-summary-rohan-malhotra.txt", label: "Discharge summary" },
  ],
  "CLM-INV-2002": [
    { name: "hospital-invoice-INV-88231.txt", url: "/samples/investigation/hospital-invoice-INV-88231.txt", label: "Invoice presented with this claim" },
  ],
  "CLM-INV-3001": [
    { name: "repair-estimate-EST-5521.txt", url: "/samples/investigation/repair-estimate-EST-5521.txt", label: "Repair estimate" },
  ],
};
