import seed from '../../../data/seed_tasks.json';
import ossingtonSeed from '../../../data/seed_ossington.json';
import evidence from '../../../data/mock_evidence.json';
import { computeCpm } from './cpm';
import { displayId } from './format';
import type {
  AttributionEntry,
  DisputeResponse,
  GraphEdge,
  GraphResponse,
  HotzoneResponse,
  PurchaseOrder,
  SensorPayload,
  SensorStatus,
  Submission,
  Task,
  TaskState,
  Verdict,
  VerdictStatus,
  VerdictStep,
  Zone,
} from './types';

/**
 * Offline mirror of the backend. Everything the demo needs runs from here with
 * the API completely down: CPM, the five canned verdicts, the dispute cascade,
 * and the attribution ledger.
 */

/**
 * Every project's own seed, keyed by project id. A project with no entry here
 * (Finch, or any future one) shares Eglinton's — same rule `backend/seed.py`'s
 * `load_seed` applies from `portal.json`'s `tasks_file`.
 */
const SEEDS: Record<string, typeof seed> = {
  'ossington-relief-tunnel': ossingtonSeed as unknown as typeof seed,
};

function seedFor(projectId?: string): typeof seed {
  return (projectId && SEEDS[projectId]) || seed;
}

// Loose on purpose: two seed files, two different sets of literal `state`
// values (Ossington's includes `disputed`/`under_review`), so this can't be
// `typeof seed.tasks[number]` — that would infer Eglinton's narrower union
// and reject Ossington's states as a type mismatch.
interface SeedTask {
  id: string;
  name: string;
  zone: string;
  x: number;
  y: number;
  duration_days: number;
  due_day?: number | null;
  state: string;
  spec_text: string;
}

/** Every seed's tasks, flattened. Ids are globally unique (`P-1xx`, `T-2xx`), so a
 * flat lookup by id needs no project context. */
const ALL_SEED_TASKS: SeedTask[] = [seed, ossingtonSeed].flatMap(
  (s) => s.tasks as SeedTask[],
);

/** A Zip purchase-order adjustment triggered by a material shortage in a report. */
export interface ZipAction {
  po_id: string;
  action: string;
  new_delivery_date: string;
  reason: string;
}

interface Expected {
  status: VerdictStatus;
  confidence: number;
  gptzero: { ai_probability: number; flagged: boolean };
  vision: { observation: string; matches_claim: boolean | null };
  reasoning: string;
  actionable_request: string | null;
  side_effect?: string;
  zip_action?: ZipAction;
}

type RawSubmission = Submission & { expected: Expected };

const RAW = evidence.submissions as unknown as RawSubmission[];

export const SUBMISSIONS: Submission[] = RAW.map(
  ({ id, beat, label, task_id, report_text, image, transcript }) => ({
    id,
    beat,
    label,
    task_id,
    report_text,
    image,
    transcript,
  }),
);

/**
 * Vision's own confidence per canned submission. These numbers carry the demo's
 * whole point: SUB-02's vision is *confident* the photo contradicts the claim,
 * while SUB-03's vision is *not confident of anything* — which is precisely why
 * it returns matches_claim: null rather than false.
 * ponytail: lives here because mock_evidence.json predates vision.confidence and
 * the data agent owns that file. Delete once the fixture ships the field.
 */
const VISION_CONFIDENCE: Record<string, number> = {
  'SUB-01': 0.93,
  'SUB-02': 0.87,
  'SUB-03': 0.18,
  'SUB-04': 0.9,
  'SUB-05': 0.86,
  'SUB-06': 0.85,
  'SUB-07': 0.21,
};

function withCpm(tasks: SeedTask[], edges: GraphEdge[]): Task[] {
  return computeCpm(tasks, edges).tasks.map(
    (t) => ({ ...t, zone: t.zone as Zone, state: t.state as TaskState }) as Task,
  );
}

/** One project's graph — Eglinton's unless `projectId` names a project with its own seed. */
export function graph(projectId?: string): GraphResponse {
  const raw = seedFor(projectId);
  const edges = raw.edges as GraphEdge[];
  const tasks = withCpm(raw.tasks as SeedTask[], edges);
  const { critical_path, project_duration } = computeCpm(tasks, edges);
  return { tasks, edges, critical_path, project_duration };
}

export function purchaseOrders(projectId?: string): PurchaseOrder[] {
  return (seedFor(projectId).purchase_orders ?? []) as PurchaseOrder[];
}

export function hotzones(): HotzoneResponse {
  const generated_at = new Date().toISOString();
  return {
    source: 'offline',
    generated_at,
    notes: 'Offline demo seed. Set BROWSERBASE_API_KEY to scrape Toronto/Metrolinx sources with Browserbase Fetch.',
    hotzones: [
      {
        id: 'eglinton-west',
        name: 'Eglinton West Station',
        lat: 43.6902,
        lng: -79.4353,
        severity: 'high',
        project: 'Eglinton Crosstown West Extension',
        source: 'offline demo seed',
        updated_at: generated_at,
        summary:
          'Station box and guideway tie-in. Multimodal audit triggered. Critical path slip on south platform pour.',
        linked_site_id: 'eglinton-west-station',
      },
      {
        id: 'dufferin-eglinton',
        name: 'Dufferin & Eglinton',
        lat: 43.6981,
        lng: -79.4462,
        severity: 'medium',
        project: 'Eglinton Crosstown West Extension',
        source: 'offline demo seed',
        updated_at: generated_at,
        summary: 'Lane restrictions and structural slab pour. Utility coordination with Toronto Hydro in progress.',
        linked_site_id: null,
      },
      {
        id: 'mount-dennis',
        name: 'Mount Dennis Portal',
        lat: 43.6825,
        lng: -79.4901,
        severity: 'medium',
        project: 'Eglinton Crosstown West Extension',
        source: 'offline demo seed',
        updated_at: generated_at,
        summary:
          'Critical path slip on guideway wiring. Contractor claims 90% complete but visual inspection pending.',
        linked_site_id: null,
      },
      {
        id: 'yonge-queen',
        name: 'Queen & Yonge',
        lat: 43.6524,
        lng: -79.3792,
        severity: 'low',
        project: 'Downtown utility renewal',
        source: 'offline demo seed',
        updated_at: generated_at,
        summary:
          'Short-duration closures and utility coordination in a dense pedestrian corridor.',
        linked_site_id: null,
      },
      {
        id: 'finch-west',
        name: 'Finch West LRT \u2013 Humber College',
        lat: 43.7285,
        lng: -79.6073,
        severity: 'medium',
        project: 'Finch West LRT',
        source: 'offline demo seed',
        updated_at: generated_at,
        summary:
          'Guideway paving near Humber College terminal. Track alignment verification in progress.',
        linked_site_id: null,
      },
      {
        id: 'scarborough-srt',
        name: 'Scarborough Subway Extension',
        lat: 43.7735,
        lng: -79.258,
        severity: 'high',
        project: 'Scarborough Subway Extension',
        source: 'offline demo seed',
        updated_at: generated_at,
        summary:
          'Tunnel boring machine staging area. Deep excavation permit under review.',
        linked_site_id: null,
      },
    ],
  };
}

/** The historical-evidence column the contract requires but the fixture lacks. */
function historicalFor(task: Task | undefined): string {
  if (!task) return 'No prior schedule history on record for this activity.';
  const float =
    task.total_float === 0
      ? 'on the critical path with zero float'
      : `carrying ${task.total_float} day${task.total_float === 1 ? '' : 's'} of total float`;
  return `${task.id} scheduled day ${task.es}–${task.ef} (${task.duration_days}d), ${float}. Logged state at submission: ${task.state}. ${task.depends_on.length ? `Predecessors ${task.depends_on.join(', ')} closed out prior.` : 'No predecessor activities.'}`;
}

/* -------------------------------------------------------------------------- */
/* Curing telemetry — offline mirror of backend/integrations/tiger.py          */
/* -------------------------------------------------------------------------- */

/**
 * What the sensor endpoint yields when there is nothing to read: no backend, or
 * a ticket the simulator never emitted for. Deliberately a real zero-sample
 * payload rather than invented readings — an offline sparkline that moved would
 * be the panel claiming a measurement nobody took.
 */
export function sensors(): SensorPayload {
  return {
    live: [],
    history: [],
    status: {
      avg_temp_c: null,
      min_temp_c: null,
      samples: 0,
      below_threshold: false,
      threshold_c: 10,
      min_samples: 10,
      window_s: 120,
      window_requested_s: 120,
      source: 'mock',
    },
  };
}

/**
 * Mirrors `_window_label` in backend/agent.py: seconds under two minutes, whole
 * minutes at or above it. Every string quoting a window goes through this, so
 * neither half of the app can claim an averaging window it did not measure.
 */
export function windowLabel(seconds: number): string {
  return seconds >= 120 ? `${Math.floor(seconds / 60)} min` : `${seconds} s`;
}

/** Mirrors the backend's `:g` on the threshold — `10`, never `10.0`. */
export function thresholdLabel(celsius: number): string {
  return String(Number(celsius.toPrecision(6)));
}

/**
 * Offline mirror of `_sensor_card` in backend/agent.py, string for string.
 *
 * Four states, tested in this order: no samples, too sparse to judge, below
 * threshold, warm enough. The sparse state is `info` and not `ok` because "too
 * few readings to judge" and "the pour is fine" are different facts — and it
 * has to be re-derived from `samples < min_samples` here for the same reason
 * the backend re-derives it: `below_threshold` folds both into `false`.
 *
 * The floor and the window come off the payload, never from a constant here;
 * the backend clamps the window to the current curing regime, so it is
 * routinely something other than two minutes.
 */
export function sensorCard(sensor?: SensorStatus | null): {
  detail: string;
  signal: VerdictStep['signal'];
} {
  const avg = sensor?.avg_temp_c ?? null;
  const samples = sensor?.samples ?? 0;
  if (!sensor || !samples || avg === null) {
    return { detail: 'No sensor telemetry for this ticket.', signal: 'info' };
  }
  const window = windowLabel(sensor.window_s ?? 0);
  const threshold = thresholdLabel(sensor.threshold_c ?? 10);
  const floor = sensor.min_samples || 10;
  if (samples < floor) {
    return {
      detail: `Telemetry too sparse to judge: ${samples} reading${samples === 1 ? '' : 's'} in the last ${window}, ${floor} needed.`,
      signal: 'info',
    };
  }
  if (sensor.below_threshold) {
    return {
      detail: `Curing temp avg ${avg.toFixed(1)} °C over last ${window}, below ${threshold} °C threshold.`,
      signal: 'bad',
    };
  }
  return {
    detail: `Curing temp avg ${avg.toFixed(1)} °C over last ${window} (threshold ${threshold} °C).`,
    signal: 'ok',
  };
}

/**
 * Offline mirror of the backend arbiter's lenient mode. Lenient mode's only
 * documented effect is that the authorship gate stops changing the status, so
 * it can soften a verdict but must never harden one.
 *
 * The canned block does not record which rule produced a hold, and deriving a
 * fresh status from vision alone gets it wrong: SUB-02's hold came from
 * insufficient evidence, but its mirrored vision confidence reads 0.87, which
 * turned a review hold into a DISPUTED header sitting above the canned
 * insufficient-evidence prose. So a hold is left exactly as it stands and only
 * the advisory is appended. Keep in step with `_decide` in backend/agent.py.
 */
function asAdvisory(v: Verdict, task?: { x: number; y: number }): Verdict {
  if (!v.gptzero.flagged) return v;

  const pct = Math.round(v.gptzero.ai_probability * 100);
  return {
    ...v,
    reasoning: `${v.reasoning.trimEnd()} GPTZero advisory: ${pct}% AI`,
    actionable_request:
      v.status === 'UNDER_REVIEW'
        ? holdRequest(v.actionable_request, task)
        : v.actionable_request,
  };
}

/**
 * Every other layer guarantees a review hold names somewhere to go, and names
 * it in blueprint coordinates. Mirrors the tail of `_decide`.
 */
function holdRequest(
  request: string | null,
  task?: { x: number; y: number },
): string {
  const where = task ? `X:${task.x} Y:${task.y}` : 'the recorded coordinates';
  const base = request ?? 'Re-inspect on site and re-submit evidence.';
  return base.includes('X:')
    ? base
    : `${base.trimEnd()} Blueprint coordinates ${where}.`;
}

/** Maps a submission's `expected` block onto the contract's Verdict shape. */
export function verdictFor(
  submissionId: string,
  tasks?: Task[],
  strict = true,
): Verdict {
  const sub = RAW.find((s) => s.id === submissionId);
  if (!sub) throw new Error(`Unknown submission ${submissionId}`);
  const e = sub.expected;
  const seedTask = ALL_SEED_TASKS.find((t) => t.id === sub.task_id);
  const liveTask = tasks?.find((t) => t.id === sub.task_id);

  const verdict: Verdict = {
    task_id: sub.task_id,
    status: e.status,
    confidence: e.confidence,
    reasoning: e.reasoning,
    actionable_request: e.actionable_request ?? null,
    gptzero: { ...e.gptzero },
    vision: {
      observation: e.vision.observation,
      matches_claim: e.vision.matches_claim,
      confidence: VISION_CONFIDENCE[sub.id] ?? 0.5,
    },
    evidence: {
      spec: seedTask?.spec_text ?? '',
      claim: sub.report_text ?? sub.transcript ?? '(no written claim submitted)',
      visual: e.vision.observation,
      historical: historicalFor(liveTask),
    },
  };

  return strict ? verdict : asAdvisory(verdict, liveTask ?? seedTask);
}

/** Procurement fallout the agent noticed in the report text, if any. */
export function sideEffectFor(submissionId: string): string | null {
  return RAW.find((s) => s.id === submissionId)?.expected.side_effect ?? null;
}

/**
 * The Zip purchase-order action a submission triggers, if any. Mirrors the
 * backend's `detect_material_shortage` so the procurement panel updates whether
 * we are hitting the API or running on fixtures.
 */
export function zipActionFor(submissionId: string): ZipAction | null {
  const raw = RAW.find((s) => s.id === submissionId)?.expected.zip_action;
  return raw ?? null;
}

/** The task state a verdict drives its node into. */
export function stateForVerdict(status: VerdictStatus): TaskState {
  return status === 'APPROVED'
    ? 'verified'
    : status === 'DISPUTED'
      ? 'disputed'
      : 'under_review';
}

/**
 * Which project's edges a task belongs to, prefixed to match `taskId` itself —
 * bare if `taskId` is bare (an all-offline session), or carrying whatever
 * `project:` prefix `taskId` does (a session that started online, where every
 * id in play, including `current`'s, is the backend's prefixed one). Mirrors
 * `backend/seed.py`'s `scoped_id`, which prefixes the seed's edges the same way.
 */
function edgesFor(taskId: string): GraphEdge[] {
  const base = displayId(taskId);
  const prefix = taskId.slice(0, taskId.length - base.length);
  const inOssington = (ossingtonSeed.tasks as SeedTask[]).some((t) => t.id === base);
  const raw = (inOssington ? ossingtonSeed : seed).edges as GraphEdge[];
  return prefix
    ? raw.map((e) => ({ source: prefix + e.source, target: prefix + e.target }))
    : raw;
}

/**
 * Re-run CPM with the disputed task stretched by `delay_days`, then diff against
 * the pre-dispute schedule to find who moved and by how much.
 */
export function dispute(
  current: Task[],
  taskId: string,
  delayDays: number,
): DisputeResponse {
  const before = new Map(current.map((t) => [t.id, t]));
  const stretched = current.map((t) =>
    t.id === taskId
      ? { ...t, duration_days: t.duration_days + delayDays }
      : { ...t },
  );
  const beforeDuration = Math.max(...current.map((t) => t.ef));
  const { tasks, critical_path, project_duration } = computeCpm(
    stretched,
    edgesFor(taskId),
  );

  const next = tasks.map(
    (t) =>
      ({
        ...t,
        zone: t.zone as Zone,
        state: (t.id === taskId
          ? 'disputed'
          : before.get(t.id)!.state) as TaskState,
      }) as Task,
  );

  const downstream = next
    .filter((t) => t.id !== taskId && t.es !== before.get(t.id)!.es)
    .map((t) => t.id);

  const projectSlipped = project_duration - beforeDuration;
  const floatConsumed = Math.min(
    before.get(taskId)?.total_float ?? 0,
    delayDays,
  );

  return {
    tasks: next,
    critical_path,
    project_slipped_days: projectSlipped,
    attribution: attributionFor(
      taskId,
      delayDays,
      floatConsumed,
      downstream,
      projectSlipped,
    ),
  };
}

function attributionFor(
  taskId: string,
  slipDays: number,
  floatConsumed: number,
  downstream: string[],
  projectSlipped: number,
): AttributionEntry {
  const canned = CASCADE_DEMO;
  const split =
    canned?.task_id === taskId && canned.expected_attribution?.attribution
      ? canned.expected_attribution.attribution
      : [
          {
            party: 'Contractor',
            days: slipDays,
            reason: 'Unverified work claim on a scheduled activity',
          },
        ];

  return {
    id: `ATT-${taskId}-${Date.now().toString(36)}`,
    task_id: taskId,
    slip_days: slipDays,
    float_consumed: floatConsumed,
    downstream_affected: downstream,
    project_slipped_days: projectSlipped,
    attribution: split,
    created_at: new Date().toISOString(),
  };
}

export const CASCADE_DEMO = evidence.cascade_demo as unknown as {
  task_id: string;
  delay_days: number;
  reason: string;
  expected_attribution?: { attribution?: AttributionEntry['attribution'] };
};

/**
 * Fallback verdict keyed by task rather than by submission, for the upload path
 * where the user brought their own document instead of picking a demo case.
 */
export function verdictForTask(
  taskId: string,
  tasks?: Task[],
  strict = true,
): Verdict {
  // `taskId` may carry a project prefix (`ossington-relief-tunnel:T-211`) while
  // mock_evidence.json's `task_id` never does — strip it before matching, or a
  // session that started online and fell back mid-demo loses its canned verdict.
  const sub = RAW.find((s) => s.task_id === displayId(taskId));
  if (sub) return verdictFor(sub.id, tasks, strict);

  const task = tasks?.find((t) => t.id === taskId);
  return {
    task_id: taskId,
    status: 'UNDER_REVIEW',
    confidence: 0.3,
    reasoning:
      'Backend unreachable, so the uploaded document could not be evaluated against the specification. No verdict is asserted.',
    actionable_request: task
      ? `Re-run verification for ${taskId} at blueprint coordinates X:${task.x} Y:${task.y} once the verification service is reachable.`
      : `Re-run verification for ${taskId} once the verification service is reachable.`,
    gptzero: { ai_probability: 0, flagged: false },
    vision: { observation: 'No analysis performed.', matches_claim: null, confidence: 0 },
    evidence: {
      spec: task?.spec_text ?? '—',
      claim: 'Uploaded document.',
      visual: 'No analysis performed.',
      historical: 'Unavailable offline.',
    },
  };
}
