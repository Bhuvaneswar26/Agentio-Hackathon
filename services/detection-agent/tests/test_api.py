import pytest
from fastapi.testclient import TestClient

from app.main import app
from tests.conftest import BASE
import copy


@pytest.fixture(scope="module")
def client():
    with TestClient(app) as c:
        yield c


def test_full_api_flow(client):
    r = client.post("/api/v1/analyze", json=copy.deepcopy(BASE))
    assert r.status_code == 200, r.text
    body = r.json()
    aid = body["analysis_id"]
    assert body["success"] and body["status"] == "COMPLETED"
    assert client.get(f"/api/v1/analyze/{aid}/status").json()["status"] == "COMPLETED"
    assert client.get(f"/api/v1/analyze/{aid}/result").json()["analysis_id"] == aid
    fl = client.get(f"/api/v1/analyze/{aid}/findings").json()["findings"]
    assert fl and client.get(f"/api/v1/analyze/{aid}/findings?severity=HIGH").json()["count"] >= 1

    exc = next(f for f in fl if f["category"] == "EXCLUDED_SERVICE")
    assert client.post(f"/api/v1/findings/{exc['finding_id']}/review", json={"action": "CORRECT"}).status_code == 422
    rv = client.post(f"/api/v1/findings/{exc['finding_id']}/review", json={"action": "DISMISS", "reviewer": "qa"})
    assert rv.json()["finding"]["review_status"] == "DISMISSED"
    res = client.get(f"/api/v1/analyze/{aid}/result").json()
    assert res["leakage_summary"]["calculated_leakage"] == 6000  # dismissed finding removed from totals

    rc = client.post(f"/api/v1/analyze/{aid}/recalculate", json={"item_overrides": {"ITEM-001": {"unit_price": 5000, "total_amount": 15000}}})
    assert rc.status_code == 200, rc.text
    assert rc.json()["meta"]["result_version"] == 2
    assert rc.json()["financial_summary"]["eligible_amount"] == 17000
    assert client.post(f"/api/v1/analyze/{aid}/recalculate", json={"item_overrides": {"NOPE": {}}}).status_code == 422

    d = client.get("/api/v1/dashboard/summary").json()
    assert d["total_analyses"] >= 1 and d["by_status"]["COMPLETED"] >= 1


def test_validation_errors_are_structured(client):
    bad = copy.deepcopy(BASE)
    del bad["claim"]["claim_id"]
    r = client.post("/api/v1/analyze", json=bad)
    assert r.status_code == 422 and r.json()["errors"][0]["field"].endswith("claim_id")
    mism = copy.deepcopy(BASE)
    mism["claim"]["policy_number"] = "POL-999"
    r = client.post("/api/v1/analyze", json=mism)
    assert r.status_code == 422 and r.json()["status"] == "VALIDATION_FAILED"


def test_unknown_ids_404(client):
    assert client.get("/api/v1/analyze/ANL-nope/status").status_code == 404
    assert client.post("/api/v1/findings/FND-x/review", json={"action": "CONFIRM"}).status_code == 404
