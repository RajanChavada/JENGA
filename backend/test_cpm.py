"""CPM engine checks. Run: python test_cpm.py"""

import json
from pathlib import Path

from cpm_engine import apply_delay, build_graph, compute

SEED = json.loads(
    (Path(__file__).parent.parent / "data" / "seed_tasks.json").read_text()
)


def graph():
    return build_graph(SEED["tasks"], SEED["edges"])


def by_id(tasks):
    return {t["id"]: t for t in tasks}


# --- baseline ---------------------------------------------------------------
# Hand-computed longest path:
#   P-101(5) -> P-102(4) -> P-103(6) -> P-104(8) -> P-111(5)
#            -> P-112(4) -> P-113(6) -> P-116(12)  = 50 days
base = compute(graph())
t = by_id(base["tasks"])

assert base["project_duration"] == 50, base["project_duration"]
assert base["critical_path"] == [
    "P-101",
    "P-102",
    "P-103",
    "P-104",
    "P-111",
    "P-112",
    "P-113",
    "P-116",
], base["critical_path"]

# spot-check the forward/backward pass on the branch point
assert (t["P-102"]["es"], t["P-102"]["ef"]) == (5, 9)
assert (t["P-116"]["es"], t["P-116"]["ef"]) == (38, 50)

# --- the demo hinges on this ------------------------------------------------
assert t["P-106"]["total_float"] == 1, t["P-106"]["total_float"]
assert t["P-106"]["is_critical"] is False

# --- every task carries depth (frontend staggers animation by depth * 120ms) --
for task in base["tasks"]:
    assert isinstance(task["depth"], int), task["id"]
assert t["P-101"]["depth"] == 0
assert t["P-106"]["depth"] > t["P-105"]["depth"]

# --- 4-day delay on P-106 ---------------------------------------------------
# eats its 1 day of float, pushes the platform branch, slips the project by 3
after = apply_delay(graph(), "P-106", 4)
a = by_id(after["tasks"])

assert after["float_consumed"] == 1, after["float_consumed"]
assert after["project_slipped_days"] == 3, after["project_slipped_days"]
assert after["project_duration"] == 53, after["project_duration"]

for downstream in ("P-109", "P-110", "P-113", "P-115", "P-116"):
    assert downstream in after["downstream_affected"], downstream
    assert a[downstream]["es"] > t[downstream]["es"], downstream

# P-112 is a descendant of nothing P-106 touches — it must not shift
assert "P-112" not in after["downstream_affected"]
assert a["P-112"]["es"] == t["P-112"]["es"]

# the critical path flips onto the platform branch
assert a["P-106"]["total_float"] == 0
assert after["critical_path"] == [
    "P-101",
    "P-102",
    "P-105",
    "P-106",
    "P-109",
    "P-110",
    "P-113",
    "P-116",
], after["critical_path"]

# apply_delay must not mutate the graph it was handed
assert compute(graph())["project_duration"] == 50

print(f"baseline duration      {base['project_duration']} days")
print(f"critical path          {' -> '.join(base['critical_path'])}")
print(f"P-106 total float      {t['P-106']['total_float']} day")
print(f"after +4d on P-106     {after['project_duration']} days "
      f"(+{after['project_slipped_days']}, float consumed {after['float_consumed']})")
print(f"downstream shifted     {', '.join(after['downstream_affected'])}")
print(f"new critical path      {' -> '.join(after['critical_path'])}")
print(f"depth assigned to all  {len(base['tasks'])} tasks")
print("\nOK")
