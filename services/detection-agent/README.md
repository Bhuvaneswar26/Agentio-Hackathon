# ClaimsGuard AI – Claims Leakage Detection Backend

Structured claim + policy JSON in → one explainable analysis JSON out. Policy _documents_ are read by the RAG pipeline (`app/rag/`), which turns a policy wording into the structured `policy` block this engine evaluates, with a clause citation behind every value.

Pipeline: `validation → normalization → policy mapping → rule engine → duplicate detection → related-party graph → anomaly + ML → settlement → findings/leakage → risk → explainability → PostgreSQL → JSON`.

## Run

```bash
cp .env.example .env
docker compose up --build            # API on :8000, docs at /docs
# or locally
pip install -r requirements.txt && uvicorn app.main:app --reload
pytest -q                            # 97 tests, uses SQLite automatically
python samples/verify_samples.py     # end-to-end check: all 5 leakage scenarios + RAG
```

`CG_EXECUTION_MODE=sync` (default) returns the full analysis in the POST response. `background`/`celery` return `202` + `analysis_id`; poll `/status`, then `/result`.

## Dashboard integration

The React dashboard (`frontend/claims-dashboard`) posts its `DetectionPayload` (schemaVersion 1.0, camelCase) to **`POST /v1/detect`**. `app/services/frontend_adapter.py` maps it to the engine's contract and maps the analysis back to a dashboard `Claim` (`claim` in the response; the full analysis is under `analysis`). Notes:

- Policy facts come only from the payload (`policy.rules`, `deductible`, `copayPercent`, optional `validFrom/validUntil/sumInsured`). The dashboard's local preview assumes a ₹5,000 room cap and a default exclusion list; the engine does not, so a pack without rules shows _Information needed_ instead of invented leakage.
- Desk claims sent as `history` (with `invoiceLines`) power cross-claim duplicate detection. With no patient id in the payload, a name-derived key (`NAME:<claimant>`) is used for repeated-incident matching.
- Packs with no line items return `status: UNASSESSED` (queue `unassessed`, zero leakage).
- Reviewer actions on the desk (confirm / dismiss) are mirrored to `POST /api/v1/findings/{id}/review`.

## API

| Method | Path                                                    | Purpose                                                                                                                       |
| ------ | ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| POST   | `/api/v1/analyze`                                       | Analyse a claim (`{claim, policy, history, options?}`)                                                                        |
| GET    | `/api/v1/analyze/{id}/status` · `/result` · `/findings` | Status, full JSON, findings (filters: severity, category, review_status)                                                      |
| POST   | `/api/v1/findings/{finding_id}/review`                  | `CONFIRM / DISMISS / REQUEST_EVIDENCE / CORRECT` (`corrected_amount` required for CORRECT)                                    |
| POST   | `/api/v1/analyze/{id}/recalculate`                      | Re-run with `item_overrides`, `policy_overrides`, `proposed_settlement`, `settlement_strategy`; review decisions carried over |
| GET    | `/api/v1/dashboard/summary`                             | Aggregates                                                                                                                    |
| POST   | `/api/v1/policy/extract`                                | Read a policy document into a structured, clause-cited policy                                                                 |
| POST   | `/api/v1/policy/extract/upload`                         | Same, from a text/markdown/CSV upload                                                                                         |
| POST   | `/api/v1/policy/ask`                                    | Answer a policy question with Gemini and return supporting clauses                                                            |
| GET    | `/api/v1/policy/rag/status`                             | RAG component availability                                                                                                    |
| GET    | `/health`, `/api/v1/models/status`                      | Ops                                                                                                                           |

Input: unknown extra fields are accepted, `null`s are tolerated. Optional additions beyond your contract: `item.service_date`, `policy.inception_date`, `policy.waiting_periods[]`, `policy.settlement_strategy`, `claimant.policyholder_tenure` (must use the same unit as the training data). Invalid input → `422 {success:false, status:"VALIDATION_FAILED", errors:[{field, code, message}]}`; business-rule blockers (policy-number mismatch, bad dates, unsupported currency…) return the full `validation` block.

## Design rules worth knowing

- **Decimal everywhere** for money; JSON output is numeric.
- **Settlement strategies** are configurable step orders: `DEDUCTIBLE_THEN_COPAY` (default), `COPAY_THEN_DEDUCTIBLE`, `CAP_THEN_…`, or a custom list e.g. `["COPAY","DEDUCTIBLE","SUM_INSURED_CAP"]`. Set per policy or per request.
- **No assumed policy terms.** If the policy is silent on an item it is reported as `INSUFFICIENT_EVIDENCE` (`MISSING_INFORMATION` finding) and treated per `CG_UNKNOWN_COVERAGE_TREATMENT`.
- **No double counting.** An item ledger lets each line leak only once across arithmetic, policy, duplicate and price findings. Settlement-level discrepancies are shown but flagged `included_in_totals=false`. Risk scoring de-duplicates by issue key.
- **Amount types:** `CALCULATED` (rule-derived), `ESTIMATED` (peer statistics / non-exact duplicates, needs review), `UNQUANTIFIED`.
- **`leakage_chance` is always `null`** – no validated, calibrated leakage-probability model exists. CatBoost output is an _uncalibrated suspicion score_; Isolation Forest output is an anomaly score (not a probability). Both are low-weight signals and are skipped when too few features can be built.
- Weights, thresholds, synonyms (`app/core/taxonomy.py`), repeatable-treatment keywords and incompatible procedure pairs (empty by default) are configuration.

## Policy-document RAG (`app/rag/`)

Reads an unstructured policy wording and emits the `policy` block `/api/v1/analyze` consumes.

`chunker` -> `retriever` -> `extractors` (+ optional `llm_extractor`) -> `service`

- **Chunking** splits on document structure (clause numbers, headings, page markers), not a token
  window, so every chunk is citable as _"Section 2 - Sub-Limits / Clause 2.1 / p.4"_. A letter
  clause marker needs a delimiter (`A.`, `B)`): a bare `A ` opens an English sentence.
- **Retrieval** is TF-IDF (word 1-2 grams, sublinear tf) cosine similarity blended 75/25 with a
  RapidFuzz lexical score, plus per-field synonym expansion (`sub-limit`, `capped at`, `maximum
payable`...). It runs offline: no API key, no model download, no vector database.
- **Extraction** is rule-based and cue-gated: a number becomes a limit only if the clause uses
  limiting language, so _"the premium is Rs. 12,000"_ never becomes a benefit cap. Each fact carries
  its clause, the snippet that justifies it, and a confidence capped by the retrieval score.
- **Grounded LLM pass** (`use_llm: true`) runs over the _retrieved clauses only_ and must cite a
  supplied `clause_id`; a fact citing anything else is dropped. The dashboard runs this
  automatically with Gemini. Set `CG_LLM_PROVIDER=gemini` and `GEMINI_API_KEY` in the local
  git-ignored `.env` file; Gemini uses `gemini-2.0-flash`. Claude remains available for backend
  extraction by setting `CG_LLM_PROVIDER=claude` and `ANTHROPIC_API_KEY`. The Ask action always
  uses Gemini when configured and returns the original supporting clauses alongside the generated
  answer. If Gemini is unavailable, Ask degrades to retrieved clause citations rather than failing.
  Retrieval and rule-based extraction continue to work without an LLM key. The active extraction
  provider and its availability are reported by `GET /api/v1/policy/rag/status`.

Keep provider credentials only in the local, git-ignored `.env` file. Never commit API keys; if a
key was committed, revoke it and create a replacement before using Gemini.

Three guarantees the rule engine depends on:

| Guarantee             | Behaviour                                                                                                                                                                                                                                                              |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Nothing invented      | A field the document never states is listed under `unresolved`, never defaulted. The rule engine then reports it as `INSUFFICIENT_EVIDENCE`.                                                                                                                           |
| Disagreement surfaced | Two clauses stating different deductibles produce a `conflicts` entry with both citations and `action_required`, instead of one silently winning.                                                                                                                      |
| Scope respected       | A waiting period tied to a condition class ("36 months for pre-existing diseases") goes to `waiting_periods_requiring_review`, **not** `waiting_periods` - a category-less waiting period applies to every line, so promoting it would void every claim on the policy. |

The dashboard exposes this at **Policy reader**: upload a wording (PDF/scan included, OCR runs in
the browser), review the cited terms, then "Use for next ingest" so the next claim pack is assessed
against those clauses. Pack-supplied values still take precedence over document-derived ones.

## Related-party detection (`app/engines/related_party_engine.py`)

The second half of leakage scenario 4; unusual provider _billing_ is statistical and stays in
`anomaly_engine`. Five checks across the claim and its history: a shared payee account / contact /
email / address / id under a **different** claimant, the same incident date and provider under a
different claimant, near-identical claimant names at one provider, single-provider concentration,
and adjacent invoice numbers across claimants.

Every signal is `UNQUANTIFIED` with `leakage=None`, carries its own `related_party` risk component
(weight 0.55, below policy violations) and an `interpretation` naming the innocent explanation. A
shared address is as likely to be a family policy as a claim ring, so nothing here concludes fraud
or claims a rupee. Links are drawn only on identifiers the payload actually supplies - a missing
field is never treated as a non-match.

## Samples and verification

`samples/` holds one fixture per leakage scenario plus a clean control, each with an `_expected`
block that `verify_samples.py` asserts:

| Sample                                  | Exercises              | Expected                                                           |
| --------------------------------------- | ---------------------- | ------------------------------------------------------------------ |
| `00-clean-claim-no-leakage`             | false-positive control | 0 findings, risk 0                                                 |
| `01-duplicate-invoice-and-line`         | scenario 1             | duplicate invoice + duplicate line                                 |
| `02-policy-limits-and-exclusions`       | scenario 2             | 6,000 room excess + 2,400 excluded + 3,000 over sub-limit          |
| `03-settlement-miscalculation`          | scenario 3             | expected 52,200 vs proposed 68,000                                 |
| `04-provider-billing-and-related-party` | scenario 4             | price anomaly (ESTIMATED) + shared bank account                    |
| `05-legitimate-repeat-service`          | scenario 5a            | physiotherapy sessions in `legitimate_repeats`, **not** duplicates |
| `06-incomplete-evidence`                | scenario 5b            | `MISSING_INFORMATION`, zero calculated leakage                     |

```bash
python samples/build_samples.py      # regenerate the fixtures
python samples/verify_samples.py     # assert all of the above, plus the RAG round trip
```

`verify_samples.py` also re-reads `samples/policy-document.txt` and checks the extracted terms match
the typed policy the fixtures use - the real test that retrieval and extraction agree with the
contract the engine evaluates.

## ML training

All three models train from a bundled synthetic generator, so the inference path runs with no
network access:

```bash
# 1. Generate training data (synthetic: labels come from a known generative process)
python -m app.ml.generate_synthetic_dataset --rows 60000

# 2. Train all three
python -m app.ml.train_catboost          --source datasets/synthetic_claims.csv --max-rows 60000
python -m app.ml.train_isolation_forest  --source datasets/synthetic_claims.csv --max-rows 60000
python -m app.ml.train_provider_model    --items-csv datasets/billing_items.csv --source datasets/synthetic_claims.csv
```

Or against the public dataset / your own labelled claims:

```bash
python -m app.ml.train_catboost          --source ziadatalabs/FreeInsuranceClaims100M --max-rows 500000
python -m app.ml.train_isolation_forest  --source ziadatalabs/FreeInsuranceClaims100M
python -m app.ml.train_provider_model    --items-csv datasets/billing_items.csv     # item-level peer prices (recommended)
```

Artefacts trained on the synthetic generator are stamped `"synthetic": true` with a caveat on
`/api/v1/models/status`: such a model has learned that generator and nothing about real leakage.
Retrain on labelled production claims before relying on either model's output. On the bundled data
CatBoost reaches test PR-AUC 0.254 against a 0.093 positive rate (a 2.7x lift, validation and test
within 0.003 of each other) - a real but modest signal, which is why it stays a low-weight input.
Each script inspects the real schema first (`reports/schema_report.json`), maps columns by name, excludes leakage columns (status/resolution/payout/…), splits chronologically when a date exists, and writes metrics + reports to `reports/` and artefacts to `ml_models/`. CatBoost is saved as native `.cbm` with a metadata JSON. **Domain caveat:** the public dataset is generic; validate on your own labelled claims before relying on ML output.
