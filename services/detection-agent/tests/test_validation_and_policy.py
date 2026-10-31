from tests.conftest import by_cat, cats


def test_valid_input_completes_with_schema_sections(analyze, payload):
    r = analyze(payload).response
    for k in ("success", "analysis_id", "status", "claim", "risk_assessment", "financial_summary", "leakage_summary",
              "policy_validation", "duplicate_analysis", "anomaly_analysis", "findings", "model_insights", "validation",
              "recommendation"):
        assert k in r
    assert r["risk_assessment"]["leakage_chance"] is None
    assert r["risk_assessment"]["assessment_status"] == "RULE_BASED"


def test_invalid_policy_number_blocks(analyze, payload):
    payload["claim"]["policy_number"] = "POL-XYZ"
    out = analyze(payload)
    assert out.status == "VALIDATION_FAILED" and out.response["success"] is False
    assert out.response["validation"]["errors"][0]["code"] == "POLICY_NUMBER_MISMATCH"


def test_expired_policy(analyze, payload):
    payload["policy"]["valid_until"] = "2026-09-30"
    out = analyze(payload)
    f = by_cat(out, "POLICY_INACTIVE")[0]
    assert f["severity"] == "CRITICAL" and f["leakage_amount"] == 27000
    assert out.response["financial_summary"]["expected_settlement"] == 0


def test_missing_policy_information_never_assumed(analyze, payload):
    payload["policy"]["coverage"] = []
    payload["policy"]["exclusions"] = []
    payload["policy"]["sum_insured"] = payload["policy"]["deductible"] = payload["policy"]["copayment_percentage"] = None
    out = analyze(payload)
    assert not by_cat(out, "POLICY_LIMIT_BREACH") and not by_cat(out, "EXCLUDED_SERVICE")
    assert by_cat(out, "MISSING_INFORMATION")
    assert out.response["financial_summary"]["expected_settlement"] == 27000  # no conditions supplied => none applied


def test_invoice_arithmetic_conflicts(analyze, payload):
    payload["claim"]["invoice"]["items"][1]["total_amount"] = 2500
    payload["claim"]["invoice"]["total_amount"] = 27500
    payload["claim"]["requested_amount"] = 27500
    out = analyze(payload)
    f = by_cat(out, "LINE_ARITHMETIC_ERROR")[0]
    assert f["leakage_amount"] == 500 and f["rule_id"] == "RULE-BILL-001"
    assert any(c["code"] == "ITEM_ARITHMETIC_MISMATCH" for c in out.response["validation"]["conflicts"])


def test_requested_exceeds_invoice(analyze, payload):
    payload["claim"]["requested_amount"] = 30000
    assert by_cat(analyze(payload), "REQUESTED_EXCEEDS_INVOICE")[0]["leakage_amount"] == 3000


def test_waiting_period(analyze, payload):
    payload["policy"]["waiting_periods"] = [{"category": "DIAGNOSTICS", "days": 400, "clause_reference": "4.1"}]
    f = by_cat(analyze(payload), "WAITING_PERIOD_VIOLATION")[0]
    assert f["policy_clause"] == "4.1" and f["leakage_amount"] == 2000


def test_category_limit_and_unmapped_items(analyze, payload):
    payload["claim"]["invoice"]["items"].append({"item_id": "X", "description": "Zzzq widget", "total_amount": 100})
    payload["claim"]["invoice"]["total_amount"] = payload["claim"]["requested_amount"] = 27100
    out = analyze(payload)
    assert any(f["item_id"] == "X" and f["category"] == "MISSING_INFORMATION" for f in out.response["findings"])
    payload["claim"]["invoice"]["items"][1]["total_amount"] = 12000
    payload["claim"]["invoice"]["items"][1]["unit_price"] = 12000
    payload["claim"]["invoice"]["total_amount"] = payload["claim"]["requested_amount"] = 37100
    leak = [f for f in analyze(payload).response["findings"] if f["item_id"] == "ITEM-002" and f["category"] == "POLICY_LIMIT_BREACH"]
    assert leak and leak[0]["leakage_amount"] == 2000


def test_icu_vs_room_mapping(analyze, payload):
    payload["claim"]["invoice"]["items"] = [{"item_id": "I", "description": "ICU room charges", "total_amount": 5000}]
    payload["claim"]["invoice"]["total_amount"] = payload["claim"]["requested_amount"] = 5000
    m = analyze(payload).response["policy_validation"]["items"][0]["mapping"]
    assert m["category"] == "ICU" and m["method"] == "SYNONYM"
