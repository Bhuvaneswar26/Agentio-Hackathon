"""Dashboard-facing endpoint: accepts the frontend's DetectionPayload and returns a dashboard-ready Claim + full analysis."""
from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.core.utils import jsonable
from app.schemas.frontend_schema import DetectionPayloadIn
from app.services import persistence_service as ps
from app.services.frontend_adapter import to_analyze_request, to_frontend_claim
from app.workers import analysis_worker as worker

router = APIRouter(tags=["dashboard-integration"])


@router.post("/v1/detect", summary="Analyse a dashboard DetectionPayload (schemaVersion 1.0)")
@router.post("/api/v1/detect", include_in_schema=False)
def detect(payload: DetectionPayloadIn, db: Session = Depends(get_db)):
    analysis_id = ps.new_analysis_id()
    req, missing, notes = to_analyze_request(payload)
    if req is None:  # nothing to analyse: report as unassessed rather than inventing leakage
        return {"success": True, "analysis_id": analysis_id, "status": "UNASSESSED", "adapter_notes": notes,
                "claim": to_frontend_claim(payload, None, missing, notes, analysis_id), "analysis": None}
    raw = {**req.model_dump(mode="json"), "frontend_payload": payload.model_dump(mode="json")}
    job = ps.create_job(db, analysis_id, req, raw, "sync")
    worker.process_analysis(analysis_id)
    db.refresh(job)
    if job.status == "FAILED":
        return {"success": False, "analysis_id": analysis_id, "status": "FAILED", "error": job.error}
    analysis = ps.overlay_result(db, job)
    return jsonable({"success": job.status == "COMPLETED", "analysis_id": analysis_id, "status": job.status,
                     "adapter_notes": notes, "claim": to_frontend_claim(payload, analysis, missing, notes, analysis_id),
                     "analysis": analysis})
