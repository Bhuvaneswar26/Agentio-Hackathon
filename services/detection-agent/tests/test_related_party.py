"""Related-party / claim-network detection (leakage scenario 4, second half)."""
from __future__ import annotations

import copy

import pytest

from app.core.config import get_settings
from app.engines.related_party_engine import RelatedPartyEngine
from app.schemas.input_schema import AnalyzeRequest
from app.services.normalization_service import normalize

BASE_CLAIM = {
    "claim_id": "CLM-RP-001", "policy_number": "POL-RP-1", "claim_type": "HEALTH",
    "claimant": {"name": "Arjun Mehta", "age": 41, "patient_id": "PAT-500",
                 "bank_account": "HDFC0001234567890", "contact_number": "9876500000"},
    "provider": {"provider_id": "HSP-9", "name": "Lakeview Hospital", "provider_type": "HOSPITAL"},
    "incident": {"incident_date": "2025-05-20", "admission_date": "2025-05-20",
                 "discharge_date": "2025-05-22"},
    "invoice": {"invoice_id": "INV-500", "invoice_date": "2025-05-22", "total_amount": 20000,
                "currency": "INR",
                "items": [{"item_id": "I1", "description": "Room Charges", "service_code": "ROOM-GEN",
                           "quantity": 2, "unit_price": 10000, "total_amount": 20000}]},
    "requested_amount": 20000,
}
POLICY = {"policy_number": "POL-RP-1", "policy_type": "HEALTH"}


def analyse(claim: dict, previous: list[dict] | None = None):
    request = AnalyzeRequest.model_validate(
        {"claim": claim, "policy": POLICY,
         "history": {"previous_claims": previous or [], "related_invoices": []}})
    ctx, _ = normalize(request, get_settings())
    return RelatedPartyEngine(get_settings()).analyze(ctx)


def types_of(result) -> set[str]:
    return {a.anomaly_type for a in result.anomalies}


# ------------------------------------------------------------------ shared identifiers

def test_shared_bank_account_under_a_different_claimant_is_flagged():
    other = {"claim_id": "CLM-RP-900", "policy_number": "POL-OTHER",
             "claimant": {"name": "Vikram Nair", "patient_id": "PAT-777",
                          "bank_account": "HDFC0001234567890"},
             "provider": {"provider_id": "HSP-9"}, "incident_date": "2025-01-02",
             "invoice": {"invoice_id": "INV-900", "total_amount": 15000}}
    result = analyse(BASE_CLAIM, [other])
    assert "RELATED_PARTY_SHARED_IDENTIFIER" in types_of(result)
    flagged = next(a for a in result.anomalies if a.anomaly_type == "RELATED_PARTY_SHARED_IDENTIFIER")
    assert flagged.rule_id == "RULE-RP-001"
    # An investigation lead, never a quantified loss.
    assert flagged.amount_type == "UNQUANTIFIED"
    assert flagged.leakage is None
    assert flagged.component == "related_party"
    assert flagged.evidence["link_type"] == "bank_account"


def test_same_claimant_reusing_their_own_account_is_not_a_related_party():
    """The commonest false positive: one person's own repeat claim shares their own bank account."""
    mine = {"claim_id": "CLM-RP-901", "policy_number": "POL-RP-1",
            "claimant": {"name": "Arjun Mehta", "patient_id": "PAT-500",
                         "bank_account": "HDFC0001234567890"},
            "provider": {"provider_id": "HSP-9"}, "incident_date": "2024-11-02",
            "invoice": {"invoice_id": "INV-901", "total_amount": 9000}}
    assert "RELATED_PARTY_SHARED_IDENTIFIER" not in types_of(analyse(BASE_CLAIM, [mine]))


def test_a_different_account_creates_no_link():
    other = {"claim_id": "CLM-RP-902", "policy_number": "POL-OTHER",
             "claimant": {"name": "Vikram Nair", "patient_id": "PAT-777",
                          "bank_account": "ICIC0009999999999"},
             "provider": {"provider_id": "HSP-9"}, "incident_date": "2025-01-02",
             "invoice": {"invoice_id": "INV-902", "total_amount": 15000}}
    assert "RELATED_PARTY_SHARED_IDENTIFIER" not in types_of(analyse(BASE_CLAIM, [other]))


def test_missing_identifiers_report_insufficient_evidence_rather_than_a_finding():
    claim = copy.deepcopy(BASE_CLAIM)
    claim["claimant"] = {"name": "Arjun Mehta", "patient_id": "PAT-500"}
    result = analyse(claim, [])
    assert not result.anomalies
    checks = {e["check"] for e in result.insufficient_evidence}
    assert "SHARED_IDENTIFIER_DIFFERENT_CLAIMANT" in checks


@pytest.mark.parametrize("field,value", [
    ("contact_number", "9876500000"),
    ("email", "shared@example.com"),
    ("address", "12 MG Road Hyderabad"),
    ("id_number", "ABCDE1234F"),
])
def test_each_link_field_is_matched(field, value):
    claim = copy.deepcopy(BASE_CLAIM)
    claim["claimant"] = {"name": "Arjun Mehta", "patient_id": "PAT-500", field: value}
    other = {"claim_id": "CLM-RP-903", "policy_number": "POL-OTHER",
             "claimant": {"name": "Someone Else", "patient_id": "PAT-888", field: value},
             "provider": {"provider_id": "HSP-9"}, "incident_date": "2025-01-02",
             "invoice": {"invoice_id": "INV-903", "total_amount": 15000}}
    result = analyse(claim, [other])
    assert any(a.evidence.get("link_type") == field for a in result.anomalies)


def test_identifier_matching_ignores_formatting_differences():
    claim = copy.deepcopy(BASE_CLAIM)
    claim["claimant"] = {"name": "Arjun Mehta", "patient_id": "PAT-500",
                         "contact_number": "+91 98765 00000"}
    other = {"claim_id": "CLM-RP-904", "policy_number": "POL-OTHER",
             "claimant": {"name": "Other Person", "patient_id": "PAT-889",
                          "contact_number": "+919876500000"},
             "provider": {"provider_id": "HSP-9"}, "incident_date": "2025-01-02",
             "invoice": {"invoice_id": "INV-904", "total_amount": 15000}}
    assert "RELATED_PARTY_SHARED_IDENTIFIER" in types_of(analyse(claim, [other]))


# ------------------------------------------------------------------ shared incident

def test_same_incident_date_and_provider_different_claimant_is_flagged():
    other = {"claim_id": "CLM-RP-905", "policy_number": "POL-OTHER",
             "claimant": {"name": "Sunita Rao", "patient_id": "PAT-600"},
             "provider": {"provider_id": "HSP-9", "name": "Lakeview Hospital"},
             "incident_date": "2025-05-20",
             "invoice": {"invoice_id": "INV-905", "total_amount": 31000}}
    result = analyse(BASE_CLAIM, [other])
    assert "SHARED_INCIDENT_DIFFERENT_CLAIMANT" in types_of(result)


def test_same_patient_same_day_is_left_to_duplicate_detection():
    """Overlapping engines would double-count; the same patient on the same day is a duplicate."""
    same = {"claim_id": "CLM-RP-906", "policy_number": "POL-RP-1",
            "claimant": {"name": "Arjun Mehta", "patient_id": "PAT-500"},
            "provider": {"provider_id": "HSP-9"}, "incident_date": "2025-05-20",
            "invoice": {"invoice_id": "INV-906", "total_amount": 20000}}
    assert "SHARED_INCIDENT_DIFFERENT_CLAIMANT" not in types_of(analyse(BASE_CLAIM, [same]))


def test_same_date_at_a_different_provider_is_not_flagged():
    other = {"claim_id": "CLM-RP-907", "policy_number": "POL-OTHER",
             "claimant": {"name": "Sunita Rao", "patient_id": "PAT-600"},
             "provider": {"provider_id": "HSP-42", "name": "Other Hospital"},
             "incident_date": "2025-05-20",
             "invoice": {"invoice_id": "INV-907", "total_amount": 31000}}
    assert "SHARED_INCIDENT_DIFFERENT_CLAIMANT" not in types_of(analyse(BASE_CLAIM, [other]))


# ------------------------------------------------------------------ name similarity

def test_near_identical_claimant_name_at_the_same_provider_is_a_low_severity_lead():
    other = {"claim_id": "CLM-RP-908", "policy_number": "POL-OTHER",
             "claimant": {"name": "Arjun Mehtaa", "patient_id": "PAT-601"},
             "provider": {"provider_id": "HSP-9"}, "incident_date": "2025-02-01",
             "invoice": {"invoice_id": "INV-908", "total_amount": 12000}}
    result = analyse(BASE_CLAIM, [other])
    hit = next(a for a in result.anomalies if a.anomaly_type == "SIMILAR_CLAIMANT_NAME_SAME_PROVIDER")
    # Usually a family member or a spelling variant, so it must not dominate the risk score.
    assert hit.severity == "LOW"
    assert hit.amount_type == "UNQUANTIFIED"


def test_unrelated_names_are_not_flagged():
    other = {"claim_id": "CLM-RP-909", "policy_number": "POL-OTHER",
             "claimant": {"name": "Priya Krishnan", "patient_id": "PAT-602"},
             "provider": {"provider_id": "HSP-9"}, "incident_date": "2025-02-01",
             "invoice": {"invoice_id": "INV-909", "total_amount": 12000}}
    assert "SIMILAR_CLAIMANT_NAME_SAME_PROVIDER" not in types_of(analyse(BASE_CLAIM, [other]))


# ------------------------------------------------------------------ invoice series

def test_adjacent_invoice_numbers_across_claimants_are_flagged():
    other = {"claim_id": "CLM-RP-910", "policy_number": "POL-OTHER",
             "claimant": {"name": "Sunita Rao", "patient_id": "PAT-603"},
             "provider": {"provider_id": "HSP-9"}, "incident_date": "2025-03-01",
             "invoice": {"invoice_id": "INV-501", "invoice_date": "2025-03-01", "total_amount": 12000}}
    assert "SHARED_INVOICE_SERIES" in types_of(analyse(BASE_CLAIM, [other]))


def test_distant_invoice_numbers_are_not_flagged():
    other = {"claim_id": "CLM-RP-911", "policy_number": "POL-OTHER",
             "claimant": {"name": "Sunita Rao", "patient_id": "PAT-604"},
             "provider": {"provider_id": "HSP-9"}, "incident_date": "2025-03-01",
             "invoice": {"invoice_id": "INV-980", "invoice_date": "2025-03-01", "total_amount": 12000}}
    assert "SHARED_INVOICE_SERIES" not in types_of(analyse(BASE_CLAIM, [other]))


# ------------------------------------------------------------------ overall contract

def test_no_history_produces_no_signals():
    result = analyse(BASE_CLAIM, [])
    assert result.anomalies == []
    assert result.records_compared == 0


def test_every_signal_is_unquantified_and_routed_for_investigation():
    """Nothing in this engine may claim a rupee of leakage or assert fraud."""
    other = {"claim_id": "CLM-RP-912", "policy_number": "POL-OTHER",
             "claimant": {"name": "Vikram Nair", "patient_id": "PAT-777",
                          "bank_account": "HDFC0001234567890"},
             "provider": {"provider_id": "HSP-9"}, "incident_date": "2025-05-20",
             "invoice": {"invoice_id": "INV-501", "total_amount": 15000}}
    result = analyse(BASE_CLAIM, [other])
    assert result.anomalies
    for a in result.anomalies:
        assert a.amount_type == "UNQUANTIFIED"
        assert a.leakage is None
        assert a.component == "related_party"
        assert "fraud" not in a.description.lower()
        assert "interpretation" in a.evidence


def test_result_serialises_with_method_and_counts():
    other = {"claim_id": "CLM-RP-913", "policy_number": "POL-OTHER",
             "claimant": {"name": "Vikram Nair", "patient_id": "PAT-777",
                          "bank_account": "HDFC0001234567890"},
             "provider": {"provider_id": "HSP-9"}, "incident_date": "2025-01-01",
             "invoice": {"invoice_id": "INV-913", "total_amount": 15000}}
    d = analyse(BASE_CLAIM, [other]).to_dict()
    assert d["related_party_signals_detected"] is True
    assert d["count"] >= 1
    assert d["by_type"]
    assert "method" in d
    assert d["checks_run"]
