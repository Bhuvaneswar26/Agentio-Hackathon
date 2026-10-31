import { backendOrigin } from "./api";
import type { PolicyExtraction } from "./policyRag";

/** A policy document in the master library. `text` is only present when fetched individually. */
export type MasterPolicy = {
  id: string;
  /** Display name, defaults to the policy number. */
  name: string;
  sourceName: string;
  policyNumber: string;
  extraction: PolicyExtraction;
  addedAt: string;
  /** Full policy wording, kept so the document can be re-read and questioned later. */
  text?: string;
};

type Wire = {
  id: string;
  name: string;
  source_name: string;
  policy_number: string;
  extraction: PolicyExtraction;
  updated_at: string;
  document_text?: string;
};

function fromWire(w: Wire): MasterPolicy {
  return {
    id: w.id,
    name: w.name,
    sourceName: w.source_name,
    policyNumber: w.policy_number,
    extraction: w.extraction,
    addedAt: w.updated_at,
    text: w.document_text,
  };
}

async function request<T>(
  agentUrl: string,
  path: string,
  init?: RequestInit,
): Promise<T> {
  const origin = backendOrigin(agentUrl);
  if (!origin)
    throw new Error(
      "No detection-engine URL is configured. Set it under Agent connection.",
    );
  let res: Response;
  try {
    res = await fetch(`${origin}/api/v1/master-policies${path}`, {
      ...init,
      headers: { "Content-Type": "application/json" },
    });
  } catch {
    throw new Error(
      "Could not reach the detection engine, so the master policy is unavailable.",
    );
  }
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

export async function listMasterPolicies(
  agentUrl: string,
): Promise<MasterPolicy[]> {
  const res = await request<{ policies: Wire[] }>(agentUrl, "");
  return res.policies.map(fromWire);
}

export async function getMasterPolicy(
  agentUrl: string,
  id: string,
): Promise<MasterPolicy> {
  const res = await request<{ policy: Wire }>(
    agentUrl,
    `/${encodeURIComponent(id)}`,
  );
  return fromWire(res.policy);
}

export async function saveMasterPolicy(
  agentUrl: string,
  entry: {
    sourceName: string;
    text: string;
    extraction: PolicyExtraction;
    name?: string;
  },
): Promise<MasterPolicy> {
  const res = await request<{ policy: Wire }>(agentUrl, "", {
    method: "PUT",
    body: JSON.stringify({
      source_name: entry.sourceName,
      name: entry.name,
      document_text: entry.text,
      extraction: entry.extraction,
    }),
  });
  return fromWire(res.policy);
}

export async function deleteMasterPolicy(
  agentUrl: string,
  id: string,
): Promise<void> {
  await request(agentUrl, `/${encodeURIComponent(id)}`, { method: "DELETE" });
}
