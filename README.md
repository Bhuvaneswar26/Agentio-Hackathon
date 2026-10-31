# Agentio Hackathon

This repository is the shared monorepo for the hackathon products. Each team should keep its application or service inside an owned top-level area instead of adding product code to the repository root.

## Current product

- **ClaimsGuard dashboard:** [frontend/claims-dashboard](frontend/claims-dashboard/README.md) — claims intake, OCR/extraction, detection payload preview, investigation dashboards, alerts, and supervisor review.

- **Detection engine:** [services/detection-agent](services/detection-agent/README.md) — FastAPI + PostgreSQL service: policy mapping, rule engine, duplicate detection, billing anomalies, related-party graph, policy-document RAG (clause retrieval + cited term extraction), CatBoost / Isolation Forest signals, settlement calculation, risk scoring, explainable findings and audit trail.

## Run everything locally

```bash
# 1. engine (API on http://localhost:8000, docs at /docs)
cd services/detection-agent
docker compose up --build
#  or without Docker (Python 3.10+ required):
#    pip install -r requirements.txt
#    cp .env.example .env     # then set CG_DATABASE_URL=sqlite:///./dev.db to skip Postgres
#    python -m app.ml.generate_synthetic_dataset --rows 60000   # one-off, for the ML models
#    python -m app.ml.train_catboost         --source datasets/synthetic_claims.csv --max-rows 60000
#    python -m app.ml.train_isolation_forest --source datasets/synthetic_claims.csv --max-rows 60000
#    python -m app.ml.train_provider_model   --items-csv datasets/billing_items.csv --source datasets/synthetic_claims.csv
#    uvicorn app.main:app --reload

# 2. dashboard (http://localhost:5173)
cd frontend/claims-dashboard && npm install && npm run dev
```

Without the training step the engine still runs; the two ML models simply report `UNAVAILABLE` and
the rule engines carry the analysis on their own.

### Check it works

```bash
cd services/detection-agent
pytest -q                          # 97 tests
python samples/verify_samples.py   # all 5 leakage scenarios + a clean control + the RAG round trip
```

`samples/` has one fixture per leakage scenario, each asserting its own expected outcome — see the
[engine README](services/detection-agent/README.md#samples-and-verification).

### Try it in the dashboard

- **Ingest** — load the health sample and press _Analyse with ClaimsGuard engine_. The dashboard
  posts to `http://localhost:8000/v1/detect` (override with `VITE_AGENT_URL` or the _Agent
  connection_ page).
- **Policy reader** — upload `services/detection-agent/samples/policy-document.txt` (or any policy
  PDF/scan; OCR runs in the browser). The engine retrieves the governing clauses and extracts the
  deductible, co-payment, sum insured, sub-limits, exclusions and waiting periods, each cited back
  to its clause. Press _Use for next ingest_ and the next claim pack is assessed against those
  clauses. Terms the document never states are listed as unresolved rather than assumed. For
  Gemini-generated, clause-grounded answers, add your key to the backend's git-ignored
  `services/detection-agent/.env` as `GEMINI_API_KEY`; never put the key in frontend code or chat.

## Repository layout

```text
frontend/
  claims-dashboard/   # React + Vite frontend
services/
  detection-agent/    # FastAPI detection engine (this is where the backend lives)

# Add other team-owned products as separate directories, for example:
# contracts/                 # agreed API schemas shared across products
# docs/                      # repository-wide architecture and team decisions
```

The example directories are organizational guidance; create them when the corresponding team is ready to contribute.

## Collaboration conventions

- Keep each product's source, dependencies, scripts, and product-specific docs in its own directory.
- Put shared API contracts in one agreed location and coordinate schema changes with both sides.
- Use short-lived feature branches and pull requests into `main`; avoid unrelated changes in a product another team owns.
- Keep root-level files limited to repository-wide guidance and settings. Add product-specific tooling/configuration inside that product's folder.

For setup and run instructions, see [frontend/claims-dashboard/README.md](frontend/claims-dashboard/README.md).
