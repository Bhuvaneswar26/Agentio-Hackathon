"""Train the unsupervised Isolation Forest (labels are NOT used for fitting; only for a sanity AUC if present).

Usage: python -m app.ml.train_isolation_forest --source <hf-dataset|csv|parquet>
"""
from __future__ import annotations

import argparse
import json
import logging
from datetime import datetime, timezone
from pathlib import Path

import joblib
import numpy as np
import pandas as pd
from sklearn.ensemble import IsolationForest
from sklearn.impute import SimpleImputer
from sklearn.metrics import roc_auc_score
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import RobustScaler

from app.core.config import BASE_DIR
from app.ml.preprocessing import (DEFAULT_DATASET, IFOREST_FEATURES, TARGET, build_feature_frame, coerce_target,
                                  inspect_schema, load_dataset, resolve_columns, robust_group_stats, split_frame)

log = logging.getLogger("train_isolation_forest")


def train(source: str, out_dir: Path, report_dir: Path, max_rows: int = 500_000, seed: int = 42,
          config: str | None = None, split: str = "train", target: str = TARGET) -> dict:
    out_dir.mkdir(parents=True, exist_ok=True)
    report_dir.mkdir(parents=True, exist_ok=True)
    df = load_dataset(source, max_rows, seed, config, split)
    mapping = resolve_columns(list(df.columns))
    (report_dir / "schema_report_iforest.json").write_text(json.dumps(inspect_schema(df, mapping, target), indent=2, default=str))
    if not mapping.get("claim_amount"):
        raise SystemExit("No claim-amount column could be resolved")

    base = build_feature_frame(df, mapping)
    y = coerce_target(df[target]) if target in df.columns else pd.Series(0, index=df.index)
    tr, _, te, _ = split_frame(base, y if y.sum() > 1 else pd.Series(np.arange(len(df)) % 2, index=df.index), seed=seed)
    type_stats = robust_group_stats(base.loc[tr, "claim_amount"], base.loc[tr, "claim_type"])
    prov_stats = {}
    if mapping.get("provider_id"):
        prov_stats = robust_group_stats(base.loc[tr, "claim_amount"], df.loc[tr, mapping["provider_id"]].astype(str))
    f = build_feature_frame(df, mapping, type_stats=type_stats, provider_stats=prov_stats)

    feats = [c for c in IFOREST_FEATURES if f.loc[tr, c].notna().mean() > 0.2]
    if len(feats) < 2:
        raise SystemExit(f"Too few usable features ({feats}); cannot train a meaningful anomaly model")
    X = f[feats].apply(pd.to_numeric, errors="coerce").replace([np.inf, -np.inf], np.nan)
    pipe = Pipeline([("impute", SimpleImputer(strategy="median")), ("scale", RobustScaler()),
                     ("iforest", IsolationForest(n_estimators=300, contamination="auto", random_state=seed, n_jobs=-1))])
    pipe.fit(X.loc[tr])
    train_scores = pipe.decision_function(X.loc[tr])
    stats = {c: {"median": float(X.loc[tr, c].median()),
                 "mad": float((X.loc[tr, c] - X.loc[tr, c].median()).abs().median())} for c in feats}
    version = "iforest-" + datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S")
    report = {"version": version, "features": feats, "rows_trained": int(len(tr)), "dataset": source}
    if target in df.columns and y.loc[te].nunique() > 1:
        report["sanity_roc_auc_vs_labels_test"] = float(roc_auc_score(y.loc[te], -pipe.decision_function(X.loc[te])))
        report["note"] = "Labels used only for evaluation; the model is unsupervised."
    bundle = {"pipeline": pipe, "features": feats, "version": version, "dataset": source,
              "score_quantiles": np.quantile(train_scores, np.linspace(0, 1, 101)).tolist(),
              "thresholds": {"p1": float(np.quantile(train_scores, 0.01)), "p5": float(np.quantile(train_scores, 0.05))},
              "feature_stats": stats, "type_stats": type_stats, "column_mapping": mapping,
              "trained_at": datetime.now(timezone.utc).isoformat()}
    joblib.dump(bundle, out_dir / "isolation_forest.joblib")
    (report_dir / "isolation_forest_evaluation.json").write_text(json.dumps({**report, "thresholds": bundle["thresholds"]}, indent=2))
    log.info("Saved %s %s", version, report)
    return report


def main() -> None:
    logging.basicConfig(level=logging.INFO)
    ap = argparse.ArgumentParser()
    ap.add_argument("--source", default=DEFAULT_DATASET)
    ap.add_argument("--config")
    ap.add_argument("--split", default="train")
    ap.add_argument("--max-rows", type=int, default=500_000)
    ap.add_argument("--target", default=TARGET)
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--output-dir", type=Path, default=BASE_DIR / "ml_models")
    ap.add_argument("--report-dir", type=Path, default=BASE_DIR / "reports")
    a = ap.parse_args()
    train(a.source, a.output_dir, a.report_dir, a.max_rows, a.seed, a.config, a.split, a.target)


if __name__ == "__main__":
    main()
