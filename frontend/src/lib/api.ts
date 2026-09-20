import * as fx from './fixtures';
import * as local from './portalFixtures';
import type {
  DecisionResponse,
  DisputeResponse,
  GraphResponse,
  HotzoneResponse,
  PortalOverview,
  PurchaseOrder,
  QueueItem,
  Report,
  SensorMode,
  SensorPayload,
  SensorScenario,
  Task,
  VideoEvidenceResponse,
} from './types';

const BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8000';
const FIXTURES_ONLY = process.env.NEXT_PUBLIC_USE_FIXTURES === '1';

/** True once a live call has failed, so we stop hammering a dead backend. */
let offline = FIXTURES_ONLY;

export function isOffline() {
  return offline;
}

/** Resolve a backend-relative media path (e.g. `report.media_url`) to a fetchable URL. */
export function mediaUrl(path: string): string {
  return `${BASE}${path}`;
}

/**
 * Try the backend; fall back to the local fixture on any failure. The demo must
 * survive the API being down mid-presentation, so the fallback is the default
 * rather than something you have to remember to flag on.
 */
async function call<T>(
  path: string,
  init: RequestInit | undefined,
  fallback: () => T,
): Promise<T> {
  if (offline) return fallback();
  try {
    const res = await fetch(`${BASE}${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', ...init?.headers },
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return (await res.json()) as T;
  } catch (err) {
    console.warn(`[jenga] ${path} unavailable, using fixtures.`, err);
    offline = true;
    return fallback();
  }
}

/**
 * One site's graph. Offline, `tasks` comes from `local.tasksFor` — the project's
 * own fixture schedule with its in-session task states — while edges/critical
 * path/duration come straight from that project's seed, so the two always agree.
 */
export function fetchGraph(projectId?: string): Promise<GraphResponse> {
  const q = projectId ? `?project_id=${encodeURIComponent(projectId)}` : '';
  return call(`/api/graph${q}`, undefined, () => {
    const g = fx.graph(projectId);
    return projectId ? { ...g, tasks: local.tasksFor(projectId) } : g;
  });
}

export function fetchPurchaseOrders(): Promise<PurchaseOrder[]> {
  return call('/api/purchase-orders', undefined, fx.purchaseOrders);
}

/** A planner action on a PO from the ledger: expedite, receive, or link to a task. */
export type POAction = 'expedite' | 'receive' | 'link';

/**
 * Act on a purchase order. On any backend failure this returns null rather than
 * a fixture: procurement is a discrete user action, and a button that silently
 * "worked" against fixtures while the backend is down is the exact confident-
 * wrong-answer failure JENGA argues against. The store leaves the PO untouched.
 */
export async function actOnPurchaseOrder(
  poId: string,
  action: POAction,
  taskId?: string,
): Promise<PurchaseOrder | null> {
  if (offline) return null;
  try {
    const res = await fetch(`${BASE}/api/purchase-orders/${poId}/action`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action, task_id: taskId ?? null }),
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return (await res.json()) as PurchaseOrder;
  } catch (err) {
    console.warn(`[jenga] PO ${action} on ${poId} did not land.`, err);
    return null;
  }
}

export function fetchHotzones(): Promise<HotzoneResponse> {
  return call('/api/hotzones', undefined, fx.hotzones);
}

/**
 * Operator-triggered Browserbase scrape. Returns null on failure rather than a
 * fixture: the whole point of the button is that the user watches the scrape
 * actually run, so a fake success would be worse than a visible error. Longer
 * timeout than `call()` — a real Stagehand session takes tens of seconds.
 *
 * Deliberately ignores the global offline latch: a button press is a discrete
 * user action and the honest answer to "scrape now" while latched is to try —
 * and a success is the strongest possible evidence the backend is back, so it
 * clears the latch and lets the rest of the app go live again.
 */
export async function scrapeHotzones(): Promise<HotzoneResponse | null> {
  if (FIXTURES_ONLY) return null; // explicitly pinned to fixtures — never network
  try {
    const res = await fetch(`${BASE}/api/hotzones/scrape`, {
      method: 'POST',
      signal: AbortSignal.timeout(60000),
    });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    offline = false;
    return (await res.json()) as HotzoneResponse;
  } catch (err) {
    console.warn('[jenga] hotzone scrape did not complete.', err);
    return null;
  }
}

/* ---------------------------------------------------------------------------
 * Curing telemetry
 *
 * Neither of these two goes through `call()`, and for one shared reason:
 * `call()` latches the global `offline` flag on its first failure, which sends
 * every later call — including the verification the whole pitch turns on — to
 * the canned fixtures. That is an acceptable trade for most one-shot actions,
 * because a user who just watched something fail expects the app to be degraded.
 * It is the wrong trade for both of these.
 *
 * For `fetchSensors` the reason is frequency: it fires every two seconds, so
 * one slow response out of hundreds would silently retire the live backend for
 * the rest of the session.
 *
 * For `setSensorScenario` the reason is worse, and is why it was moved off
 * `call()` in review. It is the *first click of the demo*. If the POST times
 * out at four seconds against a backend that is merely slow rather than dead,
 * `call()` would mark the session offline; the header's OFFLINE badge would not
 * appear, because `useJenga.offline` is only re-read inside `load()`; and the
 * report submitted thirty seconds later would come back as the canned fixture
 * verdict — **APPROVED** for SUB-01. The beat would fail as a confident wrong
 * answer rather than as a visible error, which is the one failure mode this
 * panel exists to argue against.
 * ------------------------------------------------------------------------- */

/** One warning for a dead sensor stream, not one every two seconds. */
let sensorsWarned = false;
/** Skip the network until this timestamp after a failure. See `fetchSensors`. */
let sensorsRetryAt = 0;
const SENSOR_BACKOFF_MS = 10000;

/**
 * Curing telemetry for one ticket.
 *
 * How it degrades, in order: it honours the global offline flag and never
 * touches the network once the app already knows it is offline; a failure logs
 * one warning for the whole session and returns an empty payload, so nothing
 * rejects and the strip simply empties; and a failure backs the poll off for
 * ten seconds, so a dead backend costs one refused request every ten seconds
 * rather than one every two, while still recovering on its own if the backend
 * comes back mid-demo.
 */
export async function fetchSensors(ticketId: string): Promise<SensorPayload> {
  if (offline || Date.now() < sensorsRetryAt) return fx.sensors();
  try {
    const res = await fetch(`${BASE}/api/sensors/${ticketId}`, {
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    sensorsRetryAt = 0;
    return (await res.json()) as SensorPayload;
  } catch (err) {
    sensorsRetryAt = Date.now() + SENSOR_BACKOFF_MS;
    if (!sensorsWarned) {
      sensorsWarned = true;
      console.warn('[jenga] sensor telemetry unavailable; strip will stay empty.', err);
    }
    return fx.sensors();
  }
}

/**
 * Demo control: drop a ticket into a cold snap, or bring it back.
 *
 * `null` means the regime did not change and we do not know what it still is —
 * the honest encoding, since a failed POST tells us nothing about the ticket's
 * current scenario. It is not an error the caller has to catch: the strip keeps
 * polling the live backend and simply stays warm, which is a visibly failed
 * button rather than a silently downgraded app.
 */
export async function setSensorScenario(
  ticketId: string,
  mode: SensorMode,
): Promise<SensorScenario | null> {
  if (offline) return null;
  try {
    const res = await fetch(`${BASE}/api/sensors/scenario/${ticketId}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode }),
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return (await res.json()) as SensorScenario;
  } catch (err) {
    // Every click warns, unlike the once-per-session poll warning: this is a
    // discrete user action and the presenter needs to know it did not land.
    console.warn(`[jenga] could not set the ${mode} scenario on ${ticketId}.`, err);
    return null;
  }
}

export function dispute(
  taskId: string,
  delayDays: number,
  reason: string,
  tasks: Task[],
): Promise<DisputeResponse> {
  return call<DisputeResponse>(
    `/api/tasks/${taskId}/dispute`,
    {
      method: 'POST',
      body: JSON.stringify({ delay_days: delayDays, reason }),
    },
    () => fx.dispute(tasks, taskId, delayDays),
  );
}

// ---------------------------------------------------------------------------
// Document upload
//
// These deliberately bypass `call()`: it forces `content-type: application/json`,
// and setting any content-type on a multipart request stops the browser emitting
// the boundary, so FastAPI rejects the body.
// ---------------------------------------------------------------------------

export interface ParsedDoc {
  filename: string;
  kind: string;
  char_count: number;
  text: string;
  preview: string;
  /** Preview URL for the uploaded file's original bytes. */
  media_url: string | null;
}

export interface ProposedTask {
  name: string;
  zone: string;
  duration_days: number;
  spec_text: string;
  depends_on: string[];
}

export interface ExtractedTasks {
  filename: string;
  tasks: ProposedTask[];
  source: 'llm' | 'offline' | 'rejected';
  notes: string;
}

async function upload<T>(path: string, file: File): Promise<T> {
  const body = new FormData();
  body.append('file', file);
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    body,
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(detail || `${res.status} ${res.statusText}`);
  }
  return (await res.json()) as T;
}

/** One step of the procurement agent's trace. Same shape as a verdict step. */
export interface AgentStep {
  node: string;
  title: string;
  detail: string;
  signal: 'ok' | 'warn' | 'bad' | 'info';
}

export interface AgentProcurementResult {
  ok: boolean;
  /** True only when a real purchase order now exists on Zip staging. */
  live: boolean;
  po_id: string | null;
  po_number: string | null;
  vendor: string | null;
  detail: string;
  steps: AgentStep[];
  purchase_order: PurchaseOrder | null;
}

/**
 * Ask the procurement agent to buy for a set of extracted work packages.
 *
 * Returns null on any failure rather than a fixture: like the PO actions above,
 * this is a discrete user action that creates something real (a Zip staging
 * purchase order), and a fake success would be the confident-wrong-answer
 * failure JENGA argues against. Longer timeout — the agent makes several Zip
 * calls (and possibly an LLM call) before it answers.
 */
export async function createProcurementViaAgent(
  packages: ProposedTask[],
  filename?: string,
): Promise<AgentProcurementResult | null> {
  if (offline) return null;
  try {
    const res = await fetch(`${BASE}/api/procurement/agent-create`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ packages, filename: filename ?? null }),
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return (await res.json()) as AgentProcurementResult;
  } catch (err) {
    console.warn('[jenga] agent procurement did not land.', err);
    return null;
  }
}

/** Extract raw text from an uploaded PDF / txt / md. */
export function parseDocument(file: File): Promise<ParsedDoc> {
  return upload<ParsedDoc>('/api/documents/parse', file);
}

/**
 * Upload + analyze a video ahead of `/verify`. Gemini's Files API round trip
 * runs 20-90s, well past `upload()`'s 30s default, so this gets its own
 * longer timeout rather than sharing that helper.
 */
export async function uploadVideoEvidence(
  taskId: string,
  file: File,
  reportText: string | null,
): Promise<VideoEvidenceResponse> {
  const body = new FormData();
  body.append('file', file);
  if (reportText) body.append('report_text', reportText);
  const res = await fetch(`${BASE}/api/tasks/${encodeURIComponent(taskId)}/video-evidence`, {
    method: 'POST',
    body,
    signal: AbortSignal.timeout(90000),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(detail || `${res.status} ${res.statusText}`);
  }
  return (await res.json()) as VideoEvidenceResponse;
}

/** Propose work packages from an uploaded spec or blueprint. Does not mutate the graph. */
export function extractTasks(file: File): Promise<ExtractedTasks> {
  return upload<ExtractedTasks>('/api/documents/extract-tasks', file);
}

/* --- contractor portal ---------------------------------------------------- */

/**
 * The backend's own reason (a 409 for a blocked task, a 422 for a missing note)
 * has to reach the person who caused it, so the mutations below do not go
 * through `call()`: it would swallow that error and answer from fixtures, and
 * would latch the whole session offline over what was a correct refusal.
 * Only an unreachable backend degrades to the local mirror.
 */
async function mutate<T>(path: string, body: unknown, fallback: () => T): Promise<T> {
  if (offline) return fallback();
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
  } catch (err) {
    console.warn(`[jenga] ${path} unreachable, using fixtures.`, err);
    offline = true;
    return fallback();
  }
  if (!res.ok) {
    const detail = await res.json().then((j) => j?.detail, () => null);
    throw new Error(typeof detail === 'string' ? detail : `${res.status} ${res.statusText}`);
  }
  return (await res.json()) as T;
}

export function fetchPortal(params: { companyId?: string; ownerId?: string }): Promise<PortalOverview> {
  const q = new URLSearchParams();
  if (params.companyId) q.set('company_id', params.companyId);
  if (params.ownerId) q.set('owner_id', params.ownerId);
  return call(`/api/portal?${q}`, undefined, () => local.overview(params));
}

export function fetchReports(projectId: string, view: 'owner' | 'contractor'): Promise<Report[]> {
  return call(
    `/api/projects/${encodeURIComponent(projectId)}/reports?view=${view}`,
    undefined,
    () => local.projectReports(projectId, view),
  );
}

export function fetchQueue(ownerId: string): Promise<QueueItem[]> {
  return call(`/api/portal/owners/${encodeURIComponent(ownerId)}/queue`, undefined, () =>
    local.queue(ownerId),
  );
}

/** Evidence beyond the required text+image, kept out of `submitReport`'s positional
 * args since most submissions carry none of it. */
export interface UpdateExtras {
  videoFinding?: Record<string, unknown> | null;
  mediaUrl?: string | null;
  /** MIME type of `imageBase64`, so the backend persists it with the right extension. */
  imageMime?: string | null;
  /** Preview URL + filename for an uploaded report document, from `parseDocument`. */
  reportUrl?: string | null;
  reportFilename?: string | null;
}

/** A contractor's progress update. The AI verdict comes back to the owner, not to them. */
export async function submitReport(
  projectId: string,
  taskId: string,
  reportText: string,
  imageBase64: string | null,
  tasks: Task[],
  strict = true,
  extra: UpdateExtras = {},
): Promise<void> {
  await mutate(
    `/api/tasks/${encodeURIComponent(taskId)}/verify?strict=${strict}`,
    {
      report_text: reportText,
      image_base64: imageBase64,
      image_mime: extra.imageMime ?? null,
      video_finding: extra.videoFinding ?? null,
      media_url: extra.mediaUrl ?? null,
      report_url: extra.reportUrl ?? null,
      report_filename: extra.reportFilename ?? null,
    },
    () => {
      local.submit(projectId, taskId, reportText, fx.verdictForTask(taskId, tasks, strict));
      return null;
    },
  );
}

export function decideReport(
  reportId: string,
  decision: 'approve' | 'deny',
  note: string,
): Promise<DecisionResponse> {
  return mutate<DecisionResponse>(`/api/reports/${reportId}/decision`, { decision, note }, () =>
    local.decide(reportId, decision, note),
  );
}
