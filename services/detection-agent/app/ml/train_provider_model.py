"""Build provider/peer billing benchmarks (median/MAD). LightGBM is trained ONLY with reliable labels.

Item-level benchmarks (preferred; needs columns provider_type, service_code, unit_price):
  python -m app.ml.train_provider_model --items-csv datasets/billing_items.csv
Claim-level benchmarks from the claims dataset:
  python -m app.ml.train_provider_model --source <hf-dataset|csv|parquet>
Optional supervised model (requires --label-col with >= --min-positives labelled rows):
  python -m app.ml.train_provider_model --items-csv ... --label-col is_overbilled
"""
from __future__ import annotations

import argparse
import json
import logging
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd

from app.core.config import BASE_DIR
from app.ml.preprocessing import build_feature_frame, load_dataset, resolve_columns, robust_group_stats

log = logging.getLogger("train_provider_model")


def build_benchmarks(args) -> dict:
    out: dict = {"version": "benchmarks-" + datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S"),
                 "items": {}, "claim_types": {}, "providers": {}}
    if args.items_csv:
        it = pd.read_csv(args.items_csv)
        need = {"service_code", "unit_price"}
        if not need <= set(it.columns):
            raise SystemExit(f"{args.items_csv} must contain columns {sorted(need)} (+ optional provider_type)")
        it["provider_type"] = it.get("provider_type", pd.Series("*", index=it.index)).fillna("*").astype(str).str.upper()
        for scope, key in (("typed", it["provider_type"] + "|" + it["service_code"].astype(str).str.upper()),
                           ("any", "*|" + it["service_code"].astype(str).str.upper())):
            out["items"].update(robust_group_stats(pd.to_numeric(it["unit_price"], errors="coerce"), key, args.min_n))
    if args.source:
        df = load_dataset(args.source, args.max_rows, args.seed)
        mapping = resolve_columns(list(df.columns))
        f = build_feature_frame(df, mapping)
        out["claim_types"] = robust_group_stats(f["claim_amount"], f["claim_type"], args.min_n)
        if mapping.get("provider_id"):
            out["providers"] = robust_group_stats(f["claim_amount"], df[mapping["provider_id"]].astype(str), args.min_n)
    return out


def maybe_train_lgbm(args, out_dir: Path) -> dict:
    if not args.label_col or not args.items_csv:
        return {"trained": False, "reason": "no --label-col supplied; benchmarks only (statistical method)"}
    import lightgbm as lgb
    from sklearn.metrics import average_precision_score
    from sklearn.model_selection import train_test_split

    it = pd.read_csv(args.items_csv)
    if args.label_col not in it.columns:
        return {"trained": False, "reason": f"label column '{args.label_col}' missing"}
    y = it[args.label_col].astype(int)
    if y.sum() < args.min_positives:
        return {"trained": False, "reason": f"only {int(y.sum())} positive labels (< {args.min_positives}); not reliable"}
    X = pd.get_dummies(it.drop(columns=[args.label_col]).select_dtypes(include=["number", "object"]).fillna(0))
    Xtr, Xte, ytr, yte = train_test_split(X, y, test_size=0.2, stratify=y, random_state=args.seed)
    clf = lgb.LGBMClassifier(n_estimators=400, learning_rate=0.05, class_weight="balanced", random_state=args.seed)
    clf.fit(Xtr, ytr)
    pr = float(average_precision_score(yte, clf.predict_proba(Xte)[:, 1]))
    clf.booster_.save_model(str(out_dir / "provider_lgbm.txt"))
    return {"trained": True, "pr_auc_test": pr, "features": list(X.columns)}


def main() -> None:
    logging.basicConfig(level=logging.INFO)
    ap = argparse.ArgumentParser()
    ap.add_argument("--source")
    ap.add_argument("--items-csv")
    ap.add_argument("--label-col")
    ap.add_argument("--min-n", type=int, default=5)
    ap.add_argument("--min-positives", type=int, default=500)
    ap.add_argument("--max-rows", type=int, default=500_000)
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--output-dir", type=Path, default=BASE_DIR / "ml_models")
    ap.add_argument("--report-dir", type=Path, default=BASE_DIR / "reports")
    a = ap.parse_args()
    if not (a.source or a.items_csv):
        raise SystemExit("Provide --source and/or --items-csv")
    a.output_dir.mkdir(parents=True, exist_ok=True)
    a.report_dir.mkdir(parents=True, exist_ok=True)
    bench = build_benchmarks(a)
    bench["lightgbm"] = maybe_train_lgbm(a, a.output_dir)
    (a.output_dir / "provider_benchmarks.json").write_text(json.dumps(bench, indent=2))
    (a.report_dir / "provider_benchmark_report.json").write_text(json.dumps(
        {k: (len(v) if isinstance(v, dict) and k != "lightgbm" else v) for k, v in bench.items()}, indent=2))
    log.info("Benchmarks written: %s", {k: len(v) for k, v in bench.items() if isinstance(v, dict)})


if __name__ == "__main__":
    main()
