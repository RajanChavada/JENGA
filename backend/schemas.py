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


class PaceStatus(BaseModel):
    """Earned-schedule pace, as the agent's fourth evidence source (rule 0')."""

    spi: float | None = None
    zone: str = ""
    #: The drought window the zone is judged over, in days.
    window_days: int = 7
    #: Verified work-days produced in the claim's zone inside that window.
    zone_earned_days: float = 0.0
    #: Events needed before pace decides anything. `samples` under this means
    #: "too little history to judge", which is neither a fast site nor a slow one.
    samples: int = 0
    min_samples: int = 5
    spi_floor: float = 0.6
    earned_total: float = 0.0
    planned_total: float = 0.0
    flagged: bool = False
    source: Literal["tiger", "mock"] = "mock"


class SchedulePoint(BaseModel):
    day: int
    date: str
    planned: float
    #: Null beyond today — the earned curve does not claim the future.
    earned: float | None = None


class ScheduleAnalytics(BaseModel):
    """The earned-schedule S-curve: planned vs verified work off the event stream."""

    day0: str
    today_day: int
    project_duration: int
    planned_total: float
    earned_total: float
    spi: float | None = None
    projected_finish_day: float | None = None
    projected_slip_days: float | None = None
    points: list[SchedulePoint]
    seeded: bool = False
    source: Literal["tiger", "mock"] = "mock"


class SpendPoint(BaseModel):
    day: int
    date: str
    committed: float


class SpendEvent(BaseModel):
    date: str
    day: int
    po_id: str
    event: str
    amount: float


class Escalation(BaseModel):
    """The governance agent's finding: compliant POs adding up to a pattern."""

    at: str
    message: str
    committed_pct: float
    earned_pct: float
    workflow_name: str | None = None
    #: `zip_comment` when the escalation landed as a real artifact on staging.
    delivered: Literal["zip_comment", "local"] = "local"


class SpendAnalytics(BaseModel):
    """Committed spend vs the site budget, with the escalation state."""

    budget: float
    currency: str = "CAD"
    committed_total: float
    committed_pct: float
    earned_pct: float
    points: list[SpendPoint]
    events: list[SpendEvent]
    escalation: Escalation | None = None
    workflows_read: int = 0
    workflow_name: str | None = None
    seeded: bool = False
    source: Literal["tiger", "mock"] = "mock"


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
    #: Earned-schedule pace the arbiter's rule 0' read. Absent on verdicts
    #: persisted before the pace rule existed.
    pace: PaceStatus | None = None
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
    #: Estimated committed dollars — what lands in the spend event stream.
    amount: float = 0.0
    steps: list[VerdictStep] = []
    purchase_order: PurchaseOrder | None = None
    #: Set when this creation tipped cumulative spend over the governance line.
    escalation: Escalation | None = None


class DisputeResponse(BaseModel):
    tasks: list[Task]
    critical_path: list[str]
    attribution: AttributionEntry
    project_slipped_days: int


# --- supply-line radar --------------------------------------------------------


class RouteClosure(BaseModel):
    """One 511 event sitting within ~500 m of a delivery route."""

    lat: float
    lng: float
    description: str
    roadway: str
    impact: str = ""
    full_closure: bool = False
    lanes_affected: str = ""


class RouteCpmPreview(BaseModel):
    """What the predicted slip would do to the schedule — a preview, never applied."""

    task_id: str
    project_slip_days: int
    downstream_count: int


class RouteRisk(BaseModel):
    po_id: str
    vendor: str
    material: str = ""
    vendor_lat: float
    vendor_lng: float
    #: Route line as GeoJSON (lng, lat) pairs, ready for a map source.
    geometry: list[list[float]]
    #: False when OSRM was unreachable and this is a straight-line corridor.
    geometry_live: bool = True
    closures: list[RouteClosure] = []
    risk: Literal["high", "medium", "low", "clear"] = "clear"
    predicted_slip_days: int = 0
    cpm_preview: RouteCpmPreview | None = None
    action: Literal["expedited", "escalated", "none"] = "none"
    action_detail: str = ""


class RouteSite(BaseModel):
    name: str
    lat: float
    lng: float


class RouteCheckResponse(BaseModel):
    """One radar pass: every PO's delivery route vs Ontario 511's live events."""

    #: 'live' when the 511 feed answered; 'seeded' when the fallback closure ran.
    source: Literal["live", "seeded"]
    checked_at: str
    events_scanned: int
    site: RouteSite
    routes: list[RouteRisk]


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
