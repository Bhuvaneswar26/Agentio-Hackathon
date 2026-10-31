"""Dataset loading, schema inspection/resolution and feature construction (training + inference parity)."""
from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd

log = logging.getLogger(__name__)

DEFAULT_DATASET = "ziadatalabs/FreeInsuranceClaims100M"
TARGET = "is_fraud_flagged_ground_truth"

# canonical name -> candidate source column names (case-insensitive; exact match first, then substring)
CANDIDATES: dict[str, list[str]] = {
    "claim_amount": ["claim_amount", "total_claim_amount", "claim_amt", "amount_claimed", "amount"],
    "deductible": ["deductible", "policy_deductible", "deductible_amount"],
    "policyholder_tenure": ["policyholder_tenure", "tenure", "policy_tenure", "customer_tenure", "months_as_customer"],
    "previous_claims_count": ["previous_claims_count", "previous_claims", "prior_claims", "num_previous_claims",
                              "claims_history_count"],
    "claim_type": ["claim_type", "type_of_claim", "claim_category", "line_of_business"],
    "claim_frequency": ["claim_frequency", "claims_per_year", "claim_freq"],
    "filing_delay_days": ["filing_delay_days", "filing_delay", "days_to_file", "incident_to_filing_delay",
                          "report_delay", "reporting_delay"],
    "incident_date": ["incident_date", "loss_date", "date_of_loss", "accident_date"],
    "filing_date": ["filing_date", "claim_date", "date_filed", "claim_filed_date", "report_date", "claim_submission_date"],
    "policyholder_id": ["policyholder_id", "customer_id", "member_id", "policy_holder_id", "claimant_id"],
    "provider_id": ["provider_id", "hospital_id", "repair_shop_id", "provider"],
}
# Columns matching these tokens are post-claim / outcome information => never eligible as features.
LEAKAGE_PATTERNS = ("status", "resolution", "settle", "payout", "paid", "approved", "denied", "reject", "outcome",
                    "decision", "adjudicat", "investigat", "closed", "final", "recovery", "fraud")

CAT_FEATURES = ["claim_type"]
CATBOOST_FEATURES = ["claim_amount", "deductible", "policyholder_tenure", "previous_claims_count", "claim_type",
                     "amount_to_type_median", "claim_frequency", "filing_delay_days"]
IFOREST_FEATURES = ["claim_amount", "deductible", "previous_claims_count", "claim_amount_deviation",
                    "provider_billing_deviation", "claim_frequency"]


def load_dataset(source: str, max_rows: int = 500_000, seed: int = 42, config: str | None = None,
                 split: str = "train") -> pd.DataFrame:
    """Load a local csv/parquet file or stream a (shuffled) sample from the Hugging Face hub."""
    p = Path(source)
    if p.exists():
        df = pd.read_parquet(p) if p.suffix == ".parquet" else pd.read_csv(p)
        return df.sample(n=max_rows, random_state=seed) if len(df) > max_rows else df
    from datasets import load_dataset as hf_load  # lazy: only needed for hub sources

    ds = hf_load(source, config, split=split, streaming=True)
    ds = ds.shuffle(seed=seed, buffer_size=min(max_rows * 2, 200_000)).take(max_rows)
    return pd.DataFrame(list(ds))


def resolve_columns(columns: list[str]) -> dict[str, str | None]:
    lowered = {c.lower(): c for c in columns}
    out: dict[str, str | None] = {}
    for canon, cands in CANDIDATES.items():
        hit = next((lowered[c] for c in cands if c in lowered), None)
        if hit is None:
            hit = next((orig for low, orig in lowered.items() if any(c in low for c in cands[:3])
                        and not any(p in low for p in LEAKAGE_PATTERNS)), None)
        if hit is not None and any(p in hit.lower() for p in LEAKAGE_PATTERNS):
            raise ValueError(f"Resolved feature column '{hit}' for '{canon}' matches a leakage pattern")
        out[canon] = hit
    return out


def inspect_schema(df: pd.DataFrame, mapping: dict[str, str | None], target: str = TARGET) -> dict[str, Any]:
    leak = [c for c in df.columns if any(p in c.lower() for p in LEAKAGE_PATTERNS) and c != target]
    info: dict[str, Any] = {
        "rows_sampled": int(len(df)),
        "columns": {c: {"dtype": str(df[c].dtype), "null_rate": round(float(df[c].isna().mean()), 4)} for c in df.columns},
        "resolved_columns": mapping,
        "excluded_leakage_columns": leak,
        "target_column_present": target in df.columns,
    }
    if target in df.columns:
        info["target_distribution"] = {str(k): int(v) for k, v in df[target].value_counts(dropna=False).items()}
    return info


def coerce_target(s: pd.Series) -> pd.Series:
    if s.dtype == bool:
        return s.astype(int)
    if s.dtype == object:
        return s.astype(str).str.strip().str.lower().map(
            {"true": 1, "1": 1, "yes": 1, "y": 1, "false": 0, "0": 0, "no": 0, "n": 0}).fillna(0).astype(int)
    return pd.to_numeric(s, errors="coerce").fillna(0).astype(int)


def _num(df: pd.DataFrame, col: str | None) -> pd.Series:
    return pd.to_numeric(df[col], errors="coerce") if col else pd.Series(np.nan, index=df.index, dtype=float)


def build_feature_frame(df: pd.DataFrame, mapping: dict[str, str | None],
                        type_stats: dict[str, dict[str, float]] | None = None,
                        provider_stats: dict[str, dict[str, float]] | None = None) -> pd.DataFrame:
    """Canonical features for every model. type_stats/provider_stats must come from the TRAIN split only."""
    f = pd.DataFrame(index=df.index)
    f["claim_amount"] = _num(df, mapping.get("claim_amount"))
    f["deductible"] = _num(df, mapping.get("deductible"))
    f["policyholder_tenure"] = _num(df, mapping.get("policyholder_tenure"))
    ctype = mapping.get("claim_type")
    f["claim_type"] = df[ctype].astype(str).fillna("UNKNOWN") if ctype else "UNKNOWN"

    date_col = mapping.get("incident_date") or mapping.get("filing_date")
    ev_date = pd.to_datetime(df[date_col], errors="coerce") if date_col else pd.Series(pd.NaT, index=df.index)
    f["event_date"] = ev_date

    prev = mapping.get("previous_claims_count")
    if prev:
        f["previous_claims_count"] = _num(df, prev)
    elif mapping.get("policyholder_id") and date_col:
        order = ev_date.sort_values().index
        tmp = df.loc[order, mapping["policyholder_id"]]
        f.loc[order, "previous_claims_count"] = tmp.groupby(tmp).cumcount().astype(float).values
    else:
        f["previous_claims_count"] = np.nan

    freq = mapping.get("claim_frequency")
    f["claim_frequency"] = _num(df, freq) if freq else np.nan

    delay = mapping.get("filing_delay_days")
    if delay:
        f["filing_delay_days"] = _num(df, delay)
    elif mapping.get("incident_date") and mapping.get("filing_date"):
        inc = pd.to_datetime(df[mapping["incident_date"]], errors="coerce")
        fil = pd.to_datetime(df[mapping["filing_date"]], errors="coerce")
        f["filing_delay_days"] = (fil - inc).dt.days.astype(float)
    else:
        f["filing_delay_days"] = np.nan

    ts = type_stats or {}
    med = f["claim_type"].map(lambda t: ts.get(t, {}).get("median", np.nan)).astype(float)
    mad = f["claim_type"].map(lambda t: ts.get(t, {}).get("mad", np.nan)).astype(float)
    f["amount_to_type_median"] = f["claim_amount"] / med.replace(0, np.nan)
    f["claim_amount_deviation"] = 0.6745 * (f["claim_amount"] - med) / mad.replace(0, np.nan)

    pid = mapping.get("provider_id")
    if pid and provider_stats:
        pm = df[pid].astype(str).map(lambda p: provider_stats.get(p, {}).get("median", np.nan)).astype(float)
        pmad = df[pid].astype(str).map(lambda p: provider_stats.get(p, {}).get("mad", np.nan)).astype(float)
        f["provider_billing_deviation"] = 0.6745 * (f["claim_amount"] - pm) / pmad.replace(0, np.nan)
    else:
        f["provider_billing_deviation"] = np.nan
    return f


def robust_group_stats(values: pd.Series, groups: pd.Series, min_n: int = 5) -> dict[str, dict[str, float]]:
    out: dict[str, dict[str, float]] = {}
    for g, s in values.groupby(groups):
        s = s.dropna()
        if len(s) >= min_n:
            m = float(s.median())
            out[str(g)] = {"median": m, "mad": float((s - m).abs().median()), "count": int(len(s))}
    return out


def split_frame(f: pd.DataFrame, y: pd.Series, test_size: float = 0.15, val_size: float = 0.15, seed: int = 42):
    """Chronological split when an event date exists, otherwise stratified random."""
    n = len(f)
    if f["event_date"].notna().mean() > 0.9:
        order = f["event_date"].sort_values(kind="stable").index
        a, b = int(n * (1 - test_size - val_size)), int(n * (1 - test_size))
        return order[:a], order[a:b], order[b:], "temporal"
    from sklearn.model_selection import train_test_split

    idx = f.index
    tr, te = train_test_split(idx, test_size=test_size, stratify=y, random_state=seed)
    tr, va = train_test_split(tr, test_size=val_size / (1 - test_size), stratify=y.loc[tr], random_state=seed)
    return tr, va, te, "stratified_random"
