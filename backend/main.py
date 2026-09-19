"""JENGA API. Route handler -> engine -> storage. Nothing in between."""

import json
import uuid
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware

import analytics
import browserbase_hotzones
import cpm_engine
import db
import documents
import procurement_agent
import seed as seed_module
from integrations import tiger, zip_api
from integrations.gptzero import FLAG_THRESHOLD
from schemas import (
    AgentProcurementRequest,
    AgentProcurementResponse,
    AttributionEntry,
    DisputeRequest,
    DisputeResponse,
    ExtractedTasks,
    GraphResponse,
    HotzoneResponse,
    ParsedDocument,
    POActionRequest,
    PurchaseOrder,
    ScheduleAnalytics,
    SpendAnalytics,
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

    async def verify_submission(task, report_text=None, image_base64=None, transcript=None, strict=True):
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


async def _graph(project_id=db.DEFAULT_PROJECT_ID):
    return cpm_engine.build_graph(
        await db.tasks(project_id), await db.edges(project_id)
    )


@asynccontextmanager
async def lifespan(_app):
    await db.init()
    await seed_module.seed()
    # After seeding: the seeded event history reads task states, so it needs them.
    await analytics.seed_history()
    print(
        f"[jenga] storage={db.STORAGE} agent={'live' if AGENT_AVAILABLE else 'stub'} "
        f"telemetry={tiger.source()}"
    )
    try:
        yield
    finally:
        await tiger.close()


app = FastAPI(title="JENGA", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/api/graph", response_model=GraphResponse)
async def get_graph(project_id: str = db.DEFAULT_PROJECT_ID):
    """One site's graph. A project with no tickets is a well-formed empty graph,
    not a 404 — the map can drill into a site JENGA has not onboarded yet, and
    the frontend renders that as the blueprint-upload pitch."""
    result = cpm_engine.compute(await _graph(project_id))
    return {**result, "edges": await db.edges(project_id)}


@app.get("/api/hotzones", response_model=HotzoneResponse)
async def get_hotzones():
    return await browserbase_hotzones.hotzones()


@app.post("/api/hotzones/scrape", response_model=HotzoneResponse)
async def scrape_hotzones():
    """Operator-triggered Browserbase scrape — the only path that ever scrapes.

    Page loads read the last result (or the seed); this endpoint exists so the
    scrape is an explicit button press with visible progress, not a side effect.
    Without a Browserbase key it returns the seed with a note saying so.
    """
    return await browserbase_hotzones.hotzones(force_live=True)


@app.get("/api/analytics/schedule", response_model=ScheduleAnalytics)
async def get_schedule_analytics():
    """The earned-schedule S-curve: planned vs verified work, SPI, projected finish.

    Bucketed by `time_bucket` on the Tiger Data hypertable in live mode, and by
    its bucket-for-bucket mock otherwise.
    """
    return await analytics.schedule_analysis()


@app.get("/api/analytics/spend", response_model=SpendAnalytics)
async def get_spend_analytics():
    """Committed spend vs the site budget, plus the governance escalation state."""
    await analytics.check_escalation()
    return await analytics.spend_analysis()


@app.post("/api/documents/parse", response_model=ParsedDocument)
async def parse_document(file: UploadFile = File(...)):
    data = await file.read()
    if not data:
        raise HTTPException(400, "empty upload")
    return documents.parse_document(file.filename or "upload", data)


@app.post("/api/documents/extract-tasks", response_model=ExtractedTasks)
async def extract_tasks(file: UploadFile = File(...)):
    data = await file.read()
    if not data:
        raise HTTPException(400, "empty upload")
    parsed = documents.parse_document(file.filename or "upload", data)
    return await documents.propose_tasks(parsed["filename"], parsed["text"])


@app.post("/api/tasks/{task_id}/verify", response_model=Verdict)
async def verify(task_id: str, body: VerifyRequest, strict: bool = True):
    """`?strict=false` demotes the GPTZero gate to an advisory; default is on."""
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
            strict=strict,
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
    # Non-negotiable in strict mode: an AI-written report never auto-approves.
    # Same test as agent.py's rule 1, and a backstop for the canned-verdict path
    # above, which never ran the arbiter. Lenient mode leaves the status alone —
    # the advisory is already in the reasoning.
    gz = verdict.get("gptzero") or {}
    score = gz.get("ai_probability")
    # `scored: False` is the pipeline-error fallback saying its 0.0 is a
    # placeholder. A canned offline score is a real reading and is kept.
    scored = gz.get("scored", True) and isinstance(score, (int, float))
    flagged = bool(gz.get("flagged")) or (
        isinstance(score, (int, float)) and score > FLAG_THRESHOLD
    )
    if strict and flagged:
        verdict["status"] = "UNDER_REVIEW"
        gz["flagged"] = True
        # A hold this gate creates owes the same two invariants the arbiter's
        # rule 1 keeps: never decision-grade confidence, and always somewhere
        # to go. setdefault would not have done it — the key is usually
        # present and None.
        verdict["confidence"] = min(verdict.get("confidence") or 0.0, 0.49)
        request = verdict.get("actionable_request") or (
            "Report flagged as AI-generated. Re-submit a first-hand account of the work performed."
        )
        if "X:" not in request:
            request = f"{request.rstrip()} Blueprint coordinates X:{task['x']} Y:{task['y']}."
        verdict["actionable_request"] = request

    await db.add_evidence(
        {
            "task_id": task_id,
            "report_text": body.report_text,
            "image_base64": body.image_base64,
            "transcript": body.transcript,
            "verdict": verdict,
            # What GPTZero said, recorded identically in both modes; only the
            # decision below follows the verdict. No reading at all is NULL, not
            # 0.0 — a missing score and a confident-human one differ.
            "gptzero_score": score if scored else None,
            "gptzero_flag": "flagged" if flagged else "clear",
            "owner_decision": {"APPROVED": "approved", "DISPUTED": "disputed"}.get(
                verdict["status"], "pending"
            ),
            "created_at": _now(),
        }
    )
    await db.update_task(
        task_id,
        state={"APPROVED": "verified", "DISPUTED": "disputed"}.get(
            verdict["status"], "under_review"
        ),
    )

    # Land the verdict in the earned-schedule stream: an approval earns the
    # task's days; anything else earns nothing but is still on the record for
    # trend analysis. This is the write that keeps the S-curve alive.
    event = {"APPROVED": "work_verified", "DISPUTED": "work_disputed"}.get(
        verdict["status"], "work_review"
    )
    await tiger.record_event(
        task_id,
        event,
        float(task["duration_days"]) if event == "work_verified" else 0.0,
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
        new_date = action.get("new_delivery_date") or (await _po(action["po_id"]))["delivery_date"]
        reason = action.get("reason") or "Material shortage detected in field report."

        # Live Zip integration: raise a real intake request when ZIP_API_KEY is
        # set; otherwise (or on failure) fall back to the local mirror. Either
        # way the UI reflects the expedite.
        try:
            zip_result = await zip_api.expedite_purchase_order(action["po_id"], new_date, reason)
        except Exception as exc:  # never let procurement break verify
            print(f"[verify] zip expedite failed ({exc})")
            zip_result = {"ok": True, "live": False, "detail": "Zip expedite errored — local mirror updated."}

        note = f"{reason} · via Zip API" if zip_result.get("live") else reason
        await db.update_po(
            action["po_id"],
            status="rescheduled" if action.get("action") == "expedite" else "escalated",
            delivery_date=new_date,
            last_action=note,
        )
        # The lifecycle marker for the timeline diamonds. Value 0: an expedite
        # re-promises the same money, so it must not double into committed spend.
        await tiger.record_event(action["po_id"], "po_expedited", 0.0)

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


@app.post("/api/purchase-orders/{po_id}/action", response_model=PurchaseOrder)
async def act_on_purchase_order(po_id: str, body: POActionRequest):
    """A planner acts on a PO from the ledger: expedite, receive, or link to a task.

    `expedite` raises a live Zip request when a key is set (and falls back to the
    local mirror otherwise); `receive` marks it delivered; `link` ties it to a
    ticket so a later slip can be attributed to the material. Every path writes
    through `db.update_po`, so the ledger reflects the action whether or not Zip
    is live.
    """
    po = await _po(po_id)
    if not po:
        raise HTTPException(404, f"unknown purchase order {po_id}")

    if body.action == "expedite":
        # One day earlier than the current promise — the same beat verify runs
        # on a detected shortage, but here triggered explicitly by a planner.
        try:
            base = datetime.fromisoformat(str(po["delivery_date"])).date()
        except (TypeError, ValueError):
            base = datetime.now(timezone.utc).date()
        new_date = (base - timedelta(days=1)).isoformat()
        reason = "Expedited by planner from the procurement ledger."
        zip_result = await zip_api.expedite_purchase_order(po_id, new_date, reason)
        note = f"{reason} · via Zip API" if zip_result.get("live") else reason
        updated = await db.update_po(
            po_id, status="rescheduled", delivery_date=new_date, last_action=note
        )
        await tiger.record_event(po_id, "po_expedited", 0.0)
    elif body.action == "receive":
        updated = await db.update_po(
            po_id, status="received", last_action="Marked received on site."
        )
        await tiger.record_event(po_id, "po_delivered", 0.0)
    else:  # link
        if not body.task_id:
            raise HTTPException(422, "link requires a task_id")
        if body.task_id not in await _graph():
            raise HTTPException(404, f"unknown task {body.task_id}")
        updated = await db.update_po(
            po_id,
            linked_task=body.task_id,
            last_action=f"Linked to {body.task_id}.",
        )

    if updated is None:
        raise HTTPException(404, f"unknown purchase order {po_id}")
    return updated


@app.post("/api/procurement/agent-create", response_model=AgentProcurementResponse)
async def agent_create_procurement(body: AgentProcurementRequest):
    """The procurement agent, triggered by a user on extracted work packages.

    Plans a bill of materials, picks a vendor, and creates a real purchase
    order on Zip staging (the same operations ziphq-mcp's write tools expose);
    without a key — or if staging refuses — the one fallback records the PO on
    the local ledger instead. Either way the created PO is mirrored into the
    ledger so the Procurement tab shows it immediately, and the full step
    trace is returned so the UI can show the agent's reasoning.
    """
    if not body.packages:
        raise HTTPException(422, "at least one work package is required")
    result = await procurement_agent.run(
        [p.model_dump() for p in body.packages], body.filename
    )
    if result.get("purchase_order"):
        await db.add_purchase_order(result["purchase_order"])

    # Land the commitment in the spend stream, then run the governance check:
    # this creation may be the individually-compliant PO that tips cumulative
    # spend over the policy line while verified work lags. If it does, the
    # escalation joins the agent's own trace — the agent reports itself.
    await tiger.record_event(
        result.get("po_number") or "PO", "po_created", float(result.get("amount") or 0.0)
    )
    try:
        escalation = await analytics.check_escalation()
    except Exception as exc:  # governance must never break procurement
        print(f"[procurement] escalation check failed ({exc})")
        escalation = None
    if escalation:
        result["escalation"] = escalation
        result.setdefault("steps", []).append(
            {
                "node": "governance",
                "title": "Governance check",
                "detail": escalation["message"],
                "signal": "bad",
            }
        )
    return result


@app.get("/api/zip/status")
async def zip_status():
    """Whether the live Zip Procurement API is configured. Values are never returned."""
    return {"live": zip_api.zip_live(), "base_url": zip_api.ZIP_BASE}


@app.post("/api/reset")
async def reset(project_id: str = db.DEFAULT_PROJECT_ID):
    """Re-seed a project. Only the default one, until seeds carry their own ids.

    The parameter exists because the graph route takes one, but there is exactly
    one seed payload and its ticket ids are fixed (`P-101`…`P-116`). Replaying it
    under a second project fails two different ways, and the quiet one is worse:
    on Postgres the insert collides with the global `tickets.id` primary key and
    500s, while in memory mode — the default — `db.reset` clears the whole store
    unscoped, so the call returns 200 having silently wiped the site the demo
    runs on. Refuse instead, and say what would actually unblock it.
    """
    if project_id != db.DEFAULT_PROJECT_ID:
        raise HTTPException(
            501,
            f"Only {db.DEFAULT_PROJECT_ID} can be re-seeded. Seeding {project_id} "
            "needs per-project ticket ids (T4 — project creation); until then "
            "this would wipe the default project in memory mode and violate the "
            "tickets primary key on postgres.",
        )
    await seed_module.seed(project_id)
    # The event stream is a claim about the seeded state, so it resets with it.
    await analytics.reset()
    return {"ok": True, "project_id": project_id}
