"""Structural + business validation. Blocking errors stop the pipeline; warnings/conflicts do not."""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date
from decimal import Decimal
from typing import Any

from app.core.config import Settings
from app.core.utils import ZERO, norm_text, to_money
from app.schemas.input_schema import AnalyzeRequest


@dataclass
class Issue:
    code: str
    field: str
    message: str
    blocking: bool = False
    details: dict[str, Any] = field(default_factory=dict)


@dataclass
class ValidationReport:
    errors: list[Issue] = field(default_factory=list)
    warnings: list[Issue] = field(default_factory=list)
    missing_information: list[Issue] = field(default_factory=list)
    conflicts: list[Issue] = field(default_factory=list)

    @property
    def blocking(self) -> bool:
        return any(e.blocking for e in self.errors)

    def to_dict(self) -> dict[str, Any]:
        from app.core.utils import jsonable

        return jsonable({
            "is_valid": not self.blocking,
            "errors": self.errors, "warnings": self.warnings,
            "missing_information": self.missing_information, "conflicts": self.conflicts,
        })


def validate_request(req: AnalyzeRequest, settings: Settings, today: date | None = None) -> ValidationReport:
    r = ValidationReport()
    claim, policy = req.claim, req.policy
    tol = Decimal(str(settings.money_tolerance))
    today = today or req.options.as_of_date or date.today()

    if not claim.claim_id.strip():
        r.errors.append(Issue("MISSING_CLAIM_ID", "claim.claim_id", "claim_id is required", True))
    if norm_text(claim.policy_number) != norm_text(policy.policy_number):
        r.errors.append(Issue("POLICY_NUMBER_MISMATCH", "claim.policy_number",
                              f"Claim references '{claim.policy_number}' but policy is '{policy.policy_number}'",
                              True, {"claim": claim.policy_number, "policy": policy.policy_number}))
    if policy.policy_type and policy.policy_type.upper() != claim.claim_type.value:
        r.errors.append(Issue("CLAIM_POLICY_TYPE_MISMATCH", "policy.policy_type",
                              f"Claim type {claim.claim_type.value} does not match policy type {policy.policy_type}", True))
    if policy.valid_from and policy.valid_until and policy.valid_from > policy.valid_until:
        r.errors.append(Issue("INVALID_POLICY_PERIOD", "policy.valid_from",
                              "valid_from is after valid_until", True))

    inv = claim.invoice
    if inv is None or not inv.items:
        r.errors.append(Issue("NO_INVOICE_ITEMS", "claim.invoice.items",
                              "At least one invoice line item is required for analysis", True))
    if inv and inv.currency and inv.currency.upper() not in settings.supported_currencies:
        r.errors.append(Issue("UNSUPPORTED_CURRENCY", "claim.invoice.currency",
                              f"Currency '{inv.currency}' is not supported", True))
    if inv and not inv.currency:
        r.warnings.append(Issue("CURRENCY_ASSUMED", "claim.invoice.currency", "Currency missing; INR assumed"))

    inc = claim.incident
    if inc and inc.admission_date and inc.discharge_date and inc.admission_date > inc.discharge_date:
        r.errors.append(Issue("INVALID_STAY_DATES", "claim.incident",
                              "admission_date is after discharge_date", True))
    if inc and inc.incident_date and inc.admission_date and inc.admission_date < inc.incident_date:
        r.conflicts.append(Issue("ADMISSION_BEFORE_INCIDENT", "claim.incident",
                                 "admission_date precedes incident_date"))
    if inv and inv.invoice_date and inc and inc.discharge_date and inv.invoice_date < inc.discharge_date:
        r.warnings.append(Issue("INVOICE_BEFORE_DISCHARGE", "claim.invoice.invoice_date",
                                "Invoice is dated before discharge (may be an interim bill)"))
    if inv and inv.invoice_date and inv.invoice_date > today:
        r.warnings.append(Issue("FUTURE_INVOICE_DATE", "claim.invoice.invoice_date", "Invoice date is in the future"))

    # missing information (never silently ignored)
    for path, present in (
        ("claim.claimant.patient_id", bool(claim.claimant and claim.claimant.patient_id)),
        ("claim.provider.provider_id", bool(claim.provider and claim.provider.provider_id)),
        ("claim.provider.provider_type", bool(claim.provider and claim.provider.provider_type)),
        ("claim.incident.incident_date", bool(inc and (inc.incident_date or inc.admission_date))),
        ("claim.incident.admission_date", bool(inc and inc.admission_date)),
        ("claim.incident.discharge_date", bool(inc and inc.discharge_date)),
        ("claim.invoice.invoice_id", bool(inv and inv.invoice_id)),
        ("claim.invoice.invoice_date", bool(inv and inv.invoice_date)),
        ("policy.valid_from", policy.valid_from is not None),
        ("policy.valid_until", policy.valid_until is not None),
        ("policy.sum_insured", policy.sum_insured is not None),
        ("policy.deductible", policy.deductible is not None),
        ("policy.copayment_percentage", policy.copayment_percentage is not None),
        ("policy.coverage", bool(policy.coverage)),
    ):
        if not present:
            r.missing_information.append(Issue("MISSING_FIELD", path, f"{path} not supplied"))

    # arithmetic / conflicts
    if inv:
        s = ZERO
        for it in inv.items:
            s += it.total_amount
            if it.quantity is not None and it.unit_price is not None:
                exp = to_money(it.quantity * it.unit_price)
                if abs(it.total_amount - exp) > tol:
                    r.conflicts.append(Issue("ITEM_ARITHMETIC_MISMATCH", f"claim.invoice.items[{it.item_id}]",
                                             f"total {it.total_amount} != quantity*unit_price {exp}",
                                             details={"item_id": it.item_id, "stated": it.total_amount, "computed": exp}))
        if inv.total_amount is not None and abs(inv.total_amount - s) > tol:
            r.conflicts.append(Issue("INVOICE_TOTAL_MISMATCH", "claim.invoice.total_amount",
                                     f"invoice total {inv.total_amount} != sum of items {s}",
                                     details={"stated": inv.total_amount, "items_sum": s}))
        if claim.requested_amount is not None and inv.total_amount is not None \
                and abs(claim.requested_amount - inv.total_amount) > tol:
            r.conflicts.append(Issue("REQUESTED_AMOUNT_MISMATCH", "claim.requested_amount",
                                     f"requested {claim.requested_amount} != invoice total {inv.total_amount}",
                                     details={"requested": claim.requested_amount, "invoice_total": inv.total_amount}))
    return r
