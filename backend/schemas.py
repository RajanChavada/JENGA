"""Pydantic v2 models mirroring the TypeScript interfaces in CONTRACT.md."""

from typing import Literal

from pydantic import BaseModel

TaskState = Literal[
    "pending", "active", "under_review", "verified", "disputed", "blocked"
]
Zone = Literal[
    "track_bed", "south_platform", "north_platform", "mezzanine", "escalator_well"
]
VerdictStatus = Literal["APPROVED", "DISPUTED", "UNDER_REVIEW"]
POStatus = Literal["confirmed", "rescheduled", "draft", "escalated", "received"]


class Task(BaseModel):
    id: str
    name: str
    zone: Zone
    x: float
    y: float
    duration_days: int
    #: Contractual due day, an offset from the project start. None when the schedule has no dates.
    due_day: int | None = None
    state: TaskState
    spec_text: str
    depends_on: list[str]
    #: Unverified predecessors; populated only while the task is derived `blocked`.
    blocked_by: list[str] = []
    # CPM, computed by the backend
    es: int
    ef: int
    ls: int
    lf: int
    total_float: int
    is_critical: bool
    depth: int


class Edge(BaseModel):
    source: str
    target: str


class GraphResponse(BaseModel):
    tasks: list[Task]
    edges: list[Edge]
    critical_path: list[str]
    project_duration: int


class GPTZero(BaseModel):
    ai_probability: float
    flagged: bool


class Vision(BaseModel):
    observation: str
    # false = image contradicts the claim -> DISPUTED
    # null  = image cannot establish anything -> UNDER_REVIEW
    matches_claim: bool | None = None
    confidence: float = 0.0


class Evidence(BaseModel):
    spec: str
    claim: str
    visual: str
    historical: str


class SensorStatus(BaseModel):
    """Curing telemetry for one ticket, as the agent's fifth evidence source."""

    avg_temp_c: float | None = None
    min_temp_c: float | None = None
    samples: int = 0
    below_threshold: bool = False
    threshold_c: float = 10.0
    #: Readings needed before the average decides anything. `samples` under this
    #: means "too sparse to judge", which is neither a warm slab nor a cold one.
    min_samples: int = 10
    #: The window actually measured over, which is what the UI quotes. Shorter
    #: than `window_requested_s` while a new curing regime is still filling up.
    window_s: int = 120
    window_requested_s: int = 120
    source: Literal["tiger", "mock"] = "mock"


class SensorBucket(BaseModel):
    """One `time_bucket` row: live off the hypertable, or off the 5-min aggregate."""

    bucket: str
    avg_temp: float | None = None
    avg_humidity: float | None = None
    min_temp: float | None = None
    max_temp: float | None = None
    min_humidity: float | None = None
    max_humidity: float | None = None


class SensorPayload(BaseModel):
    live: list[SensorBucket]
    history: list[SensorBucket]
    status: SensorStatus


class SensorScenario(BaseModel):
    ticket_id: str
    mode: Literal["normal", "cold"]


class VerdictStep(BaseModel):
    """One node in the agent's resolution trace. Surfaced in the UI so the
    multi-source reasoning is visible, not just its conclusion (the Rox beat)."""

    node: str
    title: str
    detail: str
    signal: Literal["ok", "warn", "bad", "info"] = "info"


class Verdict(BaseModel):
    task_id: str
    status: VerdictStatus
    confidence: float
    reasoning: str
    actionable_request: str | None = None
    gptzero: GPTZero
    vision: Vision
    evidence: Evidence
    #: Curing telemetry the arbiter's rule 0 read. Absent only on the
    #: pipeline-error path of an older verdict.
    sensor: SensorStatus | None = None
    #: Step-by-step trace of the five-node LangGraph that produced this verdict.
    trace: list[VerdictStep] = []


class AttributionSplit(BaseModel):
    party: str
    days: float
    reason: str


class AttributionEntry(BaseModel):
    id: str
    task_id: str
    slip_days: int
    float_consumed: int
    downstream_affected: list[str]
    project_slipped_days: int
    attribution: list[AttributionSplit]
    created_at: str


class PurchaseOrder(BaseModel):
    id: str
    material: str
    quantity: str
    vendor: str
    delivery_date: str
    status: POStatus
    linked_task: str
    last_action: str | None = None


class ParsedDocument(BaseModel):
    filename: str
    kind: str
    char_count: int
    text: str
    preview: str


class ProposedTask(BaseModel):
    name: str
    zone: Zone
    duration_days: int
    spec_text: str
    depends_on: list[str]


class ExtractedTasks(BaseModel):
    filename: str
    tasks: list[ProposedTask]
    source: Literal["llm", "offline", "rejected"]
    notes: str


class Hotzone(BaseModel):
    id: str
    name: str
    lat: float
    lng: float
    severity: Literal["low", "medium", "high"]
    project: str
    source: str
    updated_at: str
    summary: str
    linked_site_id: str | None = None


class HotzoneResponse(BaseModel):
    source: Literal["browserbase", "offline"]
    generated_at: str
    notes: str
    hotzones: list[Hotzone]


# --- request bodies ---------------------------------------------------------


class VerifyRequest(BaseModel):
    #: None for voice-note submissions, which carry their claim in `transcript`.
    #: Requiring a string here 422'd every voice verify and silently retired the
    #: session to fixtures — the exact confident-wrong-answer JENGA argues against.
    report_text: str | None = None
    image_base64: str | None = None
    transcript: str | None = None


class DisputeRequest(BaseModel):
    delay_days: int
    reason: str


class StateRequest(BaseModel):
    state: TaskState


class ScenarioRequest(BaseModel):
    #: Anything else is a 422; the simulator has exactly these two regimes.
    mode: Literal["normal", "cold"]


class POActionRequest(BaseModel):
    """A procurement action a planner takes on a purchase order from the ledger."""

    #: `expedite` pulls delivery in a day (live via Zip when keyed); `receive`
    #: marks it delivered; `link` ties it to a ticket for attribution.
    action: Literal["expedite", "receive", "link"]
    #: Required for `link`; ignored otherwise.
    task_id: str | None = None


class AgentProcurementRequest(BaseModel):
    """Work packages the user asked the procurement agent to buy for."""

    packages: list[ProposedTask]
    #: The document the packages were extracted from, quoted in the trace.
    filename: str | None = None


class AgentProcurementResponse(BaseModel):
    """What the procurement agent did, trace included.

    `live=True` means a real purchase order now exists on Zip staging under
    `po_id`; False means the one fallback ran and the PO is on the local ledger
    only. `steps` reuses the verification trace shape so the UI renders both
    agents with one component vocabulary.
    """

    ok: bool
    live: bool
    po_id: str | None = None
    po_number: str | None = None
    vendor: str | None = None
    detail: str
    steps: list[VerdictStep] = []
    purchase_order: PurchaseOrder | None = None


class DisputeResponse(BaseModel):
    tasks: list[Task]
    critical_path: list[str]
    attribution: AttributionEntry
    project_slipped_days: int


# --- contractor portal ------------------------------------------------------

OwnerDecision = Literal["pending", "approved", "rejected"]


class Report(BaseModel):
    id: str
    task_id: str
    project_id: str
    report_text: str
    # The AI's recommendation. Withheld (None) from the contractor's view.
    verdict: dict | None = None
    owner_decision: OwnerDecision
    owner_note: str | None = None
    #: True when the owner approved a report the AI had not approved.
    ai_override: bool = False
    #: Predicted cost of a denial, stored when the owner denies. A reduced copy
    #: (rework days, finish date) in the contractor's view.
    impact: dict | None = None
    submitted_at: str | None = None
    decided_at: str | None = None


class DecisionRequest(BaseModel):
    decision: Literal["approve", "deny"]
    #: Required to deny, and to approve against the AI's recommendation.
    note: str | None = None


class DecisionResponse(BaseModel):
    report: Report
    tasks: list[Task]


class PortalParty(BaseModel):
    id: str
    name: str


class PortalProject(BaseModel):
    id: str
    name: str
    owner: PortalParty
    contractor: PortalParty
    start_date: str
    total: int
    verified: int
    active: int
    under_review: int
    blocked: int
    awaiting_review: int


class PortalOverview(BaseModel):
    owners: list[PortalParty]
    companies: list[PortalParty]
    projects: list[PortalProject]


class AffectedTask(BaseModel):
    id: str
    name: str
    finish_date_before: str
    finish_date_after: str
    #: Day offsets on the schedule's axis. Absent on impacts stored before they existed.
    finish_day_before: int | None = None
    finish_day_after: int | None = None
    due_day: int | None = None
    due_date: str | None = None
    late_by_days: int
    newly_late: bool


class Impact(BaseModel):
    task_id: str
    rework_days: int
    rationale: list[str]
    float_consumed: int
    absorbed_by_float: bool
    project_slipped_days: int
    baseline_finish_day: int | None = None
    predicted_finish_day: int | None = None
    deadline_day: int | None = None
    baseline_finish_date: str
    predicted_finish_date: str
    project_deadline_date: str
    days_past_deadline: int
    critical_path_changed: bool
    affected: list[AffectedTask]


class QueueItem(BaseModel):
    #: "If you deny": what denying this report would do to the schedule.
    impact: Impact | None = None
    report: Report
    project_name: str
    task_name: str
