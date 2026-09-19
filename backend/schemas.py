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
POStatus = Literal["confirmed", "rescheduled", "draft", "escalated"]


class Task(BaseModel):
    id: str
    name: str
    zone: Zone
    x: float
    y: float
    duration_days: int
    state: TaskState
    spec_text: str
    depends_on: list[str]
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
    #: Step-by-step trace of the four-node LangGraph that produced this verdict.
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
    source: Literal["llm", "offline"]
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
    report_text: str
    image_base64: str | None = None
    transcript: str | None = None


class DisputeRequest(BaseModel):
    delay_days: int
    reason: str


class StateRequest(BaseModel):
    state: TaskState


class DisputeResponse(BaseModel):
    tasks: list[Task]
    critical_path: list[str]
    attribution: AttributionEntry
    project_slipped_days: int
