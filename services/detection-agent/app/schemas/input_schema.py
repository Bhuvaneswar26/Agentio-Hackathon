from __future__ import annotations

from datetime import date
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.schemas.claim_schema import Claim
from app.schemas.policy_schema import Policy


class AnalysisOptions(BaseModel):
    settlement_strategy: str | list[str] | None = None
    run_ml: bool = True
    as_of_date: date | None = None


class History(BaseModel):
    model_config = ConfigDict(extra="allow")
    previous_claims: list[dict[str, Any]] = Field(default_factory=list)
    previous_settlements: list[dict[str, Any]] = Field(default_factory=list)
    related_invoices: list[dict[str, Any]] = Field(default_factory=list)

    @field_validator("previous_claims", "previous_settlements", "related_invoices", mode="before")
    @classmethod
    def _none_to_list(cls, v):
        return [] if v is None else v


class AnalyzeRequest(BaseModel):
    model_config = ConfigDict(extra="allow")
    claim: Claim
    policy: Policy
    history: History = Field(default_factory=History)
    options: AnalysisOptions = Field(default_factory=AnalysisOptions)

    @field_validator("history", "options", mode="before")
    @classmethod
    def _none_to_default(cls, v):
        return {} if v is None else v
