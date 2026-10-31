import type {
  Claim,
  Discrepancy,
  DocumentEvidence,
  DocumentFields,
  DocumentKind,
  ExtractedLineItem,
  ExtractedValue,
  Severity,
  SourceRef,
} from "../types";
import { normalise } from "./correlation";
import { inr } from "./format";

/*
 * Rule-based reading of supporting documents (invoices, discharge summaries, repair estimates).
 * It is deliberately not a language model: the same text always gives the same fields, and every value
 * is returned with the document, line number and snippet it was read from.
 */

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

function pad(n: number) {
  return String(n).padStart(2, "0");
}

/** Reads ISO, DD/MM/YYYY, DD-MM-YYYY, "12 Sep 2026" and "Sep 12, 2026" into YYYY-MM-DD. */
export function parseDate(raw: string): string | undefined {
  const text = raw.trim();
  let m = text.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${pad(+m[2])}-${pad(+m[3])}`;
  m = text.match(/(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})/);
  if (m) return `${m[3]}-${pad(+m[2])}-${pad(+m[1])}`; // day first, as Indian documents write it
  m = text.match(/(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})/);
  if (m) {
    const month = MONTHS.indexOf(m[2].slice(0, 3).toLowerCase());
    if (month >= 0) return `${m[3]}-${pad(month + 1)}-${pad(+m[1])}`;
  }
  m = text.match(/([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})/);
  if (m) {
    const month = MONTHS.indexOf(m[1].slice(0, 3).toLowerCase());
    if (month >= 0) return `${m[3]}-${pad(month + 1)}-${pad(+m[2])}`;
  }
  return undefined;
}

export function parseAmount(raw: string): number | undefined {
  const cleaned = raw.replace(/[₹,\s]|rs\.?|inr/gi, "");
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return undefined;
  return Number(cleaned);
}

export function classifyDocument(text: string): DocumentKind {
  if (/discharge\s+summary|date\s+of\s+discharge|discharge\s+date/i.test(text)) return "discharge_summary";
  if (/repair\s+estimate|estimate\s+(?:no|number|date)|garage|workshop|spare\s+parts|labou?r\s+charges/i.test(text)) {
    return "repair_estimate";
  }
  if (/invoice|bill\s+no|tax\s+invoice/i.test(text)) return "invoice";
  return "other";
}

type Hit = { value: string; lineNo: number; line: string };

function find(lines: string[], re: RegExp): Hit | undefined {
  for (let i = 0; i < lines.length; i += 1) {
    const m = lines[i].match(re);
    if (m && m[1]?.trim()) return { value: m[1].trim(), lineNo: i + 1, line: lines[i].trim() };
  }
  return undefined;
}

function trimValue(v: string) {
  return v.replace(/\s{2,}.*$/, "").replace(/[;,.\s]+$/, "").trim();
}

// Lines that carry a label, not a billed service. A line item must not start with one of these.
const LABEL_START =
  /^\s*(?:invoice|bill|policy|claim|patient|hospital|provider|date|total|grand|sub\s*total|net|gst|tax|discount|phone|age|bed|ward\s+no|reg|vehicle|estimate|page|address|admission|discharge|diagnosis|procedure|stay|insured|owner|garage|workshop|name|id|amount\s+payable|length)\b/i;
const TOTAL_LINE =
  /^\s*(?:grand\s+)?(?:total|net\s+payable|amount\s+payable|total\s+estimate|estimate\s+total)\b(?!.*\b(?:gst|tax|discount)\b)[^\d\n]*?((?:₹|rs\.?\s*|inr\s*)?[\d][\d,]*(?:\.\d{1,2})?)\s*$/i;
const TRAILING_AMOUNT = /(?:₹|rs\.?\s*|inr\s*)?([\d][\d,]*(?:\.\d{1,2})?)\s*$/i;

function quantityOf(description: string, cells: string[]): number | undefined {
  if (cells.length >= 3) {
    const q = Number(cells[1].replace(/[^\d]/g, ""));
    if (Number.isInteger(q) && q > 0 && q < 1000) return q;
  }
  const m = description.match(/(\d+)\s*(?:days?|nights?|nos?\.?|units?|sessions?|pcs)\b/i) ?? description.match(/\bx\s*(\d+)\b/i);
  return m ? Number(m[1]) : undefined;
}

function lineItems(lines: string[], ref: (lineNo: number, snippet: string) => SourceRef): ExtractedLineItem[] {
  const items: ExtractedLineItem[] = [];
  lines.forEach((raw, i) => {
    const line = raw.trim();
    if (!line || LABEL_START.test(line)) return;
    let description: string;
    let amountRaw: string;
    let cells: string[] = [];
    if (line.includes("|")) {
      cells = line.split("|").map((c) => c.trim()).filter(Boolean);
      if (cells.length < 2) return;
      description = cells[0];
      amountRaw = cells[cells.length - 1];
    } else {
      const m = line.match(TRAILING_AMOUNT);
      if (!m || m.index === undefined) return;
      description = line.slice(0, m.index).replace(/[\s:|\-–@]+$/, "").trim();
      amountRaw = m[1];
    }
    const amount = parseAmount(amountRaw);
    if (amount === undefined || amount <= 0 || !/[A-Za-z]{3}/.test(description)) return;
    items.push({
      description: description.replace(/\s+/g, " "),
      quantity: quantityOf(description, cells),
      amount,
      source: ref(i + 1, line),
    });
  });
  return items;
}

/** Reads a document's text into typed fields and line items, each with a reference back to its line. */
export function extractDocument(input: {
  id: string;
  name: string;
  text: string;
  addedBy: string;
  addedAt?: string;
}): DocumentEvidence {
  const { id, name, text } = input;
  const lines = text.split(/\r?\n/);
  const ref = (lineNo: number, snippet: string): SourceRef => ({
    documentId: id,
    documentName: name,
    line: lineNo,
    snippet: snippet.slice(0, 200),
  });
  const value = (hit: Hit | undefined, transform?: (v: string) => string | undefined): ExtractedValue | undefined => {
    if (!hit) return undefined;
    const v = transform ? transform(hit.value) : trimValue(hit.value);
    return v ? { value: v, raw: hit.value, source: ref(hit.lineNo, hit.line) } : undefined;
  };

  const kind = classifyDocument(text);
  const fields: DocumentFields = {
    invoiceNumber: value(find(lines, /(?:invoice|bill|estimate)\s*(?:no\.?|number|#|id)\s*[:#-]\s*([A-Za-z0-9][A-Za-z0-9/-]*)/i)
      ?? find(lines, /^\s*invoice\s*[:#-]\s*([A-Za-z0-9][A-Za-z0-9/-]*)/i)),
    policyNumber: value(find(lines, /policy\s*(?:no\.?|number|#)?\s*[:#-]\s*([A-Za-z0-9][A-Za-z0-9/-]*)/i)),
    claimId: value(find(lines, /claim\s*(?:id|no\.?|number|#)\s*[:#-]\s*([A-Za-z0-9][A-Za-z0-9/-]*)/i)),
    person: value(find(lines, /^\s*(?:patient|insured|owner|customer|policyholder)(?:\s+name)?\s*[:-]\s*(.+)$/i)),
    provider: value(find(lines, /^\s*(?:hospital|provider|garage|workshop|facility|service\s+centre)(?:\s+name)?\s*[:-]\s*(.+)$/i)),
    documentDate: value(find(lines, /(?:invoice|bill|estimate|document)\s*date\s*[:-]\s*(.+)$/i), (v) => parseDate(v)),
    admissionDate: value(find(lines, /(?:date\s+of\s+admission|admission\s*date|admitted\s+on)\s*[:-]\s*(.+)$/i), (v) => parseDate(v)),
    dischargeDate: value(find(lines, /(?:date\s+of\s+discharge|discharge\s*date|discharged\s+on)\s*[:-]\s*(.+)$/i), (v) => parseDate(v)),
    diagnosis: value(find(lines, /diagnosis\s*[:-]\s*(.+)$/i)),
    procedure: value(find(lines, /(?:procedure|surgery|treatment)(?:\s+performed)?\s*[:-]\s*(.+)$/i)),
    vehicle: value(find(lines, /(?:vehicle(?:\s+no\.?)?|registration(?:\s+no\.?)?|reg\.?\s*no\.?)\s*[:-]\s*(.+)$/i)),
  };

  // The last matching total line is the document's final total (earlier ones are sub-totals).
  let total: ExtractedValue<number> | undefined;
  lines.forEach((l, i) => {
    const m = l.match(TOTAL_LINE);
    const amount = m ? parseAmount(m[1]) : undefined;
    if (amount !== undefined) total = { value: amount, raw: m![1].trim(), source: ref(i + 1, l.trim()) };
  });
  fields.totalAmount = total;

  return {
    id,
    name,
    kind,
    addedAt: input.addedAt ?? new Date().toISOString(),
    addedBy: input.addedBy,
    text,
    fields,
    lineItems: kind === "discharge_summary" ? [] : lineItems(lines, ref),
  };
}

// ------------------------------------------------------------------------------------------ comparison

const FILLER = new Set(["day", "days", "night", "nights", "charge", "charges", "billing", "repeat", "the", "and", "for", "per", "of", "with", "test", "tests", "fee", "fees"]);

function tokens(description: string): Set<string> {
  return new Set(
    normalise(description)
      .split(" ")
      .filter((t) => t.length > 1 && !/^\d+$/.test(t) && !FILLER.has(t)),
  );
}

/** Overlap of the smaller description inside the larger; 1 means one is contained in the other. */
function similarity(a: string, b: string): number {
  const ta = tokens(a);
  const tb = tokens(b);
  if (!ta.size || !tb.size) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter += 1;
  return inter / Math.min(ta.size, tb.size);
}

function sameName(a: string, b: string): boolean {
  const x = normalise(a);
  const y = normalise(b);
  if (!x || !y) return true; // nothing to compare is not a discrepancy
  if (x === y || x.includes(y) || y.includes(x)) return true;
  const tx = new Set(x.split(" "));
  const ty = y.split(" ");
  const shared = ty.filter((t) => tx.has(t)).length;
  return shared >= Math.min(tx.size, ty.length) && shared > 0;
}

function dayDiff(fromIso: string, toIso: string): number | undefined {
  const a = Date.parse(fromIso);
  const b = Date.parse(toIso);
  return Number.isFinite(a) && Number.isFinite(b) ? Math.round((b - a) / 86_400_000) : undefined;
}

function severityForAmount(atRisk: number, base: number): Severity {
  if (atRisk <= 0) return "low";
  const share = base > 0 ? atRisk / base : 1;
  return share >= 0.2 || atRisk >= 25000 ? "high" : share >= 0.05 || atRisk >= 5000 ? "medium" : "low";
}

const ROOM = /room|ward|icu|bed/i;

/** Compares one document with the claim record and lists every difference, each pointing at its source. */
export function compareDocument(doc: DocumentEvidence, claim: Claim): Discrepancy[] {
  const out: Discrepancy[] = [];
  const f = doc.fields;
  const push = (d: Omit<Discrepancy, "id" | "documentId"> & { key: string }) => {
    const { key, ...rest } = d;
    out.push({ ...rest, id: `D:${doc.id}:${rest.kind}:${key}`, documentId: doc.id });
  };

  // ---- identifiers
  const claimInvoices = [...new Set(claim.lines.map((l) => l.invoiceRef).filter(Boolean))];
  if (f.invoiceNumber && claimInvoices.length) {
    const code = (v: string) => v.toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (!claimInvoices.some((ref) => code(ref) === code(f.invoiceNumber!.value))) {
      push({
        key: "invoice",
        kind: "invoice_number_mismatch",
        severity: "high",
        title: `Invoice number differs: ${f.invoiceNumber.value} on the document, ${claimInvoices.join(", ")} on the claim`,
        field: "Invoice number",
        claimValue: claimInvoices.join(", "),
        documentValue: f.invoiceNumber.value,
        claimRef: "Claim invoice reference",
        source: f.invoiceNumber.source,
        amountAtRisk: 0,
        explanation: "The document is not the invoice the claim cites. Confirm which invoice supports this payment.",
      });
    }
  }
  if (f.policyNumber && claim.policyNumber && normalise(f.policyNumber.value) !== normalise(claim.policyNumber)) {
    push({
      key: "policy",
      kind: "policy_mismatch",
      severity: "high",
      title: `Policy number differs: ${f.policyNumber.value} on the document, ${claim.policyNumber} on the claim`,
      field: "Policy number",
      claimValue: claim.policyNumber,
      documentValue: f.policyNumber.value,
      claimRef: "Claim policy number",
      source: f.policyNumber.source,
      amountAtRisk: 0,
      explanation: "The document was issued under a different policy than the claim.",
    });
  }
  if (f.person && !sameName(f.person.value, claim.claimant)) {
    push({
      key: "person",
      kind: "name_mismatch",
      severity: "high",
      title: `Name differs: ${f.person.value} on the document, ${claim.claimant} on the claim`,
      field: doc.kind === "repair_estimate" ? "Owner / insured" : "Patient",
      claimValue: claim.claimant,
      documentValue: f.person.value,
      claimRef: "Claimant",
      source: f.person.source,
      amountAtRisk: 0,
      explanation: "The person named on the document is not the claimant.",
    });
  }
  if (f.provider && claim.provider && !sameName(f.provider.value, claim.provider)) {
    push({
      key: "provider",
      kind: "provider_mismatch",
      severity: "medium",
      title: `Provider differs: ${f.provider.value} on the document, ${claim.provider} on the claim`,
      field: doc.kind === "repair_estimate" ? "Garage" : "Hospital",
      claimValue: claim.provider,
      documentValue: f.provider.value,
      claimRef: "Claim provider",
      source: f.provider.source,
      amountAtRisk: 0,
      explanation: "The document comes from a different provider than the one on the claim.",
    });
  }

  // ---- dates
  const claimLineDate = claim.lines.find((l) => l.date)?.date;
  if (f.documentDate && claimLineDate) {
    const gap = dayDiff(claimLineDate, f.documentDate.value);
    if (gap !== undefined && gap !== 0) {
      push({
        key: "docdate",
        kind: "date_mismatch",
        severity: Math.abs(gap) > 7 ? "medium" : "low",
        title: `Document date ${f.documentDate.value} differs from the claim's billed date ${claimLineDate}`,
        field: doc.kind === "repair_estimate" ? "Estimate date" : "Invoice date",
        claimValue: claimLineDate,
        documentValue: f.documentDate.value,
        claimRef: "Claim line date",
        source: f.documentDate.source,
        amountAtRisk: 0,
        explanation: `The dates are ${Math.abs(gap)} day(s) apart.`,
      });
    }
  }
  if (f.admissionDate && claim.incidentDate) {
    const gap = dayDiff(claim.incidentDate, f.admissionDate.value);
    if (gap !== undefined && gap !== 0) {
      push({
        key: "admission",
        kind: "date_mismatch",
        severity: Math.abs(gap) > 3 ? "medium" : "low",
        title: `Admission ${f.admissionDate.value} differs from the claim's incident date ${claim.incidentDate}`,
        field: "Admission date",
        claimValue: claim.incidentDate,
        documentValue: f.admissionDate.value,
        claimRef: "Claim incident date",
        source: f.admissionDate.source,
        amountAtRisk: 0,
        explanation: `The admission is ${Math.abs(gap)} day(s) ${gap > 0 ? "after" : "before"} the incident date on the claim.`,
      });
    }
  }

  // ---- total amount
  if (f.totalAmount && (doc.kind === "invoice" || doc.kind === "repair_estimate")) {
    const diff = f.totalAmount.value - claim.requestedAmount;
    if (Math.abs(diff) > 1) {
      const atRisk = Math.max(0, -diff);
      push({
        key: "total",
        kind: "amount_mismatch",
        severity: severityForAmount(atRisk, claim.requestedAmount),
        title: `Total differs: ${inr(f.totalAmount.value)} on the document, ${inr(claim.requestedAmount)} claimed`,
        field: "Total amount",
        claimValue: inr(claim.requestedAmount),
        documentValue: inr(f.totalAmount.value),
        claimRef: "Claim requested amount",
        source: f.totalAmount.source,
        difference: diff,
        amountAtRisk: atRisk,
        explanation:
          diff < 0
            ? `The claim asks for ${inr(-diff)} more than the document supports.`
            : `The document is ${inr(diff)} higher than the claim; the claim may be understated or incomplete.`,
      });
    }
  }

  // ---- line items: match each claim line to at most one document line
  if (doc.lineItems.length && (doc.kind === "invoice" || doc.kind === "repair_estimate")) {
    const free = doc.lineItems.map((item, index) => ({ item, index }));
    const matched = new Set<number>();
    for (const line of claim.lines) {
      let best: { index: number; score: number } | undefined;
      for (const { item, index } of free) {
        if (matched.has(index)) continue;
        const score = similarity(line.description, item.description);
        const amountBonus = Math.abs(item.amount - line.amount) <= 1 ? 0.5 : 0;
        if (score >= 0.6 && (!best || score + amountBonus > best.score)) best = { index, score: score + amountBonus };
      }
      if (!best) {
        push({
          key: line.id,
          kind: "service_not_in_document",
          severity: severityForAmount(line.amount, claim.requestedAmount),
          title: `Billed on the claim but not on the document: ${line.description}`,
          field: "Service",
          claimValue: `${line.description} · ${inr(line.amount)}`,
          documentValue: "Not found",
          claimRef: `Claim line ${line.id}`,
          claimLineId: line.id,
          amountAtRisk: line.amount,
          explanation: `${inr(line.amount)} is claimed for a service that "${doc.name}" does not list. If it is a repeat of another line, it is billed twice.`,
        });
        continue;
      }
      matched.add(best.index);
      const item = doc.lineItems[best.index];
      const diff = item.amount - line.amount;
      if (Math.abs(diff) > 1) {
        const atRisk = Math.max(0, -diff);
        push({
          key: line.id,
          kind: "line_amount_mismatch",
          severity: severityForAmount(atRisk, claim.requestedAmount),
          title: `${line.description}: ${inr(item.amount)} on the document, ${inr(line.amount)} claimed`,
          field: "Line amount",
          claimValue: inr(line.amount),
          documentValue: inr(item.amount),
          claimRef: `Claim line ${line.id}`,
          claimLineId: line.id,
          source: item.source,
          difference: diff,
          amountAtRisk: atRisk,
          explanation: diff < 0 ? `The claim charges ${inr(-diff)} more than the document for this service.` : `The document charges ${inr(diff)} more than the claim records.`,
        });
      }
    }
    doc.lineItems.forEach((item, index) => {
      if (matched.has(index)) return;
      push({
        key: `doc-${index}`,
        kind: "service_not_in_claim",
        severity: "low",
        title: `On the document but not on the claim: ${item.description}`,
        field: "Service",
        claimValue: "Not found",
        documentValue: `${item.description} · ${inr(item.amount)}`,
        claimRef: "Claim lines",
        source: item.source,
        amountAtRisk: 0,
        explanation: "The document lists a service the claim does not. The claim may be incomplete.",
      });
    });
  }

  // ---- length of stay vs room days billed
  if (doc.kind === "discharge_summary" && f.admissionDate && f.dischargeDate) {
    const nights = dayDiff(f.admissionDate.value, f.dischargeDate.value);
    const room = claim.lines.find((l) => ROOM.test(l.description) && l.quantity > 0);
    // Hospitals bill either nights or calendar days (nights + 1); more than that is not supported.
    if (nights !== undefined && nights >= 0 && room && room.quantity > nights + 1) {
      const excessDays = room.quantity - (nights + 1);
      const atRisk = excessDays * (room.unitPrice || room.amount / room.quantity);
      push({
        key: room.id,
        kind: "stay_length_mismatch",
        severity: severityForAmount(atRisk, claim.requestedAmount),
        title: `${room.quantity} room days billed for a ${nights}-night stay`,
        field: "Length of stay",
        claimValue: `${room.quantity} day(s) · ${room.description}`,
        documentValue: `${f.admissionDate.value} to ${f.dischargeDate.value} (${nights} night${nights === 1 ? "" : "s"})`,
        claimRef: `Claim line ${room.id}`,
        claimLineId: room.id,
        source: f.dischargeDate.source,
        amountAtRisk: atRisk,
        explanation: `The discharge summary supports at most ${nights + 1} billed day(s) (${nights} night${nights === 1 ? "" : "s"} plus the day of admission). ${excessDays} extra day(s) × ${inr(room.unitPrice || room.amount / room.quantity)} = ${inr(atRisk)}.`,
      });
    }
  }

  return out;
}
