import { ArrowRight, Check, FileQuestion, Flag, ShieldAlert, Undo2 } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";
import { SeverityBadge } from "../ui";
import { inr, severityBorder } from "../../lib/format";
import { decisionLabel, escalationLabel, type Issue } from "../../lib/investigation";
import { useAppStore } from "../../store/useAppStore";
import { useToast } from "../../store/useToast";
import type { Decision, DecisionType, EscalationTarget, SourceRef } from "../../types";
import { SourceChip } from "./EvidenceDrawer";

const SOURCE_LABEL: Record<Issue["source"], string> = {
  finding: "Engine finding",
  document: "Document difference",
  correlation: "Linked claim",
  calculation: "Settlement calculation",
};

const STATUS_TONE: Record<DecisionType, string> = {
  CONFIRM_DISCREPANCY: "bg-red-100 text-red-800",
  FALSE_POSITIVE: "bg-slate-200 text-slate-700",
  REQUEST_EVIDENCE: "bg-amber-100 text-amber-800",
  ESCALATE: "bg-violet-100 text-violet-800",
  ACCEPT_CORRECTION: "bg-emerald-100 text-emerald-800",
};

const ACTIONS: Array<{ type: DecisionType; label: string; icon: typeof Check; tone: string }> = [
  { type: "CONFIRM_DISCREPANCY", label: "Confirm discrepancy", icon: Check, tone: "hover:border-red-300 hover:bg-red-50" },
  { type: "FALSE_POSITIVE", label: "False positive", icon: Undo2, tone: "hover:border-slate-400 hover:bg-slate-50" },
  { type: "REQUEST_EVIDENCE", label: "Request evidence", icon: FileQuestion, tone: "hover:border-amber-300 hover:bg-amber-50" },
  { type: "ESCALATE", label: "Escalate", icon: Flag, tone: "hover:border-violet-300 hover:bg-violet-50" },
  { type: "ACCEPT_CORRECTION", label: "Accept correction", icon: ShieldAlert, tone: "hover:border-emerald-300 hover:bg-emerald-50" },
];

function stamp(iso: string) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
}

/** One issue: what was found, the recommended correction with its arithmetic, and the decision controls. */
export function IssueCard({
  issue,
  claimId,
  decisions,
  locked,
  onInspect,
}: {
  issue: Issue;
  claimId: string;
  /** Every decision recorded on this issue, oldest first. */
  decisions: Decision[];
  locked: boolean;
  onInspect: (source: SourceRef) => void;
}) {
  const recordDecision = useAppStore((s) => s.recordDecision);
  const push = useToast((s) => s.push);
  const [mode, setMode] = useState<DecisionType | null>(null);
  const [reason, setReason] = useState("");
  const [target, setTarget] = useState<EscalationTarget>("SENIOR_REVIEWER");
  const [amount, setAmount] = useState("");
  const [error, setError] = useState("");
  const [open, setOpen] = useState(false);

  const rec = issue.recommendations[0];
  const latest = decisions.at(-1);
  const needsReason = mode === "FALSE_POSITIVE" || mode === "ESCALATE" || (mode === "ACCEPT_CORRECTION" && rec && amount !== "" && Number(amount) !== rec.correctedAmount);

  function start(type: DecisionType) {
    setMode(type);
    setError("");
    setReason("");
    setAmount(type === "ACCEPT_CORRECTION" && rec ? String(rec.correctedAmount) : "");
  }

  function submit() {
    if (!mode) return;
    try {
      recordDecision(claimId, {
        issueId: issue.id,
        type: mode,
        reason,
        escalateTo: mode === "ESCALATE" ? target : undefined,
        overrideAmount: mode === "ACCEPT_CORRECTION" && amount !== "" ? Number(amount) : undefined,
      });
      push({ tone: "success", message: `${decisionLabel[mode]} recorded.` });
      setMode(null);
      setReason("");
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not record that decision.");
    }
  }

  return (
    <article className={`rounded-2xl border border-l-4 border-line bg-white p-4 shadow-sm ${severityBorder[issue.severity]}`}>
      <div className="flex flex-wrap items-center gap-2">
        <SeverityBadge severity={issue.severity} />
        <span className="rounded-full bg-mist px-2 py-0.5 text-[11px] font-medium text-mute">{SOURCE_LABEL[issue.source]}</span>
        {latest ? (
          <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${STATUS_TONE[latest.type]}`}>{decisionLabel[latest.type]}</span>
        ) : (
          <span className="rounded-full border border-dashed border-line px-2 py-0.5 text-[11px] text-mute">Undecided</span>
        )}
        {issue.amount > 0 ? <span className="ml-auto font-mono text-sm font-semibold text-ink">{inr(issue.amount)}</span> : null}
      </div>
      <h3 className="mt-2 text-sm font-semibold text-ink">{issue.title}</h3>
      <p className="mt-1 text-sm text-mute">{issue.explanation}</p>

      {issue.evidence.length ? (
        <ul className="mt-2 flex flex-wrap gap-1.5">
          {issue.evidence.map((e, i) => (
            <li key={`${e.label}-${i}`} className="flex max-w-full flex-wrap items-center gap-1.5">
              <span className="rounded-full bg-mist px-2 py-0.5 text-[11px] text-ink">{e.label}</span>
              {e.source ? <SourceChip source={e.source} onInspect={onInspect} /> : null}
              {e.claimId ? (
                <Link to={`/claims/${e.claimId}/investigate`} className="text-[11px] font-medium text-sky-700 hover:underline">
                  Open {e.claimId}
                </Link>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}

      {rec ? (
        <div className="mt-3 rounded-xl border border-indigo-200 bg-indigo-50/60 p-3">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-indigo-800">Recommended correction</p>
          <p className="mt-1 text-sm font-medium text-ink">{rec.title}</p>
          <p className="mt-1.5 flex flex-wrap items-center gap-2 font-mono text-sm">
            <span className="text-mute line-through">{inr(rec.originalAmount)}</span>
            <ArrowRight className="h-3.5 w-3.5 text-mute" />
            <span className="font-semibold text-ink">{inr(rec.correctedAmount)}</span>
            <span className={rec.adjustment < 0 ? "text-red-700" : "text-emerald-700"}>
              ({rec.adjustment < 0 ? "−" : "+"}
              {inr(Math.abs(rec.adjustment))})
            </span>
          </p>
          <p className="mt-1.5 text-xs text-ink"><span className="font-semibold">Calculation: </span>{rec.calculation}</p>
          <p className="mt-1 text-xs text-ink">
            <span className="font-semibold">Policy rule: </span>
            {rec.policyRule.name}
            {rec.policyRule.id ? ` (${rec.policyRule.id})` : ""}. {rec.policyRule.clause}
            {!rec.policyRule.supplied ? (
              <span className="ml-1.5 rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-800">no clause in the supplied policy</span>
            ) : null}
          </p>
          {issue.recommendations.length > 1 ? (
            <button type="button" onClick={() => setOpen((v) => !v)} className="mt-1.5 text-xs font-medium text-indigo-800 hover:underline">
              {open ? "Hide" : "Show"} {issue.recommendations.length - 1} related step{issue.recommendations.length > 2 ? "s" : ""}
            </button>
          ) : null}
          {open
            ? issue.recommendations.slice(1).map((r) => (
                <div key={r.id} className="mt-2 border-t border-indigo-200 pt-2 text-xs text-ink">
                  <p className="font-medium">{r.title}: {inr(r.originalAmount)} → {inr(r.correctedAmount)}</p>
                  <p className="text-mute">{r.calculation}</p>
                  <p className="text-mute">Policy rule: {r.policyRule.name}. {r.policyRule.clause}</p>
                </div>
              ))
            : null}
          <p className="mt-1.5 text-[10px] text-mute">Generated by {rec.generatedBy}</p>
        </div>
      ) : (
        <p className="mt-3 rounded-xl border border-dashed border-line px-3 py-2 text-xs text-mute">
          No monetary correction is proposed for this item. Decide whether the evidence holds.
        </p>
      )}

      {latest ? (
        <div className="mt-3 rounded-xl bg-mist px-3 py-2 text-xs text-ink">
          <p>
            <span className="font-semibold">{decisionLabel[latest.type]}</span>
            {latest.escalateTo ? ` to ${escalationLabel[latest.escalateTo]}` : ""} by {latest.by.name} ({latest.by.role}) · {stamp(latest.at)}
            {decisions.length > 1 ? ` · ${decisions.length - 1} earlier decision${decisions.length > 2 ? "s" : ""} kept in the audit trail` : ""}
          </p>
          {latest.reason ? <p className="mt-0.5 text-mute">Reason: {latest.reason}</p> : null}
          {latest.override ? (
            <p className="mt-0.5 font-medium text-red-700">
              Overrode the recommendation: {inr(latest.override.originalAmount)} recommended, {inr(latest.override.overriddenAmount)} accepted.
              The original recommendation is retained.
            </p>
          ) : null}
        </div>
      ) : null}

      {locked ? (
        <p className="mt-3 text-xs text-mute">Executive view is read-only for decisions.</p>
      ) : (
        <>
          <div className="mt-3 flex flex-wrap gap-1.5" role="group" aria-label={`Decide: ${issue.title}`}>
            {ACTIONS.filter((a) => a.type !== "ACCEPT_CORRECTION" || rec).map((a) => {
              const Icon = a.icon;
              const active = mode === a.type;
              return (
                <button
                  key={a.type}
                  type="button"
                  onClick={() => (active ? setMode(null) : start(a.type))}
                  aria-pressed={active}
                  className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium transition ${
                    active ? "border-ink bg-ink text-white" : `border-line bg-white text-ink ${a.tone}`
                  }`}
                >
                  <Icon className="h-3.5 w-3.5" />
                  {a.label}
                </button>
              );
            })}
          </div>

          {mode ? (
            <div className="mt-3 space-y-2 rounded-xl border border-line bg-mist/50 p-3">
              <p className="text-xs font-semibold text-ink">{decisionLabel[mode]}</p>
              {mode === "ESCALATE" ? (
                <label className="block text-xs text-mute">
                  Escalate to
                  <select
                    value={target}
                    onChange={(e) => setTarget(e.target.value as EscalationTarget)}
                    className="mt-1 w-full rounded-lg border border-line bg-white px-2 py-1.5 text-sm text-ink"
                  >
                    {(Object.keys(escalationLabel) as EscalationTarget[]).map((t) => (
                      <option key={t} value={t}>{escalationLabel[t]}</option>
                    ))}
                  </select>
                </label>
              ) : null}
              {mode === "ACCEPT_CORRECTION" && rec ? (
                <label className="block text-xs text-mute">
                  Corrected amount (recommended {inr(rec.correctedAmount)}). Change it only if you disagree; a reason is then required.
                  <input
                    type="number"
                    min="0"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    className="mt-1 w-40 rounded-lg border border-line bg-white px-2 py-1.5 font-mono text-sm text-ink"
                  />
                </label>
              ) : null}
              <label className="block text-xs text-mute">
                {needsReason ? "Reason (required)" : "Reason (optional)"}
                <textarea
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  rows={2}
                  placeholder={mode === "FALSE_POSITIVE" ? "e.g. prescribed repeat session, not a duplicate" : "Add context for the audit trail"}
                  className="mt-1 w-full rounded-lg border border-line bg-white px-2 py-1.5 text-sm text-ink outline-none focus:border-brand"
                />
              </label>
              {error ? <p className="text-xs font-medium text-red-700" role="alert">{error}</p> : null}
              <div className="flex gap-2">
                <button type="button" onClick={submit} className="rounded-lg bg-ink px-3 py-1.5 text-xs font-medium text-white transition hover:bg-black">
                  Record decision
                </button>
                <button type="button" onClick={() => setMode(null)} className="rounded-lg border border-line bg-white px-3 py-1.5 text-xs text-ink transition hover:border-ink/40">
                  Cancel
                </button>
              </div>
            </div>
          ) : null}
        </>
      )}
    </article>
  );
}
