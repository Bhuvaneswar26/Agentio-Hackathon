"""Optional Claude-, Gemini- or Sarvam-backed extraction over retrieved policy clauses.

Gemini and Sarvam are called through LangChain (`langchain-google-genai`, and `langchain-openai`
pointed at Sarvam's OpenAI-compatible API): a prompt | structured-output chain, so the model's reply is
validated against a pydantic schema before anything downstream sees it.

This is the generative half of the RAG pipeline and it is strictly optional: when the selected
provider's package or API key is absent the service runs on rule-based extraction alone and says
so. The model only ever sees clauses the retriever selected, must cite the clause id it used for
each fact, and is told to return nothing rather than guess -- so an LLM fact is still traceable.
"""
from __future__ import annotations

import json
import logging
import os
import re
from typing import Any

from pydantic import BaseModel, Field, field_validator

from app.core.config import Settings, get_settings
from app.rag.extractors import ExtractedFact
from app.rag.guardrails import GUARDRAIL_CONTEXT, OutOfScopeError
from app.rag.retriever import Retrieved

log = logging.getLogger(__name__)

CLAUDE_MODEL = "claude-opus-5-5"
GEMINI_MODEL = "gemini-3.6-flash"
SARVAM_MODEL = "sarvam-105b"

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
    """What the model may return for a question. `in_scope` is the model-side half of the guardrails."""
    in_scope: bool = Field(description="False when the question is not about the supplied policy wording")
    refusal_reason: str = Field(default="", description="One sentence, only when in_scope is false")
    stated_in_policy: bool = Field(default=True, description="False when the clauses do not state the answer")
    answer: str = ""
    clause_ids: list[str] = Field(default_factory=list)

    @field_validator("refusal_reason", "answer", mode="before")
    @classmethod
    def _null_text_is_empty(cls, value):
        # Some models return null for an empty string.
        return "" if value is None else value

    @field_validator("clause_ids", mode="before")
    @classmethod
    def _null_ids_is_empty(cls, value):
        return [] if value is None else value


def configured_provider(settings: Settings | None = None) -> str:
    return (settings or get_settings()).llm_provider.strip().lower()


def configured_model(settings: Settings | None = None) -> str:
    provider = configured_provider(settings)
    if provider == "gemini":
        return getattr(settings or get_settings(), "gemini_model", "") or GEMINI_MODEL
    if provider == "sarvam":
        return getattr(settings or get_settings(), "sarvam_model", "") or SARVAM_MODEL
    if provider == "claude":
        return CLAUDE_MODEL
    return "unknown"


_LABELS = {"gemini": "Gemini", "sarvam": "Sarvam", "claude": "Claude"}


def provider_label(settings: Settings | None = None) -> str:
    """The provider's display name, for messages a person reads."""
    provider = configured_provider(settings)
    return _LABELS.get(provider, provider or "The language model")


# Providers that go through LangChain and can answer questions under the guardrail context.
LANGCHAIN_PROVIDERS = ("gemini", "sarvam")


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
            from langchain_google_genai import ChatGoogleGenerativeAI  # noqa: F401
        except ImportError:
            return False, "langchain-google-genai package not installed (pip install langchain-google-genai)"
        if not (settings.gemini_api_key or os.environ.get("GEMINI_API_KEY")):
            return False, "no GEMINI_API_KEY in the environment"
        return True, "ready"
    if provider == "sarvam":
        try:
            from langchain_openai import ChatOpenAI  # noqa: F401
        except ImportError:
            return False, "langchain-openai package not installed (pip install langchain-openai)"
        if not (settings.sarvam_api_key or os.environ.get("SARVAM_API_KEY")):
            return False, "no SARVAM_API_KEY in the environment"
        return True, "ready"
    return False, f"unsupported CG_LLM_PROVIDER {settings.llm_provider!r}; choose 'claude', 'gemini' or 'sarvam'"


def _gemini_chat_model(settings: Settings, *, max_output_tokens: int):
    """The LangChain chat model for Gemini. Temperature 0: these are look-ups, not creative writing."""
    from langchain_google_genai import ChatGoogleGenerativeAI

    return ChatGoogleGenerativeAI(
        model=configured_model(settings),
        api_key=settings.gemini_api_key or os.environ.get("GEMINI_API_KEY"),
        temperature=0.0,
        max_tokens=max_output_tokens,
        retries=1,  # a daily-quota 429 will not clear on retry, and each attempt can count against it
        request_timeout=60,
    )


# Sarvam's 105B model reasons before it answers, and the reasoning counts against the output limit. With a
# small limit the reasoning uses it all and the reply comes back empty, so never ask for less than this.
SARVAM_MIN_OUTPUT_TOKENS = 6000


def _sarvam_chat_model(settings: Settings, *, max_output_tokens: int):
    """LangChain chat model for Sarvam, through its OpenAI-compatible endpoint."""
    from langchain_openai import ChatOpenAI

    key = settings.sarvam_api_key or os.environ.get("SARVAM_API_KEY") or ""
    return ChatOpenAI(
        model=configured_model(settings),
        base_url=settings.sarvam_base_url,
        api_key=key,
        # Sarvam's own header; the Authorization: Bearer header LangChain adds is accepted as well.
        default_headers={"api-subscription-key": key},
        temperature=0.0,
        max_tokens=max(max_output_tokens, SARVAM_MIN_OUTPUT_TOKENS),
        max_retries=1,
        timeout=120,
    )


def _chat_model(settings: Settings, *, max_output_tokens: int):
    """The LangChain chat model for the configured provider."""
    if configured_provider(settings) == "sarvam":
        return _sarvam_chat_model(settings, max_output_tokens=max_output_tokens)
    return _gemini_chat_model(settings, max_output_tokens=max_output_tokens)


def _structured(model, schema: type[BaseModel], settings: Settings, *, include_raw: bool = False):
    """Wrap a chat model so it returns `schema`.

    Gemini enforces the schema natively. For Sarvam, strict `json_schema` mode was measured to be slow and, on
    a larger schema, to return empty fields, so Sarvam is asked for a JSON object (the schema is described in
    the system prompt, see `_system_for`) and the reply is validated with pydantic.
    """
    if configured_provider(settings) == "sarvam":
        return model.with_structured_output(schema, method="json_mode", include_raw=include_raw)
    return model.with_structured_output(schema, include_raw=include_raw)


def _system_for(settings: Settings, text: str, schema: type[BaseModel]) -> str:
    """The system prompt, with the output schema spelled out for providers that run in JSON-object mode."""
    if configured_provider(settings) != "sarvam":
        return text
    return (
        f"{text}\n\nOUTPUT FORMAT\nReply with one JSON object and nothing else (no prose, no code fences). "
        f"It must match this JSON schema; use null only where the schema allows it:\n"
        f"{json.dumps(schema.model_json_schema(), separators=(',', ':'))}"
    )


_CLAUSE_TAG = re.compile(r"\s*\[\s*clause[_ ]?ids?\s*:[^\]]*\]", re.IGNORECASE)


def _clean_answer(text: str) -> str:
    """Remove inline `[clause_id: 1.3]` tags the model sometimes pastes into prose; citations live in clause_ids."""
    return _CLAUSE_TAG.sub("", text).strip()


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
            from langchain_core.messages import SystemMessage
            from langchain_core.prompts import ChatPromptTemplate

            chain = (
                ChatPromptTemplate.from_messages(
                    [SystemMessage(content=_system_for(settings, SYSTEM, LLMPolicyExtraction)), ("human", "{task}")])
                | _structured(_chat_model(settings, max_output_tokens=16000), LLMPolicyExtraction, settings,
                              include_raw=True)
            )
            result = chain.invoke({"task": prompt})
            extraction = result.get("parsed")
            if extraction is None and result.get("parsing_error"):
                raise ValueError(f"{provider_label(settings)} output did not match the schema: {result['parsing_error']}")
            usage = getattr(result.get("raw"), "usage_metadata", None) or {}
            input_tokens = usage.get("input_tokens")
            output_tokens = usage.get("output_tokens")
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


def answer_with_llm(question: str, hits: list[Retrieved]) -> dict[str, Any]:
    """Answer from retrieved clauses only, through LangChain, under the scope guardrails.

    Raises OutOfScopeError when the model judges the question not to be about the policy, and
    RuntimeError for anything else that makes the answer unusable (no key, bad citation, no reply).
    """
    settings = get_settings()
    ok, reason = available(settings)
    if not ok or configured_provider(settings) not in LANGCHAIN_PROVIDERS:
        raise RuntimeError(reason if not ok else f"CG_LLM_PROVIDER {settings.llm_provider!r} cannot answer questions")
    label = provider_label(settings)

    from langchain_core.messages import SystemMessage
    from langchain_core.prompts import ChatPromptTemplate

    allowed_ids = {hit.chunk.clause_id or hit.chunk.chunk_id for hit in hits}
    chain = (
        ChatPromptTemplate.from_messages([
            SystemMessage(content=_system_for(settings, GUARDRAIL_CONTEXT, LLMPolicyAnswer)),
            ("human", "Question: {question}\n\n<policy_clauses>\n{clauses}\n</policy_clauses>"),
        ])
        | _structured(_chat_model(settings, max_output_tokens=2048), LLMPolicyAnswer, settings)
    )
    answer = chain.invoke({"question": question, "clauses": _clause_block(hits)})
    if answer is None:
        raise RuntimeError(f"{label} returned no answer")

    if not answer.in_scope:
        raise OutOfScopeError(answer.refusal_reason or "The question is not about the policy document.")

    cited_ids = list(dict.fromkeys(answer.clause_ids))
    unsupported_ids = [clause_id for clause_id in cited_ids if clause_id not in allowed_ids]
    if unsupported_ids:
        log.warning("%s answer cited clauses not supplied in retrieval: %s", label, unsupported_ids)
        raise RuntimeError(f"{label} returned a citation that was not in the retrieved clauses")
    answer_text = _clean_answer(answer.answer)
    if not answer_text:
        raise RuntimeError(f"{label} returned an empty answer")
    if answer.stated_in_policy and not cited_ids:
        raise RuntimeError(f"{label} answer did not cite any retrieved clauses")
    return {
        "answer": answer_text,
        "cited_clauses": cited_ids,
        "stated_in_policy": answer.stated_in_policy,
        "provider": configured_provider(settings),
        "model": configured_model(settings),
        "framework": "langchain",
    }


def describe_llm_error(exc: BaseException) -> tuple[str, str]:
    """Turn a provider exception into (kind, message a claims handler can act on)."""
    text = f"{type(exc).__name__}: {exc}"
    lowered = text.lower()
    label = provider_label()
    provider = configured_provider()
    key_name = {"gemini": "GEMINI_API_KEY", "sarvam": "SARVAM_API_KEY", "claude": "ANTHROPIC_API_KEY"}.get(provider, "the API key")
    model_var = {"gemini": "CG_GEMINI_MODEL", "sarvam": "CG_SARVAM_MODEL"}.get(provider)
    if "resource_exhausted" in lowered or "429" in lowered or "ratelimit" in lowered or "rate limit" in lowered or "quota" in lowered:
        wait = re.search(r"retry in ([0-9hms.]+)", text)
        return "rate_limit", (
            f"{label}'s usage quota for this API key is used up"
            + (f"; the provider says to retry in {_human_wait(wait.group(1))}" if wait else "")
            + ". Try again later, "
            + (f"set {model_var} to another model, " if model_var else "")
            + "switch CG_LLM_PROVIDER to another provider, or use a key with more quota.")
    if "api_key_invalid" in lowered or "api key not valid" in lowered or "permission_denied" in lowered \
            or "unauthenticated" in lowered or "invalid_api_key" in lowered or "401" in lowered or "403" in lowered:
        return "auth", f"{label} rejected the API key. Check {key_name} in services/detection-agent/.env and restart the backend."
    if "unavailable" in lowered or "503" in lowered or "timeout" in lowered or "timed out" in lowered \
            or "deadline" in lowered:
        return "unavailable", f"{label} is temporarily unavailable or timed out. Please try again in a moment."
    if "not_found" in lowered or "404" in lowered or "model_not_found" in lowered:
        return "model", f"{label} does not recognise the model {configured_model()!r}." + (f" Set {model_var} to a model your key can use." if model_var else "")
    return "other", f"{label} could not complete this request."


def _human_wait(raw: str) -> str:
    """'18h52m34.98s' -> '18h 52m'. Seconds are noise on a wait this long."""
    parts = re.findall(r"(\d+)(h|m)", raw)
    if parts:
        return " ".join(f"{n}{u}" for n, u in parts)
    return raw.split(".")[0] + "s" if raw.endswith("s") else raw
