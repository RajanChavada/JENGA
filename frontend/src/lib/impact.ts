import { computeCpm } from './cpm';
import type { GraphEdge, Impact, Task, Verdict } from './types';

/**
 * Offline mirror of backend/impact.py: what denying an update would cost the
 * schedule. Keep the rule table in step with the Python one; both are read by
 * the owner as a reason, not a black box. Advisory: never changes a duration.
 */

const TURNAROUND_DAYS = 1;

export function estimateReworkDays(
  verdict: (Partial<Verdict> & { branch?: string }) | null,
  task: Pick<Task, 'duration_days'>,
): { days: number; rationale: string[] } {
  const duration = task.duration_days || 1;
  const branch = verdict?.branch;
  const status = verdict?.status;
  const flagged = !!verdict?.gptzero?.flagged;

  let base: number;
  let why: string;
  if (branch === 'sensor_conflict') {
    base = Math.max(2, Math.ceil(0.75 * duration));
    why = 'Site sensors contradict the report, so the affected work is redone and re-cured.';
  } else if (branch === 'contradiction' || status === 'DISPUTED' || verdict?.vision?.matches_claim === false) {
    base = Math.max(1, Math.ceil(0.5 * duration));
    why = 'The photo contradicts the claimed progress, so about half the package is redone.';
  } else if (branch === 'ai_gate' || flagged) {
    base = 2;
    why = 'The report reads as AI-written, so the contractor must submit a first-hand account.';
  } else if (branch === 'ambiguity_rule' || status === 'UNDER_REVIEW') {
    base = 1;
    why = 'Evidence was too thin to rule on, so the contractor resubmits with better evidence.';
  } else {
    base = 1;
    why = 'The AI found the update sound; the denial is the owner’s call, assumed a minor fix.';
  }
  return {
    days: base + TURNAROUND_DAYS,
    rationale: [why, `+${TURNAROUND_DAYS} day to review the resubmission.`],
  };
}

const day = (start: Date, offset: number) => {
  const d = new Date(start.getTime());
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
};

export function predictDenial(
  tasks: Task[],
  edges: GraphEdge[],
  taskId: string,
  verdict: Verdict | null,
  startDate: string,
): Impact {
  const start = new Date(`${startDate}T00:00:00Z`);
  const task = tasks.find((t) => t.id === taskId)!;
  const { days, rationale } = estimateReworkDays(verdict, task);

  const before = computeCpm(tasks, edges);
  const delayed = computeCpm(
    tasks.map((t) => (t.id === taskId ? { ...t, duration_days: t.duration_days + days } : t)),
    edges,
  );
  const was = new Map(before.tasks.map((t) => [t.id, t]));
  const now = new Map(delayed.tasks.map((t) => [t.id, t]));

  // Descendants whose early start actually moved, as apply_delay reports them.
  const succs = new Map<string, string[]>();
  for (const e of edges) succs.set(e.source, [...(succs.get(e.source) ?? []), e.target]);
  const descendants = new Set<string>();
  const stack = [...(succs.get(taskId) ?? [])];
  while (stack.length) {
    const id = stack.pop()!;
    if (descendants.has(id)) continue;
    descendants.add(id);
    stack.push(...(succs.get(id) ?? []));
  }
  const moved = delayed.tasks
    .filter((t) => descendants.has(t.id) && t.es !== was.get(t.id)!.es)
    .sort((a, b) => a.depth - b.depth)
    .map((t) => t.id);

  const affected = [taskId, ...moved].map((id) => {
    const n = now.get(id)!;
    const due = n.due_day ?? null;
    const lateBefore = due === null ? 0 : Math.max(0, was.get(id)!.ef - due);
    const lateAfter = due === null ? 0 : Math.max(0, n.ef - due);
    return {
      id,
      name: n.name,
      finish_date_before: day(start, was.get(id)!.ef),
      finish_date_after: day(start, n.ef),
      due_date: due === null ? null : day(start, due),
      late_by_days: lateAfter,
      newly_late: lateAfter > lateBefore,
    };
  });

  const dues = delayed.tasks.map((t) => t.due_day).filter((d): d is number => d != null);
  const deadline = dues.length ? Math.max(...dues) : before.project_duration;
  const slipped = delayed.project_duration - before.project_duration;
  const floatBefore = was.get(taskId)!.total_float;

  return {
    task_id: taskId,
    rework_days: days,
    rationale,
    float_consumed: Math.min(days, floatBefore),
    absorbed_by_float: slipped === 0,
    project_slipped_days: slipped,
    baseline_finish_date: day(start, before.project_duration),
    predicted_finish_date: day(start, delayed.project_duration),
    project_deadline_date: day(start, deadline),
    days_past_deadline: Math.max(0, delayed.project_duration - deadline),
    critical_path_changed: before.critical_path.join() !== delayed.critical_path.join(),
    affected,
  };
}
