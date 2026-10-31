"""Turns engine outputs into explainable findings and quantifies leakage without double counting.

Every rupee of a line item can be "leaked" only once: an ItemLedger tracks the remaining payable amount per line, and
each finding (arithmetic, policy, duplicate, price anomaly) can only claim what earlier findings left behind.
Settlement-level discrepancies are reported but excluded from totals (they restate line-level findings).
"""
from __future__ import annotations

from dataclasses import dataclass, field
from decimal import Decimal
from typing import Any

from app.core.config import Settings
from app.core.utils import ZERO, to_money
from app.engines.anomaly_engine import AnomalyResult
from app.engines.duplicate_engine import DuplicateAnalysis
from app.engines.policy_engine import PolicyResult
from app.engines.settlement_engine import SettlementResult
from app.schemas.common import AmountType, ReviewStatus, Severity
from app.schemas.output_schema import Finding
from app.services.evidence_service import ev
from app.services.normalization_service import ClaimContext
from app.services.policy_mapping_service import ItemMapping
from app.services.validation_service import ValidationReport


@dataclass
class FindingDraft:
    category: str
    severity: str
    description: str
    rule_id: str
    amount_type: str
    component: str
    issue_key: str
    item_id: str | None = None
    requested: Decimal | None = None
    allowed: Decimal | None = None
    leakage: Decimal | None = None
    clause: str | None = None
    evidence: list[dict[str, Any]] = field(default_factory=list)
    confidence: float | None = None
    included_in_totals: bool = True
    review_status: str = "PENDING"

    @property
    def fingerprint(self) -> str:
        return f"{self.rule_id}|{self.item_id or '-'}|{self.category}|{self.issue_key}"

    def to_model(self, finding_id: str) -> Finding:
        return Finding(finding_id=finding_id, category=self.category, severity=Severity(self.severity),
                       description=self.description, item_id=self.item_id, requested_amount=self.requested,
                       allowed_amount=self.allowed, leakage_amount=self.leakage, amount_type=AmountType(self.amount_type),
                       rule_id=self.rule_id, policy_clause=self.clause, evidence=self.evidence,
                       review_status=ReviewStatus(self.review_status), included_in_totals=self.included_in_totals,
                       confidence=self.confidence, fingerprint=self.fingerprint)


class ItemLedger:
    def __init__(self, ctx: ClaimContext):
        self.remaining = {i.item_id: i.total for i in ctx.items}
        self.order = [i.item_id for i in ctx.items]

    def apply(self, item_id: str, amount: Decimal) -> Decimal:
        rem = self.remaining.get(item_id, ZERO)
        applied = min(max(amount, ZERO), rem)
        self.remaining[item_id] = rem - applied
        return applied

    def apply_pool(self, amount: Decimal) -> Decimal:
        left = amount
        for item_id in reversed(self.order):
            left -= self.apply(item_id, left)
        return amount - left

    def total_remaining(self) -> Decimal:
        return sum(self.remaining.values(), ZERO)


class LeakageEngine:
    def __init__(self, settings: Settings):
        self.s = settings

    @staticmethod
    def _sev(leak: Decimal | None, base: Decimal) -> str:
        if not leak or base <= 0:
            return "LOW"
        r = leak / base
        return "HIGH" if r >= Decimal("0.25") else "MEDIUM" if r >= Decimal("0.08") else "LOW"

    def build(self, ctx: ClaimContext, validation: ValidationReport, mappings: list[ItemMapping], pol: PolicyResult,
              st: SettlementResult, dup: DuplicateAnalysis, anomalies: AnomalyResult, ml: dict[str, Any]) -> list[FindingDraft]:
        out: list[FindingDraft] = []
        led = ItemLedger(ctx)
        items = {i.item_id: i for i in ctx.items}
        base = ctx.claim_amount or ZERO
        tol = Decimal(str(self.s.money_tolerance))

        # 0. claim-level amount integrity
        ref_total = ctx.invoice_total if ctx.invoice_total is not None else ctx.items_sum
        if ctx.requested is not None and ctx.requested - ref_total > tol:
            d = ctx.requested - ref_total
            out.append(FindingDraft("REQUESTED_EXCEEDS_INVOICE", self._sev(d, base),
                                    "Requested amount exceeds the invoice total", "RULE-VAL-001", "CALCULATED",
                                    "policy_violations", "REQ>INV", None, ctx.requested, ref_total, d,
                                    evidence=[ev("AMOUNT_COMPARISON", "claim", requested=ctx.requested, invoice_total=ref_total)]))
        if ctx.invoice_total is not None and ctx.invoice_total - ctx.items_sum > tol:
            d = ctx.invoice_total - ctx.items_sum
            out.append(FindingDraft("UNSUPPORTED_INVOICE_AMOUNT", self._sev(d, base),
                                    "Invoice total exceeds the sum of itemised charges", "RULE-VAL-002", "CALCULATED",
                                    "policy_violations", "INV>ITEMS", None, ctx.invoice_total, ctx.items_sum, d,
                                    evidence=[ev("AMOUNT_COMPARISON", "invoice", invoice_total=ctx.invoice_total, items_sum=ctx.items_sum)]))

        # 1. arithmetic overcharges
        for it in ctx.items:
            if it.arithmetic_excess > 0:
                amt = led.apply(it.item_id, it.arithmetic_excess)
                out.append(FindingDraft("LINE_ARITHMETIC_ERROR", self._sev(amt, base),
                                        f"{it.description}: line total exceeds quantity x unit price", "RULE-BILL-001",
                                        "CALCULATED", "policy_violations", f"ARITH::{it.item_id}", it.item_id, it.total,
                                        it.billable, amt, evidence=[ev("LINE_ARITHMETIC", "invoice", quantity=it.quantity,
                                                                      unit_price=it.unit_price, stated_total=it.total,
                                                                      computed_total=it.billable)]))

        # 2. policy rules
        if pol.policy_active is None:
            out.append(FindingDraft("MISSING_INFORMATION", "MEDIUM", pol.activity_reason, "RULE-INFO-004",
                                    "UNQUANTIFIED", "missing_evidence", "POLICY-VALIDITY",
                                    evidence=[ev("INSUFFICIENT_EVIDENCE", "policy", status="UNKNOWN")]))
        mp = {m.item_id: m for m in mappings}
        if pol.policy_active is False:
            total = ZERO
            for r in pol.items:
                total += led.apply(r.item_id, led.remaining[r.item_id])
            out.append(FindingDraft("POLICY_INACTIVE", "CRITICAL", f"Policy not in force: {pol.activity_reason}",
                                    "RULE-POL-005", "CALCULATED", "policy_violations", "POLICY-INACTIVE", None,
                                    ctx.items_sum, ZERO, total,
                                    evidence=[ev("POLICY_PERIOD", "policy", reason=pol.activity_reason,
                                                 valid_from=ctx.request.policy.valid_from,
                                                 valid_until=ctx.request.policy.valid_until)]))
        else:
            titles = {"EXCLUDED": ("EXCLUDED_SERVICE", "falls under a policy exclusion"),
                      "NOT_COVERED": ("NON_COVERED_EXPENSE", "is not covered by the policy"),
                      "WAITING_PERIOD": ("WAITING_PERIOD_VIOLATION", "was incurred within the waiting period"),
                      "LIMIT_EXCEEDED": ("POLICY_LIMIT_BREACH", "exceeds the applicable policy limit")}
            for r in pol.items:
                it, m = items[r.item_id], mp[r.item_id]
                if r.status in titles:
                    cat, txt = titles[r.status]
                    wanted = r.limit_excess if r.status == "LIMIT_EXCEEDED" else r.excluded_amount
                    amt = led.apply(r.item_id, wanted)
                    ev_list = list(r.evidence) + [ev("CATEGORY_MAPPING", "mapping", category=m.category, method=m.method,
                                                    confidence=m.confidence, rationale=m.rationale,
                                                    original_description=m.original_description)]
                    out.append(FindingDraft(cat, "HIGH" if r.status in ("EXCLUDED", "NOT_COVERED", "WAITING_PERIOD")
                                            else self._sev(amt, base),
                                            f"{it.description} {txt}" + (f" ({m.category})" if m.category else ""),
                                            r.rule_id or "RULE-POL-003", "CALCULATED", "policy_violations",
                                            f"POL::{r.item_id}", r.item_id, it.total, r.allowed, amt,
                                            clause=r.clause, evidence=ev_list))
                elif r.status == "UNKNOWN_COVERAGE":
                    out.append(FindingDraft("MISSING_INFORMATION", "LOW",
                                            f"{it.description}: no applicable policy condition supplied (INSUFFICIENT_EVIDENCE)",
                                            "RULE-INFO-002", "UNQUANTIFIED", "missing_evidence", f"UNK::{r.item_id}",
                                            r.item_id, it.total, None, None,
                                            evidence=[ev("CATEGORY_MAPPING", "mapping", category=m.category, method=m.method,
                                                         confidence=m.confidence, rationale=m.status_reason)]))
        seen: set[tuple] = set()
        for ins in pol.insufficient:
            k = (ins["code"], ins.get("item_id"))
            if k in seen:
                continue
            seen.add(k)
            out.append(FindingDraft("MISSING_INFORMATION", "LOW", ins["message"], "RULE-INFO-003", "UNQUANTIFIED",
                                    "missing_evidence", f"INS::{ins['code']}::{ins.get('item_id')}", ins.get("item_id"),
                                    evidence=[ev("INSUFFICIENT_EVIDENCE", "policy", **ins)]))

        # 3. sum insured
        if st.sum_insured_reduction > 0:
            amt = led.apply_pool(st.sum_insured_reduction)
            out.append(FindingDraft("SUM_INSURED_EXCEEDED", "HIGH", "Eligible amount exceeds the remaining sum insured",
                                    "RULE-POL-004", "CALCULATED", "policy_violations", "SUM-INSURED", None,
                                    st.eligible_amount, st.remaining_sum_insured, amt,
                                    evidence=[ev("SUM_INSURED", "policy", sum_insured=ctx.request.policy.sum_insured,
                                                 previously_used=st.previously_used_sum_insured,
                                                 remaining=st.remaining_sum_insured)]))

        # 4. duplicates
        for m in dup.matches:
            comp = "historical_patterns" if m.match_type == "REPEATED_INCIDENT" else "duplicates"
            ev_list = [ev("DUPLICATE_MATCH", "duplicate_engine", **{**m.evidence, "match_type": m.match_type,
                                                              "similarity": m.score, "matched_record": m.record})]
            if m.match_type == "EXACT_INVOICE":
                amt = sum((led.apply(i, led.remaining[i]) for i in led.order), ZERO)
                out.append(FindingDraft("DUPLICATE_INVOICE", "CRITICAL",
                                        "Invoice is an exact duplicate of a previously submitted invoice", m.rule_id,
                                        "CALCULATED", comp, m.issue_key, None, ctx.items_sum, ZERO, amt, evidence=ev_list,
                                        confidence=m.score))
            elif m.match_type in ("DUPLICATE_LINE_ITEM", "CROSS_CLAIM_ITEM"):
                cat = "DUPLICATE_LINE_ITEM" if m.match_type == "DUPLICATE_LINE_ITEM" else "CROSS_CLAIM_DUPLICATE"
                for iid in m.item_ids:
                    it = items[iid]
                    amt = led.apply(iid, led.remaining[iid])
                    out.append(FindingDraft(cat, "HIGH" if m.exact else "MEDIUM",
                                            f"{it.description}: charge duplicates "
                                            + ("another line on this invoice" if m.match_type == "DUPLICATE_LINE_ITEM"
                                               else f"a charge on claim {m.record.get('claim_id') or m.record.get('invoice_id')}"),
                                            m.rule_id, "CALCULATED" if m.exact else "ESTIMATED", comp,
                                            f"{m.issue_key}::{iid}", iid, it.total, ZERO, amt, evidence=ev_list,
                                            confidence=m.score))
            else:
                names = {"NEAR_DUPLICATE_INVOICE": ("NEAR_DUPLICATE_INVOICE", "HIGH" if m.score >= 0.95 else "MEDIUM",
                                                    "Invoice closely resembles a previously submitted invoice"),
                         "REUSED_INVOICE_ID": ("REUSED_INVOICE_ID", "MEDIUM",
                                               "Invoice number reused by the same provider with different details"),
                         "SAME_PROVIDER_DATE_AMOUNT": ("SUSPECTED_DUPLICATE_INVOICE", "HIGH",
                                                       "Same provider, date and amount as an earlier invoice with a different number"),
                         "REPEATED_INCIDENT": ("REPEATED_INCIDENT", "MEDIUM",
                                               "Same patient and incident date already claimed under a different claim id")}
                cat, sev, desc = names[m.match_type]
                out.append(FindingDraft(cat, sev, desc, m.rule_id, "UNQUANTIFIED", comp, m.issue_key,
                                        evidence=ev_list, confidence=m.score))

        # 5. billing anomalies
        for a in anomalies.anomalies:
            leak = None
            if a.leakage is not None and a.item_id:
                leak = led.apply(a.item_id, a.leakage)
            it = items.get(a.item_id) if a.item_id else None
            out.append(FindingDraft("BILLING_ANOMALY", a.severity, a.description, a.rule_id, a.amount_type, a.component,
                                    a.issue_key, a.item_id, it.total if it else None, None, leak,
                                    evidence=[ev(a.anomaly_type, "anomaly_engine", **a.evidence)]))

        # 6. data integrity / missing information
        handled = {"ITEM_ARITHMETIC_MISMATCH", "INVOICE_TOTAL_MISMATCH", "REQUESTED_AMOUNT_MISMATCH"}
        for c in validation.conflicts:
            if c.code not in handled:
                out.append(FindingDraft("DATA_INTEGRITY", "LOW", c.message, "RULE-VAL-003", "UNQUANTIFIED",
                                        "missing_evidence", f"CONF::{c.code}", evidence=[ev("VALIDATION_CONFLICT", "validation", code=c.code, field=c.field)]))
        if validation.missing_information:
            fields = [i.field for i in validation.missing_information]
            policy_fields = [f for f in fields if f.startswith("policy.")]
            claim_fields = [f for f in fields if f.startswith("claim.")]
            for label, fl, sev in (("policy", policy_fields, "MEDIUM" if "policy.coverage" in policy_fields else "LOW"),
                                   ("claim", claim_fields, "LOW")):
                if fl:
                    out.append(FindingDraft("MISSING_INFORMATION", sev, f"Missing {label} information: {', '.join(fl)}",
                                            "RULE-INFO-001", "UNQUANTIFIED", "missing_evidence", f"MISSING::{label}",
                                            evidence=[ev("MISSING_FIELDS", "validation", fields=fl)]))

        # 7. ML signals (reported as suspicious patterns, never as confirmed leakage)
        cb = ml.get("catboost", {})
        if cb.get("status") == "AVAILABLE" and cb.get("flagged"):
            p = cb["suspicion_score"]
            out.append(FindingDraft("ML_RISK_SIGNAL", "HIGH" if p >= 0.9 else "MEDIUM",
                                    "Supervised claim-risk model flags this claim for review", "RULE-ML-001",
                                    "UNQUANTIFIED", "ml_models", "ML-CATBOOST", confidence=p,
                                    evidence=[ev("MODEL_OUTPUT", "catboost", score=p, threshold=cb["decision_threshold"],
                                                 top_contributors=cb["explanation"]["top_contributors"],
                                                 caveat="uncalibrated; trained on a generic claims dataset")]))
        iff = ml.get("isolation_forest", {})
        if iff.get("status") == "AVAILABLE" and iff.get("classification") != "NORMAL":
            out.append(FindingDraft("ML_ANOMALY_SIGNAL", "MEDIUM", "Claim profile is statistically unusual (unsupervised model)",
                                    "RULE-ML-002", "UNQUANTIFIED", "ml_models", "ML-IFOREST",
                                    evidence=[ev("MODEL_OUTPUT", "isolation_forest", anomaly_score=iff["anomaly_score"],
                                                 classification=iff["classification"],
                                                 contributing_features=iff["contributing_features"],
                                                 caveat="anomaly score is not a probability")]))

        # 8. settlement-level discrepancy (restates line findings => excluded from totals)
        if st.proposed_settlement is not None and st.discrepancy is not None and st.discrepancy != 0:
            over = st.discrepancy > 0
            out.append(FindingDraft("SETTLEMENT_DISCREPANCY" if over else "SETTLEMENT_UNDERPAYMENT",
                                    self._sev(st.discrepancy if over else ZERO, base) if over else "LOW",
                                    ("Proposed settlement exceeds the policy-based expected settlement" if over
                                     else "Proposed settlement is below the policy-based expected settlement"),
                                    "RULE-SET-001", "CALCULATED", "settlement", "SETTLEMENT", None, st.proposed_settlement,
                                    st.expected_settlement, to_money(st.discrepancy) if over else ZERO,
                                    included_in_totals=False,
                                    evidence=[ev("SETTLEMENT_COMPARISON", "settlement_engine", proposed=st.proposed_settlement,
                                                 expected=st.expected_settlement, discrepancy=st.discrepancy,
                                                 strategy=st.strategy,
                                                 note="Overlaps with line-level findings; excluded from leakage totals to avoid double counting")]))
        return out


def apply_review_state(drafts: list[FindingDraft], state: dict[str, dict[str, Any]]) -> None:
    for d in drafts:
        s = state.get(d.fingerprint)
        if not s:
            continue
        d.review_status = s["status"]
        if s["status"] == "DISMISSED":
            d.included_in_totals = False
        if s["status"] == "CORRECTED" and s.get("corrected_amount") is not None:
            d.leakage = Decimal(str(s["corrected_amount"]))


def summarize(drafts: list[FindingDraft]) -> dict[str, Any]:
    live = [d for d in drafts if d.included_in_totals and d.review_status != "DISMISSED"]
    calc = sum((d.leakage or ZERO for d in live if d.amount_type == "CALCULATED"), ZERO)
    est_list = [d for d in live if d.amount_type == "ESTIMATED"]
    est = sum((d.leakage or ZERO for d in est_list), ZERO) if est_list else None
    missing = [d for d in drafts if d.category == "MISSING_INFORMATION" and d.review_status != "DISMISSED"]
    rule_viol = [d for d in live if d.amount_type == "CALCULATED" and d.category != "MISSING_INFORMATION"]
    suspicious = [d for d in drafts if d.category != "MISSING_INFORMATION" and d.review_status != "DISMISSED"
                  and d.amount_type in ("ESTIMATED", "UNQUANTIFIED")]
    return {"total_findings": len(drafts), "confirmed_rule_violations": len(rule_viol),
            "suspicious_patterns": len(suspicious), "missing_information": len(missing),
            "calculated_leakage": to_money(calc), "estimated_leakage": to_money(est) if est is not None else None,
            "unquantified_findings": sum(1 for d in drafts if d.amount_type == "UNQUANTIFIED")}
