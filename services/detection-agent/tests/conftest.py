import os
import tempfile

_tmp = tempfile.mkdtemp(prefix="cg_test_")
os.environ["CG_DATABASE_URL"] = f"sqlite:///{_tmp}/test.db"
os.environ["CG_EXECUTION_MODE"] = "sync"
os.environ["CG_MODEL_DIR"] = f"{_tmp}/no_models"

import copy  # noqa: E402

import pytest  # noqa: E402

from app.core.config import get_settings  # noqa: E402
from app.ml.inference import ModelRegistry  # noqa: E402
from app.schemas.input_schema import AnalyzeRequest  # noqa: E402
from app.services.analysis_pipeline import run_analysis  # noqa: E402

BASE = {
    "claim": {
        "claim_id": "CLM-001", "policy_number": "POL-001", "claim_type": "HEALTH",
        "claimant": {"name": "Rahul Sharma", "age": 45, "patient_id": "PAT-001"},
        "provider": {"provider_id": "HSP-001", "name": "ABC Hospital", "provider_type": "HOSPITAL", "location": "Hyderabad"},
        "incident": {"incident_date": "2026-10-10", "admission_date": "2026-10-10", "discharge_date": "2026-10-13"},
        "invoice": {"invoice_id": "INV-001", "invoice_date": "2026-10-13", "total_amount": 27000, "currency": "INR",
                    "items": [
                        {"item_id": "ITEM-001", "description": "Room Charges", "service_code": "ROOM", "quantity": 3,
                         "unit_price": 7000, "total_amount": 21000},
                        {"item_id": "ITEM-002", "description": "Diagnostic Test", "service_code": "DIAG-001", "quantity": 1,
                         "unit_price": 2000, "total_amount": 2000},
                        {"item_id": "ITEM-003", "description": "Surgical Gloves", "service_code": "CONS-001", "quantity": 1,
                         "unit_price": 4000, "total_amount": 4000}]},
        "requested_amount": 27000, "proposed_settlement": None},
    "policy": {
        "policy_number": "POL-001", "policy_type": "HEALTH", "valid_from": "2026-01-01", "valid_until": "2026-12-31",
        "sum_insured": 500000, "deductible": 10000, "copayment_percentage": 10,
        "coverage": [{"category": "ROOM_RENT", "covered": True, "daily_limit": 5000},
                     {"category": "DIAGNOSTICS", "covered": True, "limit": 10000}],
        "exclusions": [{"category": "CONSUMABLES", "description": "Non-covered medical consumables", "clause_reference": "5.2"}],
        "sublimits": []},
    "history": {"previous_claims": [], "previous_settlements": [], "related_invoices": []},
}


@pytest.fixture
def payload():
    return copy.deepcopy(BASE)


@pytest.fixture
def registry(tmp_path):
    return ModelRegistry(tmp_path / "empty")


@pytest.fixture
def analyze(registry):
    def _run(data, **kw):
        return run_analysis(AnalyzeRequest.model_validate(data), "ANL-test0001", settings=get_settings(), registry=registry, **kw)
    return _run


def cats(out):
    return [f["category"] for f in out.response["findings"]]


def by_cat(out, cat):
    return [f for f in out.response["findings"] if f["category"] == cat]
