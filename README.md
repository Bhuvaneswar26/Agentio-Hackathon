# Agentio Hackathon

This repository is the shared monorepo for the hackathon products. Each team should keep its application or service inside an owned top-level area instead of adding product code to the repository root.

## Current product

- **ClaimsGuard dashboard:** [frontend/claims-dashboard](frontend/claims-dashboard/README.md) — claims intake, OCR/extraction, detection payload preview, investigation dashboards, alerts, and supervisor review.

## Repository layout

```text
frontend/
  claims-dashboard/   # React + Vite frontend

# Add other team-owned products as separate directories, for example:
# services/detection-agent/  # detection API / agent service
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
