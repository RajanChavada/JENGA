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
    chip: 'border-blue-400/40 bg-blue-950/40 text-blue-200',
    hex: '#3b82f6',
    wireframe: true,
    opacity: 0.3,
    pulse: false,
  },
  active: {
    label: 'Active',
    chip: 'border-cyan-400/60 bg-cyan-950/40 text-cyan-200',
    hex: '#22d3ee',
    wireframe: true,
    opacity: 0.85,
    pulse: false,
  },
  under_review: {
    label: 'Under review',
    chip: 'border-amber-400 bg-amber-950/50 text-amber-200',
    hex: '#f59e0b',
    wireframe: false,
    opacity: 0.95,
    pulse: true,
  },
  verified: {
    label: 'Verified',
    chip: 'border-stone-400/60 bg-stone-800/60 text-stone-200',
    hex: '#a8a29e',
    wireframe: false,
    opacity: 1,
    pulse: false,
  },
  disputed: {
    label: 'Disputed',
    chip: 'border-red-500 bg-red-950/50 text-red-200',
    hex: '#ef4444',
    wireframe: true,
    opacity: 1,
    pulse: false,
  },
  blocked: {
    label: 'Blocked',
    chip: 'border-neutral-600 bg-neutral-900/60 text-neutral-400',
    hex: '#4b5563',
    wireframe: false,
    opacity: 0.2,
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
