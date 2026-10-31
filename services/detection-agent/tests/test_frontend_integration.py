import pytest
from fastapi.testclient import TestClient

from app.main import app

RULES = [
    {"id": "PR-ROOM", "name": "Room rent sub-limit", "clause": "Room rent payable up to ₹5,000 per day.", "type": "sublimit", "value": 5000, "unit": "per day"},
    {"id": "PR-EXC", "name": "Consumables exclusion", "clause": "Non-medical consumables are excluded.", "type": "exclusion"},
]


def payload(rules=None, history=None, lines=None):
    return {
        "schemaVersion": "1.0", "ingestedAt": "2026-10-31T10:00:00Z",
        "source": {"format": "json", "engine": "structured-parser", "ocrUsed": False, "confidence": 0.95, "warnings": []},
        "claim": {"claimId": "CLM-DEMO-01", "policyNumber": "HL-77821", "claimant": "Ananya Iyer", "incidentDate": "2026-09-12",
                  "domain": "Health", "claimType": "Hospitalisation", "requestedAmount": 28000, "proposedSettlement": 28000,
                  "provider": "Aarogyam Super Speciality", "city": "Bengaluru"},
        "invoiceLines": lines or [
            {"id": "LINE-1", "description": "Room rent 3 days", "code": "ROOM-DLX", "quantity": 3, "unitPrice": 7000, "amount": 21000, "provider": "", "invoiceRef": "INV-44109", "date": ""},
            {"id": "LINE-2", "description": "CBC diagnostic test", "code": "LAB-CBC", "quantity": 1, "unitPrice": 2000, "amount": 2000, "provider": "", "invoiceRef": "INV-44109", "date": ""},
            {"id": "LINE-3", "description": "CBC diagnostic test", "code": "LAB-CBC", "quantity": 1, "unitPrice": 2000, "amount": 2000, "provider": "", "invoiceRef": "INV-44109", "date": ""},
            {"id": "LINE-4", "description": "Surgical gloves", "code": "CONS-01", "quantity": 1, "unitPrice": 3000, "amount": 3000, "provider": "", "invoiceRef": "INV-44109", "date": ""}],
        "policy": {"policyNumber": "HL-77821", "deductible": 10000, "copayPercent": 20, "rules": RULES if rules is None else rules},
        "history": history or [], "documents": [], "extraction": {"missingFields": [], "valid": True}}


@pytest.fixture(scope="module")
def client():
    with TestClient(app) as c:
        yield c


def test_dashboard_payload_round_trip(client):
    r = client.post("/v1/detect", json=payload())
    assert r.status_code == 200, r.text
    body = r.json()
    c = body["claim"]
    kinds = {f["kind"] for f in c["findings"]}
    assert {"limit_breach", "exclusion", "duplicate_line"} <= kinds
    assert c["queue"] == "flagged" and c["analysisId"] == body["analysis_id"]
    assert c["confirmedLeakage"] >= 9000  # 6000 room excess + 3000 excluded gloves
    room = next(f for f in c["findings"] if f["kind"] == "limit_breach")
    assert room["leakageAmount"] == 6000 and room["policyClause"] == "PR-ROOM" and room["certainty"] == "confirmed"
    assert body["analysis"]["financial_summary"]["expected_settlement"] >= 0


def test_no_assumed_policy_terms(client):
    c = client.post("/v1/detect", json=payload(rules=[])).json()["claim"]
    assert not any(f["kind"] in ("limit_breach", "exclusion") for f in c["findings"])
    assert any(f["kind"] == "insufficient_evidence" for f in c["findings"])


def test_exact_duplicate_against_desk_history(client):
    hist = [{"claimId": "CLM-24011", "incidentDate": "2026-09-12", "amount": 28000, "status": "flagged",
             "claimant": "Ananya Iyer", "provider": "Aarogyam Super Speciality",
             "invoiceLines": payload()["invoiceLines"]}]
    c = client.post("/v1/detect", json=payload(history=hist)).json()["claim"]
    dup = next(f for f in c["findings"] if f["kind"] == "exact_duplicate")
    assert dup["severity"] == "critical" and "CLM-24011" in c["relatedClaimIds"]


def test_incomplete_pack_is_unassessed_without_invented_leakage(client):
    p = payload(lines=[])
    p["invoiceLines"] = []
    p["extraction"] = {"missingFields": ["invoice line items"], "valid": False}
    body = client.post("/v1/detect", json=p).json()
    assert body["status"] == "UNASSESSED" and body["claim"]["queue"] == "unassessed"
    assert body["claim"]["confirmedLeakage"] == 0


def test_indian_date_format_and_unmapped_rule_note(client):
    p = payload(rules=RULES + [{"id": "PR-X", "name": "Mystery rider", "type": "limit", "value": 10}])
    p["claim"]["incidentDate"] = "12/09/2026"
    body = client.post("/v1/detect", json=p).json()
    assert body["status"] == "COMPLETED"
    assert any("Mystery rider" in n for n in body["adapter_notes"])


def test_exact_duplicate_invoice_is_not_payable_and_not_self_related(client):
    hist = [{"claimId": "CLM-24011", "incidentDate": "2026-09-12", "amount": 28000, "status": "flagged",
             "claimant": "Ananya Iyer", "provider": "Aarogyam Super Speciality",
             "invoiceLines": payload()["invoiceLines"]}]
    body = client.post("/v1/detect", json=payload(history=hist)).json()
    fin = body["analysis"]["financial_summary"]
    assert fin["duplicate_deduction"] == fin["eligible_amount"] and fin["expected_settlement"] == 0
    assert body["claim"]["relatedClaimIds"] == ["CLM-24011"]  # never the claim itself
