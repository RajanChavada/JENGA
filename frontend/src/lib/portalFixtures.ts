import portal from '../../../data/portal.json';
import * as fx from './fixtures';
import { predictDenial } from './impact';
import type {
  ContractorImpact,
  DecisionResponse,
  Impact,
  PortalOverview,
  PortalProject,
  QueueItem,
  Report,
  Task,
  Verdict,
} from './types';

/**
 * Offline mirror of the portal routes, so the role views still work with the
 * backend down (`NEXT_PUBLIC_USE_FIXTURES=1`). Every project shares the one
 * fixture schedule — the same caveat `fetchGraph` documents — with its own
 * task states and reports, held in module memory for the session.
 */

const tasksByProject = new Map<string, Task[]>();
const reports: Report[] = [];

/** `blocked` is derived, exactly as the backend does it: never stored. */
function withBlocking(tasks: Task[]): Task[] {
  const state = new Map(tasks.map((t) => [t.id, t.state]));
  return tasks.map((t) => {
    const open = t.depends_on.filter((d) => state.get(d) !== 'verified');
    return t.state === 'pending' && open.length ? { ...t, state: 'blocked', blocked_by: open } : t;
  });
}

function stored(projectId: string): Task[] {
  let list = tasksByProject.get(projectId);
  if (!list) {
    list = fx.graph().tasks;
    tasksByProject.set(projectId, list);
  }
  return list;
}

export function tasksFor(projectId: string): Task[] {
  return withBlocking(stored(projectId));
}

const party = (list: { id: string; name: string }[], id: string) =>
  list.find((p) => p.id === id)!;

export function overview(params: { companyId?: string; ownerId?: string }): PortalOverview {
  const projects: PortalProject[] = portal.projects
    .filter(
      (p) =>
        (!params.companyId || p.contractor_id === params.companyId) &&
        (!params.ownerId || p.owner_id === params.ownerId),
    )
    .map((p) => {
      const tasks = tasksFor(p.id);
      const count = (s: string) => tasks.filter((t) => t.state === s).length;
      return {
        id: p.id,
        name: p.name,
        owner: party(portal.owners, p.owner_id),
        contractor: party(portal.companies, p.contractor_id),
        start_date: p.start_date,
        total: tasks.length,
        verified: count('verified'),
        active: count('active'),
        under_review: count('under_review'),
        blocked: count('blocked'),
        awaiting_review: reports.filter(
          (r) => r.project_id === p.id && r.owner_decision === 'pending',
        ).length,
      };
    });
  return {
    owners: portal.owners.filter((o) => projects.some((p) => p.owner.id === o.id)),
    companies: portal.companies.filter((c) => projects.some((p) => p.contractor.id === c.id)),
    projects,
  };
}

function contractorView(i: Impact | ContractorImpact): ContractorImpact {
  return {
    rework_days: i.rework_days,
    predicted_finish_date: i.predicted_finish_date,
    project_slipped_days: i.project_slipped_days,
  };
}

export function projectReports(projectId: string, view: 'owner' | 'contractor'): Report[] {
  return reports
    .filter((r) => r.project_id === projectId)
    .map((r) =>
      view === 'contractor'
        ? { ...r, verdict: null, impact: r.impact ? contractorView(r.impact) : null }
        : r,
    );
}

export function queue(ownerId: string): QueueItem[] {
  return portal.projects
    .filter((p) => p.owner_id === ownerId)
    .flatMap((p) =>
      reports
        .filter((r) => r.project_id === p.id && r.owner_decision === 'pending')
        .map((report) => ({
          impact: denialImpact(p.id, p.start_date, report),
          report,
          project_name: p.name,
          task_name: stored(p.id).find((t) => t.id === report.task_id)?.name ?? report.task_id,
        })),
    );
}

function denialImpact(projectId: string, startDate: string, report: Report): Impact {
  return predictDenial(
    stored(projectId),
    fx.graph().edges,
    report.task_id,
    report.verdict,
    startDate,
  );
}

/** Same guards as the backend's verify route. Throws with the backend's meaning. */
export function submit(projectId: string, taskId: string, text: string, verdict: Verdict) {
  const task = tasksFor(projectId).find((t) => t.id === taskId);
  if (!task) throw new Error(`unknown task ${taskId}`);
  if (task.state !== 'active') throw new Error(`${taskId} is ${task.state}, not active`);
  if (reports.some((r) => r.task_id === taskId && r.project_id === projectId && r.owner_decision === 'pending'))
    throw new Error(`${taskId} already has an update awaiting review`);
  setState(projectId, taskId, 'under_review');
  const report: Report = {
    id: `local-${reports.length + 1}`,
    task_id: taskId,
    project_id: projectId,
    report_text: text,
    verdict,
    owner_decision: 'pending',
    owner_note: null,
    ai_override: false,
    impact: null,
    submitted_at: new Date().toISOString(),
    decided_at: null,
  };
  reports.push(report);
  return report;
}

function setState(projectId: string, taskId: string, state: Task['state']) {
  tasksByProject.set(
    projectId,
    stored(projectId).map((t) => (t.id === taskId ? { ...t, state } : t)),
  );
}

export function decide(reportId: string, decision: 'approve' | 'deny', note?: string): DecisionResponse {
  const report = reports.find((r) => r.id === reportId);
  if (!report) throw new Error(`unknown report ${reportId}`);
  if (report.owner_decision !== 'pending') throw new Error('already decided');
  const approve = decision === 'approve';
  const override = approve && report.verdict?.status !== 'APPROVED';
  const trimmed = note?.trim() || null;
  if ((!approve || override) && !trimmed)
    throw new Error('a note is required to deny, or to approve against the AI');

  report.owner_decision = approve ? 'approved' : 'rejected';
  report.owner_note = trimmed;
  report.ai_override = override;
  // A denial keeps the prediction made at that moment, next to the reason for it.
  if (!approve) {
    const project = portal.projects.find((p) => p.id === report.project_id)!;
    report.impact = denialImpact(report.project_id, project.start_date, report);
  }
  report.decided_at = new Date().toISOString();
  setState(report.project_id, report.task_id, approve ? 'verified' : 'active');

  if (approve) {
    const edges = fx.graph().edges;
    const state = new Map(stored(report.project_id).map((t) => [t.id, t.state]));
    for (const e of edges.filter((e) => e.source === report.task_id)) {
      const parents = edges.filter((p) => p.target === e.target).map((p) => p.source);
      if (state.get(e.target) === 'pending' && parents.every((p) => state.get(p) === 'verified'))
        setState(report.project_id, e.target, 'active');
    }
  }
  return { report, tasks: tasksFor(report.project_id) };
}
