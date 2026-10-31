"""Environment-driven application configuration (all tunables live here)."""
from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

BASE_DIR = Path(__file__).resolve().parents[2]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_prefix="CG_", extra="ignore")

    app_name: str = "ClaimsGuard AI"
    environment: str = "development"
    log_level: str = "INFO"

    database_url: str = "postgresql+psycopg://claimsguard:claimsguard@localhost:5432/claimsguard"
    auto_create_tables: bool = True
    redis_url: str = "redis://localhost:6379/0"
    # sync: analyse inside the request | background: FastAPI background task | celery: Redis/Celery worker
    execution_mode: str = "sync"

    model_dir: Path = BASE_DIR / "ml_models"
    ml_enabled: bool = True
    ml_min_feature_coverage: float = 0.5

    supported_currencies: list[str] = ["INR", "USD", "EUR", "GBP", "AED", "SGD"]
    money_tolerance: float = 0.01

    # Settlement
    default_settlement_strategy: str = "DEDUCTIBLE_THEN_COPAY"
    # COVERED_PENDING_REVIEW | EXCLUDED_PENDING_REVIEW (what to do when policy is silent on an item)
    unknown_coverage_treatment: str = "COVERED_PENDING_REVIEW"

    # Duplicate detection
    near_duplicate_id_ratio: float = 80.0  # short ids score low per edit; amount, date and provider must also match
    near_duplicate_amount_tolerance: float = 0.02
    duplicate_window_days: int = 7
    repeatable_service_keywords: list[str] = [
        "dialysis", "physiotherapy", "chemotherapy", "radiotherapy", "rehabilitation", "follow up",
    ]

    # Billing anomalies
    min_peer_samples: int = 5
    modified_z_threshold: float = 3.5
    min_price_ratio: float = 1.25
    zero_mad_ratio: float = 1.5
    repeat_billing_min_occurrences: int = 3
    repeat_billing_window_days: int = 30
    # Pairs of service codes/categories that should not co-occur. Empty by default: supply clinical rules via config.
    incompatible_combinations: list[list[str]] = []

    # Risk scoring (noisy-OR across components; weight = max contribution of a component)
    risk_weights: dict[str, float] = Field(default_factory=lambda: {
        "policy_violations": 0.90, "duplicates": 0.90, "billing_anomalies": 0.60,
        "ml_models": 0.40, "historical_patterns": 0.50, "missing_evidence": 0.30,
    })
    risk_severity_points: dict[str, float] = Field(default_factory=lambda: {
        "LOW": 10.0, "MEDIUM": 25.0, "HIGH": 45.0, "CRITICAL": 70.0,
    })
    risk_thresholds: dict[str, int] = Field(default_factory=lambda: {"MEDIUM": 30, "HIGH": 60, "CRITICAL": 80})
    missing_evidence_points: float = 15.0


@lru_cache
def get_settings() -> Settings:
    return Settings()
