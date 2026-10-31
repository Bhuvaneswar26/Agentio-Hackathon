import copy

from tests.conftest import by_cat, cats

PRIOR = {"claim_id": "CLM-000", "claim_type": "HEALTH", "claimant": {"patient_id": "PAT-001"},
         "provider": {"provider_id": "HSP-001", "name": "ABC Hospital", "provider_type": "HOSPITAL"},
         "incident": {"incident_date": "2026-10-10"},
         "invoice": {"invoice_id": "INV-001", "invoice_date": "2026-10-13", "total_amount": 27000,
                     "items": [{"description": "Room Charges", "service_code": "ROOM", "quantity": 3, "unit_price": 7000, "total_amount": 21000}]}}


def test_exact_duplicate_invoice(analyze, payload):
    payload["history"]["previous_claims"] = [PRIOR]
    out = analyze(payload)
    f = by_cat(out, "DUPLICATE_INVOICE")[0]
    assert f["severity"] == "CRITICAL" and f["amount_type"] == "CALCULATED"
    assert out.response["duplicate_analysis"]["by_type"]["EXACT_INVOICE"] == 1
    assert out.response["recommendation"]["action"] == "ESCALATE_FOR_INVESTIGATION"


def test_near_duplicate_invoice(analyze, payload):
    prior = copy.deepcopy(PRIOR)
    prior["invoice"]["invoice_id"] = "INV-0O1"
    payload["history"]["previous_claims"] = [prior]
    out = analyze(payload)
    f = by_cat(out, "NEAR_DUPLICATE_INVOICE")
    assert f and f[0]["amount_type"] == "UNQUANTIFIED" and f[0]["leakage_amount"] is None


def test_duplicate_line_items_same_date(analyze, payload):
    payload["claim"]["invoice"]["items"][1]["service_date"] = "2026-10-11"
    payload["claim"]["invoice"]["items"].append({**payload["claim"]["invoice"]["items"][1], "item_id": "ITEM-009"})
    payload["claim"]["invoice"]["total_amount"] = payload["claim"]["requested_amount"] = 29000
    f = by_cat(analyze(payload), "DUPLICATE_LINE_ITEM")[0]
    assert f["item_id"] == "ITEM-009" and f["amount_type"] == "CALCULATED" and f["leakage_amount"] == 2000


def test_legitimate_repeat_treatments_not_flagged(analyze, payload):
    items = [{"item_id": f"D{i}", "description": "Dialysis session", "service_code": "PROC-D", "quantity": 1,
              "unit_price": 3000, "total_amount": 3000, "service_date": f"2026-10-1{i}"} for i in range(1, 4)]
    payload["claim"]["invoice"]["items"] = items
    payload["claim"]["invoice"]["total_amount"] = payload["claim"]["requested_amount"] = 9000
    out = analyze(payload)
    assert "DUPLICATE_LINE_ITEM" not in cats(out)
    assert out.response["duplicate_analysis"]["legitimate_repeats"]


def test_same_service_far_apart_is_legitimate(analyze, payload):
    prior = copy.deepcopy(PRIOR)
    prior["claim_id"], prior["invoice"]["invoice_id"] = "CLM-OLD", "INV-777"
    prior["invoice"]["invoice_date"], prior["incident"]["incident_date"] = "2026-03-01", "2026-03-01"
    prior["invoice"]["total_amount"] = 21000
    payload["history"]["previous_claims"] = [prior]
    out = analyze(payload)
    assert "CROSS_CLAIM_DUPLICATE" not in cats(out)
    assert out.response["duplicate_analysis"]["legitimate_repeats"][0]["type"] == "SAME_SERVICE_OUTSIDE_WINDOW"


def test_cross_claim_item_duplicate(analyze, payload):
    prior = copy.deepcopy(PRIOR)
    prior["claim_id"], prior["invoice"]["invoice_id"], prior["invoice"]["total_amount"] = "CLM-OLD", "INV-555", 21000
    prior["invoice"]["invoice_date"] = "2026-10-11"
    payload["history"]["previous_claims"] = [prior]
    f = by_cat(analyze(payload), "CROSS_CLAIM_DUPLICATE")
    assert f and f[0]["item_id"] == "ITEM-001"


def _peers(n=8, price=2000):
    return [{"claim_id": f"P{i}", "provider": {"provider_type": "HOSPITAL"}, "invoice": {
        "invoice_id": f"X{i}", "invoice_date": "2026-01-01", "total_amount": 27000 + i * 50,
        "items": [{"service_code": "DIAG-001", "description": "Diagnostic Test", "quantity": 1,
                   "unit_price": price + i * 20, "total_amount": price + i * 20}]}} for i in range(n)]


def test_provider_billing_anomaly(analyze, payload):
    payload["claim"]["invoice"]["items"][1].update(unit_price=9000, total_amount=9000)
    payload["claim"]["invoice"]["total_amount"] = payload["claim"]["requested_amount"] = 34000
    payload["history"]["related_invoices"] = _peers()
    out = analyze(payload)
    f = [x for x in out.response["findings"] if x["rule_id"] == "RULE-BILL-002"]
    assert f and f[0]["amount_type"] == "ESTIMATED" and f[0]["leakage_amount"] > 0
    assert out.response["leakage_summary"]["estimated_leakage"] > 0


def test_no_peer_data_means_no_anomaly_flag(analyze, payload):
    out = analyze(payload)
    assert not out.response["anomaly_analysis"]["anomalies_detected"]
    assert out.response["anomaly_analysis"]["insufficient_evidence"]


def test_quantity_exceeds_stay(analyze, payload):
    payload["claim"]["invoice"]["items"][0].update(quantity=5, total_amount=35000)
    payload["claim"]["invoice"]["total_amount"] = payload["claim"]["requested_amount"] = 41000
    f = [x for x in analyze(payload).response["findings"] if x["rule_id"] == "RULE-BILL-003"][0]
    assert f["amount_type"] == "CALCULATED" and f["leakage_amount"] == 14000
