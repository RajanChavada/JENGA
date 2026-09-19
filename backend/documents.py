"""Messy document ingestion for PDFs, Word docs and plaintext reports.

The parser intentionally stays conservative: extract text, preserve enough
preview for humans, and never mutate the live DAG from a document proposal.
"""

from __future__ import annotations

import io
import json
import os
import re
import zipfile
from html import unescape
from pathlib import Path
from xml.etree import ElementTree

from schemas import ProposedTask

ZONE_KEYWORDS = {
    "track_bed": ("track", "rail", "third rail", "direct-fixation"),
    "south_platform": ("south platform", "platform edge", "tactile"),
    "north_platform": ("north platform",),
    "mezzanine": ("mezzanine", "fare gate", "transfer slab", "fit-out"),
    "escalator_well": ("escalator", "well", "pit"),
}


def _clean(text: str) -> str:
    text = text.replace("\x00", "")
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def _decode_bytes(data: bytes) -> str:
    for enc in ("utf-8", "utf-16", "latin-1"):
        try:
            return data.decode(enc)
        except UnicodeDecodeError:
            pass
    return data.decode("utf-8", errors="ignore")


def _pdf_text(data: bytes) -> str:
    try:
        from pypdf import PdfReader

        reader = PdfReader(io.BytesIO(data))
        return "\n".join(page.extract_text() or "" for page in reader.pages)
    except Exception:
        return ""


def _docx_text(data: bytes) -> str:
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as zf:
            xml = zf.read("word/document.xml")
    except Exception:
        return ""

    try:
        root = ElementTree.fromstring(xml)
    except ElementTree.ParseError:
        return ""

    ns = {"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"}
    paragraphs: list[str] = []
    for p in root.findall(".//w:p", ns):
        words = [node.text or "" for node in p.findall(".//w:t", ns)]
        line = "".join(words).strip()
        if line:
            paragraphs.append(unescape(line))
    return "\n".join(paragraphs)


def parse_document(filename: str, data: bytes) -> dict:
    suffix = Path(filename).suffix.lower()
    if suffix == ".pdf":
        text = _pdf_text(data)
        kind = "pdf"
    elif suffix == ".docx":
        text = _docx_text(data)
        kind = "docx"
    elif suffix == ".doc":
        # Binary .doc is intentionally not guessed at. A decoded fallback may
        # recover text from exported docs, but otherwise the preview will say so.
        text = _decode_bytes(data)
        kind = "doc"
    else:
        text = _decode_bytes(data)
        kind = suffix.lstrip(".") or "text"

    text = _clean(text)
    if not text:
        text = (
            "No extractable text was found. Re-export the document as PDF, DOCX, "
            "TXT or MD, or attach a scan with OCR text."
        )
    preview = text[:1200]
    return {
        "filename": filename,
        "kind": kind,
        "char_count": len(text),
        "text": text,
        "preview": preview,
    }


def _zone_for(text: str):
    haystack = text.lower()
    for zone, keys in ZONE_KEYWORDS.items():
        if any(k in haystack for k in keys):
            return zone
    return "mezzanine"


def _duration_for(text: str) -> int:
    match = re.search(r"(\d{1,2})\s*(?:day|d)\b", text, re.I)
    if match:
        return max(1, min(30, int(match.group(1))))
    if re.search(r"pour|concrete|slab", text, re.I):
        return 6
    if re.search(r"rebar|form", text, re.I):
        return 4
    if re.search(r"install|track|escalator", text, re.I):
        return 8
    return 5


def _fallback_tasks(filename: str, text: str) -> dict:
    """Heuristic extraction that handles messy specs without pretending certainty."""
    candidates: list[str] = []
    for raw in re.split(r"(?:\n\s*){2,}|[.;]\s+", text):
        line = raw.strip(" -\n\t")
        if len(line) < 24:
            continue
        if re.search(r"install|pour|place|form|excavate|verify|inspect|track|rebar|slab", line, re.I):
            candidates.append(line)
        if len(candidates) >= 6:
            break

    if not candidates:
        candidates = [
            "Verify submitted specification against the affected station zone and request a clearer work breakdown before scheduling."
        ]

    tasks: list[ProposedTask] = []
    for idx, line in enumerate(candidates[:6], start=1):
        words = re.sub(r"[^A-Za-z0-9 ]+", " ", line).split()
        name = " ".join(words[:7]).strip() or f"Extracted Work Package {idx}"
        tasks.append(
            ProposedTask(
                name=name[:72],
                zone=_zone_for(line),
                duration_days=_duration_for(line),
                spec_text=line[:500],
                depends_on=[tasks[-1].name] if idx > 1 and re.search(r"after|following|once", line, re.I) else [],
            )
        )

    return {
        "filename": filename,
        "tasks": [t.model_dump() for t in tasks],
        "source": "offline",
        "notes": (
            "Heuristic extraction from uploaded text. JENGA proposes packages for review "
            "and keeps the live CPM graph unchanged until a planner accepts them."
        ),
    }


def _normalise_task(raw: dict, idx: int) -> ProposedTask:
    zone = raw.get("zone")
    if zone not in ZONE_KEYWORDS:
        zone = _zone_for(" ".join(str(v) for v in raw.values()))
    try:
        duration = int(raw.get("duration_days", 5))
    except (TypeError, ValueError):
        duration = 5
    deps = raw.get("depends_on") or []
    if not isinstance(deps, list):
        deps = []
    return ProposedTask(
        name=str(raw.get("name") or f"Extracted Work Package {idx}")[:72],
        zone=zone,
        duration_days=max(1, min(30, duration)),
        spec_text=str(raw.get("spec_text") or "")[:500],
        depends_on=[str(d)[:72] for d in deps[:4]],
    )


async def _llm_tasks(filename: str, text: str) -> dict | None:
    if os.getenv("JENGA_OFFLINE") == "1" or not os.getenv("OPENAI_API_KEY"):
        return None

    try:
        from openai import AsyncOpenAI
    except Exception:
        return None

    prompt = f"""Extract construction work packages from this uploaded spec/report.

Return JSON only:
{{
  "tasks": [
    {{
      "name": "short task name",
      "zone": "track_bed | south_platform | north_platform | mezzanine | escalator_well",
      "duration_days": 1,
      "spec_text": "specific requirement from the document",
      "depends_on": ["prior task names if explicitly stated"]
    }}
  ],
  "notes": "short caveat about ambiguity or missing dependency information"
}}

Rules:
- Extract at most 6 tasks.
- If the document is a daily report, extract only the work package(s) it claims.
- Do not invent dependencies or certainty that is not in the document.
- Preserve ambiguity in notes rather than guessing.

DOCUMENT {filename}:
{text[:12000]}"""

    try:
        client = AsyncOpenAI(timeout=8)
        resp = await client.chat.completions.create(
            model=os.getenv("JENGA_DOC_MODEL", "gpt-4o-mini"),
            response_format={"type": "json_object"},
            max_tokens=1200,
            messages=[{"role": "user", "content": prompt}],
        )
        payload = json.loads(resp.choices[0].message.content or "{}")
        raw_tasks = payload.get("tasks") or []
        if not isinstance(raw_tasks, list) or not raw_tasks:
            return None
        tasks = [_normalise_task(t, i) for i, t in enumerate(raw_tasks[:6], start=1)]
        return {
            "filename": filename,
            "tasks": [t.model_dump() for t in tasks],
            "source": "llm",
            "notes": str(
                payload.get("notes")
                or "Model-extracted package proposal. Planner review required before graph mutation."
            )[:500],
        }
    except Exception as exc:
        print(f"[documents] llm extraction failed ({exc}); using offline extractor")
        return None


async def propose_tasks(filename: str, text: str) -> dict:
    """Use AI extraction when available; otherwise fall back to deterministic heuristics."""
    return await _llm_tasks(filename, text) or _fallback_tasks(filename, text)
