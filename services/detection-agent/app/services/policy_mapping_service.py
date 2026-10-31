"""Maps each invoice line to a policy category/coverage with an explanation of *why*."""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Protocol

from rapidfuzz import fuzz, process

from app.core.config import Settings
from app.core.taxonomy import CATEGORY_SYNONYMS, SERVICE_CODE_TOKENS, normalize_category
from app.schemas.policy_schema import CoverageRule, ExclusionRule, Policy, Sublimit
from app.services.normalization_service import NormItem

FUZZY_CUTOFF = 85


class LLMClassifier(Protocol):  # optional last-resort hook; not wired by default
    def classify(self, description: str, candidates: list[str]) -> tuple[str, float] | None: ...


@dataclass
class ItemMapping:
    item_id: str
    original_description: str
    category: str | None
    method: str            # EXACT_CODE | CODE_TOKEN | SYNONYM | SEMANTIC_FUZZY | LLM | UNMAPPED
    confidence: float
    rationale: str
    status: str            # COVERED | EXCLUDED | NOT_COVERED | UNKNOWN
    coverage: CoverageRule | None = None
    exclusion: ExclusionRule | None = None
    sublimits: list[Sublimit] = field(default_factory=list)
    status_reason: str = ""


class PolicyMapper:
    def __init__(self, policy: Policy, settings: Settings, llm: LLMClassifier | None = None):
        self.policy, self.settings, self.llm = policy, settings, llm
        self.coverage = {normalize_category(c.category): c for c in policy.coverage}
        self.exclusions = [(normalize_category(e.category), e) for e in policy.exclusions]
        self.sublimits: dict[str | None, list[Sublimit]] = {}
        for s in policy.sublimits:
            self.sublimits.setdefault(normalize_category(s.category), []).append(s)
        self.policy_categories = set(self.coverage) | {c for c, _ in self.exclusions} | set(self.sublimits)
        self._fuzzy_choices: dict[str, str] = {}
        for cat, phrases in CATEGORY_SYNONYMS.items():
            for p in phrases:
                self._fuzzy_choices[p] = cat
        for cat in self.policy_categories:
            if cat:
                self._fuzzy_choices[cat.lower().replace("_", " ")] = cat

    def _classify(self, item: NormItem) -> tuple[str | None, str, float, str]:
        code = item.service_code
        ncode = normalize_category(code)
        if ncode and ncode in self.policy_categories:
            return ncode, "EXACT_CODE", 1.0, f"service_code '{code}' equals policy category '{ncode}'"
        if code:
            token = re.split(r"[^A-Z0-9]+", code.upper())[0]
            if token in SERVICE_CODE_TOKENS:
                cat = SERVICE_CODE_TOKENS[token]
                return cat, "CODE_TOKEN", 0.95, f"service_code token '{token}' maps to '{cat}'"
        for cat, phrases in CATEGORY_SYNONYMS.items():
            for p in phrases:
                if re.search(rf"\b{re.escape(p)}\b", item.desc_norm):
                    return cat, "SYNONYM", 0.9, f"description contains synonym '{p}' for '{cat}'"
        if item.desc_norm:
            hit = process.extractOne(item.desc_norm, list(self._fuzzy_choices), scorer=fuzz.WRatio,
                                     score_cutoff=FUZZY_CUTOFF)
            if hit:
                phrase, score, _ = hit
                return (self._fuzzy_choices[phrase], "SEMANTIC_FUZZY", round(score / 100, 2),
                        f"description fuzzily matches '{phrase}' (score {score:.0f})")
        if self.llm:
            res = self.llm.classify(item.description, sorted(self.policy_categories))
            if res:
                return res[0], "LLM", res[1], "LLM fallback classification"
        return None, "UNMAPPED", 0.0, "No code, synonym or fuzzy match; INSUFFICIENT_EVIDENCE"

    def _find_exclusion(self, category: str | None, desc_norm: str) -> ExclusionRule | None:
        for ex_cat, ex in self.exclusions:
            if category and ex_cat == category:
                return ex
            phrase = (ex_cat or "").lower().replace("_", " ")
            if phrase and re.search(rf"\b{re.escape(phrase)}\b", desc_norm):
                return ex
        return None

    def map_item(self, item: NormItem) -> ItemMapping:
        cat, method, conf, why = self._classify(item)
        m = ItemMapping(item.item_id, item.description, cat, method, conf, why, "UNKNOWN")
        ex = self._find_exclusion(cat, item.desc_norm)
        cov = self.coverage.get(cat) if cat else None
        m.sublimits = list(self.sublimits.get(cat, [])) if cat else []
        if ex:
            m.status, m.exclusion = "EXCLUDED", ex
            m.status_reason = f"Matches policy exclusion '{ex.category}'"
        elif cov is not None:
            m.coverage = cov
            m.status = "COVERED" if cov.covered else "NOT_COVERED"
            m.status_reason = f"Policy coverage entry '{cov.category}' covered={cov.covered}"
        else:
            m.status_reason = ("No applicable policy condition supplied" if cat
                               else "Item could not be categorised; INSUFFICIENT_EVIDENCE")
        return m
