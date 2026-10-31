from __future__ import annotations

from decimal import Decimal
from enum import Enum
from typing import Annotated

from pydantic import PlainSerializer

# Decimal in memory (exact arithmetic), JSON number on the wire.
Money = Annotated[Decimal, PlainSerializer(lambda v: float(v), return_type=float, when_used="json")]


class ClaimType(str, Enum):
    HEALTH = "HEALTH"
    MOTOR = "MOTOR"
    GENERAL = "GENERAL"


class Severity(str, Enum):
    LOW = "LOW"
    MEDIUM = "MEDIUM"
    HIGH = "HIGH"
    CRITICAL = "CRITICAL"


class AmountType(str, Enum):
    CALCULATED = "CALCULATED"
    ESTIMATED = "ESTIMATED"
    UNQUANTIFIED = "UNQUANTIFIED"


class ReviewStatus(str, Enum):
    PENDING = "PENDING"
    CONFIRMED = "CONFIRMED"
    DISMISSED = "DISMISSED"
    EVIDENCE_REQUESTED = "EVIDENCE_REQUESTED"
    CORRECTED = "CORRECTED"


class ReviewAction(str, Enum):
    CONFIRM = "CONFIRM"
    DISMISS = "DISMISS"
    REQUEST_EVIDENCE = "REQUEST_EVIDENCE"
    CORRECT = "CORRECT"


class JobStatus(str, Enum):
    QUEUED = "QUEUED"
    PROCESSING = "PROCESSING"
    COMPLETED = "COMPLETED"
    VALIDATION_FAILED = "VALIDATION_FAILED"
    FAILED = "FAILED"
