"""JENGA API. Route handler -> engine -> storage. Nothing in between."""

import json
import uuid
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse

import browserbase_hotzones
import cpm_engine
import db
import documents
import impact as impact_module
import media_store
import procurement_agent
import seed as seed_module
import sensors
from integrations import tiger, zip_api
from integrations.vision import analyse_video
from integrations.gptzero import FLAG_THRESHOLD
from schemas import (
    AgentProcurementRequest,
    AgentProcurementResponse,
    AttributionEntry,
    DecisionRequest,
    DecisionResponse,
    DisputeRequest,
    DisputeResponse,
    ExtractedTasks,
    GraphResponse,
    HotzoneResponse,
    ParsedDocument,
    POActionRequest,
    PortalOverview,
    PurchaseOrder,
    QueueItem,
    Report,
    ScenarioRequest,
    SensorPayload,
    SensorScenario,
    StateRequest,
    Task,
    Verdict,
    VerifyRequest,
    VideoEvidenceResponse,
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


def _project_of(task_id):
    """Non-default projects prefix their ticket ids `<project>:`."""
    return task_id.split(":", 1)[0] if ":" in task_id else db.DEFAULT_PROJECT_ID


def _with_blocking(tasks):
    """Derive `blocked`: a not-yet-started task whose predecessors are not all
    verified. Computed on read, never stored, so it cannot drift from the graph."""
    state = {t["id"]: t["state"] for t in tasks}
    out = []
    for t in tasks:
        open_deps = [d for d in t["depends_on"] if state.get(d) != "verified"]
        out.append(
            {**t, "state": "blocked", "blocked_by": open_deps}
            if t["state"] == "pending" and open_deps
            else t
        )
    return out


async def _tasks_view(project_id):
    return _with_blocking(cpm_engine.compute(await _graph(project_id))["tasks"])


def _require_project(project_id):
    project = seed_module.portal_project(project_id)
    if project is None:
        raise HTTPException(404, f"unknown project {project_id}")
    return project


@asynccontextmanager
async def lifespan(_app):
    await db.init()
    await seed_module.seed_all()
    # After seeding: the simulator emits per active ticket, so it needs tickets.
    sensor_task = sensors.start()
    print(
        f"[jenga] storage={db.STORAGE} agent={'live' if AGENT_AVAILABLE else 'stub'} "
        f"sensors={'on' if sensor_task else 'off'} telemetry={tiger.source()}"
    )
    try:
        yield
    finally:
        # Simulator first: the pool must outlive the last insert in flight.
        await sensors.stop(sensor_task)
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
    return {
        **result,
        "tasks": _with_blocking(result["tasks"]),
        "edges": await db.edges(project_id),
    }


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


@app.get("/api/sensors/{ticket_id}", response_model=SensorPayload)
async def get_sensors(ticket_id: str):
    """Curing telemetry: live `time_bucket` off the hypertable, plus the continuous
    aggregate. `history` is empty in mock mode — there is no aggregate to read."""
    return {
        "live": await tiger.recent_buckets(ticket_id),
        "history": await tiger.history_5min(ticket_id),
        "status": await tiger.curing_status(ticket_id),
    }


@app.post("/api/sensors/scenario/{ticket_id}", response_model=SensorScenario)
async def set_sensor_scenario(ticket_id: str, body: ScenarioRequest):
    """Demo control: drop a ticket into a cold snap, or bring it back."""
    sensors.set_scenario(ticket_id, body.mode)
    return {"ticket_id": ticket_id, "mode": sensors.get_scenario(ticket_id)}


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


@app.post("/api/tasks/{task_id}/video-evidence", response_model=VideoEvidenceResponse)
async def video_evidence(
    task_id: str, file: UploadFile = File(...), report_text: str | None = Form(None)
):
    """Upload + analyze a video ahead of /verify.

    Separate from /verify because the transport differs: a video is
    multipart, same as the document endpoints above; /verify's JSON body
    stays exactly as it was for text+photo submissions. The frontend calls
    this first, then passes the returned `media_url`/`finding` straight into
    the /verify call that actually creates the report — see
    VerifyRequest.video_finding/media_url.
    """
    project_id = _project_of(task_id)
    tasks = {t["id"]: t for t in await _tasks_view(project_id)}
    task = tasks.get(task_id)
    if task is None:
        raise HTTPException(404, f"unknown task {task_id}")

    data = await file.read()
    if not data:
        raise HTTPException(400, "empty upload")
    mime_type = file.content_type or "video/mp4"
    media_id, path = media_store.save(data, mime_type)

    finding = await analyse_video(
        str(path), mime_type, task["spec_text"], report_text or "", seed_module.base_id(task_id)
    )
    return VideoEvidenceResponse(media_url=f"/api/media/{media_id}", finding=finding)


@app.get("/api/media/{media_id}")
async def get_media(media_id: str):
    path = media_store.path_for(media_id)
    if path is None:
        raise HTTPException(404, "media not found")
    return FileResponse(path)


@app.post("/api/tasks/{task_id}/verify", response_model=Verdict)
async def verify(task_id: str, body: VerifyRequest, strict: bool = True):
    """`?strict=false` demotes the GPTZero gate to an advisory; default is on."""
    project_id = _project_of(task_id)
    tasks = {t["id"]: t for t in await _tasks_view(project_id)}
    task = tasks.get(task_id)
    if task is None:
        raise HTTPException(404, f"unknown task {task_id}")
    if task["state"] != "active":
        raise HTTPException(
            409, f"{task_id} is {task['state']}; updates can only be submitted against an active task"
        )
    if any(r["task_id"] == task_id and r["owner_decision"] == "pending" for r in await db.reports(project_id)):
        raise HTTPException(409, f"{task_id} already has an update awaiting the owner's review")

    base = seed_module.base_id(task_id)
    try:
        verdict = await verify_submission(
            task={**task, "id": base},
            report_text=body.report_text,
            image_base64=body.image_base64,
            transcript=body.transcript,
            strict=strict,
            video_finding=body.video_finding,
        )
        if not verdict:
            raise ValueError("agent returned nothing")
    except Exception as exc:  # degrade, never throw
        print(f"[verify] agent failed for {task_id} ({exc}); using canned verdict")
        verdict = _canned_verdict(
            base, body.report_text, body.transcript, task["spec_text"]
        )

    verdict["task_id"] = task_id
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
    # ...except over the arbiter's rule 0. This gate exists to stop a generated
    # narrative auto-approving; it has no business demoting a dispute the site's
    # own thermometer raised. A measurement outranks an authorship heuristic, and
    # the whole point of putting the sensor rule first is lost if the route
    # quietly puts the gate back in front of it.
    #
    # Keyed on the deciding rule, not on (DISPUTED and cold). Every active ticket
    # streams telemetry, so a cold-snapped one would otherwise exempt a dispute
    # that rule 0 played no part in — a contradicted photograph, say, on a claim
    # with no cure/pour/set word in it. The exemption belongs to rule 0 alone.
    sensor_disputed = verdict.get("branch") == "sensor_conflict"
    if strict and flagged and not sensor_disputed:
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

    # The verdict is a recommendation. Only the owner's decision moves the task
    # to verified; a submission always lands awaiting review.
    await db.add_evidence(
        {
            "task_id": task_id,
            "project_id": project_id,
            "report_text": body.report_text,
            "image_base64": body.image_base64,
            "transcript": body.transcript,
            "media_url": body.media_url,
            "verdict": verdict,
            # What GPTZero said, recorded identically in both modes; only the
            # decision below follows the verdict. No reading at all is NULL, not
            # 0.0 — a missing score and a confident-human one differ.
            "gptzero_score": score if scored else None,
            "gptzero_flag": "flagged" if flagged else "clear",
            "owner_decision": "pending",
            "created_at": _now(),
        }
    )
    await db.update_task(task_id, state="under_review")

    # Material shortage buried in the narrative -> act on the purchase order.
    try:
        action = await detect_material_shortage(
            " ".join(filter(None, [body.report_text, body.transcript]))
        )
    except Exception as exc:
        print(f"[verify] detect_material_shortage failed ({exc})")
        action = None
    if action is None and not AGENT_AVAILABLE:
        action = _canned_zip_action(base)
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

    return verdict


async def _po(po_id):
    return next((p for p in await db.purchase_orders() if p["id"] == po_id), {})


@app.post("/api/tasks/{task_id}/dispute", response_model=DisputeResponse)
async def dispute(task_id: str, body: DisputeRequest):
    graph = await _graph(_project_of(task_id))
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
    tasks = await _tasks_view(_project_of(task_id))
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
    elif body.action == "receive":
        updated = await db.update_po(
            po_id, status="received", last_action="Marked received on site."
        )
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
    return result


@app.get("/api/zip/status")
async def zip_status():
    """Whether the live Zip Procurement API is configured. Values are never returned."""
    return {"live": zip_api.zip_live(), "base_url": zip_api.ZIP_BASE}


@app.post("/api/reset")
async def reset(project_id: str = db.DEFAULT_PROJECT_ID):
    """Re-seed one portal project. Reset is scoped: other projects' rows survive."""
    _require_project(project_id)
    await seed_module.seed(project_id)
    return {"ok": True, "project_id": project_id}


# --- contractor portal ------------------------------------------------------
# Identity is a demo role switcher, not auth: these routes scope by the ids they
# are given and enforce nothing about who is asking. See CONTRACT.md.


def _party(items, party_id):
    return next(p for p in items if p["id"] == party_id)


@app.get("/api/portal", response_model=PortalOverview)
async def portal_overview(company_id: str | None = None, owner_id: str | None = None):
    """Projects with their parties and progress, optionally for one company or owner.
    `owners`/`companies` list only the parties that appear in the result, so a
    company sees exactly the owners it works for."""
    cfg = seed_module.load_portal()
    projects = []
    for p in cfg["projects"]:
        if (company_id and p["contractor_id"] != company_id) or (
            owner_id and p["owner_id"] != owner_id
        ):
            continue
        tasks = await _tasks_view(p["id"])
        count = lambda st: sum(1 for t in tasks if t["state"] == st)  # noqa: E731
        pending = [r for r in await db.reports(p["id"]) if r["owner_decision"] == "pending"]
        projects.append(
            {
                "id": p["id"],
                "name": p["name"],
                "owner": _party(cfg["owners"], p["owner_id"]),
                "contractor": _party(cfg["companies"], p["contractor_id"]),
                "start_date": p["start_date"],
                "total": len(tasks),
                "verified": count("verified"),
                "active": count("active"),
                "under_review": count("under_review"),
                "blocked": count("blocked"),
                "awaiting_review": len(pending),
            }
        )
    owner_ids = {p["owner"]["id"] for p in projects}
    company_ids = {p["contractor"]["id"] for p in projects}
    return {
        "owners": [o for o in cfg["owners"] if o["id"] in owner_ids],
        "companies": [c for c in cfg["companies"] if c["id"] in company_ids],
        "projects": projects,
    }


@app.get("/api/projects/{project_id}/reports", response_model=list[Report])
async def project_reports(project_id: str, view: str = "owner"):
    """`view=contractor` withholds the AI verdict: the contractor sees status and
    the owner's decision, not the verifier's reasoning."""
    _require_project(project_id)
    reports = await db.reports(project_id)
    if view == "contractor":
        reports = [
            {**r, "verdict": None, "impact": impact_module.contractor_view(r.get("impact"))}
            for r in reports
        ]
    return reports


async def _impact_of_denial(project, report):
    """Predicted cost of denying `report`, against the project's schedule now."""
    graph = await _graph(project["id"])
    if report["task_id"] not in graph:
        return None
    return impact_module.predict_denial(
        graph, report["task_id"], report.get("verdict"), project["start_date"]
    )


@app.get("/api/portal/owners/{owner_id}/queue", response_model=list[QueueItem])
async def owner_queue(owner_id: str):
    """Reports awaiting this owner's decision, across their projects, oldest first."""
    queue = []
    for p in seed_module.load_portal()["projects"]:
        if p["owner_id"] != owner_id:
            continue
        names = {t["id"]: t["name"] for t in await db.tasks(p["id"])}
        for r in await db.reports(p["id"]):
            if r["owner_decision"] == "pending":
                queue.append(
                    {
                        "report": r,
                        "impact": await _impact_of_denial(p, r),
                        "project_name": p["name"],
                        "task_name": names.get(r["task_id"], r["task_id"]),
                    }
                )
    return sorted(queue, key=lambda q: q["report"]["submitted_at"] or "")


@app.post("/api/reports/{report_id}/decision", response_model=DecisionResponse)
async def decide(report_id: str, body: DecisionRequest):
    """The owner's call. Approve verifies the task and unblocks successors whose
    predecessors are now all verified; deny returns the task to active."""
    report = None
    for p in seed_module.load_portal()["projects"]:
        report = next((r for r in await db.reports(p["id"]) if r["id"] == report_id), None)
        if report:
            break
    if report is None:
        raise HTTPException(404, f"unknown report {report_id}")
    if report["owner_decision"] != "pending":
        raise HTTPException(409, "this update has already been decided")

    approve = body.decision == "approve"
    ai_status = (report.get("verdict") or {}).get("status")
    override = approve and ai_status != "APPROVED"
    note = (body.note or "").strip() or None
    if (not approve or override) and note is None:
        raise HTTPException(
            422,
            "a note is required to deny an update, or to approve one the AI did not approve",
        )

    task_id, project_id = report["task_id"], report["project_id"]
    # A denial keeps the prediction made at that moment, next to the reason for it.
    impact = None if approve else await _impact_of_denial(seed_module.portal_project(project_id), report)
    await db.decide_report(report_id, "approved" if approve else "rejected", note, override, impact)
    await db.update_task(task_id, state="verified" if approve else "active")

    if approve:
        graph = await _graph(project_id)
        state = {t["id"]: t["state"] for t in await db.tasks(project_id)}
        for child in graph.successors(task_id):
            if state[child] == "pending" and all(
                state[parent] == "verified" for parent in graph.predecessors(child)
            ):
                await db.update_task(child, state="active")

    updated = next(r for r in await db.reports(project_id) if r["id"] == report_id)
    return {"report": updated, "tasks": await _tasks_view(project_id)}
