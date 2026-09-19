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

/** Which curing regime the simulator is driving a ticket through. */
export type SensorMode = 'normal' | 'cold';

/** Curing telemetry for one ticket — the agent's fifth evidence source. */
export interface SensorStatus {
  avg_temp_c: number | null;
  min_temp_c: number | null;
  samples: number;
  /**
   * The arbiter's rule 0 reads this and nothing else. It stays false while
   * `samples < min_samples`, so it folds "too sparse to judge" and "warm
   * enough" into the same value — never render it as "the pour is fine".
   */
  below_threshold: boolean;
  threshold_c: number;
  /** Readings needed before the average is allowed to decide anything. */
  min_samples: number;
  /** The window actually measured. Shorter than requested while a new curing
   * regime is still filling up, and the only one any string may quote. */
  window_s: number;
  window_requested_s: number;
  source: 'tiger' | 'mock';
}

/** One `time_bucket` row: live off the hypertable, or off the 5-min aggregate. */
export interface SensorBucket {
  bucket: string;
  avg_temp: number | null;
  avg_humidity: number | null;
  min_temp: number | null;
  max_temp: number | null;
  min_humidity: number | null;
  max_humidity: number | null;
}

export interface SensorPayload {
  live: SensorBucket[];
  /** The continuous aggregate. Always empty in mock mode — there is none to read. */
  history: SensorBucket[];
  status: SensorStatus;
}

export interface SensorScenario {
  ticket_id: string;
  mode: SensorMode;
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
  };
  evidence: {
    spec: string;
    claim: string;
    visual: string;
    historical: string;
  };
  /**
   * Curing telemetry the arbiter's rule 0 read. Absent on a fixture verdict and
   * on the backend's pipeline-error path.
   */
  sensor?: SensorStatus | null;
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
