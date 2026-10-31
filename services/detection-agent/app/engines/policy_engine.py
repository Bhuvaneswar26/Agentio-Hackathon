"""Deterministic policy rule evaluation (exclusions, limits, waiting periods, policy validity)."""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date
from decimal import Decimal
from typing import Any

from app.core.config import Settings
from app.core.utils import ZERO, norm_text
from app.core.taxonomy import normalize_category
from app.schemas.policy_schema import Policy
from app.services.evidence_service import ev
from app.services.normalization_service import ClaimContext
from app.services.policy_mapping_service import ItemMapping


@dataclass
class ItemPolicyResult:
    item_id: str
    category: str | None
    requested: Decimal            # billable amount entering policy evaluation
    allowed: Decimal
    excluded_amount: Decimal = ZERO
    limit_excess: Decimal = ZERO
    status: str = "ALLOWED"       # ALLOWED|EXCLUDED|NOT_COVERED|WAITING_PERIOD|LIMIT_EXCEEDED|POLICY_INACTIVE|UNKNOWN_COVERAGE
    rule_id: str | None = None
    clause: str | None = None
    policy_reference: str | None = None
    evidence: list[dict[str, Any]] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)


@dataclass
class PolicyResult:
    policy_active: bool | None
    activity_reason: str
    evaluated_date: date | None
    items: list[ItemPolicyResult]
    waiting_checks: list[dict[str, Any]]
    eligible: Decimal
    excluded: Decimal
    sublimit_adjustment: Decimal
    unknown_items: list[str]
    insufficient: list[dict[str, Any]]


class PolicyEngine:
    def __init__(self, settings: Settings):
        self.s = settings

    def _activity(self, policy: Policy, d: date | None) -> tuple[bool | None, str]:
        if d is None:
            return None, "No incident/admission/invoice date supplied; policy validity could not be verified"
        if policy.valid_from is None or policy.valid_until is None:
            return None, "Policy validity period not supplied; policy validity could not be verified"
        if d < policy.valid_from:
            return False, f"Date of loss {d} is before policy start {policy.valid_from}"
        if d > policy.valid_until:
            return False, f"Date of loss {d} is after policy expiry {policy.valid_until}"
        return True, f"Date of loss {d} within {policy.valid_from}..{policy.valid_until}"

    def evaluate(self, ctx: ClaimContext, mappings: list[ItemMapping]) -> PolicyResult:
        policy = ctx.request.policy
        active, reason = self._activity(policy, ctx.incident_ref_date)
        mp = {m.item_id: m for m in mappings}
        results: list[ItemPolicyResult] = []
        remaining: dict[tuple, Decimal] = {}
        waiting_checks: list[dict[str, Any]] = []
        insufficient: list[dict[str, Any]] = []
        unknown: list[str] = []

        inception = policy.inception_date or policy.valid_from
        elapsed = (ctx.incident_ref_date - inception).days if (inception and ctx.incident_ref_date) else None

        for it in ctx.items:
            m = mp[it.item_id]
            r = ItemPolicyResult(it.item_id, m.category, it.billable, it.billable)
            if active is False:
                r.allowed, r.excluded_amount, r.status = ZERO, it.billable, "POLICY_INACTIVE"
                r.rule_id, r.policy_reference = "RULE-POL-005", "policy.valid_from/valid_until"
                r.evidence.append(ev("POLICY_PERIOD", "policy", valid_from=policy.valid_from,
                                     valid_until=policy.valid_until, date_of_loss=ctx.incident_ref_date))
                results.append(r)
                continue

            if m.status in ("EXCLUDED", "NOT_COVERED"):
                src = m.exclusion if m.status == "EXCLUDED" else m.coverage
                r.allowed, r.excluded_amount, r.status = ZERO, it.billable, m.status
                r.rule_id = "RULE-POL-001" if m.status == "EXCLUDED" else "RULE-POL-002"
                r.clause = getattr(src, "clause_reference", None)
                r.policy_reference = (f"exclusions:{m.exclusion.category}" if m.exclusion
                                      else f"coverage:{m.coverage.category}.covered=false")
                r.evidence.append(ev("POLICY_CONDITION", "policy", reference=r.policy_reference,
                                     clause_reference=r.clause, description=getattr(src, "description", None),
                                     mapped_category=m.category, mapping_method=m.method))
                results.append(r)
                continue

            # waiting periods (use the original policy inception when supplied)
            wp_hit = None
            for wp in policy.waiting_periods:
                wcat = normalize_category(wp.category)
                if wcat is not None and wcat != m.category:
                    continue
                if elapsed is None:
                    insufficient.append({"item_id": it.item_id, "code": "WAITING_PERIOD_UNVERIFIABLE",
                                         "message": "No inception/valid_from or incident date to evaluate waiting period"})
                    continue
                chk = {"item_id": it.item_id, "category": wcat, "waiting_days": wp.days, "elapsed_days": elapsed,
                       "basis": "inception_date" if policy.inception_date else "valid_from",
                       "violated": elapsed < wp.days}
                waiting_checks.append(chk)
                if elapsed < wp.days:
                    wp_hit = (wp, chk)
            if wp_hit:
                wp, chk = wp_hit
                r.allowed, r.excluded_amount, r.status = ZERO, it.billable, "WAITING_PERIOD"
                r.rule_id, r.clause = "RULE-POL-006", wp.clause_reference
                r.policy_reference = f"waiting_periods:{wp.category or 'ALL'}"
                r.evidence.append(ev("WAITING_PERIOD", "policy", **chk))
                results.append(r)
                continue

            if m.status == "UNKNOWN" and not m.sublimits:
                unknown.append(it.item_id)
                r.status = "UNKNOWN_COVERAGE"
                r.notes.append(m.status_reason)
                if self.s.unknown_coverage_treatment == "EXCLUDED_PENDING_REVIEW":
                    r.allowed, r.excluded_amount = ZERO, it.billable
                results.append(r)
                continue

            allowed = it.billable
            sources = ([m.coverage] if m.coverage else []) + list(m.sublimits)
            for src in sources:
                ref_base = ("coverage" if src is m.coverage else "sublimits") + f":{src.category}"
                if src.daily_limit is not None:
                    units = it.quantity if it.quantity is not None else (Decimal(ctx.stay_days) if ctx.stay_days else None)
                    if units is None:
                        insufficient.append({"item_id": it.item_id, "code": "UNITS_UNKNOWN",
                                             "message": f"daily_limit on {src.category} cannot be applied: quantity and stay length unknown"})
                        continue
                    cap = src.daily_limit * units
                    if allowed > cap:
                        allowed = cap
                        r.rule_id, r.clause, r.policy_reference = "RULE-POL-003", src.clause_reference, f"{ref_base}.daily_limit"
                        r.evidence.append(ev("DAILY_LIMIT", "policy", reference=r.policy_reference,
                                             daily_limit=src.daily_limit, units=units, cap=cap, billed=it.billable))
                if src.limit is not None:
                    key = (m.category, id(src))
                    rem = remaining.setdefault(key, src.limit)
                    take = min(allowed, rem)
                    if take < allowed:
                        r.rule_id, r.clause, r.policy_reference = "RULE-POL-003", src.clause_reference, f"{ref_base}.limit"
                        r.evidence.append(ev("CATEGORY_LIMIT", "policy", reference=r.policy_reference,
                                             limit=src.limit, remaining_before=rem, billed=allowed))
                    remaining[key] = rem - take
                    allowed = take
            r.allowed = allowed
            r.limit_excess = it.billable - allowed
            if r.limit_excess > 0:
                r.status = "LIMIT_EXCEEDED"
            results.append(r)

        eligible = sum((r.allowed for r in results), ZERO)
        excluded = sum((r.excluded_amount for r in results), ZERO)
        sub_adj = sum((r.limit_excess for r in results), ZERO)
        return PolicyResult(active, reason, ctx.incident_ref_date, results, waiting_checks, eligible, excluded,
                            sub_adj, unknown, insufficient)
