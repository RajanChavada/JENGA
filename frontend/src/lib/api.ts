import * as fx from './fixtures';
import type {
  DisputeResponse,
  GraphResponse,
  HotzoneResponse,
  PurchaseOrder,
  SensorMode,
  SensorPayload,
  SensorScenario,
  Task,
  Verdict,
} from './types';

const BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8000';
const FIXTURES_ONLY = process.env.NEXT_PUBLIC_USE_FIXTURES === '1';

/** True once a live call has failed, so we stop hammering a dead backend. */
let offline = FIXTURES_ONLY;

export function isOffline() {
  return offline;
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

export function fetchGraph(): Promise<GraphResponse> {
  return call('/api/graph', undefined, fx.graph);
}

export function fetchPurchaseOrders(): Promise<PurchaseOrder[]> {
  return call('/api/purchase-orders', undefined, fx.purchaseOrders);
}

export function fetchHotzones(): Promise<HotzoneResponse> {
  return call('/api/hotzones', undefined, fx.hotzones);
}

export function verify(
  taskId: string,
  submissionId: string,
  tasks: Task[],
  strict = true,
): Promise<Verdict> {
  const sub = fx.SUBMISSIONS.find((s) => s.id === submissionId)!;
  return call<Verdict>(
    `/api/tasks/${taskId}/verify?strict=${strict}`,
    {
      method: 'POST',
      body: JSON.stringify({
        report_text: sub.report_text,
        image_base64: sub.image,
        transcript: sub.transcript,
      }),
    },
    () => fx.verdictFor(submissionId, tasks, strict),
  );
}

/** One warning for a dead sensor stream, not one every two seconds. */
let sensorsWarned = false;
/** Skip the network until this timestamp after a failure. See `fetchSensors`. */
let sensorsRetryAt = 0;
const SENSOR_BACKOFF_MS = 10000;

/**
 * Curing telemetry for one ticket. Deliberately does **not** go through
 * `call()`.
 *
 * `call()` latches the global offline flag on its first failure, which is the
 * right trade for a one-shot user action and the wrong one for something that
 * fires every two seconds: a single timed-out poll would put the rest of the
 * session on fixtures, including the live verification the demo turns on. So a
 * poll degrades on its own instead.
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

/** Demo control: drop a ticket into a cold snap, or bring it back. */
export function setSensorScenario(
  ticketId: string,
  mode: SensorMode,
): Promise<SensorScenario> {
  return call<SensorScenario>(
    `/api/sensors/scenario/${ticketId}`,
    { method: 'POST', body: JSON.stringify({ mode }) },
    () => ({ ticket_id: ticketId, mode }),
  );
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
  source: 'llm' | 'offline';
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

/** Extract raw text from an uploaded PDF / txt / md. */
export function parseDocument(file: File): Promise<ParsedDoc> {
  return upload<ParsedDoc>('/api/documents/parse', file);
}

/** Propose work packages from an uploaded spec or blueprint. Does not mutate the graph. */
export function extractTasks(file: File): Promise<ExtractedTasks> {
  return upload<ExtractedTasks>('/api/documents/extract-tasks', file);
}

/** Verify a task against text pulled out of an uploaded document. */
export function verifyWithText(
  taskId: string,
  reportText: string,
  tasks: Task[],
  strict = true,
) {
  return call<Verdict>(
    `/api/tasks/${taskId}/verify?strict=${strict}`,
    { method: 'POST', body: JSON.stringify({ report_text: reportText }) },
    () => fx.verdictForTask(taskId, tasks, strict),
  );
}
