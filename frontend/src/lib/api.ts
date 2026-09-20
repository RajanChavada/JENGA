import * as fx from './fixtures';
import type {
  DisputeResponse,
  Escalation,
  GraphResponse,
  HotzoneResponse,
  PurchaseOrder,
  RouteCheckResponse,
  ScheduleAnalytics,
  SpendAnalytics,
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

/**
 * One site's graph. The fixture fallback is the default project's, which is the
 * only one it has — an offline drill-down into another site would show Eglinton
 * West's work packages under its name, so callers past the default should treat
 * the offline path as unsupported rather than trusted.
 */
export function fetchGraph(projectId?: string): Promise<GraphResponse> {
  const q = projectId ? `?project_id=${encodeURIComponent(projectId)}` : '';
  return call(`/api/graph${q}`, undefined, fx.graph);
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

/**
 * Supply-line radar pass. Same honesty contract as the scrape: a discrete user
 * action that bypasses the offline latch, returns null when the backend never
 * answered (nothing is faked from fixtures), and clears the latch on success.
 * Generous timeout — the pass fans out to 511, OSRM per vendor, and Zip.
 */
export async function checkRoutes(): Promise<RouteCheckResponse | null> {
  if (FIXTURES_ONLY) return null;
  try {
    const res = await fetch(`${BASE}/api/routes/check`, {
      method: 'POST',
      signal: AbortSignal.timeout(60000),
    });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    offline = false;
    return (await res.json()) as RouteCheckResponse;
  } catch (err) {
    console.warn('[jenga] route check did not complete.', err);
    return null;
  }
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

/* ---------------------------------------------------------------------------
 * Site analytics — the earned-schedule S-curve and spend velocity off the
 * Tiger Data event stream. Deliberately not through `call()`: analytics are
 * decoration around the schedule, and one slow response must not latch the
 * whole session onto fixtures. A failure returns null and the band simply
 * keeps its last data (or stays empty), recovering on the next refresh.
 * ------------------------------------------------------------------------- */

/** One warning for a dead analytics path, not one per refresh. */
let analyticsWarned = false;

async function fetchAnalytics<T>(path: string): Promise<T | null> {
  if (offline) return null;
  try {
    const res = await fetch(`${BASE}${path}`, { signal: AbortSignal.timeout(6000) });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return (await res.json()) as T;
  } catch (err) {
    if (!analyticsWarned) {
      analyticsWarned = true;
      console.warn('[jenga] site analytics unavailable; the band will stay empty.', err);
    }
    return null;
  }
}

export function fetchScheduleAnalytics(): Promise<ScheduleAnalytics | null> {
  return fetchAnalytics<ScheduleAnalytics>('/api/analytics/schedule');
}

export function fetchSpendAnalytics(): Promise<SpendAnalytics | null> {
  return fetchAnalytics<SpendAnalytics>('/api/analytics/spend');
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
  /** Estimated committed dollars — what landed in the spend event stream. */
  amount: number;
  steps: AgentStep[];
  purchase_order: PurchaseOrder | null;
  /** Set when this creation tipped cumulative spend over the governance line. */
  escalation: Escalation | null;
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
