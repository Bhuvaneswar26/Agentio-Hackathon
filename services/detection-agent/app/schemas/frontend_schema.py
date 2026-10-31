"""Lenient mirror of the dashboard's `DetectionPayload` (frontend/claims-dashboard/src/types.ts, schemaVersion 1.0).

The backend adapts to the frontend's camelCase field names; the frontend does not have to change them.
"""
from __future__ import annotations

from typing import Any

from pydantic import BaseModel, ConfigDict, Field, field_validator

_CFG = ConfigDict(extra="allow", populate_by_name=True)


class FELine(BaseModel):
    model_config = _CFG
    id: str | None = None
    description: str = ""
    code: str | None = ""
    quantity: float | None = None
    unitPrice: float | None = None
    amount: float | None = 0
    provider: str | None = ""
    invoiceRef: str | None = ""
    date: str | None = ""


class FERule(BaseModel):
    model_config = _CFG
    id: str | None = None
    name: str = ""
    clause: str | None = None
    type: str | None = None
    value: float | None = None
    unit: str | None = None


class FEHistory(BaseModel):
    model_config = _CFG
    claimId: str | None = None
    incidentDate: str | None = None
    amount: float | None = None
    status: str | None = None
    claimant: str | None = None
    provider: str | None = None
    invoiceLines: list[FELine] = Field(default_factory=list)


class FEClaim(BaseModel):
    model_config = _CFG
    claimId: str | None = None
    policyNumber: str | None = None
    claimant: str | None = None
    incidentDate: str | None = None
    filedDate: str | None = None
    domain: str | None = None
    claimType: str | None = None
    requestedAmount: float | None = None
    proposedSettlement: float | None = None
    provider: str | None = None
    city: str | None = None


class FEPolicy(BaseModel):
    model_config = _CFG
    policyNumber: str | None = None
    coverage: str | None = None
    deductible: float | None = None
    copayPercent: float | None = None
    validFrom: str | None = None
    validUntil: str | None = None
    sumInsured: float | None = None
    rules: list[FERule] = Field(default_factory=list)


class FEExtraction(BaseModel):
    model_config = _CFG
    rawText: str | None = None
    missingFields: list[str] = Field(default_factory=list)
    valid: bool = False


class DetectionPayloadIn(BaseModel):
    model_config = _CFG
    schemaVersion: str | None = "1.0"
    ingestedAt: str | None = None
    source: dict[str, Any] = Field(default_factory=dict)
    claim: FEClaim = Field(default_factory=FEClaim)
    invoiceLines: list[FELine] = Field(default_factory=list)
    policy: FEPolicy = Field(default_factory=FEPolicy)
    history: list[FEHistory] = Field(default_factory=list)
    documents: list[dict[str, Any]] = Field(default_factory=list)
    extraction: FEExtraction = Field(default_factory=FEExtraction)

    @field_validator("claim", "policy", "extraction", mode="before")
    @classmethod
    def _none_to_default(cls, v):
        return {} if v is None else v

    @field_validator("invoiceLines", "history", "documents", mode="before")
    @classmethod
    def _none_to_list(cls, v):
        return [] if v is None else v
