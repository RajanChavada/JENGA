"""Plain-assert checks for the JENGA verification pipeline.

    cd backend && JENGA_OFFLINE=1 python test_agent.py

No pytest. Every submission in data/mock_evidence.json is run through the real
graph and its verdict status is checked against the `expected` block.
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import agent  # noqa: E402
from agent import _decide, detect_material_shortage, verify_submission  # noqa: E402
from integrations import DATA_DIR, OFFLINE  # noqa: E402
from integrations.gptzero import FLAG_THRESHOLD  # noqa: E402
from integrations.zip_api import PURCHASE_ORDERS, update_purchase_order  # noqa: E402

EVIDENCE = json.loads((DATA_DIR / "mock_evidence.json").read_text())
TASKS = {t["id"]: t for t in json.loads((DATA_DIR / "seed_tasks.json").read_text())["tasks"]}

# A 1x1 pixel; stands in for a real photo so the image-present path is exercised.
STUB_IMAGE = (
    "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a"
    "HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA"
    "AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q=="
)


async def main() -> None:
    failures: list[str] = []
    print(f"JENGA agent checks (offline={OFFLINE})\n" + "=" * 62)

    for sub in EVIDENCE["submissions"]:
        task = TASKS[sub["task_id"]]
        expected = sub["expected"]

        verdict = await verify_submission(
            task=task,
            report_text=sub.get("report_text"),
            image_base64=STUB_IMAGE if sub.get("image") else None,
            transcript=sub.get("transcript"),
        )

        ok = verdict["status"] == expected["status"]
        print(
            f"{'PASS' if ok else 'FAIL'}  {sub['id']}  {sub['task_id']:<6} "
            f"expected={expected['status']:<13} got={verdict['status']:<13} "
            f"conf={verdict['confidence']}"
        )
        if not ok:
            failures.append(f"{sub['id']}: expected {expected['status']}, got {verdict['status']}")

        # Verdict shape.
        for key in ("task_id", "status", "confidence", "reasoning",
                    "actionable_request", "gptzero", "vision", "evidence"):
            assert key in verdict, f"{sub['id']}: verdict missing {key!r}"
        assert verdict["task_id"] == sub["task_id"], f"{sub['id']}: task_id mismatch"
        assert verdict["status"] in {"APPROVED", "DISPUTED", "UNDER_REVIEW"}, sub["id"]
        assert 0.0 <= verdict["confidence"] <= 1.0, f"{sub['id']}: confidence out of range"
        assert len(verdict["reasoning"]) > 80, f"{sub['id']}: reasoning is not real prose"
        assert set(verdict["evidence"]) == {"spec", "claim", "visual", "historical"}, sub["id"]
        assert all(verdict["evidence"].values()), f"{sub['id']}: an evidence column is empty"
        assert isinstance(verdict["gptzero"]["ai_probability"], float), sub["id"]
        assert "confidence" in verdict["vision"], f"{sub['id']}: vision has no confidence score"

        # The ambiguity rule.
        if verdict["status"] == "UNDER_REVIEW":
            assert verdict["confidence"] < 0.5, f"{sub['id']}: review hold at confidence >= 0.5"
            req = verdict["actionable_request"]
            assert req, f"{sub['id']}: review hold with no actionable request"
            assert f"X:{task['x']}" in req and f"Y:{task['y']}" in req, \
                f"{sub['id']}: actionable request omits blueprint coordinates"
        else:
            assert verdict["actionable_request"] is None, f"{sub['id']}: non-hold carries a request"

        # An AI-authored report must never auto-approve.
        if verdict["gptzero"]["ai_probability"] > FLAG_THRESHOLD:
            assert verdict["status"] == "UNDER_REVIEW", f"{sub['id']}: AI report escaped the gate"

        if expected.get("confidence") is not None:
            assert abs(verdict["confidence"] - expected["confidence"]) < 0.01, \
                f"{sub['id']}: confidence {verdict['confidence']} != {expected['confidence']}"

    print("-" * 62)

    # Material shortage detection.
    sub1 = next(s for s in EVIDENCE["submissions"] if s["id"] == "SUB-01")
    shortage = await detect_material_shortage(sub1.get("transcript") or sub1.get("report_text") or "")
    assert shortage and shortage["po_id"] == "PO-8852", f"SUB-01 shortage: {shortage}"
    assert shortage["action"] == "expedite" and shortage["new_delivery_date"], shortage
    print(f"PASS  shortage SUB-01 -> {shortage['po_id']} {shortage['action']}")

    sub5 = next(s for s in EVIDENCE["submissions"] if s["id"] == "SUB-05")
    shortage5 = await detect_material_shortage(sub5["transcript"])
    assert shortage5 and shortage5["po_id"] == "PO-8840", f"SUB-05 shortage: {shortage5}"
    print(f"PASS  shortage SUB-05 -> {shortage5['po_id']} {shortage5['action']}")

    assert await detect_material_shortage("Poured the slab today, everything went fine.") is None
    assert await detect_material_shortage("") is None
    print("PASS  shortage no false positive on a clean report")

    # Mock PO update mutates in memory.
    updated = update_purchase_order(shortage5["po_id"], shortage5["new_delivery_date"], shortage5["reason"])
    assert updated and updated["status"] == "rescheduled", updated
    assert updated["delivery_date"] == shortage5["new_delivery_date"], updated
    assert next(p for p in PURCHASE_ORDERS if p["id"] == shortage5["po_id"])["status"] == "rescheduled"
    assert update_purchase_order("PO-0000", "2026-01-01", "nope") is None
    print(f"PASS  PO update {updated['id']} -> {updated['status']} {updated['delivery_date']}")

    # A task with no canned evidence must still produce a safe, well-formed hold.
    unknown = await verify_submission(
        task={"id": "P-999", "name": "Unmapped package", "zone": "mezzanine",
              "x": 11, "y": 22, "spec_text": "Some specification."},
        report_text="Finished it.", image_base64=None, transcript=None,
    )
    assert unknown["status"] == "UNDER_REVIEW", unknown["status"]
    assert unknown["confidence"] < 0.5 and "X:11" in unknown["actionable_request"]
    print("PASS  unknown task degrades to a safe review hold")

    # --- Strict mode: how much authority the authorship score carries --------
    sub2 = next(s for s in EVIDENCE["submissions"] if s["id"] == "SUB-02")
    task2 = TASKS[sub2["task_id"]]
    advisory = f"GPTZero advisory: {sub2['expected']['gptzero']['ai_probability']:.0%} AI"

    async def run_sub2(strict: bool) -> dict:
        return await verify_submission(
            task=task2,
            report_text=sub2.get("report_text"),
            image_base64=STUB_IMAGE if sub2.get("image") else None,
            transcript=sub2.get("transcript"),
            strict=strict,
        )

    strict_verdict = await run_sub2(True)
    assert strict_verdict["status"] == "UNDER_REVIEW", strict_verdict["status"]
    assert advisory not in strict_verdict["reasoning"], "strict mode must not add the advisory"
    print(f"PASS  SUB-02 strict  -> {strict_verdict['status']} (AI gate fired)")

    # SUB-02 lenient stays UNDER_REVIEW, and that is correct: with the gate
    # demoted, the *ambiguity* rule catches it, because P-106's photo reads at
    # 0.22 confidence — below the 0.5 floor — so this submission cannot approve
    # on any setting. What this case proves is that the AI gate did not fire:
    # the advisory is appended and the authorship card is no longer a blocker.
    # Do not "fix" it to APPROVED. No fixture pairs a flagged report with a
    # legible photo, so lenient approval is covered by the case below instead.
    lenient_verdict = await run_sub2(False)
    assert lenient_verdict["status"] == "UNDER_REVIEW", lenient_verdict["status"]
    assert advisory in lenient_verdict["reasoning"], lenient_verdict["reasoning"]
    gate_card = next(c for c in lenient_verdict["trace"] if c["node"] == "gptzero_gate")
    assert gate_card["signal"] == "warn" and "advisory only" in gate_card["detail"], gate_card
    print(f"PASS  SUB-02 lenient -> {lenient_verdict['status']} via the ambiguity rule, '{advisory}'")

    # Lenient approval: a flagged report with a legible photo. Assembled by hand
    # since no fixture combines the two. P-104 also carries canned wording, so
    # this doubles as proof the override cannot swallow the advisory.
    flagged_but_legible = {
        "task": TASKS["P-104"],
        "gptzero": {"ai_probability": 0.93, "flagged": True},
        "vision": {
            "observation": "Conduit runs are visible and follow the routing in the spec.",
            "matches_claim": True,
            "confidence": 0.9,
            "insufficient": False,
        },
        "historical": {"summary": "Two comparable packages closed on schedule."},
    }

    lenient = await _decide({**flagged_but_legible, "strict": False})
    approved = lenient["verdict"]
    assert approved["status"] == "APPROVED", approved["status"]
    assert "GPTZero advisory: 93% AI" in approved["reasoning"], approved["reasoning"]
    assert approved["actionable_request"] is None, approved["actionable_request"]
    print("PASS  flagged report + legible photo, lenient -> APPROVED carrying the advisory")

    # The same input under strict, to pin that each rule names itself. A rule
    # added ahead of the AI gate reports its own name rather than inheriting
    # one inferred from the verdict.
    held = await _decide({**flagged_but_legible, "strict": True})
    assert held["verdict"]["status"] == "UNDER_REVIEW", held["verdict"]["status"]
    assert (held["branch"], lenient["branch"]) == ("ai_gate", "approved"), (
        held["branch"], lenient["branch"],
    )
    print(f"PASS  arbiter branch names itself: strict={held['branch']} lenient={lenient['branch']}")

    # --- The route-level gate ------------------------------------------------
    # main.verify re-applies the AI gate after the agent returns, as a backstop
    # for the canned-verdict path, which never runs the arbiter. It has to
    # honour `strict` as well: left unconditional it forces UNDER_REVIEW back
    # onto every lenient approval and makes the toggle cosmetic. Driven
    # in-process against a stub agent — no server and no network involved.
    os.environ["JENGA_STORAGE"] = "memory"  # a test must never reach the shared database
    import main
    import seed as seed_module
    from schemas import VerifyRequest

    async def stub_agent(task, report_text=None, image_base64=None, transcript=None, strict=True):
        """What the route-level gate exists for: an approval carrying a flagged score."""
        return {
            "task_id": task["id"],
            "status": "APPROVED",
            "confidence": 0.9,
            "reasoning": (
                "Stub verdict standing in for the arbiter so the route-level gate can be "
                "exercised on its own, with the authorship score above the threshold."
            ),
            "actionable_request": None,
            "gptzero": {"ai_probability": 0.93, "flagged": True},
            "vision": {"observation": "Stub observation.", "matches_claim": True, "confidence": 0.9},
        }

    main.verify_submission = stub_agent
    await main.db.init()
    await seed_module.seed()
    body = VerifyRequest(report_text="Poured the slab today, everything went fine.")

    gated = await main.verify("P-104", body, strict=True)
    assert gated["status"] == "UNDER_REVIEW", gated["status"]
    # A hold is a hold whichever gate produced it: the route-level one owes the
    # same invariants as the arbiter's rule 1.
    assert gated["confidence"] <= 0.49, gated["confidence"]
    assert "X:" in gated["actionable_request"], gated["actionable_request"]
    ungated = await main.verify("P-104", body, strict=False)
    assert ungated["status"] == "APPROVED", ungated["status"]
    print("PASS  route gate holds a flagged approval under strict, leaves it under lenient")

    # Both backends must agree on what a report row carries. Memory mode keeps
    # the dict whole, so this also guards the three fields main.py computes.
    persisted = main.db._mem["evidence"][-2:]
    assert [r["owner_decision"] for r in persisted] == ["pending", "approved"], persisted
    assert all(r["gptzero_flag"] == "flagged" for r in persisted), persisted
    assert all(r["gptzero_score"] == 0.93 for r in persisted), persisted
    print("PASS  persisted gptzero_score/flag identical across modes, owner_decision follows")

    # The pipeline-error fallback has no reading at all, so its placeholder 0.0
    # must persist as NULL rather than as a confident "human-written" score.
    # Breaking the graph is the only way to reach that fallback honestly.
    class BrokenGraph:
        async def ainvoke(self, _state):
            raise RuntimeError("graph unavailable")

    real_graph, agent.GRAPH = agent.GRAPH, BrokenGraph()
    try:
        broken = await verify_submission(
            task=TASKS["P-104"],
            report_text="Poured the slab today.",
            image_base64=None,
            transcript=None,
        )
    finally:
        agent.GRAPH = real_graph
    assert broken["status"] == "UNDER_REVIEW", broken["status"]
    assert broken["gptzero"]["scored"] is False, broken["gptzero"]

    async def stub_broken(task, report_text=None, image_base64=None, transcript=None, strict=True):
        return dict(broken)

    main.verify_submission = stub_broken
    await main.verify("P-104", body, strict=True)
    unscored = main.db._mem["evidence"][-1]
    assert unscored["gptzero_score"] is None, unscored["gptzero_score"]
    assert unscored["gptzero_flag"] == "clear", unscored["gptzero_flag"]
    print("PASS  pipeline-error fallback persists a NULL score, not a confident 0.0")

    print("=" * 62)
    if failures:
        print(f"{len(failures)} FAILURE(S):")
        for f in failures:
            print("  -", f)
        sys.exit(1)
    print(f"All checks passed ({len(EVIDENCE['submissions'])} submissions).")


if __name__ == "__main__":
    asyncio.run(main())
