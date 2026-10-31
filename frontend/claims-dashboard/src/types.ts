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
