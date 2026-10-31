# ClaimsGuard AI — frontend desk

Hackathon UI for **Claims Leakage Detection**. Core detection (rules, CatBoost, Isolation Forest, RapidFuzz) lives in the sister project. This app is the claims desk: ingest, OCR, structured payload, dashboards, investigation and special review.

## Run

From the repository root, enter this product directory first:

```bash
cd frontend/claims-dashboard
npm install
npm run dev
```

Open http://localhost:5173 (or http://localhost:5174 if 5173 is already in use).

## What it does

- Ingest **JSON, CSV, Excel, PDF, images, pasted JSON, or a web URL**
- **PDF text engine** for digital PDFs; **Tesseract OCR** for images and scanned PDFs
- Maps every source into a versioned **detection payload** (`schemaVersion: 1.0`)
- Send that payload to the FastAPI engine (`Agent connection` page)
- Command center ratios, leakage vs billed, fraud-like alerts, good claims
- Escalate good or flagged claims to **special review** for supervisor agents
- Incomplete packs become **unassessed** — never invented leakage

The frontend's detection payload types live in `src/types.ts`. Coordinate changes to that contract with the detection-service team before integrating the live API.

Palette: `#2dd891`, white, black.
