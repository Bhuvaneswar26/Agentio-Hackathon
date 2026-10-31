# Agentio Hackathon

This repository is the shared monorepo for the hackathon products. Each team should keep its application or service inside an owned top-level area instead of adding product code to the repository root.

## Current product

- **ClaimsGuard dashboard:** [frontend/claims-dashboard](frontend/claims-dashboard/README.md) — claims intake, OCR/extraction, detection payload preview, investigation dashboards, alerts, and supervisor review.

- **Detection engine:** [services/detection-agent](services/detection-agent/README.md) — FastAPI + PostgreSQL service: policy mapping, rule engine, duplicate detection, billing anomalies, CatBoost / Isolation Forest signals, settlement calculation, risk scoring, explainable findings and audit trail.

## Run everything locally

```bash
# 1. engine (API on http://localhost:8000, docs at /docs)
cd services/detection-agent && docker compose up --build
#    or without Docker: pip install -r requirements.txt && CG_DATABASE_URL=sqlite:///./dev.db uvicorn app.main:app --reload

# 2. dashboard (http://localhost:5173)
cd frontend/claims-dashboard && npm install && npm run dev
```

On the dashboard open **Ingest**, load the health sample and press **Analyse with ClaimsGuard engine**. The dashboard posts to `http://localhost:8000/v1/detect` (override with `VITE_AGENT_URL` or the *Agent connection* page).

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
