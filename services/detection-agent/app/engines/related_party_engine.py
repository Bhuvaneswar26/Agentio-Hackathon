"""Related-party and claim-network detection (leakage scenario 4, second half).

Scenario 4 asks for two things. Unusual provider *billing* is statistical and lives in
`anomaly_engine`. This engine covers the other half: claims that share unusual combinations of
claimant, provider, invoice or incident information -- the shape of a claim ring.

Deliberate design choices:
  * Nothing here concludes fraud. Every finding is UNQUANTIFIED and routed for investigation,
    because a shared address or a repeat provider is equally the signature of a family policy or
    the only hospital in town.
  * Links are only drawn on identifiers the payload actually supplies. A missing bank account is
    not treated as a non-match, so sparse packs produce no findings rather than false ones.
"""
from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass, field
from typing import Any

from rapidfuzz import fuzz

from app.core.config import Settings
from app.core.utils import jsonable, norm_text
from app.engines.anomaly_engine import Anomaly
from app.services.normalization_service import ClaimContext, HistoryRecord, normalize_provider_name

# Identifier fields that, when shared across claims with different claimants, suggest a related
# party rather than a coincidence. Read from the claimant's extra fields so the payload can carry
# whatever the insurer actually holds without a schema change.
LINK_FIELDS: dict[str, tuple[str, ...]] = {
    "bank_account": ("bank_account", "bank_account_number", "account_number", "payee_account"),
    "contact_number": ("contact_number", "phone", "phone_number", "mobile", "contact"),
    "email": ("email", "email_address"),
    "address": ("address", "residential_address", "postal_address"),
    "id_number": ("id_number", "national_id", "aadhaar", "pan", "government_id"),
}

NAME_SIMILARITY_THRESHOLD = 88.0


@dataclass
class RelatedPartyResult:
    anomalies: list[Anomaly] = field(default_factory=list)
    links: list[dict[str, Any]] = field(default_factory=list)
    checks_run: list[str] = field(default_factory=list)
    insufficient_evidence: list[dict[str, Any]] = field(default_factory=list)
    records_compared: int = 0

    def to_dict(self) -> dict[str, Any]:
        by_type: dict[str, int] = defaultdict(int)
        for a in self.anomalies:
            by_type[a.anomaly_type] += 1
        return jsonable({
            "related_party_signals_detected": bool(self.anomalies),
            "count": len(self.anomalies), "by_type": dict(by_type),
            "signals": self.anomalies, "links": self.links,
            "records_compared": self.records_compared, "checks_run": self.checks_run,
            "insufficient_evidence": self.insufficient_evidence,
            "method": ("Shared-identifier and shared-incident graph across the claim and its history. "
                       "Signals are routed for investigation and never scored as confirmed leakage: a "
                       "shared identifier is as likely to be a family policy as a claim ring."),
        })


def _extra(obj: Any) -> dict[str, Any]:
    """Claimant/provider extras, lower-cased keys, as supplied by the payload."""
    if obj is None:
        return {}
    extra = dict(getattr(obj, "model_extra", None) or {})
    return {str(k).lower(): v for k, v in extra.items()}


def _link_values(source: dict[str, Any]) -> dict[str, str]:
    """Normalised values for each link field the source actually supplies."""
    out: dict[str, str] = {}
    for link, aliases in LINK_FIELDS.items():
        for alias in aliases:
            raw = source.get(alias)
            if raw is None or not str(raw).strip():
                continue
            value = norm_text(str(raw)).replace(" ", "")
            if value:
                out[link] = value
                break
    return out


def _record_claimant(rec: HistoryRecord) -> dict[str, Any]:
    """Claimant-level fields of a history record, wherever the payload put them.

    History rows arrive either flat or wrapped in a `claim` object, and claimant details may sit at
    the top level or under `claimant`; all four shapes are flattened here, most specific last.
    """
    raw = getattr(rec, "raw", None) or {}
    inner = raw.get("claim") if isinstance(raw.get("claim"), dict) else {}
    merged: dict[str, Any] = {}
    for scope in (raw, inner):
        merged.update({str(k).lower(): v for k, v in scope.items() if not isinstance(v, (dict, list))})
    for scope in (raw, inner):
        claimant = scope.get("claimant")
        if isinstance(claimant, dict):
            merged.update({str(k).lower(): v for k, v in claimant.items()})
    return merged


class RelatedPartyEngine:
    def __init__(self, settings: Settings):
        self.s = settings

    def analyze(self, ctx: ClaimContext) -> RelatedPartyResult:
        res = RelatedPartyResult()
        claim = ctx.request.claim
        recs = [r for r in ctx.history if not (r.claim_id and r.claim_id == claim.claim_id)]
        res.records_compared = len(recs)
        res.checks_run = ["SHARED_IDENTIFIER_DIFFERENT_CLAIMANT", "SHARED_INCIDENT_DIFFERENT_CLAIMANT",
                          "SIMILAR_CLAIMANT_NAME_SAME_PROVIDER", "PROVIDER_CLAIMANT_CONCENTRATION",
                          "SHARED_INVOICE_SERIES"]

        claimant = claim.claimant
        claimant_name = norm_text(claimant.name if claimant else None)
        own_links = _link_values(_extra(claimant))
        if not own_links:
            res.insufficient_evidence.append({
                "check": "SHARED_IDENTIFIER_DIFFERENT_CLAIMANT",
                "reason": "the claim carries none of the identifiers used to link related parties",
                "fields_looked_for": sorted(LINK_FIELDS)})

        # --- (1) a shared identifier under a different claimant name
        for rec in recs:
            rec_fields = _record_claimant(rec)
            rec_links = _link_values(rec_fields)
            rec_name = norm_text(rec_fields.get("name"))
            for link, value in own_links.items():
                if rec_links.get(link) != value:
                    continue
                same_person = bool(
                    (ctx.patient_id and rec.patient_id and ctx.patient_id == rec.patient_id)
                    or (claimant_name and rec_name and claimant_name == rec_name))
                if same_person:
                    continue  # the same claimant reusing their own details is not a related party
                res.links.append({"link_type": link, "matched_claim_id": rec.claim_id,
                                  "this_claimant": claimant_name or None, "matched_claimant": rec_name or None})
                res.anomalies.append(Anomaly(
                    anomaly_type="RELATED_PARTY_SHARED_IDENTIFIER", rule_id="RULE-RP-001",
                    description=(f"Claim shares the same {link.replace('_', ' ')} as claim "
                                 f"{rec.claim_id or rec.invoice_id} filed under a different claimant"),
                    item_id=None, amount_type="UNQUANTIFIED", leakage=None, severity="HIGH",
                    evidence={"link_type": link, "matched_claim_id": rec.claim_id,
                              "matched_invoice_id": rec.invoice_id, "this_claimant": claimant_name or None,
                              # not "source": `ev()` owns that key for the engine attribution
                              "matched_claimant": rec_name or None, "matched_record_source": rec.source,
                              "interpretation": ("A shared payee or contact across different claimants "
                                                 "warrants investigation; it is not proof of fraud.")},
                    issue_key=f"RP-ID::{link}::{rec.claim_id or rec.invoice_id}",
                    component="related_party"))

        # --- (2) the same incident date and provider, different claimant
        incident_date = claim.incident.incident_date if claim.incident else None
        if incident_date and (ctx.provider_id or ctx.provider_key):
            for rec in recs:
                if rec.incident_date != incident_date:
                    continue
                same_provider = bool(
                    (ctx.provider_id and rec.provider_id and ctx.provider_id == rec.provider_id)
                    or (ctx.provider_key and rec.provider_key and ctx.provider_key == rec.provider_key))
                if not same_provider:
                    continue
                rec_name = norm_text(_record_claimant(rec).get("name"))
                if ctx.patient_id and rec.patient_id and ctx.patient_id == rec.patient_id:
                    continue  # same patient, same day: duplicate_engine's territory, not a ring
                if claimant_name and rec_name and claimant_name == rec_name:
                    continue
                res.anomalies.append(Anomaly(
                    anomaly_type="SHARED_INCIDENT_DIFFERENT_CLAIMANT", rule_id="RULE-RP-002",
                    description=(f"Same incident date ({incident_date}) and provider as claim "
                                 f"{rec.claim_id or rec.invoice_id}, under a different claimant"),
                    item_id=None, amount_type="UNQUANTIFIED", leakage=None, severity="MEDIUM",
                    evidence={"incident_date": incident_date, "matched_claim_id": rec.claim_id,
                              "provider_id": ctx.provider_id, "provider": ctx.provider_key,
                              "this_claimant": claimant_name or None, "matched_claimant": rec_name or None,
                              "interpretation": ("Could be one genuine multi-casualty event or a shared "
                                                 "incident used by several claims. Verify independently.")},
                    issue_key=f"RP-INC::{rec.claim_id or rec.invoice_id}",
                    component="related_party"))

        # --- (3) near-identical claimant names at the same provider
        if claimant_name and len(claimant_name) >= 6:
            for rec in recs:
                rec_name = norm_text(_record_claimant(rec).get("name"))
                if not rec_name or len(rec_name) < 6 or rec_name == claimant_name:
                    continue
                same_provider = bool(
                    (ctx.provider_id and rec.provider_id and ctx.provider_id == rec.provider_id)
                    or (ctx.provider_key and rec.provider_key and ctx.provider_key == rec.provider_key))
                if not same_provider:
                    continue
                score = fuzz.ratio(claimant_name, rec_name)
                if score < NAME_SIMILARITY_THRESHOLD:
                    continue
                res.anomalies.append(Anomaly(
                    anomaly_type="SIMILAR_CLAIMANT_NAME_SAME_PROVIDER", rule_id="RULE-RP-003",
                    description=(f"Claimant name closely resembles '{rec_name}' on claim "
                                 f"{rec.claim_id or rec.invoice_id} at the same provider "
                                 f"({score:.0f}% similar)"),
                    item_id=None, amount_type="UNQUANTIFIED", leakage=None, severity="LOW",
                    evidence={"this_claimant": claimant_name, "matched_claimant": rec_name,
                              "name_similarity": round(score / 100, 3),
                              "matched_claim_id": rec.claim_id, "provider": ctx.provider_key,
                              "interpretation": ("Often a family member on the same policy or a spelling "
                                                 "variant of one person; confirm identity before acting.")},
                    issue_key=f"RP-NAME::{rec.claim_id or rec.invoice_id}",
                    component="related_party"))

        # --- (4) one provider accounting for an unusual share of this claimant's history
        if ctx.patient_id or claimant_name:
            mine = [r for r in recs if (ctx.patient_id and r.patient_id == ctx.patient_id)
                    or (claimant_name and norm_text(_record_claimant(r).get("name")) == claimant_name)]
            if len(mine) >= 4:
                by_provider: dict[str, int] = defaultdict(int)
                for r in mine:
                    key = (r.provider_id or r.provider_key or "").lower()
                    if key:
                        by_provider[key] += 1
                this_key = (ctx.provider_id or ctx.provider_key or "").lower()
                share = (by_provider.get(this_key, 0) + 1) / (len(mine) + 1)
                if this_key and share >= 0.8 and len(by_provider) <= 1:
                    res.anomalies.append(Anomaly(
                        anomaly_type="PROVIDER_CLAIMANT_CONCENTRATION", rule_id="RULE-RP-004",
                        description=(f"Every one of this claimant's {len(mine) + 1} claims routes through "
                                     f"the same provider"),
                        item_id=None, amount_type="UNQUANTIFIED", leakage=None, severity="LOW",
                        evidence={"claims_considered": len(mine) + 1, "provider_share": round(share, 3),
                                  "distinct_providers": len(by_provider), "provider": this_key,
                                  "interpretation": ("Expected where the insured uses one network hospital; "
                                                     "informative only when combined with other signals.")},
                        issue_key=f"RP-CONC::{this_key}", component="related_party"))
            elif len(mine) > 0:
                res.insufficient_evidence.append({
                    "check": "PROVIDER_CLAIMANT_CONCENTRATION", "claimant_history_records": len(mine),
                    "required": 4, "reason": "too little history for a concentration judgement"})

        # --- (5) sequential invoice numbers shared across different claimants at one provider
        inv = claim.invoice
        own_inv = (inv.invoice_id or "").strip() if inv else ""
        if own_inv and any(ch.isdigit() for ch in own_inv):
            prefix = own_inv.rstrip("0123456789")
            own_seq = own_inv[len(prefix):]
            for rec in recs:
                rec_inv = (rec.invoice_id or "").strip()
                if not rec_inv or rec_inv == own_inv or not rec_inv.startswith(prefix) or not prefix:
                    continue
                rec_seq = rec_inv[len(prefix):]
                if not (own_seq.isdigit() and rec_seq.isdigit()):
                    continue
                rec_name = norm_text(_record_claimant(rec).get("name"))
                if not rec_name or not claimant_name or rec_name == claimant_name:
                    continue
                if abs(int(own_seq) - int(rec_seq)) > 3:
                    continue
                res.anomalies.append(Anomaly(
                    anomaly_type="SHARED_INVOICE_SERIES", rule_id="RULE-RP-005",
                    description=(f"Invoice {own_inv} is adjacent in the provider's numbering to "
                                 f"{rec_inv} on a claim by a different claimant"),
                    item_id=None, amount_type="UNQUANTIFIED", leakage=None, severity="LOW",
                    evidence={"this_invoice": own_inv, "matched_invoice": rec_inv,
                              "sequence_gap": abs(int(own_seq) - int(rec_seq)),
                              "matched_claim_id": rec.claim_id, "matched_claimant": rec_name,
                              "interpretation": ("Consecutive invoices for different claimants are normal "
                                                 "in a busy hospital; weigh only alongside other signals.")},
                    issue_key=f"RP-SERIES::{rec_inv}", component="related_party"))
        return res
