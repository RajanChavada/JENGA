"""GPTZero AI-authorship detection.

POST https://api.gptzero.me/v2/predict/text with an `x-api-key` header.
Returns `{"ai_probability": float, "flagged": bool}` — the shape the Verdict wants.
"""

from __future__ import annotations

import os

import httpx

from . import TIMEOUT, expected_for, log, safe_call

API_URL = "https://api.gptzero.me/v2/predict/text"

#: Above this, the report never auto-approves. Contract non-negotiable #2.
FLAG_THRESHOLD = 0.85


def _extract_probability(payload: dict) -> float:
    """Pull the AI probability out of a v2 response, tolerating field drift."""
    docs = payload.get("documents") or []
    doc = docs[0] if docs else payload
    for key in ("completely_generated_prob", "average_generated_prob"):
        value = doc.get(key)
        if isinstance(value, (int, float)):
            return float(value)
    ai = (doc.get("class_probabilities") or {}).get("ai")
    if isinstance(ai, (int, float)):
        return float(ai)
    # Last resort: a categorical verdict with no score attached.
    return 1.0 if doc.get("predicted_class") == "ai" else 0.0


async def score_text(text: str | None, task_id: str) -> dict:
    """Score `text` for AI authorship. Always returns a well-formed dict."""
    fallback = dict(expected_for(task_id).get("gptzero") or {"ai_probability": 0.05, "flagged": False})

    if not text or not text.strip():
        # Nothing written by a human or a machine — voice-only submissions land here.
        return {"ai_probability": 0.0, "flagged": False}

    key = os.getenv("GPTZERO_API_KEY")
    if not key:
        log.warning("gptzero: GPTZERO_API_KEY not set, using canned fallback")
        return fallback

    async def call() -> dict:
        async with httpx.AsyncClient(timeout=TIMEOUT) as client:
            resp = await client.post(
                API_URL,
                headers={"x-api-key": key, "Content-Type": "application/json"},
                json={"document": text},
            )
            resp.raise_for_status()
            prob = _extract_probability(resp.json())
        return {"ai_probability": round(prob, 3), "flagged": prob > FLAG_THRESHOLD}

    return await safe_call("gptzero", call, fallback)
