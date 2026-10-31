import { useMemo, useState } from "react";
import type { InvestigationEvent, InvestigationEventType } from "../../types";

const TONE: Record<InvestigationEventType, { label: string; badge: string }> = {
  investigation_opened: { label: "Opened", badge: "bg-slate-100 text-slate-700" },
  calculation_recorded: { label: "Calculation", badge: "bg-sky-100 text-sky-800" },
  issue_detected: { label: "Issue detected", badge: "bg-orange-100 text-orange-800" },
  recommendation_generated: { label: "Recommendation", badge: "bg-indigo-100 text-indigo-800" },
  correlation_found: { label: "Linked claim", badge: "bg-fuchsia-100 text-fuchsia-800" },
  document_added: { label: "Document", badge: "bg-sky-100 text-sky-800" },
  discrepancy_detected: { label: "Discrepancy", badge: "bg-amber-100 text-amber-800" },
  decision: { label: "Decision", badge: "bg-emerald-100 text-emerald-800" },
  override: { label: "Override", badge: "bg-red-100 text-red-800" },
  escalation: { label: "Escalation", badge: "bg-violet-100 text-violet-800" },
  note: { label: "Note", badge: "bg-slate-100 text-slate-700" },
  queue_changed: { label: "Queue", badge: "bg-violet-100 text-violet-800" },
};

const GROUPS: Array<{ id: string; label: string; types?: InvestigationEventType[] }> = [
  { id: "all", label: "All" },
  { id: "decisions", label: "Decisions", types: ["decision", "override", "escalation", "queue_changed"] },
  { id: "system", label: "System analysis", types: ["calculation_recorded", "issue_detected", "recommendation_generated", "correlation_found", "discrepancy_detected"] },
  { id: "evidence", label: "Evidence & notes", types: ["document_added", "note", "investigation_opened"] },
];

function stamp(iso: string) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

/** The evidence history: every event, newest first, with who did it, when, and the data it recorded. */
export function AuditTrail({ events }: { events: InvestigationEvent[] }) {
  const [group, setGroup] = useState("all");
  const shown = useMemo(() => {
    const types = GROUPS.find((g) => g.id === group)?.types;
    return [...events].reverse().filter((e) => !types || types.includes(e.type));
  }, [events, group]);

  return (
    <div>
      <div className="mb-3 flex flex-wrap gap-1.5">
        {GROUPS.map((g) => (
          <button
            key={g.id}
            type="button"
            onClick={() => setGroup(g.id)}
            aria-pressed={group === g.id}
            className={`rounded-full px-3 py-1 text-xs font-medium transition ${
              group === g.id ? "bg-ink text-white" : "border border-line bg-white text-ink hover:border-ink/40"
            }`}
          >
            {g.label}
          </button>
        ))}
        <span className="ml-auto self-center text-xs text-mute">
          {shown.length} of {events.length} events
        </span>
      </div>
      <ol className="max-h-[32rem] space-y-2 overflow-y-auto pr-1">
        {shown.map((e) => (
          <li key={e.id} className="rounded-xl border border-line bg-white p-3">
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className={`rounded-full px-2 py-0.5 font-medium ${TONE[e.type].badge}`}>{TONE[e.type].label}</span>
              <span className="font-medium text-ink">{e.by.name}</span>
              <span className="text-mute">({e.by.role})</span>
              <time className="ml-auto text-mute" dateTime={e.at}>{stamp(e.at)}</time>
            </div>
            <p className="mt-1.5 text-sm text-ink">{e.summary}</p>
            {e.data !== undefined ? (
              <details className="mt-1.5">
                <summary className="cursor-pointer text-xs text-sky-700 hover:underline">Recorded data</summary>
                <pre className="mt-1 max-h-48 overflow-auto rounded-lg bg-mist p-2 font-mono text-[11px] text-ink">
                  {JSON.stringify(e.data, null, 2).slice(0, 4000)}
                </pre>
              </details>
            ) : null}
          </li>
        ))}
      </ol>
    </div>
  );
}
