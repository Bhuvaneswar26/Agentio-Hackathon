"""Model registry + inference. Missing/unsuitable models degrade gracefully; nothing is fabricated."""
from __future__ import annotations

import json
import logging
from datetime import date
from functools import lru_cache
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd

from app.core.config import Settings
from app.core.utils import jsonable
from app.ml.explainability import explain_catboost
from app.services.normalization_service import ClaimContext

log = logging.getLogger(__name__)

DOMAIN_WARNING = ("CatBoost/IsolationForest are trained on a generic insurance-claims dataset. Outputs are "
                  "uncalibrated secondary signals for review prioritisation, not leakage probabilities, and may "
                  "not transfer to Indian health-insurance billing.")


class ModelRegistry:
    def __init__(self, model_dir: Path):
        self.model_dir = Path(model_dir)
        self.catboost = self.cb_meta = self.iforest = self.if_bundle = self.benchmarks = None
        self.status: dict[str, dict[str, Any]] = {}
        self._load()

    def _load(self) -> None:
        cbm, meta = self.model_dir / "catboost_claim_risk.cbm", self.model_dir / "catboost_claim_risk.meta.json"
        if cbm.exists() and meta.exists():
            try:
                from catboost import CatBoostClassifier

                self.catboost = CatBoostClassifier().load_model(str(cbm))
                self.cb_meta = json.loads(meta.read_text())
                self.status["catboost"] = {"status": "AVAILABLE", "version": self.cb_meta.get("version")}
            except Exception as exc:
                self.status["catboost"] = {"status": "UNAVAILABLE", "reason": f"load error: {exc}"}
        else:
            self.status["catboost"] = {"status": "UNAVAILABLE", "reason": "model artefacts not found; run train_catboost.py"}
        ifp = self.model_dir / "isolation_forest.joblib"
        if ifp.exists():
            try:
                import joblib

                self.if_bundle = joblib.load(ifp)
                self.status["isolation_forest"] = {"status": "AVAILABLE", "version": self.if_bundle.get("version")}
            except Exception as exc:
                self.status["isolation_forest"] = {"status": "UNAVAILABLE", "reason": f"load error: {exc}"}
        else:
            self.status["isolation_forest"] = {"status": "UNAVAILABLE", "reason": "model artefact not found; run train_isolation_forest.py"}
        bp = self.model_dir / "provider_benchmarks.json"
        if bp.exists():
            try:
                self.benchmarks = json.loads(bp.read_text())
                self.status["provider_benchmark"] = {"status": "AVAILABLE", "version": self.benchmarks.get("version")}
            except Exception as exc:
                self.status["provider_benchmark"] = {"status": "UNAVAILABLE", "reason": str(exc)}
        else:
            self.status["provider_benchmark"] = {"status": "UNAVAILABLE", "reason": "benchmark file not found"}

    def versions(self) -> dict[str, Any]:
        return {k: v.get("version") for k, v in self.status.items() if v.get("status") == "AVAILABLE"}


@lru_cache(maxsize=4)
def get_registry(model_dir: str) -> ModelRegistry:
    return ModelRegistry(Path(model_dir))


def build_inference_features(ctx: ClaimContext) -> dict[str, float | str | None]:
    claim, policy = ctx.request.claim, ctx.request.policy
    ref = ctx.incident_ref_date
    mine = [r for r in ctx.history if r.source == "previous_claims" and r.claim_id != claim.claim_id]
    prev_count = float(len(mine)) if ctx.request.history.previous_claims is not None else None
    in_year = [r for r in mine if ref and (r.incident_date or r.invoice_date) and
               0 <= (ref - (r.incident_date or r.invoice_date)).days <= 365]
    extra = (claim.claimant.model_extra or {}) if claim.claimant else {}
    tenure = extra.get("policyholder_tenure", extra.get("tenure"))
    inv = claim.invoice
    delay = None
    if inv and inv.invoice_date and claim.incident and claim.incident.incident_date:
        delay = float((inv.invoice_date - claim.incident.incident_date).days)
    provider_amounts = [float(r.total) for r in ctx.history if r.total is not None and r.provider_id
                        and r.provider_id == ctx.provider_id]
    prov_dev = None
    if len(provider_amounts) >= 5:
        med = float(np.median(provider_amounts))
        mad = float(np.median(np.abs(np.array(provider_amounts) - med)))
        prov_dev = 0.6745 * (float(ctx.claim_amount) - med) / mad if mad else None
    return {
        "claim_amount": float(ctx.claim_amount),
        "deductible": float(policy.deductible) if policy.deductible is not None else None,
        "policyholder_tenure": float(tenure) if isinstance(tenure, (int, float)) else None,
        "previous_claims_count": prev_count,
        "claim_type": claim.claim_type.value,
        "claim_frequency": float(len(in_year)) if ref else None,
        "filing_delay_days": delay,
        "provider_billing_deviation": prov_dev,
    }


def _coverage(feats: dict, names: list[str]) -> tuple[float, list[str]]:
    missing = [n for n in names if feats.get(n) is None or (isinstance(feats.get(n), float) and np.isnan(feats[n]))]
    return 1 - len(missing) / max(len(names), 1), missing


def run_models(ctx: ClaimContext, registry: ModelRegistry, settings: Settings) -> dict[str, Any]:
    out: dict[str, Any] = {"applicability_warning": DOMAIN_WARNING, "model_versions": registry.versions()}
    out["duplicate_detection"] = {"type": "deterministic", "methods": ["SHA256 composite keys", "RapidFuzz"]}
    out["provider_benchmark"] = {**registry.status.get("provider_benchmark", {}),
                                 "method": "median/MAD peer-group statistics (history + benchmark file)"}
    if not settings.ml_enabled or not ctx.request.options.run_ml:
        out["catboost"] = out["isolation_forest"] = {"status": "DISABLED"}
        return out
    feats = build_inference_features(ctx)
    out["input_features"] = feats

    # ---- CatBoost supervised claim risk
    if registry.catboost is None:
        out["catboost"] = registry.status["catboost"]
    else:
        meta = registry.cb_meta
        names = meta["features"]
        enriched = dict(feats)
        ts = meta.get("type_stats", {}).get(feats["claim_type"])
        enriched["amount_to_type_median"] = (feats["claim_amount"] / ts["median"]) if ts and ts.get("median") else None
        cov, missing = _coverage(enriched, [n for n in names if n != "claim_type"])
        if cov < settings.ml_min_feature_coverage:
            out["catboost"] = {"status": "INSUFFICIENT_FEATURES", "feature_coverage": round(cov, 3),
                               "missing_features": missing, "required_coverage": settings.ml_min_feature_coverage}
        else:
            try:
                from catboost import Pool

                row = pd.DataFrame([{n: enriched.get(n) for n in names}])
                for n in names:
                    row[n] = row[n].astype(str) if n in meta["cat_features"] else pd.to_numeric(row[n], errors="coerce")
                pool = Pool(row, cat_features=[names.index(c) for c in meta["cat_features"]])
                p = float(registry.catboost.predict_proba(pool)[0][1])
                thr = float(meta["threshold"])
                out["catboost"] = {
                    "status": "AVAILABLE", "version": meta.get("version"),
                    "suspicion_score": round(p, 5), "decision_threshold": thr, "flagged": p >= thr,
                    "score_type": "UNCALIBRATED_CLASSIFIER_SCORE (class-weighted; not a leakage probability)",
                    "feature_coverage": round(cov, 3), "missing_features": missing,
                    "explanation": explain_catboost(registry.catboost, row, pool),
                    "validation_metrics": meta.get("metrics", {}).get("test", {}),
                }
            except Exception as exc:  # never fail the analysis because of ML
                log.exception("catboost inference failed")
                out["catboost"] = {"status": "ERROR", "reason": str(exc)}

    # ---- Isolation Forest
    if registry.if_bundle is None:
        out["isolation_forest"] = registry.status["isolation_forest"]
    else:
        b = registry.if_bundle
        names = b["features"]
        enriched = dict(feats)
        ts = b.get("type_stats", {}).get(feats["claim_type"])
        enriched["claim_amount_deviation"] = (0.6745 * (feats["claim_amount"] - ts["median"]) / ts["mad"]
                                              if ts and ts.get("mad") else None)
        cov, missing = _coverage(enriched, names)
        if cov < settings.ml_min_feature_coverage:
            out["isolation_forest"] = {"status": "INSUFFICIENT_FEATURES", "feature_coverage": round(cov, 3),
                                       "missing_features": missing}
        else:
            try:
                X = pd.DataFrame([{n: (np.nan if enriched.get(n) is None else float(enriched[n])) for n in names}])
                score = float(b["pipeline"].decision_function(X)[0])
                q = np.asarray(b["score_quantiles"])  # ascending training decision scores (101 pts)
                pct_more_anomalous = float((q < score).mean() * 100)
                cls = ("HIGHLY_ANOMALOUS" if score <= b["thresholds"]["p1"]
                       else "ANOMALOUS" if score <= b["thresholds"]["p5"] else "NORMAL")
                contrib = []
                for n in names:
                    st = b["feature_stats"].get(n)
                    if st and enriched.get(n) is not None and st["mad"]:
                        contrib.append({"feature": n, "value": float(enriched[n]), "training_median": st["median"],
                                        "robust_z": round(0.6745 * (float(enriched[n]) - st["median"]) / st["mad"], 3)})
                contrib.sort(key=lambda c: abs(c["robust_z"]), reverse=True)
                out["isolation_forest"] = {
                    "status": "AVAILABLE", "version": b.get("version"), "anomaly_score": round(score, 5),
                    "score_type": "ISOLATION_FOREST_DECISION_FUNCTION (lower = more anomalous; NOT a probability)",
                    "training_percentile_rank_anomalous": round(100 - pct_more_anomalous, 2),
                    "classification": cls, "contributing_features": contrib[:3],
                    "contribution_method": "robust z-score vs training distribution (descriptive, not causal)",
                    "investigation_recommendation": ("Route for manual investigation" if cls != "NORMAL"
                                                     else "No additional investigation indicated by this model"),
                    "feature_coverage": round(cov, 3), "missing_features": missing,
                }
            except Exception as exc:
                log.exception("isolation forest inference failed")
                out["isolation_forest"] = {"status": "ERROR", "reason": str(exc)}
    return jsonable(out)
