"""Policy-document RAG endpoints: read a policy wording into a structured, cited policy."""
from __future__ import annotations

from datetime import date

from fastapi import APIRouter, File, HTTPException, UploadFile
from pydantic import BaseModel, Field

from app.core.utils import jsonable
from app.rag.llm_extractor import answer_with_gemini
from app.rag.llm_extractor import available as llm_available
from app.rag.llm_extractor import configured_model, configured_provider
from app.rag.service import DEFAULT_MIN_CONFIDENCE, PolicyDocumentIndex, answer_question, extract_policy

router = APIRouter(prefix="/api/v1/policy", tags=["policy-rag"])

MAX_DOCUMENT_CHARS = 2_000_000


class PolicyExtractRequest(BaseModel):
    document_text: str = Field(min_length=1, description="Policy wording as plain text")
    policy_number: str | None = None
    policy_type: str | None = None
    valid_from: date | None = None
    valid_until: date | None = None
    use_llm: bool = Field(default=False, description="Also run grounded LLM extraction over retrieved clauses")
    min_confidence: float = Field(default=DEFAULT_MIN_CONFIDENCE, ge=0.0, le=1.0)
    top_k: int = Field(default=6, ge=1, le=25)


class PolicyQuestionRequest(BaseModel):
    document_text: str = Field(min_length=1)
    question: str = Field(min_length=2)
    top_k: int = Field(default=4, ge=1, le=15)
    use_llm: bool = Field(default=True, description="Generate a grounded answer with Gemini")


def _index(text: str, policy_number: str | None = None) -> PolicyDocumentIndex:
    if len(text) > MAX_DOCUMENT_CHARS:
        raise HTTPException(413, {"error": "DOCUMENT_TOO_LARGE", "characters": len(text),
                                  "limit": MAX_DOCUMENT_CHARS})
    index = PolicyDocumentIndex(text, source=policy_number or "policy-document", policy_number=policy_number)
    if not index.chunks:
        raise HTTPException(422, {"error": "NO_CLAUSES_FOUND",
                                  "message": "No readable clauses were found in the document. If this is a "
                                             "scanned PDF, run OCR before uploading the text."})
    return index


@router.post("/extract", summary="Extract a structured, clause-cited policy from a policy document")
def extract(body: PolicyExtractRequest):
    index = _index(body.document_text, body.policy_number)
    result = extract_policy(
        index, policy_number=body.policy_number, policy_type=body.policy_type,
        valid_from=body.valid_from, valid_until=body.valid_until, use_llm=body.use_llm,
        min_confidence=body.min_confidence, top_k=body.top_k)
    return jsonable({"success": True, **result.to_dict()})


@router.post("/extract/upload", summary="Same as /extract, for a text, markdown or CSV policy file")
async def extract_upload(file: UploadFile = File(...), policy_number: str | None = None,
                         policy_type: str | None = None, use_llm: bool = False):
    raw = await file.read()
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        try:
            text = raw.decode("latin-1")
        except Exception:
            raise HTTPException(422, {"error": "UNREADABLE_FILE",
                                      "message": "Upload UTF-8 text. Extract PDF/image text first "
                                                 "(the dashboard does this) and post it to /extract."})
    index = _index(text, policy_number)
    result = extract_policy(index, policy_number=policy_number, policy_type=policy_type, use_llm=use_llm)
    return jsonable({"success": True, "filename": file.filename, **result.to_dict()})


@router.post("/ask", summary="Retrieve the policy clauses that answer a question, with citations")
def ask(body: PolicyQuestionRequest):
    index = _index(body.document_text)
    result = answer_question(index, body.question, top_k=body.top_k)
    if body.use_llm and result["answered"]:
        hits = index.search(body.question, top_k=body.top_k)
        try:
            result.update(answer_with_gemini(body.question, hits))
        except Exception as exc:
            raise HTTPException(503, {"error": "GEMINI_ANSWER_FAILED", "message": str(exc)}) from exc
    return jsonable({"success": True, **result})


@router.get("/rag/status", summary="RAG component availability")
def rag_status():
    ok, reason = llm_available()
    return {
        "retrieval": {"status": "AVAILABLE", "method": "TF-IDF (scikit-learn) cosine + RapidFuzz lexical blend",
                      "requires_api_key": False},
        "rule_based_extraction": {"status": "AVAILABLE",
                                  "fields": ["deductible", "copayment_percentage", "sum_insured", "sublimits",
                                             "exclusions", "coverage", "waiting_periods"]},
        "llm_extraction": {"status": "AVAILABLE" if ok else "UNAVAILABLE", "reason": reason,
                           "provider": configured_provider(), "model": configured_model(),
                           "note": "Optional for extraction; the Ask action requires Gemini."},
    }
