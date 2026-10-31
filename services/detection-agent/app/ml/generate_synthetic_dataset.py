"""Generate a synthetic Indian health/motor claims dataset for training and demos.

Why this exists: the ML scripts need a labelled dataset, and the public dataset referenced in the
README needs network access and is generically Western-motor shaped. This generator produces data
with the column names `preprocessing.resolve_columns` already understands, so the real training
scripts run against it unchanged.

What it is NOT: real claims data. The label here is produced by a known generative process, so a
model trained on it learns that process -- good enough to exercise and demo the inference path,
worthless as evidence about real leakage. Every artefact trained from it is stamped
`synthetic: true` so nothing downstream can mistake it for a validated model.

  python -m app.ml.generate_synthetic_dataset --rows 60000
"""
from __future__ import annotations

import argparse
import logging
from datetime import date, timedelta
from pathlib import Path

import numpy as np
import pandas as pd

from app.core.config import BASE_DIR

log = logging.getLogger("generate_synthetic_dataset")

CLAIM_TYPES = ["HEALTH", "MOTOR", "GENERAL"]
CLAIM_TYPE_WEIGHTS = [0.62, 0.28, 0.10]
# Log-normal scale per claim type, in rupees: health admissions cluster higher than motor repairs.
TYPE_SCALE = {"HEALTH": (10.9, 0.75), "MOTOR": (9.9, 0.85), "GENERAL": (9.4, 0.95)}

PROVIDER_TYPES = ["HOSPITAL", "CLINIC", "DIAGNOSTIC_CENTRE", "GARAGE"]

# Item catalogue: (service_code, provider_type, fair unit price, spread). Used for the peer-price
# benchmarks the anomaly engine consults when a claim has too little history of its own.
ITEM_CATALOGUE = [
    ("ROOM-GEN", "HOSPITAL", 4200, 0.22), ("ROOM-PVT", "HOSPITAL", 7800, 0.25),
    ("ICU-001", "HOSPITAL", 11500, 0.20), ("NURS-001", "HOSPITAL", 1200, 0.25),
    ("SURG-APP", "HOSPITAL", 48000, 0.28), ("SURG-CAT", "HOSPITAL", 32000, 0.26),
    ("DOC-CONS", "HOSPITAL", 1100, 0.30), ("DOC-CONS", "CLINIC", 700, 0.30),
    ("DIAG-CBC", "DIAGNOSTIC_CENTRE", 450, 0.28), ("DIAG-CBC", "HOSPITAL", 620, 0.30),
    ("DIAG-MRI", "DIAGNOSTIC_CENTRE", 7500, 0.24), ("DIAG-MRI", "HOSPITAL", 9200, 0.26),
    ("DIAG-XRAY", "DIAGNOSTIC_CENTRE", 550, 0.30), ("DIAG-USG", "DIAGNOSTIC_CENTRE", 1400, 0.26),
    ("PHARM-001", "HOSPITAL", 320, 0.45), ("CONS-GLOVE", "HOSPITAL", 90, 0.40),
    ("CONS-SYR", "HOSPITAL", 45, 0.42), ("AMB-001", "HOSPITAL", 1800, 0.30),
    ("MOT-PANEL", "GARAGE", 8200, 0.30), ("MOT-PAINT", "GARAGE", 5600, 0.28),
    ("MOT-LABOR", "GARAGE", 2400, 0.32), ("MOT-WSHLD", "GARAGE", 11000, 0.25),
]


def generate_claims(rows: int, seed: int = 42) -> pd.DataFrame:
    """Claim-level rows with a label generated from a known risk process."""
    rng = np.random.default_rng(seed)
    claim_type = rng.choice(CLAIM_TYPES, size=rows, p=CLAIM_TYPE_WEIGHTS)

    amount = np.empty(rows)
    for ct, (mu, sigma) in TYPE_SCALE.items():
        mask = claim_type == ct
        amount[mask] = rng.lognormal(mu, sigma, size=mask.sum())
    amount = np.round(np.clip(amount, 800, 4_000_000), 2)

    tenure = np.clip(rng.gamma(2.2, 14, rows), 1, 240).round()           # months as customer
    prev_claims = rng.poisson(1.3, rows)
    claim_freq = np.clip(rng.poisson(0.9, rows), 0, 12)
    filing_delay = np.clip(rng.gamma(2.0, 4.5, rows), 0, 365).round()
    deductible = rng.choice([0, 2500, 5000, 10000, 25000], size=rows, p=[0.22, 0.2, 0.3, 0.2, 0.08])

    n_holders, n_providers = max(rows // 6, 50), max(rows // 90, 25)
    holder_id = rng.integers(0, n_holders, rows)
    provider_idx = rng.integers(0, n_providers, rows)
    provider_type = rng.choice(PROVIDER_TYPES, size=n_providers, p=[0.45, 0.25, 0.2, 0.10])[provider_idx]
    # A small set of providers bills systematically above their peers; this is the signal the
    # provider-deviation feature is meant to pick up.
    hot_providers = set(rng.choice(n_providers, size=max(n_providers // 12, 1), replace=False).tolist())
    provider_inflation = np.array([1.45 if p in hot_providers else 1.0 for p in provider_idx])
    amount = np.round(amount * provider_inflation, 2)

    start = date(2024, 1, 1)
    incident_offset = rng.integers(0, 640, rows)
    incident_dates = [start + timedelta(days=int(d)) for d in incident_offset]
    filing_dates = [d + timedelta(days=int(x)) for d, x in zip(incident_dates, filing_delay)]

    # ---- label: a logistic function of standardised drivers, then sampled.
    # Keeping the process explicit (rather than hand-labelling) is what makes the resulting metrics
    # interpretable: the model is being asked to recover this, nothing more.
    type_median = pd.Series(amount).groupby(pd.Series(claim_type)).transform("median").to_numpy()
    amount_ratio = amount / np.clip(type_median, 1, None)
    z = (-3.15
         + 0.62 * np.log1p(np.clip(amount_ratio - 1, 0, None)) * 2.2   # unusually large for its type
         + 0.42 * (prev_claims >= 4)
         + 0.38 * (claim_freq >= 3)
         + 0.30 * (filing_delay > 45)
         + 0.45 * (tenure < 9)                                          # very new policyholder
         + 0.50 * np.isin(provider_idx, list(hot_providers))
         + rng.normal(0, 0.55, rows))
    label = rng.binomial(1, 1 / (1 + np.exp(-z)))

    return pd.DataFrame({
        "claim_id": [f"SYN-{i:08d}" for i in range(rows)],
        "policyholder_id": [f"PH-{h:06d}" for h in holder_id],
        "provider_id": [f"PRV-{p:05d}" for p in provider_idx],
        "provider_type": provider_type,
        "claim_type": claim_type,
        "claim_amount": amount,
        "deductible": deductible,
        "policyholder_tenure": tenure,
        "previous_claims_count": prev_claims,
        "claim_frequency": claim_freq,
        "filing_delay_days": filing_delay,
        "incident_date": incident_dates,
        "filing_date": filing_dates,
        "is_fraud_flagged_ground_truth": label,
    })


def generate_items(rows: int, seed: int = 42) -> pd.DataFrame:
    """Invoice-line rows for the peer-price benchmark file."""
    rng = np.random.default_rng(seed + 1)
    codes = rng.integers(0, len(ITEM_CATALOGUE), rows)
    out = []
    for i in codes:
        code, ptype, fair, spread = ITEM_CATALOGUE[i]
        # Mostly fair prices; a tail of genuine over-billing keeps the MAD realistic rather than tight.
        unit = fair * rng.lognormal(0, spread)
        if rng.random() < 0.04:
            unit *= rng.uniform(1.8, 3.2)
        out.append((code, ptype, round(float(unit), 2), int(rng.integers(1, 5))))
    return pd.DataFrame(out, columns=["service_code", "provider_type", "unit_price", "quantity"])


def main() -> None:
    logging.basicConfig(level=logging.INFO)
    ap = argparse.ArgumentParser(description="Generate the synthetic claims + billing-item datasets")
    ap.add_argument("--rows", type=int, default=60_000, help="claim-level rows")
    ap.add_argument("--item-rows", type=int, default=40_000, help="invoice-line rows")
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--output-dir", type=Path, default=BASE_DIR / "datasets")
    a = ap.parse_args()
    a.output_dir.mkdir(parents=True, exist_ok=True)

    claims = generate_claims(a.rows, a.seed)
    items = generate_items(a.item_rows, a.seed)
    claims_path = a.output_dir / "synthetic_claims.csv"
    items_path = a.output_dir / "billing_items.csv"
    claims.to_csv(claims_path, index=False)
    items.to_csv(items_path, index=False)
    rate = float(claims["is_fraud_flagged_ground_truth"].mean())
    log.info("Wrote %s (%d rows, positive rate %.4f)", claims_path, len(claims), rate)
    log.info("Wrote %s (%d rows, %d distinct service codes)", items_path, len(items), items["service_code"].nunique())
    log.warning("SYNTHETIC DATA: labels come from a known generative process. Use for pipeline "
                "exercise and demos only, never as evidence about real leakage.")


if __name__ == "__main__":
    main()
