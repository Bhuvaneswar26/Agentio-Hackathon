"""Evidence helpers: every finding carries structured, source-attributed evidence (never free-text invention)."""
from __future__ import annotations

from typing import Any

from app.core.utils import jsonable


def ev(kind: str, source: str, **data: Any) -> dict[str, Any]:
    return jsonable({"type": kind, "source": source, **data})
