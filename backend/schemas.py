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


class Verdict(BaseModel):
    task_id: str
    status: VerdictStatus
    confidence: float
    reasoning: str
    actionable_request: str | None = None
    gptzero: GPTZero
    vision: Vision
    evidence: Evidence


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
