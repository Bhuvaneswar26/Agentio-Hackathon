import type { Claim, Correlation, CorrelationAttribute } from "../types";
import { inr } from "./format";

/** A claim is related once its matching attributes add up to this much. */
export const RELATED_THRESHOLD = 35;
const STRONG = 60;

const NOISE = new Set(["", "-", "—", "unknown", "unknown provider", "unknown claimant", "unknown policy", "n/a", "na"]);

/** Lower-case, strip punctuation and collapse whitespace so "Dr. A. Rao" and "dr a rao" compare equal. */
export function normalise(value: string | undefined | null): string {
  return (value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function code(value: string | undefined | null): string {
  return (value ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function usable(value: string | undefined | null): boolean {
  return !NOISE.has(normalise(value));
}

function dayNumber(iso: string): number | null {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? Math.floor(t / 86_400_000) : null;
}

function lineFingerprints(claim: Claim): Set<string> {
  return new Set(
    claim.lines
      .filter((l) => l.amount > 0)
      .map((l) => `${normalise(l.code || l.description).replace(/\s/g, "")}|${l.amount}`),
  );
}

function join(values: string[]): string {
  return values.length > 3 ? `${values.slice(0, 3).join(", ")} +${values.length - 3} more` : values.join(", ");
}

/**
 * Finds the claims related to `claim` and explains each link attribute by attribute.
 *
 * Attributes are weighted: a shared invoice number is the strongest evidence, a shared provider the
 * weakest (providers bill many claims). The same invoice from the same provider under two different
 * policies is called out separately because the one expense is then being claimed twice.
 */
export function correlateClaim(claim: Claim, all: Claim[]): Correlation[] {
  const myInvoices = new Map<string, string>();
  for (const l of claim.lines) {
    if (usable(l.invoiceRef)) myInvoices.set(code(l.invoiceRef), l.invoiceRef);
  }
  const myFingerprints = lineFingerprints(claim);
  const myIncident = dayNumber(claim.incidentDate);

  const out: Correlation[] = [];
  for (const other of all) {
    if (other.id === claim.id) continue;
    const attributes: CorrelationAttribute[] = [];
    const add = (attribute: string, thisClaim: string, otherClaim: string, weight: number) =>
      attributes.push({ attribute, thisClaim, otherClaim, weight });

    const sharedInvoices = [
      ...new Set(
        other.lines
          .filter((l) => usable(l.invoiceRef) && myInvoices.has(code(l.invoiceRef)))
          .map((l) => myInvoices.get(code(l.invoiceRef)) as string),
      ),
    ];
    if (sharedInvoices.length) add("Invoice number", join(sharedInvoices), join(sharedInvoices), 50);

    const sameClaimant = usable(claim.claimant) && normalise(claim.claimant) === normalise(other.claimant);
    if (sameClaimant) add("Claimant", claim.claimant, other.claimant, 20);

    const samePolicy = usable(claim.policyNumber) && code(claim.policyNumber) === code(other.policyNumber);
    if (samePolicy) add("Policy", claim.policyNumber, other.policyNumber, 15);

    const sameProvider = usable(claim.provider) && normalise(claim.provider) === normalise(other.provider);
    if (sameProvider) add("Provider", claim.provider, other.provider, 10);

    const otherIncident = dayNumber(other.incidentDate);
    const sameIncidentDay = myIncident !== null && myIncident === otherIncident;
    if (sameIncidentDay) {
      add("Incident date", claim.incidentDate, other.incidentDate, 15);
      if (usable(claim.city) && normalise(claim.city) === normalise(other.city)) {
        add("Incident city", claim.city, other.city, 10);
      }
    } else if (myIncident !== null && otherIncident !== null && Math.abs(myIncident - otherIncident) <= 3) {
      add("Incident date (within 3 days)", claim.incidentDate, other.incidentDate, 5);
    }

    const sharedLines = [...lineFingerprints(other)].filter((f) => myFingerprints.has(f));
    if (sharedLines.length) {
      add("Identical billed lines", `${sharedLines.length} line(s)`, `${sharedLines.length} line(s)`, 10);
    }

    if (attributes.length && claim.requestedAmount > 0 && claim.requestedAmount === other.requestedAmount) {
      add("Requested amount", inr(claim.requestedAmount), inr(other.requestedAmount), 10);
    }

    const score = attributes.reduce((sum, a) => sum + a.weight, 0);
    if (score < RELATED_THRESHOLD) continue;

    const crossPolicyInvoice = sharedInvoices.length > 0 && !samePolicy && sameProvider;
    out.push({
      claimId: other.id,
      claimant: other.claimant,
      policyNumber: other.policyNumber,
      provider: other.provider,
      requestedAmount: other.requestedAmount,
      filedDate: other.filedDate,
      queue: other.queue,
      strength: score >= STRONG ? "strong" : score >= 45 ? "moderate" : "weak",
      score,
      attributes: attributes.sort((a, b) => b.weight - a.weight),
      crossPolicyInvoice,
      headline: headline({ claim, other, sharedInvoices, sameClaimant, samePolicy, sameProvider, sameIncidentDay }),
    });
  }
  return out.sort((a, b) => b.score - a.score || a.claimId.localeCompare(b.claimId));
}

function headline(c: {
  claim: Claim;
  other: Claim;
  sharedInvoices: string[];
  sameClaimant: boolean;
  samePolicy: boolean;
  sameProvider: boolean;
  sameIncidentDay: boolean;
}): string {
  const { claim, other, sharedInvoices } = c;
  if (sharedInvoices.length) {
    const inv = sharedInvoices[0];
    if (!c.samePolicy && c.sameProvider) {
      return `Invoice ${inv} from ${claim.provider} is cited by both claims, filed under different policies (${claim.policyNumber} and ${other.policyNumber}).`;
    }
    if (!c.samePolicy) {
      return `Invoice ${inv} appears on both claims, which sit under different policies (${claim.policyNumber} and ${other.policyNumber}).`;
    }
    return `Invoice ${inv} appears on both claims under the same policy ${claim.policyNumber}.`;
  }
  if (c.sameClaimant && c.sameIncidentDay) {
    return `${claim.claimant} has two claims for the same incident date (${claim.incidentDate}).`;
  }
  if (c.sameClaimant && c.samePolicy) {
    return `${claim.claimant} has more than one claim under policy ${claim.policyNumber}.`;
  }
  if (c.sameProvider && c.sameIncidentDay) {
    return `Both claims name ${claim.provider} for the same incident date (${claim.incidentDate}).`;
  }
  return "Several attributes match between these claims.";
}
