'use client';

import { create } from 'zustand';
import * as api from '@/lib/api';
import type {
  AttributionEntry,
  GraphEdge,
  HotzoneResponse,
  PortalOverview,
  PortalProject,
  PurchaseOrder,
  QueueItem,
  Report,
  Role,
  RouteCheckResponse,
  ScheduleAnalytics,
  SensorPayload,
  SpendAnalytics,
  Task,
  TaskState,
  Zone,
} from '@/lib/types';
import type { FocusOrigin } from '@/lib/focus';
import { displayId } from '@/lib/format';

/** Milliseconds of delay per topological rank during the cascade. */
export const CASCADE_STEP_MS = 120;

/** The one site JENGA ships onboarded. Mirrors `db.DEFAULT_PROJECT_ID`. */
export const DEFAULT_PROJECT_ID = 'eglinton-west-station';
const DEFAULT_SITE_NAME = 'Eglinton West Station';

const IDENTITY_KEY = 'jenga.identity';

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

function persistIdentity(s: { role: Role; ownerId: string; companyId: string }) {
  try {
    localStorage.setItem(
      IDENTITY_KEY,
      JSON.stringify({ role: s.role, ownerId: s.ownerId, companyId: s.companyId }),
    );
  } catch {
    /* private window or blocked storage: the switcher still works for the session */
  }
}

/**
 * Re-read the active project's tasks and submissions without the loading flash
 * `load` causes. Ignored if the site changed while the request was in flight.
 */
async function refreshSite(projectId: string) {
  const { role } = useJenga.getState();
  const [g, reports] = await Promise.all([
    api.fetchGraph(projectId),
    api.fetchReports(projectId, role === 'contractor' ? 'contractor' : 'owner'),
  ]);
  if (useJenga.getState().activeProjectId !== projectId) return;
  useJenga.setState((s) => ({
    tasks: g.tasks,
    edges: g.edges,
    criticalPath: g.critical_path,
    projectDuration: g.project_duration,
    reports,
    stageHistory: recordStages(s.stageHistory, g.tasks),
  }));
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
  /**
   * The focus: one task or one zone, never both. Every view frames it (graph fit,
   * twin camera, schedule row) and clearing it resets them all. `focusOrigin` says
   * which view the click came from, so the graph does not re-zoom on its own click.
   */
  selectedTaskId: string | null;
  selectedZone: Zone | null;
  focusOrigin: FocusOrigin | null;
  /**
   * Hard-gate AI-written reports. Always on: there is no toggle any more, since
   * the owner reviews every update anyway. Kept as state so each verify request
   * still says `strict=true` explicitly.
   */
  strict: boolean;

  attributions: AttributionEntry[];
  purchaseOrders: PurchaseOrder[];
  hotzones: HotzoneResponse | null;
  /** True while an operator-triggered Browserbase scrape is running. */
  scrapingHotzones: boolean;
  /** Set when the last scrape press could not reach the backend at all. */
  scrapeError: string | null;

  /** The last supply-line radar pass: delivery routes vs live 511 closures. */
  routeRisk: RouteCheckResponse | null;
  /** True while a radar pass is running. */
  checkingRoutes: boolean;
  /** The earned-schedule S-curve and spend velocity, refreshed after actions. */
  schedule: ScheduleAnalytics | null;
  spend: SpendAnalytics | null;

  /** Live log of agentic operations, newest first. Survives site switches. */
  activity: AgentEvent[];
  /** Whether the activity rail is open. */
  activityOpen: boolean;
  /** Curing telemetry, keyed by ticket. Nothing polls it since SensorStrip was removed. */
  sensors: Record<string, SensorPayload>;

  /**
   * Who is looking. A demo role switcher, not authentication: the API scopes by
   * the ids it is given and the UI filters by these. See CONTRACT.md.
   */
  role: Role;
  ownerId: string;
  companyId: string;
  portal: PortalOverview | null;
  /** The active project's submissions. The contractor's copy carries no verdicts. */
  reports: Report[];
  /** Updates awaiting the current owner's decision, across their projects. */
  queue: QueueItem[];
  /** The docked Reviews rail, the card it was opened on, and the card the pointer is over. */
  reviewsOpen: boolean;
  reviewTargetId: string | null;
  previewReportId: string | null;

  loading: boolean;
  busy: boolean;
  cascading: boolean;
  offline: boolean;

  load: (projectId?: string) => Promise<void>;
  loadSite: (hotzoneId: string) => Promise<void>;
  /** Press-to-scrape: run Browserbase now and put the result on the map. */
  scrapeHotzones: () => Promise<void>;
  /** Supply-line radar: trace delivery routes and check them against 511. */
  checkRoutes: () => Promise<void>;
  /** Refresh both analytics payloads; logs a new escalation into the rail. */
  loadAnalytics: () => Promise<void>;
  loadSample: () => Promise<void>;
  reset: () => Promise<void>;
  setView: (v: SiteView) => void;
  setMicroTab: (t: MicroTab) => void;
  setMode: (m: ViewMode) => void;
  selectTask: (id: string | null, origin?: FocusOrigin) => void;
  selectZone: (z: Zone | null, origin?: FocusOrigin) => void;
  clearFocus: () => void;
  setReviewsOpen: (open: boolean) => void;
  setPreviewReport: (reportId: string | null) => void;
  /** Open the rail on a review and focus its task in every view. */
  openReview: (reportId: string, taskId: string) => void;
  loadSensors: (id: string) => Promise<void>;
  restoreIdentity: () => void;
  setRole: (role: Role) => Promise<void>;
  setOwner: (id: string) => Promise<void>;
  setCompany: (id: string) => Promise<void>;
  refreshPortal: () => Promise<void>;
  focusProject: (project: PortalProject) => Promise<void>;
  /** Each returns the refusal message, or null on success. */
  submitUpdate: (
    taskId: string,
    text: string,
    imageBase64: string | null,
    extra?: api.UpdateExtras,
  ) => Promise<string | null>;
  decide: (reportId: string, decision: 'approve' | 'deny', note: string) => Promise<string | null>;
  runDispute: (taskId: string, delayDays: number, reason: string) => Promise<void>;
  /** Procurement actions on a PO. Each hits the backend and mirrors the result. */
  expeditePO: (poId: string) => Promise<void>;
  markPoReceived: (poId: string) => Promise<void>;
  linkPoToTask: (poId: string, taskId: string) => Promise<void>;
  /**
   * Hand extracted work packages to the procurement agent, which creates a real
   * purchase order on Zip staging (or the local-ledger fallback). Logs the run
   * in the activity rail and mirrors the new PO into the ledger. Returns the
   * full result so the caller can render the agent's trace, or null if the
   * request never landed.
   */
  agentProcure: (
    packages: api.ProposedTask[],
    filename: string,
  ) => Promise<api.AgentProcurementResult | null>;

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
  focusOrigin: null,
  attributions: [],
  purchaseOrders: [],
  sensors: {},
  schedule: null,
  spend: null,
  // Routes are drawn from this site's POs to this site's pin; a site switch
  // makes every line on the map a claim about the wrong project.
  routeRisk: null,
  busy: false,
  cascading: false,
} satisfies Partial<JengaState>;

export const useJenga = create<JengaState>((set, get) => ({
  ...EMPTY_SITE,

  activeProjectId: DEFAULT_PROJECT_ID,
  activeSiteName: DEFAULT_SITE_NAME,
  view: 'micro',

  mode: 'logical',
  strict: true,

  hotzones: null,
  scrapingHotzones: false,
  scrapeError: null,

  routeRisk: null,
  checkingRoutes: false,
  schedule: null,
  spend: null,

  activity: [],
  activityOpen: false,

  role: 'owner',
  ownerId: 'halton-transit',
  companyId: 'ellis-civil',
  portal: null,
  reports: [],
  queue: [],
  reviewsOpen: false,
  reviewTargetId: null,
  previewReportId: null,

  loading: true,
  offline: false,

  async load(projectId) {
    const target = projectId ?? get().activeProjectId ?? DEFAULT_PROJECT_ID;
    set({ loading: true, activeProjectId: target });
    const [g, pos, hotzones, reports] = await Promise.all([
      api.fetchGraph(target),
      api.fetchPurchaseOrders(),
      api.fetchHotzones(),
      api.fetchReports(target, get().role === 'contractor' ? 'contractor' : 'owner'),
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
      reports,
      hotzones,
      loading: false,
      offline: api.isOffline(),
    });
    // The curves belong to the freshly loaded site.
    void get().loadAnalytics();
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
   * Supply-line radar: trace every PO's delivery route via OSRM and check it
   * against Ontario 511's live closure feed (fetched through Browserbase).
   * Discrete user action — announces itself and its outcome in the activity
   * rail with the same three-way honesty as the scrape.
   */
  async checkRoutes() {
    const site = get().activeProjectId;
    set({ checkingRoutes: true });
    const ev = get().logActivity({
      source: 'browserbase',
      status: 'running',
      title: 'Checking delivery routes against live closures',
      detail: 'Ontario 511 events · OSRM vendor routes · proximity analysis',
    });
    const result = await api.checkRoutes();
    if (get().activeProjectId !== site) {
      set({ checkingRoutes: false });
      return; // routes belong to the site they were checked from
    }
    set((s) => ({ checkingRoutes: false, routeRisk: result ?? s.routeRisk }));

    if (!result) {
      get().updateActivity(ev, {
        status: 'error',
        title: 'Route check did not reach the backend',
      });
      return;
    }
    const flagged = result.routes.filter((r) => r.risk !== 'clear');
    get().updateActivity(ev, {
      status: result.source === 'live' ? (flagged.length ? 'warn' : 'ok') : 'warn',
      title:
        result.source === 'live'
          ? `${result.events_scanned} live 511 events · ${flagged.length}/${result.routes.length} routes at risk`
          : 'Live 511 feed unreachable — seeded closure used',
      detail: flagged
        .map((r) => `${r.po_id} via ${r.closures[0]?.roadway ?? '—'}: ${r.risk}`)
        .join(' · '),
    });

    // The agent may have acted; announce it and refresh what it touched.
    const acted = result.routes.find((r) => r.action !== 'none');
    if (acted) {
      const preview = acted.cpm_preview;
      get().logActivity({
        source: 'zip',
        status: 'ok',
        title: `${acted.po_id} auto-expedited — ${acted.closures[0]?.roadway ?? 'route'} closure`,
        detail: preview
          ? `Predicted +${acted.predicted_slip_days}d delivery slip → ${preview.task_id} → project +${preview.project_slip_days}d, ${preview.downstream_count} downstream. ${acted.action_detail}`
          : acted.action_detail,
      });
      const pos = await api.fetchPurchaseOrders();
      if (get().activeProjectId === site) set({ purchaseOrders: pos });
      void get().loadAnalytics();
    }
  },

  /**
   * Refresh the S-curve and spend analytics. A null response (backend down)
   * keeps the previous data on screen rather than blanking the band. A *new*
   * escalation — one the rail has not seen — logs as an activity event, so the
   * governance moment is announced, not just drawn.
   */
  async loadAnalytics() {
    const site = get().activeProjectId;
    const [schedule, spend] = await Promise.all([
      api.fetchScheduleAnalytics(),
      api.fetchSpendAnalytics(),
    ]);
    if (get().activeProjectId !== site) return; // stale by site switch
    const prev = get().spend?.escalation?.at;
    set((s) => ({
      schedule: schedule ?? s.schedule,
      spend: spend ?? s.spend,
    }));
    const esc = spend?.escalation;
    if (esc && esc.at !== prev) {
      get().logActivity({
        source: 'zip',
        status: 'error',
        title: 'Governance escalation — spend outrunning the build',
        detail: esc.message,
      });
    }
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
      attributions: [],
      selectedTaskId: null,
      selectedZone: null,
      focusOrigin: null,
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
  // Task and zone are one focus: choosing either replaces the other, and choosing
  // nothing clears both, so "deselect" always means the same reset.
  selectTask: (id, origin = 'schedule') =>
    set(
      id
        ? { selectedTaskId: id, selectedZone: null, focusOrigin: origin }
        : { selectedTaskId: null, selectedZone: null, focusOrigin: null },
    ),
  selectZone: (zone, origin = 'twin') =>
    set(
      zone
        ? { selectedZone: zone, selectedTaskId: null, focusOrigin: origin }
        : { selectedTaskId: null, selectedZone: null, focusOrigin: null },
    ),
  clearFocus: () => set({ selectedTaskId: null, selectedZone: null, focusOrigin: null }),
  setReviewsOpen: (reviewsOpen) =>
    set(reviewsOpen ? { reviewsOpen } : { reviewsOpen, reviewTargetId: null, previewReportId: null }),
  setPreviewReport: (previewReportId) => set({ previewReportId }),
  // Clicking a review badge is a selection like any other, so the graph, the twin
  // and the schedule all focus the task; hovering a card only previews (see the rail).
  openReview: (reportId, taskId) => {
    set({ reviewsOpen: true, reviewTargetId: reportId });
    get().selectTask(taskId, 'schedule');
  },

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

  /** Read the saved identity after hydration; reading it at module init would mismatch the server HTML. */
  restoreIdentity() {
    try {
      const saved = JSON.parse(localStorage.getItem(IDENTITY_KEY) ?? 'null');
      if (saved && (saved.role === 'owner' || saved.role === 'contractor')) {
        set({
          role: saved.role,
          ownerId: saved.ownerId ?? get().ownerId,
          companyId: saved.companyId ?? get().companyId,
        });
      }
    } catch {
      /* private window or blocked storage: the defaults are fine */
    }
  },

  async setRole(role) {
    set({ role });
    persistIdentity(get());
    await get().refreshPortal();
  },
  async setOwner(ownerId) {
    set({ ownerId });
    persistIdentity(get());
    await get().refreshPortal();
  },
  async setCompany(companyId) {
    set({ companyId });
    persistIdentity(get());
    await get().refreshPortal();
  },

  /**
   * Reload everything the current identity can see, and put the graph on one of
   * its projects if the one on screen belongs to someone else. A site the portal
   * does not know (a hotzone with no project) is left alone.
   */
  async refreshPortal() {
    const { role, ownerId, companyId } = get();
    const params = role === 'owner' ? { ownerId } : { companyId };
    const [portal, queue] = await Promise.all([
      api.fetchPortal(params),
      role === 'owner' ? api.fetchQueue(ownerId) : Promise.resolve([] as QueueItem[]),
    ]);
    if (get().role !== role) return; // the switcher moved again while this was in flight
    set({ portal, queue, offline: api.isOffline() });

    const active = get().activeProjectId;
    const mine = portal.projects.some((p) => p.id === active);
    if (!mine && portal.projects.length > 0 && (role === 'contractor' || active !== null)) {
      await get().focusProject(portal.projects[0]);
    } else if (active && mine) {
      await refreshSite(active);
    }
  },

  async focusProject(project) {
    set({
      ...EMPTY_SITE,
      reports: [],
      view: 'micro',
      activeProjectId: project.id,
      activeSiteName: project.name,
      loading: true,
    });
    await get().load(project.id);
    await refreshSite(project.id);
  },

  async submitUpdate(taskId, text, imageBase64, extra = {}) {
    const site = get().activeProjectId;
    if (!site) return 'No project selected.';
    set({ busy: true });
    const ev = get().logActivity({
      source: 'agent',
      status: 'running',
      title: `Verifying ${displayId(taskId)} — 5-node pipeline`,
      detail: 'GPTZero authorship → vision → historical memory → telemetry → arbiter',
    });
    try {
      await api.submitReport(site, taskId, text, imageBase64, get().tasks, get().strict, extra);
    } catch (err) {
      set({ busy: false });
      const message = err instanceof Error ? err.message : 'Submission failed.';
      get().updateActivity(ev, { status: 'error', title: `Update on ${displayId(taskId)} refused`, detail: message });
      return message;
    }
    get().updateActivity(ev, {
      status: 'ok',
      title: `Update on ${displayId(taskId)} sent for owner review`,
      detail: 'The AI recommendation is attached for the owner to weigh.',
    });
    set({ busy: false, offline: api.isOffline() });
    if (get().activeProjectId === site) await refreshSite(site);
    const { role, ownerId, companyId } = get();
    set({ portal: await api.fetchPortal(role === 'owner' ? { ownerId } : { companyId }) });
    return null;
  },

  async decide(reportId, decision, note) {
    let res;
    try {
      res = await api.decideReport(reportId, decision, note);
    } catch (err) {
      return err instanceof Error ? err.message : 'Decision failed.';
    }
    if (get().activeProjectId === res.report.project_id) {
      set((s) => ({
        tasks: res.tasks,
        stageHistory: recordStages(s.stageHistory, res.tasks),
      }));
    }
    const { ownerId } = get();
    const [queue, portal] = await Promise.all([
      api.fetchQueue(ownerId),
      api.fetchPortal({ ownerId }),
    ]);
    set({ queue, portal, offline: api.isOffline() });
    if (get().activeProjectId) await refreshSite(get().activeProjectId!);
    // A denial reworks the schedule; the earned/spend curves must follow.
    void get().loadAnalytics();
    return null;
  },

  async runDispute(taskId, delayDays, reason) {
    const site = get().activeProjectId;
    set({ busy: true, cascading: true });
    const ev = get().logActivity({
      source: 'agent',
      status: 'running',
      title: `Propagating +${delayDays}d slip from ${displayId(taskId)}`,
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
          // The slip is now in the schedule; the S-curve must reflect it.
          void get().loadAnalytics();
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
    // The expedite just landed in the event stream; redraw the spend curve.
    void get().loadAnalytics();
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

  async agentProcure(packages, filename) {
    const site = get().activeProjectId;
    const ev = get().logActivity({
      source: 'zip',
      status: 'running',
      title: `Agent creating procurement from ${filename}`,
      detail: `Planning materials for ${packages.length} work package${packages.length === 1 ? '' : 's'} → vendor → Zip purchase order…`,
    });
    const result = await api.createProcurementViaAgent(packages, filename);
    get().updateActivity(
      ev,
      !result
        ? {
            status: 'error',
            title: 'Procurement agent did not reach the backend',
            detail: 'Is the backend running on :8000?',
          }
        : result.live
          ? {
              status: 'ok',
              title: `Zip PO ${result.po_number ?? result.po_id} created on staging`,
              detail: result.detail,
            }
          : {
              status: 'warn',
              title: `PO ${result.po_number} drafted on the local ledger`,
              detail: result.detail,
            },
    );
    if (!result) return null;
    // Mirror the new PO into the Procurement tab, unless the user has switched
    // sites while the agent ran — the PO belongs to the site it was raised from.
    if (result.purchase_order && get().activeProjectId === site) {
      const po = result.purchase_order;
      set((s) => ({ purchaseOrders: [po, ...s.purchaseOrders] }));
      void get().loadAnalytics();
    }
    return result;
  },

  async linkPoToTask(poId, taskId) {
    const site = get().activeProjectId;
    const updated = await api.actOnPurchaseOrder(poId, 'link', taskId);
    get().logActivity(
      updated
        ? { source: 'zip', status: 'ok', title: `${displayId(poId)} linked to ${displayId(taskId)}` }
        : { source: 'zip', status: 'error', title: `Link of ${poId} did not land` },
    );
    if (!updated || get().activeProjectId !== site) return;
    set((s) => ({
      purchaseOrders: s.purchaseOrders.map((po) => (po.id === poId ? updated : po)),
    }));
  },
}));
