"""JENGA's verification pipeline.

A four-node LangGraph: gptzero_gate -> vision_analysis -> historical_memory -> arbiter.

Two rules govern the arbiter, in this order:

1. GPTZero gate. An AI-authored report (ai_probability > 0.85) forces UNDER_REVIEW
   no matter how good the photograph looks. A generated narrative can describe work
   nobody performed. Under `strict=False` the gate is advisory instead: the score is
   appended to the reasoning and the remaining rules decide the status.

2. The ambiguity rule. If the image cannot actually be read — dark, occluded, blurry,
   badly framed — the verdict is UNDER_REVIEW at confidence < 0.5 with an actionable
   request naming the blueprint coordinates. The agent never infers compliance from
   evidence it could not see. Refusing to decide, and saying why, is the correct
   answer here.
"""

from __future__ import annotations

from typing import Any, TypedDict

from langgraph.graph import END, START, StateGraph

from integrations import emit, expected_for, span, transaction
from integrations.gptzero import FLAG_THRESHOLD, score_text
from integrations.memory import retrieve_similar
from integrations.vision import CONFIDENCE_THRESHOLD, analyse_image
from integrations.zip_api import detect_material_shortage  # noqa: F401  (re-exported)

class VerifyState(TypedDict, total=False):
    task: dict
    report_text: str | None
    image_base64: str | None
    transcript: str | None
    claim: str
    #: False demotes the AI gate from a hard override to an advisory line.
    strict: bool
    gptzero: dict
    vision: dict
    historical: dict
    verdict: dict


# ---------------------------------------------------------------- nodes


async def gptzero_gate(state: VerifyState) -> dict:
    """Score the written report for AI authorship. Runs first, by contract."""
    task_id = state["task"].get("id", "")
    with span("gptzero_gate", task_id=task_id, has_report=bool(state.get("report_text"))) as s:
        result = await score_text(state.get("report_text"), task_id)
        s.set_data("ai_probability", result.get("ai_probability"))
        s.set_data("flagged", result.get("flagged"))
        emit(
            "info",
            "gptzero_gate scored report",
            task_id=task_id,
            ai_probability=result.get("ai_probability"),
            flagged=bool(result.get("flagged")),
            threshold=FLAG_THRESHOLD,
        )
    return {"gptzero": result}


async def vision_analysis(state: VerifyState) -> dict:
    """Compare the photograph against the spec and the contractor's claim."""
    task = state["task"]
    task_id = task.get("id", "")
    with span("vision_analysis", task_id=task_id, has_image=bool(state.get("image_base64"))) as s:
        result = await analyse_image(
            state.get("image_base64"),
            task.get("spec_text", ""),
            state.get("claim", ""),
            task_id,
        )
        s.set_data("confidence", result.get("confidence"))
        s.set_data("matches_claim", result.get("matches_claim"))
        s.set_data("insufficient", result.get("insufficient"))
        emit(
            "info",
            "vision_analysis compared image against spec",
            task_id=task_id,
            confidence=result.get("confidence"),
            matches_claim=result.get("matches_claim"),
            insufficient=bool(result.get("insufficient")),
            threshold=CONFIDENCE_THRESHOLD,
        )
    return {"vision": result}


async def historical_memory(state: VerifyState) -> dict:
    """Retrieve comparable past work packages and their slip statistics."""
    task_id = state["task"].get("id", "")
    with span("historical_memory", task_id=task_id) as s:
        result = await retrieve_similar(state["task"])
        s.set_data("source", result.get("source"))
        s.set_data("package_count", len(result.get("packages") or []))
        emit(
            "info",
            "historical_memory retrieved comparable packages",
            task_id=task_id,
            source=result.get("source"),
            package_count=len(result.get("packages") or []),
        )
    return {"historical": result}


async def arbiter(state: VerifyState) -> dict:
    """Resolve across all three sources and emit the final Verdict."""
    task_id = state["task"].get("id", "")
    strict = bool(state.get("strict", True))
    with span("arbiter", task_id=task_id) as s:
        result = await _decide(state)
        verdict = result["verdict"]
        # Which rule fired is recoverable from the verdict itself: only the AI
        # gate produces a hold with `flagged` set — and only in strict mode,
        # where the gate can still override.
        if verdict["status"] == "UNDER_REVIEW":
            branch = "ai_gate" if strict and verdict["gptzero"]["flagged"] else "ambiguity_rule"
        elif verdict["status"] == "DISPUTED":
            branch = "contradiction"
        else:
            branch = "approved"
        s.set_data("branch", branch)
        s.set_data("strict", strict)
        s.set_data("status", verdict["status"])
        s.set_data("confidence", verdict["confidence"])
        emit(
            "info",
            "arbiter resolved verdict",
            task_id=task_id,
            branch=branch,
            strict=strict,
            status=verdict["status"],
            confidence=verdict["confidence"],
            actionable=bool(verdict["actionable_request"]),
        )
    return result


async def _decide(state: VerifyState) -> dict:
    """Pure decision logic. Kept separate so `arbiter` stays a thin traced shell."""
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
    # Strict mode lets the AI gate override every other source; lenient mode
    # demotes it to an advisory line appended once the other rules have run.
    strict = bool(state.get("strict", True))

    coords = f"blueprint coordinates X:{task.get('x')} Y:{task.get('y')}"
    where = f"{task.get('name', task_id)} in {str(task.get('zone', '')).replace('_', ' ')}"

    # Rule 1 — the AI gate. In strict mode a hard override, nothing downstream
    # can lift it. In lenient mode it does not fire at all and evaluation falls
    # through to the rules below.
    if ai_flagged and strict:
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

    # Lenient mode's advisory. Appended after the canned override so that wording
    # cannot swallow it, and only when the gate would have fired in strict mode.
    # Reasoning only — the status, confidence and request are left as the
    # surviving rule set them.
    if ai_flagged and not strict:
        reasoning = f"{reasoning.rstrip()} GPTZero advisory: {ai_prob:.0%} AI"

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


def _build_trace(state: VerifyState) -> list[dict]:
    """Turn the finished graph state into a human-readable resolution trace.

    This is the Rox beat made visible: four sources go in, and each node's read
    is surfaced in order so the agent's multi-source reasoning under uncertainty
    is legible — including where it declines to conclude.
    """
    gz = state.get("gptzero") or {}
    vision = state.get("vision") or {}
    hist = state.get("historical") or {}
    verdict = state.get("verdict") or {}

    ai_prob = float(gz.get("ai_probability", 0.0))
    ai_flagged = bool(gz.get("flagged"))
    strict = bool(state.get("strict", True))
    matches = vision.get("matches_claim")
    vis_conf = float(vision.get("confidence", 0.0))
    insufficient = bool(vision.get("insufficient")) or matches is None
    hist_source = hist.get("source", "local corpus")
    hist_count = len(hist.get("packages") or [])
    status = verdict.get("status", "UNDER_REVIEW")

    if matches is True:
        vision_detail = f"Photo is consistent with the claim ({vis_conf:.0%} confidence)."
        vision_signal = "ok"
    elif matches is False:
        vision_detail = f"Photo contradicts the claim ({vis_conf:.0%} confidence)."
        vision_signal = "bad"
    else:
        vision_detail = f"Image cannot establish the claim ({vis_conf:.0%} confidence) — insufficient." if insufficient else f"Inconclusive ({vis_conf:.0%})."
        vision_signal = "warn"

    if not ai_flagged:
        gate_detail, gate_signal = "reads as first-hand.", "ok"
    elif strict:
        gate_detail, gate_signal = "flagged, cannot auto-approve on prose.", "bad"
    else:
        # Lenient mode: say so, or the card contradicts an approval below it.
        gate_detail, gate_signal = "flagged, advisory only — not gating this verdict.", "warn"

    return [
        {
            "node": "gptzero_gate",
            "title": "1 · Authorship gate",
            "detail": f"Report scores {ai_prob:.0%} AI-authorship — {gate_detail}",
            "signal": gate_signal,
        },
        {
            "node": "vision_analysis",
            "title": "2 · Visual analysis",
            "detail": vision_detail,
            "signal": vision_signal,
        },
        {
            "node": "historical_memory",
            "title": "3 · Historical memory",
            "detail": (
                f"Compared against {hist_count} similar package(s) from {hist_source}."
                if hist_count
                else f"No close historical match ({hist_source})."
            ),
            "signal": "info",
        },
        {
            "node": "arbiter",
            "title": "4 · Arbiter",
            "detail": {
                "APPROVED": "Sources agree — approved.",
                "DISPUTED": "Sources conflict, evidence legible — disputed.",
                "UNDER_REVIEW": "Evidence insufficient — declined to rule, routed to a human.",
            }.get(status, "Resolved."),
            "signal": {"APPROVED": "ok", "DISPUTED": "bad", "UNDER_REVIEW": "warn"}.get(status, "info"),
        },
    ]


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
    strict: bool = True,
) -> dict[str, Any]:
    """Run the verification pipeline. Returns a Verdict dict. Never raises.

    `strict=False` demotes the GPTZero gate to an advisory; see `_decide`.
    """
    claim = " ".join(p.strip() for p in (report_text, transcript) if p and p.strip())
    task_id = task.get("id", "")
    try:
        with transaction(f"verify {task_id}", task_id=task_id, zone=task.get("zone", "")) as txn:
            final = await GRAPH.ainvoke(
                {
                    "task": task,
                    "report_text": report_text,
                    "image_base64": image_base64,
                    "transcript": transcript,
                    "claim": claim,
                    "strict": strict,
                }
            )
            verdict = final["verdict"]
            verdict["trace"] = _build_trace(final)
            txn.set_tag("verdict_status", verdict["status"])
        return verdict
    except Exception as exc:  # the pipeline itself must never take the demo down
        emit("warning", "verify_submission pipeline failed", task_id=task_id, error=str(exc))
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
            "trace": [
                {
                    "node": "arbiter",
                    "title": "Pipeline error",
                    "detail": "Agent could not complete; holding the package rather than defaulting to approval.",
                    "signal": "warn",
                }
            ],
            "gptzero": {"ai_probability": 0.0, "flagged": False},
            "vision": {"observation": "Vision analysis unavailable.", "matches_claim": None, "confidence": 0.0},
            "evidence": {
                "spec": task.get("spec_text", ""),
                "claim": claim or "(no written or spoken claim submitted)",
                "visual": "Vision analysis unavailable.",
                "historical": "Historical retrieval unavailable.",
            },
        }
