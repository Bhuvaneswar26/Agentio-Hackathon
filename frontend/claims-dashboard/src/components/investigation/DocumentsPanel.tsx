import { FileText, Loader2, Upload } from "lucide-react";
import { useRef, useState } from "react";
import { DEMO_DOCUMENTS } from "../../data/investigationDemo";
import { inr } from "../../lib/format";
import { readDocumentText } from "../../lib/readDocument";
import { useAppStore } from "../../store/useAppStore";
import { useToast } from "../../store/useToast";
import type { Claim, DocumentEvidence, DocumentFields, SourceRef } from "../../types";
import { SourceChip } from "./EvidenceDrawer";

const FIELD_LABEL: Record<keyof DocumentFields, string> = {
  invoiceNumber: "Invoice / estimate no.",
  policyNumber: "Policy number",
  claimId: "Claim id",
  person: "Patient / owner",
  provider: "Hospital / garage",
  documentDate: "Document date",
  admissionDate: "Admission",
  dischargeDate: "Discharge",
  totalAmount: "Total amount",
  diagnosis: "Diagnosis",
  procedure: "Procedure",
  vehicle: "Vehicle",
};

const KIND_LABEL: Record<DocumentEvidence["kind"], string> = {
  invoice: "Invoice",
  discharge_summary: "Discharge summary",
  repair_estimate: "Repair estimate",
  other: "Other document",
};

function DocumentCard({ doc, onInspect }: { doc: DocumentEvidence; onInspect: (source: SourceRef) => void }) {
  const [open, setOpen] = useState(true);
  const fields = (Object.keys(FIELD_LABEL) as Array<keyof DocumentFields>).flatMap((key) => {
    const f = doc.fields[key];
    return f ? [{ key, label: FIELD_LABEL[key], value: key === "totalAmount" ? inr(f.value as number) : String(f.value), source: f.source }] : [];
  });

  return (
    <article className="rounded-xl border border-line bg-white">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-3 py-2.5 text-left"
      >
        <FileText className="h-4 w-4 shrink-0 text-sky-700" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-ink">{doc.name}</span>
          <span className="text-[11px] text-mute">
            {KIND_LABEL[doc.kind]} · {fields.length} fields · {doc.lineItems.length} line items · added by {doc.addedBy}
          </span>
        </span>
        <span className="text-xs text-mute">{open ? "Hide" : "Show"}</span>
      </button>
      {open ? (
        <div className="space-y-3 border-t border-line px-3 py-3">
          {fields.length ? (
            <table className="w-full text-left text-xs">
              <thead className="text-mute">
                <tr>
                  <th className="pb-1 font-medium">Field</th>
                  <th className="pb-1 font-medium">Value</th>
                  <th className="pb-1 font-medium">Source</th>
                </tr>
              </thead>
              <tbody>
                {fields.map((f) => (
                  <tr key={f.key} className="border-t border-line align-top">
                    <td className="py-1.5 pr-2 text-mute">{f.label}</td>
                    <td className="py-1.5 pr-2 font-medium text-ink">{f.value}</td>
                    <td className="py-1.5"><SourceChip source={f.source} onInspect={onInspect} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="text-xs text-mute">No labelled fields were recognised in this document.</p>
          )}
          {doc.lineItems.length ? (
            <table className="w-full text-left text-xs">
              <thead className="text-mute">
                <tr>
                  <th className="pb-1 font-medium">Line item</th>
                  <th className="pb-1 text-right font-medium">Qty</th>
                  <th className="pb-1 text-right font-medium">Amount</th>
                  <th className="pb-1 pl-2 font-medium">Source</th>
                </tr>
              </thead>
              <tbody>
                {doc.lineItems.map((l, i) => (
                  <tr key={`${l.source.line}-${i}`} className="border-t border-line align-top">
                    <td className="py-1.5 pr-2 text-ink">{l.description}</td>
                    <td className="py-1.5 text-right font-mono">{l.quantity ?? "—"}</td>
                    <td className="py-1.5 text-right font-mono">{inr(l.amount)}</td>
                    <td className="py-1.5 pl-2"><SourceChip source={l.source} onInspect={onInspect} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
          <button
            type="button"
            onClick={() => onInspect({ documentId: doc.id, documentName: doc.name, line: 1, snippet: "" })}
            className="text-xs font-medium text-sky-700 hover:underline"
          >
            Read the full document
          </button>
        </div>
      ) : null}
    </article>
  );
}

/** Attach supporting documents and see everything read from them, each value tied to its source line. */
export function DocumentsPanel({
  claim,
  locked,
  onInspect,
}: {
  claim: Claim;
  locked: boolean;
  onInspect: (source: SourceRef) => void;
}) {
  const attachDocument = useAppStore((s) => s.attachDocument);
  const push = useToast((s) => s.push);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const input = useRef<HTMLInputElement | null>(null);
  const docs = claim.documents ?? [];
  const samples = (DEMO_DOCUMENTS[claim.id] ?? []).filter((s) => !docs.some((d) => d.name === s.name));

  async function add(name: string, read: () => Promise<string>) {
    setBusy(name);
    setError("");
    try {
      attachDocument(claim.id, { name, text: await read() });
      push({ tone: "success", message: `${name} added. Differences with the claim are listed below.` });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not read that document.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-3">
      {locked ? null : (
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => input.current?.click()}
            disabled={busy !== null}
            className="inline-flex items-center gap-1.5 rounded-lg bg-ink px-3 py-1.5 text-xs font-medium text-white transition hover:bg-black disabled:opacity-50"
          >
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
            Attach a document
          </button>
          <input
            ref={input}
            type="file"
            className="hidden"
            accept=".pdf,.txt,.md,.png,.jpg,.jpeg,.webp"
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (file) void add(file.name, () => readDocumentText(file));
            }}
          />
          {samples.map((s) => (
            <button
              key={s.name}
              type="button"
              disabled={busy !== null}
              onClick={() =>
                void add(s.name, async () => {
                  const res = await fetch(s.url);
                  if (!res.ok) throw new Error(`Could not load the sample (HTTP ${res.status}).`);
                  return res.text();
                })
              }
              className="rounded-lg border border-line bg-white px-2.5 py-1.5 text-xs font-medium text-ink transition hover:border-sky-300 hover:bg-sky-50 disabled:opacity-50"
            >
              Attach sample: {s.label}
            </button>
          ))}
        </div>
      )}
      {error ? <p className="text-xs font-medium text-red-700" role="alert">{error}</p> : null}
      {docs.length === 0 ? (
        <p className="rounded-xl border border-dashed border-line px-3 py-6 text-center text-xs text-mute">
          No supporting documents yet. Attach an invoice, discharge summary or repair estimate and the app will
          compare it with this claim.
        </p>
      ) : (
        docs.map((d) => <DocumentCard key={d.id} doc={d} onInspect={onInspect} />)
      )}
    </div>
  );
}
