"""JENGA's verification pipeline.

A five-node LangGraph:
gptzero_gate -> vision_analysis -> historical_memory -> pace_check -> arbiter.

Rules governing the arbiter, in evaluation order:

1. GPTZero gate. An AI-authored report (ai_probability over FLAG_THRESHOLD) forces
   UNDER_REVIEW no matter how good the photograph looks. A generated narrative can
   describe work nobody performed. Under `strict=False` the gate is advisory instead:
   the score is appended to the reasoning and the remaining rules decide the status.

2. The ambiguity rule. If the image cannot actually be read — dark, occluded, blurry,
   badly framed — the verdict is UNDER_REVIEW at confidence < 0.5 with an actionable
   request naming the blueprint coordinates. The agent never infers compliance from
   evidence it could not see. Refusing to decide, and saying why, is the correct
   answer here.

0'. The pace rule (evaluated before any approval). A completion claim can pass the
   authorship gate and the photograph and still outrun the site's own measured
   pace: the earned-schedule stream (Tiger Data) knows how much verified work
   this site actually produces per day and how long the claim's zone has gone
   without producing any. When the site is clearly behind plan (SPI under
   `analytics.PACE_SPI_FLOOR`), the zone is in drought, and there is enough
   history to judge, the arbiter holds rather than approves. Too little history
   is its own answer — the rule needs `analytics.PACE_MIN_EVENTS` events before
   it will fire at all, the same discipline the old ten-readings floor kept.
"""

from __future__ import annotations

import re
from typing import Any, TypedDict

from langgraph.graph import END, START, StateGraph

import analytics
from integrations import emit, expected_for, span, transaction
from integrations.gptzero import FLAG_THRESHOLD, score_text
from integrations.memory import retrieve_similar
from integrations.vision import CONFIDENCE_THRESHOLD, analyse_image
from integrations.zip_api import detect_material_shortage  # noqa: F401  (re-exported)

#: A claim that work is done — the only kind of claim site pace can contradict.
COMPLETION_CLAIM_RE = re.compile(
    r"\b(complete(d)?|finish(ed)?|done|placed|installed|poured|cured|laid|closed out)\b", re.I
)
PACE_REQUEST = (
    "Provide a dated field record (crew logs or survey shots) demonstrating the "
    "claimed progress before downstream work proceeds."
)


class VerifyState(TypedDict, total=False):
    task: dict
    report_text: str | None
    image_base64: str | None
    transcript: str | None
    #: Set by the route handler when a video was uploaded and analyzed ahead
    #: of this call (see main.py's /video-evidence endpoint) — already in the
    #: same normalised shape `analyse_image`/`analyse_video` return, so
    #: `vision_analysis` below just passes it through rather than re-asking
    #: Gemini a second time for footage it has already seen. `media_url`
    #: (where that video is served back from) is deliberately not here — no
    #: node's decision touches it, it only ever flows main.py -> db.add_evidence
    #: -> Report, for the owner's review player.
    video_finding: dict | None
    claim: str
    #: False demotes the AI gate from a hard override to an advisory line.
    strict: bool
    #: Which arbiter rule produced the verdict. Named by the rule itself.
    branch: str
    gptzero: dict
    vision: dict
    historical: dict
    pace: dict
    verdict: dict


# ---------------------------------------------------------------- helpers


def _pace_card(pace: dict) -> tuple[str, str]:
    """(detail, signal) for the site-pace trace card.

    Re-derives `samples < min_samples` rather than trusting `flagged` alone:
    "too little history to judge" and "the site is pacing fine" are different
    facts, and one card cannot claim both.
    """
    samples = int(pace.get("samples") or 0)
    spi = pace.get("spi")
    if not samples or spi is None:
        return "No site-pace history for this project yet.", "info"
    floor = int(pace.get("min_samples") or analytics.PACE_MIN_EVENTS)
    zone = str(pace.get("zone") or "").replace("_", " ")
    window = int(pace.get("window_days") or analytics.PACE_WINDOW_DAYS)
    if samples < floor:
        return (
            f"Pace history too thin to judge: {samples} event{'' if samples == 1 else 's'} "
            f"recorded, {floor} needed."
        ), "info"
    if pace.get("flagged"):
        return (
            f"Site pacing at SPI {float(spi):.2f} (floor {analytics.PACE_SPI_FLOOR:g}) and "
            f"no verified work in {zone} for {window} days — the claim outruns the "
            f"site's measured pace."
        ), "bad"
    return (
        f"SPI {float(spi):.2f} · {float(pace.get('zone_earned_days') or 0):g}d verified in "
        f"{zone} over the last {window} days — pace consistent with the claim."
    ), "ok"


def _pace_sentence(pace: dict) -> str:
    """The clause rule 0' appends to its reasoning, quoting the measured pace."""
    zone = str(pace.get("zone") or "").replace("_", " ")
    return (
        f"The earned-schedule stream shows the site pacing at SPI "
        f"{float(pace.get('spi') or 0.0):.2f} with no verified work in {zone} for the last "
        f"{int(pace.get('window_days') or 0)} days; a completion claim here outruns the "
        f"site's own measured pace. Claim and telemetry conflict."
    )


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
    """Compare the submitted evidence — a video, or a photo — against the
    spec and the contractor's claim.

    A video is analyzed once, at upload time (see main.py's
    /video-evidence endpoint), and its finding arrives pre-computed on
    `state["video_finding"]`. When present, that finding wins outright —
    it's already in the same normalised shape `analyse_image` returns, and
    re-running Gemini here would be a second, redundant call against
    footage the pipeline has already seen. Only when no video finding is
    present does this node fall back to the (synchronous, same-request)
    photo path.
    """
    task = state["task"]
    task_id = task.get("id", "")
    video_finding = state.get("video_finding")
    with span(
        "vision_analysis",
        task_id=task_id,
        has_image=bool(state.get("image_base64")),
        has_video=bool(video_finding),
    ) as s:
        if video_finding:
            result = video_finding
        else:
            result = await analyse_image(
                state.get("image_base64"),
                task.get("spec_text", ""),
                state.get("claim", ""),
                task_id,
            )
        s.set_data("media_type", result.get("media_type", "photo"))
        s.set_data("confidence", result.get("confidence"))
        s.set_data("matches_claim", result.get("matches_claim"))
        s.set_data("insufficient", result.get("insufficient"))
        emit(
            "info",
            "vision_analysis compared evidence against spec",
            task_id=task_id,
            media_type=result.get("media_type", "photo"),
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


async def pace_check(state: VerifyState) -> dict:
    """Read the site's earned-schedule pace off the Tiger Data event stream.

    Pace is never allowed to fail a verdict: a dead analytics path degrades to
    "no history" and the pipeline carries on.
    """
    task_id = state["task"].get("id", "")
    with span("pace_check", task_id=task_id) as s:
        try:
            result = await analytics.pace_status(state["task"])
        except Exception as exc:
            emit("warning", "pace_check unavailable", task_id=task_id, error=type(exc).__name__)
            result = {"samples": 0}
        s.set_data("samples", result.get("samples"))
        s.set_data("spi", result.get("spi"))
        s.set_data("flagged", bool(result.get("flagged")))
        s.set_data("source", result.get("source"))
        emit(
            "info",
            "pace_check read earned-schedule pace",
            task_id=task_id,
            samples=result.get("samples"),
            spi=result.get("spi"),
            zone_earned_days=result.get("zone_earned_days"),
            flagged=bool(result.get("flagged")),
            source=result.get("source"),
        )
    return {"pace": result}


async def arbiter(state: VerifyState) -> dict:
    """Resolve across all four sources and emit the final Verdict."""
    task_id = state["task"].get("id", "")
    strict = bool(state.get("strict", True))
    with span("arbiter", task_id=task_id) as s:
        result = await _decide(state)
        verdict = result["verdict"]
        # Each rule names itself, so a rule added later is reported as itself
        # rather than being inferred from the verdict and mislabelled.
        branch = result["branch"]
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
    pace = state.get("pace") or {"samples": 0}
    canned = expected_for(task_id)

    observation = vision.get("observation", "No visual observation available.")
    matches = vision.get("matches_claim")
    vis_conf = float(vision.get("confidence", 0.0))
    # Reasoning text names the medium that was actually reviewed rather than
    # defaulting to "photograph" for a submission that was in fact a video.
    is_video = vision.get("media_type") == "video"
    media_noun = "video" if is_video else "photograph"
    media_evidence_noun = "video" if is_video else "photographic evidence"
    hist_summary = hist.get("summary", "No comparable historical packages were found.")
    ai_prob = float(gz.get("ai_probability", 0.0))
    ai_flagged = bool(gz.get("flagged")) or ai_prob > FLAG_THRESHOLD
    # Strict mode lets the AI gate override every other source; lenient mode
    # demotes it to an advisory line appended once the other rules have run.
    strict = bool(state.get("strict", True))
    # The recommendation is meant to weigh both axes — how AI-generated the
    # report reads, and how well the evidence matches the claim — even on
    # branches where the score wasn't the deciding factor. `ai_gate` and
    # `approved` below already name both signals in their own prose; this is
    # appended to the other three so no branch reports on the evidence alone.
    authorship_note = (
        f"Separately, the written report scores {ai_prob:.0%} on GPTZero's AI-authorship check, "
        f"{'above' if ai_flagged else 'well under'} the {FLAG_THRESHOLD:.0%} threshold."
    )

    coords = f"blueprint coordinates X:{task.get('x')} Y:{task.get('y')}"
    where = f"{task.get('name', task_id)} in {str(task.get('zone', '')).replace('_', ' ')}"

    # Rule 1 — the AI gate. In strict mode a hard override, nothing downstream
    # can lift it. In lenient mode it does not fire at all and evaluation falls
    # through to the rules below.
    if ai_flagged and strict:
        status, branch = "UNDER_REVIEW", "ai_gate"
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
        status, branch = "UNDER_REVIEW", "ambiguity_rule"
        confidence = min(vis_conf, 0.49)
        reasoning = (
            f"The {media_evidence_noun} does not establish the claim. {observation} "
            f"The vision analysis returned {vis_conf:.2f} confidence, below the "
            f"{CONFIDENCE_THRESHOLD:.2f} floor required for an automated decision, so JENGA is "
            f"declining to rule rather than guessing. Approving on this evidence would mean signing "
            f"off on {where} on the strength of a {media_noun} in which the specified detail is not "
            f"actually legible — the spec calls for \"{task.get('spec_text', '')}\" and that cannot "
            f"be confirmed from what was submitted. {hist_summary} The package is held for "
            f"re-inspection; a clear {media_noun} is likely to resolve it in minutes."
        )
        request = (
            f"{'Re-record video of' if is_video else 'Re-photograph'} {where} at {coords} under "
            f"adequate lighting, framed so the feature described in the specification is unobstructed "
            f"and in focus, and re-submit for verification."
        )

    elif matches is False:
        status, branch = "DISPUTED", "contradiction"
        confidence = round(vis_conf, 2)
        reasoning = (
            f"The {media_noun} contradicts the submitted claim. {observation} The specification for "
            f"{where} requires \"{task.get('spec_text', '')}\", and the visible condition at {coords} "
            f"does not meet it at {vis_conf:.2f} confidence. {hist_summary} This is raised as a "
            f"dispute rather than a review hold because the evidence is legible — it simply shows "
            f"something other than what was reported."
        )
        request = None

    # Rule 0' — the pace rule, checked before any approval. Prose and photograph
    # both passed, but the site's own earned-schedule stream says this zone has
    # produced no verified work in a week while the whole site paces under the
    # SPI floor — a completion claim here is held for a field record rather
    # than approved on evidence that outruns the measured pace.
    elif pace.get("flagged") and COMPLETION_CLAIM_RE.search(state.get("claim") or ""):
        status, branch = "UNDER_REVIEW", "pace_conflict"
        confidence = min(vis_conf, 0.49)
        reasoning = (
            f"The submitted claim reports {where} as complete, and the site's own "
            f"earned-schedule telemetry cannot support it. {observation} {hist_summary} "
            f"JENGA holds the package rather than approving: the claim may be true, but "
            f"approving it would mean crediting progress the site's measured pace has not "
            f"produced. A dated field record resolves this in minutes."
        )
        request = PACE_REQUEST

    else:
        status, branch = "APPROVED", "approved"
        confidence = round(vis_conf, 2)
        # Lenient mode can reach an approval on a flagged report, so this clause
        # must not claim the score came in under the gate when it did not.
        authorship = (
            f"the report is flagged at {ai_prob:.0%} AI-authorship, over the "
            f"{FLAG_THRESHOLD:.0%} gate but advisory only in this mode"
            if ai_flagged
            else f"the report reads as a first-hand account ({ai_prob:.0%} AI-authorship "
            f"probability, well under the {FLAG_THRESHOLD:.0%} gate)"
        )
        reasoning = (
            f"The {media_evidence_noun} supports the claim. {observation} The submitted {media_noun} is "
            f"legible enough to rule on, returning {vis_conf:.2f} confidence against the "
            f"{CONFIDENCE_THRESHOLD:.2f} floor, and {authorship}. "
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

    # Append the authorship note for the branches that don't already name it in
    # their own prose. After the canned override so demo wording cannot swallow
    # it. Reasoning only — status, confidence and request are left as the
    # surviving rule set them. A lenient approval of a *flagged* report also
    # carries the note: the override must never silently swallow the advisory.
    if branch in ("pace_conflict", "ambiguity_rule", "contradiction") or (
        ai_flagged and not strict and branch == "approved"
    ):
        reasoning = f"{reasoning.rstrip()} {authorship_note}"

    if status == "UNDER_REVIEW":
        confidence = min(confidence, 0.49)
        request = request or (
            f"Re-inspect {where} at {coords} and re-submit evidence."
        )
        if "X:" not in request:
            request = f"{request.rstrip()} Blueprint coordinates X:{task.get('x')} Y:{task.get('y')}."
    else:
        request = None

    # Rule 0''s numbers, applied last for the same reason the advisory above is:
    # neither the demo's canned wording nor the request-clearing that every
    # non-hold gets may swallow the measured pace.
    if branch == "pace_conflict":
        reasoning = f"{reasoning.rstrip()} {_pace_sentence(pace)}"

    return {
        "branch": branch,
        "verdict": {
            "task_id": task_id,
            # Also on the verdict, not just the graph state: `main.verify` and the
            # trace both need to know *which rule decided*, and inferring it from
            # the status alone mislabels holds. `schemas.Verdict` drops the key,
            # so it stays an internal fact rather than part of the API.
            "branch": branch,
            "status": status,
            "confidence": round(max(0.0, min(1.0, confidence)), 2),
            "reasoning": reasoning,
            "actionable_request": request,
            "gptzero": {"ai_probability": round(ai_prob, 3), "flagged": ai_flagged},
            "pace": pace,
            "vision": {
                "observation": observation,
                "matches_claim": matches,
                "confidence": round(vis_conf, 2),
                "media_type": vision.get("media_type", "photo"),
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

    This is the Rox beat made visible: four sources go in — authorship, image,
    history and site telemetry — and each node's read is surfaced in order so the
    agent's multi-source reasoning under uncertainty is legible, including where
    it declines to conclude.
    """
    gz = state.get("gptzero") or {}
    vision = state.get("vision") or {}
    hist = state.get("historical") or {}
    pace = state.get("pace") or {"samples": 0}
    verdict = state.get("verdict") or {}

    ai_prob = float(gz.get("ai_probability", 0.0))
    # Same test as _decide's: a fixture can carry flagged=false above the
    # threshold, and a green card over a hold would be a lie.
    ai_flagged = bool(gz.get("flagged")) or ai_prob > FLAG_THRESHOLD
    strict = bool(state.get("strict", True))
    matches = vision.get("matches_claim")
    vis_conf = float(vision.get("confidence", 0.0))
    insufficient = bool(vision.get("insufficient")) or matches is None
    hist_source = hist.get("source", "local corpus")
    hist_count = len(hist.get("packages") or [])
    status = verdict.get("status", "UNDER_REVIEW")
    pace_detail, pace_signal = _pace_card(pace)

    media_type = vision.get("media_type") or "photo"
    media_label = "Video" if media_type == "video" else "Photo"

    if matches is True:
        vision_detail = f"{media_label} is consistent with the claim ({vis_conf:.0%} confidence)."
        vision_signal = "ok"
    elif matches is False:
        vision_detail = f"{media_label} contradicts the claim ({vis_conf:.0%} confidence)."
        vision_signal = "bad"
    else:
        vision_detail = f"{media_label} cannot establish the claim ({vis_conf:.0%} confidence) — insufficient." if insufficient else f"Inconclusive ({vis_conf:.0%})."
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
            "title": f"2 · {media_label} analysis",
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
            "node": "pace_check",
            "title": "4 · Site pace",
            "detail": pace_detail,
            "signal": pace_signal,
        },
        {
            "node": "arbiter",
            "title": "5 · Arbiter",
            # A pace hold needs its own line: the generic one blames insufficient
            # evidence, and rule 0' fires on the measured pace however legible the
            # photograph was. Keyed on the branch that actually decided — a hold
            # that came from the AI gate on a slow site is not pace's doing, and
            # this card must not say it was.
            "detail": "Claim outruns the site's measured pace — held for a field record."
            if state.get("branch") == "pace_conflict"
            else {
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
_graph.add_node("pace_check", pace_check)
_graph.add_node("arbiter", arbiter)
_graph.add_edge(START, "gptzero_gate")
_graph.add_edge("gptzero_gate", "vision_analysis")
_graph.add_edge("vision_analysis", "historical_memory")
_graph.add_edge("historical_memory", "pace_check")
_graph.add_edge("pace_check", "arbiter")
_graph.add_edge("arbiter", END)
GRAPH = _graph.compile()


async def verify_submission(
    task: dict,
    report_text: str | None,
    image_base64: str | None,
    transcript: str | None,
    strict: bool = True,
    video_finding: dict | None = None,
) -> dict[str, Any]:
    """Run the verification pipeline. Returns a Verdict dict. Never raises.

    `strict=False` demotes the GPTZero gate to an advisory; see `_decide`.
    `video_finding`, when given, is the already-computed result of analyzing
    an uploaded video (see main.py's /video-evidence endpoint) — it takes
    over the vision_analysis node outright rather than being re-derived here.
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
                    "video_finding": video_finding,
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
            # `scored: False` marks the 0.0 as a placeholder, not a reading —
            # GPTZero never ran here. schemas.GPTZero ignores the extra key, so
            # only the raw dict (which is what gets persisted) can see it.
            "gptzero": {"ai_probability": 0.0, "flagged": False, "scored": False},
            "vision": {"observation": "Vision analysis unavailable.", "matches_claim": None, "confidence": 0.0, "media_type": None},
            "pace": {"samples": 0},
            "evidence": {
                "spec": task.get("spec_text", ""),
                "claim": claim or "(no written or spoken claim submitted)",
                "visual": "Vision analysis unavailable.",
                "historical": "Historical retrieval unavailable.",
            },
        }
