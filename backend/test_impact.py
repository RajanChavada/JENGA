"""Denial impact: rework rules, deadlines, dependencies, purity. Run from backend/."""

import json
from pathlib import Path

import cpm_engine
import impact

SEED = json.loads((Path(__file__).parent.parent / "data" / "seed_tasks.json").read_text())
START = "2026-08-03"


def graph():
    return cpm_engine.build_graph(SEED["tasks"], SEED["edges"])


def denial(task_id, verdict):
    return impact.predict_denial(graph(), task_id, verdict, START)


# --- rework rules: each finding maps to its own cost -------------------------
t = {"duration_days": 8}
rules = {
    "sensor": ({"status": "DISPUTED", "branch": "sensor_conflict"}, 6 + 1),  # ceil(.75*8)
    "contradiction": ({"status": "DISPUTED", "branch": "contradiction"}, 4 + 1),
    "vision-only": ({"status": "DISPUTED", "vision": {"matches_claim": False}}, 4 + 1),
    "ai_gate": ({"status": "UNDER_REVIEW", "branch": "ai_gate"}, 2 + 1),
    "flagged": ({"status": "UNDER_REVIEW", "gptzero": {"flagged": True}}, 2 + 1),
    "ambiguity": ({"status": "UNDER_REVIEW", "branch": "ambiguity_rule"}, 1 + 1),
    "approved-but-denied": ({"status": "APPROVED"}, 1 + 1),
    "no verdict": (None, 1 + 1),
}
for name, (verdict, want) in rules.items():
    days, why = impact.estimate_rework_days(verdict, t)
    assert days == want, (name, days, want)
    assert len(why) == 2 and why[0], name
# the sensor conflict outranks a flagged report, as in the arbiter
assert impact.estimate_rework_days(
    {"branch": "sensor_conflict", "gptzero": {"flagged": True}}, t
)[0] == 7
print("PASS  rework days follow the verdict's finding, with a reason")

# --- a critical task: the slip reaches the project and breaches the deadline --
before = cpm_engine.compute(graph())
g = graph()
crit = impact.predict_denial(g, "P-104", {"status": "UNDER_REVIEW", "branch": "ambiguity_rule"}, START)
assert crit["rework_days"] == 2 and crit["project_slipped_days"] == 2, crit
assert crit["days_past_deadline"] == 2 and not crit["absorbed_by_float"], crit
assert crit["predicted_finish_date"] > crit["project_deadline_date"], crit
assert crit["baseline_finish_date"] == crit["project_deadline_date"]  # zero-buffer contract
assert crit["affected"][0]["id"] == "P-104"
ids = [a["id"] for a in crit["affected"]]
assert {"P-111", "P-112", "P-113", "P-116"} <= set(ids), ids  # its dependants move
assert next(a for a in crit["affected"] if a["id"] == "P-116")["newly_late"], crit["affected"]
print("PASS  critical-task denial slips the project and breaches the deadline")

# --- a task with float: absorbed, nothing late ---------------------------------
slack = denial("P-114", {"status": "UNDER_REVIEW", "branch": "ambiguity_rule"})
assert slack["absorbed_by_float"] and slack["project_slipped_days"] == 0, slack
assert slack["float_consumed"] == 2 and slack["days_past_deadline"] == 0, slack
assert slack["predicted_finish_date"] == slack["baseline_finish_date"]
print("PASS  a denial inside the float slips nothing and consumes float")

# --- dependencies: only descendants can be affected ----------------------------
south = denial("P-106", {"status": "DISPUTED", "branch": "contradiction"})
affected = {a["id"] for a in south["affected"]}
assert affected <= {"P-106", "P-109", "P-110", "P-113", "P-115", "P-116"}, affected
assert "P-104" not in affected and "P-107" not in affected
print("PASS  affected tasks are the denied task and its dependants only")

# --- purity: predicting must not touch the live schedule -----------------------
after = cpm_engine.compute(g)
assert [(x["id"], x["duration_days"], x["ef"]) for x in after["tasks"]] == [
    (x["id"], x["duration_days"], x["ef"]) for x in before["tasks"]
]
print("PASS  prediction does not mutate the graph")

# --- what the contractor may see -----------------------------------------------
view = impact.contractor_view(crit)
assert set(view) == {"rework_days", "predicted_finish_date", "project_slipped_days"}, view
assert impact.contractor_view(None) is None
print("PASS  contractor view carries days and finish date only")
print("All impact checks passed")
