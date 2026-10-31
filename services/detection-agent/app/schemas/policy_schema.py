from __future__ import annotations

from datetime import date
from decimal import Decimal

from pydantic import BaseModel, ConfigDict, Field, field_validator

_CFG = ConfigDict(extra="allow", str_strip_whitespace=True)


class CoverageRule(BaseModel):
    model_config = _CFG
    category: str
    covered: bool = True
    daily_limit: Decimal | None = Field(default=None, ge=0)
    limit: Decimal | None = Field(default=None, ge=0)
    clause_reference: str | None = None


class ExclusionRule(BaseModel):
    model_config = _CFG
    category: str
    description: str | None = None
    clause_reference: str | None = None


class Sublimit(BaseModel):
    model_config = _CFG
    category: str
    limit: Decimal | None = Field(default=None, ge=0)
    daily_limit: Decimal | None = Field(default=None, ge=0)
    clause_reference: str | None = None


class WaitingPeriod(BaseModel):
    model_config = _CFG
    category: str | None = None  # None = applies to every item
    days: int = Field(ge=0)
    clause_reference: str | None = None


class Policy(BaseModel):
    model_config = _CFG
    policy_number: str
    policy_type: str | None = None
    valid_from: date | None = None
    valid_until: date | None = None
    inception_date: date | None = None  # original policy start (for waiting periods)
    sum_insured: Decimal | None = Field(default=None, ge=0)
    deductible: Decimal | None = Field(default=None, ge=0)
    copayment_percentage: Decimal | None = Field(default=None, ge=0, le=100)
    coverage: list[CoverageRule] = Field(default_factory=list)
    exclusions: list[ExclusionRule] = Field(default_factory=list)
    sublimits: list[Sublimit] = Field(default_factory=list)
    waiting_periods: list[WaitingPeriod] = Field(default_factory=list)
    settlement_strategy: str | list[str] | None = None

    @field_validator("coverage", "exclusions", "sublimits", "waiting_periods", mode="before")
    @classmethod
    def _none_to_list(cls, v):
        return [] if v is None else v
