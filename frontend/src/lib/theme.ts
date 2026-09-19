import type { TaskState, Zone } from './types';

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
 * A zone shows its most alarming task. Disputed beats under_review beats the
 * rest, so a problem is never hidden behind a neighbouring green box.
 */
const SEVERITY: TaskState[] = [
  'disputed',
  'under_review',
  'blocked',
  'active',
  'pending',
  'verified',
];

export function aggregateZoneState(states: TaskState[]): TaskState {
  for (const s of SEVERITY) if (states.includes(s)) return s;
  return 'pending';
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
