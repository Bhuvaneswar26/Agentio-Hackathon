"""Retrieval over policy-document chunks.

The retriever is intentionally dependency-light: a character+word TF-IDF index with cosine
similarity, which runs offline with no API key and no model download, plus a RapidFuzz lexical
score that rescues short keyword queries ("co-payment", "ICU") that TF-IDF alone ranks poorly on
a small corpus. Scores are returned so downstream extraction can refuse low-confidence evidence
instead of guessing.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Iterable

import numpy as np
from rapidfuzz import fuzz
from sklearn.feature_extraction.text import TfidfVectorizer

from app.rag.chunker import Chunk

# Vocabulary that policy wordings use for the facts we care about. Expanding the query with these
# synonyms is the cheap, auditable alternative to a learned embedding: it lifts recall on clauses
# that phrase the same limit differently ("sub-limit", "capped at", "maximum payable").
QUERY_EXPANSIONS: dict[str, list[str]] = {
    "deductible": ["deductible", "excess", "self retention", "aggregate deductible", "borne by the insured"],
    "copayment": ["co-payment", "copayment", "co pay", "copay", "share of the claim", "percentage of the admissible"],
    "sum_insured": ["sum insured", "annual limit", "policy limit", "maximum liability", "overall limit"],
    "room_rent": ["room rent", "room charges", "accommodation", "per day", "bed charges", "daily limit"],
    "icu": ["icu", "intensive care", "critical care unit"],
    "exclusion": ["exclusion", "excluded", "not payable", "shall not cover", "no claim shall be admissible"],
    "sublimit": ["sub-limit", "sublimit", "capped at", "maximum payable", "limited to", "subject to a limit"],
    "waiting_period": ["waiting period", "months of continuous coverage", "shall not be payable during the first"],
    "policy_period": ["policy period", "period of insurance", "valid from", "commencement date", "expiry date"],
}


@dataclass
class Retrieved:
    chunk: Chunk
    score: float
    tfidf_score: float
    lexical_score: float

    def to_dict(self) -> dict[str, Any]:
        return {**self.chunk.to_dict(), "score": round(self.score, 4),
                "tfidf_score": round(self.tfidf_score, 4), "lexical_score": round(self.lexical_score, 4)}


def expand_query(query: str, topics: Iterable[str] = ()) -> str:
    terms = [query]
    for topic in topics:
        terms.extend(QUERY_EXPANSIONS.get(topic, []))
    return " ".join(terms)


class ChunkRetriever:
    """TF-IDF + lexical hybrid retriever over one policy document."""

    def __init__(self, chunks: list[Chunk]):
        self.chunks = chunks
        self._matrix = None
        self._vectorizer: TfidfVectorizer | None = None
        if not chunks:
            return
        corpus = [self._searchable(c) for c in chunks]
        # sublinear_tf dampens repeated boilerplate; a 1-2 word ngram range keeps phrases like
        # "per day" and "waiting period" intact. min_df=1 because a policy document is a small corpus.
        self._vectorizer = TfidfVectorizer(lowercase=True, ngram_range=(1, 2), sublinear_tf=True,
                                           min_df=1, stop_words=None)
        self._matrix = self._vectorizer.fit_transform(corpus)

    @staticmethod
    def _searchable(chunk: Chunk) -> str:
        """Index the heading trail alongside the body so "Exclusions / gloves" matches either way."""
        return " ".join(filter(None, [*chunk.heading_trail, chunk.clause_id or "", chunk.text]))

    def search(self, query: str, *, top_k: int = 5, topics: Iterable[str] = (),
               min_score: float = 0.0) -> list[Retrieved]:
        if not self.chunks or self._matrix is None or self._vectorizer is None:
            return []
        expanded = expand_query(query, topics)
        qv = self._vectorizer.transform([expanded])
        # Rows are L2-normalised by TfidfVectorizer, so the dot product is already cosine similarity.
        tfidf = (self._matrix @ qv.T).toarray().ravel()
        out: list[Retrieved] = []
        for i, chunk in enumerate(self.chunks):
            lex = fuzz.token_set_ratio(expanded.lower(), self._searchable(chunk).lower()) / 100.0
            # TF-IDF carries the ranking; the lexical term only breaks ties and rescues keyword queries.
            score = 0.75 * float(tfidf[i]) + 0.25 * lex
            if score >= min_score:
                out.append(Retrieved(chunk, score, float(tfidf[i]), lex))
        out.sort(key=lambda r: r.score, reverse=True)
        return out[:top_k]

    @property
    def size(self) -> int:
        return len(self.chunks)

    @property
    def vocabulary_size(self) -> int:
        return len(self._vectorizer.vocabulary_) if self._vectorizer is not None else 0
