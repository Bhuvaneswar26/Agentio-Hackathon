"""SHAP explanations for CatBoost. Text is templated from computed values — never LLM generated."""
from __future__ import annotations

import logging
from typing import Any

import numpy as np
import pandas as pd

log = logging.getLogger(__name__)


def shap_values_for(model, pool) -> tuple[np.ndarray, float | None, str]:
    try:
        import shap

        sv = np.asarray(shap.TreeExplainer(model).shap_values(pool))
        base = None
        return sv.reshape(sv.shape[-2:] if sv.ndim > 2 else (1, -1))[0], base, "shap.TreeExplainer"
    except Exception as exc:  # fall back to CatBoost's exact native TreeSHAP
        log.debug("shap library path failed (%s); using CatBoost native ShapValues", exc)
        raw = model.get_feature_importance(pool, type="ShapValues")
        return np.asarray(raw)[0][:-1], float(np.asarray(raw)[0][-1]), "catboost_native_treeshap"


def explain_catboost(model, row: pd.DataFrame, pool, top_k: int = 5) -> dict[str, Any]:
    vals, base, method = shap_values_for(model, pool)
    feats = list(row.columns)
    contribs = []
    for name, v in zip(feats, vals):
        raw = row.iloc[0][name]
        value = None if (isinstance(raw, float) and np.isnan(raw)) else (raw.item() if hasattr(raw, "item") else raw)
        up = float(v) > 0
        contribs.append({
            "feature": name, "value": value, "shap_value": round(float(v), 5),
            "direction": "INCREASES_RISK" if up else ("DECREASES_RISK" if float(v) < 0 else "NEUTRAL"),
            "explanation": (f"{name}={value if value is not None else 'missing'} "
                            f"{'raises' if up else 'lowers'} the model's suspicion score (SHAP {float(v):+.4f})"),
        })
    contribs.sort(key=lambda c: abs(c["shap_value"]), reverse=True)
    return {"method": method, "base_value": base, "top_contributors": contribs[:top_k]}
