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
  state: TaskState;
  spec_text: string;
  depends_on: string[];
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
