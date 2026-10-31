from __future__ import annotations

from datetime import date
from decimal import Decimal

from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.schemas.common import ClaimType

_CFG = ConfigDict(extra="allow", str_strip_whitespace=True)  # unknown frontend fields are preserved, not rejected


class Claimant(BaseModel):
    model_config = _CFG
    name: str | None = None
    age: int | None = Field(default=None, ge=0, le=130)
    patient_id: str | None = None


class Provider(BaseModel):
    model_config = _CFG
    provider_id: str | None = None
    name: str | None = None
    provider_type: str | None = None
    location: str | None = None


class Incident(BaseModel):
    model_config = _CFG
    incident_date: date | None = None
    admission_date: date | None = None
    discharge_date: date | None = None


class InvoiceItem(BaseModel):
    model_config = _CFG
    item_id: str | None = None
    description: str = ""
    service_code: str | None = None
    quantity: Decimal | None = Field(default=None, ge=0)
    unit_price: Decimal | None = Field(default=None, ge=0)
    total_amount: Decimal = Field(ge=0)
    service_date: date | None = None


class Invoice(BaseModel):
    model_config = _CFG
    invoice_id: str | None = None
    invoice_date: date | None = None
    total_amount: Decimal | None = Field(default=None, ge=0)
    currency: str | None = None
    items: list[InvoiceItem] = Field(default_factory=list)


class Claim(BaseModel):
    model_config = _CFG
    claim_id: str
    policy_number: str
    claim_type: ClaimType
    claimant: Claimant | None = None
    provider: Provider | None = None
    incident: Incident | None = None
    invoice: Invoice | None = None
    requested_amount: Decimal | None = Field(default=None, ge=0)
    proposed_settlement: Decimal | None = Field(default=None, ge=0)

    @field_validator("claim_type", mode="before")
    @classmethod
    def _upper(cls, v):
        return v.strip().upper() if isinstance(v, str) else v
