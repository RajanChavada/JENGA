import type { GraphEdge, Task, Zone } from './types';

/**
 * Selection focus: what the three views frame when something is selected.
 * Pure on purpose, so the rules can be checked without React or a canvas.
 */

/** Where a selection came from. A graph click must not re-zoom the graph. */
export type FocusOrigin = 'schedule' | 'graph' | 'twin';

/** The task plus the tasks it depends on and the tasks it unblocks. */
export function focusSet(taskId: string, edges: GraphEdge[]): Set<string> {
  const ids = new Set([taskId]);
  for (const e of edges) {
    if (e.target === taskId) ids.add(e.source);
    if (e.source === taskId) ids.add(e.target);
  }
  return ids;
}

export function zoneTaskIds(zone: Zone, tasks: Task[]): Set<string> {
  return new Set(tasks.filter((t) => t.zone === zone).map((t) => t.id));
}

/** The nodes to frame for the current selection, or null when nothing is selected. */
export function focusNodeIds(
  selectedTaskId: string | null,
  selectedZone: Zone | null,
  tasks: Task[],
  edges: GraphEdge[],
): Set<string> | null {
  if (selectedTaskId && tasks.some((t) => t.id === selectedTaskId)) {
    return focusSet(selectedTaskId, edges);
  }
  if (selectedZone) {
    const ids = zoneTaskIds(selectedZone, tasks);
    return ids.size > 0 ? ids : null;
  }
  return null;
}

/** The zone the twin should frame: the selected task's zone, else the selected zone. */
export function focusedZone(
  selectedTaskId: string | null,
  selectedZone: Zone | null,
  tasks: Task[],
): Zone | null {
  if (selectedTaskId) return tasks.find((t) => t.id === selectedTaskId)?.zone ?? null;
  return selectedZone;
}

/** An edge is part of the focus when both its ends are. */
export function edgeInFocus(e: GraphEdge, ids: Set<string> | null): boolean {
  return !ids || (ids.has(e.source) && ids.has(e.target));
}

type V3 = [number, number, number];

/**
 * Where to put the camera to frame a box, looking along the direction the user
 * is already looking. The angle is kept (only the target and the distance
 * change), which is what a library `fitToBox` does not do: it snaps to the
 * nearest axis. The distance comes from the box's bounding sphere so it holds at
 * any angle, with a margin so labels and the neighbouring zones keep some room.
 */
export function framePose(
  camera: V3,
  target: V3,
  box: { position: V3; size: V3 },
  fovDegrees: number,
  limits: { min: number; max: number },
  margin = 1.25,
): { position: V3; target: V3; distance: number } {
  let d: V3 = [camera[0] - target[0], camera[1] - target[1], camera[2] - target[2]];
  let len = Math.hypot(...d);
  if (len < 1e-6) {
    d = [1, 1, 1];
    len = Math.hypot(...d);
  }
  const dir: V3 = [d[0] / len, d[1] / len, d[2] / len];
  const radius = 0.5 * Math.hypot(...box.size);
  const fit = (radius / Math.sin((fovDegrees * Math.PI) / 360)) * margin;
  const distance = Math.min(limits.max, Math.max(limits.min, fit));
  const c = box.position;
  return {
    position: [c[0] + dir[0] * distance, c[1] + dir[1] * distance, c[2] + dir[2] * distance],
    target: [c[0], c[1], c[2]],
    distance,
  };
}
