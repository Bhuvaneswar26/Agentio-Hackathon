import {
  AlertTriangle,
  BookOpen,
  Check,
  FileText,
  HelpCircle,
  Library,
  Loader2,
  Quote,
  RefreshCw,
  ShieldAlert,
  Upload,
} from "lucide-react";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { EmptyState, PageHeader, Panel } from "../components/ui";
import { inr } from "../lib/format";
import { getMasterPolicy } from "../lib/masterPolicyApi";
import { readDocument } from "../lib/readDocument";
import {
  askPolicyQuestion,
  extractPolicyFromDocument,
  fetchRagStatus,
  providerKeyName,
  providerLabel,
  type PolicyAnswer,
  type PolicyExtraction,
  type RagStatus,
} from "../lib/policyRag";
import { useAppStore } from "../store/useAppStore";

const EXAMPLE_QUESTIONS = [
  "Is room rent capped?",
  "Are consumables payable?",
  "What is the co-payment?",
];

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
  const {
    agentUrl,
    policyFromDocument,
    setPolicyFromDocument,
    masterPolicies,
    loadMasterPolicies,
    addMasterPolicy,
    log,
  } = useAppStore();
  const [savedMasterId, setSavedMasterId] = useState<string | null>(null);
  const [progress, setProgress] = useState("");
  const [readInfo, setReadInfo] = useState("");
  const [readWarning, setReadWarning] = useState("");
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
    void loadMasterPolicies();
  }, [loadMasterPolicies]);

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
      setReadInfo("");
      setReadWarning("");
      const read = await readDocument(file, (page, total, stage) =>
        setProgress(`${stage === "ocr" ? "Scanning" : "Reading"} page ${page} of ${total}…`),
      );
      setText(read.text);
      setReadInfo(
        `Read ${read.pages ? `${read.pages} page${read.pages === 1 ? "" : "s"} · ` : ""}${read.text.length.toLocaleString("en-IN")} characters from ${file.name}`,
      );
      setReadWarning(read.warning ?? "");
      setSourceName(file.name);
      setResult(null);
      setAnswer(null);
      setSavedMasterId(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not read that file");
    } finally {
      setProgress("");
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
      setSavedMasterId(null);
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

  async function ask(override?: string) {
    const q = (override ?? question).trim();
    if (!q || !text.trim()) return;
    if (override !== undefined) setQuestion(override);
    setAsking(true);
    setError("");
    try {
      setAnswer(await askPolicyQuestion(agentUrl, text, q));
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
      masterId: savedMasterId ?? undefined,
    });
    log({
      actor: "Policy reader",
      action: "Applied document-derived policy terms to the ingest desk",
      detail: result.policy.policy_number,
    });
  }

  async function saveToMaster() {
    if (!result) return;
    setError("");
    setBusy(true);
    try {
      setSavedMasterId(
        await addMasterPolicy({
          sourceName:
            sourceName || `Pasted wording ${new Date().toLocaleString()}`,
          text,
          extraction: result,
        }),
      );
    } catch (err) {
      setError(
        err instanceof Error
          ? `Not saved to the master policy: ${err.message}`
          : "Not saved to the master policy",
      );
    } finally {
      setBusy(false);
    }
  }

  async function loadFromMaster(id: string) {
    if (!id) return;
    setError("");
    setBusy(true);
    try {
      // The list leaves the wording out to stay light, so fetch the full entry.
      const entry = await getMasterPolicy(agentUrl, id);
      setText(entry.text ?? "");
      setSourceName(entry.sourceName);
      setPolicyNumber(entry.policyNumber);
      setResult(entry.extraction);
      setAnswer(null);
      setSavedMasterId(entry.id);
    } catch (err) {
      setError(
        err instanceof Error
          ? `Could not load that policy: ${err.message}`
          : "Could not load that policy",
      );
    } finally {
      setBusy(false);
    }
  }

  const llmName = providerLabel(ragStatus?.llm_extraction?.provider);
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
            {llmName}{" "}
            {ragStatus?.llm_extraction?.status === "AVAILABLE"
              ? "ready"
              : "not configured"}
            {ragStatus?.llm_extraction?.model
              ? ` · ${ragStatus.llm_extraction.model}`
              : ""}
            {ragStatus?.llm_extraction?.framework === "langchain"
              ? " · via LangChain"
              : ""}
          </p>
          <p className="mt-0.5 text-xs">
            {ragStatus?.llm_extraction?.status === "AVAILABLE"
              ? "Policy answers use retrieved clauses as context and require clause citations. Guardrails decline questions that are not about the policy document."
              : `Set ${providerKeyName(ragStatus?.llm_extraction?.provider)} in services/detection-agent/.env (never in the frontend or chat), then restart the backend. Retrieval-only clause answers remain available.`}
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
            {masterPolicies.length ? (
              <select
                value=""
                onChange={(e) => void loadFromMaster(e.target.value)}
                disabled={busy}
                aria-label="Load a policy from the master policy"
                className="mb-3 w-full rounded-xl border border-line bg-white px-3 py-2 text-sm text-ink outline-none focus:border-brand"
              >
                <option value="">
                  Load from master policy ({masterPolicies.length})…
                </option>
                {masterPolicies.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} · {p.sourceName}
                  </option>
                ))}
              </select>
            ) : null}
            <label className="flex cursor-pointer flex-col items-center gap-2 rounded-xl border border-dashed border-line bg-mist/40 px-4 py-6 text-center transition hover:border-brand">
              <Upload className="h-5 w-5 text-brand-dark" />
              <span className="text-sm font-medium text-ink">
                Upload a policy wording
              </span>
              <span className="text-xs text-mute">
                {progress ||
                  "PDF, text, markdown or a scan (OCR runs in the browser)"}
              </span>
              <input
                type="file"
                className="hidden"
                accept=".pdf,.txt,.md,.csv,.png,.jpg,.jpeg,.webp"
                onChange={(e) => void onFile(e.target.files)}
              />
            </label>

            {readInfo ? (
              <p className="mt-3 text-xs text-brand-dark" role="status">
                {readInfo}
              </p>
            ) : null}
            {readWarning ? (
              <p className="mt-1 text-xs text-amber-800" role="alert">
                {readWarning}
              </p>
            ) : null}

            <textarea
              value={text}
              onChange={(e) => {
                setText(e.target.value);
                setResult(null);
                setReadInfo("");
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
              {llmName} runs over retrieved clauses and must cite the policy
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
              answer.out_of_scope ? (
                <div
                  className="mt-3 rounded-xl border border-amber-300 bg-amber-50 p-3"
                  role="status"
                >
                  <p className="flex items-center gap-1.5 text-xs font-semibold text-amber-900">
                    <ShieldAlert className="h-3.5 w-3.5" />
                    {answer.scope_category === "prompt_injection"
                      ? "Declined · instruction override"
                      : "Out of scope"}
                  </p>
                  <p className="mt-1 text-sm text-amber-950">{answer.reason}</p>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {EXAMPLE_QUESTIONS.map((example) => (
                      <button
                        key={example}
                        type="button"
                        onClick={() => void ask(example)}
                        disabled={asking}
                        className="rounded-full border border-amber-300 bg-white px-2.5 py-1 text-xs text-amber-900 transition hover:bg-amber-100 disabled:opacity-50"
                      >
                        {example}
                      </button>
                    ))}
                  </div>
                </div>
              ) : answer.answered && answer.answer ? (
                <div className="mt-3 rounded-xl border border-brand/40 bg-brand/10 p-3">
                  <p className="text-xs font-semibold text-brand-dark">
                    {providerLabel(answer.provider ?? ragStatus?.llm_extraction?.provider)} answer
                    {answer.model ? ` · ${answer.model}` : ""}
                  </p>
                  <p className="mt-1 whitespace-pre-wrap text-sm text-ink">
                    {answer.answer}
                  </p>
                  {answer.stated_in_policy === false ? (
                    <p className="mt-1 text-xs text-amber-800">
                      The policy wording does not state this, so nothing is
                      cited.
                    </p>
                  ) : null}
                  {answer.cited_clauses?.length ? (
                    <p className="mt-2 flex flex-wrap items-center gap-1.5 text-xs text-mute">
                      Based on
                      {answer.cited_clauses.map((id) => (
                        <span
                          key={id}
                          className="rounded-full bg-white px-2 py-0.5 font-mono text-[11px] text-brand-dark"
                        >
                          clause {id}
                        </span>
                      ))}
                    </p>
                  ) : null}
                </div>
              ) : answer.answered ? (
                // The model did not answer. Say why; the retrieved clause text is deliberately not shown.
                <div
                  className="mt-3 rounded-xl border border-amber-300 bg-amber-50 p-3"
                  role="alert"
                >
                  <p className="flex items-center gap-1.5 text-xs font-semibold text-amber-900">
                    <AlertTriangle className="h-3.5 w-3.5" />
                    {providerLabel(answer.provider ?? ragStatus?.llm_extraction?.provider)} could not answer
                  </p>
                  <p className="mt-1 text-sm text-amber-950">
                    {answer.llm_error?.message ??
                      answer.llm_notice ??
                      `${providerLabel(answer.provider ?? ragStatus?.llm_extraction?.provider)} could not complete this request.`}
                  </p>
                  <button
                    type="button"
                    onClick={() => void ask()}
                    disabled={asking}
                    className="mt-2 inline-flex items-center gap-1.5 rounded-lg border border-amber-300 bg-white px-2.5 py-1 text-xs font-medium text-amber-900 transition hover:bg-amber-100 disabled:opacity-50"
                  >
                    {asking ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <RefreshCw className="h-3 w-3" />
                    )}
                    Try again
                  </button>
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
                  <div className="flex items-center gap-2">
                    {savedMasterId ? (
                      <Link
                        to="/master-policy"
                        className="inline-flex items-center gap-1.5 rounded-lg border border-line px-3 py-1.5 text-xs font-medium text-brand-dark transition hover:border-brand"
                      >
                        <Check className="h-3.5 w-3.5" />
                        In master policy
                      </Link>
                    ) : (
                      <button
                        type="button"
                        onClick={() => void saveToMaster()}
                        disabled={busy}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-line px-3 py-1.5 text-xs font-medium text-ink transition hover:border-brand"
                      >
                        <Library className="h-3.5 w-3.5" />
                        Add to master policy
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={applyToIngest}
                      className="inline-flex items-center gap-1.5 rounded-lg bg-brand px-3 py-1.5 text-xs font-medium text-ink transition hover:bg-brand/80"
                    >
                      <Check className="h-3.5 w-3.5" />
                      Use for next ingest
                    </button>
                  </div>
                }
              >
                <div className="mb-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-mute">
                  <span>{result.document.chunks} chunks</span>
                  <span>{result.document.clauses_detected} clauses</span>
                  <span>{result.facts.length} cited facts</span>
                  <span>
                    {llmName} pass:{" "}
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
