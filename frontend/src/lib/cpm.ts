import type { GraphEdge, Task } from './types';

/**
 * Critical Path Method over the task DAG.
 *
 * The backend owns this in production (CONTRACT.md `/api/graph`), but the seed
 * fixture ships only durations + edges, so the fixture layer recomputes it to
 * stay demoable with the backend down. Same function powers the dispute
 * cascade: bump a duration, re-run, diff.
 */

export type CpmInput = Pick<Task, 'id' | 'duration_days'>;

export interface CpmResult<T extends CpmInput> {
  tasks: (T & {
    depends_on: string[];
    es: number;
    ef: number;
    ls: number;
    lf: number;
    total_float: number;
    is_critical: boolean;
    depth: number;
  })[];
  critical_path: string[];
  project_duration: number;
}

/** Kahn's algorithm. Throws on a cycle so a bad edge list fails loudly. */
function topoOrder(ids: string[], preds: Map<string, string[]>): string[] {
  const indegree = new Map(ids.map((id) => [id, preds.get(id)?.length ?? 0]));
  const succs = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const [id, ps] of preds) {
    for (const p of ps) succs.get(p)?.push(id);
  }

  const queue = ids.filter((id) => indegree.get(id) === 0);
  const order: string[] = [];
  while (queue.length) {
    const id = queue.shift()!;
    order.push(id);
    for (const s of succs.get(id) ?? []) {
      const next = indegree.get(s)! - 1;
      indegree.set(s, next);
      if (next === 0) queue.push(s);
    }
  }
  if (order.length !== ids.length) {
    throw new Error('Task graph contains a cycle');
  }
  return order;
}

export function computeCpm<T extends CpmInput>(
  tasks: T[],
  edges: GraphEdge[],
): CpmResult<T> {
  const ids = tasks.map((t) => t.id);
  const byId = new Map(tasks.map((t) => [t.id, t]));

  const preds = new Map<string, string[]>(ids.map((id) => [id, []]));
  const succs = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const e of edges) {
    if (!byId.has(e.source) || !byId.has(e.target)) continue;
    preds.get(e.target)!.push(e.source);
    succs.get(e.source)!.push(e.target);
  }

  const order = topoOrder(ids, preds);
  const es = new Map<string, number>();
  const ef = new Map<string, number>();
  const depth = new Map<string, number>();

  // Forward pass. depth = longest edge-count from any source, which is what the
  // cascade animation staggers on.
  for (const id of order) {
    const ps = preds.get(id)!;
    const start = ps.length ? Math.max(...ps.map((p) => ef.get(p)!)) : 0;
    es.set(id, start);
    ef.set(id, start + byId.get(id)!.duration_days);
    depth.set(id, ps.length ? Math.max(...ps.map((p) => depth.get(p)!)) + 1 : 0);
  }

  const projectDuration = Math.max(0, ...ids.map((id) => ef.get(id)!));

  // Backward pass. Sinks are bounded by the project finish, not by their own EF,
  // so a short dangling branch correctly reports the float it really has.
  const lf = new Map<string, number>();
  const ls = new Map<string, number>();
  for (const id of [...order].reverse()) {
    const ss = succs.get(id)!;
    const finish = ss.length
      ? Math.min(...ss.map((s) => ls.get(s)!))
      : projectDuration;
    lf.set(id, finish);
    ls.set(id, finish - byId.get(id)!.duration_days);
  }

  const out = tasks.map((t) => ({
    ...t,
    depends_on: preds.get(t.id)!,
    es: es.get(t.id)!,
    ef: ef.get(t.id)!,
    ls: ls.get(t.id)!,
    lf: lf.get(t.id)!,
    total_float: ls.get(t.id)! - es.get(t.id)!,
    is_critical: ls.get(t.id)! - es.get(t.id)! === 0,
    depth: depth.get(t.id)!,
  }));

  return {
    tasks: out,
    critical_path: criticalChain(out, succs),
    project_duration: projectDuration,
  };
}

/**
 * Walk the zero-float chain from its start to its end.
 * ponytail: on a tie between two critical successors we take the first. Real
 * schedules have near-parallel critical chains; if the demo ever needs both,
 * return every chain instead of one.
 */
function criticalChain(
  tasks: { id: string; es: number; ef: number; is_critical: boolean }[],
  succs: Map<string, string[]>,
): string[] {
  const critical = tasks.filter((t) => t.is_critical);
  if (!critical.length) return [];
  const byId = new Map(critical.map((t) => [t.id, t]));

  let cursor = critical.reduce((a, b) => (b.es < a.es ? b : a));
  const path = [cursor.id];
  for (;;) {
    const next = (succs.get(cursor.id) ?? [])
      .map((id) => byId.get(id))
      .find((t) => t && t.es === cursor.ef);
    if (!next) break;
    cursor = next;
    path.push(cursor.id);
  }
  return path;
}
