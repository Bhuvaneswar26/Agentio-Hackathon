from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.schemas.common import ReviewAction
from app.schemas.output_schema import ReviewRequest
from app.services import persistence_service as ps

router = APIRouter(prefix="/api/v1/findings", tags=["findings"])


@router.post("/{finding_id}/review")
def review(finding_id: str, body: ReviewRequest, db: Session = Depends(get_db)):
    if body.action == ReviewAction.CORRECT and body.corrected_amount is None:
        raise HTTPException(422, {"error": "CORRECTED_AMOUNT_REQUIRED",
                                  "message": "corrected_amount is required for action CORRECT"})
    row = ps.review_finding(db, finding_id, body)
    if row is None:
        raise HTTPException(404, {"error": "FINDING_NOT_FOUND", "finding_id": finding_id})
    return {"success": True, "finding": ps.finding_dict(row),
            "hint": f"POST /api/v1/analyze/{row.analysis_id}/recalculate to refresh totals using review decisions"}
