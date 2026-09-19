'use client';

import { create } from 'zustand';
import * as api from '@/lib/api';
import * as fx from '@/lib/fixtures';
import type {
  AttributionEntry,
  GraphEdge,
  HotzoneResponse,
  PurchaseOrder,
  SensorPayload,
  Task,
  TaskState,
  Verdict,
  Zone,
} from '@/lib/types';

/** Milliseconds of delay per topological rank during the cascade. */
export const CASCADE_STEP_MS = 120;

/** The one site JENGA ships onboarded. Mirrors `db.DEFAULT_PROJECT_ID`. */
export const DEFAULT_PROJECT_ID = 'eglinton-west-station';
const DEFAULT_SITE_NAME = 'Eglinton West Station';

export type ViewMode = 'blueprint' | 'logical';

/** Toronto-wide hotzone map, or one site's dependency graph. */
export type SiteView = 'macro' | 'micro';

/** Within a site: the work surface, or the procurement/ledger surface. */
export type MicroTab = 'site' | 'procurement';

/** One entry per state transition a task went through. Append-only. */
export interface StageEvent {
  state: TaskState;
  at: number;
}

/** Which integration or agent produced an activity entry. Drives the icon. */
export type AgentSource = 'browserbase' | 'tiger' | 'agent' | 'documents' | 'zip';

/**
 * One agentic operation, as the activity rail shows it. Entries are created
 * `running` and resolved in place, so the rail reads as live confirmations of
 * what the system actually did — not a decorative animation.
 */
export interface AgentEvent {
  id: string;
  ts: number;
  source: AgentSource;
  title: string;
  detail?: string;
  status: 'running' | 'ok' | 'warn' | 'error';
}

let _eventSeq = 0;

/** Where every task sat on the schedule at load. Slip = distance from this. */
export type Baseline = Record<string, { es: number; ef: number }>;

/**
 * Only a task whose state differs from its last logged entry gets a new one, so
 * this is safe to call on every task write and never rewrites what is already
 * recorded. Returns the same object when nothing moved, keeping renders cheap.
 */
function recordStages(
  history: Record<string, StageEvent[]>,
  tasks: Task[],
): Record<string, StageEvent[]> {
  const at = Date.now();
  let next = history;
  for (const t of tasks) {
    const log = history[t.id];
    if (log && log[log.length - 1].state === t.state) continue;
    if (next === history) next = { ...history };
    next[t.id] = [...(log ?? []), { state: t.state, at }];
  }
  return next;
}

/** How a landed verdict resolves its pipeline activity entry. */
function verdictEvent(v: Verdict): Partial<Omit<AgentEvent, 'id' | 'ts'>> {
  const gz = `${Math.round(v.gptzero.ai_probability * 100)}% AI-authorship`;
  const vis =
    v.vision.matches_claim === null
      ? 'vision cannot establish'
      : v.vision.matches_claim
        ? 'vision consistent'
        : 'vision contradicts';
  return {
    status: v.status === 'APPROVED' ? 'ok' : v.status === 'DISPUTED' ? 'error' : 'warn',
    title: `Verdict on ${v.task_id}: ${v.status.replace('_', ' ')}`,
    detail: `${gz} · ${vis} · confidence ${v.confidence.toFixed(2)}`,
  };
}

interface JengaState {
  /**
   * The project whose graph is on screen, or null for a hotzone JENGA has no
   * site behind yet — the state the blueprint-onboarding pitch renders from.
   */
  activeProjectId: string | null;
  /** Display name of that site, straight off the hotzone. Drives the header. */
  activeSiteName: string;
  view: SiteView;
  /** Which micro surface is on screen: the work graph, or procurement. */
  microTab: MicroTab;

  tasks: Task[];
  edges: GraphEdge[];
  criticalPath: string[];
  projectDuration: number;
  baselineDuration: number | null;
  baseline: Baseline;
  stageHistory: Record<string, StageEvent[]>;

  mode: ViewMode;
  selectedTaskId: string | null;
  selectedZone: Zone | null;
  /** Hard-gate AI-written reports (ours) vs. record the score and move on (main's). */
  strict: boolean;

  verdict: Verdict | null;
  attributions: AttributionEntry[];
  purchaseOrders: PurchaseOrder[];
  hotzones: HotzoneResponse | null;
  /** True while an operator-triggered Browserbase scrape is running. */
  scrapingHotzones: boolean;
  /** Set when the last scrape press could not reach the backend at all. */
  scrapeError: string | null;

  /** Live log of agentic operations, newest first. Survives site switches. */
  activity: AgentEvent[];
  /** Whether the activity rail is open. */
  activityOpen: boolean;
  sideEffect: string | null;
  /** Curing telemetry, keyed by ticket. Written by the poll in <SensorStrip>. */
  sensors: Record<string, SensorPayload>;

  loading: boolean;
  busy: boolean;
  cascading: boolean;
  offline: boolean;

  load: (projectId?: string) => Promise<void>;
  loadSite: (hotzoneId: string) => Promise<void>;
  /** Press-to-scrape: run Browserbase now and put the result on the map. */
  scrapeHotzones: () => Promise<void>;
  loadSample: () => Promise<void>;
  reset: () => Promise<void>;
  setView: (v: SiteView) => void;
  setMicroTab: (t: MicroTab) => void;
  setMode: (m: ViewMode) => void;
  setStrict: (v: boolean) => void;
  selectTask: (id: string | null) => void;
  selectZone: (z: Zone | null) => void;
  clearVerdict: () => void;
  loadSensors: (id: string) => Promise<void>;
  submit: (submissionId: string) => Promise<void>;
  submitText: (taskId: string, text: string, filename: string) => Promise<void>;
  runDispute: (taskId: string, delayDays: number, reason: string) => Promise<void>;
  /** Procurement actions on a PO. Each hits the backend and mirrors the result. */
  expeditePO: (poId: string) => Promise<void>;
  markPoReceived: (poId: string) => Promise<void>;
  linkPoToTask: (poId: string, taskId: string) => Promise<void>;

  /** Append an activity entry; returns its id so the caller can resolve it. */
  logActivity: (e: Omit<AgentEvent, 'id' | 'ts'>) => string;
  /** Resolve or amend an activity entry in place. */
  updateActivity: (id: string, patch: Partial<Omit<AgentEvent, 'id' | 'ts'>>) => void;
  setActivityOpen: (open: boolean) => void;
}

/**
 * Every slice of the store that belongs to one site, at its empty value.
 *
 * A site switch writes all of it in a single `set`, because each field is a
 * claim about the project that was on screen: a verdict, a selection, a
 * sparkline or a purchase order from Eglinton West says nothing true about
 * Dufferin, and a panel left floating over the wrong site reads as a bug.
 * `hotzones`, `mode` and `strict` are deliberately absent — the map is
 * Toronto-wide and the other two are the operator's preferences, not the
 * site's.
 */
const EMPTY_SITE = {
  microTab: 'site' as MicroTab,
  tasks: [],
  edges: [],
  criticalPath: [],
  projectDuration: 0,
  baselineDuration: null,
  baseline: {},
  stageHistory: {},
  selectedTaskId: null,
  selectedZone: null,
  verdict: null,
  sideEffect: null,
  attributions: [],
  purchaseOrders: [],
  sensors: {},
  busy: false,
  cascading: false,
} satisfies Partial<JengaState>;

export const useJenga = create<JengaState>((set, get) => ({
  ...EMPTY_SITE,

  activeProjectId: DEFAULT_PROJECT_ID,
  activeSiteName: DEFAULT_SITE_NAME,
  view: 'micro',

  mode: 'blueprint',
  strict: true,

  hotzones: null,
  scrapingHotzones: false,
  scrapeError: null,

  activity: [],
  activityOpen: false,

  loading: true,
  offline: false,

  async load(projectId) {
    const target = projectId ?? get().activeProjectId ?? DEFAULT_PROJECT_ID;
    set({ loading: true, activeProjectId: target });
    const [g, pos, hotzones] = await Promise.all([
      api.fetchGraph(target),
      api.fetchPurchaseOrders(),
      api.fetchHotzones(),
    ]);
    // Two sites clicked in quick succession: the slower response is the older
    // site's, and must not land on top of the newer one.
    if (get().activeProjectId !== target) return;
    set({
      tasks: g.tasks,
      edges: g.edges,
      criticalPath: g.critical_path,
      projectDuration: g.project_duration,
      baselineDuration: g.project_duration,
      // Snapshotted next to baselineDuration and for the same reason: the
      // timeline draws where each task *was* behind where it is now.
      baseline: Object.fromEntries(g.tasks.map((t) => [t.id, { es: t.es, ef: t.ef }])),
      stageHistory: recordStages({}, g.tasks),
      purchaseOrders: pos,
      hotzones,
      loading: false,
      offline: api.isOffline(),
    });
  },

  /**
   * The scrape is a discrete user action with a visible outcome: the button
   * spins while Browserbase runs, and the result — live zones or the seed with
   * an honest note about why — replaces the panel when it lands. A null return
   * (backend down) keeps the old data on screen; nothing is faked.
   */
  async scrapeHotzones() {
    set({ scrapingHotzones: true, scrapeError: null });
    const ev = get().logActivity({
      source: 'browserbase',
      status: 'running',
      title: 'Scraping municipal construction feeds',
      detail: 'toronto.ca road restrictions · metrolinx.com Eglinton Crosstown West',
    });
    const result = await api.scrapeHotzones();
    set((s) => ({
      scrapingHotzones: false,
      hotzones: result ?? s.hotzones,
      // A null result means the request never completed — backend down or
      // timed out — which is a different fact from "ran and fell back to the
      // seed", and the panel must not report one as the other.
      scrapeError: result
        ? null
        : 'Scrape did not reach the backend — is it running on :8000?',
      offline: api.isOffline(),
    }));
    get().updateActivity(
      ev,
      !result
        ? { status: 'error', title: 'Scrape did not reach the backend' }
        : result.source === 'browserbase'
          ? {
              status: 'ok',
              title: `Live scrape complete — ${result.hotzones.length} zones`,
              detail: result.notes,
            }
          : {
              status: 'warn',
              title: 'Scrape ran, fell back to seeded zones',
              detail: result.notes,
            },
    );
  },

  /**
   * Drill from a map pin into that site. The hotzone carries the project id, so
   * this is the only place that decides which of the two micro-views the map
   * opens: the dependency graph, or the pitch for onboarding a site we have no
   * blueprint for yet.
   */
  async loadSite(hotzoneId) {
    const hotzone = get().hotzones?.hotzones.find((h) => h.id === hotzoneId);
    if (!hotzone) return;
    const projectId = hotzone.linked_site_id;

    // One write: the old site's state goes and the new site's identity arrives
    // together, so no render sees Eglinton West's verdict over Dufferin's name.
    // `loading` is true only when a graph is actually coming, otherwise the
    // empty state would flicker in for a frame before the fetch resolved.
    set({
      ...EMPTY_SITE,
      view: 'micro',
      activeProjectId: projectId,
      activeSiteName: hotzone.name,
      loading: projectId !== null,
    });

    if (projectId) await get().load(projectId);
  },

  /**
   * Instant value from a not-onboarded pin: drop the empty state and load the
   * one fully-onboarded site JENGA ships, so a first-time visitor sees the graph
   * working before they have any drawings of their own.
   */
  async loadSample() {
    set({
      ...EMPTY_SITE,
      view: 'micro',
      activeProjectId: DEFAULT_PROJECT_ID,
      activeSiteName: DEFAULT_SITE_NAME,
      loading: true,
    });
    await get().load(DEFAULT_PROJECT_ID);
  },

  async reset() {
    set({
      verdict: null,
      attributions: [],
      sideEffect: null,
      selectedTaskId: null,
      sensors: {},
    });
    // Nothing to re-seed on a site with no project: reloading here would pull
    // the default project's graph onto a pin that has no site behind it.
    if (get().activeProjectId === null) return;
    await get().load();
  },

  logActivity(e) {
    const id = `EV-${++_eventSeq}`;
    set((s) => ({
      // Newest first, capped so a long demo session cannot grow unbounded.
      activity: [{ ...e, id, ts: Date.now() }, ...s.activity].slice(0, 40),
    }));
    return id;
  },

  updateActivity(id, patch) {
    set((s) => ({
      activity: s.activity.map((ev) => (ev.id === id ? { ...ev, ...patch } : ev)),
    }));
  },

  setActivityOpen: (activityOpen) => set({ activityOpen }),

  setView: (view) => set({ view }),
  setMicroTab: (microTab) => set({ microTab }),
  setMode: (mode) => set({ mode }),
  setStrict: (strict) => set({ strict }),
  selectTask: (selectedTaskId) => set({ selectedTaskId }),
  selectZone: (selectedZone) => set({ selectedZone }),
  clearVerdict: () => set({ verdict: null, sideEffect: null }),

  /**
   * One poll's worth of telemetry. Merged per ticket rather than replacing the
   * map, so switching selection back and forth keeps the previous sparkline on
   * screen instead of blanking it for one tick.
   */
  async loadSensors(id) {
    const payload = await api.fetchSensors(id);
    // A poll in flight when the site changed belongs to the old project. The
    // strip is already unmounted by then, but writing the reading back would
    // put the ticket straight into the map the switch just cleared.
    if (!get().tasks.some((t) => t.id === id)) return;
    set((s) => ({ sensors: { ...s.sensors, [id]: payload } }));
  },

  async submit(submissionId) {
    const sub = fx.SUBMISSIONS.find((s) => s.id === submissionId);
    if (!sub) return;
    const site = get().activeProjectId;
    set({ busy: true, verdict: null, sideEffect: null });
    const ev = get().logActivity({
      source: 'agent',
      status: 'running',
      title: `Verifying ${sub.task_id} — 5-node pipeline`,
      detail: 'GPTZero authorship → vision → historical memory → telemetry → arbiter',
    });

    const verdict = await api.verify(sub.task_id, submissionId, get().tasks, get().strict);
    get().updateActivity(ev, verdictEvent(verdict));
    // Verification takes seconds; the presenter can be on another site by the
    // time it answers. That verdict is about the site it was submitted from.
    // The switch already cleared `busy`, so there is nothing to unwind.
    if (get().activeProjectId !== site) return;
    const nextState = fx.stateForVerdict(verdict.status);

    set((s) => {
      const tasks = s.tasks.map((t) =>
        t.id === sub.task_id ? { ...t, state: nextState } : t,
      );
      return {
        verdict,
        busy: false,
        sideEffect: fx.sideEffectFor(submissionId),
        selectedTaskId: sub.task_id,
        offline: api.isOffline(),
        tasks,
        stageHistory: recordStages(s.stageHistory, tasks),
      };
    });

    // A shortage in the report reschedules its linked PO. Mirrors the backend's
    // Zip mock so the panel is right whether we are live or on fixtures.
    const zip = fx.zipActionFor(submissionId);
    if (zip) {
      get().logActivity({
        source: 'zip',
        status: 'ok',
        title: `Shortage detected — ${zip.po_id} expedited`,
        detail: zip.reason,
      });
      set((s) => ({
        purchaseOrders: s.purchaseOrders.map((po) =>
          po.id === zip.po_id
            ? {
                ...po,
                status: 'rescheduled',
                delivery_date: zip.new_delivery_date,
                last_action: zip.reason,
              }
            : po,
        ),
      }));
    }
  },

  /**
   * Same verification path as `submit`, but the claim text came from a document
   * the user uploaded rather than one of the canned submissions. No side-effect
   * lookup: there is no fixture entry to read procurement fallout from.
   */
  async submitText(taskId, text, filename) {
    const site = get().activeProjectId;
    set({ busy: true, verdict: null, sideEffect: null });
    const ev = get().logActivity({
      source: 'agent',
      status: 'running',
      title: `Verifying ${taskId} from ${filename}`,
      detail: 'GPTZero authorship → vision → historical memory → telemetry → arbiter',
    });

    const verdict = await api.verifyWithText(taskId, text, get().tasks, get().strict);
    get().updateActivity(ev, verdictEvent(verdict));
    if (get().activeProjectId !== site) return; // see `submit`
    const nextState = fx.stateForVerdict(verdict.status);

    set((s) => {
      const tasks = s.tasks.map((t) =>
        t.id === taskId ? { ...t, state: nextState } : t,
      );
      return {
        verdict: {
          ...verdict,
          evidence: { ...verdict.evidence, claim: `${filename} — ${verdict.evidence.claim}` },
        },
        busy: false,
        selectedTaskId: taskId,
        offline: api.isOffline(),
        tasks,
        stageHistory: recordStages(s.stageHistory, tasks),
      };
    });
  },

  async runDispute(taskId, delayDays, reason) {
    const site = get().activeProjectId;
    set({ busy: true, cascading: true });
    const ev = get().logActivity({
      source: 'agent',
      status: 'running',
      title: `Propagating +${delayDays}d slip from ${taskId}`,
      detail: 'Recomputing CPM float and cascading downstream…',
    });
    const res = await api.dispute(taskId, delayDays, reason, get().tasks);
    get().updateActivity(ev, {
      status: 'ok',
      title: `Slip recorded — ${res.attribution.downstream_affected.length} downstream tasks moved`,
      detail: `Project slipped +${res.project_slipped_days}d · attribution written to the ledger.`,
    });
    if (get().activeProjectId !== site) return; // see `submit`

    // The cascade is the demo's money shot: rather than swapping the whole graph
    // at once, walk it rank by rank so the delay is visibly seen propagating
    // along dependencies. Ordering is by the `depth` the API hands us.
    const affected = new Set(res.attribution.downstream_affected);
    const byDepth = new Map<number, Task[]>();
    for (const t of res.tasks) {
      if (t.id !== taskId && !affected.has(t.id)) continue;
      const list = byDepth.get(t.depth) ?? [];
      list.push(t);
      byDepth.set(t.depth, list);
    }
    const ranks = [...byDepth.keys()].sort((a, b) => a - b);

    // Everything that did not move updates immediately (float/critical changes).
    set((s) => {
      const tasks = s.tasks.map((t) => {
        if (t.id === taskId || affected.has(t.id)) return t;
        return res.tasks.find((n) => n.id === t.id) ?? t;
      });
      return {
        tasks,
        criticalPath: res.critical_path,
        stageHistory: recordStages(s.stageHistory, tasks),
      };
    });

    ranks.forEach((rank, i) => {
      setTimeout(() => {
        // The cascade animates over the next second or so; a site switch part
        // way through must stop it rather than write the old graph's ranks —
        // and its attribution entry — into the new site.
        if (get().activeProjectId !== site) return;
        const moved = byDepth.get(rank)!;
        set((s) => {
          const tasks = s.tasks.map((t) => {
            const hit = moved.find((m) => m.id === t.id);
            if (!hit) return t;
            const state: TaskState = hit.id === taskId ? 'disputed' : 'under_review';
            return { ...hit, state };
          });
          return { tasks, stageHistory: recordStages(s.stageHistory, tasks) };
        });
        if (i === ranks.length - 1) {
          set({
            projectDuration: res.tasks.reduce((m, t) => Math.max(m, t.ef), 0),
            attributions: [res.attribution, ...get().attributions],
            busy: false,
            cascading: false,
            offline: api.isOffline(),
          });
        }
      }, i * CASCADE_STEP_MS);
    });

    if (ranks.length === 0) set({ busy: false, cascading: false });
  },

  /**
   * Procurement actions. Each posts to the backend and writes the returned PO
   * back into the ledger; a null return (backend down / rejected) leaves the PO
   * as-is rather than faking success, matching `actOnPurchaseOrder`'s contract.
   */
  async expeditePO(poId) {
    const site = get().activeProjectId;
    const ev = get().logActivity({
      source: 'zip',
      status: 'running',
      title: `Expediting ${poId} via Zip`,
    });
    const updated = await api.actOnPurchaseOrder(poId, 'expedite');
    get().updateActivity(
      ev,
      updated
        ? {
            status: 'ok',
            title: `${poId} expedited → ${updated.delivery_date}`,
            detail: updated.last_action ?? undefined,
          }
        : { status: 'error', title: `Expedite of ${poId} did not land` },
    );
    if (!updated || get().activeProjectId !== site) return;
    set((s) => ({
      purchaseOrders: s.purchaseOrders.map((po) => (po.id === poId ? updated : po)),
    }));
  },

  async markPoReceived(poId) {
    const site = get().activeProjectId;
    const updated = await api.actOnPurchaseOrder(poId, 'receive');
    get().logActivity(
      updated
        ? { source: 'zip', status: 'ok', title: `${poId} marked received on site` }
        : { source: 'zip', status: 'error', title: `Receive of ${poId} did not land` },
    );
    if (!updated || get().activeProjectId !== site) return;
    set((s) => ({
      purchaseOrders: s.purchaseOrders.map((po) => (po.id === poId ? updated : po)),
    }));
  },

  async linkPoToTask(poId, taskId) {
    const site = get().activeProjectId;
    const updated = await api.actOnPurchaseOrder(poId, 'link', taskId);
    get().logActivity(
      updated
        ? { source: 'zip', status: 'ok', title: `${poId} linked to ${taskId}` }
        : { source: 'zip', status: 'error', title: `Link of ${poId} did not land` },
    );
    if (!updated || get().activeProjectId !== site) return;
    set((s) => ({
      purchaseOrders: s.purchaseOrders.map((po) => (po.id === poId ? updated : po)),
    }));
  },
}));
