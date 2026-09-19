"""JENGA API. Route handler -> engine -> storage. Nothing in between."""

import json
import uuid
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

import cpm_engine
import db
import seed as seed_module
from schemas import (
    AttributionEntry,
    DisputeRequest,
    DisputeResponse,
    GraphResponse,
    PurchaseOrder,
    StateRequest,
    Task,
    Verdict,
    VerifyRequest,
)

MOCK = json.loads(
    (Path(__file__).parent.parent / "data" / "mock_evidence.json").read_text()
)

# The AI pipeline is another agent's module. Until it lands (or if it throws)
# we serve the canned verdicts from mock_evidence.json so the demo never dies.
try:
    from agent import detect_material_shortage, verify_submission

    AGENT_AVAILABLE = True
except ImportError:
    AGENT_AVAILABLE = False

    async def verify_submission(task, report_text=None, image_base64=None, transcript=None):
        return _canned_verdict(task["id"])

    async def detect_material_shortage(text):
        return None


def _now():
    return datetime.now(timezone.utc).isoformat()


def _submission_for(task_id):
    return next((s for s in MOCK["submissions"] if s["task_id"] == task_id), None)


def _canned_verdict(task_id, report_text="", transcript=None, spec_text=""):
    """Fallback verdict, read from the matching `expected` block in mock_evidence."""
    sub = _submission_for(task_id)
    if sub is None:
        return {
            "task_id": task_id,
            "status": "UNDER_REVIEW",
            "confidence": 0.3,
            "reasoning": "No verification pipeline available and no canned evidence for this task.",
            "actionable_request": "Re-submit with a site photo and a written progress note.",
            "gptzero": {"ai_probability": 0.0, "flagged": False},
            "vision": {"observation": "No image analysed.", "matches_claim": None, "confidence": 0.0},
            "evidence": {
                "spec": spec_text,
                "claim": report_text or (transcript or ""),
                "visual": "No image analysed.",
                "historical": "No prior submissions on record.",
            },
        }

    exp = sub["expected"]
    vision = dict(exp["vision"])
    vision.setdefault("matches_claim", None)
    # mock_evidence predates vision.confidence; mirror the top-level score.
    vision.setdefault("confidence", exp["confidence"])
    return {
        "task_id": task_id,
        "status": exp["status"],
        "confidence": exp["confidence"],
        "reasoning": exp["reasoning"],
        "actionable_request": exp.get("actionable_request"),
        "gptzero": exp["gptzero"],
        "vision": vision,
        "evidence": {
            "spec": spec_text,
            "claim": report_text or sub.get("report_text") or sub.get("transcript") or "",
            "visual": vision["observation"],
            "historical": exp.get("side_effect") or "No prior disputes on this task.",
        },
    }


def _canned_zip_action(task_id):
    sub = _submission_for(task_id)
    return (sub or {}).get("expected", {}).get("zip_action")


async def _graph():
    return cpm_engine.build_graph(await db.tasks(), await db.edges())


@asynccontextmanager
async def lifespan(_app):
    await db.init()
    await seed_module.seed()
    print(f"[jenga] storage={db.STORAGE} agent={'live' if AGENT_AVAILABLE else 'stub'}")
    yield


app = FastAPI(title="JENGA", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/api/graph", response_model=GraphResponse)
async def get_graph():
    result = cpm_engine.compute(await _graph())
    return {**result, "edges": await db.edges()}


@app.post("/api/tasks/{task_id}/verify", response_model=Verdict)
async def verify(task_id: str, body: VerifyRequest):
    tasks = {t["id"]: t for t in cpm_engine.compute(await _graph())["tasks"]}
    task = tasks.get(task_id)
    if task is None:
        raise HTTPException(404, f"unknown task {task_id}")

    try:
        verdict = await verify_submission(
            task=task,
            report_text=body.report_text,
            image_base64=body.image_base64,
            transcript=body.transcript,
        )
        if not verdict:
            raise ValueError("agent returned nothing")
    except Exception as exc:  # degrade, never throw
        print(f"[verify] agent failed for {task_id} ({exc}); using canned verdict")
        verdict = _canned_verdict(
            task_id, body.report_text, body.transcript, task["spec_text"]
        )

    verdict.setdefault("task_id", task_id)
    verdict.setdefault(
        "evidence",
        {
            "spec": task["spec_text"],
            "claim": body.report_text or body.transcript or "",
            "visual": verdict.get("vision", {}).get("observation", ""),
            "historical": "",
        },
    )
    # Non-negotiable: an AI-written report never auto-approves.
    if verdict.get("gptzero", {}).get("ai_probability", 0) > 0.85:
        verdict["status"] = "UNDER_REVIEW"
        verdict["gptzero"]["flagged"] = True
        verdict.setdefault(
            "actionable_request",
            "Report flagged as AI-generated. Re-submit a first-hand account of the work performed.",
        )

    await db.add_evidence(
        {
            "task_id": task_id,
            "report_text": body.report_text,
            "image_base64": body.image_base64,
            "transcript": body.transcript,
            "verdict": verdict,
            "created_at": _now(),
        }
    )
    await db.update_task(
        task_id,
        state={"APPROVED": "verified", "DISPUTED": "disputed"}.get(
            verdict["status"], "under_review"
        ),
    )

    # Material shortage buried in the narrative -> act on the purchase order.
    try:
        action = await detect_material_shortage(
            " ".join(filter(None, [body.report_text, body.transcript]))
        )
    except Exception as exc:
        print(f"[verify] detect_material_shortage failed ({exc})")
        action = None
    if action is None and not AGENT_AVAILABLE:
        action = _canned_zip_action(task_id)
    if action and action.get("po_id"):
        await db.update_po(
            action["po_id"],
            status="rescheduled" if action.get("action") == "expedite" else "escalated",
            delivery_date=action.get("new_delivery_date")
            or (await _po(action["po_id"]))["delivery_date"],
            last_action=action.get("reason"),
        )

    return verdict


async def _po(po_id):
    return next((p for p in await db.purchase_orders() if p["id"] == po_id), {})


@app.post("/api/tasks/{task_id}/dispute", response_model=DisputeResponse)
async def dispute(task_id: str, body: DisputeRequest):
    graph = await _graph()
    if task_id not in graph:
        raise HTTPException(404, f"unknown task {task_id}")

    result = cpm_engine.apply_delay(graph, task_id, body.delay_days)

    await db.update_task(
        task_id,
        duration_days=result["graph"].nodes[task_id]["duration_days"],
        state="disputed",
    )

    entry = {
        "id": f"ATTR-{uuid.uuid4().hex[:8]}",
        "task_id": task_id,
        "slip_days": body.delay_days,
        "float_consumed": result["float_consumed"],
        "downstream_affected": result["downstream_affected"],
        "project_slipped_days": result["project_slipped_days"],
        "attribution": _attribution_for(task_id, body),
        "created_at": _now(),
    }
    await db.add_attribution(entry)

    return {
        "tasks": result["tasks"],
        "critical_path": result["critical_path"],
        "attribution": entry,
        "project_slipped_days": result["project_slipped_days"],
    }


def _attribution_for(task_id, body):
    """Scripted split for the demo task; otherwise it's all on the subcontractor."""
    cascade = MOCK.get("cascade_demo", {})
    if cascade.get("task_id") == task_id:
        return cascade["expected_attribution"]["attribution"]
    return [
        {
            "party": "Subcontractor",
            "days": body.delay_days,
            "reason": body.reason,
        }
    ]


@app.post("/api/tasks/{task_id}/state", response_model=Task)
async def set_state(task_id: str, body: StateRequest):
    if await db.update_task(task_id, state=body.state) is None:
        raise HTTPException(404, f"unknown task {task_id}")
    tasks = cpm_engine.compute(await _graph())["tasks"]
    return next(t for t in tasks if t["id"] == task_id)


@app.get("/api/attributions", response_model=list[AttributionEntry])
async def get_attributions():
    return await db.attributions()


@app.get("/api/purchase-orders", response_model=list[PurchaseOrder])
async def get_purchase_orders():
    return await db.purchase_orders()


@app.post("/api/reset")
async def reset():
    await seed_module.seed()
    return {"ok": True}
