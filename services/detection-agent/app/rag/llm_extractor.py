"""Optional Claude- or Gemini-backed extraction over retrieved policy clauses.

This is the generative half of the RAG pipeline and it is strictly optional: when the selected
provider's package or API key is absent the service runs on rule-based extraction alone and says
so. The model only ever sees clauses the retriever selected, must cite the clause id it used for
each fact, and is told to return nothing rather than guess -- so an LLM fact is still traceable.
"""
from __future__ import annotations

import logging
import os
from typing import Any

from pydantic import BaseModel, Field

from app.core.config import Settings, get_settings
from app.rag.extractors import ExtractedFact
from app.rag.retriever import Retrieved

log = logging.getLogger(__name__)

CLAUDE_MODEL = "claude-opus-5-5"
GEMINI_MODEL = "gemini-2.5-flash"

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


class LLMPolicyAnswer(BaseModel):
    answer: str
    clause_ids: list[str]


def configured_provider(settings: Settings | None = None) -> str:
    return (settings or get_settings()).llm_provider.strip().lower()


def configured_model(settings: Settings | None = None) -> str:
    provider = configured_provider(settings)
    if provider == "gemini":
        return GEMINI_MODEL
    if provider == "claude":
        return CLAUDE_MODEL
    return "unknown"


def available(settings: Settings | None = None) -> tuple[bool, str]:
    """Whether the LLM extraction path can run, and why not when it cannot."""
    settings = settings or get_settings()
    provider = configured_provider(settings)
    if provider == "claude":
        try:
            import anthropic  # noqa: F401
        except ImportError:
            return False, "anthropic package not installed (pip install anthropic)"
        if not (settings.anthropic_api_key or settings.anthropic_auth_token
                or os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN")):
            return False, "no ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN in the environment"
        return True, "ready"
    if provider == "gemini":
        try:
            from google import genai  # noqa: F401
        except ImportError:
            return False, "google-genai package not installed (pip install google-genai)"
        if not (settings.gemini_api_key or os.environ.get("GEMINI_API_KEY")):
            return False, "no GEMINI_API_KEY in the environment"
        return True, "ready"
    return False, f"unsupported CG_LLM_PROVIDER {settings.llm_provider!r}; choose 'claude' or 'gemini'"


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
            retrieval_score=hit.score,
            notes=[f"extracted by {configured_provider().title()} {configured_model()} from the retrieved clause"]))

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


def extract_with_llm(hits: list[Retrieved], *, model: str | None = None) -> tuple[list[ExtractedFact], dict[str, Any]]:
    """Extract policy facts from retrieved clauses with the configured provider."""
    settings = get_settings()
    provider = configured_provider(settings)
    model = model or configured_model(settings)
    ok, reason = available(settings)
    if not ok:
        return [], {"status": "UNAVAILABLE", "reason": reason, "provider": provider, "model": model}
    if not hits:
        return [], {"status": "SKIPPED", "reason": "no clauses retrieved",
                    "provider": provider, "model": model}

    by_clause: dict[str, Retrieved] = {}
    for hit in hits:
        by_clause[hit.chunk.clause_id or hit.chunk.chunk_id] = hit
        by_clause[hit.chunk.chunk_id] = hit

    try:
        prompt = "Extract the policy terms stated in these clauses.\n\n" + _clause_block(hits)
        if provider == "claude":
            import anthropic

            client = anthropic.Anthropic(
                api_key=settings.anthropic_api_key or os.environ.get("ANTHROPIC_API_KEY"),
                auth_token=settings.anthropic_auth_token or os.environ.get("ANTHROPIC_AUTH_TOKEN"),
            )
            response = client.messages.parse(
                model=model,
                max_tokens=16000,
                system=SYSTEM,
                messages=[{"role": "user", "content": prompt}],
                output_format=LLMPolicyExtraction,
            )
            extraction = response.parsed_output
            usage = getattr(response, "usage", None)
            input_tokens = getattr(usage, "input_tokens", None)
            output_tokens = getattr(usage, "output_tokens", None)
        else:
            from google import genai
            from google.genai import types

            client = genai.Client(api_key=settings.gemini_api_key or os.environ.get("GEMINI_API_KEY"))
            response = client.models.generate_content(
                model=model,
                contents=prompt,
                config=types.GenerateContentConfig(
                    system_instruction=SYSTEM,
                    response_mime_type="application/json",
                    response_schema=LLMPolicyExtraction,
                    max_output_tokens=16000,
                ),
            )
            extraction = (LLMPolicyExtraction.model_validate_json(response.text)
                          if response.text else None)
            usage = getattr(response, "usage_metadata", None)
            input_tokens = getattr(usage, "prompt_token_count", None)
            output_tokens = getattr(usage, "candidates_token_count", None)
    except Exception as exc:  # never fail policy extraction because the LLM path failed
        log.exception("LLM policy extraction failed")
        return [], {"status": "ERROR", "reason": str(exc), "provider": provider, "model": model}

    if extraction is None:
        return [], {"status": "ERROR", "reason": "model returned no parsable output",
                    "provider": provider, "model": model}
    facts = _as_facts(extraction, by_clause)
    return facts, {
        "status": "AVAILABLE", "provider": provider, "model": model, "facts_extracted": len(facts),
        "clauses_supplied": len(hits), "unclear_clauses": extraction.unclear_clauses,
        "input_tokens": input_tokens,
        "output_tokens": output_tokens,
        "grounding": "facts citing a clause_id outside the retrieved set are dropped",
    }


def answer_with_gemini(question: str, hits: list[Retrieved]) -> dict[str, Any]:
    """Answer from retrieved clauses only, rejecting model citations not supplied in the prompt."""
    settings = get_settings()
    try:
        from google import genai
        from google.genai import types
    except ImportError as exc:
        raise RuntimeError("google-genai package not installed (pip install google-genai)") from exc

    api_key = settings.gemini_api_key or os.environ.get("GEMINI_API_KEY")
    if not api_key:
        raise RuntimeError("no GEMINI_API_KEY in the environment")

    allowed_ids = {hit.chunk.clause_id or hit.chunk.chunk_id for hit in hits}
    prompt = (
        "Answer the user's question using only the supplied policy clauses. If they do not contain "
        "the answer, say that the policy wording does not state it. Do not use outside knowledge or "
        "make assumptions. Cite every factual statement with the clause_id(s) that support it. "
        "Return only clause IDs from the supplied clauses.\n\n"
        f"Question: {question}\n\nSupplied clauses:\n{_clause_block(hits)}"
    )
    client = genai.Client(api_key=api_key)
    response = client.models.generate_content(
        model=GEMINI_MODEL,
        contents=prompt,
        config=types.GenerateContentConfig(
            system_instruction="You are a careful insurance-policy assistant. Ground every answer in the provided text.",
            response_mime_type="application/json",
            response_schema=LLMPolicyAnswer,
            max_output_tokens=2048,
        ),
    )
    if not response.text:
        raise RuntimeError("Gemini returned no answer")
    answer = LLMPolicyAnswer.model_validate_json(response.text)
    cited_ids = list(dict.fromkeys(answer.clause_ids))
    unsupported_ids = [clause_id for clause_id in cited_ids if clause_id not in allowed_ids]
    if unsupported_ids:
        log.warning("Gemini answer cited clauses not supplied in retrieval: %s", unsupported_ids)
        raise RuntimeError("Gemini returned a citation that was not in the retrieved clauses")
    if not cited_ids:
        raise RuntimeError("Gemini answer did not cite any retrieved clauses")
    return {
        "answer": answer.answer,
        "cited_clauses": cited_ids,
        "provider": "gemini",
        "model": GEMINI_MODEL,
    }
