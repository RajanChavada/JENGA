"""Multimodal comparison of site photo evidence against the blueprint spec.

OpenAI is preferred; Gemini is used when only `GOOGLE_API_KEY` is present.
Both are asked for JSON, not prose.

The prompt is the point of this file. A model that guesses "looks compliant" at
a black photograph is worse than useless on a construction site, so the prompt
makes declining an explicitly correct answer and puts a number on it.
"""

from __future__ import annotations

import json
import os

from . import TIMEOUT, expected_for, log, safe_call

#: Below this, the image did not actually establish anything.
CONFIDENCE_THRESHOLD = 0.5

PROMPT = """You are a construction QA inspector reviewing a single site photograph \
submitted as evidence that a work package is complete.

BLUEPRINT SPECIFICATION:
{spec_text}

CONTRACTOR'S CLAIM:
{claim}

Compare the photograph against the specification and the claim. Respond with JSON only:

{{
  "observation": "1-2 specific sentences describing what is actually visible, and if the image cannot be read, what specifically prevents reading it",
  "matches_claim": true | false | null,
  "confidence": 0.0 to 1.0,
  "insufficient": true | false
}}

CRITICAL RULE — READ BEFORE ANSWERING:
If the photograph is underexposed, dark, shadowed, blurry, motion-smeared, \
low-resolution, obstructed, or simply framed so that the specific feature named in \
the specification is not resolvable, you MUST answer:
  "insufficient": true, "matches_claim": null, "confidence": below {threshold}
and say in the observation exactly what prevents verification.

Set "confidence" above {threshold} ONLY when the spec-relevant detail is directly \
legible in the image — not inferred from context, surroundings, or the contractor's \
wording. An honest "I cannot tell from this image" is a correct and valued answer. \
Guessing compliance from an unreadable photograph is the single worst failure you \
can make here: it signs off on work nobody has seen."""


def _normalise(raw: dict) -> dict:
    """Coerce a model response into the shape the arbiter expects."""
    try:
        confidence = float(raw.get("confidence", 0.0))
    except (TypeError, ValueError):
        confidence = 0.0
    confidence = max(0.0, min(1.0, confidence))

    matches = raw.get("matches_claim")
    if matches not in (True, False, None):
        matches = None

    insufficient = bool(raw.get("insufficient")) or confidence < CONFIDENCE_THRESHOLD
    if insufficient:
        matches = None

    return {
        "observation": str(raw.get("observation") or "No usable observation returned by the vision model."),
        "matches_claim": matches,
        "confidence": round(confidence, 2),
        "insufficient": insufficient,
    }


async def _openai(prompt: str, image_base64: str) -> dict:
    from openai import AsyncOpenAI

    client = AsyncOpenAI(api_key=os.environ["OPENAI_API_KEY"], timeout=TIMEOUT)
    resp = await client.chat.completions.create(
        model=os.getenv("JENGA_VISION_MODEL", "gpt-4o"),
        response_format={"type": "json_object"},
        max_tokens=400,
        messages=[
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": prompt},
                    {
                        "type": "image_url",
                        "image_url": {"url": f"data:image/jpeg;base64,{image_base64}"},
                    },
                ],
            }
        ],
    )
    return json.loads(resp.choices[0].message.content)


async def _gemini(prompt: str, image_base64: str) -> dict:
    import base64

    from google import genai
    from google.genai import types

    client = genai.Client(api_key=os.environ["GOOGLE_API_KEY"])
    resp = await client.aio.models.generate_content(
        model=os.getenv("JENGA_VISION_MODEL", "gemini-2.0-flash"),
        contents=[
            prompt,
            types.Part.from_bytes(data=base64.b64decode(image_base64), mime_type="image/jpeg"),
        ],
        config={"response_mime_type": "application/json"},
    )
    return json.loads(resp.text)


async def analyse_image(image_base64: str | None, spec_text: str, claim: str, task_id: str) -> dict:
    """Compare an image against the spec. Always returns a well-formed dict."""
    canned = expected_for(task_id)
    fallback = _normalise(
        dict(canned.get("vision") or {})
        | {"confidence": canned.get("confidence", 0.0)}
    )

    if not image_base64:
        # Offline demo mode: the canned vision result for this task stands in for the photo,
        # so the scripted reasoning (e.g. P-107's shadow occlusion) still reaches the UI before
        # the demo images exist. Only in offline mode — online, a missing photo is a real gap.
        if os.getenv("JENGA_OFFLINE") == "1" and canned.get("vision"):
            return fallback
        # No photo at all is the most insufficient evidence there is.
        return {
            "observation": "No photographic evidence was attached to this submission, so no visual verification of the specified work was possible.",
            "matches_claim": None,
            "confidence": 0.0,
            "insufficient": True,
        }

    prompt = PROMPT.format(spec_text=spec_text, claim=claim or "(no written claim provided)", threshold=CONFIDENCE_THRESHOLD)

    if os.getenv("OPENAI_API_KEY"):
        provider, call = "openai", _openai
    elif os.getenv("GOOGLE_API_KEY"):
        provider, call = "gemini", _gemini
    else:
        log.warning("vision: no OPENAI_API_KEY or GOOGLE_API_KEY set, using canned fallback")
        return fallback

    raw = await safe_call(f"vision[{provider}]", lambda: call(prompt, image_base64), None)
    return fallback if raw is None else _normalise(raw)
