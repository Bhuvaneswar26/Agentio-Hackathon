"""Deterministic duplicate detection (SHA256 composite keys + RapidFuzz) with legitimate-repeat guarding."""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date
from decimal import Decimal
from typing import Any

from rapidfuzz import fuzz

from app.core.config import Settings
from app.core.utils import jsonable, norm_text, parse_date, parse_decimal, sha256_key, to_money
from app.services.normalization_service import ClaimContext, HistoryRecord, NormItem


@dataclass
class DuplicateMatch:
    match_type: str      # EXACT_INVOICE | DUPLICATE_LINE_ITEM | CROSS_CLAIM_ITEM | NEAR_DUPLICATE_INVOICE |
                         # SAME_PROVIDER_DATE_AMOUNT | REPEATED_INCIDENT | REUSED_INVOICE_ID
    rule_id: str
    score: float
    exact: bool
    item_ids: list[str]
    record: dict[str, Any]
    evidence: dict[str, Any]
    issue_key: str


@dataclass
class DuplicateAnalysis:
    matches: list[DuplicateMatch] = field(default_factory=list)
    legitimate_repeats: list[dict[str, Any]] = field(default_factory=list)
    records_compared: int = 0
    checks_run: list[str] = field(default_factory=list)
    invoice_hash: str | None = None

    def to_dict(self) -> dict[str, Any]:
        by_type: dict[str, int] = {}
        for m in self.matches:
            by_type[m.match_type] = by_type.get(m.match_type, 0) + 1
        return jsonable({
            "duplicates_detected": bool(self.matches), "match_count": len(self.matches), "by_type": by_type,
            "matches": self.matches, "legitimate_repeats": self.legitimate_repeats,
            "records_compared": self.records_compared, "checks_run": self.checks_run,
            "invoice_hash": self.invoice_hash,
        })


def _provider_token(provider_id: str | None, key: str) -> str:
    return (provider_id or "").strip().lower() or key


def _sim_amount(a: Decimal | None, b: Decimal | None) -> float:
    if a is None or b is None or (a == 0 and b == 0):
        return 0.0 if (a is None or b is None) else 1.0
    return float(1 - min(abs(a - b) / max(a, b), 1))


def _sim_date(a: date | None, b: date | None, window: int) -> float:
    if a is None or b is None:
        return 0.0
    return max(0.0, 1 - abs((a - b).days) / max(window, 1))


class DuplicateEngine:
    def __init__(self, settings: Settings):
        self.s = settings

    def _repeatable(self, desc_norm: str) -> bool:
        return any(k in desc_norm for k in self.s.repeatable_service_keywords)

    @staticmethod
    def _core_hash(code: str | None, desc_norm: str, total: Decimal | None) -> str:
        return sha256_key((code or "").upper(), desc_norm, to_money(total) if total is not None else "")

    def analyze(self, ctx: ClaimContext) -> DuplicateAnalysis:
        out = DuplicateAnalysis()
        claim = ctx.request.claim
        inv = claim.invoice
        recs = [r for r in ctx.history if not (r.claim_id and r.claim_id == claim.claim_id)]
        out.records_compared = len(recs)
        win = self.s.duplicate_window_days
        prov = _provider_token(ctx.provider_id, ctx.provider_key)
        inv_id = norm_text(inv.invoice_id) if inv and inv.invoice_id else ""
        inv_date = inv.invoice_date if inv else None
        inv_total = ctx.invoice_total if ctx.invoice_total is not None else ctx.items_sum
        out.invoice_hash = sha256_key(prov, inv_id, inv_date, to_money(inv_total))
        all_ids = [i.item_id for i in ctx.items]
        invoice_matched: set[int] = set()
        out.checks_run = ["EXACT_INVOICE_HASH", "REUSED_INVOICE_ID", "NEAR_DUPLICATE_INVOICE_ID",
                          "SAME_PROVIDER_DATE_AMOUNT", "WITHIN_INVOICE_LINE_DUPLICATES",
                          "CROSS_CLAIM_LINE_DUPLICATES", "REPEATED_INCIDENT"]

        for idx, r in enumerate(recs):
            r_prov = _provider_token(r.provider_id, r.provider_key)
            r_id = norm_text(r.invoice_id) if r.invoice_id else ""
            rec_info = {"claim_id": r.claim_id, "invoice_id": r.invoice_id, "source": r.source,
                        "invoice_date": r.invoice_date, "total_amount": r.total}
            same_prov = bool(prov and r_prov and prov == r_prov)
            amt_sim = _sim_amount(inv_total, r.total)
            date_sim = _sim_date(inv_date, r.invoice_date, win)

            if inv_id and r_id and inv_id == r_id and same_prov and r.total is not None \
                    and to_money(r.total) == to_money(inv_total) \
                    and (r.invoice_date == inv_date or r.invoice_date is None or inv_date is None):
                out.matches.append(DuplicateMatch(
                    "EXACT_INVOICE", "RULE-DUP-001", 1.0, True, list(all_ids), rec_info,
                    {"invoice_hash": out.invoice_hash, "matched_hash": sha256_key(
                        r_prov, r_id, r.invoice_date, to_money(r.total)), "similarity": 1.0},
                    f"DUP-INV::{r.claim_id or r.invoice_id}"))
                invoice_matched.add(idx)
                continue
            if inv_id and r_id and inv_id == r_id and same_prov:
                out.matches.append(DuplicateMatch(
                    "REUSED_INVOICE_ID", "RULE-DUP-004", 0.9, False, [], rec_info,
                    {"reason": "Same provider and invoice number but different amount/date",
                     "amount_similarity": round(amt_sim, 3), "date_similarity": round(date_sim, 3)},
                    f"DUP-INV::{r.claim_id or r.invoice_id}"))
                invoice_matched.add(idx)
                continue
            if inv_id and r_id and inv_id != r_id:
                id_sim = fuzz.ratio(inv_id, r_id)
                if id_sim >= self.s.near_duplicate_id_ratio and (same_prov or not (prov and r_prov)) \
                        and amt_sim >= 1 - self.s.near_duplicate_amount_tolerance and \
                        (inv_date is None or r.invoice_date is None or abs((inv_date - r.invoice_date).days) <= win):
                    score = round((id_sim / 100 + amt_sim + max(date_sim, 0.0)) / 3, 3)
                    out.matches.append(DuplicateMatch(
                        "NEAR_DUPLICATE_INVOICE", "RULE-DUP-004", score, False, [], rec_info,
                        {"invoice_id_similarity": round(id_sim / 100, 3), "amount_similarity": round(amt_sim, 3),
                         "date_similarity": round(date_sim, 3), "provider_match": same_prov},
                        f"DUP-INV::{r.claim_id or r.invoice_id}"))
                    invoice_matched.add(idx)
                    continue
            if same_prov and inv_date and r.invoice_date == inv_date and r.total is not None \
                    and to_money(r.total) == to_money(inv_total) \
                    and (not ctx.patient_id or not r.patient_id or ctx.patient_id == r.patient_id):
                out.matches.append(DuplicateMatch(
                    "SAME_PROVIDER_DATE_AMOUNT", "RULE-DUP-005", 0.85, False, [], rec_info,
                    {"provider": prov, "invoice_date": inv_date, "amount": to_money(inv_total),
                     "different_invoice_ids": True},
                    f"DUP-INV::{r.claim_id or r.invoice_id}"))
                invoice_matched.add(idx)

        # --- duplicate lines within the invoice
        groups: dict[str, list[NormItem]] = {}
        for it in ctx.items:
            key = sha256_key((it.service_code or ""), it.desc_norm, it.unit_price, it.quantity, it.total)
            groups.setdefault(key, []).append(it)
        for key, grp in groups.items():
            if len(grp) < 2:
                continue
            dates = [g.service_date for g in grp]
            if all(d is not None for d in dates) and len(set(dates)) == len(dates):
                out.legitimate_repeats.append({"type": "SAME_LINE_DIFFERENT_SERVICE_DATES",
                                               "item_ids": [g.item_id for g in grp], "service_dates": dates})
                continue
            if self._repeatable(grp[0].desc_norm) and any(d is None for d in dates):
                out.legitimate_repeats.append({"type": "REPEATABLE_TREATMENT_NO_SERVICE_DATES",
                                               "item_ids": [g.item_id for g in grp],
                                               "note": "Treatment commonly repeated; verify service dates"})
                continue
            exact = all(d is not None for d in dates) and len(set(dates)) == 1
            out.matches.append(DuplicateMatch(
                "DUPLICATE_LINE_ITEM", "RULE-DUP-002", 1.0 if exact else 0.9, exact,
                [g.item_id for g in grp[1:]], {"claim_id": claim.claim_id, "source": "same_invoice"},
                {"line_hash": key, "occurrences": len(grp), "first_item_id": grp[0].item_id,
                 "same_service_date": exact, "description": grp[0].description, "total_amount": grp[0].total},
                f"DUP-LINE::{key[:16]}"))

        # --- duplicate lines across historical claims
        for idx, r in enumerate(recs):
            if idx in invoice_matched or not r.items:
                continue
            r_prov = _provider_token(r.provider_id, r.provider_key)
            if prov and r_prov and prov != r_prov:
                continue
            for it in ctx.items:
                cur_core = self._core_hash(it.service_code, it.desc_norm, it.total)
                for ri in r.items:
                    r_total = parse_decimal(ri.get("total_amount"))
                    r_core = self._core_hash(ri.get("service_code"), norm_text(ri.get("description")), r_total)
                    if cur_core != r_core:
                        continue
                    cur_d = it.service_date or ctx.incident_ref_date
                    rec_d = parse_date(ri.get("service_date")) or r.incident_date or r.invoice_date
                    if cur_d and rec_d and abs((cur_d - rec_d).days) > win:
                        out.legitimate_repeats.append({
                            "type": "SAME_SERVICE_OUTSIDE_WINDOW", "item_id": it.item_id,
                            "matched_claim_id": r.claim_id, "days_apart": abs((cur_d - rec_d).days),
                            "window_days": win})
                        continue
                    days = abs((cur_d - rec_d).days) if (cur_d and rec_d) else None
                    exact = days == 0
                    score = round(((1.0 + 1.0 + (1.0 if exact else (0.7 if days is not None else 0.5))) / 3), 3)
                    out.matches.append(DuplicateMatch(
                        "CROSS_CLAIM_ITEM", "RULE-DUP-003", score, exact, [it.item_id],
                        {"claim_id": r.claim_id, "invoice_id": r.invoice_id, "source": r.source},
                        {"line_hash": cur_core, "days_apart": days, "dates_available": days is not None,
                         "description": it.description, "total_amount": it.total},
                        f"DUP-XLINE::{it.item_id}::{r.claim_id or r.invoice_id}"))

        # --- repeated incident under a different claim id
        if ctx.patient_id and ctx.request.claim.incident and ctx.request.claim.incident.incident_date:
            for idx, r in enumerate(recs):
                if idx in invoice_matched or not r.patient_id:
                    continue
                if r.patient_id == ctx.patient_id and r.incident_date == ctx.request.claim.incident.incident_date:
                    out.matches.append(DuplicateMatch(
                        "REPEATED_INCIDENT", "RULE-DUP-006", 0.7, False, [],
                        {"claim_id": r.claim_id, "invoice_id": r.invoice_id, "source": r.source},
                        {"patient_id": ctx.patient_id, "incident_date": r.incident_date,
                         "different_claim_id": True},
                        f"DUP-INC::{r.claim_id}"))
        return out
