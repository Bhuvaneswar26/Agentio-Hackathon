"""Build the sample claim pack used to exercise every leakage scenario.

Each sample is written so its expected outcome is arithmetically checkable, and `verify_samples.py`
asserts exactly that. Amounts are computed here rather than hand-typed so the fixtures cannot drift
out of agreement with the assertions.

  python samples/build_samples.py
"""
from __future__ import annotations

import json
from pathlib import Path

HERE = Path(__file__).resolve().parent

# ---------------------------------------------------------------- shared policy (matches policy-document.txt)
POLICY = {
    "policy_number": "POL-HLT-2025-00412",
    "policy_type": "HEALTH",
    "valid_from": "2025-04-01",
    "valid_until": "2026-03-31",
    "inception_date": "2023-04-01",
    "sum_insured": 500000,
    "deductible": 10000,
    "copayment_percentage": 10,
    "coverage": [
        {"category": "ROOM_RENT", "covered": True, "daily_limit": 5000, "clause_reference": "Clause 2.1"},
        {"category": "ICU", "covered": True, "daily_limit": 10000, "clause_reference": "Clause 2.2"},
        {"category": "DIAGNOSTICS", "covered": True, "limit": 25000, "clause_reference": "Clause 2.3"},
        {"category": "SURGERY", "covered": True, "clause_reference": "Clause 2.0"},
        {"category": "PHARMACY", "covered": True, "clause_reference": "Clause 2.0"},
        {"category": "DOCTOR_FEES", "covered": True, "clause_reference": "Clause 2.0"},
        {"category": "AMBULANCE", "covered": True, "limit": 2000, "clause_reference": "Clause 2.4"},
    ],
    "exclusions": [
        {"category": "CONSUMABLES", "description": "Gloves, syringes, disposable gowns and masks",
         "clause_reference": "Clause 3.1"},
    ],
    "sublimits": [
        {"category": "ROOM_RENT", "daily_limit": 5000, "clause_reference": "Clause 2.1"},
        {"category": "ICU", "daily_limit": 10000, "clause_reference": "Clause 2.2"},
        {"category": "DIAGNOSTICS", "limit": 25000, "clause_reference": "Clause 2.3"},
    ],
}


def claimant(name="Rahul Sharma", pid="PAT-1001", age=46, **extra):
    return {"name": name, "age": age, "patient_id": pid, **extra}


def provider(pid="HSP-2001", name="Lakeview Multispeciality Hospital"):
    return {"provider_id": pid, "name": name, "provider_type": "HOSPITAL", "location": "Hyderabad"}


def item(iid, desc, code, qty, unit, total=None, service_date=None):
    row = {"item_id": iid, "description": desc, "service_code": code,
           "quantity": qty, "unit_price": unit, "total_amount": total if total is not None else qty * unit}
    if service_date:
        row["service_date"] = service_date
    return row


def sample(claim, policy=None, history=None, notes="", expect=None):
    return {
        "_scenario_notes": notes,
        "_expected": expect or {},
        "claim": claim,
        "policy": policy or POLICY,
        "history": history or {"previous_claims": [], "related_invoices": []},
    }


SAMPLES: dict[str, dict] = {}

# ---------------------------------------------------------------- 00: control, no leakage
items = [
    item("ITEM-001", "Room Charges - Semi Private", "ROOM-GEN", 3, 4500),      # 13,500 under 5,000/day cap
    item("ITEM-002", "Complete Blood Count", "DIAG-CBC", 1, 600),
    item("ITEM-003", "Consultant Visit", "DOC-CONS", 3, 900),
    # Billed per unit, not as one consolidated total: PHARM-001 is a per-unit benchmark key, so a
    # lump sum under that code is compared against a single medicine's price and flagged.
    item("ITEM-004", "Pharmacy - in patient medication", "PHARM-001", 14, 300),
]
gross = sum(i["total_amount"] for i in items)            # 13500 + 600 + 2700 + 4200 = 21,000
# eligible = gross (nothing excluded or capped); then deductible 10,000, then 10% copay
expected_settlement = round((gross - 10000) * 0.9, 2)    # 9,900
SAMPLES["00-clean-claim-no-leakage"] = sample(
    {"claim_id": "CLM-2025-0900", "policy_number": POLICY["policy_number"], "claim_type": "HEALTH",
     "claimant": claimant(), "provider": provider(),
     "incident": {"incident_date": "2025-09-02", "admission_date": "2025-09-02", "discharge_date": "2025-09-05"},
     "invoice": {"invoice_id": "INV-LV-90001", "invoice_date": "2025-09-05", "total_amount": gross,
                 "currency": "INR", "items": items},
     "requested_amount": gross, "proposed_settlement": expected_settlement},
    notes=("Control case. Everything is within policy, the settlement maths is correct, and nothing is "
           "duplicated. A detector that flags this one is producing false positives."),
    expect={"calculated_leakage": 0, "expected_settlement": expected_settlement,
            "discrepancy": 0, "must_not_contain_categories": ["DUPLICATE_INVOICE", "EXCLUDED_SERVICE",
                                                              "POLICY_LIMIT_BREACH"]})

# ---------------------------------------------------------------- 01: duplicates (scenario 1)
dup_items = [
    item("ITEM-001", "Room Charges - Private", "ROOM-PVT", 2, 5000, service_date="2025-08-11"),
    # same test, same code, same amount, same service date, billed twice => exact duplicate line
    item("ITEM-002", "MRI Brain with contrast", "DIAG-MRI", 1, 9000, service_date="2025-08-11"),
    item("ITEM-003", "MRI Brain with contrast", "DIAG-MRI", 1, 9000, service_date="2025-08-11"),
    item("ITEM-004", "Consultant Visit", "DOC-CONS", 2, 900, service_date="2025-08-11"),
]
dup_gross = sum(i["total_amount"] for i in dup_items)    # 10000 + 9000 + 9000 + 1800 = 29,800
SAMPLES["01-duplicate-invoice-and-line"] = sample(
    {"claim_id": "CLM-2025-0901", "policy_number": POLICY["policy_number"], "claim_type": "HEALTH",
     "claimant": claimant(), "provider": provider(),
     "incident": {"incident_date": "2025-08-10", "admission_date": "2025-08-10", "discharge_date": "2025-08-12"},
     "invoice": {"invoice_id": "INV-LV-90120", "invoice_date": "2025-08-12", "total_amount": dup_gross,
                 "currency": "INR", "items": dup_items},
     "requested_amount": dup_gross, "proposed_settlement": dup_gross},
    history={"previous_claims": [
        # the identical invoice, already settled under an earlier claim => exact duplicate invoice
        {"claim_id": "CLM-2025-0855", "policy_number": POLICY["policy_number"],
         "claimant": {"name": "Rahul Sharma", "patient_id": "PAT-1001"},
         "provider": {"provider_id": "HSP-2001", "name": "Lakeview Multispeciality Hospital"},
         "incident_date": "2025-08-10",
         "invoice": {"invoice_id": "INV-LV-90120", "invoice_date": "2025-08-12", "total_amount": dup_gross,
                     "items": dup_items}},
    ], "related_invoices": []},
    notes=("Scenario 1. Two independent duplicate signals: the MRI line appears twice on the same service "
           "date within this invoice, and the whole invoice was already claimed under CLM-2025-0855."),
    expect={"min_calculated_leakage": 9000,
            "must_contain_categories": ["DUPLICATE_INVOICE", "DUPLICATE_LINE_ITEM"]})

# ---------------------------------------------------------------- 02: limits + exclusions (scenario 2)
# Room billed at 7,000/day for 3 days against a 5,000/day cap => 6,000 excess (the brief's example).
lim_items = [
    item("ITEM-001", "Room Charges - Deluxe", "ROOM-PVT", 3, 7000),           # 21,000, cap 15,000 => 6,000
    item("ITEM-002", "Surgical Gloves and Syringes", "CONS-GLOVE", 1, 2400),   # excluded entirely
    item("ITEM-003", "MRI Brain", "DIAG-MRI", 1, 9000),
    item("ITEM-004", "CT Abdomen", "DIAG-CT", 1, 11000),
    item("ITEM-005", "Ultrasound Whole Abdomen", "DIAG-USG", 1, 8000),        # diagnostics total 28,000 vs 25,000
]
lim_gross = sum(i["total_amount"] for i in lim_items)                          # 51,400
room_excess, consumable_excl, diag_excess = 6000, 2400, 3000
SAMPLES["02-policy-limits-and-exclusions"] = sample(
    {"claim_id": "CLM-2025-0902", "policy_number": POLICY["policy_number"], "claim_type": "HEALTH",
     "claimant": claimant(), "provider": provider(),
     "incident": {"incident_date": "2025-07-14", "admission_date": "2025-07-14", "discharge_date": "2025-07-17"},
     "invoice": {"invoice_id": "INV-LV-90210", "invoice_date": "2025-07-17", "total_amount": lim_gross,
                 "currency": "INR", "items": lim_items},
     "requested_amount": lim_gross, "proposed_settlement": lim_gross},
    notes=(f"Scenario 2. Three separable breaches: room rent {room_excess} over the per-day cap across 3 days, "
           f"{consumable_excl} of excluded consumables, and {diag_excess} over the diagnostics annual sub-limit."),
    expect={"min_calculated_leakage": room_excess + consumable_excl + diag_excess,
            "must_contain_categories": ["POLICY_LIMIT_BREACH", "EXCLUDED_SERVICE"]})

# ---------------------------------------------------------------- 03: settlement miscalculation (scenario 3)
set_items = [
    item("ITEM-001", "Room Charges", "ROOM-GEN", 4, 4000),
    item("ITEM-002", "Appendectomy - OT charges", "SURG-APP", 1, 46000),
    item("ITEM-003", "Pharmacy - in patient medication", "PHARM-001", 20, 300),
]
set_gross = sum(i["total_amount"] for i in set_items)      # 16000 + 46000 + 6000 = 68,000
set_expected = round((set_gross - 10000) * 0.9, 2)         # 52,200
set_proposed = set_gross                                   # handler forgot both deductible and co-pay
SAMPLES["03-settlement-miscalculation"] = sample(
    {"claim_id": "CLM-2025-0903", "policy_number": POLICY["policy_number"], "claim_type": "HEALTH",
     "claimant": claimant(), "provider": provider(),
     "incident": {"incident_date": "2025-06-05", "admission_date": "2025-06-05", "discharge_date": "2025-06-09"},
     "invoice": {"invoice_id": "INV-LV-90330", "invoice_date": "2025-06-09", "total_amount": set_gross,
                 "currency": "INR", "items": set_items},
     "requested_amount": set_gross, "proposed_settlement": set_proposed},
    notes=(f"Scenario 3. Every line is payable; the error is arithmetic. The handler proposed the gross "
           f"{set_gross} without applying the {POLICY['deductible']} deductible or the "
           f"{POLICY['copayment_percentage']}% co-payment. Expected settlement is {set_expected}."),
    expect={"expected_settlement": set_expected, "discrepancy": round(set_proposed - set_expected, 2),
            "must_contain_categories": ["SETTLEMENT_DISCREPANCY"]})

# ---------------------------------------------------------------- 04: provider billing + related party (scenario 4)
# MRI at 26,000 against a peer median near 9,200 across the supplied history.
rp_items = [
    item("ITEM-001", "MRI Brain with contrast", "DIAG-MRI", 1, 26000),
    item("ITEM-002", "Room Charges", "ROOM-GEN", 2, 4500),
]
rp_gross = sum(i["total_amount"] for i in rp_items)        # 35,000
peer_history = [
    {"claim_id": f"CLM-2025-07{n:02d}", "policy_number": "POL-HLT-2025-00999",
     "claimant": {"name": f"Peer Patient {n}", "patient_id": f"PAT-9{n:03d}"},
     "provider": {"provider_id": "HSP-2001", "name": "Lakeview Multispeciality Hospital",
                  "provider_type": "HOSPITAL"},
     "incident_date": "2025-05-02", "invoice": {"invoice_id": f"INV-LV-88{n:03d}",
                                                "invoice_date": "2025-05-03", "total_amount": 13700,
                                                "items": [item(f"P{n}-1", "MRI Brain with contrast", "DIAG-MRI",
                                                               1, 9000 + n * 120),
                                                          item(f"P{n}-2", "Room Charges", "ROOM-GEN", 1, 4500)]}}
    for n in range(1, 8)
]
# A different claimant sharing this claim's payee account, and a same-day same-provider claim.
peer_history.append({
    "claim_id": "CLM-2025-0877", "policy_number": "POL-HLT-2025-00777",
    "claimant": {"name": "Vikram Nair", "patient_id": "PAT-7777", "bank_account": "HDFC0001234567890"},
    "provider": {"provider_id": "HSP-2001", "name": "Lakeview Multispeciality Hospital",
                 "provider_type": "HOSPITAL"},
    "incident_date": "2025-05-20",
    "invoice": {"invoice_id": "INV-LV-90441", "invoice_date": "2025-05-21", "total_amount": 41000,
                "items": [item("V-1", "CT Abdomen", "DIAG-CT", 1, 41000)]}})
SAMPLES["04-provider-billing-and-related-party"] = sample(
    {"claim_id": "CLM-2025-0904", "policy_number": POLICY["policy_number"], "claim_type": "HEALTH",
     "claimant": claimant(name="Arjun Mehta", pid="PAT-1055", bank_account="HDFC0001234567890"),
     "provider": provider(),
     "incident": {"incident_date": "2025-05-20", "admission_date": "2025-05-20", "discharge_date": "2025-05-22"},
     "invoice": {"invoice_id": "INV-LV-90440", "invoice_date": "2025-05-22", "total_amount": rp_gross,
                 "currency": "INR", "items": rp_items},
     "requested_amount": rp_gross, "proposed_settlement": rp_gross},
    history={"previous_claims": peer_history, "related_invoices": []},
    notes=("Scenario 4. The MRI is billed at 26,000 where seven peer invoices at the same hospital sit near "
           "9,200 (an ESTIMATED amount, not a confirmed one). Separately, CLM-2025-0877 belongs to a "
           "different claimant but shares this claim's payee bank account and the same incident date and "
           "provider - a related-party lead for investigation, explicitly not a fraud conclusion."),
    expect={"must_contain_categories": ["BILLING_ANOMALY", "RELATED_PARTY_PATTERN"],
            "must_contain_rule_ids": ["RULE-RP-001"]})

# ---------------------------------------------------------------- 05: legitimate repeat (scenario 5a)
physio_items = [
    item("ITEM-001", "Physiotherapy session", "PHYSIO-01", 1, 800, service_date="2025-10-06"),
    item("ITEM-002", "Physiotherapy session", "PHYSIO-01", 1, 800, service_date="2025-10-08"),
    item("ITEM-003", "Physiotherapy session", "PHYSIO-01", 1, 800, service_date="2025-10-10"),
    item("ITEM-004", "Physiotherapy session", "PHYSIO-01", 1, 800, service_date="2025-10-13"),
]
physio_gross = sum(i["total_amount"] for i in physio_items)   # 3,200
SAMPLES["05-legitimate-repeat-service"] = sample(
    {"claim_id": "CLM-2025-0905", "policy_number": POLICY["policy_number"], "claim_type": "HEALTH",
     "claimant": claimant(), "provider": provider(pid="CLN-3001", name="Lakeview Physiotherapy Clinic"),
     "incident": {"incident_date": "2025-10-06"},
     "invoice": {"invoice_id": "INV-PT-77010", "invoice_date": "2025-10-14", "total_amount": physio_gross,
                 "currency": "INR", "items": physio_items},
     "requested_amount": physio_gross, "proposed_settlement": physio_gross},
    notes=("Scenario 5, first half. Four identical physiotherapy lines that are four genuine sessions on "
           "four different dates. These must land in legitimate_repeats, not in duplicates."),
    expect={"must_not_contain_categories": ["DUPLICATE_LINE_ITEM", "DUPLICATE_INVOICE"],
            "min_legitimate_repeats": 1})

# ---------------------------------------------------------------- 06: incomplete evidence (scenario 5b)
inc_items = [
    item("ITEM-001", "Hospital charges - consolidated", "", 1, 47000),
]
SAMPLES["06-incomplete-evidence"] = sample(
    {"claim_id": "CLM-2025-0906", "policy_number": "POL-HLT-2025-00412", "claim_type": "HEALTH",
     "claimant": {"name": "Meera Iyer"},
     "provider": {"name": "City Care Hospital"},
     "incident": {},
     "invoice": {"invoice_id": "INV-CC-5500", "total_amount": 47000, "currency": "INR", "items": inc_items},
     "requested_amount": 47000},
    policy={"policy_number": "POL-HLT-2025-00412", "policy_type": "HEALTH"},
    notes=("Scenario 5, second half. A consolidated line with no breakdown, no dates and a policy with no "
           "stated terms. The right behaviour is to ask for information, not to invent a limit breach: "
           "expect MISSING_INFORMATION findings and zero calculated leakage."),
    expect={"calculated_leakage": 0, "must_contain_categories": ["MISSING_INFORMATION"]})


def main() -> None:
    HERE.mkdir(parents=True, exist_ok=True)
    for name, payload in SAMPLES.items():
        path = HERE / f"{name}.json"
        path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
        print(f"wrote {path.name}")
    index = {name: {"file": f"{name}.json", "notes": p["_scenario_notes"], "expected": p["_expected"]}
             for name, p in SAMPLES.items()}
    (HERE / "index.json").write_text(json.dumps(index, indent=2), encoding="utf-8")
    print(f"wrote index.json ({len(SAMPLES)} samples)")


if __name__ == "__main__":
    main()
