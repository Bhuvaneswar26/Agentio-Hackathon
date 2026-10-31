import type { PolicyRule } from "../types";
import { backendOrigin } from "./api";

/** A policy term the engine extracted from a document, with the clause that justifies it. */
export type Citation = {
  citation: string;
  clause_id: string | null;
  confidence: number;
  snippet: string;
  method: string;
};

export type ExtractedSublimit = {
  category: string;
  limit?: number;
  daily_limit?: number;
  clause_reference?: string;
};

export type ExtractedExclusion = {
  category: string;
  description: string;
  clause_reference?: string;
};

export type ExtractedPolicy = {
  policy_number: string;
  policy_type?: string;
  deductible?: number;
  copayment_percentage?: number;
  sum_insured?: number;
  sublimits?: ExtractedSublimit[];
  exclusions?: ExtractedExclusion[];
  coverage?: Array<{
    category: string;
    covered: boolean;
    clause_reference?: string;
  }>;
  waiting_periods?: Array<{
    days: number;
    category?: string;
    clause_reference?: string;
  }>;
  waiting_periods_requiring_review?: Array<{
    days: number;
    citation: string;
    reason: string;
    engine_behaviour: string;
  }>;
  extraction_citations?: Record<string, unknown>;
  extraction_method?: string;
};

export type PolicyExtraction = {
  success: boolean;
  policy: ExtractedPolicy;
  facts: Array<{
    field: string;
    value: unknown;
    category: string | null;
    confidence: number;
    method: string;
    citation: string;
    snippet: string;
  }>;
  conflicts: Array<{
    field: string;
    category: string | null;
    reason: string;
    chosen: { value: unknown; citation: string; confidence: number };
    candidates: Array<{
      value: unknown;
      citation: string;
      confidence: number;
      snippet: string;
    }>;
    action_required: string;
  }>;
  unresolved: Array<{
    field: string;
    reason: string;
    engine_behaviour: string;
  }>;
  low_confidence: Array<{
    field: string;
    citation: string;
    confidence: number;
  }>;
  document: { chunks: number; clauses_detected: number; characters: number };
  llm_extraction: { status: string; reason?: string; model?: string };
};

export type PolicyAnswer = {
  answered: boolean;
  reason?: string;
  answer?: string;
  provider?: string;
  model?: string;
  cited_clauses?: string[];
  answer_source?: "gemini_grounded" | "retrieval_fallback" | "retrieval";
  llm_notice?: string;
  best_citation?: string;
  confidence?: number;
  clauses: Array<{
    citation: string;
    text: string;
    score: number;
    clause_id: string | null;
  }>;
};

export type RagStatus = {
  llm_extraction?: {
    status: "AVAILABLE" | "UNAVAILABLE";
    reason?: string;
    provider?: string;
    model?: string;
  };
};

async function post<T>(
  agentUrl: string,
  path: string,
  body: unknown,
): Promise<T> {
  const origin = backendOrigin(agentUrl);
  if (!origin)
    throw new Error(
      "No detection-engine URL is configured. Set it under Agent connection.",
    );
  const res = await fetch(`${origin}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const parsed = JSON.parse(text) as {
        detail?: { message?: string; error?: string };
      };
      detail = parsed.detail?.message ?? parsed.detail?.error ?? detail;
    } catch {
      // keep the status line
    }
    throw new Error(detail);
  }
  return JSON.parse(text) as T;
}

export function extractPolicyFromDocument(
  agentUrl: string,
  documentText: string,
  opts: { policyNumber?: string; policyType?: string; useLlm?: boolean } = {},
) {
  return post<PolicyExtraction>(agentUrl, "/api/v1/policy/extract", {
    document_text: documentText,
    policy_number: opts.policyNumber || undefined,
    policy_type: opts.policyType || undefined,
    use_llm: Boolean(opts.useLlm),
  });
}

export function askPolicyQuestion(
  agentUrl: string,
  documentText: string,
  question: string,
) {
  return post<PolicyAnswer>(agentUrl, "/api/v1/policy/ask", {
    document_text: documentText,
    question,
    use_llm: true,
  });
}

export async function fetchRagStatus(agentUrl: string): Promise<RagStatus> {
  const origin = backendOrigin(agentUrl);
  if (!origin) throw new Error("No detection-engine URL is configured.");
  const response = await fetch(`${origin}/api/v1/policy/rag/status`);
  if (!response.ok)
    throw new Error(`RAG status unavailable (HTTP ${response.status}).`);
  return response.json() as Promise<RagStatus>;
}

/**
 * Render the extracted policy as the dashboard's own rule list, so a document-derived policy shows
 * up on the claim exactly like a hand-entered one. Each rule keeps its clause citation.
 */
export function toPolicyRules(policy: ExtractedPolicy): PolicyRule[] {
  const rules: PolicyRule[] = [];
  let n = 0;
  const next = () => `PR-DOC-${(n += 1)}`;

  if (policy.deductible != null) {
    rules.push({
      id: next(),
      name: "Deductible",
      clause:
        `Deductible of ${policy.deductible} per claim (${policy.extraction_citations ? "from policy document" : ""})`.trim(),
      type: "deductible",
      value: policy.deductible,
      unit: "INR",
    });
  }
  if (policy.copayment_percentage != null) {
    rules.push({
      id: next(),
      name: "Co-payment",
      clause: `Insured bears ${policy.copayment_percentage}% of each admissible claim`,
      type: "copay",
      value: policy.copayment_percentage,
      unit: "%",
    });
  }
  if (policy.sum_insured != null) {
    rules.push({
      id: next(),
      name: "Sum insured",
      clause: `Maximum liability ${policy.sum_insured} per policy year`,
      type: "limit",
      value: policy.sum_insured,
      unit: "INR",
    });
  }
  for (const sub of policy.sublimits ?? []) {
    const perDay = sub.daily_limit != null;
    rules.push({
      id: next(),
      name: `${sub.category} ${perDay ? "daily limit" : "limit"}`,
      clause: sub.clause_reference ?? "",
      type: "sublimit",
      value: perDay ? sub.daily_limit : sub.limit,
      unit: perDay ? "INR/day" : "INR",
    });
  }
  for (const exc of policy.exclusions ?? []) {
    rules.push({
      id: next(),
      name: `Excluded: ${exc.category}`,
      clause: exc.clause_reference ?? exc.description,
      type: "exclusion",
    });
  }
  return rules;
}
