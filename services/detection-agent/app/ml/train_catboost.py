"""Train the supervised claim-risk CatBoost model.

Usage:
  python -m app.ml.train_catboost --source ziadatalabs/FreeInsuranceClaims100M --max-rows 500000
  python -m app.ml.train_catboost --source datasets/claims.parquet
The script inspects the real dataset schema first and writes reports/schema_report.json.
"""
from __future__ import annotations

import argparse
import json
import logging
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd
from catboost import CatBoostClassifier, Pool
from sklearn.metrics import (average_precision_score, confusion_matrix, f1_score, precision_recall_curve,
                             precision_score, recall_score)

from app.core.config import BASE_DIR
from app.ml.preprocessing import (CAT_FEATURES, CATBOOST_FEATURES, DEFAULT_DATASET, TARGET, build_feature_frame,
                                  coerce_target, inspect_schema, load_dataset, resolve_columns, robust_group_stats,
                                  split_frame)

log = logging.getLogger("train_catboost")


def _metrics(y_true, proba, thr: float) -> dict:
    pred = (proba >= thr).astype(int)
    tn, fp, fn, tp = confusion_matrix(y_true, pred, labels=[0, 1]).ravel()
    return {"threshold": thr, "precision": float(precision_score(y_true, pred, zero_division=0)),
            "recall": float(recall_score(y_true, pred, zero_division=0)),
            "f1": float(f1_score(y_true, pred, zero_division=0)),
            "pr_auc": float(average_precision_score(y_true, proba)),
            "positive_rate": float(np.mean(y_true)),
            "confusion_matrix": {"tn": int(tn), "fp": int(fp), "fn": int(fn), "tp": int(tp)}}


def train(source: str, out_dir: Path, report_dir: Path, max_rows: int = 500_000, seed: int = 42,
          config: str | None = None, split: str = "train", target: str = TARGET, iterations: int = 600) -> dict:
    out_dir.mkdir(parents=True, exist_ok=True)
    report_dir.mkdir(parents=True, exist_ok=True)
    df = load_dataset(source, max_rows, seed, config, split)
    mapping = resolve_columns(list(df.columns))
    schema = inspect_schema(df, mapping, target)
    (report_dir / "schema_report.json").write_text(json.dumps(schema, indent=2, default=str))
    if target not in df.columns:
        raise SystemExit(f"Target column '{target}' not found. See {report_dir/'schema_report.json'} for actual schema.")
    if not mapping.get("claim_amount"):
        raise SystemExit("No claim-amount column could be resolved; extend CANDIDATES in preprocessing.py")

    y = coerce_target(df[target])
    base = build_feature_frame(df, mapping)  # type stats are computed from the TRAIN rows below
    tr, va, te, split_kind = split_frame(base, y, seed=seed)
    type_stats = robust_group_stats(base.loc[tr, "claim_amount"], base.loc[tr, "claim_type"])
    f = build_feature_frame(df, mapping, type_stats=type_stats)

    feats = [c for c in CATBOOST_FEATURES if c in f.columns and f.loc[tr, c].notna().mean() > 0.05 or c in CAT_FEATURES]
    cat_idx = [feats.index(c) for c in CAT_FEATURES if c in feats]
    X = f[feats].copy()
    for c in feats:
        X[c] = X[c].astype(str) if c in CAT_FEATURES else pd.to_numeric(X[c], errors="coerce")

    pos = int(y.loc[tr].sum())
    if pos < 50:
        raise SystemExit(f"Only {pos} positive training rows; cannot train a reliable classifier")
    model = CatBoostClassifier(iterations=iterations, learning_rate=0.05, depth=6, loss_function="Logloss",
                               eval_metric="PRAUC", auto_class_weights="Balanced", random_seed=seed,
                               od_type="Iter", od_wait=50, verbose=100)
    model.fit(Pool(X.loc[tr], y.loc[tr], cat_features=cat_idx), eval_set=Pool(X.loc[va], y.loc[va], cat_features=cat_idx),
              use_best_model=True)

    pv = model.predict_proba(Pool(X.loc[va], cat_features=cat_idx))[:, 1]
    prec, rec, thr = precision_recall_curve(y.loc[va], pv)
    f1s = 2 * prec[:-1] * rec[:-1] / np.clip(prec[:-1] + rec[:-1], 1e-9, None)
    threshold = float(thr[int(np.argmax(f1s))]) if len(thr) else 0.5
    pt = model.predict_proba(Pool(X.loc[te], cat_features=cat_idx))[:, 1]
    metrics = {"validation": _metrics(y.loc[va], pv, threshold), "test": _metrics(y.loc[te], pt, threshold)}

    importance = dict(zip(feats, map(float, model.get_feature_importance())))
    shap_summary: dict[str, float] = {}
    try:
        sample = X.loc[te].head(2000)
        sv = model.get_feature_importance(Pool(sample, cat_features=cat_idx), type="ShapValues")
        shap_summary = dict(zip(feats, map(float, np.abs(sv[:, :-1]).mean(axis=0))))
    except Exception as exc:
        log.warning("SHAP summary failed: %s", exc)

    version = "catboost-" + datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S")
    model.save_model(str(out_dir / "catboost_claim_risk.cbm"), format="cbm")
    meta = {"version": version, "features": feats, "cat_features": [c for c in CAT_FEATURES if c in feats],
            "threshold": threshold, "type_stats": type_stats, "column_mapping": mapping, "split": split_kind,
            "metrics": metrics, "feature_importance": importance, "shap_mean_abs": shap_summary,
            "dataset": source, "rows": int(len(df)), "target": target, "trained_at": datetime.now(timezone.utc).isoformat(),
            "calibrated": False,
            "notes": "Scores are class-weighted and uncalibrated; not usable as a leakage probability."}
    (out_dir / "catboost_claim_risk.meta.json").write_text(json.dumps(meta, indent=2, default=str))
    (report_dir / "catboost_evaluation.json").write_text(json.dumps(meta, indent=2, default=str))
    t = metrics["test"]
    (report_dir / "catboost_evaluation.md").write_text(
        f"# CatBoost claim-risk evaluation\n\n- Dataset: `{source}` ({len(df)} rows sampled), split: **{split_kind}**\n"
        f"- Features: {', '.join(feats)}\n- Threshold (max F1 on validation): {threshold:.4f}\n\n"
        f"| Metric | Test |\n|---|---|\n| Precision | {t['precision']:.4f} |\n| Recall | {t['recall']:.4f} |\n"
        f"| F1 | {t['f1']:.4f} |\n| PR-AUC | {t['pr_auc']:.4f} (baseline = positive rate {t['positive_rate']:.4f}) |\n\n"
        f"Confusion matrix: `{t['confusion_matrix']}`\n\nFeature importance: `{importance}`\n")
    log.info("Saved model %s; test PR-AUC=%.4f F1=%.4f", version, t["pr_auc"], t["f1"])
    return meta


def main() -> None:
    logging.basicConfig(level=logging.INFO)
    ap = argparse.ArgumentParser()
    ap.add_argument("--source", default=DEFAULT_DATASET)
    ap.add_argument("--config")
    ap.add_argument("--split", default="train")
    ap.add_argument("--max-rows", type=int, default=500_000)
    ap.add_argument("--target", default=TARGET)
    ap.add_argument("--iterations", type=int, default=600)
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--output-dir", type=Path, default=BASE_DIR / "ml_models")
    ap.add_argument("--report-dir", type=Path, default=BASE_DIR / "reports")
    a = ap.parse_args()
    train(a.source, a.output_dir, a.report_dir, a.max_rows, a.seed, a.config, a.split, a.target, a.iterations)


if __name__ == "__main__":
    main()
