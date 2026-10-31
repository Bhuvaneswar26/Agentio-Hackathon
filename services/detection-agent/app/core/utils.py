"""Small, dependency-free helpers shared across the package."""
from __future__ import annotations

import dataclasses
import hashlib
import re
from datetime import date, datetime
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation
from enum import Enum
from typing import Any

CENT = Decimal("0.01")
ZERO = Decimal("0")


def to_money(v: Any) -> Decimal:
    return Decimal(str(v)).quantize(CENT, ROUND_HALF_UP)


def parse_decimal(v: Any) -> Decimal | None:
    if v is None or v == "" or isinstance(v, bool):
        return None
    try:
        return Decimal(str(v))
    except InvalidOperation:
        return None


def parse_date(v: Any) -> date | None:
    if isinstance(v, datetime):
        return v.date()
    if isinstance(v, date):
        return v
    if isinstance(v, str) and v.strip():
        try:
            return date.fromisoformat(v.strip()[:10])
        except ValueError:
            return None
    return None


def get_path(data: dict, *paths: str, default: Any = None) -> Any:
    """Return the first non-empty value found at any dotted path."""
    for path in paths:
        cur: Any = data
        for key in path.split("."):
            if isinstance(cur, dict) and key in cur:
                cur = cur[key]
            else:
                cur = None
                break
        if cur not in (None, ""):
            return cur
    return default


def norm_text(s: Any) -> str:
    return re.sub(r"[^a-z0-9]+", " ", str(s or "").lower()).strip()


def sha256_key(*parts: Any) -> str:
    return hashlib.sha256("|".join("" if p is None else str(p) for p in parts).encode()).hexdigest()


def jsonable(obj: Any) -> Any:
    """Recursively convert to JSON-safe primitives (Decimal -> float)."""
    if obj is None or isinstance(obj, (str, int, bool)):
        return obj
    if isinstance(obj, float):
        return None if obj != obj else obj
    if isinstance(obj, Decimal):
        return float(obj)
    if isinstance(obj, (date, datetime)):
        return obj.isoformat()
    if isinstance(obj, Enum):
        return obj.value
    if hasattr(obj, "model_dump"):
        return jsonable(obj.model_dump(mode="python"))
    if dataclasses.is_dataclass(obj) and not isinstance(obj, type):
        return jsonable({f.name: getattr(obj, f.name) for f in dataclasses.fields(obj)})
    if isinstance(obj, dict):
        return {str(k): jsonable(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple, set, frozenset)):
        return [jsonable(v) for v in obj]
    try:  # numpy scalars
        import numpy as np

        if isinstance(obj, np.generic):
            return jsonable(obj.item())
    except ImportError:  # pragma: no cover
        pass
    return str(obj)
