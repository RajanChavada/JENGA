"""What denying a contractor's update would cost the schedule.

Pure functions over the CPM graph: no I/O, and nothing here mutates the graph it
is given. The prediction is advisory. It never changes a task's duration in the
live schedule; the owner sees it before deciding, and it is stored on the report
so the reason and the cost of a denial stay together.
"""

import math
from datetime import date, timedelta

import cpm_engine

#: A denied update is reviewed again after the fix, which takes a day on top of the rework.
TURNAROUND_DAYS = 1


def estimate_rework_days(verdict, task):
    """(days, rationale) for redoing the work a denial sends back.

    Read off the AI verdict, because what the verifier found says what kind of
    fix the contractor faces: a contradicted claim is real rework, thin evidence
    is a resubmission. Deliberately a rule table rather than a model, so the
    owner can read why the number is what it is.
    """
    verdict = verdict or {}
    duration = task.get("duration_days") or 1
    branch = verdict.get("branch")
    status = verdict.get("status")
    vision = verdict.get("vision") or {}
    flagged = bool((verdict.get("gptzero") or {}).get("flagged"))

    if branch == "sensor_conflict":
        base = max(2, math.ceil(0.75 * duration))
        why = "Site sensors contradict the report, so the affected work is redone and re-cured."
    elif branch == "contradiction" or status == "DISPUTED" or vision.get("matches_claim") is False:
        base = max(1, math.ceil(0.5 * duration))
        why = "The photo contradicts the claimed progress, so about half the package is redone."
    elif branch == "ai_gate" or flagged:
        base = 2
        why = "The report reads as AI-written, so the contractor must submit a first-hand account."
    elif branch == "ambiguity_rule" or status == "UNDER_REVIEW":
        base = 1
        why = "Evidence was too thin to rule on, so the contractor resubmits with better evidence."
    else:
        base = 1
        why = "The AI found the update sound; the denial is the owner's call, assumed a minor fix."

    return base + TURNAROUND_DAYS, [why, f"+{TURNAROUND_DAYS} day to review the resubmission."]


def _day(start, offset):
    return (start + timedelta(days=offset)).isoformat()


def predict_denial(graph, task_id, verdict, start_date):
    """Impact of denying `task_id`'s update, against the graph as it stands.

    `start_date` (ISO) anchors day offsets to the calendar. Task due dates are
    `due_day` node attributes; the project deadline is the latest of them.
    """
    start = date.fromisoformat(start_date)
    node = graph.nodes[task_id]
    days, rationale = estimate_rework_days(verdict, node)

    before = cpm_engine.compute(graph)
    delayed = cpm_engine.apply_delay(graph, task_id, days)
    was = {t["id"]: t for t in before["tasks"]}
    now = {t["id"]: t for t in delayed["tasks"]}

    affected = []
    for tid in [task_id, *delayed["downstream_affected"]]:
        due = now[tid].get("due_day")
        late_before = max(0, was[tid]["ef"] - due) if due is not None else 0
        late_after = max(0, now[tid]["ef"] - due) if due is not None else 0
        affected.append(
            {
                "id": tid,
                "name": now[tid]["name"],
                "finish_date_before": _day(start, was[tid]["ef"]),
                "finish_date_after": _day(start, now[tid]["ef"]),
                # The same finishes as day offsets, which is the schedule's own axis.
                "finish_day_before": was[tid]["ef"],
                "finish_day_after": now[tid]["ef"],
                "due_day": due,
                "due_date": _day(start, due) if due is not None else None,
                "late_by_days": late_after,
                "newly_late": late_after > late_before,
            }
        )

    dues = [t["due_day"] for t in now.values() if t.get("due_day") is not None]
    deadline = max(dues) if dues else before["project_duration"]
    predicted = delayed["project_duration"]

    return {
        "task_id": task_id,
        "rework_days": days,
        "rationale": rationale,
        "float_consumed": delayed["float_consumed"],
        "absorbed_by_float": delayed["project_slipped_days"] == 0,
        "project_slipped_days": delayed["project_slipped_days"],
        "baseline_finish_day": before["project_duration"],
        "predicted_finish_day": predicted,
        "deadline_day": deadline,
        "baseline_finish_date": _day(start, before["project_duration"]),
        "predicted_finish_date": _day(start, predicted),
        "project_deadline_date": _day(start, deadline),
        "days_past_deadline": max(0, predicted - deadline),
        "critical_path_changed": before["critical_path"] != delayed["critical_path"],
        "affected": affected,
    }


def contractor_view(impact):
    """The part of an impact the contractor sees: what the rework costs, not the
    owner's downstream and critical-path analysis."""
    if not impact:
        return None
    return {
        "rework_days": impact["rework_days"],
        "predicted_finish_date": impact["predicted_finish_date"],
        "project_slipped_days": impact["project_slipped_days"],
    }
