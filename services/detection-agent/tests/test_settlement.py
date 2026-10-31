from decimal import Decimal

import pytest

from app.engines.settlement_engine import resolve_strategy
from tests.conftest import by_cat


def test_room_rent_excess_and_exclusion_and_settlement(analyze, payload):
    out = analyze(payload)
    fin = out.response["financial_summary"]
    assert out.status == "COMPLETED"
    room = by_cat(out, "POLICY_LIMIT_BREACH")[0]
    assert room["requested_amount"] == 21000 and room["allowed_amount"] == 15000 and room["leakage_amount"] == 6000
    assert room["amount_type"] == "CALCULATED" and room["rule_id"] == "RULE-POL-003"
    exc = by_cat(out, "EXCLUDED_SERVICE")[0]
    assert exc["leakage_amount"] == 4000 and exc["policy_clause"] == "5.2"
    assert fin["eligible_amount"] == 17000
    assert fin["deductible"] == 10000 and fin["copayment"] == 700 and fin["expected_settlement"] == 6300
    assert out.response["leakage_summary"]["calculated_leakage"] == 10000


def test_deductible_then_copay_matches_spec_example(analyze, payload):
    payload["claim"]["invoice"]["items"] = [{"item_id": "A", "description": "Surgery", "service_code": "SURG", "total_amount": 66000}]
    payload["claim"]["invoice"]["total_amount"] = payload["claim"]["requested_amount"] = 66000
    fin = analyze(payload).response["financial_summary"]
    assert (fin["eligible_amount"], fin["deductible"], fin["copayment"], fin["expected_settlement"]) == (66000, 10000, 5600, 50400)


def test_copay_before_deductible_differs(analyze, payload):
    payload["claim"]["invoice"]["items"] = [{"item_id": "A", "description": "Surgery", "service_code": "SURG", "total_amount": 66000}]
    payload["claim"]["invoice"]["total_amount"] = payload["claim"]["requested_amount"] = 66000
    payload["options"] = {"settlement_strategy": "COPAY_THEN_DEDUCTIBLE"}
    fin = analyze(payload).response["financial_summary"]
    assert fin["copayment"] == 6600 and fin["expected_settlement"] == 49400


def test_overall_sum_insured_limit(analyze, payload):
    payload["policy"]["sum_insured"] = 20000
    payload["history"]["previous_settlements"] = [{"policy_number": "POL-001", "settled_amount": 18000, "settlement_date": "2026-05-01"}]
    out = analyze(payload)
    assert out.response["financial_summary"]["expected_settlement"] == 2000
    assert by_cat(out, "SUM_INSURED_EXCEEDED")


def test_unknown_strategy_rejected():
    with pytest.raises(ValueError):
        resolve_strategy("NOPE", "DEDUCTIBLE_THEN_COPAY")
    assert resolve_strategy(["COPAY", "DEDUCTIBLE"], "x")[1] == ["COPAY", "DEDUCTIBLE"]


def test_settlement_discrepancy_not_double_counted(analyze, payload):
    payload["claim"]["proposed_settlement"] = 20000
    out = analyze(payload)
    fin, summ = out.response["financial_summary"], out.response["leakage_summary"]
    assert fin["calculated_discrepancy"] == 13700
    disc = by_cat(out, "SETTLEMENT_DISCREPANCY")[0]
    assert disc["leakage_amount"] == 13700 and disc["included_in_totals"] is False
    assert summ["calculated_leakage"] == 10000  # line-level only


def test_no_double_counting_across_engines(analyze, payload):
    # excluded item that is also duplicated on the invoice: leakage can never exceed the line total
    payload["claim"]["invoice"]["items"].append(dict(payload["claim"]["invoice"]["items"][2], item_id="ITEM-004"))
    payload["claim"]["invoice"]["total_amount"] = payload["claim"]["requested_amount"] = 31000
    out = analyze(payload)
    per_item: dict = {}
    for f in out.response["findings"]:
        if f["item_id"] and f["included_in_totals"] and f["leakage_amount"]:
            per_item[f["item_id"]] = per_item.get(f["item_id"], 0) + f["leakage_amount"]
    totals = {i["item_id"]: i["total_amount"] for i in out.response["policy_validation"]["items"]}
    assert all(per_item[k] <= totals[k] for k in per_item)


def test_exact_duplicate_line_removed_from_payable(analyze, payload):
    # same line twice on the same service date => exact duplicate; its allowed amount must not be paid
    payload["claim"]["invoice"]["items"] = [
        {"item_id": "A", "description": "Surgery", "service_code": "SURG", "total_amount": 30000, "service_date": "2026-06-02"},
        {"item_id": "B", "description": "Surgery", "service_code": "SURG", "total_amount": 30000, "service_date": "2026-06-02"}]
    payload["claim"]["invoice"]["total_amount"] = payload["claim"]["requested_amount"] = 60000
    fin = analyze(payload).response["financial_summary"]
    assert fin["eligible_amount"] == 60000 and fin["duplicate_deduction"] == 30000
    assert fin["expected_settlement"] == 18000  # (60000 - 30000 - 10000 deductible) less 10% co-pay
    assert any(s["step"] == "DUPLICATE_DEDUCTION" for s in fin["calculation_steps"])
