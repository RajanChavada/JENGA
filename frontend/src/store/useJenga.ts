'use client';

import { create } from 'zustand';
import * as api from '@/lib/api';
import * as fx from '@/lib/fixtures';
import type {
  AttributionEntry,
  GraphEdge,
  HotzoneResponse,
  PurchaseOrder,
  Task,
  TaskState,
  Verdict,
  Zone,
} from '@/lib/types';

/** Milliseconds of delay per topological rank during the cascade. */
export const CASCADE_STEP_MS = 120;

export type ViewMode = 'blueprint' | 'logical';

/** One entry per state transition a task went through. Append-only. */
export interface StageEvent {
  state: TaskState;
  at: number;
}

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

interface JengaState {
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
  sideEffect: string | null;

  loading: boolean;
  busy: boolean;
  cascading: boolean;
  offline: boolean;

  load: () => Promise<void>;
  reset: () => Promise<void>;
  setMode: (m: ViewMode) => void;
  setStrict: (v: boolean) => void;
  selectTask: (id: string | null) => void;
  selectZone: (z: Zone | null) => void;
  clearVerdict: () => void;
  submit: (submissionId: string) => Promise<void>;
  submitText: (taskId: string, text: string, filename: string) => Promise<void>;
  runDispute: (taskId: string, delayDays: number, reason: string) => Promise<void>;
}

export const useJenga = create<JengaState>((set, get) => ({
  tasks: [],
  edges: [],
  criticalPath: [],
  projectDuration: 0,
  baselineDuration: null,
  baseline: {},
  stageHistory: {},

  mode: 'blueprint',
  selectedTaskId: null,
  selectedZone: null,
  strict: true,

  verdict: null,
  attributions: [],
  purchaseOrders: [],
  hotzones: null,
  sideEffect: null,

  loading: true,
  busy: false,
  cascading: false,
  offline: false,

  async load() {
    set({ loading: true });
    const [g, pos, hotzones] = await Promise.all([
      api.fetchGraph(),
      api.fetchPurchaseOrders(),
      api.fetchHotzones(),
    ]);
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

  async reset() {
    set({ verdict: null, attributions: [], sideEffect: null, selectedTaskId: null });
    await get().load();
  },

  setMode: (mode) => set({ mode }),
  setStrict: (strict) => set({ strict }),
  selectTask: (selectedTaskId) => set({ selectedTaskId }),
  selectZone: (selectedZone) => set({ selectedZone }),
  clearVerdict: () => set({ verdict: null, sideEffect: null }),

  async submit(submissionId) {
    const sub = fx.SUBMISSIONS.find((s) => s.id === submissionId);
    if (!sub) return;
    set({ busy: true, verdict: null, sideEffect: null });

    const verdict = await api.verify(sub.task_id, submissionId, get().tasks, get().strict);
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
    set({ busy: true, verdict: null, sideEffect: null });

    const verdict = await api.verifyWithText(taskId, text, get().tasks, get().strict);
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
    set({ busy: true, cascading: true });
    const res = await api.dispute(taskId, delayDays, reason, get().tasks);

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
}));
