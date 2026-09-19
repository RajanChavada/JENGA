"""JENGA's verification pipeline.

A four-node LangGraph: gptzero_gate -> vision_analysis -> historical_memory -> arbiter.

Two rules govern the arbiter, in this order:

1. GPTZero gate. An AI-authored report (ai_probability > 0.85) forces UNDER_REVIEW
   no matter how good the photograph looks. A generated narrative can describe work
   nobody performed.

2. The ambiguity rule. If the image cannot actually be read — dark, occluded, blurry,
   badly framed — the verdict is UNDER_REVIEW at confidence < 0.5 with an actionable
   request naming the blueprint coordinates. The agent never infers compliance from
   evidence it could not see. Refusing to decide, and saying why, is the correct
   answer here.
"""

from __future__ import annotations

import logging
from typing import Any, TypedDict

from langgraph.graph import END, START, StateGraph

from integrations import expected_for
from integrations.gptzero import FLAG_THRESHOLD, score_text
from integrations.memory import retrieve_similar
from integrations.vision import CONFIDENCE_THRESHOLD, analyse_image
from integrations.zip_api import detect_material_shortage  # noqa: F401  (re-exported)

log = logging.getLogger("jenga.agent")


class VerifyState(TypedDict, total=False):
    task: dict
    report_text: str | None
    image_base64: str | None
    transcript: str | None
    claim: str
    gptzero: dict
    vision: dict
    historical: dict
    verdict: dict


# ---------------------------------------------------------------- nodes


async def gptzero_gate(state: VerifyState) -> dict:
    """Score the written report for AI authorship. Runs first, by contract."""
    task_id = state["task"].get("id", "")
    return {"gptzero": await score_text(state.get("report_text"), task_id)}


async def vision_analysis(state: VerifyState) -> dict:
    """Compare the photograph against the spec and the contractor's claim."""
    task = state["task"]
    return {
        "vision": await analyse_image(
            state.get("image_base64"),
            task.get("spec_text", ""),
            state.get("claim", ""),
            task.get("id", ""),
        )
    }


async def historical_memory(state: VerifyState) -> dict:
    """Retrieve comparable past work packages and their slip statistics."""
    return {"historical": await retrieve_similar(state["task"])}


async def arbiter(state: VerifyState) -> dict:
    """Resolve across all three sources and emit the final Verdict."""
    task = state["task"]
    task_id = task.get("id", "")
    gz = state.get("gptzero") or {"ai_probability": 0.0, "flagged": False}
    vision = state.get("vision") or {}
    hist = state.get("historical") or {}
    canned = expected_for(task_id)

    observation = vision.get("observation", "No visual observation available.")
    matches = vision.get("matches_claim")
    vis_conf = float(vision.get("confidence", 0.0))
    hist_summary = hist.get("summary", "No comparable historical packages were found.")
    ai_prob = float(gz.get("ai_probability", 0.0))
    ai_flagged = bool(gz.get("flagged")) or ai_prob > FLAG_THRESHOLD

    coords = f"blueprint coordinates X:{task.get('x')} Y:{task.get('y')}"
    where = f"{task.get('name', task_id)} in {str(task.get('zone', '')).replace('_', ' ')}"

    # Rule 1 — the AI gate. Hard override, nothing downstream can lift it.
    if ai_flagged:
        status = "UNDER_REVIEW"
        confidence = min(vis_conf, 0.49)
        reasoning = (
            f"The written report scores {ai_prob:.0%} on GPTZero's AI-authorship check, above the "
            f"{FLAG_THRESHOLD:.0%} threshold at which JENGA stops treating a narrative as a first-hand "
            f"account of work performed. A generated report can fluently describe a pour that nobody "
            f"stood and watched, so this submission cannot auto-approve on the strength of its prose "
            f"regardless of what the accompanying photograph appears to show. {observation} "
            f"For context: {hist_summary} This is routed to a human inspector — not because the work "
            f"is assumed deficient, but because the account of it has not been established as real."
        )
        request = (
            f"Report text for {where} is flagged as likely AI-generated. Require the crew lead to "
            f"re-submit a first-hand written account, or confirm the work in person at {coords}."
        )

    # Rule 2 — the ambiguity rule. Never infer compliance from an unreadable image.
    elif vision.get("insufficient") or matches is None or vis_conf < CONFIDENCE_THRESHOLD:
        status = "UNDER_REVIEW"
        confidence = min(vis_conf, 0.49)
        reasoning = (
            f"The photographic evidence does not establish the claim. {observation} "
            f"The vision analysis returned {vis_conf:.2f} confidence, below the "
            f"{CONFIDENCE_THRESHOLD:.2f} floor required for an automated decision, so JENGA is "
            f"declining to rule rather than guessing. Approving on this evidence would mean signing "
            f"off on {where} on the strength of an image in which the specified detail is not "
            f"actually legible — the spec calls for \"{task.get('spec_text', '')}\" and that cannot "
            f"be confirmed from what was submitted. {hist_summary} The package is held for "
            f"re-inspection; a clear photograph is likely to resolve it in minutes."
        )
        request = (
            f"Re-photograph {where} at {coords} under adequate lighting, framed so the feature "
            f"described in the specification is unobstructed and in focus, and re-submit for verification."
        )

    elif matches is False:
        status = "DISPUTED"
        confidence = round(vis_conf, 2)
        reasoning = (
            f"The photograph contradicts the submitted claim. {observation} The specification for "
            f"{where} requires \"{task.get('spec_text', '')}\", and the visible condition at {coords} "
            f"does not meet it at {vis_conf:.2f} confidence. {hist_summary} This is raised as a "
            f"dispute rather than a review hold because the evidence is legible — it simply shows "
            f"something other than what was reported."
        )
        request = None

    else:
        status = "APPROVED"
        confidence = round(vis_conf, 2)
        reasoning = (
            f"The photographic evidence supports the claim. {observation} The submitted image is "
            f"legible enough to rule on, returning {vis_conf:.2f} confidence against the "
            f"{CONFIDENCE_THRESHOLD:.2f} floor, and the report reads as a first-hand account "
            f"({ai_prob:.0%} AI-authorship probability, well under the {FLAG_THRESHOLD:.0%} gate). "
            f"The work matches the specification for {where} at {coords}. {hist_summary} "
            f"Approved without escalation."
        )
        request = None

    # Prefer the demo script's own wording when we are running from canned evidence,
    # but never let it break the two invariants above.
    if canned.get("status") == status:
        reasoning = canned.get("reasoning") or reasoning
        request = canned.get("actionable_request") or request
        if isinstance(canned.get("confidence"), (int, float)):
            confidence = float(canned["confidence"])

    if status == "UNDER_REVIEW":
        confidence = min(confidence, 0.49)
        request = request or (
            f"Re-inspect {where} at {coords} and re-submit evidence."
        )
        if "X:" not in request:
            request = f"{request.rstrip()} Blueprint coordinates X:{task.get('x')} Y:{task.get('y')}."
    else:
        request = None

    return {
        "verdict": {
            "task_id": task_id,
            "status": status,
            "confidence": round(max(0.0, min(1.0, confidence)), 2),
            "reasoning": reasoning,
            "actionable_request": request,
            "gptzero": {"ai_probability": round(ai_prob, 3), "flagged": ai_flagged},
            "vision": {
                "observation": observation,
                "matches_claim": matches,
                "confidence": round(vis_conf, 2),
            },
            "evidence": {
                "spec": task.get("spec_text", ""),
                "claim": state.get("claim") or "(no written or spoken claim submitted)",
                "visual": observation,
                "historical": hist_summary,
            },
        }
    }


# ---------------------------------------------------------------- graph

_graph = StateGraph(VerifyState)
_graph.add_node("gptzero_gate", gptzero_gate)
_graph.add_node("vision_analysis", vision_analysis)
_graph.add_node("historical_memory", historical_memory)
_graph.add_node("arbiter", arbiter)
_graph.add_edge(START, "gptzero_gate")
_graph.add_edge("gptzero_gate", "vision_analysis")
_graph.add_edge("vision_analysis", "historical_memory")
_graph.add_edge("historical_memory", "arbiter")
_graph.add_edge("arbiter", END)
GRAPH = _graph.compile()


async def verify_submission(
    task: dict,
    report_text: str | None,
    image_base64: str | None,
    transcript: str | None,
) -> dict[str, Any]:
    """Run the verification pipeline. Returns a Verdict dict. Never raises."""
    claim = " ".join(p.strip() for p in (report_text, transcript) if p and p.strip())
    try:
        final = await GRAPH.ainvoke(
            {
                "task": task,
                "report_text": report_text,
                "image_base64": image_base64,
                "transcript": transcript,
                "claim": claim,
            }
        )
        return final["verdict"]
    except Exception as exc:  # the pipeline itself must never take the demo down
        log.warning("verify_submission: pipeline failed (%s), returning review hold", exc)
        task_id = task.get("id", "")
        return {
            "task_id": task_id,
            "status": "UNDER_REVIEW",
            "confidence": 0.0,
            "reasoning": (
                "The verification pipeline could not complete, so no automated judgement was "
                "reached about this submission. JENGA holds the package rather than defaulting "
                "to approval: an unverified sign-off is the one outcome worse than a delay."
            ),
            "actionable_request": (
                f"Re-run verification for {task.get('name', task_id)}, or inspect manually at "
                f"blueprint coordinates X:{task.get('x')} Y:{task.get('y')}."
            ),
            "gptzero": {"ai_probability": 0.0, "flagged": False},
            "vision": {"observation": "Vision analysis unavailable.", "matches_claim": None, "confidence": 0.0},
            "evidence": {
                "spec": task.get("spec_text", ""),
                "claim": claim or "(no written or spoken claim submitted)",
                "visual": "Vision analysis unavailable.",
                "historical": "Historical retrieval unavailable.",
            },
        }
