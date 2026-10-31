"""Normalization: builds the immutable ClaimContext every engine consumes."""
from __future__ import annotations

import copy
import re
from dataclasses import dataclass, field
from datetime import date
from decimal import Decimal
from typing import Any

from app.core.config import Settings
from app.core.utils import ZERO, get_path, norm_text, parse_date, parse_decimal, to_money
from app.schemas.input_schema import AnalyzeRequest

_PROVIDER_NOISE = {"pvt", "ltd", "private", "limited", "inc", "llp", "llc", "co"}


def normalize_provider_name(name: str | None) -> str:
    return " ".join(t for t in norm_text(name).split() if t not in _PROVIDER_NOISE)


@dataclass
class NormItem:
    index: int
    item_id: str
    description: str
    desc_norm: str
    service_code: str | None
    quantity: Decimal | None
    unit_price: Decimal | None
    total: Decimal
    billable: Decimal            # min(total, qty*unit_price) when both known
    arithmetic_excess: Decimal   # total - billable (>0 => line total exceeds qty*unit)
    service_date: date | None


@dataclass
class HistoryRecord:
    source: str
    claim_id: str | None
    policy_number: str | None
    patient_id: str | None
    provider_id: str | None
    provider_key: str
    provider_type: str | None
    incident_date: date | None
    invoice_id: str | None
    invoice_date: date | None
    total: Decimal | None
    items: list[dict[str, Any]] = field(default_factory=list)
    # The record as supplied. Related-party detection reads identifier fields (payee account,
    # contact, address) that have no place in the typed schema but are what links two claimants.
    raw: dict[str, Any] = field(default_factory=dict)

    @classmethod
    def from_raw(cls, raw: dict[str, Any], source: str) -> "HistoryRecord":
        g = lambda *p: get_path(raw, *p, *[f"claim.{x}" for x in p])  # noqa: E731
        items = g("invoice.items", "items") or []
        return cls(
            source=source,
            claim_id=g("claim_id"),
            policy_number=g("policy_number"),
            patient_id=g("claimant.patient_id", "patient_id"),
            provider_id=g("provider.provider_id", "provider_id"),
            provider_key=normalize_provider_name(g("provider.name", "provider_name", "provider")
                                                 if not isinstance(g("provider"), dict) else g("provider.name")),
            provider_type=g("provider.provider_type", "provider_type"),
            incident_date=parse_date(g("incident.incident_date", "incident_date")),
            invoice_id=g("invoice.invoice_id", "invoice_id"),
            invoice_date=parse_date(g("invoice.invoice_date", "invoice_date")),
            total=parse_decimal(g("invoice.total_amount", "total_amount", "requested_amount", "amount")),
            items=[i for i in items if isinstance(i, dict)] if isinstance(items, list) else [],
            raw=raw,
        )


@dataclass
class ClaimContext:
    request: AnalyzeRequest
    items: list[NormItem]
    stay_days: int | None
    incident_ref_date: date | None
    provider_id: str | None
    provider_key: str
    provider_type: str | None
    patient_id: str | None
    invoice_total: Decimal | None
    items_sum: Decimal
    requested: Decimal | None
    claim_amount: Decimal
    currency: str
    history: list[HistoryRecord]

    @property
    def claim_id(self) -> str:
        return self.request.claim.claim_id


def unique_item_ids(items) -> None:
    seen: set[str] = set()
    for n, it in enumerate(items, 1):
        base = (it.item_id or f"ITEM-{n:03d}").strip()
        cand, k = base, 2
        while cand in seen:
            cand, k = f"{base}#{k}", k + 1
        it.item_id = cand
        seen.add(cand)


def normalize(request: AnalyzeRequest, settings: Settings) -> tuple[ClaimContext, AnalyzeRequest]:
    req = copy.deepcopy(request)
    claim, policy = req.claim, req.policy
    inv = claim.invoice
    raw_items = inv.items if inv else []
    unique_item_ids(raw_items)

    items: list[NormItem] = []
    for n, it in enumerate(raw_items):
        it.service_code = it.service_code.strip().upper() if it.service_code else None
        billable, excess = it.total_amount, ZERO
        if it.quantity is not None and it.unit_price is not None:
            expected = to_money(it.quantity * it.unit_price)
            if it.total_amount - expected > Decimal(str(settings.money_tolerance)):
                billable, excess = expected, it.total_amount - expected
        items.append(NormItem(n, it.item_id, it.description, norm_text(it.description), it.service_code,
                              it.quantity, it.unit_price, it.total_amount, billable, excess, it.service_date))

    inc = claim.incident
    stay = None
    if inc and inc.admission_date and inc.discharge_date and inc.discharge_date >= inc.admission_date:
        stay = max((inc.discharge_date - inc.admission_date).days, 1)
    ref_date = (inc.incident_date or inc.admission_date) if inc else None
    ref_date = ref_date or (inv.invoice_date if inv else None)

    items_sum = sum((i.total for i in items), ZERO)
    invoice_total = inv.total_amount if inv else None
    claim_amount = claim.requested_amount if claim.requested_amount is not None else (
        invoice_total if invoice_total is not None else items_sum)
    currency = ((inv.currency if inv and inv.currency else None) or "INR").upper()
    if inv:
        inv.currency = currency

    history: list[HistoryRecord] = []
    for src, rows in (("previous_claims", req.history.previous_claims),
                      ("related_invoices", req.history.related_invoices)):
        history.extend(HistoryRecord.from_raw(r, src) for r in rows if isinstance(r, dict))

    prov = claim.provider
    ctx = ClaimContext(
        request=req, items=items, stay_days=stay, incident_ref_date=ref_date,
        provider_id=prov.provider_id if prov else None,
        provider_key=normalize_provider_name(prov.name if prov else None),
        provider_type=(prov.provider_type.upper() if prov and prov.provider_type else None),
        patient_id=claim.claimant.patient_id if claim.claimant else None,
        invoice_total=invoice_total, items_sum=items_sum, requested=claim.requested_amount,
        claim_amount=claim_amount, currency=currency, history=history,
    )
    return ctx, req
