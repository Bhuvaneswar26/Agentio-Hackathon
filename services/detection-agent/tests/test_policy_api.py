"""HTTP contract for the policy-document RAG endpoints."""
from __future__ import annotations

import io

import pytest
from fastapi.testclient import TestClient

from app.core.config import get_settings
from app.main import create_app

DOC = """
SECTION 1 - BENEFITS

1.1 Sum Insured
    The sum insured under this policy is Rs. 4,00,000 per policy year, being the maximum liability.
1.2 Deductible
    A deductible of Rs. 7,500 shall be borne by the insured on each and every claim.
1.3 Co-payment
    The insured shall bear 15% of each admissible claim as co-payment.

SECTION 2 - SUB-LIMITS

2.1 Room Rent
    Room rent is payable up to Rs. 4,000 per day of hospitalisation.

SECTION 3 - EXCLUSIONS

3.1 Consumables such as gloves and syringes are not payable under this policy.
"""


@pytest.fixture(scope="module")
def client():
    with TestClient(create_app()) as c:
        yield c


def test_rag_status_reports_each_component(client):
    body = client.get("/api/v1/policy/rag/status").json()
    assert body["retrieval"]["status"] == "AVAILABLE"
    assert body["retrieval"]["requires_api_key"] is False
    assert body["rule_based_extraction"]["status"] == "AVAILABLE"
    # The LLM path is optional; whichever way it resolves, it must explain itself.
    assert body["llm_extraction"]["status"] in ("AVAILABLE", "UNAVAILABLE")
    assert body["llm_extraction"]["reason"]


def test_rag_status_supports_gemini_provider(client, monkeypatch):
    monkeypatch.setenv("CG_LLM_PROVIDER", "gemini")
    monkeypatch.setenv("GEMINI_API_KEY", "test-key")
    get_settings.cache_clear()
    try:
        body = client.get("/api/v1/policy/rag/status").json()["llm_extraction"]
    finally:
        get_settings.cache_clear()
    assert body["provider"] == "gemini"
    assert body["model"] == "gemini-3.6-flash"


def test_extract_returns_a_policy_with_citations(client):
    r = client.post("/api/v1/policy/extract",
                    json={"document_text": DOC, "policy_number": "POL-API-1", "policy_type": "HEALTH"})
    assert r.status_code == 200
    body = r.json()
    policy = body["policy"]
    assert policy["policy_number"] == "POL-API-1"
    assert float(policy["deductible"]) == 7500
    assert float(policy["copayment_percentage"]) == 15
    assert float(policy["sum_insured"]) == 400000
    room = next(s for s in policy["sublimits"] if s["category"] == "ROOM_RENT")
    assert float(room["daily_limit"]) == 4000
    # Every scalar must name the clause it came from.
    assert "Clause 1.2" in policy["extraction_citations"]["deductible"]["citation"]
    assert body["facts"] and body["document"]["chunks"] > 3


def test_extracted_policy_is_accepted_by_the_analysis_endpoint(client):
    """The point of extraction: its output must be postable straight into /analyze."""
    extracted = client.post("/api/v1/policy/extract",
                            json={"document_text": DOC, "policy_number": "POL-API-2",
                                  "policy_type": "HEALTH", "valid_from": "2025-04-01",
                                  "valid_until": "2026-03-31"}).json()["policy"]
    claim = {
        "claim_id": "CLM-API-2", "policy_number": "POL-API-2", "claim_type": "HEALTH",
        "claimant": {"name": "Test Claimant", "patient_id": "PAT-1"},
        "provider": {"provider_id": "HSP-1", "name": "Test Hospital", "provider_type": "HOSPITAL"},
        "incident": {"incident_date": "2025-06-01", "admission_date": "2025-06-01",
                     "discharge_date": "2025-06-03"},
        "invoice": {"invoice_id": "INV-API-2", "invoice_date": "2025-06-03", "total_amount": 20000,
                    "currency": "INR", "items": [
                        # 2 days at 6,000 against the extracted 4,000/day cap => 4,000 over.
                        {"item_id": "I1", "description": "Room Charges", "service_code": "ROOM-PVT",
                         "quantity": 2, "unit_price": 6000, "total_amount": 12000},
                        {"item_id": "I2", "description": "Surgical Gloves", "service_code": "CONS-GLOVE",
                         "quantity": 1, "unit_price": 8000, "total_amount": 8000}]},
        "requested_amount": 20000, "proposed_settlement": 20000}
    r = client.post("/api/v1/analyze", json={"claim": claim, "policy": extracted})
    assert r.status_code == 200, r.text
    body = r.json()
    categories = {f["category"] for f in body["findings"]}
    # The cap and the exclusion came from the document, and both bite.
    assert "POLICY_LIMIT_BREACH" in categories
    assert "EXCLUDED_SERVICE" in categories
    assert float(body["leakage_summary"]["calculated_leakage"]) >= 12000


def test_ask_returns_clauses_with_citations(client):
    body = client.post("/api/v1/policy/ask",
                       json={"document_text": DOC, "question": "what is the co-payment?",
                             "use_llm": False}).json()
    assert body["answered"] is True
    assert "Clause 1.3" in body["best_citation"]
    assert "15%" in body["clauses"][0]["text"]


def test_ask_automatically_uses_gemini(client, monkeypatch):
    from app.api import policy as policy_api

    def fake_answer(question, hits):
        assert question == "what is the co-payment?"
        assert any(hit.chunk.clause_id == "1.3" for hit in hits)
        return {
            "answer": "The insured bears 15% as co-payment.",
            "cited_clauses": ["1.3"],
            "provider": "gemini",
            "model": "gemini-3.6-flash",
        }

    monkeypatch.setattr(policy_api, "answer_with_llm", fake_answer)
    body = client.post("/api/v1/policy/ask",
                       json={"document_text": DOC, "question": "what is the co-payment?"}).json()
    assert body["answer"] == "The insured bears 15% as co-payment."
    assert body["cited_clauses"] == ["1.3"]
    assert body["provider"] == "gemini"


def test_ask_falls_back_to_retrieved_clauses_when_gemini_is_unavailable(client, monkeypatch):
    from app.api import policy as policy_api

    def unavailable(question, hits):
        raise RuntimeError("provider unavailable")

    monkeypatch.setattr(policy_api, "answer_with_llm", unavailable)
    # Whether a real key is configured must not change what this test asserts.
    monkeypatch.setattr(policy_api, "llm_available", lambda: (False, "no GEMINI_API_KEY in the environment"))
    response = client.post("/api/v1/policy/ask", json={
        "document_text": DOC,
        "question": "what is the co-payment?",
    })
    assert response.status_code == 200
    body = response.json()
    assert body["answer_source"] == "retrieval_fallback"
    assert "is not ready" in body["llm_notice"]
    assert body["llm_error"]["kind"] == "unavailable"
    assert body["answered"] is True
    assert body["clauses"]


def test_a_document_with_no_clauses_is_rejected_not_guessed(client):
    r = client.post("/api/v1/policy/extract", json={"document_text": "   \n \n  "})
    assert r.status_code == 422
    assert r.json()["detail"]["error"] in ("NO_CLAUSES_FOUND", "VALIDATION_FAILED")


def test_empty_document_text_fails_validation(client):
    assert client.post("/api/v1/policy/extract", json={"document_text": ""}).status_code == 422


def test_upload_accepts_a_text_file(client):
    r = client.post("/api/v1/policy/extract/upload",
                    files={"file": ("policy.txt", io.BytesIO(DOC.encode()), "text/plain")},
                    params={"policy_number": "POL-UPLOAD-1"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["filename"] == "policy.txt"
    assert float(body["policy"]["deductible"]) == 7500


def test_models_status_exposes_synthetic_provenance(client):
    """An operator must be able to see that a demo artefact is not a validated model."""
    body = client.get("/api/v1/models/status").json()
    assert set(body) >= {"catboost", "isolation_forest", "provider_benchmark"}
    for info in body.values():
        if info.get("synthetic"):
            assert "caveat" in info


def test_a_quota_error_is_reported_with_its_real_reason(client, monkeypatch):
    """The user must be told it is a quota problem, not a generic failure."""
    from app.api import policy as policy_api

    def quota(question, hits):
        raise RuntimeError("Error calling model (RESOURCE_EXHAUSTED): 429 Quota exceeded. "
                           "Please retry in 18h52m34.98s.")

    monkeypatch.setattr(policy_api, "answer_with_llm", quota)
    monkeypatch.setattr(policy_api, "llm_available", lambda: (True, "ready"))
    body = client.post("/api/v1/policy/ask", json={
        "document_text": DOC, "question": "what is the co-payment?"}).json()
    assert body["answer_source"] == "retrieval_fallback"
    assert body["llm_error"]["kind"] == "rate_limit"
    assert "quota" in body["llm_error"]["message"]
    assert "18h 52m" in body["llm_error"]["message"]
