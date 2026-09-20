// Mirrors CONTRACT.md. Do not drift from it.

export type TaskState =
  | 'pending'
  | 'active'
  | 'under_review'
  | 'verified'
  | 'disputed'
  | 'blocked';

export type Zone =
  | 'track_bed'
  | 'south_platform'
  | 'north_platform'
  | 'mezzanine'
  | 'escalator_well';

export const ZONES: Zone[] = [
  'track_bed',
  'south_platform',
  'north_platform',
  'mezzanine',
  'escalator_well',
];

export interface Task {
  id: string;
  name: string;
  zone: Zone;
  x: number;
  y: number;
  duration_days: number;
  /** Contractual due day: an offset from the project start. Absent when the schedule has no dates. */
  due_day?: number | null;
  state: TaskState;
  spec_text: string;
  depends_on: string[];
  /** While the task is derived `blocked`: the predecessors not yet verified. */
  blocked_by?: string[];
  es: number;
  ef: number;
  ls: number;
  lf: number;
  total_float: number;
  is_critical: boolean;
  depth: number;
}

export interface GraphEdge {
  source: string;
  target: string;
}

export interface GraphResponse {
  tasks: Task[];
  edges: GraphEdge[];
  critical_path: string[];
  project_duration: number;
}

export type VerdictStatus = 'APPROVED' | 'DISPUTED' | 'UNDER_REVIEW';

/** Earned-schedule pace — the agent's fourth evidence source (rule 0'). */
export interface PaceStatus {
  spi: number | null;
  zone: string;
  /** The drought window the zone is judged over, in days. */
  window_days: number;
  /** Verified work-days produced in the claim's zone inside that window. */
  zone_earned_days: number;
  /**
   * Events needed before pace decides anything. `samples` under this means
   * "too little history to judge" — neither a fast site nor a slow one.
   */
  samples: number;
  min_samples: number;
  spi_floor: number;
  earned_total: number;
  planned_total: number;
  flagged: boolean;
  source: 'tiger' | 'mock';
}

/** One day on the S-curve. `earned` is null beyond today — no claimed future. */
export interface SchedulePoint {
  day: number;
  date: string;
  planned: number;
  earned: number | null;
}

export interface ScheduleAnalytics {
  day0: string;
  today_day: number;
  project_duration: number;
  planned_total: number;
  earned_total: number;
  spi: number | null;
  projected_finish_day: number | null;
  projected_slip_days: number | null;
  points: SchedulePoint[];
  seeded: boolean;
  source: 'tiger' | 'mock';
}

export interface SpendPoint {
  day: number;
  date: string;
  committed: number;
}

/** One procurement lifecycle marker — a diamond on the timeline. */
export interface SpendEvent {
  date: string;
  day: number;
  po_id: string;
  event: string;
  amount: number;
}

/** The governance agent's finding: compliant POs adding up to a pattern. */
export interface Escalation {
  at: string;
  message: string;
  committed_pct: number;
  earned_pct: number;
  workflow_name: string | null;
  /** `zip_comment` when the escalation landed as a real artifact on staging. */
  delivered: 'zip_comment' | 'local';
}

export interface SpendAnalytics {
  budget: number;
  currency: string;
  committed_total: number;
  committed_pct: number;
  earned_pct: number;
  points: SpendPoint[];
  events: SpendEvent[];
  escalation: Escalation | null;
  workflows_read: number;
  workflow_name: string | null;
  seeded: boolean;
  source: 'tiger' | 'mock';
}

/** One node in the agent's resolution trace (the five-node LangGraph). */
export interface VerdictStep {
  node: string;
  title: string;
  detail: string;
  signal: 'ok' | 'warn' | 'bad' | 'info';
}

export interface Verdict {
  task_id: string;
  status: VerdictStatus;
  confidence: number;
  reasoning: string;
  actionable_request: string | null;
  gptzero: { ai_probability: number; flagged: boolean };
  vision: {
    observation: string;
    /**
     * false = the image CONTRADICTS the claim  -> DISPUTED
     * null  = the image CANNOT ESTABLISH anything -> UNDER_REVIEW
     * Never collapse these two. `null` is the "agent refuses to rule" beat.
     */
    matches_claim: boolean | null;
    /** Vision's own confidence, 0..1. Distinct from the top-level verdict confidence. */
    confidence: number;
    /** Which medium was actually reviewed. Absent only on an older pipeline-error verdict. */
    media_type?: 'photo' | 'video' | null;
  };
  evidence: {
    spec: string;
    claim: string;
    visual: string;
    historical: string;
  };
  /**
   * Earned-schedule pace the arbiter's rule 0' read. Absent on a fixture
   * verdict and on the backend's pipeline-error path.
   */
  pace?: PaceStatus | null;
  /** Step-by-step agent trace. Synthesized on the client when absent. */
  trace?: VerdictStep[];
}

export interface AttributionSplit {
  party: string;
  days: number;
  reason: string;
}

export interface AttributionEntry {
  id: string;
  task_id: string;
  slip_days: number;
  float_consumed: number;
  downstream_affected: string[];
  project_slipped_days: number;
  attribution: AttributionSplit[];
  created_at: string;
}

export interface DisputeResponse {
  tasks: Task[];
  critical_path: string[];
  attribution: AttributionEntry;
  project_slipped_days: number;
}

export interface PurchaseOrder {
  id: string;
  material: string;
  quantity: string;
  vendor: string;
  delivery_date: string;
  status: 'confirmed' | 'rescheduled' | 'draft' | 'escalated' | 'received';
  linked_task: string;
  last_action: string | null;
}

export interface Hotzone {
  id: string;
  name: string;
  lat: number;
  lng: number;
  severity: 'low' | 'medium' | 'high';
  project: string;
  source: string;
  updated_at: string;
  summary: string;
  linked_site_id: string | null;
}

export interface HotzoneResponse {
  source: 'browserbase' | 'offline';
  generated_at: string;
  notes: string;
  hotzones: Hotzone[];
}

export interface VerifyBody {
  report_text: string | null;
  image_base64?: string | null;
  transcript?: string | null;
  /** Set only when a video was attached: the finding POST /video-evidence already computed. */
  video_finding?: Record<string, unknown> | null;
  /** That video's playback URL, carried through so the stored report can play it back. */
  media_url?: string | null;
}

/** What POST /api/tasks/{id}/video-evidence returns. */
export interface VideoEvidenceResponse {
  media_url: string;
  finding: Record<string, unknown>;
}

/** A canned demo submission out of data/mock_evidence.json. */
export interface Submission {
  id: string;
  beat: number;
  label: string;
  task_id: string;
  report_text: string | null;
  image: string;
  transcript: string | null;
}

/* --------------------------------------------------------------------------
 * Supply-line radar: delivery routes vs Ontario 511's live closure feed.
 * ------------------------------------------------------------------------ */

/** One 511 event sitting within ~500 m of a delivery route. */
export interface RouteClosure {
  lat: number;
  lng: number;
  description: string;
  roadway: string;
  impact: string;
  full_closure: boolean;
  lanes_affected: string;
}

/** What the predicted slip would do to the schedule — a preview, never applied. */
export interface RouteCpmPreview {
  task_id: string;
  project_slip_days: number;
  downstream_count: number;
}

export interface RouteRisk {
  po_id: string;
  vendor: string;
  material: string;
  vendor_lat: number;
  vendor_lng: number;
  /** Route line as GeoJSON (lng, lat) pairs, ready for a map source. */
  geometry: number[][];
  /** False when OSRM was unreachable and this is a straight-line corridor. */
  geometry_live: boolean;
  closures: RouteClosure[];
  risk: 'high' | 'medium' | 'low' | 'clear';
  predicted_slip_days: number;
  cpm_preview: RouteCpmPreview | null;
  action: 'expedited' | 'escalated' | 'none';
  action_detail: string;
}

export interface RouteCheckResponse {
  /** 'live' when the 511 feed answered; 'seeded' when the fallback closure ran. */
  source: 'live' | 'seeded';
  checked_at: string;
  events_scanned: number;
  site: { name: string; lat: number; lng: number };
  routes: RouteRisk[];
}
/* --- contractor portal ---------------------------------------------------- */

export type OwnerDecision = 'pending' | 'approved' | 'rejected';

export interface ImpactedTask {
  id: string;
  name: string;
  finish_date_before: string;
  finish_date_after: string;
  /** Day offsets on the schedule's axis; absent on impacts stored before they existed. */
  finish_day_before?: number | null;
  finish_day_after?: number | null;
  due_day?: number | null;
  due_date: string | null;
  late_by_days: number;
  newly_late: boolean;
}

/** What denying an update would cost the schedule. Advisory: no duration changes. */
export interface Impact {
  task_id: string;
  rework_days: number;
  rationale: string[];
  float_consumed: number;
  absorbed_by_float: boolean;
  project_slipped_days: number;
  baseline_finish_day?: number | null;
  predicted_finish_day?: number | null;
  deadline_day?: number | null;
  baseline_finish_date: string;
  predicted_finish_date: string;
  project_deadline_date: string;
  days_past_deadline: number;
  critical_path_changed: boolean;
  affected: ImpactedTask[];
}

/** The part of an Impact the contractor sees. */
export type ContractorImpact = Pick<
  Impact,
  'rework_days' | 'predicted_finish_date' | 'project_slipped_days'
>;

export interface Report {
  id: string;
  task_id: string;
  project_id: string;
  report_text: string;
  /** Playback URL for the attached evidence (video or photo), when one was submitted. */
  media_url?: string | null;
  /** Preview URL for the contractor's uploaded report file (PDF/DOCX/TXT), when submitted as a document. */
  report_url?: string | null;
  report_filename?: string | null;
  /** The AI's recommendation. Null in the contractor's view: it never sees it. */
  verdict: Verdict | null;
  owner_decision: OwnerDecision;
  owner_note: string | null;
  /** The owner approved a report the AI had not approved. */
  ai_override: boolean;
  /** Stored when the owner denies. The contractor's copy is reduced to `ContractorImpact`. */
  impact: Impact | ContractorImpact | null;
  submitted_at: string | null;
  decided_at: string | null;
}

export interface PortalParty {
  id: string;
  name: string;
}

export interface PortalProject {
  id: string;
  name: string;
  owner: PortalParty;
  contractor: PortalParty;
  /** ISO date that day 0 of the schedule falls on. */
  start_date: string;
  total: number;
  verified: number;
  active: number;
  under_review: number;
  blocked: number;
  awaiting_review: number;
}

export interface PortalOverview {
  owners: PortalParty[];
  companies: PortalParty[];
  projects: PortalProject[];
}

export interface QueueItem {
  /** "If you deny": the predicted cost of denying this report. */
  impact: Impact | null;
  report: Report;
  project_name: string;
  task_name: string;
}

export interface DecisionResponse {
  report: Report;
  tasks: Task[];
}

export type Role = 'owner' | 'contractor';
