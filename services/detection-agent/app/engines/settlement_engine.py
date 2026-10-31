"""Deterministic, Decimal-only settlement calculation with configurable step ordering."""
from __future__ import annotations

from dataclasses import dataclass, field
from decimal import Decimal
from typing import Any

from app.core.config import Settings
from app.core.utils import ZERO, norm_text, parse_date, parse_decimal, to_money
from app.engines.policy_engine import PolicyResult
from app.schemas.input_schema import AnalyzeRequest
from app.services.normalization_service import ClaimContext

STEPS = {"DEDUCTIBLE", "COPAY", "SUM_INSURED_CAP"}
STRATEGIES: dict[str, list[str]] = {
    "DEDUCTIBLE_THEN_COPAY": ["DEDUCTIBLE", "COPAY", "SUM_INSURED_CAP"],
    "COPAY_THEN_DEDUCTIBLE": ["COPAY", "DEDUCTIBLE", "SUM_INSURED_CAP"],
    "CAP_THEN_DEDUCTIBLE_THEN_COPAY": ["SUM_INSURED_CAP", "DEDUCTIBLE", "COPAY"],
    "CAP_THEN_COPAY_THEN_DEDUCTIBLE": ["SUM_INSURED_CAP", "COPAY", "DEDUCTIBLE"],
}


def resolve_strategy(spec: str | list[str] | None, default: str) -> tuple[str, list[str]]:
    if isinstance(spec, list):
        order = [s.upper() for s in spec]
        if not order or any(s not in STEPS for s in order):
            raise ValueError(f"Custom settlement strategy must be a list drawn from {sorted(STEPS)}")
        return "CUSTOM:" + ">".join(order), order
    name = (spec or default).upper()
    if name not in STRATEGIES:
        raise ValueError(f"Unknown settlement strategy '{name}'. Available: {sorted(STRATEGIES)}")
    return name, STRATEGIES[name]


@dataclass
class SettlementResult:
    strategy: str
    gross_invoice_amount: Decimal
    eligible_amount: Decimal
    excluded_amount: Decimal
    sublimit_adjustment: Decimal
    deductible_applied: Decimal
    copayment: Decimal
    sum_insured_reduction: Decimal
    expected_settlement: Decimal
    proposed_settlement: Decimal | None
    discrepancy: Decimal | None
    remaining_sum_insured: Decimal | None
    previously_used_sum_insured: Decimal
    steps: list[dict[str, Any]] = field(default_factory=list)


def remaining_sum_insured(req: AnalyzeRequest) -> tuple[Decimal | None, Decimal]:
    policy = req.policy
    if policy.sum_insured is None:
        return None, ZERO
    used = ZERO
    for s in req.history.previous_settlements:
        pn = s.get("policy_number")
        if pn and norm_text(pn) != norm_text(policy.policy_number):
            continue
        if s.get("claim_id") and s.get("claim_id") == req.claim.claim_id:
            continue
        d = parse_date(s.get("settlement_date") or s.get("date"))
        if d and policy.valid_from and policy.valid_until and not (policy.valid_from <= d <= policy.valid_until):
            continue
        amt = parse_decimal(s.get("settled_amount", s.get("amount", s.get("settlement_amount"))))
        used += amt or ZERO
    return max(policy.sum_insured - used, ZERO), used


class SettlementEngine:
    def __init__(self, settings: Settings):
        self.s = settings

    def calculate(self, ctx: ClaimContext, pol: PolicyResult) -> SettlementResult:
        req, policy = ctx.request, ctx.request.policy
        name, order = resolve_strategy(req.options.settlement_strategy or policy.settlement_strategy,
                                       self.s.default_settlement_strategy)
        remaining, used = remaining_sum_insured(req)
        amount = to_money(pol.eligible)
        ded = cop = cap_red = ZERO
        steps: list[dict[str, Any]] = [{"step": "ELIGIBLE_AMOUNT", "before": None, "after": amount,
                                        "note": "Sum of line amounts allowed after exclusions, limits and waiting periods"}]
        for step in order:
            before = amount
            if step == "DEDUCTIBLE":
                d = policy.deductible or ZERO
                applied = min(amount, d)
                amount -= applied
                ded += applied
                note = "deductible applied per claim" if policy.deductible is not None else "no deductible supplied"
            elif step == "COPAY":
                pct = policy.copayment_percentage or ZERO
                c = to_money(amount * pct / Decimal(100))
                amount -= c
                cop += c
                note = f"{pct}% co-payment" if policy.copayment_percentage is not None else "no co-payment supplied"
            else:
                if remaining is not None and amount > remaining:
                    cap_red += amount - remaining
                    amount = remaining
                note = ("remaining sum insured " + str(remaining)) if remaining is not None else "no sum insured supplied"
            steps.append({"step": step, "before": before, "after": amount, "note": note})
        expected = to_money(amount)
        proposed = req.claim.proposed_settlement
        gross = ctx.invoice_total if ctx.invoice_total is not None else ctx.items_sum
        return SettlementResult(
            strategy=name, gross_invoice_amount=gross, eligible_amount=to_money(pol.eligible),
            excluded_amount=to_money(pol.excluded), sublimit_adjustment=to_money(pol.sublimit_adjustment),
            deductible_applied=to_money(ded), copayment=to_money(cop), sum_insured_reduction=to_money(cap_red),
            expected_settlement=expected, proposed_settlement=proposed,
            discrepancy=(to_money(proposed - expected) if proposed is not None else None),
            remaining_sum_insured=remaining, previously_used_sum_insured=used, steps=steps)
