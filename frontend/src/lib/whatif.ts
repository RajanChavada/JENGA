import type { Impact, QueueItem, Report, Task } from './types';

/**
 * What the owner's schedule shows about updates under review and denials.
 *
 * One prediction is *primary*: the one the owner is looking at (a hovered review
 * card, else the selected task's pending or denied update). It gets the full
 * overlay (extensions, predicted finish, deadline). Every other still-denied task
 * is *faint*: its own extension only, since separate denials are independent
 * what-ifs and their finish lines would contradict each other.
 *
 * Pure so the rules can be checked without React.
 */

export interface WhatIf {
  kind: 'pending' | 'denied';
  reportId: string;
  taskId: string;
  impact: Impact;
}

export interface Extension {
  /** Current finish day and predicted finish day on the schedule's axis. */
  from: number;
  to: number;
  /** Primary (full strength) or faint (a past denial). */
  live: boolean;
  dueDay: number | null;
  /** Days past its due date after the extension (0 when on time or undated). */
  lateBy: number;
}

/** Only impacts that carry day offsets can be drawn; older stored ones are skipped. */
function drawable(impact: Impact | Report['impact'] | undefined): impact is Impact {
  return (
    !!impact &&
    'affected' in impact &&
    impact.predicted_finish_day != null &&
    impact.affected.every((a) => a.finish_day_before != null && a.finish_day_after != null)
  );
}

/** A task's denial: it is active again and its latest update was rejected. */
function deniedFor(tasks: Task[], reports: Report[]): WhatIf[] {
  const out: WhatIf[] = [];
  for (const t of tasks) {
    if (t.state !== 'active') continue;
    const latest = reports.filter((r) => r.task_id === t.id).at(-1);
    if (latest?.owner_decision === 'rejected' && drawable(latest.impact)) {
      out.push({ kind: 'denied', reportId: latest.id, taskId: t.id, impact: latest.impact });
    }
  }
  return out;
}

export function whatIfFor(args: {
  selectedTaskId: string | null;
  previewReportId: string | null;
  queue: QueueItem[];
  reports: Report[];
  tasks: Task[];
  activeProjectId: string | null;
}): { primary: WhatIf | null; faint: WhatIf[] } {
  const { selectedTaskId, previewReportId, queue, reports, tasks, activeProjectId } = args;

  const pending: WhatIf[] = queue
    .filter((q) => q.report.project_id === activeProjectId && drawable(q.impact))
    .map((q) => ({ kind: 'pending', reportId: q.report.id, taskId: q.report.task_id, impact: q.impact! }));
  const denied = deniedFor(tasks, reports);

  const primary =
    (previewReportId
      ? [...pending, ...denied].find((w) => w.reportId === previewReportId)
      : undefined) ??
    (selectedTaskId
      ? (pending.find((w) => w.taskId === selectedTaskId) ??
        denied.find((w) => w.taskId === selectedTaskId))
      : undefined) ??
    null;

  const faint = denied.filter((w) => w.taskId !== primary?.taskId);
  return { primary, faint };
}

/** Per-task extensions to draw. The primary wins where both cover the same task. */
export function extensionsByTask(
  primary: WhatIf | null,
  faint: WhatIf[],
): Map<string, Extension> {
  const out = new Map<string, Extension>();
  const add = (w: WhatIf, live: boolean) => {
    for (const a of w.impact.affected) {
      const from = a.finish_day_before!;
      const to = a.finish_day_after!;
      if (to <= from) continue;
      const dueDay = a.due_day ?? null;
      out.set(a.id, { from, to, live, dueDay, lateBy: dueDay == null ? 0 : Math.max(0, to - dueDay) });
    }
  };
  for (const w of faint) add(w, false);
  if (primary) add(primary, true);
  return out;
}

/** The axis grows to hold a prediction (with a little room) and never shrinks below the plan. */
export function axisSpan(base: number, primary: WhatIf | null): number {
  if (!primary) return base;
  const reach = Math.max(primary.impact.predicted_finish_day ?? 0, primary.impact.deadline_day ?? 0);
  return Math.max(base, Math.ceil(reach * 1.04));
}
