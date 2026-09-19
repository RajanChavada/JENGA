// Run: node --experimental-strip-types scripts/test-whatif.ts  (from frontend/)
import assert from 'node:assert/strict';
import { axisSpan, extensionsByTask, whatIfFor } from '../src/lib/whatif.ts';

const aff = (id: string, before: number, after: number, due: number | null) => ({
  id, name: id, finish_date_before: '', finish_date_after: '', finish_day_before: before, finish_day_after: after, due_day: due, due_date: null, late_by_days: 0, newly_late: false,
});
const impact = (task: string, affected: ReturnType<typeof aff>[], predicted = 52, deadline = 50) =>
  ({ task_id: task, rework_days: 2, rationale: [], float_consumed: 0, absorbed_by_float: false, project_slipped_days: predicted - 50, baseline_finish_day: 50, predicted_finish_day: predicted, deadline_day: deadline, baseline_finish_date: '', predicted_finish_date: '', project_deadline_date: '', days_past_deadline: Math.max(0, predicted - deadline), critical_path_changed: false, affected }) as never;
const task = (id: string, state: string) => ({ id, state }) as never;
const report = (id: string, task_id: string, decision: string, imp: unknown = null, project_id = 'p1') =>
  ({ id, task_id, project_id, owner_decision: decision, impact: imp }) as never;
const item = (id: string, task_id: string, imp: unknown, project_id = 'p1') => ({ report: report(id, task_id, 'pending', null, project_id), impact: imp }) as never;

const A = impact('A', [aff('A', 20, 22, 20), aff('B', 30, 32, 31)]);
const D = impact('D', [aff('D', 10, 12, 12), aff('E', 40, 41, 45)], 51, 50);
const base = { previewReportId: null, selectedTaskId: null, queue: [item('r1', 'A', A)], reports: [], tasks: [task('A', 'under_review'), task('D', 'active')], activeProjectId: 'p1' };

// nothing selected or hovered: no prediction
assert.equal(whatIfFor(base).primary, null);
// the selected task's pending review is primary
assert.equal(whatIfFor({ ...base, selectedTaskId: 'A' }).primary?.reportId, 'r1');
// a hovered card wins over the selection
const two = { ...base, queue: [item('r1', 'A', A), item('r2', 'X', impact('X', [aff('X', 5, 6, 5)]))], selectedTaskId: 'A' };
assert.equal(whatIfFor({ ...two, previewReportId: 'r2' }).primary?.reportId, 'r2');
// another project's queue items are ignored
assert.equal(whatIfFor({ ...base, selectedTaskId: 'A', activeProjectId: 'p2' }).primary, null);
// an impact from before day offsets existed cannot be drawn
assert.equal(whatIfFor({ ...base, selectedTaskId: 'A', queue: [item('r1', 'A', { ...(A as object), predicted_finish_day: null })] }).primary, null);

// denied tasks (active + latest report rejected) are faint until resubmitted/approved
const denied = { ...base, reports: [report('d1', 'D', 'rejected', D)], queue: [] };
assert.deepEqual(whatIfFor(denied).faint.map((w) => w.taskId), ['D']);
assert.equal(whatIfFor(denied).primary, null);                                  // nothing selected: faint only
assert.equal(whatIfFor({ ...denied, selectedTaskId: 'D' }).primary?.kind, 'denied');   // selecting it makes it primary
assert.deepEqual(whatIfFor({ ...denied, selectedTaskId: 'D' }).faint, []);       // ...and no longer faint
assert.deepEqual(whatIfFor({ ...denied, reports: [report('d1', 'D', 'rejected', D), report('d2', 'D', 'pending')] }).faint, []); // resubmitted
assert.deepEqual(whatIfFor({ ...denied, tasks: [task('D', 'verified')] }).faint, []);   // approved

// extensions: primary full strength with lateness; faint separate; primary wins on a shared task
const ext = extensionsByTask(whatIfFor({ ...base, selectedTaskId: 'A' }).primary, whatIfFor(denied).faint);
assert.deepEqual(ext.get('A'), { from: 20, to: 22, live: true, dueDay: 20, lateBy: 2 });
assert.deepEqual(ext.get('B'), { from: 30, to: 32, live: true, dueDay: 31, lateBy: 1 });
assert.equal(ext.get('D')!.live, false);
assert.equal(ext.get('E')!.lateBy, 0);                                            // on time despite moving
const overlap = extensionsByTask(whatIfFor({ ...base, selectedTaskId: 'A' }).primary, [{ kind: 'denied', reportId: 'z', taskId: 'A', impact: impact('A', [aff('A', 20, 25, 20)]) }]);
assert.equal(overlap.get('A')!.to, 22);
// a zero or negative move is not drawn
assert.equal(extensionsByTask(null, [{ kind: 'denied', reportId: 'z', taskId: 'Q', impact: impact('Q', [aff('Q', 9, 9, 9)]) }]).size, 0);

// axis: unchanged without a prediction, grows to hold one, never shrinks
assert.equal(axisSpan(50, null), 50);
assert.equal(axisSpan(50, whatIfFor({ ...base, selectedTaskId: 'A' }).primary), 55);   // ceil(52 * 1.04)
assert.equal(axisSpan(80, whatIfFor({ ...base, selectedTaskId: 'A' }).primary), 80);

console.log('All what-if checks passed');
