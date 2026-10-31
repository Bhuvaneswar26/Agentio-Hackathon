"""All database reads/writes. Keeps a full audit trail of analyses, reviews and recalculations."""
from __future__ import annotations

import uuid
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from typing import Any

from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session

from app.core.utils import parse_decimal
from app.engines.leakage_engine import FindingDraft, summarize
from app.models import database_models as M
from app.schemas.common import ReviewAction, ReviewStatus
from app.schemas.input_schema import AnalyzeRequest
from app.schemas.output_schema import ReviewRequest
from app.services.analysis_pipeline import PipelineOutput


def now() -> datetime:
    return datetime.now(timezone.utc)


def new_analysis_id() -> str:
    return "ANL-" + uuid.uuid4().hex[:12]


def audit(db: Session, entity_type: str, entity_id: str, action: str, actor: str | None = None,
          details: dict | None = None) -> None:
    db.add(M.AuditLog(entity_type=entity_type, entity_id=entity_id, action=action, actor=actor, details=details))


def create_job(db: Session, analysis_id: str, req: AnalyzeRequest, raw: dict, mode: str) -> M.AnalysisJob:
    job = M.AnalysisJob(analysis_id=analysis_id, status="QUEUED", claim_id=req.claim.claim_id,
                        policy_number=req.claim.policy_number, execution_mode=mode, request_json=raw)
    db.add(job)
    audit(db, "analysis", analysis_id, "ANALYSIS_SUBMITTED", details={"mode": mode})
    db.commit()
    return job


def get_job(db: Session, analysis_id: str) -> M.AnalysisJob | None:
    return db.get(M.AnalysisJob, analysis_id)


def mark_processing(db: Session, job: M.AnalysisJob) -> None:
    job.status, job.started_at, job.error = "PROCESSING", now(), None
    db.commit()


def mark_failed(db: Session, job: M.AnalysisJob, error: str) -> None:
    job.status, job.error, job.completed_at = "FAILED", error[:4000], now()
    audit(db, "analysis", job.analysis_id, "ANALYSIS_FAILED", details={"error": error[:500]})
    db.commit()


def review_state_for(db: Session, analysis_id: str) -> dict[str, dict[str, Any]]:
    rows = db.scalars(select(M.LeakageFinding).where(M.LeakageFinding.analysis_id == analysis_id,
                                                     M.LeakageFinding.review_status != "PENDING")).all()
    return {r.fingerprint: {"status": r.review_status,
                            "corrected_amount": r.leakage_amount if r.review_status == "CORRECTED" else None}
            for r in rows}


def _d(v: Any) -> Decimal | None:
    return parse_decimal(v)


def save_output(db: Session, job: M.AnalysisJob, req: AnalyzeRequest, out: PipelineOutput) -> None:
    aid = job.analysis_id
    for model in (M.Claim, M.Policy, M.InvoiceItemRow, M.SettlementRow, M.ModelPrediction, M.LeakageFinding):
        db.execute(delete(model).where(model.analysis_id == aid))
    c, p = req.claim, req.policy
    inv, inc = c.invoice, c.incident
    db.add(M.Claim(analysis_id=aid, claim_id=c.claim_id, policy_number=c.policy_number, claim_type=c.claim_type.value,
                   patient_id=c.claimant.patient_id if c.claimant else None,
                   provider_id=c.provider.provider_id if c.provider else None,
                   provider_name=c.provider.name if c.provider else None,
                   incident_date=inc.incident_date if inc else None, admission_date=inc.admission_date if inc else None,
                   discharge_date=inc.discharge_date if inc else None, invoice_id=inv.invoice_id if inv else None,
                   invoice_date=inv.invoice_date if inv else None, invoice_total=inv.total_amount if inv else None,
                   requested_amount=c.requested_amount, proposed_settlement=c.proposed_settlement,
                   currency=inv.currency if inv else None, raw_json=job.request_json))
    db.add(M.Policy(analysis_id=aid, policy_number=p.policy_number, policy_type=p.policy_type, valid_from=p.valid_from,
                    valid_until=p.valid_until, sum_insured=p.sum_insured, deductible=p.deductible,
                    copayment_percentage=p.copayment_percentage, raw_json=req.policy.model_dump(mode="json")))
    for it in out.items:
        m, r = it["mapping"], it["policy_result"]
        db.add(M.InvoiceItemRow(analysis_id=aid, item_id=it["item_id"], description=it["description"],
                                service_code=it["service_code"], quantity=_d(it["quantity"]), unit_price=_d(it["unit_price"]),
                                total_amount=_d(it["total_amount"]) or Decimal(0), mapped_category=m["category"],
                                mapping_method=m["method"], mapping_confidence=m["confidence"],
                                mapping_rationale=m["rationale"], allowed_amount=_d(r["allowed_amount"]),
                                policy_status=r["status"]))
    if out.settlement:
        s = out.settlement
        db.add(M.SettlementRow(analysis_id=aid, version=job.result_version, strategy=s["strategy"],
                               gross_invoice_amount=_d(s["gross_invoice_amount"]), eligible_amount=_d(s["eligible_amount"]),
                               excluded_amount=_d(s["excluded_amount"]), sublimit_adjustment=_d(s["sublimit_adjustment"]),
                               deductible=_d(s["deductible"]), copayment=_d(s["copayment"]),
                               expected_settlement=_d(s["expected_settlement"]), proposed_settlement=_d(s["proposed_settlement"]),
                               discrepancy=_d(s["discrepancy"]), calculation_json=s))
    for pr in out.predictions:
        db.add(M.ModelPrediction(analysis_id=aid, model_name=pr["model"], model_version=pr.get("version"),
                                 status=pr.get("status"), output=pr["output"]))
    for f in out.findings:
        db.add(M.LeakageFinding(
            finding_id=f["finding_id"], analysis_id=aid, fingerprint=f["fingerprint"], category=f["category"],
            severity=f["severity"], description=f["description"], item_id=f["item_id"],
            requested_amount=_d(f["requested_amount"]), allowed_amount=_d(f["allowed_amount"]),
            leakage_amount=_d(f["leakage_amount"]), amount_type=f["amount_type"], rule_id=f["rule_id"],
            policy_clause=f["policy_clause"], evidence=f["evidence"], included_in_totals=f["included_in_totals"],
            confidence=f["confidence"], review_status=f["review_status"]))
    resp = out.response
    job.status = out.status
    job.normalized_json = out.normalized or None
    job.result_json = resp
    job.rule_results = out.rule_results
    job.model_versions = out.model_versions
    job.risk_score = resp["risk_assessment"]["risk_score"]
    job.risk_level = resp["risk_assessment"]["risk_level"]
    job.calculated_leakage = _d(resp["leakage_summary"]["calculated_leakage"])
    job.completed_at = now()
    audit(db, "analysis", aid, "ANALYSIS_COMPLETED" if out.status == "COMPLETED" else "VALIDATION_FAILED",
          details={"risk_score": job.risk_score, "version": job.result_version,
                   "model_versions": out.model_versions})
    db.commit()


def finding_dict(r: M.LeakageFinding) -> dict[str, Any]:
    f = lambda v: float(v) if v is not None else None  # noqa: E731
    return {"finding_id": r.finding_id, "category": r.category, "severity": r.severity, "description": r.description,
            "item_id": r.item_id, "requested_amount": f(r.requested_amount), "allowed_amount": f(r.allowed_amount),
            "leakage_amount": f(r.leakage_amount), "amount_type": r.amount_type, "rule_id": r.rule_id,
            "policy_clause": r.policy_clause, "evidence": r.evidence, "review_status": r.review_status,
            "included_in_totals": r.included_in_totals, "confidence": r.confidence, "fingerprint": r.fingerprint,
            "reviewed_by": r.reviewed_by, "reviewed_at": r.reviewed_at.isoformat() if r.reviewed_at else None}


def list_findings(db: Session, analysis_id: str, severity: str | None = None, category: str | None = None,
                  review_status: str | None = None) -> list[M.LeakageFinding]:
    q = select(M.LeakageFinding).where(M.LeakageFinding.analysis_id == analysis_id).order_by(M.LeakageFinding.finding_id)
    if severity:
        q = q.where(M.LeakageFinding.severity == severity.upper())
    if category:
        q = q.where(M.LeakageFinding.category == category.upper())
    if review_status:
        q = q.where(M.LeakageFinding.review_status == review_status.upper())
    return list(db.scalars(q))


def overlay_result(db: Session, job: M.AnalysisJob) -> dict[str, Any]:
    """Result JSON with the latest reviewer decisions applied to findings and leakage totals."""
    result = dict(job.result_json or {})
    rows = {r.finding_id: r for r in list_findings(db, job.analysis_id)}
    if not rows or "findings" not in result:
        return result
    drafts = []
    findings = []
    for f in result["findings"]:
        r = rows.get(f["finding_id"])
        if r:
            f = {**f, "review_status": r.review_status, "leakage_amount": float(r.leakage_amount) if r.leakage_amount is not None else None,
                 "included_in_totals": r.included_in_totals and r.review_status != "DISMISSED"}
        findings.append(f)
        drafts.append(FindingDraft(f["category"], f["severity"], f["description"], f["rule_id"], f["amount_type"], "", "",
                                   leakage=_d(f["leakage_amount"]), included_in_totals=f["included_in_totals"],
                                   review_status=f["review_status"]))
    result["findings"] = findings
    result["leakage_summary"] = {**result["leakage_summary"], **{k: (float(v) if isinstance(v, Decimal) else v)
                                                                   for k, v in summarize(drafts).items()}}
    return result


def review_finding(db: Session, finding_id: str, body: ReviewRequest) -> M.LeakageFinding | None:
    r = db.get(M.LeakageFinding, finding_id)
    if r is None:
        return None
    status = {ReviewAction.CONFIRM: ReviewStatus.CONFIRMED, ReviewAction.DISMISS: ReviewStatus.DISMISSED,
              ReviewAction.REQUEST_EVIDENCE: ReviewStatus.EVIDENCE_REQUESTED,
              ReviewAction.CORRECT: ReviewStatus.CORRECTED}[body.action]
    before = {"review_status": r.review_status, "leakage_amount": float(r.leakage_amount) if r.leakage_amount is not None else None}
    r.review_status, r.reviewed_by, r.reviewed_at = status.value, body.reviewer, now()
    if body.action == ReviewAction.DISMISS:
        r.included_in_totals = False
    if body.action == ReviewAction.CORRECT:
        r.leakage_amount = body.corrected_amount
    db.add(M.Investigation(analysis_id=r.analysis_id, finding_id=finding_id, action=body.action.value,
                           reviewer=body.reviewer, notes=body.notes, corrected_amount=body.corrected_amount))
    audit(db, "finding", finding_id, f"REVIEW_{body.action.value}", body.reviewer,
          {"before": before, "notes": body.notes, "corrected_amount": float(body.corrected_amount) if body.corrected_amount is not None else None})
    db.commit()
    return r


def dashboard_summary(db: Session, days: int = 30) -> dict[str, Any]:
    jobs = M.AnalysisJob
    by_status = dict(db.execute(select(jobs.status, func.count()).group_by(jobs.status)).all())
    by_level = dict(db.execute(select(jobs.risk_level, func.count()).where(jobs.risk_level.is_not(None))
                               .group_by(jobs.risk_level)).all())
    avg_risk, total_leak = db.execute(select(func.avg(jobs.risk_score), func.coalesce(func.sum(jobs.calculated_leakage), 0))
                                      .where(jobs.status == "COMPLETED")).one()
    F = M.LeakageFinding
    by_cat = [{"category": c, "count": n, "leakage": float(l or 0)} for c, n, l in db.execute(
        select(F.category, func.count(), func.sum(F.leakage_amount)).where(F.included_in_totals.is_(True),
                                                                           F.review_status != "DISMISSED")
        .group_by(F.category).order_by(func.count().desc()))]
    by_review = dict(db.execute(select(F.review_status, func.count()).group_by(F.review_status)).all())
    by_sev = dict(db.execute(select(F.severity, func.count()).group_by(F.severity)).all())
    since = now() - timedelta(days=days)
    trend: dict[str, dict[str, float]] = defaultdict(lambda: {"analyses": 0, "calculated_leakage": 0.0})
    for created, leak in db.execute(select(jobs.created_at, jobs.calculated_leakage).where(jobs.created_at >= since)):
        k = created.date().isoformat()
        trend[k]["analyses"] += 1
        trend[k]["calculated_leakage"] += float(leak or 0)
    return {"total_analyses": sum(by_status.values()), "by_status": by_status, "risk_level_distribution": by_level,
            "average_risk_score": round(float(avg_risk), 2) if avg_risk is not None else None,
            "total_calculated_leakage": float(total_leak or 0), "findings_by_category": by_cat,
            "findings_by_severity": by_sev, "findings_by_review_status": by_review,
            "trend": [{"date": d, **v} for d, v in sorted(trend.items())], "window_days": days}
