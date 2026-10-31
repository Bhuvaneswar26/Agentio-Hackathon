import {
  AlertTriangle,
  BookOpen,
  Check,
  FileText,
  HelpCircle,
  Loader2,
  Quote,
  Upload,
} from "lucide-react";
import { useEffect, useState } from "react";
import { EmptyState, PageHeader, Panel } from "../components/ui";
import { extractFromFile } from "../lib/extract";
import { inr } from "../lib/format";
import {
  askPolicyQuestion,
  extractPolicyFromDocument,
  fetchRagStatus,
  type PolicyAnswer,
  type PolicyExtraction,
  type RagStatus,
} from "../lib/policyRag";
import { useAppStore } from "../store/useAppStore";

/** Read the document's plain text. PDFs and images reuse the ingest extractor (pdf.js / Tesseract). */
async function readDocument(file: File): Promise<string> {
  const name = file.name.toLowerCase();
  if (name.endsWith(".txt") || name.endsWith(".md") || name.endsWith(".csv")) {
    return file.text();
  }
  const payload = await extractFromFile(file);
  const raw = payload.extraction.rawText;
  if (!raw || raw.replace(/\s/g, "").length < 40) {
    throw new Error(
      "No readable text came out of that file. If it is a scanned policy, try a clearer scan.",
    );
  }
  return raw;
}

function Confidence({ value }: { value: number }) {
  const pct = Math.round(value * 100);
  const tone =
    pct >= 80
      ? "bg-brand/20 text-[#0b6b45]"
      : pct >= 60
        ? "bg-mist text-ink"
        : "bg-white border border-line text-mute";
  return (
    <span
      className={`inline-flex rounded-full px-2 py-0.5 font-mono text-[11px] ${tone}`}
    >
      {pct}%
    </span>
  );
}

function CitedRow({
  label,
  value,
  citation,
  confidence,
  snippet,
}: {
  label: string;
  value: string;
  citation?: string;
  confidence?: number;
  snippet?: string;
}) {
  return (
    <div className="border-b border-line py-2.5 last:border-0">
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-sm text-mute">{label}</p>
        <div className="flex items-center gap-2">
          <p className="font-mono text-sm font-semibold text-ink">{value}</p>
          {confidence != null ? <Confidence value={confidence} /> : null}
        </div>
      </div>
      {citation ? (
        <p className="mt-1 text-xs text-brand-dark">
          <Quote className="mr-1 inline h-3 w-3" />
          {citation}
        </p>
      ) : null}
      {snippet ? (
        <p className="mt-1 line-clamp-2 text-xs italic text-mute">
          “{snippet}”
        </p>
      ) : null}
    </div>
  );
}

export function PolicyReader() {
  const { agentUrl, policyFromDocument, setPolicyFromDocument, log } =
    useAppStore();
  const [text, setText] = useState("");
  const [sourceName, setSourceName] = useState("");
  const [policyNumber, setPolicyNumber] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<PolicyExtraction | null>(null);
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState<PolicyAnswer | null>(null);
  const [asking, setAsking] = useState(false);
  const [ragStatus, setRagStatus] = useState<RagStatus | null>(null);

  useEffect(() => {
    let active = true;
    void fetchRagStatus(agentUrl)
      .then((status) => {
        if (active) setRagStatus(status);
      })
      .catch(() => {
        if (active) setRagStatus(null);
      });
    return () => {
      active = false;
    };
  }, [agentUrl]);

  async function onFile(files: FileList | null) {
    const file = files?.[0];
    if (!file) return;
    setError("");
    setBusy(true);
    try {
      const content = await readDocument(file);
      setText(content);
      setSourceName(file.name);
      setResult(null);
      setAnswer(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not read that file");
    } finally {
      setBusy(false);
    }
  }

  async function runExtraction() {
    if (!text.trim()) {
      setError("Paste the policy wording or upload a document first.");
      return;
    }
    setError("");
    setBusy(true);
    try {
      const res = await extractPolicyFromDocument(agentUrl, text, {
        policyNumber: policyNumber || undefined,
        policyType: "HEALTH",
        useLlm: true,
      });
      setResult(res);
      log({
        actor: "Policy reader",
        action: "Extracted policy terms from a document",
        detail: `${sourceName || "pasted text"} · ${res.facts.length} cited facts · ${res.conflicts.length} conflict(s)`,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Extraction failed");
    } finally {
      setBusy(false);
    }
  }

  async function ask() {
    if (!question.trim() || !text.trim()) return;
    setAsking(true);
    setError("");
    try {
      setAnswer(await askPolicyQuestion(agentUrl, text, question));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Lookup failed");
    } finally {
      setAsking(false);
    }
  }

  function applyToIngest() {
    if (!result) return;
    setPolicyFromDocument({
      policy: result.policy,
      sourceName: sourceName || "pasted policy wording",
    });
    log({
      actor: "Policy reader",
      action: "Applied document-derived policy terms to the ingest desk",
      detail: result.policy.policy_number,
    });
  }

  const policy = result?.policy;
  const cites = (policy?.extraction_citations ?? {}) as Record<
    string,
    { citation?: string; confidence?: number; snippet?: string }
  >;

  return (
    <div>
      <PageHeader
        eyebrow="Policy intelligence"
        title="Read a policy document"
        description="Upload or paste a policy wording. The engine retrieves the governing clauses and extracts the deductible, co-payment, sum insured, sub-limits, exclusions and waiting periods — each one cited back to the clause it came from. Terms the document does not state are reported as unresolved, never assumed."
      />

      <div
        className={`mb-4 flex items-start gap-2 rounded-xl border px-4 py-3 text-sm ${ragStatus?.llm_extraction?.status === "AVAILABLE" ? "border-brand/40 bg-brand/10" : "border-amber-200 bg-amber-50"}`}
        role="status"
      >
        <HelpCircle className="mt-0.5 h-4 w-4 shrink-0" />
        <div>
          <p className="font-medium">
            Gemini{" "}
            {ragStatus?.llm_extraction?.status === "AVAILABLE"
              ? "ready"
              : "not configured"}
            {ragStatus?.llm_extraction?.model
              ? ` · ${ragStatus.llm_extraction.model}`
              : ""}
          </p>
          <p className="mt-0.5 text-xs">
            {ragStatus?.llm_extraction?.status === "AVAILABLE"
              ? "Policy answers use retrieved clauses as context and require clause citations."
              : "Set GEMINI_API_KEY in services/detection-agent/.env (never in the frontend or chat), then restart the backend. Retrieval-only clause answers remain available."}
          </p>
        </div>
      </div>

      {error ? (
        <div className="mb-4 flex items-start gap-2 rounded-xl border border-line bg-white px-4 py-3 text-sm text-ink">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-brand-dark" />
          <span>{error}</span>
        </div>
      ) : null}

      <div className="grid gap-4 xl:grid-cols-5">
        {/* ---------------------------------------------------------------- input */}
        <div className="space-y-4 xl:col-span-2">
          <Panel title="Policy document">
            <label className="flex cursor-pointer flex-col items-center gap-2 rounded-xl border border-dashed border-line bg-mist/40 px-4 py-6 text-center transition hover:border-brand">
              <Upload className="h-5 w-5 text-brand-dark" />
              <span className="text-sm font-medium text-ink">
                Upload a policy wording
              </span>
              <span className="text-xs text-mute">
                PDF, text, markdown or a scan (OCR runs in the browser)
              </span>
              <input
                type="file"
                className="hidden"
                accept=".pdf,.txt,.md,.csv,.png,.jpg,.jpeg,.webp"
                onChange={(e) => void onFile(e.target.files)}
              />
            </label>

            <textarea
              value={text}
              onChange={(e) => {
                setText(e.target.value);
                setResult(null);
              }}
              rows={12}
              placeholder={
                "…or paste the policy wording here, for example:\n\nSECTION 2 - SUB-LIMITS\n2.1 Room Rent\n    Room rent is payable up to Rs. 5,000 per day of hospitalisation."
              }
              className="mt-3 w-full rounded-xl border border-line bg-white px-3 py-2 font-mono text-xs text-ink outline-none focus:border-brand"
            />

            <div className="mt-3 grid gap-2 sm:grid-cols-2">
              <input
                value={policyNumber}
                onChange={(e) => setPolicyNumber(e.target.value)}
                placeholder="Policy number (optional)"
                className="rounded-xl border border-line bg-white px-3 py-2 text-sm outline-none focus:border-brand"
              />
            </div>
            <p className="mt-1 text-xs text-mute">
              Gemini runs over retrieved clauses and must cite the policy
              wording. The rule-based extraction also runs, and the engine key
              stays on the backend.
            </p>

            <button
              type="button"
              onClick={() => void runExtraction()}
              disabled={busy || !text.trim()}
              className="mt-3 inline-flex w-full items-center justify-center gap-2 rounded-xl bg-ink px-4 py-2.5 text-sm font-medium text-white transition hover:bg-ink/90 disabled:opacity-50"
            >
              {busy ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <BookOpen className="h-4 w-4" />
              )}
              Extract policy terms
            </button>
          </Panel>

          <Panel title="Ask the document">
            <div className="flex gap-2">
              <input
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void ask();
                }}
                placeholder="Are consumables payable?"
                className="flex-1 rounded-xl border border-line bg-white px-3 py-2 text-sm outline-none focus:border-brand"
              />
              <button
                type="button"
                onClick={() => void ask()}
                disabled={asking || !text.trim() || !question.trim()}
                className="inline-flex items-center gap-1.5 rounded-xl border border-line px-3 py-2 text-sm font-medium text-ink transition hover:border-brand disabled:opacity-50"
              >
                {asking ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <HelpCircle className="h-4 w-4" />
                )}
                Ask
              </button>
            </div>
            {answer ? (
              answer.answered ? (
                <div className="mt-3 space-y-2">
                  {answer.clauses.slice(0, 3).map((c) => (
                    <div
                      key={c.citation + c.text.slice(0, 20)}
                      className="rounded-xl border border-line bg-mist/30 p-3"
                    >
                      <p className="text-xs font-medium text-brand-dark">
                        {c.citation}
                      </p>
                      <p className="mt-1 whitespace-pre-wrap text-xs text-ink">
                        {c.text}
                      </p>
                    </div>
                  ))}
                  {answer.answer ? (
                    <div className="rounded-xl border border-brand/40 bg-brand/10 p-3">
                      <p className="text-xs font-semibold text-brand-dark">
                        {answer.answer_source === "retrieval_fallback"
                          ? "Retrieved policy answer · Gemini unavailable"
                          : answer.answer_source === "retrieval"
                            ? "Retrieved policy answer"
                            : `Gemini answer${answer.model ? ` · ${answer.model}` : ""}`}
                      </p>
                      <p className="mt-1 whitespace-pre-wrap text-sm text-ink">
                        {answer.answer}
                      </p>
                      {answer.cited_clauses?.length ? (
                        <p className="mt-1 text-xs text-mute">
                          Cited clauses: {answer.cited_clauses.join(", ")}
                        </p>
                      ) : null}
                    </div>
                  ) : null}
                  {answer.llm_notice ? (
                    <p className="text-xs text-amber-800" role="status">
                      {answer.llm_notice}
                    </p>
                  ) : null}
                  <p className="text-xs text-mute">
                    Answers use retrieved clauses only; the original wording is
                    quoted above for verification.
                  </p>
                </div>
              ) : (
                <p className="mt-3 text-sm text-mute">
                  {answer.reason ?? "Nothing in the document matched."}
                </p>
              )
            ) : null}
          </Panel>
        </div>

        {/* ---------------------------------------------------------------- results */}
        <div className="space-y-4 xl:col-span-3">
          {!result ? (
            <EmptyState
              title="No document read yet"
              body="Upload or paste a policy wording and run the extraction. Every value that comes back will name the clause it was read from."
            />
          ) : (
            <>
              <Panel
                title="Extracted terms"
                action={
                  <button
                    type="button"
                    onClick={applyToIngest}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-brand px-3 py-1.5 text-xs font-medium text-ink transition hover:bg-brand/80"
                  >
                    <Check className="h-3.5 w-3.5" />
                    Use for next ingest
                  </button>
                }
              >
                <div className="mb-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-mute">
                  <span>{result.document.chunks} chunks</span>
                  <span>{result.document.clauses_detected} clauses</span>
                  <span>{result.facts.length} cited facts</span>
                  <span>
                    Gemini pass:{" "}
                    {result.llm_extraction.status
                      .toLowerCase()
                      .replace(/_/g, " ")}
                  </span>
                </div>

                {policy?.deductible != null ? (
                  <CitedRow
                    label="Deductible"
                    value={inr(policy.deductible)}
                    citation={cites.deductible?.citation}
                    confidence={cites.deductible?.confidence}
                    snippet={cites.deductible?.snippet}
                  />
                ) : null}
                {policy?.copayment_percentage != null ? (
                  <CitedRow
                    label="Co-payment"
                    value={`${policy.copayment_percentage}%`}
                    citation={cites.copayment_percentage?.citation}
                    confidence={cites.copayment_percentage?.confidence}
                    snippet={cites.copayment_percentage?.snippet}
                  />
                ) : null}
                {policy?.sum_insured != null ? (
                  <CitedRow
                    label="Sum insured"
                    value={inr(policy.sum_insured)}
                    citation={cites.sum_insured?.citation}
                    confidence={cites.sum_insured?.confidence}
                    snippet={cites.sum_insured?.snippet}
                  />
                ) : null}
                {(policy?.sublimits ?? []).map((s) => (
                  <CitedRow
                    key={`${s.category}-${s.daily_limit ?? s.limit}`}
                    label={`${s.category.replace(/_/g, " ")} ${s.daily_limit != null ? "(per day)" : "(per year)"}`}
                    value={inr(s.daily_limit ?? s.limit ?? 0)}
                    citation={s.clause_reference}
                  />
                ))}
                {(policy?.waiting_periods ?? []).map((w) => (
                  <CitedRow
                    key={`wp-${w.days}-${w.category ?? "all"}`}
                    label={`Waiting period${w.category ? ` — ${w.category}` : " (policy-wide)"}`}
                    value={`${w.days} days`}
                    citation={w.clause_reference}
                  />
                ))}
              </Panel>

              {(policy?.exclusions ?? []).length ? (
                <Panel title={`Exclusions (${policy?.exclusions?.length})`}>
                  <ul className="space-y-2">
                    {policy?.exclusions?.map((e) => (
                      <li
                        key={e.description.slice(0, 40)}
                        className="rounded-xl border border-line p-3"
                      >
                        <p className="text-xs font-semibold uppercase tracking-wide text-brand-dark">
                          {e.category.replace(/_/g, " ")}
                        </p>
                        <p className="mt-1 text-sm text-ink">{e.description}</p>
                        {e.clause_reference ? (
                          <p className="mt-1 text-xs text-mute">
                            {e.clause_reference}
                          </p>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                </Panel>
              ) : null}

              {result.conflicts.length ? (
                <Panel
                  title={`Conflicting clauses (${result.conflicts.length}) — needs a decision`}
                >
                  {result.conflicts.map((c) => (
                    <div
                      key={c.field + String(c.category)}
                      className="mb-3 rounded-xl border border-ink/20 bg-mist/40 p-3 last:mb-0"
                    >
                      <p className="text-sm font-semibold text-ink">
                        {c.field.replace(/[._]/g, " ")}
                        {c.category ? ` — ${c.category}` : ""}
                      </p>
                      <p className="mt-1 text-xs text-mute">{c.reason}</p>
                      <ul className="mt-2 space-y-1">
                        {c.candidates.map((cand) => (
                          <li
                            key={cand.citation + String(cand.value)}
                            className="flex items-center justify-between gap-2 text-xs"
                          >
                            <span className="text-brand-dark">
                              {cand.citation}
                            </span>
                            <span className="font-mono font-semibold text-ink">
                              {String(cand.value)}
                            </span>
                          </li>
                        ))}
                      </ul>
                      <p className="mt-2 text-xs font-medium text-ink">
                        {c.action_required}
                      </p>
                    </div>
                  ))}
                </Panel>
              ) : null}

              {(policy?.waiting_periods_requiring_review ?? []).length ? (
                <Panel title="Held back for review">
                  {policy?.waiting_periods_requiring_review?.map((w) => (
                    <div
                      key={w.citation}
                      className="mb-2 rounded-xl border border-line p-3 last:mb-0"
                    >
                      <p className="text-sm font-medium text-ink">
                        {w.days}-day waiting period
                      </p>
                      <p className="mt-1 text-xs text-brand-dark">
                        {w.citation}
                      </p>
                      <p className="mt-1 text-xs text-mute">{w.reason}</p>
                      <p className="mt-1 text-xs italic text-mute">
                        {w.engine_behaviour}
                      </p>
                    </div>
                  ))}
                </Panel>
              ) : null}

              {result.unresolved.length ? (
                <Panel
                  title={`Not stated in this document (${result.unresolved.length})`}
                >
                  <ul className="space-y-2">
                    {result.unresolved.map((u) => (
                      <li
                        key={u.field}
                        className="rounded-xl border border-dashed border-line p-3"
                      >
                        <p className="text-sm font-medium text-ink">
                          {u.field.replace(/_/g, " ")}
                        </p>
                        <p className="mt-0.5 text-xs text-mute">{u.reason}</p>
                        <p className="mt-0.5 text-xs italic text-mute">
                          {u.engine_behaviour}
                        </p>
                      </li>
                    ))}
                  </ul>
                </Panel>
              ) : null}
            </>
          )}

          {policyFromDocument ? (
            <div className="flex items-start gap-2 rounded-xl border border-brand bg-brand/10 px-4 py-3 text-sm text-ink">
              <FileText className="mt-0.5 h-4 w-4 shrink-0 text-brand-dark" />
              <span>
                Terms from <strong>{policyFromDocument.sourceName}</strong> are
                armed for the next ingest. The claim you send next will be
                assessed against these clauses.
              </span>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
