"""Orchestrates: VALIDATION -> NORMALIZATION -> POLICY MAPPING -> RULES -> DUPLICATES -> ML -> SETTLEMENT ->
FINDINGS/LEAKAGE -> RISK -> EXPLAINABILITY -> response. Persistence happens outside (persistence_service)."""
from __future__ import annotations

import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any

from app.core.config import Settings, get_settings
from app.core.utils import jsonable
from app.engines.anomaly_engine import AnomalyEngine
from app.engines.duplicate_engine import DuplicateEngine
from app.engines.leakage_engine import FindingDraft, LeakageEngine, apply_review_state, summarize
from app.engines.policy_engine import PolicyEngine
from app.engines.related_party_engine import RelatedPartyEngine
from app.engines.risk_engine import RiskEngine
from app.engines.settlement_engine import SettlementEngine
from app.ml.inference import ModelRegistry, get_registry, run_models
from app.schemas.input_schema import AnalyzeRequest
from app.schemas.output_schema import AnalysisResponse, FinancialSummary, LeakageSummary, RiskAssessment
from app.services.normalization_service import normalize
from app.services.policy_mapping_service import PolicyMapper
from app.services.validation_service import validate_request


@dataclass
class PipelineOutput:
    status: str
    response: dict[str, Any]
    normalized: dict[str, Any] = field(default_factory=dict)
    rule_results: list[dict[str, Any]] = field(default_factory=list)
    predictions: list[dict[str, Any]] = field(default_factory=list)
    settlement: dict[str, Any] = field(default_factory=dict)
    findings: list[dict[str, Any]] = field(default_factory=list)
    items: list[dict[str, Any]] = field(default_factory=list)
    model_versions: dict[str, Any] = field(default_factory=dict)


def _recommendation(risk: dict, summary: dict, findings: list[FindingDraft], st) -> dict[str, Any]:
    live = [f for f in findings if f.review_status != "DISMISSED"]
    reasons = [f"{f.rule_id}: {f.description}" for f in live if f.severity in ("HIGH", "CRITICAL")][:8]
    critical_dup = any(f.category in ("DUPLICATE_INVOICE",) for f in live)
    if critical_dup or risk["risk_level"] == "CRITICAL":
        action, priority = "ESCALATE_FOR_INVESTIGATION", "URGENT"
    elif risk["risk_level"] == "HIGH":
        action, priority = "MANUAL_REVIEW", "HIGH"
    elif summary["calculated_leakage"] > 0:
        action, priority = "ADJUST_SETTLEMENT", "NORMAL"
    elif summary["missing_information"] or any(f.amount_type != "CALCULATED" for f in live):
        action, priority = "REQUEST_ADDITIONAL_INFORMATION", "NORMAL"
    else:
        action, priority = "PROCEED_TO_SETTLEMENT", "LOW"
    steps = []
    if summary["calculated_leakage"] > 0:
        steps.append(f"Reduce payable amount; expected settlement per policy is {st.expected_settlement}")
    if summary["suspicious_patterns"]:
        steps.append("Review suspicious-pattern findings (ESTIMATED/UNQUANTIFIED) before confirming leakage")
    if summary["missing_information"]:
        steps.append("Request the missing policy/claim information listed in the findings")
    return {"action": action, "priority": priority, "reasons": reasons, "next_steps": steps,
            "basis": "Deterministic mapping from risk level, findings and calculated amounts; no generative text"}


def run_analysis(request: AnalyzeRequest, analysis_id: str, *, settings: Settings | None = None,
                 registry: ModelRegistry | None = None, review_state: dict[str, dict[str, Any]] | None = None,
                 result_version: int = 1) -> PipelineOutput:
    settings = settings or get_settings()
    started = time.perf_counter()
    timings: dict[str, float] = {}

    def tick(name: str, t0: float) -> None:
        timings[name] = round((time.perf_counter() - t0) * 1000, 2)

    t = time.perf_counter()
    validation = validate_request(request, settings)
    tick("validation", t)
    meta = {"processed_at": datetime.now(timezone.utc).isoformat(), "result_version": result_version}

    if validation.blocking:
        resp = AnalysisResponse(
            success=False, analysis_id=analysis_id, status="VALIDATION_FAILED",
            claim=jsonable(request.claim.model_dump(mode="python")),
            risk_assessment=RiskAssessment(assessment_status="NOT_ASSESSED"),
            validation=validation.to_dict(),
            recommendation={"action": "CORRECT_INPUT", "priority": "NORMAL",
                            "reasons": [e.message for e in validation.errors if e.blocking], "next_steps": [
                                "Correct the blocking validation errors and resubmit"]},
            meta={**meta, "timings_ms": timings})
        return PipelineOutput("VALIDATION_FAILED", resp.model_dump(mode="json"))

    t = time.perf_counter()
    ctx, normalized_req = normalize(request, settings)
    tick("normalization", t)

    t = time.perf_counter()
    mapper = PolicyMapper(ctx.request.policy, settings)
    mappings = [mapper.map_item(i) for i in ctx.items]
    tick("policy_mapping", t)

    t = time.perf_counter()
    pol = PolicyEngine(settings).evaluate(ctx, mappings)
    tick("policy_rules", t)

    t = time.perf_counter()
    dup = DuplicateEngine(settings).analyze(ctx)
    tick("duplicate_detection", t)

    t = time.perf_counter()
    related = RelatedPartyEngine(settings).analyze(ctx)
    tick("related_party", t)

    registry = registry or get_registry(str(settings.model_dir))
    t = time.perf_counter()
    anomalies = AnomalyEngine(settings, registry.benchmarks).analyze(ctx, mappings)
    # Related-party signals become findings through the same path as billing anomalies, but keep
    # their own risk component so a shared identifier never inflates the billing-anomaly score.
    anomalies.anomalies.extend(related.anomalies)
    anomalies.insufficient_evidence.extend(related.insufficient_evidence)
    ml = run_models(ctx, registry, settings)
    tick("anomaly_and_ml", t)

    t = time.perf_counter()
    st = SettlementEngine(settings).calculate(ctx, pol, dup)
    tick("settlement", t)

    t = time.perf_counter()
    drafts = LeakageEngine(settings).build(ctx, validation, mappings, pol, st, dup, anomalies, ml)
    if review_state:
        apply_review_state(drafts, review_state)
    risk = RiskEngine(settings).score(drafts, ml)
    summary = summarize(drafts)
    tick("findings_and_risk", t)

    suffix = analysis_id.split("-", 1)[-1]
    findings = [d.to_model(f"FND-{suffix}-{n:03d}") for n, d in enumerate(drafts, 1)]
    rec = _recommendation(risk, summary, drafts, st)

    item_rows = []
    pr = {r.item_id: r for r in pol.items}
    for it, m in zip(ctx.items, mappings):
        r = pr[it.item_id]
        item_rows.append({
            "item_id": it.item_id, "description": it.description, "service_code": it.service_code,
            "quantity": it.quantity, "unit_price": it.unit_price, "total_amount": it.total, "billable_amount": it.billable,
            "mapping": {"category": m.category, "method": m.method, "confidence": m.confidence, "rationale": m.rationale,
                        "coverage_status": m.status, "status_reason": m.status_reason},
            "policy_result": {"status": r.status, "allowed_amount": r.allowed, "excluded_amount": r.excluded_amount,
                              "limit_excess": r.limit_excess, "rule_id": r.rule_id, "clause_reference": r.clause,
                              "policy_reference": r.policy_reference, "notes": r.notes}})

    policy = ctx.request.policy
    policy_validation = jsonable({
        "policy_active": pol.policy_active, "activity_reason": pol.activity_reason, "date_evaluated": pol.evaluated_date,
        "policy_period": {"valid_from": policy.valid_from, "valid_until": policy.valid_until},
        "stay_days": ctx.stay_days, "items": item_rows, "waiting_period_checks": pol.waiting_checks,
        "insufficient_evidence": pol.insufficient, "unknown_coverage_items": pol.unknown_items,
        "sum_insured": {"sum_insured": policy.sum_insured, "previously_used": st.previously_used_sum_insured,
                        "remaining": st.remaining_sum_insured},
        "totals": {"eligible": pol.eligible, "excluded": pol.excluded, "sublimit_adjustment": pol.sublimit_adjustment}})

    fin = FinancialSummary(
        requested_amount=ctx.requested if ctx.requested is not None else ctx.claim_amount,
        gross_invoice_amount=st.gross_invoice_amount, eligible_amount=st.eligible_amount,
        excluded_amount=st.excluded_amount, sublimit_adjustment=st.sublimit_adjustment, deductible=st.deductible_applied,
        copayment=st.copayment, sum_insured_reduction=st.sum_insured_reduction, duplicate_deduction=st.duplicate_deduction,
        expected_settlement=st.expected_settlement,
        proposed_settlement=st.proposed_settlement, calculated_discrepancy=st.discrepancy, currency=ctx.currency,
        settlement_strategy=st.strategy, calculation_steps=jsonable(st.steps))

    model_insights = {**ml, "catboost_explainability_method": (ml.get("catboost", {}).get("explanation") or {}).get("method")}
    tick("total", started)

    resp = AnalysisResponse(
        success=True, analysis_id=analysis_id, status="COMPLETED",
        claim=jsonable(normalized_req.claim.model_dump(mode="python")),
        risk_assessment=RiskAssessment(**risk), financial_summary=fin, leakage_summary=LeakageSummary(**summary),
        policy_validation=policy_validation, duplicate_analysis=dup.to_dict(), anomaly_analysis=anomalies.to_dict(),
        related_party_analysis=related.to_dict(),
        findings=findings, model_insights=model_insights, validation=validation.to_dict(), recommendation=rec,
        meta={**meta, "timings_ms": timings, "model_versions": registry.versions()})

    rule_results = [{"engine": "policy", "policy_active": pol.policy_active, "items": item_rows},
                    {"engine": "duplicate", **dup.to_dict()}, {"engine": "anomaly", **anomalies.to_dict()},
                    {"engine": "related_party", **related.to_dict()},
                    {"engine": "risk", **risk}]
    predictions = [{"model": k, "status": v.get("status"), "version": v.get("version"), "output": v}
                   for k, v in ml.items() if k in ("catboost", "isolation_forest", "provider_benchmark")]
    return PipelineOutput(
        "COMPLETED", resp.model_dump(mode="json"), jsonable(normalized_req.model_dump(mode="python")),
        jsonable(rule_results), jsonable(predictions),
        jsonable({"strategy": st.strategy, "gross_invoice_amount": st.gross_invoice_amount,
                  "eligible_amount": st.eligible_amount, "excluded_amount": st.excluded_amount,
                  "sublimit_adjustment": st.sublimit_adjustment, "deductible": st.deductible_applied,
                  "copayment": st.copayment, "sum_insured_reduction": st.sum_insured_reduction,
                  "duplicate_deduction": st.duplicate_deduction, "expected_settlement": st.expected_settlement, "proposed_settlement": st.proposed_settlement,
                  "discrepancy": st.discrepancy, "steps": st.steps}),
        [f.model_dump(mode="json") for f in findings], jsonable(item_rows), registry.versions())
