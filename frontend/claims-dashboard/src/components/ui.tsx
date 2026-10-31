import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { ArrowUpRight, CheckCircle2, Info, TriangleAlert, X } from "lucide-react";
import { queueLabel, riskTone, severityDot, severityTone } from "../lib/format";
import { useToast } from "../store/useToast";
import type { ClaimQueue, Severity } from "../types";

export function Toaster() {
  const { toasts, dismiss } = useToast();
  return (
    <div
      className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-[min(24rem,calc(100vw-2rem))] flex-col gap-2"
      aria-live="polite"
    >
      {toasts.map((t) => {
        const Icon =
          t.tone === "success"
            ? CheckCircle2
            : t.tone === "error"
              ? TriangleAlert
              : Info;
        const tone =
          t.tone === "success"
            ? "text-brand-dark"
            : t.tone === "error"
              ? "text-red-600"
              : "text-mute";
        return (
          <div
            key={t.id}
            role={t.tone === "error" ? "alert" : "status"}
            className="animate-slide-up pointer-events-auto flex items-start gap-3 rounded-xl border border-line bg-white px-4 py-3 text-sm shadow-lg"
          >
            <Icon size={18} className={`mt-0.5 shrink-0 ${tone}`} />
            <p className="flex-1">{t.message}</p>
            {t.action ? (
              <button
                type="button"
                className="shrink-0 font-semibold text-brand-dark hover:underline"
                onClick={() => {
                  t.action?.onClick();
                  dismiss(t.id);
                }}
              >
                {t.action.label}
              </button>
            ) : null}
            <button
              type="button"
              aria-label="Dismiss"
              className="shrink-0 text-mute hover:text-ink"
              onClick={() => dismiss(t.id)}
            >
              <X size={16} />
            </button>
          </div>
        );
      })}
    </div>
  );
}

export type KpiTone = "neutral" | "good" | "warn" | "bad";

const kpiTone: Record<KpiTone, { card: string; label: string; value: string }> =
  {
    neutral: {
      card: "border-line bg-white",
      label: "text-mute",
      value: "text-ink",
    },
    good: {
      card: "border-emerald-200 bg-emerald-50",
      label: "text-emerald-800/80",
      value: "text-emerald-800",
    },
    warn: {
      card: "border-amber-200 bg-amber-50",
      label: "text-amber-800/80",
      value: "text-amber-800",
    },
    bad: {
      card: "border-red-200 bg-red-50",
      label: "text-red-800/80",
      value: "text-red-700",
    },
  };

/** A headline number. Pass `to` to make the whole card a link to the view behind the number. */
export function KpiCard({
  label,
  value,
  hint,
  tone = "neutral",
  to,
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: KpiTone;
  to?: string;
}) {
  const t = kpiTone[tone];
  const body = (
    <>
      <div className="flex items-start justify-between gap-2">
        <p className={`text-xs font-medium uppercase tracking-wide ${t.label}`}>
          {label}
        </p>
        {to ? (
          <ArrowUpRight
            size={14}
            className={`shrink-0 opacity-0 transition group-hover:translate-x-0.5 group-hover:-translate-y-0.5 group-hover:opacity-100 ${t.label}`}
          />
        ) : null}
      </div>
      <p
        className={`mt-2 font-mono text-2xl font-semibold tracking-tight ${t.value}`}
      >
        {value}
      </p>
      {hint ? <p className={`mt-1 text-xs ${t.label}`}>{hint}</p> : null}
    </>
  );
  const base = `group block rounded-2xl border p-4 shadow-sm transition hover:-translate-y-0.5 hover:shadow-md ${t.card}`;
  return to ? (
    <Link to={to} className={`${base} focus-visible:-translate-y-0.5`}>
      {body}
    </Link>
  ) : (
    <div className={base}>{body}</div>
  );
}

const queueTone: Record<ClaimQueue, { badge: string; dot: string }> = {
  intake: { badge: "bg-slate-100 text-slate-700", dot: "bg-slate-400" },
  good: { badge: "bg-emerald-100 text-emerald-800", dot: "bg-emerald-500" },
  flagged: { badge: "bg-orange-100 text-orange-800", dot: "bg-orange-500" },
  unassessed: {
    badge: "bg-amber-50 text-amber-800 ring-1 ring-inset ring-amber-300",
    dot: "bg-amber-500",
  },
  special: { badge: "bg-violet-100 text-violet-800", dot: "bg-violet-500" },
  confirmed: { badge: "bg-red-600 text-white", dot: "bg-white" },
  dismissed: { badge: "bg-slate-100 text-slate-500", dot: "bg-slate-300" },
};

export function QueueBadge({ queue }: { queue: ClaimQueue }) {
  const tone = queueTone[queue];
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium ${tone.badge}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${tone.dot}`} />
      {queueLabel[queue]}
    </span>
  );
}

export function SeverityBadge({ severity }: { severity: Severity }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium capitalize ${severityTone[severity]}`}
    >
      <span
        className={`h-1.5 w-1.5 rounded-full ${severity === "critical" ? "animate-pulse-smooth bg-white" : severityDot[severity]}`}
      />
      {severity}
    </span>
  );
}

/** Risk score as a coloured pill: green is low risk, amber is medium, red is high. */
export function RiskPill({ score }: { score: number }) {
  return (
    <span
      className={`inline-flex min-w-9 items-center justify-center rounded-full px-2.5 py-0.5 font-mono text-xs font-semibold ${riskTone(score)}`}
      title={`Risk score ${score} of 100`}
    >
      {score}
    </span>
  );
}

export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow: string;
  title: string;
  description: string;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
      <div>
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-brand-dark">
          {eyebrow}
        </p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight text-ink md:text-3xl">
          {title}
        </h1>
        <p className="mt-1 max-w-2xl text-sm text-mute">{description}</p>
      </div>
      {actions}
    </div>
  );
}

export function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <div className="rounded-2xl border border-dashed border-line bg-white px-6 py-16 text-center">
      <p className="font-medium text-ink">{title}</p>
      <p className="mt-1 text-sm text-mute">{body}</p>
    </div>
  );
}

export function Panel({
  title,
  children,
  action,
}: {
  title: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-line bg-white p-4 shadow-sm md:p-5">
      <div className="mb-4 flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-ink">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}
