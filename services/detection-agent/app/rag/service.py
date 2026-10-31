"""Policy-document RAG service: document in, citable structured policy out.

Pipeline: chunk -> index -> retrieve per policy field -> extract (rule-based, plus Claude when it is
configured) -> reconcile -> emit a `Policy`-shaped dict with a citation for every value.

Two rules shape the output and both exist to protect the claims decision downstream:
  * Nothing is invented. A field the document does not state is reported under `unresolved`, never
    defaulted, so the rule engine keeps treating it as INSUFFICIENT_EVIDENCE.
  * Disagreement is surfaced, not resolved silently. Two clauses stating different room-rent caps
    produce a `conflicts` entry with both citations for a human to settle.
"""
from __future__ import annotations

import hashlib
import logging
from dataclasses import dataclass, field
from datetime import date
from decimal import Decimal
from typing import Any

from app.core.config import Settings, get_settings
from app.rag.chunker import Chunk, chunk_policy_document
from app.rag.extractors import EXTRACTORS, ExtractedFact
from app.rag.llm_extractor import available as llm_available
from app.rag.llm_extractor import extract_with_llm
from app.rag.retriever import ChunkRetriever, Retrieved

log = logging.getLogger(__name__)

# What to retrieve for, and with which synonym expansion. One retrieval per field keeps each
# extractor focused on the clauses that can actually answer it.
FIELD_QUERIES: dict[str, tuple[str, list[str]]] = {
    "deductible": ("deductible amount payable by the insured before the claim", ["deductible"]),
    "copayment_percentage": ("co-payment percentage borne by the insured", ["copayment"]),
    "sum_insured": ("sum insured and overall annual limit of liability", ["sum_insured"]),
    "sublimits": ("sub-limits and daily caps for room rent, ICU, diagnostics and consumables",
                  ["sublimit", "room_rent", "icu"]),
    "exclusions": ("services and items excluded from cover and not payable", ["exclusion"]),
    "coverage": ("what the policy covers and which charges are payable", ["room_rent", "icu"]),
    "waiting_periods": ("waiting period before benefits become payable", ["waiting_period"]),
}

# Facts below this confidence are reported but not promoted into the policy the engine evaluates.
DEFAULT_MIN_CONFIDENCE = 0.55


@dataclass
class PolicyExtraction:
    """Result of reading one policy document."""
    policy: dict[str, Any]
    facts: list[ExtractedFact]
    conflicts: list[dict[str, Any]] = field(default_factory=list)
    unresolved: list[dict[str, Any]] = field(default_factory=list)
    low_confidence: list[dict[str, Any]] = field(default_factory=list)
    retrieval: dict[str, Any] = field(default_factory=dict)
    document: dict[str, Any] = field(default_factory=dict)
    llm: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "policy": self.policy,
            "facts": [f.to_dict() for f in self.facts],
            "conflicts": self.conflicts,
            "unresolved": self.unresolved,
            "low_confidence": self.low_confidence,
            "retrieval": self.retrieval,
            "document": self.document,
            "llm_extraction": self.llm,
            "contract": ("`policy` can be posted as the policy block of /api/v1/analyze. Fields the "
                         "document does not state are absent, not defaulted: the rule engine reports "
                         "them as INSUFFICIENT_EVIDENCE rather than assuming a market-standard term."),
        }


class PolicyDocumentIndex:
    """A chunked, retrievable policy document."""

    def __init__(self, text: str, *, source: str | None = None, policy_number: str | None = None):
        self.text = text
        self.source = source or "policy-document"
        self.policy_number = policy_number
        self.chunks: list[Chunk] = chunk_policy_document(text, source=self.source)
        self.retriever = ChunkRetriever(self.chunks)
        self.doc_hash = hashlib.sha256(text.encode("utf-8")).hexdigest()[:16]

    def search(self, query: str, *, top_k: int = 6, topics: list[str] | None = None) -> list[Retrieved]:
        return self.retriever.search(query, top_k=top_k, topics=topics or [])

    def stats(self) -> dict[str, Any]:
        return {"source": self.source, "doc_hash": self.doc_hash, "characters": len(self.text),
                "chunks": len(self.chunks), "vocabulary_size": self.retriever.vocabulary_size,
                "clauses_detected": sum(1 for c in self.chunks if c.clause_id),
                "pages_detected": len({c.page for c in self.chunks if c.page is not None}) or None}


def _best(facts: list[ExtractedFact]) -> ExtractedFact:
    """Prefer the better-evidenced fact; retrieval score breaks a confidence tie."""
    return max(facts, key=lambda f: (f.confidence, f.retrieval_score))


def _conflict(field_name: str, facts: list[ExtractedFact], chosen: ExtractedFact,
              category: str | None = None) -> dict[str, Any]:
    return {
        "field": field_name, "category": category,
        "reason": "two or more clauses state different values for this field",
        "chosen": {"value": _json_value(chosen.value), "citation": chosen.citation,
                   "confidence": round(chosen.confidence, 3)},
        "candidates": [{"value": _json_value(f.value), "citation": f.citation, "clause_id": f.clause_id,
                        "confidence": round(f.confidence, 3), "snippet": f.snippet} for f in facts],
        "action_required": "A reviewer must confirm which clause governs before this value is relied on.",
    }


def _json_value(value: Any) -> Any:
    return float(value) if isinstance(value, Decimal) else value


def _decimal(value: Any) -> Decimal:
    return value if isinstance(value, Decimal) else Decimal(str(value))


def extract_policy(
    index: PolicyDocumentIndex,
    *,
    policy_number: str | None = None,
    policy_type: str | None = None,
    valid_from: date | None = None,
    valid_until: date | None = None,
    use_llm: bool = False,
    min_confidence: float = DEFAULT_MIN_CONFIDENCE,
    top_k: int = 6,
    settings: Settings | None = None,
) -> PolicyExtraction:
    """Read a policy document into a structured, cited policy."""
    settings = settings or get_settings()
    retrieval_log: dict[str, Any] = {}
    all_facts: list[ExtractedFact] = []

    # --- retrieve + extract per field
    retrieved_union: dict[str, Retrieved] = {}
    for field_name, (query, topics) in FIELD_QUERIES.items():
        hits = index.search(query, top_k=top_k, topics=topics)
        retrieval_log[field_name] = {
            "query": query, "expansion_topics": topics, "hits": len(hits),
            "top_citations": [{"citation": h.chunk.citation, "score": round(h.score, 4)} for h in hits[:3]],
        }
        for hit in hits:
            retrieved_union.setdefault(hit.chunk.chunk_id, hit)
        extractor = EXTRACTORS.get(field_name)
        if extractor is not None:
            all_facts.extend(extractor(hits))

    # --- optional LLM pass over the union of retrieved clauses
    llm_info: dict[str, Any]
    if use_llm:
        llm_facts, llm_info = extract_with_llm(sorted(retrieved_union.values(),
                                                      key=lambda h: h.score, reverse=True)[:24])
        all_facts.extend(llm_facts)
    else:
        ok, reason = llm_available()
        llm_info = {"status": "NOT_REQUESTED",
                    "reason": "use_llm=false; rule-based extraction only",
                    "would_be_available": ok, "availability_detail": reason}

    # --- reconcile into a Policy-shaped dict
    usable = [f for f in all_facts if f.confidence >= min_confidence]
    low_conf = [f.to_dict() for f in all_facts if f.confidence < min_confidence]
    by_field: dict[str, list[ExtractedFact]] = {}
    for f in usable:
        by_field.setdefault(f.field, []).append(f)

    policy: dict[str, Any] = {"policy_number": policy_number or index.policy_number or "UNKNOWN"}
    if policy_type:
        policy["policy_type"] = policy_type
    if valid_from:
        policy["valid_from"] = valid_from.isoformat()
    if valid_until:
        policy["valid_until"] = valid_until.isoformat()

    conflicts: list[dict[str, Any]] = []
    unresolved: list[dict[str, Any]] = []
    citations: dict[str, Any] = {}

    # scalars
    for field_name in ("deductible", "copayment_percentage", "sum_insured"):
        facts = by_field.get(field_name, [])
        if not facts:
            unresolved.append({
                "field": field_name, "reason": "no clause in the document states this value",
                "clauses_searched": retrieval_log[field_name]["hits"],
                "engine_behaviour": "treated as not supplied; no leakage is computed from an assumed value"})
            continue
        chosen = _best(facts)
        distinct = {str(_json_value(f.value)) for f in facts}
        if len(distinct) > 1:
            conflicts.append(_conflict(field_name, facts, chosen))
        policy[field_name] = _json_value(chosen.value)
        citations[field_name] = {"citation": chosen.citation, "clause_id": chosen.clause_id,
                                 "confidence": round(chosen.confidence, 3), "snippet": chosen.snippet,
                                 "method": chosen.method}

    # sublimits: one entry per category, daily_limit and limit merged
    sublimits: dict[str, dict[str, Any]] = {}
    for field_name in ("sublimit.daily_limit", "sublimit.limit"):
        key = field_name.split(".", 1)[1]
        per_category: dict[str, list[ExtractedFact]] = {}
        for f in by_field.get(field_name, []):
            if f.category:
                per_category.setdefault(f.category, []).append(f)
        for category, facts in per_category.items():
            chosen = _best(facts)
            if len({str(_json_value(f.value)) for f in facts}) > 1:
                conflicts.append(_conflict(field_name, facts, chosen, category=category))
            entry = sublimits.setdefault(category, {"category": category})
            entry[key] = _json_value(chosen.value)
            entry["clause_reference"] = chosen.citation
            entry.setdefault("_citations", {})[key] = {
                "citation": chosen.citation, "clause_id": chosen.clause_id,
                "confidence": round(chosen.confidence, 3), "snippet": chosen.snippet, "method": chosen.method}
    if sublimits:
        policy["sublimits"] = [{k: v for k, v in e.items() if k != "_citations"} for e in sublimits.values()]
        citations["sublimits"] = {c: e["_citations"] for c, e in sublimits.items() if "_citations" in e}

    # exclusions: de-duplicated on normalised description
    seen_exclusions: set[str] = set()
    exclusions: list[dict[str, Any]] = []
    exclusion_citations: list[dict[str, Any]] = []
    for f in sorted(by_field.get("exclusion", []), key=lambda x: x.confidence, reverse=True):
        norm = " ".join(str(f.value).lower().split())[:120]
        if norm in seen_exclusions:
            continue
        seen_exclusions.add(norm)
        exclusions.append({"category": f.category or "UNCATEGORISED", "description": str(f.value),
                           "clause_reference": f.citation})
        exclusion_citations.append({"category": f.category, "citation": f.citation, "clause_id": f.clause_id,
                                    "confidence": round(f.confidence, 3), "snippet": f.snippet,
                                    "method": f.method})
    if exclusions:
        policy["exclusions"] = exclusions
        citations["exclusions"] = exclusion_citations

    # coverage: explicit covered / not-covered statements
    coverage: dict[str, dict[str, Any]] = {}
    for f in sorted(by_field.get("coverage.covered", []), key=lambda x: x.confidence, reverse=True):
        if f.category and f.category not in coverage:
            coverage[f.category] = {"category": f.category, "covered": bool(f.value),
                                    "clause_reference": f.citation}
    # A category named only in an exclusion is not covered, whatever a generic coverage line says.
    for f in by_field.get("exclusion", []):
        if f.category:
            coverage[f.category] = {"category": f.category, "covered": False, "clause_reference": f.citation}
    if coverage:
        policy["coverage"] = list(coverage.values())

    # waiting periods
    waiting: list[dict[str, Any]] = []
    for f in sorted(by_field.get("waiting_period", []), key=lambda x: x.confidence, reverse=True):
        entry = {"days": int(f.value), "clause_reference": f.citation}
        if f.category:
            entry["category"] = f.category
        if entry not in waiting:
            waiting.append(entry)
    if waiting:
        policy["waiting_periods"] = waiting

    # Waiting periods whose scope the extractor could not pin to an item category are reported for a
    # human to apply, never enforced: the engine would otherwise apply them to every line.
    needs_review = [{
        "field": "waiting_period", "days": int(f.value), "citation": f.citation, "clause_id": f.clause_id,
        "snippet": f.snippet, "confidence": round(f.confidence, 3), "notes": f.notes,
        "reason": "the clause limits this waiting period to a class of conditions that cannot be "
                  "determined from invoice lines",
        "engine_behaviour": "not applied; a reviewer must decide whether it governs this claim",
    } for f in by_field.get("waiting_period.needs_review", [])]
    if needs_review:
        policy["waiting_periods_requiring_review"] = needs_review

    for field_name in ("sublimits", "exclusions", "waiting_periods"):
        if field_name not in policy:
            unresolved.append({
                "field": field_name, "reason": "no clause in the document states this",
                "clauses_searched": retrieval_log.get(field_name, {}).get("hits", 0),
                "engine_behaviour": "nothing assumed; items in these categories stay UNKNOWN_COVERAGE"})

    policy["extraction_citations"] = citations
    policy["extraction_method"] = ("RAG: TF-IDF clause retrieval + rule-based extraction"
                                   + (f" + {llm_info.get('provider', 'LLM').title()} grounded extraction"
                                      if llm_info.get("status") == "AVAILABLE"
                                      else ""))

    return PolicyExtraction(
        policy=policy, facts=all_facts, conflicts=conflicts, unresolved=unresolved,
        low_confidence=low_conf,
        retrieval={**retrieval_log, "min_confidence": min_confidence, "top_k": top_k,
                   "method": "TF-IDF (word 1-2 grams, sublinear tf) cosine + RapidFuzz lexical blend"},
        document=index.stats(), llm=llm_info)


def answer_question(index: PolicyDocumentIndex, question: str, *, top_k: int = 4) -> dict[str, Any]:
    """Grounded lookup over the policy document: the clauses that answer a question, with citations.

    This is retrieval only -- it returns the governing clauses rather than prose, because a claims
    handler needs the clause they can quote in a rejection letter, not a paraphrase of it.
    """
    hits = index.search(question, top_k=top_k)
    if not hits:
        return {"question": question, "answered": False,
                "reason": "nothing in the document matched the question",
                "clauses": [], "document": index.stats()}
    return {
        "question": question,
        "answered": True,
        "clauses": [h.to_dict() for h in hits],
        "best_citation": hits[0].chunk.citation,
        "confidence": round(hits[0].score, 4),
        "basis": "clause retrieval over the uploaded document; text is quoted verbatim, not generated",
        "document": index.stats(),
    }
