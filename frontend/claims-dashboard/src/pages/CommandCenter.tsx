import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Link, useNavigate } from "react-router-dom";
import { ArrowUpRight, Upload } from "lucide-react";
import { useMemo } from "react";
import {
  KpiCard,
  PageHeader,
  Panel,
  QueueBadge,
  RiskPill,
} from "../components/ui";
import {
  findingLabel,
  inr,
  palette,
  pct,
  severityDot,
  severityOrder,
  severityTone,
} from "../lib/format";
import { useAppStore } from "../store/useAppStore";

export function CommandCenter() {
  const claims = useAppStore((s) => s.claims);
  const loadDemoData = useAppStore((s) => s.loadDemoData);
  const navigate = useNavigate();
  const processed = claims.length;
  const good = claims.filter(
    (c) => c.queue === "good" || c.queue === "dismissed",
  );
  const flagged = claims.filter((c) =>
    ["flagged", "confirmed", "special"].includes(c.queue),
  );
  const unassessed = claims.filter((c) => c.queue === "unassessed");
  const confirmed = claims.reduce((s, c) => s + c.confirmedLeakage, 0);
  const potential = claims.reduce((s, c) => s + c.potentialLeakage, 0);
  const requested = claims.reduce((s, c) => s + c.requestedAmount, 0);
  const leakageRatio = requested ? (confirmed + potential) / requested : 0;
  const fraudish = claims.filter((c) =>
    c.findings.some(
      (f) => f.kind === "fraud_signal" || f.kind === "related_party",
    ),
  );

  const byDomain = ["Health", "Motor", "General"].map((d) => ({
    name: d,
    claims: claims.filter((c) => c.domain === d).length,
    leakage: claims
      .filter((c) => c.domain === d)
      .reduce((s, c) => s + c.confirmedLeakage + c.potentialLeakage, 0),
  }));

  const categories = Object.entries(
    claims
      .flatMap((c) => c.findings)
      .reduce<Record<string, number>>((acc, f) => {
        acc[f.kind] = (acc[f.kind] ?? 0) + 1;
        return acc;
      }, {}),
  ).map(([kind, count]) => ({
    name: findingLabel[kind as keyof typeof findingLabel] ?? kind,
    count,
  }));

  const funnel = [
    { name: "Processed", value: processed, tab: "all", color: palette.neutral },
    { name: "Good", value: good.length, tab: "good", color: palette.good },
    {
      name: "Flagged",
      value: flagged.length,
      tab: "attention",
      color: palette.flagged,
    },
    {
      name: "Special",
      value: claims.filter((c) => c.queue === "special").length,
      tab: "special",
      color: palette.special,
    },
  ];

  const bySeverity = severityOrder.map((severity) => ({
    severity,
    count: claims
      .flatMap((c) => c.findings)
      .filter((f) => f.severity === severity).length,
  }));

  const trend = useMemo(() => {
    const weeks = new Map<
      number,
      { day: string; flagged: number; good: number }
    >();
    const weekMs = 7 * 24 * 60 * 60 * 1000;
    const mondayEpochMs = 4 * 24 * 60 * 60 * 1000;
    for (const claim of claims) {
      const filedAt = Date.parse(claim.filedDate);
      if (!Number.isFinite(filedAt)) continue;
      const week = Math.floor((filedAt - mondayEpochMs) / weekMs);
      const group = weeks.get(week) ?? {
        day: claim.filedDate,
        flagged: 0,
        good: 0,
      };
      if (["flagged", "confirmed", "special"].includes(claim.queue))
        group.flagged += 1;
      if (["good", "dismissed"].includes(claim.queue)) group.good += 1;
      if (claim.filedDate < group.day) group.day = claim.filedDate;
      weeks.set(week, group);
    }
    return [...weeks.entries()]
      .sort(([a], [b]) => a - b)
      .slice(-10)
      .map(([, group]) => group);
  }, [claims]);

  const mix = [
    { name: "Good", value: good.length, color: palette.good, tab: "good" },
    {
      name: "Flagged",
      value: flagged.length,
      color: palette.flagged,
      tab: "attention",
    },
    {
      name: "Unassessed",
      value: unassessed.length,
      color: palette.warn,
      tab: "unassessed",
    },
    {
      name: "Intake",
      value: claims.filter((c) => c.queue === "intake").length,
      color: palette.neutral,
      tab: "intake",
    },
  ];

  const hot = [...claims].sort((a, b) => b.riskScore - a.riskScore).slice(0, 6);

  return (
    <div>
      <PageHeader
        eyebrow="Executive view"
        title="Command center"
        description="Portfolio health across good claims, leakage, fraud signals and supervisor exceptions. Confirmed rupees are never mixed with suspected amounts."
        actions={
          <Link
            to="/ingest"
            className="group inline-flex items-center gap-2 rounded-full bg-ink px-4 py-2 text-sm text-white transition hover:bg-brand-dark hover:shadow-md"
          >
            <Upload size={15} /> Ingest a claim pack{" "}
            <ArrowUpRight
              size={14}
              className="transition group-hover:translate-x-0.5 group-hover:-translate-y-0.5"
            />
          </Link>
        }
      />

      {processed === 0 ? (
        <div className="mb-4 flex flex-col items-start gap-3 rounded-2xl border border-dashed border-line bg-white px-6 py-8 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="font-medium text-ink">No claims on the desk yet</p>
            <p className="mt-1 text-sm text-mute">
              Ingest a claim pack to see leakage, risk and alerts here, or load the demo portfolio to explore.
            </p>
          </div>
          <div className="flex gap-2">
            <Link
              to="/ingest"
              className="rounded-full bg-ink px-4 py-2 text-sm text-white transition hover:bg-brand-dark"
            >
              Ingest a claim pack
            </Link>
            <button
              type="button"
              onClick={loadDemoData}
              className="rounded-full border border-line px-4 py-2 text-sm transition hover:border-ink/40 hover:bg-mist"
            >
              Load demo portfolio
            </button>
          </div>
        </div>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
        <KpiCard
          label="Claims processed"
          value={String(processed)}
          hint="Demo + ingested packs"
          to="/claims?tab=all"
        />
        <KpiCard
          label="Good claim ratio"
          value={pct(good.length / processed || 0)}
          hint={`${good.length} cleared`}
          tone="good"
          to="/claims?tab=good"
        />
        <KpiCard
          label="Flagged ratio"
          value={pct(flagged.length / processed || 0)}
          hint={`${flagged.length} need action`}
          tone="warn"
          to="/claims?tab=attention"
        />
        <KpiCard
          label="Confirmed leakage"
          value={inr(confirmed)}
          hint="Deterministic only"
          tone="bad"
          to="/alerts"
        />
        <KpiCard
          label="Potential leakage"
          value={inr(potential)}
          hint="Held out of savings"
          tone="warn"
          to="/alerts"
        />
        <KpiCard
          label="Leakage vs billed"
          value={pct(leakageRatio)}
          hint={`${fraudish.length} fraud-like patterns`}
          to="/alerts"
        />
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <span className="mr-1 text-xs font-semibold uppercase tracking-wide text-mute">
          Findings by severity
        </span>
        {bySeverity.map(({ severity, count }) => (
          <Link
            key={severity}
            to={`/alerts?severity=${severity}`}
            className={`inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-xs font-medium capitalize transition hover:-translate-y-0.5 hover:shadow-md ${severityTone[severity]}`}
            title={`Open ${count} ${severity} finding${count === 1 ? "" : "s"}`}
          >
            <span
              className={`h-2 w-2 rounded-full ${severity === "critical" ? "bg-white" : severityDot[severity]}`}
            />
            {severity}
            <span className="font-mono font-semibold">{count}</span>
          </Link>
        ))}
      </div>

      <div className="mt-5 grid gap-4 xl:grid-cols-3">
        <Panel
          title="Claim mix"
          action={
            <span className="text-xs text-mute">Click a slice to open it</span>
          }
        >
          <div className="h-56">
            <ResponsiveContainer>
              <PieChart>
                <Pie
                  data={mix}
                  dataKey="value"
                  nameKey="name"
                  innerRadius={52}
                  outerRadius={80}
                  paddingAngle={3}
                  cursor="pointer"
                  onClick={(slice) => {
                    const tab = (slice as { tab?: string }).tab;
                    if (tab) navigate(`/claims?tab=${tab}`);
                  }}
                >
                  {mix.map((e) => (
                    <Cell key={e.name} fill={e.color} />
                  ))}
                </Pie>
                <Tooltip />
              </PieChart>
            </ResponsiveContainer>
          </div>
          <div className="grid grid-cols-2 gap-1 text-xs text-mute">
            {mix.map((m) => (
              <Link
                key={m.name}
                to={`/claims?tab=${m.tab}`}
                className="flex items-center gap-2 rounded-lg px-2 py-1 transition hover:bg-mist hover:text-ink"
              >
                <span
                  className="h-2.5 w-2.5 rounded-full"
                  style={{ background: m.color }}
                />
                {m.name} · {m.value}
              </Link>
            ))}
          </div>
        </Panel>
        <Panel
          title="Weekly good vs flagged"
          action={
            <span className="text-xs text-mute">
              By filed date · last 10 weeks
            </span>
          }
        >
          <div className="h-64">
            <ResponsiveContainer>
              <AreaChart data={trend}>
                <CartesianGrid stroke="#e6eee9" vertical={false} />
                <XAxis dataKey="day" tick={{ fontSize: 12 }} />
                <YAxis tick={{ fontSize: 12 }} />
                <Tooltip />
                <Area
                  type="monotone"
                  dataKey="good"
                  stroke={palette.good}
                  fill={palette.good}
                  fillOpacity={0.3}
                />
                <Area
                  type="monotone"
                  dataKey="flagged"
                  stroke={palette.flagged}
                  fill={palette.flagged}
                  fillOpacity={0.3}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </Panel>
        <Panel title="Leakage by line of business">
          <div className="h-64">
            <ResponsiveContainer>
              <BarChart data={byDomain}>
                <CartesianGrid stroke="#e6eee9" vertical={false} />
                <XAxis dataKey="name" tick={{ fontSize: 12 }} />
                <YAxis tick={{ fontSize: 12 }} />
                <Tooltip formatter={(v) => inr(Number(v))} />
                <Bar
                  dataKey="leakage"
                  fill={palette.danger}
                  radius={[8, 8, 0, 0]}
                />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Panel>
      </div>

      <div className="mt-5 grid gap-4 xl:grid-cols-2">
        <Panel title="Detection categories">
          <div className="h-64">
            <ResponsiveContainer>
              <BarChart
                data={categories}
                layout="vertical"
                margin={{ left: 24 }}
              >
                <CartesianGrid stroke="#e6eee9" horizontal={false} />
                <XAxis type="number" tick={{ fontSize: 12 }} />
                <YAxis
                  type="category"
                  dataKey="name"
                  width={140}
                  tick={{ fontSize: 11 }}
                />
                <Tooltip />
                <Bar
                  dataKey="count"
                  fill={palette.flagged}
                  radius={[0, 8, 8, 0]}
                  cursor="pointer"
                  onClick={() => navigate("/alerts")}
                />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Panel>
        <Panel
          title="Funnel · processed to special review"
          action={
            <span className="text-xs text-mute">
              {funnel.map((f) => f.value).join(" → ")}
            </span>
          }
        >
          <div className="space-y-3">
            {funnel.map((f) => (
              <Link
                key={f.name}
                to={`/claims?tab=${f.tab}`}
                className="group -mx-2 block rounded-lg px-2 py-1 transition hover:bg-mist"
              >
                <div className="mb-1 flex justify-between text-xs">
                  <span className="group-hover:font-medium">{f.name}</span>
                  <span className="font-mono">{f.value}</span>
                </div>
                <div className="h-2 rounded-full bg-mist group-hover:bg-white">
                  <div
                    className="h-2 rounded-full transition-all duration-500"
                    style={{
                      background: f.color,
                      width: `${Math.max(8, (f.value / (processed || 1)) * 100)}%`,
                    }}
                  />
                </div>
              </Link>
            ))}
          </div>
          <p className="mt-4 text-xs text-mute">
            Incomplete packs stay in unassessed. They never inflate confirmed
            leakage.
          </p>
        </Panel>
      </div>

      <Panel
        title="Highest risk on desk"
        action={
          <Link to="/alerts" className="text-xs text-brand-dark">
            Open alerts
          </Link>
        }
      >
        <div className="overflow-x-auto">
          <table className="w-full min-w-180 text-left text-sm">
            <thead className="text-xs uppercase tracking-wide text-mute">
              <tr>
                <th className="pb-3">Claim</th>
                <th className="pb-3">Claimant</th>
                <th className="pb-3">Domain</th>
                <th className="pb-3">Requested</th>
                <th className="pb-3">Risk</th>
                <th className="pb-3">Queue</th>
              </tr>
            </thead>
            <tbody>
              {hot.map((c) => (
                <tr
                  key={c.id}
                  onClick={() => navigate(`/claims/${c.id}`)}
                  className="cursor-pointer border-t border-line transition-colors hover:bg-mist"
                >
                  <td className="py-3 pl-2">
                    <Link
                      className="font-medium text-ink hover:text-brand-dark hover:underline"
                      to={`/claims/${c.id}`}
                      onClick={(e) => e.stopPropagation()}
                    >
                      {c.id}
                    </Link>
                  </td>
                  <td>{c.claimant}</td>
                  <td>{c.domain}</td>
                  <td className="font-mono">{inr(c.requestedAmount)}</td>
                  <td>
                    <RiskPill score={c.riskScore} />
                  </td>
                  <td>
                    <QueueBadge queue={c.queue} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
    </div>
  );
}
