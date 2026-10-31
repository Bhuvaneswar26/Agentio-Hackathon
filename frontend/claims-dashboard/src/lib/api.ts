import type { Role } from "../types";

/** Backend origin derived from the configured detect URL, e.g. http://localhost:8000 */
export function backendOrigin(agentUrl: string): string {
  try {
    return new URL(agentUrl).origin;
  } catch {
    return "";
  }
}

export const DEFAULT_AGENT_URL =
  import.meta.env.VITE_AGENT_URL ?? "http://localhost:8000/v1/detect";

export type FindingReviewAction =
  | "CONFIRM"
  | "DISMISS"
  | "REQUEST_EVIDENCE"
  | "CORRECT";

export async function reviewFinding(
  agentUrl: string,
  findingId: string,
  action: FindingReviewAction,
  reviewer: Role,
  notes?: string,
  correctedAmount?: number,
) {
  const origin = backendOrigin(agentUrl);
  if (!origin) throw new Error("Backend URL is invalid.");
  const response = await fetch(
    `${origin}/api/v1/findings/${encodeURIComponent(findingId)}/review`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action,
        reviewer,
        notes,
        corrected_amount: correctedAmount,
      }),
    },
  );
  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Review was not saved (HTTP ${response.status})${body ? `: ${body.slice(0, 240)}` : ""}`,
    );
  }
  return response.json() as Promise<{
    success: boolean;
    finding: { review_status?: string };
  }>;
}

export async function recalculateAnalysis(
  agentUrl: string,
  analysisId: string,
  reviewer: Role,
) {
  const origin = backendOrigin(agentUrl);
  if (!origin) throw new Error("Backend URL is invalid.");
  const response = await fetch(
    `${origin}/api/v1/analyze/${encodeURIComponent(analysisId)}/recalculate`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apply_review_decisions: true, reviewer }),
    },
  );
  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Totals could not be recalculated (HTTP ${response.status})${body ? `: ${body.slice(0, 240)}` : ""}`,
    );
  }
  return response.json() as Promise<{
    financial_summary?: { expected_settlement?: number };
    leakage_summary?: {
      calculated_leakage?: number;
      estimated_leakage?: number;
    };
    risk_assessment?: { risk_score?: number };
  }>;
}
