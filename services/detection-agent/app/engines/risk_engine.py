"""Configurable risk aggregation: noisy-OR within and across components, de-duplicated by issue key."""
from __future__ import annotations

import math
from typing import Any

from app.core.config import Settings
from app.engines.leakage_engine import FindingDraft


class RiskEngine:
    def __init__(self, settings: Settings):
        self.s = settings

    def level(self, score: int) -> str:
        t = self.s.risk_thresholds
        return ("CRITICAL" if score >= t["CRITICAL"] else "HIGH" if score >= t["HIGH"]
                else "MEDIUM" if score >= t["MEDIUM"] else "LOW")

    @staticmethod
    def _noisy_or(points: list[float]) -> float:
        return 100 * (1 - math.prod(1 - min(p, 100) / 100 for p in points)) if points else 0.0

    def score(self, drafts: list[FindingDraft], ml: dict[str, Any]) -> dict[str, Any]:
        sev = self.s.risk_severity_points
        best: dict[tuple[str, str], float] = {}
        for d in drafts:
            if d.review_status == "DISMISSED" or d.component in ("settlement", "ml_models"):
                continue  # settlement restates line findings; ML handled separately below
            pts = self.s.missing_evidence_points if d.component == "missing_evidence" else sev[d.severity]
            key = (d.component, d.issue_key)
            best[key] = max(best.get(key, 0.0), pts)
        comp_points: dict[str, list[float]] = {}
        for (comp, _), pts in best.items():
            comp_points.setdefault(comp, []).append(pts)

        ml_points: list[float] = []
        cb, iff = ml.get("catboost", {}), ml.get("isolation_forest", {})
        if cb.get("status") == "AVAILABLE" and cb.get("flagged"):
            ml_points.append(100 * float(cb["suspicion_score"]))
        if iff.get("status") == "AVAILABLE":
            ml_points.append({"HIGHLY_ANOMALOUS": 70.0, "ANOMALOUS": 45.0}.get(iff.get("classification"), 0.0))
        comp_points["ml_models"] = [p for p in ml_points if p > 0]

        components, residual = {}, []
        for comp, w in self.s.risk_weights.items():
            raw = self._noisy_or(comp_points.get(comp, []))
            if comp == "missing_evidence":
                raw = min(raw, 60.0)
            contribution = w * raw
            components[comp] = {"component_score": round(raw, 2), "weight": w, "contribution": round(contribution, 2),
                                "distinct_issues": len(comp_points.get(comp, []))}
            residual.append(contribution)
        total = int(round(self._noisy_or(residual)))
        ml_used = any(x.get("status") == "AVAILABLE" for x in (cb, iff))
        return {"risk_score": total, "risk_level": self.level(total), "leakage_chance": None,
                "assessment_status": "RULE_BASED_WITH_ML_SIGNALS" if ml_used else "RULE_BASED",
                "components": components}
