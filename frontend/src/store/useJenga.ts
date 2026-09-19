'use client';

import { create } from 'zustand';
import * as api from '@/lib/api';
import * as fx from '@/lib/fixtures';
import type {
  AttributionEntry,
  GraphEdge,
  PurchaseOrder,
  Task,
  TaskState,
  Verdict,
  Zone,
} from '@/lib/types';

/** Milliseconds of delay per topological rank during the cascade. */
export const CASCADE_STEP_MS = 120;

export type ViewMode = 'blueprint' | 'logical';

interface JengaState {
  tasks: Task[];
  edges: GraphEdge[];
  criticalPath: string[];
  projectDuration: number;
  baselineDuration: number | null;

  mode: ViewMode;
  selectedTaskId: string | null;
  selectedZone: Zone | null;

  verdict: Verdict | null;
  attributions: AttributionEntry[];
  purchaseOrders: PurchaseOrder[];
  sideEffect: string | null;

  loading: boolean;
  busy: boolean;
  cascading: boolean;
  offline: boolean;

  load: () => Promise<void>;
  reset: () => Promise<void>;
  setMode: (m: ViewMode) => void;
  selectTask: (id: string | null) => void;
  selectZone: (z: Zone | null) => void;
  clearVerdict: () => void;
  submit: (submissionId: string) => Promise<void>;
  runDispute: (taskId: string, delayDays: number, reason: string) => Promise<void>;
}

export const useJenga = create<JengaState>((set, get) => ({
  tasks: [],
  edges: [],
  criticalPath: [],
  projectDuration: 0,
  baselineDuration: null,

  mode: 'blueprint',
  selectedTaskId: null,
  selectedZone: null,

  verdict: null,
  attributions: [],
  purchaseOrders: [],
  sideEffect: null,

  loading: true,
  busy: false,
  cascading: false,
  offline: false,

  async load() {
    set({ loading: true });
    const [g, pos] = await Promise.all([api.fetchGraph(), api.fetchPurchaseOrders()]);
    set({
      tasks: g.tasks,
      edges: g.edges,
      criticalPath: g.critical_path,
      projectDuration: g.project_duration,
      baselineDuration: g.project_duration,
      purchaseOrders: pos,
      loading: false,
      offline: api.isOffline(),
    });
  },

  async reset() {
    set({ verdict: null, attributions: [], sideEffect: null, selectedTaskId: null });
    await get().load();
  },

  setMode: (mode) => set({ mode }),
  selectTask: (selectedTaskId) => set({ selectedTaskId }),
  selectZone: (selectedZone) => set({ selectedZone }),
  clearVerdict: () => set({ verdict: null, sideEffect: null }),

  async submit(submissionId) {
    const sub = fx.SUBMISSIONS.find((s) => s.id === submissionId);
    if (!sub) return;
    set({ busy: true, verdict: null, sideEffect: null });

    const verdict = await api.verify(sub.task_id, submissionId, get().tasks);
    const nextState = fx.stateForVerdict(verdict.status);

    set((s) => ({
      verdict,
      busy: false,
      sideEffect: fx.sideEffectFor(submissionId),
      selectedTaskId: sub.task_id,
      offline: api.isOffline(),
      tasks: s.tasks.map((t) =>
        t.id === sub.task_id ? { ...t, state: nextState } : t,
      ),
    }));

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
    set((s) => ({
      tasks: s.tasks.map((t) => {
        if (t.id === taskId || affected.has(t.id)) return t;
        return res.tasks.find((n) => n.id === t.id) ?? t;
      }),
      criticalPath: res.critical_path,
    }));

    ranks.forEach((rank, i) => {
      setTimeout(() => {
        const moved = byDepth.get(rank)!;
        set((s) => ({
          tasks: s.tasks.map((t) => {
            const hit = moved.find((m) => m.id === t.id);
            if (!hit) return t;
            const state: TaskState = hit.id === taskId ? 'disputed' : 'under_review';
            return { ...hit, state };
          }),
        }));
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
