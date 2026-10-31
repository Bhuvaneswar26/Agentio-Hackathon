# ClaimsGuard AI – Claims Leakage Detection Backend

Structured claim + policy JSON in → one explainable analysis JSON out. No OCR/extraction (the frontend does that).

Pipeline: `validation → normalization → policy mapping → rule engine → duplicate detection → anomaly + ML → settlement → findings/leakage → risk → explainability → PostgreSQL → JSON`.

## Run
```bash
cp .env.example .env
docker compose up --build            # API on :8000, docs at /docs
# or locally
pip install -r requirements.txt && uvicorn app.main:app --reload
pytest -q                            # 34 tests, uses SQLite automatically
```
`CG_EXECUTION_MODE=sync` (default) returns the full analysis in the POST response. `background`/`celery` return `202` + `analysis_id`; poll `/status`, then `/result`.

## Dashboard integration
The React dashboard (`frontend/claims-dashboard`) posts its `DetectionPayload` (schemaVersion 1.0, camelCase) to **`POST /v1/detect`**. `app/services/frontend_adapter.py` maps it to the engine's contract and maps the analysis back to a dashboard `Claim` (`claim` in the response; the full analysis is under `analysis`). Notes:
- Policy facts come only from the payload (`policy.rules`, `deductible`, `copayPercent`, optional `validFrom/validUntil/sumInsured`). The dashboard's local preview assumes a ₹5,000 room cap and a default exclusion list; the engine does not, so a pack without rules shows *Information needed* instead of invented leakage.
- Desk claims sent as `history` (with `invoiceLines`) power cross-claim duplicate detection. With no patient id in the payload, a name-derived key (`NAME:<claimant>`) is used for repeated-incident matching.
- Packs with no line items return `status: UNASSESSED` (queue `unassessed`, zero leakage).
- Reviewer actions on the desk (confirm / dismiss) are mirrored to `POST /api/v1/findings/{id}/review`.

## API
| Method | Path | Purpose |
|---|---|---|
| POST | `/api/v1/analyze` | Analyse a claim (`{claim, policy, history, options?}`) |
| GET | `/api/v1/analyze/{id}/status` · `/result` · `/findings` | Status, full JSON, findings (filters: severity, category, review_status) |
| POST | `/api/v1/findings/{finding_id}/review` | `CONFIRM / DISMISS / REQUEST_EVIDENCE / CORRECT` (`corrected_amount` required for CORRECT) |
| POST | `/api/v1/analyze/{id}/recalculate` | Re-run with `item_overrides`, `policy_overrides`, `proposed_settlement`, `settlement_strategy`; review decisions carried over |
| GET | `/api/v1/dashboard/summary` | Aggregates |
| GET | `/health`, `/api/v1/models/status` | Ops |

Input: unknown extra fields are accepted, `null`s are tolerated. Optional additions beyond your contract: `item.service_date`, `policy.inception_date`, `policy.waiting_periods[]`, `policy.settlement_strategy`, `claimant.policyholder_tenure` (must use the same unit as the training data). Invalid input → `422 {success:false, status:"VALIDATION_FAILED", errors:[{field, code, message}]}`; business-rule blockers (policy-number mismatch, bad dates, unsupported currency…) return the full `validation` block.

## Design rules worth knowing
- **Decimal everywhere** for money; JSON output is numeric.
- **Settlement strategies** are configurable step orders: `DEDUCTIBLE_THEN_COPAY` (default), `COPAY_THEN_DEDUCTIBLE`, `CAP_THEN_…`, or a custom list e.g. `["COPAY","DEDUCTIBLE","SUM_INSURED_CAP"]`. Set per policy or per request.
- **No assumed policy terms.** If the policy is silent on an item it is reported as `INSUFFICIENT_EVIDENCE` (`MISSING_INFORMATION` finding) and treated per `CG_UNKNOWN_COVERAGE_TREATMENT`.
- **No double counting.** An item ledger lets each line leak only once across arithmetic, policy, duplicate and price findings. Settlement-level discrepancies are shown but flagged `included_in_totals=false`. Risk scoring de-duplicates by issue key.
- **Amount types:** `CALCULATED` (rule-derived), `ESTIMATED` (peer statistics / non-exact duplicates, needs review), `UNQUANTIFIED`.
- **`leakage_chance` is always `null`** – no validated, calibrated leakage-probability model exists. CatBoost output is an *uncalibrated suspicion score*; Isolation Forest output is an anomaly score (not a probability). Both are low-weight signals and are skipped when too few features can be built.
- Weights, thresholds, synonyms (`app/core/taxonomy.py`), repeatable-treatment keywords and incompatible procedure pairs (empty by default) are configuration.

## ML training
```bash
python -m app.ml.train_catboost          --source ziadatalabs/FreeInsuranceClaims100M --max-rows 500000
python -m app.ml.train_isolation_forest  --source ziadatalabs/FreeInsuranceClaims100M
python -m app.ml.train_provider_model    --items-csv datasets/billing_items.csv     # item-level peer prices (recommended)
```
Each script inspects the real schema first (`reports/schema_report.json`), maps columns by name, excludes leakage columns (status/resolution/payout/…), splits chronologically when a date exists, and writes metrics + reports to `reports/` and artefacts to `ml_models/`. CatBoost is saved as native `.cbm` with a metadata JSON. **Domain caveat:** the public dataset is generic; validate on your own labelled claims before relying on ML output.
