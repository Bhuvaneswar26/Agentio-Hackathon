export type Domain = "Health" | "Motor" | "General";
export type Severity = "low" | "medium" | "high" | "critical";
export type SourceFormat =
  | "json"
  | "csv"
  | "xlsx"
  | "pdf"
  | "image"
  | "url"
  | "text";
export type Role = "handler" | "supervisor" | "executive";

export type ClaimQueue =
  | "intake"
  | "good"
  | "flagged"
  | "unassessed"
  | "special"
  | "confirmed"
  | "dismissed";

export type FindingKind =
  | "exact_duplicate"
  | "near_duplicate"
  | "duplicate_line"
  | "limit_breach"
  | "exclusion"
  | "settlement_error"
  | "provider_anomaly"
  | "related_party"
  | "insufficient_evidence"
  | "legitimate_repeat"
  | "fraud_signal";

export type Certainty = "confirmed" | "potential" | "unassessed";

export type InvoiceLine = {
  id: string;
  description: string;
  code: string;
  quantity: number;
  unitPrice: number;
  amount: number;
  provider: string;
  invoiceRef: string;
  date: string;
};

export type PolicyRule = {
  id: string;
  name: string;
  clause: string;
  type:
    | "limit"
    | "exclusion"
    | "deductible"
    | "copay"
    | "sublimit"
    | "coverage";
  value?: number;
  unit?: string;
};

export type Finding = {
  id: string;
  kind: FindingKind;
  title: string;
  explanation: string;
  evidence: string[];
  policyClause?: string;
  invoiceLineIds: string[];
  certainty: Certainty;
  severity: Severity;
  leakageAmount: number;
  engine: "rules" | "duplicate" | "ml" | "ocr" | "graph";
  /** Set when the finding came from the ClaimsGuard engine (used for reviewer sync). */
  backendId?: string;
  ruleId?: string;
  amountType?: "CALCULATED" | "ESTIMATED" | "UNQUANTIFIED";
  reviewStatus?:
    | "PENDING"
    | "CONFIRMED"
    | "DISMISSED"
    | "REQUEST_EVIDENCE"
    | "CORRECTED";
};

export type AuditEvent = {
  id: string;
  at: string;
  actor: string;
  action: string;
  detail: string;
  claimId?: string;
};

export type ClaimNote = {
  id: string;
  at: string;
  by: string;
  text: string;
  /** Queue the claim was moved to when this note was saved, if it changed. */
  queue?: ClaimQueue;
};

export type Claim = {
  id: string;
  policyNumber: string;
  claimant: string;
  incidentDate: string;
  filedDate: string;
  domain: Domain;
  claimType: string;
  requestedAmount: number;
  proposedSettlement: number;
  expectedSettlement: number;
  confirmedLeakage: number;
  potentialLeakage: number;
  provider: string;
  city: string;
  queue: ClaimQueue;
  riskScore: number;
  findings: Finding[];
  lines: InvoiceLine[];
  policyRules: PolicyRule[];
  missingFields: string[];
  relatedClaimIds: string[];
  sourceFormat: SourceFormat;
  extractionConfidence: number;
  notes: string;
  /** Saved reviewer notes, newest first. `notes` mirrors the latest one. */
  noteHistory?: ClaimNote[];
  supervisorNote?: string;
  specialReason?: string;
  /** ClaimsGuard engine analysis id, when scored by the backend. */
  analysisId?: string;
  /** Supporting documents attached in the investigation workspace. */
  documents?: DocumentEvidence[];
  /** The investigation record, created the first time an analyst opens the workspace. */
  investigation?: Investigation;
};

// ------------------------------------------------------------------ investigation workspace

/** Where an extracted value came from, so an analyst can open the document at that exact line. */
export type SourceRef = {
  documentId: string;
  documentName: string;
  /** 1-based line number in the document text. */
  line: number;
  snippet: string;
};

export type ExtractedValue<T = string> = { value: T; raw: string; source: SourceRef };

export type DocumentKind =
  | "invoice"
  | "discharge_summary"
  | "repair_estimate"
  | "other";

export type ExtractedLineItem = {
  description: string;
  quantity?: number;
  amount: number;
  source: SourceRef;
};

export type DocumentFields = {
  invoiceNumber?: ExtractedValue;
  policyNumber?: ExtractedValue;
  claimId?: ExtractedValue;
  /** Patient on a hospital document, owner / insured on a repair estimate. */
  person?: ExtractedValue;
  /** Hospital on a medical document, garage on a repair estimate. */
  provider?: ExtractedValue;
  documentDate?: ExtractedValue;
  admissionDate?: ExtractedValue;
  dischargeDate?: ExtractedValue;
  totalAmount?: ExtractedValue<number>;
  diagnosis?: ExtractedValue;
  procedure?: ExtractedValue;
  vehicle?: ExtractedValue;
};

/** A supporting document attached to a claim, with everything read from it and where it was read. */
export type DocumentEvidence = {
  id: string;
  name: string;
  kind: DocumentKind;
  addedAt: string;
  addedBy: string;
  /** Full text, kept so the analyst can inspect any extracted value in context. */
  text: string;
  fields: DocumentFields;
  lineItems: ExtractedLineItem[];
};

export type DiscrepancyKind =
  | "amount_mismatch"
  | "line_amount_mismatch"
  | "date_mismatch"
  | "invoice_number_mismatch"
  | "name_mismatch"
  | "provider_mismatch"
  | "policy_mismatch"
  | "service_not_in_document"
  | "service_not_in_claim"
  | "stay_length_mismatch";

/** A difference between a supporting document and the claim record. */
export type Discrepancy = {
  id: string;
  kind: DiscrepancyKind;
  severity: Severity;
  title: string;
  /** Human label of the compared attribute, e.g. "Total amount". */
  field: string;
  claimValue: string;
  documentValue: string;
  /** Where on the claim record the claim-side value lives. */
  claimRef: string;
  /** The claim line the difference is about, when it is about one. */
  claimLineId?: string;
  /** Where in the document the document-side value was read. Absent when the document lacks the item. */
  source?: SourceRef;
  documentId: string;
  /** Document minus claim, for amount differences. */
  difference?: number;
  /** Amount at risk if the claim record is wrong; 0 when the difference is informational. */
  amountAtRisk: number;
  explanation: string;
};

export type CorrelationAttribute = {
  /** What matched, e.g. "Invoice number". */
  attribute: string;
  thisClaim: string;
  otherClaim: string;
  weight: number;
};

/** A claim related to the one under investigation, and exactly why. */
export type Correlation = {
  claimId: string;
  claimant: string;
  policyNumber: string;
  provider: string;
  requestedAmount: number;
  filedDate: string;
  queue: ClaimQueue;
  strength: "strong" | "moderate" | "weak";
  score: number;
  /** One sentence naming the link, e.g. the same invoice under two policies. */
  headline: string;
  attributes: CorrelationAttribute[];
  /** True when two policies reference the same invoice from the same provider. */
  crossPolicyInvoice: boolean;
};

export type RecommendationKind =
  | "remove_duplicate_line"
  | "remove_unsupported_line"
  | "remove_excluded_item"
  | "cap_at_sublimit"
  | "correct_line_amount"
  | "apply_deductible"
  | "apply_copay"
  | "correct_settlement"
  | "hold_duplicate_claim";

/** A specific settlement adjustment. Nothing here is a generic warning: every one has a number. */
export type Recommendation = {
  /** Deterministic from claim, kind and target, so it stays stable when the analysis is re-run. */
  id: string;
  kind: RecommendationKind;
  title: string;
  originalAmount: number;
  correctedAmount: number;
  /** correctedAmount - originalAmount; negative means the payout goes down. */
  adjustment: number;
  /** The arithmetic, written out. */
  calculation: string;
  policyRule: {
    id?: string;
    name: string;
    clause: string;
    /** False when the supplied policy has no clause for this; the correction rests on evidence only. */
    supplied: boolean;
  };
  basis: "policy_terms" | "document_evidence" | "cross_claim";
  /** Line ids the recommendation touches. */
  invoiceLineIds: string[];
  /** Whether this step is part of the corrected-settlement waterfall. */
  inWaterfall: boolean;
  generatedBy: string;
};

export type WaterfallStep = {
  key: string;
  label: string;
  before: number;
  after: number;
  calculation: string;
};

export type SettlementCalculation = {
  gross: number;
  steps: WaterfallStep[];
  /** Corrected settlement after every waterfall step. */
  expected: number;
  proposed: number;
  /** proposed - expected, never negative. */
  leakage: number;
};

export type DecisionType =
  | "CONFIRM_DISCREPANCY"
  | "FALSE_POSITIVE"
  | "REQUEST_EVIDENCE"
  | "ESCALATE"
  | "ACCEPT_CORRECTION";

export type EscalationTarget = "SENIOR_REVIEWER" | "SIU";

export type Actor = { name: string; role: Role };

/** What an analyst decided about one issue. Overrides keep the recommendation as it was offered. */
export type Decision = {
  id: string;
  issueId: string;
  type: DecisionType;
  at: string;
  by: Actor;
  /** Required for FALSE_POSITIVE, ESCALATE and any override. */
  reason?: string;
  escalateTo?: EscalationTarget;
  recommendationId?: string;
  /** The recommendation exactly as it stood when the decision was made. */
  recommendationSnapshot?: Recommendation;
  /** Set when the analyst accepted a different amount from the one recommended. */
  override?: { originalAmount: number; overriddenAmount: number; reason: string };
};

export type InvestigationEventType =
  | "investigation_opened"
  | "calculation_recorded"
  | "issue_detected"
  | "recommendation_generated"
  | "correlation_found"
  | "document_added"
  | "discrepancy_detected"
  | "decision"
  | "override"
  | "escalation"
  | "note"
  | "queue_changed";

/** One immutable entry in the evidence history. Events are only ever appended. */
export type InvestigationEvent = {
  id: string;
  at: string;
  by: Actor;
  type: InvestigationEventType;
  summary: string;
  /** The structured payload: the calculation, issue, recommendation or decision as recorded. */
  data?: unknown;
};

export type InvestigationNote = {
  id: string;
  at: string;
  by: Actor;
  text: string;
  /** Issue the note is about, when it is about one. */
  issueId?: string;
};

export type Investigation = {
  openedAt: string;
  openedBy: Actor;
  decisions: Decision[];
  notes: InvestigationNote[];
  events: InvestigationEvent[];
};

export type ProviderStat = {
  name: string;
  domain: Domain;
  claims: number;
  billed: number;
  avgVsPeer: number;
  risk: number;
  flaggedShare: number;
};

export type DetectionPayload = {
  schemaVersion: "1.0";
  ingestedAt: string;
  source: {
    format: SourceFormat;
    filename?: string;
    url?: string;
    engine: string;
    ocrUsed: boolean;
    confidence: number;
    warnings: string[];
  };
  claim: {
    claimId?: string;
    policyNumber?: string;
    claimant?: string;
    incidentDate?: string;
    filedDate?: string;
    domain?: Domain | string;
    claimType?: string;
    requestedAmount?: number;
    proposedSettlement?: number;
    provider?: string;
    city?: string;
  };
  invoiceLines: InvoiceLine[];
  policy: {
    policyNumber?: string;
    coverage?: string;
    deductible?: number;
    copayPercent?: number;
    validFrom?: string;
    validUntil?: string;
    sumInsured?: number;
    rules: PolicyRule[];
  };
  history: Array<{
    claimId: string;
    incidentDate: string;
    amount: number;
    status: string;
    claimant?: string;
    provider?: string;
    invoiceLines?: InvoiceLine[];
  }>;
  documents: Array<{
    name: string;
    type: string;
    excerpt: string;
  }>;
  extraction: {
    rawText?: string;
    missingFields: string[];
    valid: boolean;
  };
};

export type IngestJob = {
  id: string;
  name: string;
  format: SourceFormat;
  status: "extracting" | "ready" | "sent" | "failed";
  payload: DetectionPayload | null;
  error?: string;
  sentAt?: string;
  agentResponse?: string;
};
