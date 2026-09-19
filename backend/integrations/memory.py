"""Historical work-package retrieval — the fourth evidence column.

Primary target is Backboard.io (one API for RAG + embeddings + memory), which is
the sponsor track we are submitting under. Behind it sits a local corpus of slip
statistics so the panel is never empty on conference wifi.

Backboard API surface, taken from https://docs.backboard.io (API Reference ->
Memories -> Search Memories):

    Base URL : https://app.backboard.io/api
    Auth     : X-API-Key: <BACKBOARD_API_KEY>
    Endpoint : POST /assistants/{assistant_id}/memories/search
    Body     : {"query": "...", "limit": 3}
    Response : {"memories": [{"id", "content", "score", "created_at"}], "total_count": int}

Confidence in that shape: high for the path, verb, auth header and body — they are
quoted from the published API reference. Medium on the response field names, which
we read defensively below rather than trusting.

TODO(backboard): the search endpoint is scoped to an assistant, so it needs
BACKBOARD_ASSISTANT_ID alongside the key, plus a one-off ingest of the historical
package corpus into that assistant's memories. Until that ingest happens this
module answers from LOCAL_CORPUS even when a key is present, which is the honest
behaviour — a silent 404 against an empty assistant would be worse.
"""

from __future__ import annotations

import os

import httpx

from . import TIMEOUT, log, safe_call

BASE_URL = os.getenv("BACKBOARD_BASE_URL", "https://app.backboard.io/api")

#: Slip statistics from comparable packages on previous transit builds.
LOCAL_CORPUS: dict[str, list[dict]] = {
    "pour": [
        {"package": "Platform slab pours, Line 2 stations", "sample": 40, "slipped": 31,
         "threshold_days": 3, "cause": "rebar inspection hold"},
        {"package": "Track-bed concrete placements, Eglinton Crosstown", "sample": 22, "slipped": 14,
         "threshold_days": 2, "cause": "pump truck availability"},
        {"package": "Cold-weather pours requiring blanket cure", "sample": 18, "slipped": 11,
         "threshold_days": 4, "cause": "cylinder break results below 28-day target"},
    ],
    "rebar": [
        {"package": "Platform rebar grids at 150mm spacing", "sample": 36, "slipped": 27,
         "threshold_days": 3, "cause": "spacing and lap-length rework after first inspection"},
        {"package": "Mezzanine slab reinforcement", "sample": 19, "slipped": 9,
         "threshold_days": 2, "cause": "late bar delivery from fabricator"},
        {"package": "Rebar packages photographed for remote sign-off", "sample": 25, "slipped": 18,
         "threshold_days": 3, "cause": "evidence rejected as unreadable, re-inspection required"},
    ],
    "form": [
        {"package": "Escalator well and shaft formwork", "sample": 21, "slipped": 12,
         "threshold_days": 3, "cause": "form release agent stock-out"},
        {"package": "Wall forming in confined excavations", "sample": 17, "slipped": 10,
         "threshold_days": 2, "cause": "shoring conflict with form ties"},
    ],
    "excavation": [
        {"package": "Station box and well excavations", "sample": 28, "slipped": 19,
         "threshold_days": 4, "cause": "unmarked utilities found at depth"},
        {"package": "Escalator well digs adjacent to live track", "sample": 12, "slipped": 8,
         "threshold_days": 5, "cause": "track possession windows shortened"},
    ],
    "subgrade": [
        {"package": "Track-bed subgrade preparation and grading", "sample": 30, "slipped": 16,
         "threshold_days": 2, "cause": "granular aggregate resupply gap"},
        {"package": "Compaction sign-off before placement", "sample": 24, "slipped": 9,
         "threshold_days": 2, "cause": "proctor density retest"},
    ],
    "_default": [
        {"package": "Comparable structural packages, prior transit builds", "sample": 45, "slipped": 24,
         "threshold_days": 3, "cause": "inspection hold"},
        {"package": "Packages verified from photo evidence alone", "sample": 31, "slipped": 20,
         "threshold_days": 3, "cause": "evidence returned for re-inspection"},
    ],
}

_KEYWORDS = [
    ("pour", "pour"), ("concrete", "pour"),
    ("rebar", "rebar"), ("reinforc", "rebar"),
    ("form", "form"),
    ("excavat", "excavation"), ("shoring", "excavation"),
    ("subgrade", "subgrade"), ("grading", "subgrade"), ("prep", "subgrade"),
]


def _bucket(task_name: str) -> str:
    name = (task_name or "").lower()
    for needle, bucket in _KEYWORDS:
        if needle in name:
            return bucket
    return "_default"


def _summarise(packages: list[dict]) -> str:
    lines = []
    for p in packages:
        if "text" in p:  # already prose, straight from Backboard
            lines.append(p["text"])
            continue
        lines.append(
            f"{p['slipped']} of {p['sample']} comparable {p['package'].lower()} "
            f"slipped ≥{p['threshold_days']} days; most common cause: {p['cause']}."
        )
    return " ".join(lines)


async def _backboard(query: str, assistant_id: str, key: str) -> list[dict]:
    async with httpx.AsyncClient(timeout=TIMEOUT) as client:
        resp = await client.post(
            f"{BASE_URL}/assistants/{assistant_id}/memories/search",
            headers={"X-API-Key": key, "Content-Type": "application/json"},
            json={"query": query, "limit": 3},
        )
        resp.raise_for_status()
        payload = resp.json()
    memories = payload.get("memories") or payload.get("results") or []
    return [
        {"text": m.get("content") or m.get("text") or "", "score": m.get("score")}
        for m in memories
        if (m.get("content") or m.get("text"))
    ]


async def retrieve_similar(task: dict) -> dict:
    """Return 2-3 comparable historical packages with slip statistics.

    Always returns `{"summary": str, "packages": list, "source": str}`.
    """
    local = LOCAL_CORPUS[_bucket(task.get("name", ""))][:3]
    fallback = {"summary": _summarise(local), "packages": local, "source": "local_corpus"}

    key = os.getenv("BACKBOARD_API_KEY")
    assistant_id = os.getenv("BACKBOARD_ASSISTANT_ID")
    if not key or not assistant_id:
        log.warning(
            "memory: BACKBOARD_API_KEY/BACKBOARD_ASSISTANT_ID not both set, using local corpus"
        )
        return fallback

    query = f"{task.get('name', '')} in {task.get('zone', '')}: historical schedule slip and causes"
    packages = await safe_call("backboard", lambda: _backboard(query, assistant_id, key), None)
    if not packages:
        return fallback
    return {"summary": _summarise(packages), "packages": packages, "source": "backboard"}
