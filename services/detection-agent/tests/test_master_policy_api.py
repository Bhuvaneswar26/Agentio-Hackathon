"""HTTP contract for the database-backed master policy library."""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from tests.test_policy_api import DOC


@pytest.fixture(scope="module")
def client():
    with TestClient(create_app()) as c:
        yield c


def _extract(client, number):
    return client.post("/api/v1/policy/extract",
                       json={"document_text": DOC, "policy_number": number, "policy_type": "HEALTH"}).json()


def _save(client, source, number, **extra):
    return client.put("/api/v1/master-policies",
                      json={"source_name": source, "document_text": DOC,
                            "extraction": _extract(client, number), **extra})


def test_saved_policy_is_listed_and_readable_with_its_wording(client):
    saved = _save(client, "master-a.txt", "POL-M-A").json()
    assert saved["created"] is True
    pid = saved["policy"]["id"]
    assert saved["policy"]["policy_number"] == "POL-M-A"
    assert saved["policy"]["name"] == "POL-M-A"

    listed = client.get("/api/v1/master-policies").json()["policies"]
    entry = next(p for p in listed if p["id"] == pid)
    assert float(entry["extraction"]["policy"]["deductible"]) == 7500
    assert "document_text" not in entry  # the list stays light; the wording comes from the detail call

    detail = client.get(f"/api/v1/master-policies/{pid}").json()["policy"]
    assert detail["document_text"] == DOC


def test_saving_the_same_source_updates_instead_of_duplicating(client):
    first = _save(client, "master-b.txt", "POL-M-B1", name="Gold plan").json()
    second = _save(client, "master-b.txt", "POL-M-B2").json()
    assert second["created"] is False
    assert second["policy"]["id"] == first["policy"]["id"]
    assert second["policy"]["policy_number"] == "POL-M-B2"
    assert second["policy"]["name"] == "Gold plan"  # a rename survives a re-save without a new name
    same_source = [p for p in client.get("/api/v1/master-policies").json()["policies"]
                   if p["source_name"] == "master-b.txt"]
    assert len(same_source) == 1


def test_delete_removes_the_policy(client):
    pid = _save(client, "master-c.txt", "POL-M-C").json()["policy"]["id"]
    assert client.delete(f"/api/v1/master-policies/{pid}").status_code == 200
    assert client.get(f"/api/v1/master-policies/{pid}").status_code == 404
    assert client.delete(f"/api/v1/master-policies/{pid}").status_code == 404


def test_an_extraction_without_a_policy_number_is_rejected(client):
    r = client.put("/api/v1/master-policies",
                   json={"source_name": "bad.txt", "document_text": DOC, "extraction": {"policy": {}}})
    assert r.status_code == 422
    assert r.json()["detail"]["error"] == "INVALID_EXTRACTION"
