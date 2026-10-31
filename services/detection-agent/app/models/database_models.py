from __future__ import annotations

import uuid
from datetime import date, datetime, timezone
from decimal import Decimal

from sqlalchemy import JSON, Boolean, Date, DateTime, ForeignKey, Integer, Numeric, String, Text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base

JsonType = JSON().with_variant(JSONB(), "postgresql")


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _uuid() -> str:
    return uuid.uuid4().hex


class AnalysisJob(Base):
    __tablename__ = "analysis_jobs"
    analysis_id: Mapped[str] = mapped_column(String(40), primary_key=True)
    status: Mapped[str] = mapped_column(String(24), index=True)
    claim_id: Mapped[str] = mapped_column(String(100), index=True)
    policy_number: Mapped[str] = mapped_column(String(100), index=True)
    execution_mode: Mapped[str] = mapped_column(String(16))
    request_json: Mapped[dict] = mapped_column(JsonType)          # original incoming JSON
    normalized_json: Mapped[dict | None] = mapped_column(JsonType, nullable=True)
    result_json: Mapped[dict | None] = mapped_column(JsonType, nullable=True)
    rule_results: Mapped[list | None] = mapped_column(JsonType, nullable=True)
    model_versions: Mapped[dict | None] = mapped_column(JsonType, nullable=True)
    risk_score: Mapped[int | None] = mapped_column(Integer, nullable=True)
    risk_level: Mapped[str | None] = mapped_column(String(12), nullable=True, index=True)
    calculated_leakage: Mapped[Decimal | None] = mapped_column(Numeric(18, 2), nullable=True)
    result_version: Mapped[int] = mapped_column(Integer, default=1)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class Claim(Base):
    __tablename__ = "claims"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_uuid)
    analysis_id: Mapped[str] = mapped_column(ForeignKey("analysis_jobs.analysis_id"), index=True)
    claim_id: Mapped[str] = mapped_column(String(100), index=True)
    policy_number: Mapped[str] = mapped_column(String(100), index=True)
    claim_type: Mapped[str] = mapped_column(String(16))
    patient_id: Mapped[str | None] = mapped_column(String(100), nullable=True, index=True)
    provider_id: Mapped[str | None] = mapped_column(String(100), nullable=True, index=True)
    provider_name: Mapped[str | None] = mapped_column(String(200), nullable=True)
    incident_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    admission_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    discharge_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    invoice_id: Mapped[str | None] = mapped_column(String(100), nullable=True, index=True)
    invoice_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    invoice_total: Mapped[Decimal | None] = mapped_column(Numeric(18, 2), nullable=True)
    requested_amount: Mapped[Decimal | None] = mapped_column(Numeric(18, 2), nullable=True)
    proposed_settlement: Mapped[Decimal | None] = mapped_column(Numeric(18, 2), nullable=True)
    currency: Mapped[str | None] = mapped_column(String(8), nullable=True)
    raw_json: Mapped[dict] = mapped_column(JsonType)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)


class Policy(Base):
    __tablename__ = "policies"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_uuid)
    analysis_id: Mapped[str] = mapped_column(ForeignKey("analysis_jobs.analysis_id"), index=True)
    policy_number: Mapped[str] = mapped_column(String(100), index=True)
    policy_type: Mapped[str | None] = mapped_column(String(16), nullable=True)
    valid_from: Mapped[date | None] = mapped_column(Date, nullable=True)
    valid_until: Mapped[date | None] = mapped_column(Date, nullable=True)
    sum_insured: Mapped[Decimal | None] = mapped_column(Numeric(18, 2), nullable=True)
    deductible: Mapped[Decimal | None] = mapped_column(Numeric(18, 2), nullable=True)
    copayment_percentage: Mapped[Decimal | None] = mapped_column(Numeric(6, 2), nullable=True)
    raw_json: Mapped[dict] = mapped_column(JsonType)


class MasterPolicyRow(Base):
    """A policy document kept in the master library: its wording plus the terms read from it.

    Unlike `policies` (a snapshot taken per analysis), this is the reusable source a claim is assessed against.
    """
    __tablename__ = "master_policies"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_uuid)
    name: Mapped[str] = mapped_column(String(200))
    source_name: Mapped[str] = mapped_column(String(255), unique=True, index=True)
    policy_number: Mapped[str] = mapped_column(String(100), index=True)
    policy_type: Mapped[str | None] = mapped_column(String(16), nullable=True)
    document_text: Mapped[str] = mapped_column(Text)
    extraction_json: Mapped[dict] = mapped_column(JsonType)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now, onupdate=_now)


class InvoiceItemRow(Base):
    __tablename__ = "invoice_items"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_uuid)
    analysis_id: Mapped[str] = mapped_column(ForeignKey("analysis_jobs.analysis_id"), index=True)
    item_id: Mapped[str] = mapped_column(String(100))
    description: Mapped[str] = mapped_column(Text)
    service_code: Mapped[str | None] = mapped_column(String(64), nullable=True)
    quantity: Mapped[Decimal | None] = mapped_column(Numeric(18, 4), nullable=True)
    unit_price: Mapped[Decimal | None] = mapped_column(Numeric(18, 2), nullable=True)
    total_amount: Mapped[Decimal] = mapped_column(Numeric(18, 2))
    mapped_category: Mapped[str | None] = mapped_column(String(64), nullable=True)
    mapping_method: Mapped[str | None] = mapped_column(String(24), nullable=True)
    mapping_confidence: Mapped[float | None] = mapped_column(nullable=True)
    mapping_rationale: Mapped[str | None] = mapped_column(Text, nullable=True)
    allowed_amount: Mapped[Decimal | None] = mapped_column(Numeric(18, 2), nullable=True)
    policy_status: Mapped[str | None] = mapped_column(String(24), nullable=True)


class SettlementRow(Base):
    __tablename__ = "settlements"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_uuid)
    analysis_id: Mapped[str] = mapped_column(ForeignKey("analysis_jobs.analysis_id"), index=True)
    version: Mapped[int] = mapped_column(Integer, default=1)
    strategy: Mapped[str] = mapped_column(String(120))
    gross_invoice_amount: Mapped[Decimal | None] = mapped_column(Numeric(18, 2), nullable=True)
    eligible_amount: Mapped[Decimal | None] = mapped_column(Numeric(18, 2), nullable=True)
    excluded_amount: Mapped[Decimal | None] = mapped_column(Numeric(18, 2), nullable=True)
    sublimit_adjustment: Mapped[Decimal | None] = mapped_column(Numeric(18, 2), nullable=True)
    deductible: Mapped[Decimal | None] = mapped_column(Numeric(18, 2), nullable=True)
    copayment: Mapped[Decimal | None] = mapped_column(Numeric(18, 2), nullable=True)
    expected_settlement: Mapped[Decimal | None] = mapped_column(Numeric(18, 2), nullable=True)
    proposed_settlement: Mapped[Decimal | None] = mapped_column(Numeric(18, 2), nullable=True)
    discrepancy: Mapped[Decimal | None] = mapped_column(Numeric(18, 2), nullable=True)
    calculation_json: Mapped[dict] = mapped_column(JsonType)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)


class LeakageFinding(Base):
    __tablename__ = "leakage_findings"
    finding_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    analysis_id: Mapped[str] = mapped_column(ForeignKey("analysis_jobs.analysis_id"), index=True)
    fingerprint: Mapped[str] = mapped_column(String(300), index=True)
    category: Mapped[str] = mapped_column(String(64), index=True)
    severity: Mapped[str] = mapped_column(String(12), index=True)
    description: Mapped[str] = mapped_column(Text)
    item_id: Mapped[str | None] = mapped_column(String(100), nullable=True)
    requested_amount: Mapped[Decimal | None] = mapped_column(Numeric(18, 2), nullable=True)
    allowed_amount: Mapped[Decimal | None] = mapped_column(Numeric(18, 2), nullable=True)
    leakage_amount: Mapped[Decimal | None] = mapped_column(Numeric(18, 2), nullable=True)
    amount_type: Mapped[str] = mapped_column(String(14))
    rule_id: Mapped[str] = mapped_column(String(32))
    policy_clause: Mapped[str | None] = mapped_column(String(100), nullable=True)
    evidence: Mapped[list] = mapped_column(JsonType)
    included_in_totals: Mapped[bool] = mapped_column(Boolean, default=True)
    confidence: Mapped[float | None] = mapped_column(nullable=True)
    review_status: Mapped[str] = mapped_column(String(24), default="PENDING", index=True)
    reviewed_by: Mapped[str | None] = mapped_column(String(100), nullable=True)
    reviewed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)


class ModelPrediction(Base):
    __tablename__ = "model_predictions"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_uuid)
    analysis_id: Mapped[str] = mapped_column(ForeignKey("analysis_jobs.analysis_id"), index=True)
    model_name: Mapped[str] = mapped_column(String(64))
    model_version: Mapped[str | None] = mapped_column(String(64), nullable=True)
    status: Mapped[str | None] = mapped_column(String(32), nullable=True)
    output: Mapped[dict] = mapped_column(JsonType)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)


class Investigation(Base):
    __tablename__ = "investigations"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_uuid)
    analysis_id: Mapped[str] = mapped_column(String(40), index=True)
    finding_id: Mapped[str] = mapped_column(String(64), index=True)  # no FK: findings are regenerated on recalculation
    action: Mapped[str] = mapped_column(String(24))
    reviewer: Mapped[str | None] = mapped_column(String(100), nullable=True)
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)
    corrected_amount: Mapped[Decimal | None] = mapped_column(Numeric(18, 2), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)


class AuditLog(Base):
    __tablename__ = "audit_logs"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_uuid)
    entity_type: Mapped[str] = mapped_column(String(32), index=True)
    entity_id: Mapped[str] = mapped_column(String(100), index=True)
    action: Mapped[str] = mapped_column(String(48))
    actor: Mapped[str | None] = mapped_column(String(100), nullable=True)
    details: Mapped[dict | None] = mapped_column(JsonType, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
