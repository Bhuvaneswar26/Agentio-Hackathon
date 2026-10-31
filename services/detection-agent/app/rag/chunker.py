"""Clause-aware chunking of policy wordings.

Policy documents are not prose: they are numbered clauses under headings, and a retrieved fact is
only useful to a claims handler if it can be cited back to the clause it came from. The chunker
therefore splits on structure (clause numbers, headings) rather than on a fixed token window, and
every chunk keeps the clause id, heading trail and character offsets needed to build a citation.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

# Clause markers at the start of a line: "4", "4.2", "4.2.1", "C.3", "A.", "B)".
# A letter marker must carry a delimiter: a bare "A " or "I " opens an English sentence ("A
# deductible of Rs. 10,000 shall..."), and treating it as a marker splits the clause mid-sentence.
# Digits need no delimiter, since no English word starts with one.
CLAUSE_RE = re.compile(
    r"^\s*(?:"
    r"([0-9]{1,2}(?:\.[0-9]{1,2}){0,3})[.)\-]?"
    r"|([A-Z](?:\.[0-9]{1,2}){1,3})[.)\-]?"
    r"|([A-Z])[.)]"
    r")\s+(?=\S)")


def _clause_marker(line: str) -> str | None:
    m = CLAUSE_RE.match(line)
    return next((g for g in m.groups() if g), None) if m else None
# "SECTION 4 - BENEFITS", "PART II: EXCLUSIONS", "SCHEDULE OF BENEFITS", "EXCLUSIONS"
HEADING_RE = re.compile(
    r"^\s*(?:(?:SECTION|PART|ARTICLE|CLAUSE|ANNEXURE|SCHEDULE|CHAPTER)\b[^\n]{0,80}"
    r"|[A-Z][A-Z0-9 ,&/()\-']{6,80})\s*$")
PAGE_RE = re.compile(r"^\s*(?:---\s*)?page\s+(\d+)\s*(?:of\s+\d+\s*)?(?:---)?\s*$", re.IGNORECASE)

MIN_CHUNK_CHARS = 40
MAX_CHUNK_CHARS = 1800


@dataclass
class Chunk:
    """One citable unit of a policy document."""
    chunk_id: str
    text: str
    clause_id: str | None
    heading: str | None
    heading_trail: list[str] = field(default_factory=list)
    page: int | None = None
    char_start: int = 0
    char_end: int = 0

    @property
    def citation(self) -> str:
        """Human-readable reference a reviewer can look up in the document."""
        bits = []
        if self.heading:
            bits.append(self.heading.strip().title() if self.heading.isupper() else self.heading.strip())
        if self.clause_id:
            bits.append(f"Clause {self.clause_id}")
        if self.page is not None:
            bits.append(f"p.{self.page}")
        return " / ".join(bits) or self.chunk_id

    def to_dict(self) -> dict[str, Any]:
        return {"chunk_id": self.chunk_id, "clause_id": self.clause_id, "heading": self.heading,
                "heading_trail": self.heading_trail, "page": self.page, "citation": self.citation,
                "char_start": self.char_start, "char_end": self.char_end, "text": self.text}


def _is_heading(line: str) -> bool:
    s = line.strip()
    if not s or len(s) > 90 or s.endswith((".", ";", ",")):
        return False
    if _clause_marker(line):
        return False
    return bool(HEADING_RE.match(line))


def _split_oversized(text: str, limit: int = MAX_CHUNK_CHARS) -> list[str]:
    """Break a very long clause on sentence boundaries so retrieval stays precise."""
    if len(text) <= limit:
        return [text]
    parts, buf = [], ""
    for sentence in re.split(r"(?<=[.;])\s+", text):
        if buf and len(buf) + len(sentence) + 1 > limit:
            parts.append(buf.strip())
            buf = sentence
        else:
            buf = f"{buf} {sentence}".strip()
    if buf.strip():
        parts.append(buf.strip())
    return parts or [text]


def chunk_policy_document(text: str, *, source: str | None = None) -> list[Chunk]:
    """Split a policy wording into citable clause-level chunks.

    Lines are walked once, tracking the current page marker and heading trail. A new chunk starts at
    every clause number and every heading; unnumbered body text accumulates into the chunk it
    belongs to so a limit and its qualifier ("per day", "per policy year") stay together.
    """
    if not text or not text.strip():
        return []
    chunks: list[Chunk] = []
    heading_trail: list[str] = []
    page: int | None = None
    cur_lines: list[str] = []
    cur_clause: str | None = None
    cur_heading: str | None = None
    cur_trail: list[str] = []
    cur_start = 0
    offset = 0

    def flush(end: int) -> None:
        nonlocal cur_lines, cur_clause, cur_start
        body = "\n".join(cur_lines).strip()
        cur_lines = []
        if len(body) < MIN_CHUNK_CHARS and not cur_clause:
            cur_clause = None
            return
        if not body:
            cur_clause = None
            return
        for n, piece in enumerate(_split_oversized(body)):
            cid = f"{source or 'doc'}::c{len(chunks) + 1:04d}"
            chunks.append(Chunk(chunk_id=cid, text=piece, clause_id=cur_clause, heading=cur_heading,
                                heading_trail=list(cur_trail), page=page,
                                char_start=cur_start, char_end=end))
        cur_clause = None

    for raw_line in text.splitlines(keepends=True):
        line = raw_line.rstrip("\n").rstrip("\r")
        line_start, offset = offset, offset + len(raw_line)

        pm = PAGE_RE.match(line)
        if pm:
            flush(line_start)
            page = int(pm.group(1))
            cur_start = offset
            continue

        if _is_heading(line):
            flush(line_start)
            head = line.strip()
            # A heading that looks like a top-level section resets the trail; others nest under it.
            if re.match(r"^(SECTION|PART|ARTICLE|CHAPTER|SCHEDULE|ANNEXURE)\b", head, re.IGNORECASE):
                heading_trail = [head]
            else:
                heading_trail = (heading_trail[:1] + [head]) if heading_trail else [head]
            cur_heading, cur_trail = head, list(heading_trail)
            cur_start = offset
            continue

        marker = _clause_marker(line)
        if marker:
            flush(line_start)
            cur_clause = marker
            cur_heading, cur_trail = (heading_trail[-1] if heading_trail else None), list(heading_trail)
            cur_start = line_start
            cur_lines = [line.strip()]
            continue

        if not line.strip():
            continue
        if not cur_lines:
            cur_start = line_start
            cur_heading, cur_trail = (heading_trail[-1] if heading_trail else None), list(heading_trail)
        cur_lines.append(line.strip())

    flush(offset)
    return chunks
