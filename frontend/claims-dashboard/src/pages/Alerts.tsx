import { useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { Filter, RotateCcw } from "lucide-react";
import {
  EmptyState,
  PageHeader,
  QueueBadge,
  SeverityBadge,
} from "../components/ui";
import {
  findingLabel,
  inr,
  severityBorder,
  severityDot,
  severityOrder,
  severityTone,
} from "../lib/format";
import { useAppStore } from "../store/useAppStore";
import type { Certainty, FindingKind, Severity } from "../types";

export function Alerts() {
  const claims = useAppStore((s) => s.claims);
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [kind, setKind] = useState("all");
  const [certainty, setCertainty] = useState("all");
  const [minRisk, setMinRisk] = useState(0);
  const [provider, setProvider] = useState("all");
  // A severity chip elsewhere in the app links here with ?severity=critical.
  const [severity, setSeverity] = useState(() => {
    const fromUrl = params.get("severity");
    return severityOrder.includes(fromUrl as Severity) ? (fromUrl as string) : "all";
  });
  const [reviewStatus, setReviewStatus] = useState("all");
  const [claimType, setClaimType] = useState("all");
  const [domain, setDomain] = useState("all");
  const [minAmount, setMinAmount] = useState("");
  const [maxAmount, setMaxAmount] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");

  const rows = useMemo(() => {
    return claims
      .flatMap((c) => c.findings.map((f) => ({ claim: c, finding: f })))
      .filter((r) => (kind === "all" ? true : r.finding.kind === kind))
      .filter((r) =>
        certainty === "all" ? true : r.finding.certainty === certainty,
      )
      .filter((r) => provider === "all" || r.claim.provider === provider)
      .filter((r) => severity === "all" || r.finding.severity === severity)
      .filter(
        (r) =>
          reviewStatus === "all" ||
          (r.finding.reviewStatus ?? "PENDING") === reviewStatus,
      )
      .filter((r) => claimType === "all" || r.claim.claimType === claimType)
      .filter((r) => domain === "all" || r.claim.domain === domain)
      .filter((r) => !minAmount || r.finding.leakageAmount >= Number(minAmount))
      .filter((r) => !maxAmount || r.finding.leakageAmount <= Number(maxAmount))
      .filter((r) => !dateFrom || r.claim.incidentDate >= dateFrom)
      .filter((r) => !dateTo || r.claim.incidentDate <= dateTo)
      .filter((r) => r.claim.riskScore >= minRisk)
      .sort((a, b) => b.finding.leakageAmount - a.finding.leakageAmount);
  }, [
    claims,
    kind,
    certainty,
    minRisk,
    provider,
    severity,
    reviewStatus,
    claimType,
    domain,
    minAmount,
    maxAmount,
    dateFrom,
    dateTo,
  ]);

  const kinds = Array.from(
    new Set(claims.flatMap((c) => c.findings.map((f) => f.kind))),
  );
  const providers = Array.from(
    new Set(claims.map((claim) => claim.provider).filter(Boolean)),
  ).sort();
  const claimTypes = Array.from(
    new Set(claims.map((claim) => claim.claimType).filter(Boolean)),
  ).sort();

  const severityCounts = severityOrder.map((value) => ({
    value,
    count: claims
      .flatMap((c) => c.findings)
      .filter((f) => f.severity === value).length,
  }));

  return (
    <div>
      <PageHeader
        eyebrow="Investigation"
        title="Fraud alerts & leakage findings"
        description="Each row is an explainable finding. Confirmed amounts are calculated. Potential amounts stay out of savings. Legitimate repeats are labelled so they are not treated as duplicates."
      />
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => setSeverity("all")}
          aria-pressed={severity === "all"}
          className={`rounded-full px-3 py-1.5 text-xs font-medium transition hover:-translate-y-0.5 ${
            severity === "all"
              ? "bg-ink text-white shadow-md"
              : "border border-line bg-white text-ink hover:border-ink/40"
          }`}
        >
          All severities
        </button>
        {severityCounts.map(({ value, count }) => {
          const active = severity === value;
          return (
            <button
              key={value}
              type="button"
              onClick={() => setSeverity(active ? "all" : value)}
              aria-pressed={active}
              className={`inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-xs font-medium capitalize transition hover:-translate-y-0.5 hover:shadow-md ${severityTone[value]} ${
                active ? "ring-2 ring-ink ring-offset-2" : "opacity-80 hover:opacity-100"
              }`}
            >
              <span
                className={`h-2 w-2 rounded-full ${value === "critical" ? "bg-white" : severityDot[value]}`}
              />
              {value}
              <span className="font-mono font-semibold">{count}</span>
            </button>
          );
        })}
        <span className="ml-auto text-xs text-mute" aria-live="polite">
          {rows.length} finding{rows.length === 1 ? "" : "s"} shown
        </span>
      </div>
      <div className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-mute">
        <Filter size={14} /> Filter findings
      </div>
      <div className="mb-4 flex flex-wrap gap-2 rounded-2xl border border-line bg-white p-3">
        <select
          value={kind}
          onChange={(e) => setKind(e.target.value)}
          className="rounded-xl border border-line bg-white px-3 py-2 text-sm"
        >
          <option value="all">All categories</option>
          {kinds.map((k) => (
            <option key={k} value={k}>
              {findingLabel[k as FindingKind]}
            </option>
          ))}
        </select>
        <select
          value={provider}
          onChange={(e) => setProvider(e.target.value)}
          className="rounded-xl border border-line bg-white px-3 py-2 text-sm"
        >
          <option value="all">All providers</option>
          {providers.map((name) => (
            <option key={name}>{name}</option>
          ))}
        </select>
        <select
          value={claimType}
          onChange={(e) => setClaimType(e.target.value)}
          className="rounded-xl border border-line bg-white px-3 py-2 text-sm"
        >
          <option value="all">All claim types</option>
          {claimTypes.map((name) => (
            <option key={name}>{name}</option>
          ))}
        </select>
        <select
          value={domain}
          onChange={(e) => setDomain(e.target.value)}
          className="rounded-xl border border-line bg-white px-3 py-2 text-sm"
        >
          <option value="all">All domains</option>
          {(["Health", "Motor", "General"] as const).map((name) => (
            <option key={name}>{name}</option>
          ))}
        </select>
        <input
          aria-label="Minimum finding amount"
          type="number"
          min="0"
          value={minAmount}
          onChange={(e) => setMinAmount(e.target.value)}
          placeholder="Min ₹"
          className="w-24 rounded-xl border border-line px-3 py-2 text-sm"
        />
        <input
          aria-label="Maximum finding amount"
          type="number"
          min="0"
          value={maxAmount}
          onChange={(e) => setMaxAmount(e.target.value)}
          placeholder="Max ₹"
          className="w-24 rounded-xl border border-line px-3 py-2 text-sm"
        />
        <select
          value={severity}
          onChange={(e) => setSeverity(e.target.value)}
          className="rounded-xl border border-line bg-white px-3 py-2 text-sm"
        >
          <option value="all">All severities</option>
          {(["critical", "high", "medium", "low"] as const).map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
        <select
          value={reviewStatus}
          onChange={(e) => setReviewStatus(e.target.value)}
          className="rounded-xl border border-line bg-white px-3 py-2 text-sm"
        >
          <option value="all">All review states</option>
          {[
            "PENDING",
            "CONFIRMED",
            "DISMISSED",
            "REQUEST_EVIDENCE",
            "CORRECTED",
          ].map((value) => (
            <option key={value}>{value}</option>
          ))}
        </select>
        <label className="flex items-center gap-2 rounded-xl border border-line px-3 py-2 text-xs text-mute">
          From{" "}
          <input
            type="date"
            value={dateFrom}
            onChange={(e) => setDateFrom(e.target.value)}
            className="text-sm text-ink"
          />
        </label>
        <label className="flex items-center gap-2 rounded-xl border border-line px-3 py-2 text-xs text-mute">
          To{" "}
          <input
            type="date"
            value={dateTo}
            onChange={(e) => setDateTo(e.target.value)}
            className="text-sm text-ink"
          />
        </label>
        <select
          value={certainty}
          onChange={(e) => setCertainty(e.target.value)}
          className="rounded-xl border border-line bg-white px-3 py-2 text-sm"
        >
          <option value="all">All certainty</option>
          {(["confirmed", "potential", "unassessed"] as Certainty[]).map(
            (c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ),
          )}
        </select>
        <label className="flex items-center gap-2 rounded-xl border border-line bg-white px-3 py-2 text-sm">
          Min risk
          <input
            type="range"
            min={0}
            max={100}
            value={minRisk}
            onChange={(e) => setMinRisk(Number(e.target.value))}
          />
          <span className="font-mono">{minRisk}</span>
        </label>
        <button
          type="button"
          title="Reset filters"
          onClick={() => {
            setKind("all");
            setCertainty("all");
            setMinRisk(0);
            setProvider("all");
            setSeverity("all");
            setReviewStatus("all");
            setClaimType("all");
            setDomain("all");
            setMinAmount("");
            setMaxAmount("");
            setDateFrom("");
            setDateTo("");
          }}
          className="inline-flex items-center gap-1 rounded-xl border border-line px-3 py-2 text-sm"
        >
          <RotateCcw size={14} /> Reset
        </button>
      </div>

      {rows.length === 0 ? (
        <EmptyState
          title="No findings for these filters"
          body="Relax the filters or ingest a new pack."
        />
      ) : (
        <div className="overflow-x-auto rounded-2xl border border-line bg-white">
          <table className="w-full min-w-240 text-left text-sm">
            <thead className="bg-mist text-xs uppercase tracking-wide text-mute">
              <tr>
                <th className="px-4 py-3">Finding</th>
                <th className="px-4 py-3">Claim</th>
                <th className="px-4 py-3">Engine</th>
                <th className="px-4 py-3">Certainty</th>
                <th className="px-4 py-3">Review</th>
                <th className="px-4 py-3">Severity</th>
                <th className="px-4 py-3">Amount</th>
                <th className="px-4 py-3">Queue</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ claim, finding }) => (
                <tr
                  key={finding.id}
                  onClick={() => navigate(`/claims/${claim.id}`)}
                  className="cursor-pointer border-t border-line align-top transition-colors hover:bg-mist/60"
                >
                  <td
                    className={`border-l-4 px-4 py-3 ${severityBorder[finding.severity]}`}
                  >
                    <p className="font-medium">{finding.title}</p>
                    <p className="mt-1 max-w-md text-xs text-mute">
                      {finding.explanation}
                    </p>
                  </td>
                  <td className="px-4 py-3">
                    <Link
                      className="font-medium hover:text-brand-dark hover:underline"
                      to={`/claims/${claim.id}`}
                      onClick={(e) => e.stopPropagation()}
                    >
                      {claim.id}
                    </Link>
                    <p className="text-xs text-mute">{claim.claimant}</p>
                  </td>
                  <td className="px-4 py-3 font-mono text-xs">
                    {finding.engine}
                  </td>
                  <td className="px-4 py-3 text-xs">{finding.certainty}</td>
                  <td className="px-4 py-3 text-xs">
                    {finding.reviewStatus ?? "PENDING"}
                  </td>
                  <td className="px-4 py-3">
                    <SeverityBadge severity={finding.severity} />
                  </td>
                  <td className="px-4 py-3 font-mono">
                    {finding.leakageAmount ? inr(finding.leakageAmount) : "—"}
                  </td>
                  <td className="px-4 py-3">
                    <QueueBadge queue={claim.queue} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
