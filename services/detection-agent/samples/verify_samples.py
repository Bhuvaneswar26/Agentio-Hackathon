"""Run every sample through the analysis pipeline and assert its expected outcome.

This is the one command that answers "does the whole thing actually work": it exercises validation,
normalisation, policy mapping, the four detection engines, settlement, findings, risk and the ML
registry, then checks each sample against the `_expected` block in its own fixture. It also runs the
policy-document RAG pipeline and checks the extracted terms match the typed policy the samples use.

  python samples/verify_samples.py              # in-process, no server needed
  python samples/verify_samples.py --rag-only
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile
from decimal import Decimal
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(ROOT))

# Samples must not depend on a running Postgres; the pipeline itself needs no database.
os.environ.setdefault("CG_DATABASE_URL", f"sqlite:///{tempfile.mkdtemp(prefix='cg_samples_')}/s.db")
os.environ.setdefault("CG_EXECUTION_MODE", "sync")

from app.core.config import get_settings  # noqa: E402
from app.rag.service import PolicyDocumentIndex, extract_policy  # noqa: E402
from app.schemas.input_schema import AnalyzeRequest  # noqa: E402
from app.services.analysis_pipeline import run_analysis  # noqa: E402

GREEN, RED, YELLOW, DIM, RESET = "\033[32m", "\033[31m", "\033[33m", "\033[2m", "\033[0m"
OK, FAIL, WARN = f"{GREEN}PASS{RESET}", f"{RED}FAIL{RESET}", f"{YELLOW}WARN{RESET}"


def _money(v) -> Decimal:
    return Decimal(str(v or 0))


def check_sample(path: Path) -> tuple[bool, list[str]]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    expect = payload.get("_expected", {})
    request = AnalyzeRequest.model_validate(
        {k: v for k, v in payload.items() if not k.startswith("_")})
    out = run_analysis(request, f"AN-{path.stem[:2]}", settings=get_settings())
    resp = out.response
    problems: list[str] = []

    if resp.get("status") not in ("COMPLETED", "VALIDATION_FAILED"):
        return False, [f"unexpected status {resp.get('status')}"]

    findings = resp.get("findings", [])
    categories = {f["category"] for f in findings}
    rule_ids = {f["rule_id"] for f in findings}
    summary = resp.get("leakage_summary", {})
    fin = resp.get("financial_summary", {})
    calc = _money(summary.get("calculated_leakage"))

    for cat in expect.get("must_contain_categories", []):
        if cat not in categories:
            problems.append(f"expected a {cat} finding; got {sorted(categories)}")
    for cat in expect.get("must_not_contain_categories", []):
        if cat in categories:
            problems.append(f"did not expect a {cat} finding")
    for rid in expect.get("must_contain_rule_ids", []):
        if rid not in rule_ids:
            problems.append(f"expected rule {rid}; got {sorted(rule_ids)}")

    if "calculated_leakage" in expect and calc != _money(expect["calculated_leakage"]):
        problems.append(f"calculated_leakage {calc} != expected {expect['calculated_leakage']}")
    if "min_calculated_leakage" in expect and calc < _money(expect["min_calculated_leakage"]):
        problems.append(f"calculated_leakage {calc} < expected minimum {expect['min_calculated_leakage']}")
    for key, label in (("expected_settlement", "expected_settlement"),
                       ("discrepancy", "calculated_discrepancy")):
        if key in expect:
            actual = _money(fin.get(label))
            if actual != _money(expect[key]):
                problems.append(f"{label} {actual} != expected {expect[key]}")
    if "min_legitimate_repeats" in expect:
        n = len(resp.get("duplicate_analysis", {}).get("legitimate_repeats", []))
        if n < expect["min_legitimate_repeats"]:
            problems.append(f"legitimate_repeats {n} < expected {expect['min_legitimate_repeats']}")

    risk = resp.get("risk_assessment", {})
    print(f"  {DIM}findings={len(findings)} calc_leakage={calc} "
          f"expected_settlement={fin.get('expected_settlement')} "
          f"discrepancy={fin.get('calculated_discrepancy')} "
          f"risk={risk.get('risk_score')}/{risk.get('risk_level')}{RESET}")
    if categories:
        print(f"  {DIM}categories: {', '.join(sorted(categories))}{RESET}")
    return not problems, problems


def check_rag() -> tuple[bool, list[str]]:
    doc = HERE / "policy-document.txt"
    if not doc.exists():
        return False, ["samples/policy-document.txt is missing"]
    index = PolicyDocumentIndex(doc.read_text(encoding="utf-8"), source="POL-HLT-2025-00412")
    result = extract_policy(index, policy_number="POL-HLT-2025-00412", policy_type="HEALTH")
    policy = result.policy
    problems: list[str] = []

    print(f"  {DIM}chunks={index.stats()['chunks']} clauses={index.stats()['clauses_detected']} "
          f"facts={len(result.facts)} conflicts={len(result.conflicts)}{RESET}")

    # The document and the typed policy the samples use describe the same contract, so extraction
    # must recover the same numbers. This is the real test of the RAG pipeline.
    for field, want in (("deductible", 10000), ("copayment_percentage", 10), ("sum_insured", 500000)):
        got = policy.get(field)
        if got is None:
            problems.append(f"{field} was not extracted from the document")
        elif _money(got) != _money(want):
            problems.append(f"{field} extracted as {got}, document states {want}")

    sublimits = {s["category"]: s for s in policy.get("sublimits", [])}
    for cat, key, want in (("ROOM_RENT", "daily_limit", 5000), ("ICU", "daily_limit", 10000),
                           ("DIAGNOSTICS", "limit", 25000)):
        got = sublimits.get(cat, {}).get(key)
        if got is None:
            problems.append(f"sub-limit {cat}.{key} was not extracted")
        elif _money(got) != _money(want):
            problems.append(f"sub-limit {cat}.{key} extracted as {got}, document states {want}")

    exclusion_cats = {e["category"] for e in policy.get("exclusions", [])}
    if "CONSUMABLES" not in exclusion_cats:
        problems.append(f"consumables exclusion not extracted; got {sorted(exclusion_cats)}")

    # Every extracted value must be traceable to a clause.
    for fact in result.facts:
        if not fact.citation:
            problems.append(f"fact {fact.field} carries no citation")
            break

    # The 36-month pre-existing-disease waiting period must NOT become a blanket rule.
    enforced = policy.get("waiting_periods", [])
    blanket = [w for w in enforced if "category" not in w and w["days"] > 90]
    if blanket:
        problems.append(f"a condition-scoped waiting period was enforced policy-wide: {blanket}")
    if not policy.get("waiting_periods_requiring_review"):
        problems.append("the 36-month pre-existing waiting period was not held back for review")

    print(f"  {DIM}extracted: deductible={policy.get('deductible')} "
          f"copay={policy.get('copayment_percentage')}% sum_insured={policy.get('sum_insured')} "
          f"sublimits={len(policy.get('sublimits', []))} exclusions={len(policy.get('exclusions', []))}{RESET}")
    print(f"  {DIM}llm path: {result.llm.get('status')} ({result.llm.get('reason')}){RESET}")
    return not problems, problems


def check_models() -> None:
    from app.ml.inference import get_registry

    status = get_registry(str(get_settings().model_dir)).status
    for name, info in status.items():
        state = info.get("status")
        mark = OK if state == "AVAILABLE" else WARN
        extra = f" {DIM}synthetic{RESET}" if info.get("synthetic") else ""
        print(f"  [{mark}] {name}: {state}{extra} {DIM}{info.get('version') or info.get('reason', '')}{RESET}")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--rag-only", action="store_true")
    ap.add_argument("--samples-only", action="store_true")
    args = ap.parse_args()
    failures = 0

    if not args.rag_only:
        print(f"\n{DIM}=== ML model registry ==={RESET}")
        check_models()

        print(f"\n{DIM}=== Claim samples ==={RESET}")
        for path in sorted(HERE.glob("*.json")):
            if path.name == "index.json":
                continue
            print(f"\n{path.stem}")
            try:
                passed, problems = check_sample(path)
            except Exception as exc:  # a crash is a failure, not a stack trace to read
                passed, problems = False, [f"raised {type(exc).__name__}: {exc}"]
            print(f"  [{OK if passed else FAIL}]")
            for p in problems:
                print(f"    {RED}- {p}{RESET}")
            failures += 0 if passed else 1

    if not args.samples_only:
        print(f"\n{DIM}=== Policy-document RAG ==={RESET}")
        try:
            passed, problems = check_rag()
        except Exception as exc:
            passed, problems = False, [f"raised {type(exc).__name__}: {exc}"]
        print(f"  [{OK if passed else FAIL}]")
        for p in problems:
            print(f"    {RED}- {p}{RESET}")
        failures += 0 if passed else 1

    print(f"\n{'=' * 50}")
    print(f"{GREEN}all checks passed{RESET}" if not failures else f"{RED}{failures} check(s) failed{RESET}")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
