"""Billing anomaly detection using peer-group robust statistics (median / MAD)."""
from __future__ import annotations

from dataclasses import dataclass, field
from decimal import Decimal
from statistics import median
from typing import Any

from app.core.config import Settings
from app.core.taxonomy import PER_DAY_CATEGORIES
from app.core.utils import ZERO, jsonable, norm_text, to_money
from app.services.normalization_service import ClaimContext, NormItem
from app.services.policy_mapping_service import ItemMapping


def robust_stats(values: list[float]) -> tuple[float, float]:
    med = median(values)
    return med, median([abs(v - med) for v in values])


def modified_z(x: float, med: float, mad: float) -> float | None:
    return None if mad == 0 else 0.6745 * (x - med) / mad


@dataclass
class Anomaly:
    anomaly_type: str
    rule_id: str
    description: str
    item_id: str | None
    amount_type: str            # CALCULATED | ESTIMATED | UNQUANTIFIED
    leakage: Decimal | None
    severity: str
    evidence: dict[str, Any]
    issue_key: str
    component: str = "billing_anomalies"


@dataclass
class AnomalyResult:
    anomalies: list[Anomaly] = field(default_factory=list)
    insufficient_evidence: list[dict[str, Any]] = field(default_factory=list)
    peer_groups: list[dict[str, Any]] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return jsonable({"anomalies_detected": bool(self.anomalies), "count": len(self.anomalies),
                         "anomalies": self.anomalies, "peer_groups": self.peer_groups,
                         "insufficient_evidence": self.insufficient_evidence,
                         "method": "median/MAD modified z-score against peer groups; no peer data => no flag"})


class AnomalyEngine:
    def __init__(self, settings: Settings, benchmarks: dict[str, Any] | None = None):
        self.s, self.bench = settings, benchmarks or {}

    def _peer_prices(self, ctx: ClaimContext, it: NormItem) -> tuple[list[float], list[float], str]:
        prices: list[float] = []
        qtys: list[float] = []
        code = (it.service_code or "").upper()
        for r in ctx.history:
            if ctx.provider_type and r.provider_type and r.provider_type.upper() != ctx.provider_type:
                continue
            for ri in r.items:
                same = (code and str(ri.get("service_code") or "").upper() == code) or \
                       (not code and norm_text(ri.get("description")) == it.desc_norm)
                if not same:
                    continue
                q = ri.get("quantity")
                up = ri.get("unit_price")
                tot = ri.get("total_amount")
                try:
                    if up is not None:
                        prices.append(float(up))
                    elif tot is not None and q:
                        prices.append(float(tot) / float(q))
                    if q is not None:
                        qtys.append(float(q))
                except (TypeError, ValueError):
                    continue
        return prices, qtys, "history"

    def analyze(self, ctx: ClaimContext, mappings: list[ItemMapping]) -> AnomalyResult:
        res = AnomalyResult()
        cat = {m.item_id: m.category for m in mappings}
        min_n = self.s.min_peer_samples

        for it in ctx.items:
            unit = it.unit_price if it.unit_price is not None else (
                it.total / it.quantity if it.quantity else None)
            # (1) per-day units exceeding the length of stay (deterministic)
            if cat.get(it.item_id) in PER_DAY_CATEGORIES and ctx.stay_days and it.quantity is not None \
                    and it.quantity > ctx.stay_days and unit is not None:
                excess_units = it.quantity - ctx.stay_days
                res.anomalies.append(Anomaly(
                    "QUANTITY_EXCEEDS_STAY", "RULE-BILL-003",
                    f"{it.description}: {it.quantity} units billed for a {ctx.stay_days}-day stay",
                    it.item_id, "CALCULATED", min(to_money(excess_units * unit), it.total), "HIGH",
                    {"quantity": it.quantity, "stay_days": ctx.stay_days, "excess_units": excess_units,
                     "unit_price": unit}, f"QTY::{it.item_id}"))

            # (2) unit price / quantity vs peer distribution
            if unit is None:
                continue
            prices, qtys, src = self._peer_prices(ctx, it)
            key = (it.service_code or it.desc_norm)
            bm = self.bench.get("items", {}).get(f"{ctx.provider_type or '*'}|{key}") or \
                self.bench.get("items", {}).get(f"*|{key}")
            if len(prices) >= min_n:
                med, mad = robust_stats(prices)
                n = len(prices)
            elif bm and bm.get("count", 0) >= min_n:
                med, mad, n, src = bm["median"], bm["mad"], bm["count"], "benchmark_file"
            else:
                res.insufficient_evidence.append({"item_id": it.item_id, "check": "UNIT_PRICE_PEER_COMPARISON",
                                                  "peer_samples": len(prices), "required": min_n})
                continue
            x = float(unit)
            z = modified_z(x, med, mad)
            ratio = x / med if med else None
            res.peer_groups.append({"item_id": it.item_id, "peer_key": key, "source": src, "n": n,
                                    "median": med, "mad": mad, "unit_price": x, "modified_z": z})
            flagged = (z is not None and z >= self.s.modified_z_threshold and (ratio or 0) >= self.s.min_price_ratio) or \
                      (z is None and ratio is not None and ratio >= self.s.zero_mad_ratio)
            if flagged:
                excess = min(to_money((Decimal(str(x)) - Decimal(str(med))) * (it.quantity or Decimal(1))), it.total)
                res.anomalies.append(Anomaly(
                    "ABNORMAL_UNIT_PRICE", "RULE-BILL-002",
                    f"{it.description}: unit price {x:.2f} vs peer median {med:.2f}",
                    it.item_id, "ESTIMATED", excess, "MEDIUM",
                    {"unit_price": x, "peer_median": med, "peer_mad": mad, "modified_z": z, "peer_n": n,
                     "price_ratio": ratio, "peer_source": src,
                     "estimate_basis": "(unit_price - peer_median) x quantity"}, f"PRICE::{it.item_id}"))
            if it.quantity is not None and len(qtys) >= min_n:
                qm, qmad = robust_stats(qtys)
                qz = modified_z(float(it.quantity), qm, qmad)
                if qz is not None and qz >= self.s.modified_z_threshold:
                    res.anomalies.append(Anomaly(
                        "ABNORMAL_QUANTITY", "RULE-BILL-007",
                        f"{it.description}: quantity {it.quantity} vs peer median {qm:.1f}", it.item_id,
                        "UNQUANTIFIED", None, "LOW",
                        {"quantity": it.quantity, "peer_median": qm, "peer_mad": qmad, "modified_z": qz, "peer_n": len(qtys)},
                        f"QTYPEER::{it.item_id}"))

        # (3) overall invoice vs provider-type peers
        peers = [float(r.total) for r in ctx.history if r.total is not None and
                 (not ctx.provider_type or not r.provider_type or r.provider_type.upper() == ctx.provider_type)]
        if len(peers) >= min_n:
            med, mad = robust_stats(peers)
            z = modified_z(float(ctx.claim_amount), med, mad)
            if z is not None and z >= self.s.modified_z_threshold:
                res.anomalies.append(Anomaly(
                    "UNUSUAL_PROVIDER_BILLING", "RULE-BILL-004",
                    f"Invoice total {ctx.claim_amount} is unusually high vs peer median {med:.2f}", None,
                    "UNQUANTIFIED", None, "MEDIUM",
                    {"claim_amount": ctx.claim_amount, "peer_median": med, "peer_mad": mad, "modified_z": z,
                     "peer_n": len(peers)}, "PROVIDER-TOTAL"))
        else:
            res.insufficient_evidence.append({"check": "INVOICE_TOTAL_PEER_COMPARISON", "peer_samples": len(peers),
                                              "required": min_n})

        # (4) repeat billing pattern for the same patient
        if ctx.patient_id and ctx.incident_ref_date:
            for it in ctx.items:
                if any(k in it.desc_norm for k in self.s.repeatable_service_keywords):
                    continue
                key = (it.service_code or "").upper() or it.desc_norm
                count = 1
                for r in ctx.history:
                    if r.patient_id != ctx.patient_id:
                        continue
                    d = r.incident_date or r.invoice_date
                    if d is None or abs((ctx.incident_ref_date - d).days) > self.s.repeat_billing_window_days:
                        continue
                    if any((str(ri.get("service_code") or "").upper() or norm_text(ri.get("description"))) == key
                           for ri in r.items):
                        count += 1
                if count >= self.s.repeat_billing_min_occurrences:
                    res.anomalies.append(Anomaly(
                        "REPEAT_BILLING_PATTERN", "RULE-BILL-005",
                        f"{it.description} billed {count} times in {self.s.repeat_billing_window_days} days",
                        it.item_id, "UNQUANTIFIED", None, "LOW",
                        {"occurrences": count, "window_days": self.s.repeat_billing_window_days, "key": key},
                        f"REPEAT::{it.item_id}", component="historical_patterns"))

        # (5) configured incompatible combinations
        present = {it.service_code for it in ctx.items if it.service_code} | {c for c in cat.values() if c}
        for pair in self.s.incompatible_combinations:
            if len(pair) == 2 and pair[0].upper() in present and pair[1].upper() in present:
                res.anomalies.append(Anomaly(
                    "UNUSUAL_PROCEDURE_COMBINATION", "RULE-BILL-006",
                    f"Configured incompatible combination billed together: {pair[0]} + {pair[1]}", None,
                    "UNQUANTIFIED", None, "MEDIUM", {"pair": pair}, f"COMBO::{pair[0]}::{pair[1]}"))
        return res
