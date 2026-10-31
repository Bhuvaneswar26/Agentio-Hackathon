"""Adapter between the dashboard's DetectionPayload and the analysis engine (both directions).

Policy facts are only taken from what the payload states. The dashboard's own preview assumes a default room cap and a
default exclusion list; this adapter does NOT — missing policy terms surface as MISSING_INFORMATION findings.
"""
from __future__ import annotations

import re
from datetime import date, datetime
from decimal import Decimal
from typing import Any

from app.core.taxonomy import CATEGORY_SYNONYMS, normalize_category
from app.core.utils import jsonable, norm_text
from app.schemas.frontend_schema import DetectionPayloadIn, FELine
from app.schemas.input_schema import AnalyzeRequest

DOMAIN_TO_TYPE = {"health": "HEALTH", "motor": "MOTOR", "general": "GENERAL"}

CATEGORY_TO_KIND = {
    "DUPLICATE_INVOICE": "exact_duplicate",
    "NEAR_DUPLICATE_INVOICE": "near_duplicate", "SUSPECTED_DUPLICATE_INVOICE": "near_duplicate",
    "REUSED_INVOICE_ID": "near_duplicate", "REPEATED_INCIDENT": "near_duplicate",
    "DUPLICATE_LINE_ITEM": "duplicate_line", "CROSS_CLAIM_DUPLICATE": "duplicate_line",
    "POLICY_LIMIT_BREACH": "limit_breach", "SUM_INSURED_EXCEEDED": "limit_breach",
    "EXCLUDED_SERVICE": "exclusion", "NON_COVERED_EXPENSE": "exclusion", "WAITING_PERIOD_VIOLATION": "exclusion",
    "POLICY_INACTIVE": "exclusion",
    "SETTLEMENT_DISCREPANCY": "settlement_error", "SETTLEMENT_UNDERPAYMENT": "settlement_error",
    "LINE_ARITHMETIC_ERROR": "settlement_error", "REQUESTED_EXCEEDS_INVOICE": "settlement_error",
    "UNSUPPORTED_INVOICE_AMOUNT": "settlement_error",
    "BILLING_ANOMALY": "provider_anomaly",
    "ML_RISK_SIGNAL": "fraud_signal", "ML_ANOMALY_SIGNAL": "fraud_signal",
    "MISSING_INFORMATION": "insufficient_evidence", "DATA_INTEGRITY": "insufficient_evidence",
}
TITLES = {
    "DUPLICATE_INVOICE": "Invoice already submitted", "NEAR_DUPLICATE_INVOICE": "Near-duplicate invoice",
    "SUSPECTED_DUPLICATE_INVOICE": "Same provider, date and amount as an earlier invoice",
    "REUSED_INVOICE_ID": "Invoice number reused", "REPEATED_INCIDENT": "Same incident already claimed",
    "DUPLICATE_LINE_ITEM": "Duplicate line item", "CROSS_CLAIM_DUPLICATE": "Charge duplicated from another claim",
    "POLICY_LIMIT_BREACH": "Charge exceeds policy limit", "SUM_INSURED_EXCEEDED": "Sum insured exceeded",
    "EXCLUDED_SERVICE": "Excluded service billed", "NON_COVERED_EXPENSE": "Non-covered expense",
    "WAITING_PERIOD_VIOLATION": "Waiting period not served", "POLICY_INACTIVE": "Policy not in force",
    "SETTLEMENT_DISCREPANCY": "Proposed settlement exceeds expected",
    "SETTLEMENT_UNDERPAYMENT": "Proposed settlement below expected",
    "LINE_ARITHMETIC_ERROR": "Line total exceeds quantity x rate", "REQUESTED_EXCEEDS_INVOICE": "Requested amount exceeds invoice",
    "UNSUPPORTED_INVOICE_AMOUNT": "Invoice total not supported by line items", "BILLING_ANOMALY": "Unusual billing",
    "ML_RISK_SIGNAL": "Claim-risk model signal", "ML_ANOMALY_SIGNAL": "Statistically unusual claim profile",
    "MISSING_INFORMATION": "Information needed", "DATA_INTEGRITY": "Data inconsistency",
}
NON_ASSESSING = {"MISSING_INFORMATION", "DATA_INTEGRITY"}


def parse_date_loose(s: str | None) -> date | None:
    if not s:
        return None
    s = s.strip()
    for fmt in ("%Y-%m-%d", "%d/%m/%Y", "%d-%m-%Y", "%d/%m/%y", "%d-%m-%y", "%d %b %Y", "%d %B %Y"):
        try:
            return datetime.strptime(s[:10] if fmt == "%Y-%m-%d" else s, fmt).date()
        except ValueError:
            continue
    return None


def _dec(v: float | None) -> Decimal | None:
    return None if v is None else Decimal(str(v))


def infer_category(text: str) -> str | None:
    t = norm_text(text)
    for cat, phrases in CATEGORY_SYNONYMS.items():
        if any(re.search(rf"\b{re.escape(p)}\b", t) for p in phrases):
            return cat
    return None


def _slug(name: str | None) -> str | None:
    s = norm_text(name).replace(" ", "-")
    return f"NAME:{s}" if s else None  # name-derived identity key; the payload carries no patient id


def _item(line: FELine, n: int) -> dict[str, Any]:
    return {"item_id": line.id or f"LINE-{n}", "description": line.description or f"Line {n}",
            "service_code": (line.code or None), "quantity": line.quantity, "unit_price": line.unitPrice,
            "total_amount": line.amount or 0,
            "service_date": (d.isoformat() if (d := parse_date_loose(line.date)) else None)}


def _first_ref(lines: list[FELine]) -> str | None:
    return next((l.invoiceRef for l in lines if l.invoiceRef), None)


def to_analyze_request(p: DetectionPayloadIn) -> tuple[AnalyzeRequest | None, list[str], list[str]]:
    """Returns (request | None, missing_fields, notes). None => pack cannot be assessed (no invented leakage)."""
    notes: list[str] = []
    missing = list(p.extraction.missingFields)
    lines = p.invoiceLines
    if not lines:
        if "invoice line items" not in missing:
            missing.append("invoice line items")
        return None, missing, notes
    policy_no = p.claim.policyNumber or p.policy.policyNumber
    if not policy_no:
        notes.append("No policy number in payload; 'UNKNOWN' used so remaining checks can still run")
        policy_no = "UNKNOWN"
    domain = (p.claim.domain or "Health").strip().lower()
    claim_type = DOMAIN_TO_TYPE.get(domain, "HEALTH")
    if domain not in DOMAIN_TO_TYPE:
        notes.append(f"Unrecognised domain '{p.claim.domain}'; HEALTH assumed")

    coverage: dict[str, dict[str, Any]] = {}
    exclusions: list[dict[str, Any]] = []
    deductible, copay = p.policy.deductible, p.policy.copayPercent
    for r in p.policy.rules:
        t = (r.type or "").lower()
        cat = infer_category(r.name)
        if t == "exclusion":
            exclusions.append({"category": cat or normalize_category(r.name) or r.name, "description": r.clause or r.name, "clause_reference": r.id})
        elif t in ("limit", "sublimit", "coverage") and cat:
            c = coverage.setdefault(cat, {"category": cat, "covered": True})
            c["clause_reference"] = r.id
            if t != "coverage" and r.value is not None:
                per_day = bool(r.unit and "day" in r.unit.lower())
                c["daily_limit" if per_day else "limit"] = r.value
        elif t == "deductible" and deductible is None and r.value is not None:
            deductible = r.value
        elif t == "copay" and copay is None and r.value is not None:
            copay = r.value
        elif t in ("limit", "sublimit", "coverage"):
            notes.append(f"Rule '{r.name}' could not be mapped to a category and was not applied")

    invoice_total = sum(Decimal(str(l.amount or 0)) for l in lines)
    history = []
    for h in p.history:
        hl = h.invoiceLines
        history.append({
            "claim_id": h.claimId, "status": h.status,
            "claimant": {"name": h.claimant, "patient_id": _slug(h.claimant)},
            "provider": {"name": h.provider},
            "incident": {"incident_date": (d.isoformat() if (d := parse_date_loose(h.incidentDate)) else None)},
            "invoice": {"invoice_id": _first_ref(hl),
                        "total_amount": float(sum(Decimal(str(l.amount or 0)) for l in hl)) if hl else h.amount,
                        "items": [_item(l, i) for i, l in enumerate(hl, 1)]}})

    data = {
        "claim": {
            "claim_id": p.claim.claimId or "UNASSIGNED", "policy_number": policy_no, "claim_type": claim_type,
            "claimant": {"name": p.claim.claimant, "patient_id": _slug(p.claim.claimant)},
            "provider": {"name": p.claim.provider, "location": p.claim.city},
            "incident": {"incident_date": (d.isoformat() if (d := parse_date_loose(p.claim.incidentDate)) else None)},
            "invoice": {"invoice_id": _first_ref(lines),
                        "invoice_date": (d.isoformat() if (d := parse_date_loose(p.claim.filedDate)) else None),
                        "total_amount": float(invoice_total), "currency": "INR",
                        "items": [_item(l, i) for i, l in enumerate(lines, 1)]},
            "requested_amount": p.claim.requestedAmount, "proposed_settlement": p.claim.proposedSettlement},
        "policy": {
            "policy_number": policy_no, "policy_type": claim_type,
            "valid_from": (d.isoformat() if (d := parse_date_loose(p.policy.validFrom)) else None),
            "valid_until": (d.isoformat() if (d := parse_date_loose(p.policy.validUntil)) else None),
            "sum_insured": p.policy.sumInsured, "deductible": deductible, "copayment_percentage": copay,
            "coverage": list(coverage.values()), "exclusions": exclusions, "sublimits": []},
        "history": {"previous_claims": history, "previous_settlements": [], "related_invoices": []},
    }
    if p.claim.claimant is None:
        data["claim"]["claimant"] = None
    return AnalyzeRequest.model_validate(data), missing, notes


# ---------------------------------------------------------------- analysis -> dashboard Claim
def _evidence_strings(evidence: list[dict[str, Any]]) -> list[str]:
    out = []
    for e in evidence:
        head = str(e.get("type", "evidence")).replace("_", " ").lower()
        kv = [f"{k}={v}" for k, v in e.items() if k not in ("type", "source") and isinstance(v, (str, int, float, bool))][:5]
        out.append(f"{head}: {', '.join(kv)}" if kv else head)
    return out


def _engine(rule_id: str) -> str:
    return "duplicate" if "-DUP-" in rule_id else "ml" if "-ML-" in rule_id else "rules"


def _frontend_finding(f: dict[str, Any]) -> dict[str, Any]:
    cat = f["category"]
    certainty = ("unassessed" if cat in NON_ASSESSING
                 else "confirmed" if f["amount_type"] == "CALCULATED" and f.get("included_in_totals", True) else "potential")
    return {"id": f["finding_id"], "backendId": f["finding_id"], "kind": CATEGORY_TO_KIND.get(cat, "fraud_signal"),
            "title": TITLES.get(cat, cat.replace("_", " ").title()), "explanation": f["description"],
            "evidence": _evidence_strings(f.get("evidence", [])), "policyClause": f.get("policy_clause"),
            "invoiceLineIds": [f["item_id"]] if f.get("item_id") else [], "certainty": certainty,
            "severity": f["severity"].lower(), "leakageAmount": f.get("leakage_amount") or 0,
            "engine": _engine(f["rule_id"]), "ruleId": f["rule_id"], "amountType": f["amount_type"]}


def _queue(analysis: dict[str, Any], findings: list[dict[str, Any]], has_rules: bool) -> str:
    if analysis.get("status") == "VALIDATION_FAILED":
        return "unassessed"
    substantive = [f for f in analysis["findings"] if f["category"] not in NON_ASSESSING
                   and f["review_status"] != "DISMISSED"]
    if substantive:
        return "flagged"
    return "good" if has_rules else "unassessed"


def to_frontend_claim(p: DetectionPayloadIn, analysis: dict[str, Any] | None, missing: list[str],
                      notes: list[str], analysis_id: str) -> dict[str, Any]:
    fin = (analysis or {}).get("financial_summary", {})
    summ = (analysis or {}).get("leakage_summary", {})
    lines = [{"id": l.id or f"LINE-{i}", "description": l.description, "code": l.code or "",
              "quantity": l.quantity or 1, "unitPrice": l.unitPrice or l.amount or 0, "amount": l.amount or 0,
              "provider": l.provider or "", "invoiceRef": l.invoiceRef or "", "date": l.date or ""}
             for i, l in enumerate(p.invoiceLines, 1)]
    requested = p.claim.requestedAmount if p.claim.requestedAmount is not None else sum(l["amount"] for l in lines)
    base = {
        "id": p.claim.claimId or f"CLM-{analysis_id[-6:]}", "policyNumber": p.claim.policyNumber or p.policy.policyNumber or "UNKNOWN",
        "claimant": p.claim.claimant or "Unknown claimant",
        "incidentDate": p.claim.incidentDate or (p.ingestedAt or "")[:10], "filedDate": p.claim.filedDate or (p.ingestedAt or "")[:10],
        "domain": next((d for d in ("Health", "Motor", "General") if d.lower() == (p.claim.domain or "").lower()), "Health"),
        "claimType": p.claim.claimType or "Submitted pack", "requestedAmount": requested,
        "proposedSettlement": p.claim.proposedSettlement if p.claim.proposedSettlement is not None else requested,
        "provider": p.claim.provider or "Unknown provider", "city": p.claim.city or "—",
        "lines": lines, "policyRules": [r.model_dump(exclude_none=True) for r in p.policy.rules],
        "sourceFormat": p.source.get("format", "json"), "extractionConfidence": p.source.get("confidence", 0),
        "analysisId": analysis_id}
    if analysis is None or analysis.get("status") == "VALIDATION_FAILED":
        errs = [e["message"] for e in (analysis or {}).get("validation", {}).get("errors", []) if e.get("blocking")]
        return {**base, "expectedSettlement": 0, "confirmedLeakage": 0, "potentialLeakage": 0, "queue": "unassessed",
                "riskScore": 0, "relatedClaimIds": [], "missingFields": missing + errs,
                "findings": [{"id": f"F-{analysis_id}-0", "kind": "insufficient_evidence", "title": "Cannot assess — incomplete or invalid pack",
                              "explanation": "No leakage amount was invented. " + ("; ".join(errs) or "Mandatory fields or line items are missing."),
                              "evidence": missing + errs, "invoiceLineIds": [], "certainty": "unassessed", "severity": "medium",
                              "leakageAmount": 0, "engine": "rules"}],
                "notes": "ClaimsGuard engine could not assess this pack; see findings."}
    findings = [_frontend_finding(f) for f in analysis["findings"]]
    related = sorted({m["record"].get("claim_id") for m in analysis["duplicate_analysis"].get("matches", [])
                      if m["record"].get("claim_id")})
    has_rules = bool(p.policy.rules or p.policy.deductible is not None or p.policy.copayPercent is not None)
    return {**base, "expectedSettlement": fin.get("expected_settlement") or 0,
            "confirmedLeakage": summ.get("calculated_leakage") or 0, "potentialLeakage": summ.get("estimated_leakage") or 0,
            "queue": _queue(analysis, findings, has_rules), "riskScore": analysis["risk_assessment"]["risk_score"] or 0,
            "findings": findings, "relatedClaimIds": related,
            "missingFields": missing + [f for f in analysis["validation"].get("missing_information", [])
                                        for f in [f["field"]]][:12],
            "notes": (f"ClaimsGuard engine {analysis_id} · {analysis['risk_assessment']['assessment_status']} · "
                      f"{analysis['recommendation']['action']}" + (" · " + "; ".join(notes) if notes else ""))}
