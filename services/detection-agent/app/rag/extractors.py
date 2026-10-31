"""Deterministic extraction of policy facts from retrieved clauses.

Every fact carries the clause it came from, the exact snippet that justifies it and a confidence.
Nothing is inferred from silence: a clause that does not state a number produces no fact, which is
what keeps the engine's "no assumed policy terms" rule intact once extraction feeds it.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from decimal import Decimal, InvalidOperation
from typing import Any

from app.core.taxonomy import CATEGORY_SYNONYMS
from app.rag.retriever import Retrieved

# ---------------------------------------------------------------------------- money / number parsing

_MULTIPLIERS = {"lakh": 100_000, "lac": 100_000, "crore": 10_000_000, "cr": 10_000_000, "k": 1_000}

MONEY_RE = re.compile(
    r"(?:(?P<sym>₹|rs\.?|inr|rupees)\s*)"
    r"(?P<num>\d[\d,]*(?:\.\d{1,2})?)"
    r"(?:\s*(?P<mult>lakhs?|lacs?|crores?|cr|k)\b)?"
    r"|(?P<num2>\d[\d,]*(?:\.\d{1,2})?)\s*(?P<mult2>lakhs?|lacs?|crores?)\b"
    r"|(?P<num3>\d[\d,]*(?:\.\d{1,2})?)\s*/-",
    re.IGNORECASE)

PERCENT_RE = re.compile(r"(?P<num>\d{1,3}(?:\.\d{1,2})?)\s*(?:%|per\s*cent|percent)", re.IGNORECASE)
DAYS_RE = re.compile(r"(?P<num>\d{1,4})\s*(?P<unit>days?|months?|years?)\b", re.IGNORECASE)

PER_DAY_RE = re.compile(r"per\s+day|per\s+night|daily|a\s+day|/\s*day", re.IGNORECASE)
PER_YEAR_RE = re.compile(r"per\s+(?:policy\s+)?year|per\s+annum|annually|policy\s+year", re.IGNORECASE)

# A clause only states a limit if it uses limiting language; "the premium is Rs. 12,000" must not
# become a benefit cap just because it contains a number.
LIMIT_CUES = re.compile(
    r"\b(?:up\s*to|upto|maximum|max\.?|not\s+exceed(?:ing)?|subject\s+to\s+a?\s*(?:limit|cap|sub-?limit)"
    r"|limited\s+to|capped\s+at|restricted\s+to|payable\s+up\s*to|ceiling|sub-?limit\s+of"
    r"|shall\s+not\s+exceed)\b", re.IGNORECASE)
EXCLUSION_CUES = re.compile(
    r"\b(?:excluded|not\s+payable|not\s+covered|non-?payable|not\s+admissible"
    r"|shall\s+not\s+(?:cover|be\s+(?:payable|covered|admissible))"
    r"|no\s+claim\s+shall\s+be\s+admissible|outside\s+the\s+scope|we\s+will\s+not\s+pay)\b", re.IGNORECASE)
DEDUCTIBLE_CUES = re.compile(
    r"\b(?:deductible|excess|self[-\s]retention|borne\s+by\s+the\s+insured)\b", re.IGNORECASE)
COPAY_CUES = re.compile(
    r"\b(?:co-?payment|co-?pay|insured\s+shall\s+bear|share\s+of\s+(?:the|each)\s+claim)\b", re.IGNORECASE)
SUM_INSURED_CUES = re.compile(
    r"\b(?:sum\s+insured|annual\s+(?:aggregate\s+)?limit|overall\s+limit|maximum\s+liability"
    r"|total\s+liability)\b", re.IGNORECASE)
WAITING_CUES = re.compile(
    r"\b(?:waiting\s+period|months?\s+of\s+continuous\s+coverage|during\s+the\s+first)\b", re.IGNORECASE)
COVERED_CUES = re.compile(r"\b(?:is|are|shall\s+be)\s+(?:covered|payable|admissible|reimbursed)\b", re.IGNORECASE)

# A waiting period that applies to a named class of conditions rather than to the whole policy. The
# engine applies a category-less waiting period to EVERY item, so mistaking "36 months for
# pre-existing diseases" for a blanket rule would void every claim on the policy. When one of these
# qualifiers is present and no taxonomy category matches, the fact is held back for review instead.
CONDITION_SCOPED_RE = re.compile(
    r"\b(?:pre-?existing|specified\s+(?:disease|ailment|illness)|named\s+ailment|maternity|childbirth"
    r"|hernia|cataract|joint\s+replacement|bariatric|infertility|organ\s+donor"
    r"|specific\s+(?:disease|ailment|illness)s?)\b", re.IGNORECASE)
# Wording that marks a genuinely policy-wide initial waiting period.
BLANKET_WAITING_RE = re.compile(
    r"\b(?:no\s+claim\s+shall\s+be\s+admissible|initial\s+waiting\s+period|first\s+\d+\s+days\s+of\s+the\s+policy"
    r"|from\s+the\s+(?:date\s+of\s+)?(?:inception|commencement))\b", re.IGNORECASE)

# Negations that flip an apparent statement: "Room rent is covered" vs "Room rent is not covered".
NEGATION_RE = re.compile(r"\b(?:not|no|never|except|excluding|other\s+than)\b", re.IGNORECASE)


def parse_money(match: re.Match) -> Decimal | None:
    raw = match.group("num") or match.group("num2") or match.group("num3")
    if not raw:
        return None
    try:
        value = Decimal(raw.replace(",", ""))
    except InvalidOperation:
        return None
    mult = (match.groupdict().get("mult") or match.groupdict().get("mult2") or "").lower()
    if mult:
        key = mult.rstrip("s")
        value *= Decimal(_MULTIPLIERS.get(key, 1))
    return value


def find_money(text: str) -> list[tuple[Decimal, str]]:
    """Every monetary amount in the text, with the snippet that contains it."""
    out: list[tuple[Decimal, str]] = []
    for m in MONEY_RE.finditer(text):
        value = parse_money(m)
        if value is not None and value > 0:
            out.append((value, text[max(0, m.start() - 60):m.end() + 60].strip()))
    return out


def detect_category(text: str) -> tuple[str | None, float]:
    """Map clause wording to the engine's service taxonomy. Priority order matters: ICU before ROOM."""
    low = text.lower()
    for category, synonyms in CATEGORY_SYNONYMS.items():
        for syn in synonyms:
            if syn in low:
                # A longer, more specific synonym is stronger evidence than a one-word match.
                return category, 0.9 if len(syn) > 6 else 0.75
    return None, 0.0


# ---------------------------------------------------------------------------- fact model


@dataclass
class ExtractedFact:
    """One policy fact with the evidence that supports it."""
    field: str                   # deductible | copayment_percentage | sum_insured | sublimit.* | exclusion | ...
    value: Any
    category: str | None
    confidence: float
    method: str                  # rule_based | llm_grounded
    clause_id: str | None
    citation: str
    snippet: str
    chunk_id: str
    retrieval_score: float
    notes: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {"field": self.field, "value": self.value, "category": self.category,
                "confidence": round(self.confidence, 3), "method": self.method,
                "clause_id": self.clause_id, "citation": self.citation, "snippet": self.snippet,
                "chunk_id": self.chunk_id, "retrieval_score": round(self.retrieval_score, 4),
                "notes": self.notes}


def _fact(hit: Retrieved, field_name: str, value: Any, confidence: float, snippet: str,
          category: str | None = None, notes: list[str] | None = None) -> ExtractedFact:
    return ExtractedFact(
        field=field_name, value=value, category=category,
        # Retrieval quality caps the confidence of anything extracted from the clause.
        confidence=round(min(confidence, 0.55 + 0.45 * min(hit.score / 0.6, 1.0)), 3),
        method="rule_based", clause_id=hit.chunk.clause_id, citation=hit.chunk.citation,
        snippet=snippet.strip()[:400], chunk_id=hit.chunk.chunk_id, retrieval_score=hit.score,
        notes=notes or [])


# ---------------------------------------------------------------------------- field extractors


def extract_deductible(hits: list[Retrieved]) -> list[ExtractedFact]:
    out = []
    for hit in hits:
        text = hit.chunk.text
        if not DEDUCTIBLE_CUES.search(text):
            continue
        for value, snippet in find_money(text):
            if DEDUCTIBLE_CUES.search(snippet) or DEDUCTIBLE_CUES.search(text[:120]):
                out.append(_fact(hit, "deductible", value, 0.85, snippet))
                break
    return out


def extract_copayment(hits: list[Retrieved]) -> list[ExtractedFact]:
    out = []
    for hit in hits:
        text = hit.chunk.text
        if not COPAY_CUES.search(text):
            continue
        for m in PERCENT_RE.finditer(text):
            snippet = text[max(0, m.start() - 70):m.end() + 70].strip()
            if COPAY_CUES.search(snippet) or COPAY_CUES.search(text[:120]):
                out.append(_fact(hit, "copayment_percentage", Decimal(m.group("num")), 0.85, snippet))
                break
    return out


def extract_sum_insured(hits: list[Retrieved]) -> list[ExtractedFact]:
    out = []
    for hit in hits:
        text = hit.chunk.text
        if not SUM_INSURED_CUES.search(text):
            continue
        for value, snippet in find_money(text):
            if SUM_INSURED_CUES.search(snippet) or SUM_INSURED_CUES.search(text[:150]):
                out.append(_fact(hit, "sum_insured", value, 0.85, snippet))
                break
    return out


def extract_sublimits(hits: list[Retrieved]) -> list[ExtractedFact]:
    """Category caps, split into daily_limit vs limit by the clause's own qualifier."""
    out = []
    for hit in hits:
        text = hit.chunk.text
        if not LIMIT_CUES.search(text) or EXCLUSION_CUES.search(text):
            continue
        # Co-payment, deductible and sum-insured clauses also contain limiting language; they have
        # their own extractors and must not be re-read as a category sub-limit.
        if DEDUCTIBLE_CUES.search(text) or COPAY_CUES.search(text) or SUM_INSURED_CUES.search(text):
            continue
        category, cat_conf = detect_category(text)
        if category is None:
            continue
        monies = find_money(text)
        if not monies:
            continue
        value, snippet = monies[0]
        per_day = bool(PER_DAY_RE.search(snippet) or PER_DAY_RE.search(text))
        notes = []
        if per_day:
            notes.append("clause states a per-day qualifier")
        elif PER_YEAR_RE.search(text):
            notes.append("clause states a per-policy-year qualifier")
        out.append(_fact(hit, "sublimit.daily_limit" if per_day else "sublimit.limit", value,
                         0.80 * cat_conf + 0.15, snippet, category=category, notes=notes))
    return out


def extract_exclusions(hits: list[Retrieved]) -> list[ExtractedFact]:
    out = []
    for hit in hits:
        text = hit.chunk.text
        if not EXCLUSION_CUES.search(text):
            continue
        # A waiting-period clause reads like an exclusion ("no claim shall be admissible during the
        # first 30 days") but is time-bound, not a permanent carve-out. extract_waiting_periods owns it.
        if WAITING_CUES.search(text) and not LIMIT_CUES.search(text):
            continue
        # Exclusion clauses are usually lists; take each sentence carrying the exclusion cue so a
        # five-item exclusion list becomes five citable facts rather than one blob.
        for sentence in re.split(r"(?<=[.;])\s+|\n", text):
            s = sentence.strip()
            if len(s) < 12 or not EXCLUSION_CUES.search(s):
                continue
            category, cat_conf = detect_category(s)
            out.append(_fact(hit, "exclusion", s[:220], 0.75 * max(cat_conf, 0.6) + 0.2, s,
                             category=category,
                             notes=[] if category else ["no taxonomy category matched; review wording"]))
    return out


def extract_coverage(hits: list[Retrieved]) -> list[ExtractedFact]:
    """Explicitly covered / not-covered statements for a category."""
    out = []
    for hit in hits:
        text = hit.chunk.text
        for sentence in re.split(r"(?<=[.;])\s+|\n", text):
            s = sentence.strip()
            if len(s) < 12:
                continue
            category, cat_conf = detect_category(s)
            if category is None:
                continue
            if EXCLUSION_CUES.search(s):
                out.append(_fact(hit, "coverage.covered", False, 0.75 * cat_conf + 0.2, s, category=category))
            elif COVERED_CUES.search(s):
                head = s[:COVERED_CUES.search(s).start()]
                if not NEGATION_RE.search(head):
                    out.append(_fact(hit, "coverage.covered", True, 0.70 * cat_conf + 0.15, s, category=category))
    return out


def extract_waiting_periods(hits: list[Retrieved]) -> list[ExtractedFact]:
    out = []
    for hit in hits:
        text = hit.chunk.text
        if not WAITING_CUES.search(text):
            continue
        for m in DAYS_RE.finditer(text):
            snippet = text[max(0, m.start() - 80):m.end() + 80].strip()
            if not WAITING_CUES.search(snippet) and not WAITING_CUES.search(text[:150]):
                continue
            n, unit = int(m.group("num")), m.group("unit").lower()
            days = n * (30 if unit.startswith("month") else 365 if unit.startswith("year") else 1)
            category, _ = detect_category(text)
            notes = [f"stated as {n} {unit}"]
            if not unit.startswith("day"):
                notes.append("converted to days (30/month, 365/year)")

            scoped = CONDITION_SCOPED_RE.search(text)
            if category is None and scoped:
                # Scope is a condition class the item taxonomy cannot express. Emitting this with no
                # category would make the engine apply it to every line of every claim.
                notes.append(f"applies only to '{scoped.group(0)}' claims, which this engine cannot "
                             f"identify from invoice lines; held back from the enforced policy")
                out.append(_fact(hit, "waiting_period.needs_review", days, 0.80, snippet,
                                 category=None, notes=notes))
                break
            if category is None and not BLANKET_WAITING_RE.search(text):
                notes.append("clause does not state what the waiting period applies to; "
                             "held back from the enforced policy")
                out.append(_fact(hit, "waiting_period.needs_review", days, 0.75, snippet,
                                 category=None, notes=notes))
                break
            if category is None:
                notes.append("policy-wide initial waiting period")
            out.append(_fact(hit, "waiting_period", days, 0.80, snippet, category=category, notes=notes))
            break
    return out


EXTRACTORS = {
    "deductible": extract_deductible,
    "copayment_percentage": extract_copayment,
    "sum_insured": extract_sum_insured,
    "sublimits": extract_sublimits,
    "exclusions": extract_exclusions,
    "coverage": extract_coverage,
    "waiting_periods": extract_waiting_periods,
}
