"""Plain-assert checks for the JENGA verification pipeline.

    cd backend && JENGA_OFFLINE=1 python test_agent.py

No pytest. Every submission in data/mock_evidence.json is run through the real
graph and its verdict status is checked against the `expected` block.
"""

from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from agent import detect_material_shortage, verify_submission  # noqa: E402
from integrations import DATA_DIR, OFFLINE  # noqa: E402
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
        if verdict["gptzero"]["ai_probability"] > 0.85:
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

    print("=" * 62)
    if failures:
        print(f"{len(failures)} FAILURE(S):")
        for f in failures:
            print("  -", f)
        sys.exit(1)
    print(f"All checks passed ({len(EVIDENCE['submissions'])} submissions).")


if __name__ == "__main__":
    asyncio.run(main())
