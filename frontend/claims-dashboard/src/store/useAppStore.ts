import { create } from "zustand";
import { persist } from "zustand/middleware";
import { investigationDemoClaims } from "../data/investigationDemo";
import { allSeedClaims, seedAudit } from "../data/seed";
import { payloadToClaim } from "../lib/payloadToClaim";
import {
  DEFAULT_AGENT_URL,
  recalculateAnalysis,
  reviewFinding as postFindingReview,
} from "../lib/api";
import type { FindingReviewAction } from "../lib/api";
import { extractDocument } from "../lib/documents";
import { uid } from "../lib/format";
import {
  analyseClaim,
  buildDecision,
  eventsForNewDocument,
  makeEvent,
  openInvestigation as baselineInvestigation,
  escalationLabel,
  type DecisionInput,
} from "../lib/investigation";
import {
  deleteMasterPolicy,
  listMasterPolicies,
  saveMasterPolicy,
  type MasterPolicy,
} from "../lib/masterPolicyApi";
import type { ExtractedPolicy, PolicyExtraction } from "../lib/policyRag";
import type {
  Actor,
  Decision,
  Finding,
  Investigation,
  InvestigationEvent,
  AuditEvent,
  Claim,
  ClaimNote,
  ClaimQueue,
  DetectionPayload,
  IngestJob,
  Role,
} from "../types";

type Filters = {
  domain: string;
  queue: string;
  search: string;
};

export type { MasterPolicy };

type MasterPoliciesStatus = "idle" | "loading" | "ready" | "error";

type AppState = {
  role: Role;
  agentUrl: string;
  claims: Claim[];
  audit: AuditEvent[];
  jobs: IngestJob[];
  /**
   * Cache of the master policy library. The database behind the detection engine is the source of
   * truth, so this is never persisted; call loadMasterPolicies to refresh it.
   */
  masterPolicies: MasterPolicy[];
  masterPoliciesStatus: MasterPoliciesStatus;
  masterPoliciesError: string;
  /** Terms read out of a policy document by the engine's RAG pipeline, ready to apply to an ingest. */
  policyFromDocument: {
    policy: ExtractedPolicy;
    sourceName: string;
    at: string;
    /** Set when the terms were picked from the master policy library. */
    masterId?: string;
  } | null;
  filters: Filters;
  /** Who is signed in as the analyst. Self-declared: the app has no login. */
  analyst: { name: string };
  setRole: (role: Role) => void;
  setAnalystName: (name: string) => void;
  /** Creates the investigation record (baseline calculation, issues, recommendations) if it does not exist. */
  openInvestigation: (claimId: string) => void;
  /** Reads a supporting document into the claim and records what it changed. Returns the document id. */
  attachDocument: (claimId: string, file: { name: string; text: string }) => string;
  /** Records a decision on one issue. Throws a readable error if the decision is not valid. */
  recordDecision: (claimId: string, input: Omit<DecisionInput, "issue" | "by"> & { issueId: string }) => Decision;
  addInvestigationNote: (claimId: string, text: string, issueId?: string) => void;
  setAgentUrl: (url: string) => void;
  setPolicyFromDocument: (
    entry: {
      policy: ExtractedPolicy;
      sourceName: string;
      masterId?: string;
    } | null,
  ) => void;
  loadMasterPolicies: () => Promise<void>;
  /** Stores a policy in the database; the same source file replaces its earlier entry. Returns the id. */
  addMasterPolicy: (entry: {
    sourceName: string;
    text: string;
    extraction: PolicyExtraction;
    name?: string;
  }) => Promise<string>;
  removeMasterPolicy: (id: string) => Promise<void>;
  /** Applies a master policy to the next ingest; pass null to clear the selection. */
  selectMasterPolicy: (id: string | null) => void;
  setFilters: (partial: Partial<Filters>) => void;
  addJob: (job: IngestJob) => void;
  updateJob: (id: string, patch: Partial<IngestJob>) => void;
  ingestPayloadAsClaim: (payload: DetectionPayload) => string;
  addAgentClaim: (claim: Claim) => string;
  /** Returns the queue the claim was in before the move (for undo). */
  moveQueue: (
    claimId: string,
    queue: ClaimQueue,
    reason?: string,
  ) => ClaimQueue | undefined;
  /** Saves a queue decision and an optional note in one step. */
  saveReview: (
    claimId: string,
    review: { queue: ClaimQueue; note?: string },
  ) => void;
  reviewFinding: (
    claimId: string,
    findingId: string,
    action: FindingReviewAction,
    notes?: string,
    correctedAmount?: number,
  ) => Promise<void>;
  addNote: (claimId: string, note: string) => void;
  log: (event: Omit<AuditEvent, "id" | "at">) => void;
  /** Empties the desk and the audit trail in this browser. The database is untouched. */
  clearLocalData: () => void;
  /** Fills the desk with the bundled demo portfolio, for walkthroughs. */
  loadDemoData: () => void;
};

function actorOf(state: { analyst: { name: string }; role: Role }): Actor {
  return { name: state.analyst.name.trim() || "Analyst", role: state.role };
}

/** Maps an investigation decision onto the older per-finding review status. */
const REVIEW_STATUS: Partial<Record<Decision["type"], NonNullable<Finding["reviewStatus"]>>> = {
  CONFIRM_DISCREPANCY: "CONFIRMED",
  FALSE_POSITIVE: "DISMISSED",
  REQUEST_EVIDENCE: "REQUEST_EVIDENCE",
  ACCEPT_CORRECTION: "CORRECTED",
};

/** The only way events get into a claim's history: appended, never edited or removed. */
function appendEvents(claim: Claim, events: InvestigationEvent[], decision?: Decision): Claim {
  const inv: Investigation | undefined = claim.investigation;
  if (!inv) return claim;
  return {
    ...claim,
    investigation: {
      ...inv,
      events: [...inv.events, ...events],
      decisions: decision ? [...inv.decisions, decision] : inv.decisions,
    },
  };
}

export const useAppStore = create<AppState>()(
  persist(
    (set, get) => ({
      role: "handler",
      analyst: { name: "" },
      agentUrl: DEFAULT_AGENT_URL,
      claims: [],
      audit: [],
      jobs: [],
      masterPolicies: [],
      masterPoliciesStatus: "idle",
      masterPoliciesError: "",
      policyFromDocument: null,
      filters: { domain: "all", queue: "all", search: "" },
      setRole: (role) => set({ role }),
      setAnalystName: (name) => set({ analyst: { name } }),
      openInvestigation: (claimId) => {
        const claim = get().claims.find((c) => c.id === claimId);
        if (!claim || claim.investigation) return;
        const by = actorOf(get());
        const investigation = baselineInvestigation(analyseClaim(claim, get().claims), by);
        set({ claims: get().claims.map((c) => (c.id === claimId ? { ...c, investigation } : c)) });
        get().log({ actor: by.name, action: "Investigation opened", detail: claim.id, claimId });
      },
      attachDocument: (claimId, file) => {
        get().openInvestigation(claimId);
        const claim = get().claims.find((c) => c.id === claimId);
        if (!claim) throw new Error("That claim is no longer on the desk.");
        if (!file.text.trim()) throw new Error("No readable text came out of that document.");
        const by = actorOf(get());
        const doc = extractDocument({ id: uid("DOC"), name: file.name, text: file.text, addedBy: by.name });
        const before = analyseClaim(claim, get().claims);
        const next = { ...claim, documents: [...(claim.documents ?? []), doc] };
        const after = analyseClaim(next, get().claims);
        const events = eventsForNewDocument(
          before,
          after,
          {
            id: doc.id,
            name: doc.name,
            kind: doc.kind,
            fieldCount: Object.values(doc.fields).filter(Boolean).length,
            lineItemCount: doc.lineItems.length,
          },
          by,
        );
        set({ claims: get().claims.map((c) => (c.id === claimId ? appendEvents(next, events) : c)) });
        get().log({ actor: by.name, action: "Document attached to investigation", detail: `${doc.name} · ${doc.kind.replace("_", " ")}`, claimId });
        return doc.id;
      },
      recordDecision: (claimId, { issueId, ...input }) => {
        get().openInvestigation(claimId);
        const claim = get().claims.find((c) => c.id === claimId);
        if (!claim) throw new Error("That claim is no longer on the desk.");
        const issue = analyseClaim(claim, get().claims).issues.find((i) => i.id === issueId);
        if (!issue) throw new Error("That item is no longer part of this investigation.");
        const by = actorOf(get());
        const { decision, events } = buildDecision({ ...input, issue, by });

        let updated: typeof claim = { ...claim };
        // Keep the older per-finding review status in step, so the claim page agrees with the workspace.
        const status = REVIEW_STATUS[decision.type];
        if (status && claim.findings.some((f) => f.id === issueId)) {
          updated.findings = claim.findings.map((f): Finding => (f.id === issueId ? { ...f, reviewStatus: status } : f));
        }
        const extra: InvestigationEvent[] = [];
        if (decision.type === "ESCALATE" && decision.escalateTo) {
          updated = {
            ...updated,
            queue: "special",
            specialReason: `Escalated to ${escalationLabel[decision.escalateTo]}: ${decision.reason}`,
          };
          if (claim.queue !== "special") {
            extra.push(makeEvent(by, "queue_changed", `Moved from ${claim.queue} to special review by escalation`, { from: claim.queue, to: "special" }));
          }
        }
        updated = appendEvents(updated, [...events, ...extra], decision);
        set({ claims: get().claims.map((c) => (c.id === claimId ? updated : c)) });
        get().log({
          actor: by.name,
          action: `Investigation decision: ${decision.type.toLowerCase().replace(/_/g, " ")}`,
          detail: `${issue.title}${decision.reason ? ` · ${decision.reason}` : ""}`,
          claimId,
        });
        return decision;
      },
      addInvestigationNote: (claimId, text, issueId) => {
        const body = text.trim();
        if (!body) return;
        get().openInvestigation(claimId);
        const claim = get().claims.find((c) => c.id === claimId);
        if (!claim?.investigation) return;
        const by = actorOf(get());
        const note = { id: uid("NOTE"), at: new Date().toISOString(), by, text: body, issueId };
        const event = makeEvent(by, "note", `Note added${issueId ? " on an issue" : ""}: ${body.slice(0, 120)}`, note, note.at);
        const updated = appendEvents(claim, [event]);
        set({
          claims: get().claims.map((c) =>
            c.id === claimId ? { ...updated, investigation: { ...updated.investigation!, notes: [note, ...updated.investigation!.notes] } } : c,
          ),
        });
      },
      setAgentUrl: (agentUrl) => set({ agentUrl }),
      setPolicyFromDocument: (entry) =>
        set({
          policyFromDocument: entry
            ? { ...entry, at: new Date().toISOString() }
            : null,
        }),
      loadMasterPolicies: async () => {
        set({ masterPoliciesStatus: "loading", masterPoliciesError: "" });
        try {
          const policies = await listMasterPolicies(get().agentUrl);
          const armed = get().policyFromDocument;
          set({
            masterPolicies: policies,
            masterPoliciesStatus: "ready",
            // A policy removed elsewhere must not stay armed for the next ingest.
            policyFromDocument:
              armed?.masterId && !policies.some((p) => p.id === armed.masterId)
                ? null
                : armed,
          });
        } catch (err) {
          set({
            masterPoliciesStatus: "error",
            masterPoliciesError:
              err instanceof Error
                ? err.message
                : "Could not load the master policy",
          });
        }
      },
      addMasterPolicy: async ({ sourceName, text, extraction, name }) => {
        const existing = get().masterPolicies.find(
          (p) => p.sourceName === sourceName,
        );
        const saved = await saveMasterPolicy(get().agentUrl, {
          sourceName,
          text,
          extraction,
          name,
        });
        const armed = get().policyFromDocument;
        set({
          masterPolicies: [
            saved,
            ...get().masterPolicies.filter((p) => p.id !== saved.id),
          ],
          // Re-saving a policy that is currently armed must not leave stale terms behind.
          policyFromDocument:
            armed?.masterId === saved.id
              ? {
                  policy: saved.extraction.policy,
                  sourceName: saved.name,
                  masterId: saved.id,
                  at: new Date().toISOString(),
                }
              : armed,
        });
        get().log({
          actor: "Master policy",
          action: existing
            ? "Updated a policy in the master library"
            : "Added a policy to the master library",
          detail: `${saved.name} · ${sourceName}`,
        });
        return saved.id;
      },
      removeMasterPolicy: async (id) => {
        const target = get().masterPolicies.find((p) => p.id === id);
        if (!target) return;
        await deleteMasterPolicy(get().agentUrl, id);
        const armed = get().policyFromDocument;
        set({
          masterPolicies: get().masterPolicies.filter((p) => p.id !== id),
          policyFromDocument: armed?.masterId === id ? null : armed,
        });
        get().log({
          actor: "Master policy",
          action: "Removed a policy from the master library",
          detail: `${target.name} · ${target.sourceName}`,
        });
      },
      selectMasterPolicy: (id) => {
        if (id === null) {
          set({ policyFromDocument: null });
          return;
        }
        const target = get().masterPolicies.find((p) => p.id === id);
        if (!target) return;
        get().setPolicyFromDocument({
          policy: target.extraction.policy,
          sourceName: target.name,
          masterId: id,
        });
        get().log({
          actor: "Master policy",
          action: "Selected a master policy for the next ingest",
          detail: `${target.name} · ${target.policyNumber}`,
        });
      },
      setFilters: (partial) =>
        set({ filters: { ...get().filters, ...partial } }),
      addJob: (job) => set({ jobs: [job, ...get().jobs].slice(0, 20) }),
      updateJob: (id, patch) =>
        set({
          jobs: get().jobs.map((j) => (j.id === id ? { ...j, ...patch } : j)),
        }),
      ingestPayloadAsClaim: (payload) => {
        const claim = payloadToClaim(payload, get().claims);
        const existing = get().claims.find((c) => c.id === claim.id);
        if (existing) claim.id = `${claim.id}-${uid("R").slice(-4)}`;
        set({ claims: [claim, ...get().claims] });
        get().log({
          actor: "Preview detection",
          action: "Claim pack ingested and scored",
          detail: `${claim.id} · ${claim.findings.length} findings · queue ${claim.queue} · ${payload.source.engine}`,
          claimId: claim.id,
        });
        return claim.id;
      },
      addAgentClaim: (incoming) => {
        const claim = { ...incoming };
        if (get().claims.some((c) => c.id === claim.id))
          claim.id = `${claim.id}-${uid("R").slice(-4)}`;
        set({ claims: [claim, ...get().claims] });
        get().log({
          actor: "ClaimsGuard engine",
          action: "Claim analysed by detection engine",
          detail: `${claim.id} · ${claim.findings.length} findings · queue ${claim.queue} · risk ${claim.riskScore}`,
          claimId: claim.id,
        });
        return claim.id;
      },
      moveQueue: (claimId, queue, reason) => {
        const previous = get().claims.find((c) => c.id === claimId)?.queue;
        set({
          claims: get().claims.map((c) =>
            c.id === claimId
              ? {
                  ...c,
                  queue,
                  specialReason:
                    queue === "special"
                      ? (reason ?? c.specialReason)
                      : c.specialReason,
                }
              : c,
          ),
        });
        get().log({
          actor: get().role === "supervisor" ? "Supervisor" : "Claims handler",
          action: `Moved to ${queue}`,
          detail: reason || `Queue changed to ${queue}`,
          claimId,
        });
        return previous;
      },
      saveReview: (claimId, { queue, note }) => {
        const text = note?.trim();
        const claim = get().claims.find((c) => c.id === claimId);
        if (!claim) return;
        const moved = queue !== claim.queue;
        const entry: ClaimNote | null = text
          ? {
              id: uid("NOTE"),
              at: new Date().toISOString(),
              by: get().role,
              text,
              ...(moved ? { queue } : {}),
            }
          : null;
        set({
          claims: get().claims.map((c) =>
            c.id === claimId
              ? {
                  ...c,
                  queue,
                  specialReason:
                    queue === "special"
                      ? (text ?? c.specialReason ?? "Needs supervisor judgement")
                      : c.specialReason,
                  ...(entry
                    ? {
                        notes: entry.text,
                        noteHistory: [entry, ...(c.noteHistory ?? [])],
                        supervisorNote:
                          get().role === "supervisor"
                            ? entry.text
                            : c.supervisorNote,
                      }
                    : {}),
                }
              : c,
          ),
        });
        get().log({
          actor: get().role,
          action: moved ? `Decision saved: ${queue}` : "Note saved",
          detail: text || `Queue changed to ${queue}`,
          claimId,
        });
      },
      reviewFinding: async (
        claimId,
        findingId,
        action,
        notes,
        correctedAmount,
      ) => {
        const target = get().claims.find((claim) => claim.id === claimId);
        const finding = target?.findings.find((item) => item.id === findingId);
        if (!target || !finding)
          throw new Error("Finding is no longer available on this claim.");
        if (
          action === "CORRECT" &&
          (correctedAmount === undefined ||
            !Number.isFinite(correctedAmount) ||
            correctedAmount < 0)
        ) {
          throw new Error("Enter a valid corrected amount (zero or greater).");
        }
        const reviewStatus =
          action === "CONFIRM"
            ? "CONFIRMED"
            : action === "DISMISS"
              ? "DISMISSED"
              : action === "CORRECT"
                ? "CORRECTED"
                : "REQUEST_EVIDENCE";
        if (finding.backendId) {
          await postFindingReview(
            get().agentUrl,
            finding.backendId,
            action,
            get().role,
            notes,
            correctedAmount,
          );
        }
        set({
          claims: get().claims.map((claim) =>
            claim.id === claimId
              ? {
                  ...claim,
                  findings: claim.findings.map((item) =>
                    item.id === findingId
                      ? {
                          ...item,
                          reviewStatus,
                          ...(action === "CORRECT"
                            ? { leakageAmount: correctedAmount }
                            : {}),
                        }
                      : item,
                  ),
                }
              : claim,
          ),
        });
        get().log({
          actor: get().role,
          action: `Finding review: ${action.toLowerCase()}`,
          detail:
            notes ||
            `${finding.title}${action === "CORRECT" ? ` · corrected amount ${correctedAmount}` : ""}`,
          claimId,
        });
        if (finding.backendId && target.analysisId) {
          try {
            const refreshed = await recalculateAnalysis(
              get().agentUrl,
              target.analysisId,
              get().role,
            );
            set({
              claims: get().claims.map((claim) =>
                claim.id === claimId
                  ? {
                      ...claim,
                      expectedSettlement:
                        refreshed.financial_summary?.expected_settlement ??
                        claim.expectedSettlement,
                      confirmedLeakage:
                        refreshed.leakage_summary?.calculated_leakage ??
                        claim.confirmedLeakage,
                      potentialLeakage:
                        refreshed.leakage_summary?.estimated_leakage ??
                        claim.potentialLeakage,
                      riskScore:
                        refreshed.risk_assessment?.risk_score ??
                        claim.riskScore,
                    }
                  : claim,
              ),
            });
          } catch (error) {
            throw new Error(
              `Review saved, but totals could not refresh: ${error instanceof Error ? error.message : "unknown error"}`,
            );
          }
        }
      },
      addNote: (claimId, note) => {
        const claim = get().claims.find((c) => c.id === claimId);
        if (claim) get().saveReview(claimId, { queue: claim.queue, note });
      },
      log: (event) =>
        set({
          audit: [
            { id: uid("AUD"), at: new Date().toISOString(), ...event },
            ...get().audit,
          ].slice(0, 200),
        }),
      clearLocalData: () =>
        set({
          claims: [],
          audit: [],
          jobs: [],
          policyFromDocument: null,
          filters: { domain: "all", queue: "all", search: "" },
        }),
      loadDemoData: () =>
        set({
          claims: [...investigationDemoClaims(allSeedClaims), ...allSeedClaims],
          audit: seedAudit,
          jobs: [],
          policyFromDocument: null,
          filters: { domain: "all", queue: "all", search: "" },
        }),
    }),
    {
      name: "claimsguard-ui-v3",
      version: 5,
      // v5: one-time clean slate. Claims (and the findings stored inside them), the audit trail and ingest
      // jobs saved by an earlier version are dropped. Settings such as the role and agent URL are kept.
      migrate: (persisted, version) => {
        const state = persisted as AppState;
        if (version >= 5) return state;
        return {
          ...state,
          claims: [],
          audit: [],
          jobs: [],
          policyFromDocument: null,
        };
      },
      // The master policy lives in the database; keep only the UI state in the browser.
      partialize: ({
        masterPolicies: _policies,
        masterPoliciesStatus: _status,
        masterPoliciesError: _error,
        ...rest
      }) => rest,
      merge: (persisted, current) => ({
        ...current,
        ...(persisted as Partial<AppState>),
        masterPolicies: current.masterPolicies,
        masterPoliciesStatus: current.masterPoliciesStatus,
        masterPoliciesError: current.masterPoliciesError,
      }),
    },
  ),
);
