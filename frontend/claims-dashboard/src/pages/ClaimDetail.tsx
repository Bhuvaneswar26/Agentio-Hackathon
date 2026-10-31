import { useState } from "react";
import {
  ArrowLeft,
  Check,
  CheckCircle2,
  FileQuestion,
  Pencil,
  Save,
  Search,
  Sparkles,
  X,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  EmptyState,
  PageHeader,
  Panel,
  QueueBadge,
  RiskPill,
  SeverityBadge,
} from "../components/ui";
import {
  findingLabel,
  formatDate,
  inr,
  queueLabel,
  severityBorder,
} from "../lib/format";
import { useAppStore } from "../store/useAppStore";
import { useToast } from "../store/useToast";
import type { Claim, ClaimNote, ClaimQueue } from "../types";
import type { FindingReviewAction } from "../lib/api";

const decisions: Array<{
  queue: ClaimQueue;
  label: string;
  hint: string;
  icon: LucideIcon;
  /** Matches the queue badge colour so a decision looks like the status it produces. */
  selected: string;
  hover: string;
  iconColor: string;
}> = [
  {
    queue: "good",
    label: "Good claim",
    hint: "Clear to settle",
    icon: CheckCircle2,
    selected: "border-emerald-500 bg-emerald-50 ring-2 ring-emerald-200",
    hover: "hover:border-emerald-400 hover:bg-emerald-50/50",
    iconColor: "text-emerald-600",
  },
  {
    queue: "unassessed",
    label: "Request documents",
    hint: "Evidence is incomplete",
    icon: FileQuestion,
    selected: "border-amber-500 bg-amber-50 ring-2 ring-amber-200",
    hover: "hover:border-amber-400 hover:bg-amber-50/50",
    iconColor: "text-amber-600",
  },
  {
    queue: "special",
    label: "Special review",
    hint: "Needs supervisor judgement",
    icon: Sparkles,
    selected: "border-violet-500 bg-violet-50 ring-2 ring-violet-200",
    hover: "hover:border-violet-400 hover:bg-violet-50/50",
    iconColor: "text-violet-600",
  },
];

const roleLabel = {
  handler: "Claims handler",
  supervisor: "Supervisor",
  executive: "Executive",
} as const;

function formatStamp(iso: string) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("en-IN", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function ClaimDetail() {
  const { id } = useParams();
  const claims = useAppStore((s) => s.claims);
  const claim = claims.find((c) => c.id === id);

  if (!claim) {
    return (
      <EmptyState
        title="Claim not on the desk"
        body="It may have been cleared from demo data. Go back to the workspace."
      />
    );
  }
  // Keyed so local drafts reset when moving between claims.
  return <ClaimView key={claim.id} claim={claim} claims={claims} />;
}

function DecisionPanel({ claim }: { claim: Claim }) {
  const { saveReview, moveQueue, role } = useAppStore();
  const push = useToast((s) => s.push);
  const [pick, setPick] = useState<ClaimQueue | null>(null);
  const [note, setNote] = useState("");
  const [savedAt, setSavedAt] = useState<string | null>(null);

  const readOnly = role === "executive";
  const choice = pick ?? claim.queue;
  const changed = choice !== claim.queue;
  const dirty = changed || note.trim().length > 0;

  const history: ClaimNote[] =
    claim.noteHistory ??
    (claim.notes
      ? [{ id: "legacy", at: "", by: "system", text: claim.notes }]
      : []);

  function save() {
    if (!dirty) return;
    const previous = claim.queue;
    saveReview(claim.id, { queue: choice, note });
    setNote("");
    setPick(null);
    setSavedAt(new Date().toISOString());
    push({
      tone: "success",
      message: changed
        ? `${claim.id} saved as “${queueLabel[choice]}”.`
        : `Note saved on ${claim.id}.`,
      action: changed
        ? {
            label: "Undo",
            onClick: () => {
              moveQueue(claim.id, previous, `Undo: restored ${previous}`);
              push({
                tone: "info",
                message: `${claim.id} restored to “${queueLabel[previous]}”.`,
              });
            },
          }
        : undefined,
    });
  }

  return (
    <Panel
      title="Your decision"
      action={
        <span
          className={`inline-flex items-center gap-1.5 text-xs ${dirty ? "text-amber-700" : "text-mute"}`}
        >
          <span
            className={`h-1.5 w-1.5 rounded-full ${dirty ? "bg-amber-500" : "bg-emerald-500"}`}
          />
          {dirty
            ? "Unsaved changes"
            : savedAt
              ? `Saved at ${formatStamp(savedAt)}`
              : "No pending changes"}
        </span>
      }
    >
      <div className="grid gap-5 lg:grid-cols-[3fr_2fr]">
        <div>
          <div
            className="grid gap-2 sm:grid-cols-3"
            role="radiogroup"
            aria-label="Claim decision"
          >
            {decisions.map((d) => {
              const Icon = d.icon;
              const selected = choice === d.queue;
              return (
                <button
                  key={d.queue}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  disabled={readOnly}
                  onClick={() => setPick(d.queue)}
                  className={`flex flex-col items-start gap-1 rounded-xl border p-3 text-left transition hover:-translate-y-0.5 disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:translate-y-0 ${
                    selected
                      ? d.selected
                      : `border-line bg-white ${d.hover}`
                  }`}
                >
                  <span className="flex items-center gap-2 text-sm font-medium">
                    <Icon
                      size={16}
                      className={selected ? d.iconColor : "text-mute"}
                    />
                    {d.label}
                  </span>
                  <span className="text-[11px] text-mute">
                    {selected && !changed ? "Current status" : d.hint}
                  </span>
                </button>
              );
            })}
          </div>
          {readOnly ? (
            <p className="mt-2 text-xs text-mute">
              Executive view is read-only on queue moves. You can still add a
              note.
            </p>
          ) : null}

          <label
            htmlFor="claim-note"
            className="mt-4 block text-xs font-medium text-mute"
          >
            {choice === "special"
              ? "Why does this need special review?"
              : "Note (optional)"}
          </label>
          <textarea
            id="claim-note"
            className="mt-1 w-full rounded-xl border border-line bg-mist p-3 text-sm outline-none focus:border-brand focus:bg-white"
            rows={3}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter") save();
            }}
            placeholder={`Add a ${roleLabel[role].toLowerCase()} note…`}
          />
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={save}
              disabled={!dirty}
              className="inline-flex items-center gap-2 rounded-full bg-ink px-5 py-2 text-sm font-medium text-white shadow-sm hover:bg-black disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Save size={15} />
              {changed ? `Save as ${queueLabel[choice]}` : "Save note"}
            </button>
            {dirty ? (
              <button
                type="button"
                className="text-sm text-mute hover:text-ink"
                onClick={() => {
                  setPick(null);
                  setNote("");
                }}
              >
                Discard
              </button>
            ) : null}
            <span className="ml-auto hidden text-[11px] text-mute sm:block">
              Ctrl + Enter to save
            </span>
          </div>
        </div>

        <div>
          <p className="mb-2 text-xs font-medium text-mute">
            Saved notes{history.length ? ` · ${history.length}` : ""}
          </p>
          {history.length === 0 ? (
            <p className="rounded-xl border border-dashed border-line px-3 py-6 text-center text-xs text-mute">
              No notes yet. Saved notes will appear here.
            </p>
          ) : (
            <ul className="max-h-56 space-y-2 overflow-y-auto pr-1">
              {history.map((n) => (
                <li key={n.id} className="rounded-xl bg-mist px-3 py-2 text-sm">
                  <p className="whitespace-pre-wrap">{n.text}</p>
                  <p className="mt-1 text-[11px] text-mute">
                    {n.by in roleLabel
                      ? roleLabel[n.by as keyof typeof roleLabel]
                      : n.by}
                    {n.at ? ` · ${formatStamp(n.at)}` : ""}
                    {n.queue ? ` · → ${queueLabel[n.queue]}` : ""}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </Panel>
  );
}

function ClaimView({ claim, claims }: { claim: Claim; claims: Claim[] }) {
  const navigate = useNavigate();
  const reviewFinding = useAppStore((s) => s.reviewFinding);
  const push = useToast((s) => s.push);
  const [correctedAmounts, setCorrectedAmounts] = useState<
    Record<string, string>
  >({});
  const [busyId, setBusyId] = useState<string | null>(null);

  const related = claims.filter((c) => claim.relatedClaimIds.includes(c.id));

  async function review(findingId: string, action: FindingReviewAction) {
    const raw = correctedAmounts[findingId];
    const amount = action === "CORRECT" ? Number(raw) : undefined;
    setBusyId(findingId);
    try {
      await reviewFinding(claim.id, findingId, action, undefined, amount);
      push({
        tone: "success",
        message:
          "Finding review saved" +
          (claim.analysisId ? " and totals recalculated." : "."),
      });
    } catch (error) {
      push({
        tone: "error",
        message:
          error instanceof Error
            ? error.message
            : "Could not save this finding review.",
      });
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div>
      <PageHeader
        eyebrow={claim.domain}
        title={claim.id}
        description={`${claim.claimant} · ${claim.provider} · ${claim.city}`}
        actions={
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              className="inline-flex items-center gap-1.5 text-sm text-mute hover:text-ink"
              onClick={() => navigate(-1)}
            >
              <ArrowLeft size={16} /> Back
            </button>
            <Link
              to={`/claims/${claim.id}/investigate`}
              className="inline-flex items-center gap-1.5 rounded-lg bg-ink px-3 py-2 text-xs font-medium text-white transition hover:bg-black"
            >
              <Search size={14} /> Open investigation workspace
            </Link>
          </div>
        }
      />

      <div className="mb-5 flex flex-wrap items-center gap-2">
        <QueueBadge queue={claim.queue} />
        <span className="inline-flex items-center gap-2 rounded-full bg-white px-3 py-1 text-xs">
          Risk <RiskPill score={claim.riskScore} />
        </span>
        <span className="rounded-full bg-white px-3 py-1 text-xs">
          Source {claim.sourceFormat} ·{" "}
          {Math.round(claim.extractionConfidence * 100)}%
        </span>
        <span className="text-xs text-mute">
          Filed {formatDate(claim.filedDate)} · incident{" "}
          {formatDate(claim.incidentDate)}
        </span>
        {claim.missingFields.length ? (
          <span className="rounded-full bg-amber-100 px-3 py-1 text-xs font-medium text-amber-800">
            Missing: {claim.missingFields.join(", ")}
          </span>
        ) : null}
      </div>

      <div className="mb-5">
        <DecisionPanel claim={claim} />
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <div className="rounded-2xl border border-line bg-white p-4">
          <p className="text-xs text-mute">Requested</p>
          <p className="mt-1 font-mono text-xl">{inr(claim.requestedAmount)}</p>
        </div>
        <div className="rounded-2xl border border-line bg-white p-4">
          <p className="text-xs text-mute">Proposed settlement</p>
          <p className="mt-1 font-mono text-xl">
            {inr(claim.proposedSettlement)}
          </p>
        </div>
        <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-4">
          <p className="text-xs text-emerald-800/80">
            Expected (counterfactual)
          </p>
          <p className="mt-1 font-mono text-xl text-emerald-800">
            {inr(claim.expectedSettlement)}
          </p>
        </div>
        <div
          className={`rounded-2xl border p-4 ${claim.confirmedLeakage > 0 ? "border-red-200 bg-red-50" : "border-line bg-white"}`}
        >
          <p
            className={`text-xs ${claim.confirmedLeakage > 0 ? "text-red-800/80" : "text-mute"}`}
          >
            Confirmed leakage
          </p>
          <p
            className={`mt-1 font-mono text-xl ${claim.confirmedLeakage > 0 ? "text-red-700" : ""}`}
          >
            {inr(claim.confirmedLeakage)}
          </p>
        </div>
        <div
          className={`rounded-2xl border p-4 ${claim.potentialLeakage > 0 ? "border-amber-200 bg-amber-50" : "border-line bg-white"}`}
        >
          <p
            className={`text-xs ${claim.potentialLeakage > 0 ? "text-amber-800/80" : "text-mute"}`}
          >
            Potential only
          </p>
          <p
            className={`mt-1 font-mono text-xl ${claim.potentialLeakage > 0 ? "text-amber-800" : ""}`}
          >
            {inr(claim.potentialLeakage)}
          </p>
        </div>
      </div>

      <div className="mt-5 grid gap-4 xl:grid-cols-2">
        <Panel
          title="Line items"
          action={
            <span className="text-xs text-mute">{claim.lines.length} rows</span>
          }
        >
          {claim.lines.length === 0 ? (
            <p className="text-sm text-mute">
              No lines extracted. Request the itemised invoice.
            </p>
          ) : (
            <ul className="space-y-2 text-sm">
              {claim.lines.map((l) => (
                <li
                  key={l.id}
                  className="flex justify-between gap-3 rounded-xl bg-mist px-3 py-2"
                >
                  <span>
                    {l.description}
                    <span className="block text-[11px] text-mute">
                      {l.code || l.invoiceRef}
                    </span>
                  </span>
                  <span className="font-mono">{inr(l.amount)}</span>
                </li>
              ))}
            </ul>
          )}
        </Panel>
        <Panel title="Policy rules applied">
          <ul className="space-y-3 text-sm">
            {claim.policyRules.map((r) => (
              <li key={r.id}>
                <p className="font-medium">{r.name}</p>
                <p className="text-xs text-mute">{r.clause}</p>
              </li>
            ))}
          </ul>
        </Panel>
      </div>

      <div className="mt-4 space-y-3">
        <h2 className="text-sm font-semibold">Explainable findings</h2>
        {claim.findings.length === 0 ? (
          <p className="rounded-2xl border border-line bg-white p-4 text-sm text-mute">
            No leakage findings. This is a good claim unless new evidence
            arrives.
          </p>
        ) : (
          claim.findings.map((f) => {
            const busy = busyId === f.id;
            return (
              <article
                key={f.id}
                className={`rounded-2xl border border-l-4 border-line bg-white p-4 transition hover:shadow-md ${severityBorder[f.severity]}`}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="font-medium">{f.title}</h3>
                  <SeverityBadge severity={f.severity} />
                  <span className="text-xs text-mute">
                    {findingLabel[f.kind]} · {f.engine} · {f.certainty}
                  </span>
                  {f.leakageAmount ? (
                    <span className="ml-auto font-mono text-sm">
                      {inr(f.leakageAmount)}
                    </span>
                  ) : null}
                </div>
                <p className="mt-2 text-sm text-mute">{f.explanation}</p>
                <ul className="mt-2 flex flex-wrap gap-2">
                  {f.evidence.map((e) => (
                    <li
                      key={e}
                      className="rounded-full bg-mist px-2 py-1 text-[11px]"
                    >
                      {e}
                    </li>
                  ))}
                </ul>
                <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-line pt-3">
                  <span className="mr-auto text-xs text-mute">
                    Review: {f.reviewStatus ?? "PENDING"}
                  </span>
                  <button
                    type="button"
                    title="Confirm finding"
                    aria-label="Confirm finding"
                    disabled={busy}
                    onClick={() => void review(f.id, "CONFIRM")}
                    className="inline-flex items-center gap-1 rounded-lg bg-red-600 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-50"
                  >
                    <Check size={14} /> Confirm leakage
                  </button>
                  <button
                    type="button"
                    title="Dismiss finding"
                    aria-label="Dismiss finding"
                    disabled={busy}
                    onClick={() => void review(f.id, "DISMISS")}
                    className="inline-flex items-center gap-1 rounded-lg border border-line px-2.5 py-1.5 text-xs disabled:opacity-50"
                  >
                    <X size={14} /> Dismiss
                  </button>
                  <button
                    type="button"
                    title="Request evidence"
                    aria-label="Request evidence"
                    disabled={busy}
                    onClick={() => void review(f.id, "REQUEST_EVIDENCE")}
                    className="inline-flex items-center gap-1 rounded-lg border border-line px-2.5 py-1.5 text-xs disabled:opacity-50"
                  >
                    <FileQuestion size={14} /> Request evidence
                  </button>
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={correctedAmounts[f.id] ?? String(f.leakageAmount)}
                    onChange={(event) =>
                      setCorrectedAmounts((values) => ({
                        ...values,
                        [f.id]: event.target.value,
                      }))
                    }
                    aria-label={`Corrected amount for ${f.title}`}
                    className="w-28 rounded-lg border border-line px-2 py-1.5 text-xs"
                  />
                  <button
                    type="button"
                    title="Save corrected amount"
                    aria-label="Save corrected amount"
                    disabled={busy}
                    onClick={() => void review(f.id, "CORRECT")}
                    className="inline-flex items-center gap-1 rounded-lg border border-line px-2.5 py-1.5 text-xs disabled:opacity-50"
                  >
                    <Pencil size={14} /> Correct
                  </button>
                </div>
              </article>
            );
          })
        )}
      </div>

      {related.length ? (
        <div className="mt-4">
          <Panel title="Related claims">
            <ul className="text-sm">
              {related.map((r) => (
                <li
                  key={r.id}
                  className="flex justify-between border-t border-line py-2 first:border-0"
                >
                  <Link
                    className="hover:text-brand-dark"
                    to={`/claims/${r.id}`}
                  >
                    {r.id} · {r.claimant}
                  </Link>
                  <QueueBadge queue={r.queue} />
                </li>
              ))}
            </ul>
          </Panel>
        </div>
      ) : null}
    </div>
  );
}
