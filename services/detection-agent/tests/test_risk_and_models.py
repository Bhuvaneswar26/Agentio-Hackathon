import json

import numpy as np
import pandas as pd
import pytest

from app.core.config import get_settings
from app.engines.risk_engine import RiskEngine
from app.ml.inference import ModelRegistry
from app.schemas.input_schema import AnalyzeRequest
from app.services.analysis_pipeline import run_analysis
from tests.conftest import cats


def test_ml_unavailable_degrades_gracefully(analyze, payload):
    r = analyze(payload).response
    assert r["model_insights"]["catboost"]["status"] == "UNAVAILABLE"
    assert r["model_insights"]["isolation_forest"]["status"] == "UNAVAILABLE"
    assert r["risk_assessment"]["risk_score"] is not None
    assert "ML_RISK_SIGNAL" not in cats(analyze(payload))


def test_risk_levels_and_noisy_or():
    e = RiskEngine(get_settings())
    assert [e.level(s) for s in (0, 29, 30, 59, 60, 79, 80, 100)] == ["LOW", "LOW", "MEDIUM", "MEDIUM", "HIGH", "HIGH", "CRITICAL", "CRITICAL"]


def test_risk_increases_with_findings_and_is_bounded(analyze, payload):
    import copy
    c = copy.deepcopy(payload)
    c["claim"]["invoice"]["items"] = [{"item_id": "D", "description": "Diagnostic Test", "service_code": "DIAG-001", "quantity": 1, "unit_price": 2000, "total_amount": 2000}]
    c["claim"]["invoice"]["total_amount"] = c["claim"]["requested_amount"] = 2000
    low = analyze(c).response["risk_assessment"]["risk_score"]
    high = analyze(payload).response["risk_assessment"]["risk_score"]
    assert 0 <= low < high <= 100


def test_same_issue_counted_once_in_risk(analyze, payload):
    r = analyze(payload).response["risk_assessment"]["components"]["policy_violations"]
    # 2 line-level policy issues -> 2 distinct issues, not one per rule/engine
    assert r["distinct_issues"] == 2


def test_response_json_serialisable_numbers(analyze, payload):
    out = analyze(payload)
    s = json.dumps(out.response)
    assert isinstance(out.response["financial_summary"]["expected_settlement"], float) or isinstance(out.response["financial_summary"]["expected_settlement"], int)
    assert '"leakage_chance": null' in s


def test_ml_training_and_inference_roundtrip(tmp_path, payload):
    pytest.importorskip("catboost")
    from app.ml import train_catboost, train_isolation_forest, train_provider_model  # noqa: F401

    rng = np.random.default_rng(0)
    n = 4000
    amount = rng.lognormal(8, 0.6, n)
    fraud = (rng.random(n) < 0.08).astype(int)
    amount = np.where(fraud == 1, amount * 3, amount)
    df = pd.DataFrame({
        "claim_id": range(n), "claim_amount": amount, "deductible": rng.choice([500, 1000, 2000], n),
        "policyholder_tenure": rng.integers(1, 120, n), "previous_claims_count": rng.poisson(1, n) + fraud,
        "claim_type": rng.choice(["HEALTH", "AUTO"], n), "claim_status": rng.choice(["PAID", "DENIED"], n),
        "incident_date": pd.date_range("2024-01-01", periods=n, freq="h").astype(str),
        "is_fraud_flagged_ground_truth": fraud})
    src = tmp_path / "claims.csv"
    df.to_csv(src, index=False)
    out_dir, rep = tmp_path / "models", tmp_path / "reports"
    meta = train_catboost.train(str(src), out_dir, rep, max_rows=n, iterations=60)
    assert "claim_status" not in meta["features"] and meta["split"] == "temporal"
    assert (rep / "schema_report.json").exists()
    train_isolation_forest.train(str(src), out_dir, rep, max_rows=n)

    reg = ModelRegistry(out_dir)
    assert reg.status["catboost"]["status"] == "AVAILABLE" and reg.status["isolation_forest"]["status"] == "AVAILABLE"
    payload["claim"]["claimant"]["policyholder_tenure"] = 24
    res = run_analysis(AnalyzeRequest.model_validate(payload), "ANL-ml000001", settings=get_settings(), registry=reg).response
    cb, iso = res["model_insights"]["catboost"], res["model_insights"]["isolation_forest"]
    assert cb["status"] == "AVAILABLE" and 0 <= cb["suspicion_score"] <= 1
    assert cb["explanation"]["top_contributors"] and res["risk_assessment"]["leakage_chance"] is None
    assert iso["status"] in ("AVAILABLE", "INSUFFICIENT_FEATURES")
