import {
  AlertTriangle,
  Check,
  FileText,
  Library,
  Loader2,
  Plus,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { EmptyState, PageHeader, Panel } from "../components/ui";
import { inr } from "../lib/format";
import { useAppStore, type MasterPolicy as MasterPolicyEntry } from "../store/useAppStore";

function Term({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-line py-2 text-sm last:border-0">
      <span className="text-mute">{label}</span>
      <span className="font-mono font-semibold text-ink">{value}</span>
    </div>
  );
}

function PolicyDetail({ entry }: { entry: MasterPolicyEntry }) {
  const policy = entry.extraction.policy;
  const sublimits = policy.sublimits ?? [];
  const waiting = policy.waiting_periods ?? [];
  const exclusions = policy.exclusions ?? [];
  const hasTerms =
    policy.deductible != null ||
    policy.copayment_percentage != null ||
    policy.sum_insured != null ||
    sublimits.length > 0 ||
    waiting.length > 0;

  return (
    <>
      <Panel title="Policy terms">
        {hasTerms ? (
          <>
            {policy.sum_insured != null ? (
              <Term label="Sum insured" value={inr(policy.sum_insured)} />
            ) : null}
            {policy.deductible != null ? (
              <Term label="Deductible" value={inr(policy.deductible)} />
            ) : null}
            {policy.copayment_percentage != null ? (
              <Term
                label="Co-payment"
                value={`${policy.copayment_percentage}%`}
              />
            ) : null}
            {sublimits.map((s) => (
              <Term
                key={`${s.category}-${s.daily_limit ?? s.limit}`}
                label={`${s.category.replace(/_/g, " ")} ${s.daily_limit != null ? "(per day)" : "(per year)"}`}
                value={inr(s.daily_limit ?? s.limit ?? 0)}
              />
            ))}
            {waiting.map((w) => (
              <Term
                key={`wp-${w.days}-${w.category ?? "all"}`}
                label={`Waiting period${w.category ? ` — ${w.category}` : " (policy-wide)"}`}
                value={`${w.days} days`}
              />
            ))}
          </>
        ) : (
          <p className="text-sm text-mute">
            No numeric terms were stated in this document.
          </p>
        )}
      </Panel>

      {exclusions.length ? (
        <Panel title={`Exclusions (${exclusions.length})`}>
          <ul className="space-y-2">
            {exclusions.map((e) => (
              <li
                key={e.description.slice(0, 40)}
                className="rounded-xl border border-line p-3"
              >
                <p className="text-xs font-semibold uppercase tracking-wide text-brand-dark">
                  {e.category.replace(/_/g, " ")}
                </p>
                <p className="mt-1 text-sm text-ink">{e.description}</p>
                {e.clause_reference ? (
                  <p className="mt-1 text-xs text-mute">{e.clause_reference}</p>
                ) : null}
              </li>
            ))}
          </ul>
        </Panel>
      ) : null}

      {entry.extraction.unresolved.length ? (
        <Panel
          title={`Not stated in this document (${entry.extraction.unresolved.length})`}
        >
          <ul className="space-y-1.5 text-sm">
            {entry.extraction.unresolved.map((u) => (
              <li key={u.field}>
                <span className="font-medium text-ink">
                  {u.field.replace(/_/g, " ")}
                </span>
                <span className="text-xs text-mute"> — {u.engine_behaviour}</span>
              </li>
            ))}
          </ul>
        </Panel>
      ) : null}
    </>
  );
}

export function MasterPolicy() {
  const {
    masterPolicies,
    masterPoliciesStatus,
    masterPoliciesError,
    loadMasterPolicies,
    policyFromDocument,
    selectMasterPolicy,
    removeMasterPolicy,
  } = useAppStore();
  const [openId, setOpenId] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
  const [removeError, setRemoveError] = useState("");

  useEffect(() => {
    void loadMasterPolicies();
  }, [loadMasterPolicies]);

  async function remove(id: string) {
    setRemoving(true);
    setRemoveError("");
    try {
      await removeMasterPolicy(id);
      setConfirmId(null);
      setOpenId(null);
    } catch (err) {
      setRemoveError(
        err instanceof Error ? err.message : "Could not remove that policy",
      );
    } finally {
      setRemoving(false);
    }
  }

  const selected =
    masterPolicies.find((p) => p.id === openId) ?? masterPolicies[0] ?? null;
  const activeId = policyFromDocument?.masterId ?? null;

  return (
    <div>
      <PageHeader
        eyebrow="Policy intelligence"
        title="Master policy"
        description="Every policy document you add is stored in the database. Pick the policy a claim should be assessed against and it is applied to the next ingest. Terms the claim pack carries itself still take precedence."
        actions={
          <Link
            to="/policy"
            className="inline-flex items-center gap-1.5 rounded-xl bg-ink px-4 py-2.5 text-sm font-medium text-white transition hover:bg-ink/90"
          >
            <Plus className="h-4 w-4" />
            Add a policy document
          </Link>
        }
      />

      {masterPoliciesStatus === "error" ? (
        <div
          className="mb-4 flex items-start gap-2 rounded-xl border border-line bg-white px-4 py-3 text-sm text-ink"
          role="alert"
        >
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-brand-dark" />
          <span className="flex-1">
            The master policy could not be loaded: {masterPoliciesError}
          </span>
          <button
            type="button"
            onClick={() => void loadMasterPolicies()}
            className="inline-flex items-center gap-1.5 text-xs font-medium text-brand-dark hover:underline"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Retry
          </button>
        </div>
      ) : null}

      {removeError ? (
        <div
          className="mb-4 flex items-start gap-2 rounded-xl border border-line bg-white px-4 py-3 text-sm text-ink"
          role="alert"
        >
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-brand-dark" />
          <span>{removeError}</span>
        </div>
      ) : null}

      {masterPolicies.length === 0 &&
      (masterPoliciesStatus === "loading" ||
        masterPoliciesStatus === "idle") ? (
        <div className="flex items-center justify-center gap-2 rounded-2xl border border-dashed border-line bg-white px-6 py-16 text-sm text-mute">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading the master policy…
        </div>
      ) : masterPolicies.length === 0 ? (
        <EmptyState
          title="No policies in the master policy yet"
          body="Read a policy document on the Policy reader page and choose “Add to master policy”. It will appear here for selection."
        />
      ) : (
        <div className="grid gap-4 xl:grid-cols-5">
          <div className="space-y-2 xl:col-span-2">
            <p className="text-xs font-semibold uppercase tracking-wide text-mute">
              {masterPolicies.length}{" "}
              {masterPolicies.length === 1 ? "policy" : "policies"} stored
            </p>
            {masterPolicies.map((p) => {
              const isOpen = selected?.id === p.id;
              const isActive = activeId === p.id;
              return (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => {
                    setOpenId(p.id);
                    setConfirmId(null);
                  }}
                  className={`flex w-full items-start gap-3 rounded-2xl border bg-white p-4 text-left shadow-sm transition hover:border-brand ${
                    isOpen ? "border-brand ring-1 ring-brand/30" : "border-line"
                  }`}
                >
                  <FileText className="mt-0.5 h-4 w-4 shrink-0 text-brand-dark" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-semibold text-ink">
                      {p.name}
                    </span>
                    <span className="mt-0.5 block truncate text-xs text-mute">
                      {p.policyNumber} · {p.sourceName}
                    </span>
                    <span className="mt-0.5 block text-xs text-mute">
                      Added {new Date(p.addedAt).toLocaleDateString()}
                    </span>
                  </span>
                  {isActive ? (
                    <span className="shrink-0 rounded-full bg-brand/20 px-2 py-0.5 text-[10px] font-bold text-[#0b6b45]">
                      IN USE
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>

          <div className="space-y-4 xl:col-span-3">
            {selected ? (
              <>
                <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-line bg-white p-4 shadow-sm">
                  <div className="min-w-0">
                    <p className="flex items-center gap-2 text-sm font-semibold text-ink">
                      <Library className="h-4 w-4 text-brand-dark" />
                      <span className="truncate">{selected.name}</span>
                    </p>
                    <p className="mt-0.5 text-xs text-mute">
                      {selected.extraction.facts.length} cited facts ·{" "}
                      {selected.extraction.document.clauses_detected} clauses
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    {confirmId === selected.id ? (
                      <>
                        <button
                          type="button"
                          onClick={() => void remove(selected.id)}
                          disabled={removing}
                          className="rounded-lg bg-red-600 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-red-700 disabled:opacity-50"
                        >
                          {removing ? "Removing…" : "Confirm remove"}
                        </button>
                        <button
                          type="button"
                          onClick={() => setConfirmId(null)}
                          className="rounded-lg border border-line px-3 py-1.5 text-xs font-medium text-ink transition hover:border-brand"
                        >
                          Cancel
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          type="button"
                          onClick={() => setConfirmId(selected.id)}
                          aria-label={`Remove ${selected.name}`}
                          className="inline-flex items-center gap-1.5 rounded-lg border border-line px-3 py-1.5 text-xs font-medium text-mute transition hover:border-red-300 hover:text-red-600"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                          Remove
                        </button>
                        {activeId === selected.id ? (
                          <button
                            type="button"
                            onClick={() => selectMasterPolicy(null)}
                            className="rounded-lg border border-line px-3 py-1.5 text-xs font-medium text-ink transition hover:border-brand"
                          >
                            Stop using
                          </button>
                        ) : (
                          <button
                            type="button"
                            onClick={() => selectMasterPolicy(selected.id)}
                            className="inline-flex items-center gap-1.5 rounded-lg bg-brand px-3 py-1.5 text-xs font-medium text-ink transition hover:bg-brand/80"
                          >
                            <Check className="h-3.5 w-3.5" />
                            Use for next ingest
                          </button>
                        )}
                      </>
                    )}
                  </div>
                </div>
                <PolicyDetail entry={selected} />
              </>
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
}
