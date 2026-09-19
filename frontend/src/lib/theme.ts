import type { Report, Task, TaskState, Zone } from './types';

/**
 * One state -> appearance table, read by both React Flow and Three.js so the 2D
 * graph and the 3D station can never disagree. Material columns follow the
 * mapping table in CONTRACT.md.
 */
export interface StateStyle {
  label: string;
  /** Tailwind classes for the 2D node. */
  chip: string;
  /** Hex used by the 3D material and by edge strokes. */
  hex: string;
  wireframe: boolean;
  opacity: number;
  /** under_review pulses in 3D. */
  pulse: boolean;
}

export const STATE_STYLE: Record<TaskState, StateStyle> = {
  pending: {
    label: 'Pending',
    chip: 'border-slate-200 bg-slate-50 text-slate-500',
    hex: '#94a3b8',
    wireframe: true,
    opacity: 0.35,
    pulse: false,
  },
  active: {
    label: 'Active',
    chip: 'border-blue-200 bg-blue-50 text-blue-700',
    hex: '#2563eb',
    wireframe: true,
    opacity: 0.85,
    pulse: false,
  },
  under_review: {
    label: 'Under review',
    chip: 'border-amber-300 bg-amber-50 text-amber-700',
    hex: '#d97706',
    wireframe: false,
    opacity: 0.95,
    pulse: true,
  },
  verified: {
    label: 'Verified',
    chip: 'border-slate-300 bg-white text-slate-700',
    hex: '#64748b',
    wireframe: false,
    opacity: 1,
    pulse: false,
  },
  disputed: {
    label: 'Disputed',
    chip: 'border-red-300 bg-red-50 text-red-700',
    hex: '#dc2626',
    wireframe: true,
    opacity: 1,
    pulse: false,
  },
  blocked: {
    label: 'Blocked',
    chip: 'border-slate-200 bg-slate-100 text-slate-400',
    hex: '#cbd5e1',
    wireframe: false,
    opacity: 0.3,
    pulse: false,
  },
};

/**
 * A denial is not a task state (CONTRACT.md fixes those): the owner's "no" sends
 * the task back to `active`, and the only record of it is the task's latest
 * report. So "denied" is derived: active, and the last update was rejected. It
 * clears by itself when the contractor resubmits (the latest report is pending
 * again) or the owner approves.
 */
export function isDenied(task: Task, reports: Report[]): boolean {
  if (task.state !== 'active') return false;
  const latest = reports.filter((r) => r.task_id === task.id).at(-1);
  return latest?.owner_decision === 'rejected';
}

export function deniedTaskIds(tasks: Task[], reports: Report[]): Set<string> {
  return new Set(tasks.filter((t) => isDenied(t, reports)).map((t) => t.id));
}

/** Solid red, pulsing: distinct from `disputed`, which is a red wireframe. */
export const DENIED_STYLE: StateStyle = {
  label: 'Denied',
  chip: 'border-red-400 bg-red-100 text-red-800',
  hex: '#dc2626',
  wireframe: false,
  opacity: 0.9,
  pulse: true,
};

export type ZoneVisual = TaskState | 'denied';

/**
 * What a zone box shows. The worst live problem wins (denied, disputed, under
 * review), then active work, then not-yet-startable work. Active outranks
 * blocked: a zone with work in progress must not read as idle just because its
 * later packages are waiting. Verified shows only when nothing is left, so a
 * zone's completed tasks are counted on its label instead (`zoneProgress`).
 */
export function zoneVisual(tasks: Task[], denied: Set<string>): ZoneVisual {
  if (tasks.some((t) => denied.has(t.id))) return 'denied';
  if (tasks.length > 0 && tasks.every((t) => t.state === 'verified')) return 'verified';
  for (const s of ZONE_ORDER) if (tasks.some((t) => t.state === s)) return s;
  return 'pending';
}

const ZONE_ORDER: TaskState[] = ['disputed', 'under_review', 'active', 'blocked', 'pending'];

/** "3/5 verified", or null for an empty zone. */
export function zoneProgress(tasks: Task[]): string | null {
  if (tasks.length === 0) return null;
  return `${tasks.filter((t) => t.state === 'verified').length}/${tasks.length} verified`;
}

export const ZONE_LABEL: Record<Zone, string> = {
  track_bed: 'Track Bed',
  south_platform: 'South Platform',
  north_platform: 'North Platform',
  mezzanine: 'Mezzanine',
  escalator_well: 'Escalator Well',
};

/**
 * Box geometry for the 3D station. Five boxes, roughly arranged like a station
 * section: track at the bottom, platforms either side, mezzanine above, and the
 * escalator well cutting between them.
 */
export const ZONE_BOXES: Record<
  Zone,
  { position: [number, number, number]; size: [number, number, number] }
> = {
  track_bed: { position: [0, 0, 0], size: [12, 0.6, 3] },
  south_platform: { position: [0, 0.9, 3], size: [12, 1.2, 2.6] },
  north_platform: { position: [0, 0.9, -3], size: [12, 1.2, 2.6] },
  mezzanine: { position: [0, 4, 0], size: [9, 0.8, 7] },
  escalator_well: { position: [4.2, 2.4, 1.6], size: [2.4, 3.6, 2.4] },
};
