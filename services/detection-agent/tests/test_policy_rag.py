"""Policy-document RAG: chunking, retrieval, extraction and the no-invention guarantees."""
from __future__ import annotations

from decimal import Decimal
from types import SimpleNamespace
from unittest.mock import patch

import pytest

from app.rag import llm_extractor
from app.rag.chunker import chunk_policy_document
from app.rag.extractors import detect_category, find_money
from app.rag.llm_extractor import LLMPolicyExtraction, LLMScalar, _as_facts
from app.rag.retriever import ChunkRetriever
from app.rag.service import PolicyDocumentIndex, answer_question, extract_policy

POLICY_DOC = """
NATIONAL HEALTH SHIELD POLICY
Policy Number: POL-HLT-2025-00412

SECTION 1 - SCHEDULE OF BENEFITS

1.1 Sum Insured
    The sum insured under this policy is Rs. 5,00,000 per policy year, being the maximum
    liability of the Company for all claims in the aggregate.

1.2 Deductible
    A deductible of Rs. 10,000 shall be borne by the insured on each and every claim.

1.3 Co-payment
    The insured shall bear 10% of each admissible claim as co-payment.

SECTION 2 - SUB-LIMITS

2.1 Room Rent
    Room rent is payable up to Rs. 5,000 per day of hospitalisation.

2.2 Intensive Care Unit
    ICU charges are payable up to Rs. 10,000 per day.

2.3 Diagnostics
    Diagnostic and laboratory investigations are covered subject to a limit of Rs. 25,000
    per policy year.

SECTION 3 - EXCLUSIONS

3.1 Consumables such as gloves, syringes, disposable gowns and masks are not payable
    under this policy.
3.2 Cosmetic and aesthetic treatment is excluded.

SECTION 4 - WAITING PERIODS

4.1 No claim shall be admissible during the first 30 days of the policy.
4.2 Pre-existing diseases are subject to a waiting period of 36 months of continuous coverage.
"""

SILENT_DOC = """
SECTION 1 - GENERAL CONDITIONS

1.1 Notification
    The insured shall notify the Company of any claim within 48 hours of admission.
1.2 Jurisdiction
    This policy is subject to the exclusive jurisdiction of the courts at Mumbai.
"""


@pytest.fixture(scope="module")
def index() -> PolicyDocumentIndex:
    return PolicyDocumentIndex(POLICY_DOC, source="POL-HLT-2025-00412")


@pytest.fixture(scope="module")
def extraction(index):
    return extract_policy(index, policy_number="POL-HLT-2025-00412", policy_type="HEALTH")


# ------------------------------------------------------------------ chunking

def test_chunking_keeps_clause_and_heading_for_citation():
    chunks = chunk_policy_document(POLICY_DOC, source="P")
    assert len(chunks) > 8
    room = next(c for c in chunks if "Room rent is payable" in c.text)
    assert room.clause_id == "2.1"
    assert "Sub-Limits" in room.citation
    assert "Clause 2.1" in room.citation


def test_chunking_tracks_page_markers():
    doc = "--- page 1 ---\n1.1 Alpha\n    " + "a" * 60 + "\n--- page 7 ---\n2.1 Beta\n    " + "b" * 60
    pages = {c.clause_id: c.page for c in chunk_policy_document(doc, source="P")}
    assert pages["1.1"] == 1
    assert pages["2.1"] == 7


def test_empty_document_produces_no_chunks():
    assert chunk_policy_document("") == []
    assert chunk_policy_document("   \n  \n") == []


# ------------------------------------------------------------------ retrieval

@pytest.mark.parametrize("query,topics,expected_clause", [
    ("co-payment percentage", ["copayment"], "1.3"),
    ("room rent per day cap", ["room_rent"], "2.1"),
    ("deductible borne by the insured", ["deductible"], "1.2"),
    ("intensive care daily limit", ["icu"], "2.2"),
])
def test_retrieval_ranks_the_governing_clause_first(index, query, topics, expected_clause):
    hits = index.retriever.search(query, top_k=3, topics=topics)
    assert hits[0].chunk.clause_id == expected_clause


def test_retriever_on_empty_corpus_returns_nothing():
    assert ChunkRetriever([]).search("anything") == []


# ------------------------------------------------------------------ money parsing

@pytest.mark.parametrize("text,expected", [
    ("Rs. 5,000 per day", Decimal("5000")),
    ("INR 10,000", Decimal("10000")),
    ("Rs. 5,00,000 per policy year", Decimal("500000")),
    ("a sum of Rs. 2 lakh", Decimal("200000")),
    ("5 crore of cover", Decimal("50000000")),
    ("25,000/- only", Decimal("25000")),
])
def test_money_parsing_handles_indian_notation(text, expected):
    assert find_money(text)[0][0] == expected


def test_icu_wins_over_room_for_an_icu_room_charge():
    # Priority order matters: "ICU room charges" must map to ICU, not ROOM_RENT.
    assert detect_category("ICU room charges per day")[0] == "ICU"


# ------------------------------------------------------------------ extraction accuracy

def test_scalars_match_the_document(extraction):
    p = extraction.policy
    assert Decimal(str(p["deductible"])) == Decimal("10000")
    assert Decimal(str(p["copayment_percentage"])) == Decimal("10")
    assert Decimal(str(p["sum_insured"])) == Decimal("500000")


def test_sublimits_separate_per_day_from_per_year(extraction):
    subs = {s["category"]: s for s in extraction.policy["sublimits"]}
    assert Decimal(str(subs["ROOM_RENT"]["daily_limit"])) == Decimal("5000")
    assert Decimal(str(subs["ICU"]["daily_limit"])) == Decimal("10000")
    # A per-policy-year cap must not become a daily one, or the engine would allow it every day.
    assert Decimal(str(subs["DIAGNOSTICS"]["limit"])) == Decimal("25000")
    assert "daily_limit" not in subs["DIAGNOSTICS"]


def test_consumables_exclusion_is_extracted_and_categorised(extraction):
    cats = {e["category"] for e in extraction.policy["exclusions"]}
    assert "CONSUMABLES" in cats


def test_exclusion_drives_coverage_false(extraction):
    coverage = {c["category"]: c["covered"] for c in extraction.policy["coverage"]}
    assert coverage["CONSUMABLES"] is False
    assert coverage["ROOM_RENT"] is True


def test_every_fact_is_traceable_to_a_clause(extraction):
    assert extraction.facts
    for fact in extraction.facts:
        assert fact.citation
        assert fact.chunk_id
        assert 0.0 <= fact.confidence <= 1.0


def test_waiting_period_clause_is_not_also_read_as_an_exclusion(extraction):
    # "No claim shall be admissible during the first 30 days" is time-bound, not a carve-out.
    descriptions = " ".join(e["description"] for e in extraction.policy["exclusions"]).lower()
    assert "first 30 days" not in descriptions


def test_condition_scoped_waiting_period_is_not_enforced_policy_wide(extraction):
    """The 36-month pre-existing-disease wait must never become a blanket rule.

    A category-less waiting period is applied by the policy engine to every line of every claim, so
    promoting this one would void every claim on the policy.
    """
    enforced = extraction.policy["waiting_periods"]
    assert [w["days"] for w in enforced] == [30]
    held = extraction.policy["waiting_periods_requiring_review"]
    assert any(w["days"] == 36 * 30 for w in held)


# ------------------------------------------------------------------ no-invention guarantees

def test_a_silent_document_yields_no_invented_terms():
    index = PolicyDocumentIndex(SILENT_DOC, source="SILENT")
    result = extract_policy(index, policy_number="POL-SILENT")
    for field in ("deductible", "copayment_percentage", "sum_insured", "sublimits", "exclusions"):
        assert field not in result.policy, f"{field} was invented from a document that never states it"
    unresolved = {u["field"] for u in result.unresolved}
    assert {"deductible", "copayment_percentage", "sum_insured"} <= unresolved


def test_conflicting_clauses_are_surfaced_not_silently_resolved():
    doc = POLICY_DOC + """
SECTION 9 - ENDORSEMENT

9.1 Deductible
    Notwithstanding Clause 1.2, a deductible of Rs. 25,000 shall apply to this policy.
"""
    result = extract_policy(PolicyDocumentIndex(doc, source="CONFLICT"), policy_number="P")
    conflict = next((c for c in result.conflicts if c["field"] == "deductible"), None)
    assert conflict is not None, "two different deductibles must raise a conflict"
    assert len(conflict["candidates"]) >= 2
    assert {str(int(float(c["value"]))) for c in conflict["candidates"]} >= {"10000", "25000"}


def test_low_confidence_facts_are_reported_but_not_promoted(index):
    strict = extract_policy(index, policy_number="P", min_confidence=0.99)
    assert "deductible" not in strict.policy
    assert strict.low_confidence


# ------------------------------------------------------------------ grounded Q&A

def test_question_returns_the_governing_clause_verbatim(index):
    answer = answer_question(index, "are consumables such as gloves payable?")
    assert answer["answered"] is True
    assert "3.1" in answer["best_citation"]
    assert "not payable" in answer["clauses"][0]["text"].lower()


def test_question_with_no_match_says_so():
    answer = answer_question(PolicyDocumentIndex("1.1 Jurisdiction\n    " + "x" * 80, source="X"),
                             "what is the room rent limit")
    # Either no hit at all, or hits the caller can see are weak -- never a fabricated answer.
    assert answer["clauses"] == [] or answer["confidence"] < 0.35


# ------------------------------------------------------------------ LLM grounding check

def test_llm_facts_citing_an_unretrieved_clause_are_dropped(index):
    """The grounding check: a hallucinated citation must not reach the policy."""
    hits = index.retriever.search("deductible", top_k=2, topics=["deductible"])
    by_clause = {h.chunk.clause_id: h for h in hits}
    good = LLMPolicyExtraction(deductible=LLMScalar(
        value=10000, clause_id=hits[0].chunk.clause_id, snippet="deductible of Rs. 10,000", confidence=0.9))
    assert len(_as_facts(good, by_clause)) == 1

    invented = LLMPolicyExtraction(deductible=LLMScalar(
        value=99999, clause_id="99.9", snippet="a clause that was never supplied", confidence=0.99))
    assert _as_facts(invented, by_clause) == []


def test_llm_path_is_optional_and_reports_why_it_is_off(extraction):
    assert extraction.llm["status"] in ("NOT_REQUESTED", "UNAVAILABLE", "AVAILABLE", "ERROR", "SKIPPED")
    assert extraction.llm.get("reason") or extraction.llm.get("model")


def test_gemini_provider_uses_structured_output_and_keeps_citations(index, monkeypatch):
    settings = SimpleNamespace(
        llm_provider="gemini", gemini_api_key="test-key",
        anthropic_api_key="", anthropic_auth_token="")
    monkeypatch.setattr(llm_extractor, "get_settings", lambda: settings)
    hits = index.retriever.search("deductible", top_k=1, topics=["deductible"])
    response = SimpleNamespace(
        text='{"deductible":{"value":10000,"clause_id":"1.2",'
             '"snippet":"deductible of Rs. 10,000","confidence":0.9}}',
        usage_metadata=SimpleNamespace(prompt_token_count=12, candidates_token_count=8))

    with patch("google.genai.Client") as client_type:
        client_type.return_value.models.generate_content.return_value = response
        facts, info = llm_extractor.extract_with_llm(hits)

    assert len(facts) == 1
    assert facts[0].clause_id == "1.2"
    assert info["provider"] == "gemini"
    assert info["model"] == "gemini-3.6-flash"
    assert info["input_tokens"] == 12
    request = client_type.return_value.models.generate_content.call_args.kwargs
    assert request["config"].response_mime_type == "application/json"
    assert request["config"].response_schema is LLMPolicyExtraction
