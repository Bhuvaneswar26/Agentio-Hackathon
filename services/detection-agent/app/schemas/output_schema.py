from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field

from app.schemas.common import AmountType, Money, ReviewAction, ReviewStatus, Severity


class Finding(BaseModel):
    finding_id: str
    category: str
    severity: Severity
    description: str
    item_id: str | None = None
    requested_amount: Money | None = None
    allowed_amount: Money | None = None
    leakage_amount: Money | None = None
    amount_type: AmountType
    rule_id: str
    policy_clause: str | None = None
    evidence: list[dict[str, Any]] = Field(default_factory=list)
    review_status: ReviewStatus = ReviewStatus.PENDING
    included_in_totals: bool = True
    confidence: float | None = None
    fingerprint: str | None = None


class RiskAssessment(BaseModel):
    risk_score: int | None = None
    risk_level: str | None = None
    leakage_chance: float | None = None
    assessment_status: str = "RULE_BASED"
    components: dict[str, Any] = Field(default_factory=dict)


class FinancialSummary(BaseModel):
    requested_amount: Money | None = None
    gross_invoice_amount: Money | None = None
    eligible_amount: Money | None = None
    excluded_amount: Money | None = None
    sublimit_adjustment: Money | None = None
    deductible: Money | None = None
    copayment: Money | None = None
    sum_insured_reduction: Money | None = None
    expected_settlement: Money | None = None
    proposed_settlement: Money | None = None
    calculated_discrepancy: Money | None = None
    currency: str | None = None
    settlement_strategy: str | None = None
    calculation_steps: list[dict[str, Any]] = Field(default_factory=list)


class LeakageSummary(BaseModel):
    total_findings: int = 0
    confirmed_rule_violations: int = 0
    suspicious_patterns: int = 0
    missing_information: int = 0
    calculated_leakage: Money = 0
    estimated_leakage: Money | None = None
    unquantified_findings: int = 0


class AnalysisResponse(BaseModel):
    success: bool = True
    analysis_id: str
    status: str
    claim: dict[str, Any] = Field(default_factory=dict)
    risk_assessment: RiskAssessment = Field(default_factory=RiskAssessment)
    financial_summary: FinancialSummary = Field(default_factory=FinancialSummary)
    leakage_summary: LeakageSummary = Field(default_factory=LeakageSummary)
    policy_validation: dict[str, Any] = Field(default_factory=dict)
    duplicate_analysis: dict[str, Any] = Field(default_factory=dict)
    anomaly_analysis: dict[str, Any] = Field(default_factory=dict)
    findings: list[Finding] = Field(default_factory=list)
    model_insights: dict[str, Any] = Field(default_factory=dict)
    validation: dict[str, Any] = Field(default_factory=dict)
    recommendation: dict[str, Any] = Field(default_factory=dict)
    meta: dict[str, Any] = Field(default_factory=dict)


class ReviewRequest(BaseModel):
    action: ReviewAction
    reviewer: str | None = None
    notes: str | None = None
    corrected_amount: Money | None = None


class RecalculateRequest(BaseModel):
    item_overrides: dict[str, dict[str, Any]] = Field(default_factory=dict)
    policy_overrides: dict[str, Any] = Field(default_factory=dict)
    proposed_settlement: Money | None = None
    settlement_strategy: str | list[str] | None = None
    apply_review_decisions: bool = True
    reviewer: str | None = None
