from __future__ import annotations

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.api import analyze, dashboard, detect, findings
from app.core.config import get_settings
from app.core.database import init_db
from app.core.logging import setup_logging
from app.ml.inference import get_registry


@asynccontextmanager
async def lifespan(app: FastAPI):
    s = get_settings()
    setup_logging(s.log_level)
    if s.auto_create_tables:
        init_db()
    logging.getLogger(__name__).info("ML models: %s", get_registry(str(s.model_dir)).status)
    yield


def create_app() -> FastAPI:
    app = FastAPI(title="ClaimsGuard AI", version="1.0.0", lifespan=lifespan,
                  description="Insurance claims leakage detection: structured JSON in, explainable analysis JSON out.")
    app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

    @app.exception_handler(RequestValidationError)
    async def validation_handler(_: Request, exc: RequestValidationError):
        errors = [{"field": ".".join(str(p) for p in e["loc"] if p != "body"), "code": e["type"], "message": e["msg"]}
                  for e in exc.errors()]
        return JSONResponse(status_code=422, content={"success": False, "status": "VALIDATION_FAILED", "errors": errors})

    app.include_router(analyze.router)
    app.include_router(findings.router)
    app.include_router(dashboard.router)
    app.include_router(detect.router)

    @app.get("/health", tags=["ops"])
    def health():
        return {"status": "ok"}

    @app.get("/api/v1/models/status", tags=["ops"])
    def models_status():
        return get_registry(str(get_settings().model_dir)).status

    return app


app = create_app()
