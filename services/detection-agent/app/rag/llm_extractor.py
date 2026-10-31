"""Optional Claude-backed extraction over retrieved policy clauses.

This is the generative half of the RAG pipeline and it is strictly optional: when the `anthropic`
package or an API key is absent the service runs on rule-based extraction alone and says so. The
model only ever sees clauses the retriever selected, must cite the clause id it used for each fact,
and is told to return nothing rather than guess -- so an LLM fact is still traceable to a clause.
"""
from __future__ import annotations

import logging
from typing import Any

from pydantic import BaseModel, Field

from app.rag.extractors import ExtractedFact
from app.rag.retriever import Retrieved

log = logging.getLogger(__name__)

MODEL = "claude-opus-5-5"

SYSTEM = """You extract insurance policy terms from policy wording, for a claims-leakage engine.

Rules you must follow:
- Use ONLY the numbered clauses given to you. Never use outside knowledge of typical policies.
- Every fact must carry the clause_id of the clause it came from, and a verbatim snippet from it.
- If the clauses do not state a value, omit it. Returning nothing is correct and expected; a
  guessed deductible or room-rent cap causes an insurer to mis-pay a real claim.
- Amounts are numbers without currency symbols or separators. Percentages are numbers (10, not 0.1).
- A per-day cap goes in daily_limit; a per-policy-year or per-claim cap goes in limit.
- Categories must be one of: ROOM_RENT, ICU, DIAGNOSTICS, PHARMACY, CONSUMABLES, SURGERY,
  DOCTOR_FEES, NURSING, AMBULANCE. Omit the category if none fits.
- Set confidence to how clearly the clause states the fact, from 0.0 to 1.0."""


class LLMSublimit(BaseModel):
    category: str
    limit: float | None = None
    daily_limit: float | None = None
    clause_id: str
    snippet: str
    confidence: float = Field(ge=0.0, le=1.0)


class LLMExclusion(BaseModel):
    category: str | None = None
    description: str
    clause_id: str
    snippet: str
    confidence: float = Field(ge=0.0, le=1.0)


class LLMWaitingPeriod(BaseModel):
    category: str | None = None
    days: int
    clause_id: str
    snippet: str
    confidence: float = Field(ge=0.0, le=1.0)


class LLMScalar(BaseModel):
    value: float
    clause_id: str
    snippet: str
    confidence: float = Field(ge=0.0, le=1.0)


class LLMPolicyExtraction(BaseModel):
    """What the model is allowed to return. Every field is optional by design."""
    deductible: LLMScalar | None = None
    copayment_percentage: LLMScalar | None = None
    sum_insured: LLMScalar | None = None
    sublimits: list[LLMSublimit] = Field(default_factory=list)
    exclusions: list[LLMExclusion] = Field(default_factory=list)
    waiting_periods: list[LLMWaitingPeriod] = Field(default_factory=list)
    unclear_clauses: list[str] = Field(default_factory=list)


def available() -> tuple[bool, str]:
    """Whether the LLM extraction path can run, and why not when it cannot."""
    try:
        import anthropic  # noqa: F401
    except ImportError:
        return False, "anthropic package not installed (pip install anthropic)"
    import os

    if not (os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN")):
        return False, "no ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN in the environment"
    return True, "ready"


def _clause_block(hits: list[Retrieved]) -> str:
    """Render retrieved clauses with stable ids the model must cite back."""
    lines = []
    for hit in hits:
        ref = hit.chunk.clause_id or hit.chunk.chunk_id
        lines.append(f"[clause_id: {ref}] ({hit.chunk.citation})\n{hit.chunk.text}")
    return "\n\n".join(lines)


def _as_facts(extraction: LLMPolicyExtraction, by_clause: dict[str, Retrieved]) -> list[ExtractedFact]:
    """Convert the model's output into the same fact type the rule-based path produces.

    A fact whose clause_id is not one we supplied is dropped: that is the grounding check, and it is
    what stops a hallucinated citation from reaching the policy the engine evaluates.
    """
    facts: list[ExtractedFact] = []

    def push(field: str, value: Any, clause_id: str, snippet: str, confidence: float,
             category: str | None = None) -> None:
        hit = by_clause.get(clause_id)
        if hit is None:
            log.warning("dropping LLM fact %s: clause_id %r was not in the retrieved set", field, clause_id)
            return
        facts.append(ExtractedFact(
            field=field, value=value, category=category, confidence=min(float(confidence), 0.95),
            method="llm_grounded", clause_id=hit.chunk.clause_id, citation=hit.chunk.citation,
            snippet=(snippet or hit.chunk.text)[:400], chunk_id=hit.chunk.chunk_id,
            retrieval_score=hit.score, notes=[f"extracted by {MODEL} from the retrieved clause"]))

    for name, scalar in (("deductible", extraction.deductible),
                         ("copayment_percentage", extraction.copayment_percentage),
                         ("sum_insured", extraction.sum_insured)):
        if scalar is not None:
            push(name, scalar.value, scalar.clause_id, scalar.snippet, scalar.confidence)
    for sub in extraction.sublimits:
        if sub.daily_limit is not None:
            push("sublimit.daily_limit", sub.daily_limit, sub.clause_id, sub.snippet, sub.confidence, sub.category)
        if sub.limit is not None:
            push("sublimit.limit", sub.limit, sub.clause_id, sub.snippet, sub.confidence, sub.category)
    for exc in extraction.exclusions:
        push("exclusion", exc.description, exc.clause_id, exc.snippet, exc.confidence, exc.category)
    for wp in extraction.waiting_periods:
        push("waiting_period", wp.days, wp.clause_id, wp.snippet, wp.confidence, wp.category)
    return facts


def extract_with_llm(hits: list[Retrieved], *, model: str = MODEL) -> tuple[list[ExtractedFact], dict[str, Any]]:
    """Extract policy facts from retrieved clauses with Claude. Returns (facts, diagnostics)."""
    ok, reason = available()
    if not ok:
        return [], {"status": "UNAVAILABLE", "reason": reason}
    if not hits:
        return [], {"status": "SKIPPED", "reason": "no clauses retrieved"}

    import anthropic

    by_clause: dict[str, Retrieved] = {}
    for hit in hits:
        by_clause[hit.chunk.clause_id or hit.chunk.chunk_id] = hit
        by_clause[hit.chunk.chunk_id] = hit

    try:
        client = anthropic.Anthropic()
        response = client.messages.parse(
            model=model,
            max_tokens=16000,
            system=SYSTEM,
            messages=[{"role": "user", "content":
                       "Extract the policy terms stated in these clauses.\n\n" + _clause_block(hits)}],
            output_format=LLMPolicyExtraction,
        )
    except Exception as exc:  # never fail policy extraction because the LLM path failed
        log.exception("LLM policy extraction failed")
        return [], {"status": "ERROR", "reason": str(exc), "model": model}

    extraction = response.parsed_output
    if extraction is None:
        return [], {"status": "ERROR", "reason": "model returned no parsable output", "model": model}
    facts = _as_facts(extraction, by_clause)
    usage = getattr(response, "usage", None)
    return facts, {
        "status": "AVAILABLE", "model": model, "facts_extracted": len(facts),
        "clauses_supplied": len(hits), "unclear_clauses": extraction.unclear_clauses,
        "input_tokens": getattr(usage, "input_tokens", None),
        "output_tokens": getattr(usage, "output_tokens", None),
        "grounding": "facts citing a clause_id outside the retrieved set are dropped",
    }
