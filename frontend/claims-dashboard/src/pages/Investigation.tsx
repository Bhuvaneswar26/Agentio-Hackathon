import { ArrowLeft, Download, FileJson, Printer } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { AuditTrail } from "../components/investigation/AuditTrail";
import { DocumentsPanel } from "../components/investigation/DocumentsPanel";
import { EvidenceDrawer, SourceChip } from "../components/investigation/EvidenceDrawer";
import { IssueCard } from "../components/investigation/IssueCard";
import { EmptyState, KpiCard, PageHeader, Panel, QueueBadge, RiskPill, SeverityBadge } from "../components/ui";
import { downloadText } from "../lib/download";
import { formatDate, inr } from "../lib/format";
import { analyseClaim, buildReport, reportToHtml } from "../lib/investigation";
import { useAppStore } from "../store/useAppStore";
import { useToast } from "../store/useToast";
import type { Actor, Correlation, Decision, SourceRef } from "../types";

const STRENGTH_TONE: Record<Correlation["strength"], string> = {
  strong: "bg-red-100 text-red-800",
  moderate: "bg-amber-100 text-amber-800",
  weak: "bg-slate-100 text-slate-700",
};

type IssueFilter = "all" | "undecided" | "decided";

export function Investigation() {
  const { id } = useParams();
  const claims = useAppStore((s) => s.claims);
  const claim = claims.find((c) => c.id === id);
  if (!claim) {
    return <EmptyState title="Claim not on the desk" body="It may have been cleared. Go back to the claims desk." />;
  }
  return <Workspace key={claim.id} claimId={claim.id} />;
}

function Workspace({ claimId }: { claimId: string }) {
  const navigate = useNavigate();
  const push = useToast((s) => s.push);
  const claims = useAppStore((s) => s.claims);
  const role = useAppStore((s) => s.role);
  const analystName = useAppStore((s) => s.analyst.name);
  const openInvestigation = useAppStore((s) => s.openInvestigation);
  const addNote = useAppStore((s) => s.addInvestigationNote);
  const claim = claims.find((c) => c.id === claimId)!;

  const [filter, setFilter] = useState<IssueFilter>("all");
  const [inspect, setInspect] = useState<SourceRef | null>(null);
  const [note, setNote] = useState("");

  // The baseline (original calculation, issues, recommendations) is written once, on first open.
  useEffect(() => {
    openInvestigation(claimId);
  }, [claimId, openInvestigation]);

  const analysis = useMemo(() => analyseClaim(claim, claims), [claim, claims]);
  const inv = claim.investigation;
  const actor: Actor = { name: analystName.trim() || "Analyst", role };
  const locked = role === "executive";

  const byIssue = useMemo(() => {
    const map = new Map<string, Decision[]>();
    for (const d of inv?.decisions ?? []) map.set(d.issueId, [...(map.get(d.issueId) ?? []), d]);
    return map;
  }, [inv]);
  const decided = analysis.issues.filter((i) => byIssue.has(i.id)).length;
  const shown = analysis.issues.filter((i) => (filter === "all" ? true : filter === "decided" ? byIssue.has(i.id) : !byIssue.has(i.id)));

  const inspectedDoc = inspect ? claim.documents?.find((d) => d.id === inspect.documentId) ?? null : null;

  // Corrected amount per billed line, from the recommendations that touch it.
  const corrected = useMemo(() => {
    const map = new Map<string, number>();
    for (const l of claim.lines) {
      const delta = analysis.recommendations
        .filter((r) => r.inWaterfall && r.invoiceLineIds[0] === l.id)
        .reduce((sum, r) => sum + r.adjustment, 0);
      map.set(l.id, l.amount + delta);
    }
    return map;
  }, [claim.lines, analysis.recommendations]);

  function report() {
    return buildReport(claim, claims, analysis, actor);
  }
  function downloadJson() {
    downloadText(`investigation-${claim.id}.json`, "application/json", JSON.stringify(report(), null, 2));
    push({ tone: "success", message: "Investigation report downloaded (JSON)." });
  }
  function downloadHtml() {
    downloadText(`investigation-${claim.id}.html`, "text/html", reportToHtml(report()));
    push({ tone: "success", message: "Printable report downloaded. Open it and print to PDF." });
  }

  const counts: Record<IssueFilter, number> = {
    all: analysis.issues.length,
    undecided: analysis.issues.length - decided,
    decided,
  };

  return (
    <div>
      <PageHeader
        eyebrow="Investigation workspace"
        title={claim.id}
        description={`${claim.claimant} · ${claim.provider} · policy ${claim.policyNumber} · filed ${formatDate(claim.filedDate)}`}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={() => navigate(-1)} className="inline-flex items-center gap-1.5 text-sm text-mute hover:text-ink">
              <ArrowLeft size={16} /> Back
            </button>
            <button type="button" onClick={downloadJson} className="inline-flex items-center gap-1.5 rounded-lg bg-ink px-3 py-2 text-xs font-medium text-white transition hover:bg-black">
              <FileJson size={14} /> Download report (JSON)
            </button>
            <button type="button" onClick={downloadHtml} className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-white px-3 py-2 text-xs font-medium text-ink transition hover:border-ink/40">
              <Printer size={14} /> Printable report
            </button>
          </div>
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-2 text-xs">
        <QueueBadge queue={claim.queue} />
        <span className="inline-flex items-center gap-2 rounded-full bg-white px-3 py-1">Risk <RiskPill score={claim.riskScore} /></span>
        <span className="rounded-full bg-white px-3 py-1 text-mute">
          Working as <span className="font-medium text-ink">{actor.name}</span> ({actor.role}). Set your name in the sidebar.
        </span>
        <Link to={`/claims/${claim.id}`} className="ml-auto font-medium text-sky-700 hover:underline">Claim page</Link>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
        <KpiCard label="Requested" value={inr(claim.requestedAmount)} />
        <KpiCard label="Proposed settlement" value={inr(analysis.calculation.proposed)} />
        <KpiCard label="Corrected settlement" value={inr(analysis.calculation.expected)} tone="good" hint="After every recommended step" />
        <KpiCard label="Calculated leakage" value={inr(analysis.leakage.calculated)} tone={analysis.leakage.calculated > 0 ? "bad" : "neutral"} hint="Proposed minus corrected" />
        <KpiCard label="Cross-claim exposure" value={inr(analysis.leakage.crossClaimExposure)} tone={analysis.leakage.crossClaimExposure > 0 ? "warn" : "neutral"} hint="If a duplicate is confirmed" />
        <KpiCard label="Issues decided" value={`${decided} / ${analysis.issues.length}`} tone={decided === analysis.issues.length && decided > 0 ? "good" : "neutral"} hint={`${analysis.issues.length - decided} still open`} />
      </div>

      <div className="mt-5 grid gap-4 xl:grid-cols-5">
        <div className="space-y-4 xl:col-span-3">
          <Panel
            title="Issues and recommended corrections"
            action={
              <div className="flex gap-1">
                {(["all", "undecided", "decided"] as IssueFilter[]).map((f) => (
                  <button
                    key={f}
                    type="button"
                    onClick={() => setFilter(f)}
                    aria-pressed={filter === f}
                    className={`rounded-full px-2.5 py-1 text-xs font-medium capitalize transition ${filter === f ? "bg-ink text-white" : "border border-line bg-white text-ink hover:border-ink/40"}`}
                  >
                    {f} · {counts[f]}
                  </button>
                ))}
              </div>
            }
          >
            {analysis.issues.length === 0 ? (
              <p className="text-sm text-mute">No issues were found on this claim. Attach supporting documents to check it against the evidence.</p>
            ) : shown.length === 0 ? (
              <p className="text-sm text-mute">Nothing in this view.</p>
            ) : (
              <div className="space-y-3">
                {shown.map((issue) => (
                  <IssueCard key={issue.id} issue={issue} claimId={claim.id} decisions={byIssue.get(issue.id) ?? []} locked={locked} onInspect={setInspect} />
                ))}
              </div>
            )}
          </Panel>

          <Panel title="Settlement calculation" action={<span className="text-xs text-mute">Original, then each correction in order</span>}>
            <table className="w-full text-left text-sm">
              <thead className="text-xs uppercase tracking-wide text-mute">
                <tr><th className="pb-2">Step</th><th className="pb-2 text-right">Before</th><th className="pb-2 text-right">After</th></tr>
              </thead>
              <tbody>
                <tr className="border-t border-line"><td className="py-2 font-medium">Claimed</td><td /><td className="py-2 text-right font-mono">{inr(analysis.calculation.gross)}</td></tr>
                {analysis.calculation.steps.map((s) => (
                  <tr key={s.key} className="border-t border-line align-top">
                    <td className="py-2"><p className="font-medium">{s.label}</p><p className="text-xs text-mute">{s.calculation}</p></td>
                    <td className="py-2 text-right font-mono text-mute">{inr(s.before)}</td>
                    <td className="py-2 text-right font-mono">{inr(s.after)}</td>
                  </tr>
                ))}
                <tr className="border-t-2 border-ink">
                  <td className="py-2 font-semibold">Corrected settlement</td><td />
                  <td className="py-2 text-right font-mono font-semibold text-emerald-700">{inr(analysis.calculation.expected)}</td>
                </tr>
                <tr><td className="py-1 text-xs text-mute">Proposed {inr(analysis.calculation.proposed)}</td><td /><td className="py-1 text-right font-mono text-xs font-semibold text-red-700">leakage {inr(analysis.calculation.leakage)}</td></tr>
              </tbody>
            </table>
            {claim.confirmedLeakage + claim.potentialLeakage > 0 ? (
              <p className="mt-2 text-xs text-mute">
                For comparison, the desk scored this claim at {inr(claim.confirmedLeakage)} confirmed and {inr(claim.potentialLeakage)} potential leakage.
                This workspace recalculates from the policy terms and documents, so the figures can differ.
              </p>
            ) : null}
          </Panel>

          <Panel title="Original claim">
            <dl className="mb-3 grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-3">
              {[
                ["Claimant", claim.claimant],
                ["Policy", claim.policyNumber],
                ["Provider", claim.provider],
                ["City", claim.city],
                ["Incident", formatDate(claim.incidentDate)],
                ["Filed", formatDate(claim.filedDate)],
                ["Type", `${claim.domain} · ${claim.claimType}`],
                ["Source", `${claim.sourceFormat} · ${Math.round(claim.extractionConfidence * 100)}%`],
              ].map(([k, v]) => (
                <div key={k}><dt className="text-xs text-mute">{k}</dt><dd className="font-medium text-ink">{v}</dd></div>
              ))}
            </dl>
            {claim.lines.length ? (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[30rem] text-left text-xs">
                  <thead className="text-mute"><tr><th className="pb-1">Line</th><th className="pb-1">Invoice</th><th className="pb-1 text-right">Qty</th><th className="pb-1 text-right">Billed</th><th className="pb-1 text-right">Corrected</th></tr></thead>
                  <tbody>
                    {claim.lines.map((l) => {
                      const c = corrected.get(l.id) ?? l.amount;
                      return (
                        <tr key={l.id} className="border-t border-line">
                          <td className="py-1.5 pr-2 text-ink">{l.description}</td>
                          <td className="py-1.5 pr-2 font-mono text-mute">{l.invoiceRef}</td>
                          <td className="py-1.5 text-right font-mono">{l.quantity}</td>
                          <td className="py-1.5 text-right font-mono">{inr(l.amount)}</td>
                          <td className={`py-1.5 text-right font-mono ${c < l.amount ? "font-semibold text-red-700" : "text-mute"}`}>{inr(c)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="text-sm text-mute">No line items were extracted for this claim.</p>
            )}
          </Panel>

          <Panel title="Relevant policy terms">
            {claim.policyRules.length ? (
              <ul className="space-y-2">
                {claim.policyRules.map((r) => (
                  <li key={r.id} className="rounded-xl border border-line p-3 text-sm">
                    <p className="flex items-center gap-2 font-medium text-ink">
                      {r.name}
                      {r.value !== undefined ? <span className="rounded-full bg-mist px-2 py-0.5 font-mono text-[11px]">{r.unit === "%" ? `${r.value}%` : inr(r.value)}{r.unit && r.unit !== "%" && r.unit !== "INR" ? ` ${r.unit}` : ""}</span> : null}
                      <span className="ml-auto font-mono text-[11px] text-mute">{r.id}</span>
                    </p>
                    <p className="mt-0.5 text-xs text-mute">{r.clause}</p>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-mute">No policy terms are attached to this claim. Pick a policy from the master policy on the Ingest page.</p>
            )}
          </Panel>
        </div>

        <div className="space-y-4 xl:col-span-2">
          <Panel title={`Related claims (${analysis.correlations.length})`}>
            {analysis.correlations.length === 0 ? (
              <p className="text-sm text-mute">No other claim on the desk shares an invoice, claimant, policy, provider or incident with this one.</p>
            ) : (
              <ul className="space-y-3">
                {analysis.correlations.map((c) => (
                  <li key={c.claimId} className={`rounded-xl border p-3 ${c.crossPolicyInvoice ? "border-red-300 bg-red-50/60" : "border-line"}`}>
                    <div className="flex flex-wrap items-center gap-2">
                      <Link to={`/claims/${c.claimId}/investigate`} className="text-sm font-semibold text-ink hover:underline">{c.claimId}</Link>
                      <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold capitalize ${STRENGTH_TONE[c.strength]}`}>{c.strength} link</span>
                      <QueueBadge queue={c.queue} />
                      <span className="ml-auto font-mono text-xs text-mute">{inr(c.requestedAmount)}</span>
                    </div>
                    <p className="mt-1.5 text-sm text-ink">{c.headline}</p>
                    <table className="mt-2 w-full text-left text-xs">
                      <thead className="text-mute"><tr><th className="pb-1 font-medium">Matching attribute</th><th className="pb-1 font-medium">This claim</th><th className="pb-1 font-medium">{c.claimId}</th></tr></thead>
                      <tbody>
                        {c.attributes.map((a) => (
                          <tr key={a.attribute} className="border-t border-line/70">
                            <td className="py-1 pr-2 font-medium text-ink">{a.attribute}</td>
                            <td className="py-1 pr-2 text-ink">{a.thisClaim}</td>
                            <td className="py-1 text-ink">{a.otherClaim}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    <p className="mt-1.5 text-[11px] text-mute">Policy {c.policyNumber} · {c.claimant} · {c.provider}</p>
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          <Panel title="Supporting documents">
            <DocumentsPanel claim={claim} locked={locked} onInspect={setInspect} />
          </Panel>

          <Panel title={`Document vs claim differences (${analysis.discrepancies.length})`}>
            {analysis.discrepancies.length === 0 ? (
              <p className="text-sm text-mute">{claim.documents?.length ? "The documents agree with the claim record." : "Attach a document to compare it with the claim."}</p>
            ) : (
              <ul className="space-y-2">
                {analysis.discrepancies.map((d) => (
                  <li key={d.id} className="rounded-xl border border-line p-3 text-xs">
                    <div className="flex flex-wrap items-center gap-2">
                      <SeverityBadge severity={d.severity} />
                      <span className="font-medium text-ink">{d.field}</span>
                      {d.amountAtRisk > 0 ? <span className="ml-auto font-mono font-semibold text-red-700">{inr(d.amountAtRisk)} at risk</span> : null}
                    </div>
                    <p className="mt-1 text-sm text-ink">{d.title}</p>
                    <div className="mt-1.5 grid grid-cols-2 gap-2">
                      <div className="rounded-lg bg-mist p-2"><p className="text-mute">Claim</p><p className="font-medium text-ink">{d.claimValue}</p><p className="text-[10px] text-mute">{d.claimRef}</p></div>
                      <div className="rounded-lg bg-sky-50 p-2"><p className="text-sky-800/80">Document</p><p className="font-medium text-ink">{d.documentValue}</p>{d.source ? <div className="mt-1"><SourceChip source={d.source} onInspect={setInspect} /></div> : <p className="text-[10px] text-mute">not in the document</p>}</div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          <Panel title={`Analyst notes (${inv?.notes.length ?? 0})`}>
            {locked ? null : (
              <div className="mb-3">
                <textarea
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  rows={3}
                  placeholder={`Add a note as ${actor.name}…`}
                  className="w-full rounded-xl border border-line bg-white px-3 py-2 text-sm outline-none focus:border-brand"
                />
                <button
                  type="button"
                  disabled={!note.trim()}
                  onClick={() => {
                    addNote(claim.id, note);
                    setNote("");
                    push({ tone: "success", message: "Note added to the audit trail." });
                  }}
                  className="mt-2 rounded-lg bg-ink px-3 py-1.5 text-xs font-medium text-white transition hover:bg-black disabled:opacity-40"
                >
                  Add note
                </button>
              </div>
            )}
            {(inv?.notes.length ?? 0) === 0 ? (
              <p className="text-xs text-mute">No notes yet.</p>
            ) : (
              <ul className="space-y-2">
                {inv!.notes.map((n) => (
                  <li key={n.id} className="rounded-xl bg-mist px-3 py-2 text-sm">
                    <p className="whitespace-pre-wrap text-ink">{n.text}</p>
                    <p className="mt-1 text-[11px] text-mute">{n.by.name} ({n.by.role}) · {new Date(n.at).toLocaleString("en-IN")}</p>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>
      </div>

      <div className="mt-4">
        <Panel
          title={`Evidence and audit trail (${inv?.events.length ?? 0} events)`}
          action={
            <button type="button" onClick={downloadJson} className="inline-flex items-center gap-1.5 text-xs font-medium text-sky-700 hover:underline">
              <Download size={13} /> Download with the report
            </button>
          }
        >
          <p className="mb-3 text-xs text-mute">
            Every calculation, detected issue, recommendation, decision and override is kept here with who did it and when. Events are only ever added;
            an override keeps the original recommendation.
          </p>
          {inv ? <AuditTrail events={inv.events} /> : <p className="text-sm text-mute">Opening the investigation…</p>}
        </Panel>
      </div>

      <EvidenceDrawer doc={inspectedDoc} line={inspect?.line} onClose={() => setInspect(null)} />
    </div>
  );
}
