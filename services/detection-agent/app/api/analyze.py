from __future__ import annotations

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Request
from fastapi.responses import JSONResponse
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.database import get_db
from app.engines.settlement_engine import resolve_strategy
from app.schemas.input_schema import AnalyzeRequest
from app.schemas.output_schema import RecalculateRequest
from app.services import persistence_service as ps
from app.workers import analysis_worker as worker

router = APIRouter(prefix="/api/v1/analyze", tags=["analysis"])


def _job_or_404(db: Session, analysis_id: str):
    job = ps.get_job(db, analysis_id)
    if job is None:
        raise HTTPException(404, {"error": "ANALYSIS_NOT_FOUND", "analysis_id": analysis_id})
    return job


@router.post("", summary="Analyse a claim (structured JSON in, full analysis JSON out)")
async def analyze(payload: AnalyzeRequest, request: Request, background: BackgroundTasks, db: Session = Depends(get_db)):
    settings = get_settings()
    try:
        resolve_strategy(payload.options.settlement_strategy or payload.policy.settlement_strategy,
                         settings.default_settlement_strategy)
    except ValueError as exc:
        raise HTTPException(422, {"error": "INVALID_SETTLEMENT_STRATEGY", "message": str(exc)})
    raw = await request.json()
    analysis_id = ps.new_analysis_id()
    mode = settings.execution_mode
    job = ps.create_job(db, analysis_id, payload, raw, mode)
    if mode == "sync":
        worker.process_analysis(analysis_id)
        db.refresh(job)
        if job.status == "FAILED":
            return JSONResponse(status_code=500, content={"success": False, "analysis_id": analysis_id,
                                                          "status": "FAILED", "error": job.error})
        result = ps.overlay_result(db, job)
        return JSONResponse(status_code=422 if job.status == "VALIDATION_FAILED" else 200, content=result)
    if mode == "background":
        background.add_task(worker.process_analysis, analysis_id)
    elif mode == "celery":
        worker.analyze_claim.delay(analysis_id)
    else:
        raise HTTPException(500, f"Unknown execution mode '{mode}'")
    return JSONResponse(status_code=202, content={"success": True, "analysis_id": analysis_id, "status": "QUEUED",
                                                  "status_url": f"/api/v1/analyze/{analysis_id}/status",
                                                  "result_url": f"/api/v1/analyze/{analysis_id}/result"})


@router.get("/{analysis_id}/status")
def status(analysis_id: str, db: Session = Depends(get_db)):
    j = _job_or_404(db, analysis_id)
    return {"analysis_id": j.analysis_id, "status": j.status, "claim_id": j.claim_id, "result_version": j.result_version,
            "created_at": j.created_at, "started_at": j.started_at, "completed_at": j.completed_at, "error": j.error}


@router.get("/{analysis_id}/result")
def result(analysis_id: str, db: Session = Depends(get_db)):
    j = _job_or_404(db, analysis_id)
    if j.status in ("QUEUED", "PROCESSING"):
        return JSONResponse(status_code=202, content={"success": True, "analysis_id": analysis_id, "status": j.status})
    if j.status == "FAILED":
        return JSONResponse(status_code=500, content={"success": False, "analysis_id": analysis_id, "status": "FAILED", "error": j.error})
    return ps.overlay_result(db, j)


@router.get("/{analysis_id}/findings")
def findings(analysis_id: str, severity: str | None = None, category: str | None = None,
             review_status: str | None = None, db: Session = Depends(get_db)):
    _job_or_404(db, analysis_id)
    rows = ps.list_findings(db, analysis_id, severity, category, review_status)
    return {"analysis_id": analysis_id, "count": len(rows), "findings": [ps.finding_dict(r) for r in rows]}


@router.post("/{analysis_id}/recalculate")
def recalculate(analysis_id: str, body: RecalculateRequest, db: Session = Depends(get_db)):
    _job_or_404(db, analysis_id)
    try:
        res = worker.recalculate(analysis_id, body)
    except KeyError as exc:
        raise HTTPException(422, {"error": "INVALID_OVERRIDE", "message": str(exc.args[0])})
    except (RuntimeError, ValueError) as exc:
        raise HTTPException(409, {"error": "RECALCULATION_REJECTED", "message": str(exc)})
    return res
