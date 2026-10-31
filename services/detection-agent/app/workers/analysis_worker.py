"""Analysis execution (inline, background task or Celery worker) and recalculation."""
from __future__ import annotations

import logging
from typing import Any

from celery import Celery

from app.core.config import get_settings
from app.core.database import SessionLocal
from app.schemas.input_schema import AnalyzeRequest
from app.schemas.output_schema import RecalculateRequest
from app.services import persistence_service as ps
from app.services.analysis_pipeline import run_analysis

log = logging.getLogger(__name__)
settings = get_settings()
celery_app = Celery("claimsguard", broker=settings.redis_url, backend=settings.redis_url)
celery_app.conf.update(task_acks_late=True, worker_prefetch_multiplier=1, task_track_started=True)


def process_analysis(analysis_id: str) -> None:
    with SessionLocal() as db:
        job = ps.get_job(db, analysis_id)
        if job is None:
            log.error("analysis %s not found", analysis_id)
            return
        ps.mark_processing(db, job)
        try:
            req = AnalyzeRequest.model_validate(job.request_json)
            out = run_analysis(req, analysis_id, settings=settings, result_version=job.result_version)
            ps.save_output(db, job, req, out)
        except Exception as exc:
            log.exception("analysis %s failed", analysis_id)
            db.rollback()
            ps.mark_failed(db, job, f"{type(exc).__name__}: {exc}")


@celery_app.task(name="claimsguard.analyze_claim", bind=True, max_retries=2, default_retry_delay=5)
def analyze_claim(self, analysis_id: str) -> None:  # pragma: no cover - requires broker
    process_analysis(analysis_id)


def apply_overrides(base: dict[str, Any], body: RecalculateRequest) -> AnalyzeRequest:
    data = AnalyzeRequest.model_validate(base).model_dump(mode="json")
    items = {i["item_id"]: i for i in (data["claim"].get("invoice") or {}).get("items", [])}
    allowed = {"quantity", "unit_price", "total_amount", "service_code", "description", "service_date"}
    for item_id, patch in body.item_overrides.items():
        if item_id not in items:
            raise KeyError(f"Unknown item_id '{item_id}'")
        bad = set(patch) - allowed
        if bad:
            raise KeyError(f"Fields not overridable on items: {sorted(bad)}")
        items[item_id].update(patch)
    allowed_p = {"deductible", "copayment_percentage", "sum_insured", "valid_from", "valid_until", "inception_date",
                 "coverage", "exclusions", "sublimits", "waiting_periods", "settlement_strategy"}
    bad = set(body.policy_overrides) - allowed_p
    if bad:
        raise KeyError(f"Fields not overridable on policy: {sorted(bad)}")
    data["policy"].update(body.policy_overrides)
    if body.proposed_settlement is not None:
        data["claim"]["proposed_settlement"] = float(body.proposed_settlement)
    if body.settlement_strategy is not None:
        data.setdefault("options", {})["settlement_strategy"] = body.settlement_strategy
    return AnalyzeRequest.model_validate(data)


def recalculate(analysis_id: str, body: RecalculateRequest) -> dict[str, Any] | None:
    with SessionLocal() as db:
        job = ps.get_job(db, analysis_id)
        if job is None:
            return None
        if job.status not in ("COMPLETED", "VALIDATION_FAILED") or not (job.normalized_json or job.request_json):
            raise RuntimeError(f"Analysis is {job.status}; recalculation requires a finished analysis")
        before = {"expected_settlement": (job.result_json or {}).get("financial_summary", {}).get("expected_settlement"),
                  "risk_score": job.risk_score}
        state = ps.review_state_for(db, analysis_id) if body.apply_review_decisions else {}
        req = apply_overrides(job.normalized_json or job.request_json, body)
        job.result_version += 1
        out = run_analysis(req, analysis_id, settings=settings, review_state=state, result_version=job.result_version)
        ps.save_output(db, job, req, out)
        ps.audit(db, "analysis", analysis_id, "RECALCULATED", body.reviewer,
                 {"before": before, "after": {"expected_settlement": out.response["financial_summary"].get("expected_settlement"),
                                              "risk_score": job.risk_score},
                  "overrides": body.model_dump(mode="json", exclude={"reviewer"})})
        db.commit()
        return ps.overlay_result(db, job)
