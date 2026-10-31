"""Master policy library: policy documents stored in the database so a claim can be assessed against any of them."""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.policy import MAX_DOCUMENT_CHARS
from app.core.database import get_db
from app.models.database_models import AuditLog, MasterPolicyRow

router = APIRouter(prefix="/api/v1/master-policies", tags=["master-policy"])


class MasterPolicySave(BaseModel):
    source_name: str = Field(min_length=1, max_length=255, description="File name (or label) the wording came from")
    name: str | None = Field(default=None, max_length=200)
    document_text: str = Field(min_length=1, max_length=MAX_DOCUMENT_CHARS)
    extraction: dict[str, Any] = Field(description="The response body of POST /api/v1/policy/extract")


def _summary(row: MasterPolicyRow) -> dict:
    return {
        "id": row.id,
        "name": row.name,
        "source_name": row.source_name,
        "policy_number": row.policy_number,
        "policy_type": row.policy_type,
        "extraction": row.extraction_json,
        "created_at": row.created_at.isoformat(),
        "updated_at": row.updated_at.isoformat(),
    }


def _audit(db: Session, row_id: str, action: str, details: dict) -> None:
    db.add(AuditLog(entity_type="MASTER_POLICY", entity_id=row_id, action=action, details=details))


@router.get("", summary="List the policies in the master library, newest first")
def list_master_policies(db: Session = Depends(get_db)):
    rows = db.scalars(select(MasterPolicyRow).order_by(MasterPolicyRow.updated_at.desc())).all()
    return {"success": True, "policies": [_summary(r) for r in rows]}


@router.get("/{policy_id}", summary="One master policy, including the full policy wording")
def get_master_policy(policy_id: str, db: Session = Depends(get_db)):
    row = db.get(MasterPolicyRow, policy_id)
    if row is None:
        raise HTTPException(404, {"error": "MASTER_POLICY_NOT_FOUND", "id": policy_id})
    return {"success": True, "policy": {**_summary(row), "document_text": row.document_text}}


@router.put("", summary="Add a policy to the master library; the same source name updates its entry")
def save_master_policy(body: MasterPolicySave, db: Session = Depends(get_db)):
    policy = body.extraction.get("policy")
    number = policy.get("policy_number") if isinstance(policy, dict) else None
    if not isinstance(number, str) or not number.strip():
        raise HTTPException(422, {"error": "INVALID_EXTRACTION",
                                  "message": "extraction.policy.policy_number is required. Send the "
                                             "response of /api/v1/policy/extract unchanged."})
    policy_type = policy.get("policy_type")
    row = db.scalar(select(MasterPolicyRow).where(MasterPolicyRow.source_name == body.source_name))
    created = row is None
    if row is None:
        row = MasterPolicyRow(source_name=body.source_name, name=body.name or number)
        db.add(row)
    elif body.name:
        row.name = body.name
    row.policy_number = number.strip()
    row.policy_type = policy_type[:16] if isinstance(policy_type, str) else None
    row.document_text = body.document_text
    row.extraction_json = body.extraction
    db.flush()
    _audit(db, row.id, "CREATED" if created else "UPDATED",
           {"name": row.name, "source_name": row.source_name, "policy_number": row.policy_number})
    db.commit()
    db.refresh(row)
    return {"success": True, "created": created, "policy": _summary(row)}


@router.delete("/{policy_id}", summary="Remove a policy from the master library")
def delete_master_policy(policy_id: str, db: Session = Depends(get_db)):
    row = db.get(MasterPolicyRow, policy_id)
    if row is None:
        raise HTTPException(404, {"error": "MASTER_POLICY_NOT_FOUND", "id": policy_id})
    _audit(db, row.id, "DELETED", {"name": row.name, "source_name": row.source_name})
    db.delete(row)
    db.commit()
    return {"success": True, "id": policy_id}
