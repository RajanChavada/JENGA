// Run: node --experimental-strip-types scripts/test-focus.ts  (from frontend/)
import assert from 'node:assert/strict';
import { edgeInFocus, focusNodeIds, focusSet, focusedZone, framePose, zoneTaskIds } from '../src/lib/focus.ts';

const t = (id: string, zone: string) => ({ id, zone }) as never;
const tasks = [t('A', 'track_bed'), t('B', 'track_bed'), t('C', 'south_platform'), t('D', 'mezzanine')];
// A -> B -> C -> D, plus A -> C
const edges = [
  { source: 'A', target: 'B' },
  { source: 'B', target: 'C' },
  { source: 'C', target: 'D' },
  { source: 'A', target: 'C' },
];

// a mid-graph task frames its predecessors and successors, nothing further
assert.deepEqual([...focusSet('B', edges)].sort(), ['A', 'B', 'C']);
assert.deepEqual([...focusSet('C', edges)].sort(), ['A', 'B', 'C', 'D']);
// a root has no predecessors, a leaf no successors
assert.deepEqual([...focusSet('A', edges)].sort(), ['A', 'B', 'C']);
assert.deepEqual([...focusSet('D', edges)].sort(), ['C', 'D']);
// an isolated task frames just itself
assert.deepEqual([...focusSet('Z', edges)], ['Z']);

// zone selection frames that zone's tasks
assert.deepEqual([...zoneTaskIds('track_bed', tasks as never)].sort(), ['A', 'B']);
assert.equal(zoneTaskIds('escalator_well', tasks as never).size, 0);

// task selection wins; zone selection is the fallback; nothing selected -> null
assert.deepEqual([...focusNodeIds('D', 'track_bed', tasks as never, edges)!].sort(), ['C', 'D']);
assert.deepEqual([...focusNodeIds(null, 'track_bed', tasks as never, edges)!].sort(), ['A', 'B']);
assert.equal(focusNodeIds(null, null, tasks as never, edges), null);
// a stale selection (task no longer in the graph) frames nothing rather than crashing
assert.equal(focusNodeIds('GONE', null, tasks as never, edges), null);
// an empty zone frames nothing
assert.equal(focusNodeIds(null, 'escalator_well', tasks as never, edges), null);

// the twin frames the task's zone, else the selected zone
assert.equal(focusedZone('C', null, tasks as never), 'south_platform');
assert.equal(focusedZone('C', 'mezzanine', tasks as never), 'south_platform');
assert.equal(focusedZone(null, 'mezzanine', tasks as never), 'mezzanine');
assert.equal(focusedZone(null, null, tasks as never), null);
assert.equal(focusedZone('GONE', null, tasks as never), null);

// edges stay emphasised only when both ends are in focus
const ids = focusSet('B', edges);
assert.equal(edgeInFocus({ source: 'A', target: 'B' }, ids), true);
assert.equal(edgeInFocus({ source: 'C', target: 'D' }, ids), false);
assert.equal(edgeInFocus({ source: 'C', target: 'D' }, null), true);

// framing keeps the viewing direction, aims at the box, and respects the distance limits
const lim = { min: 8, max: 40 };
const home = [22, 17, 22] as [number, number, number];
const dirOf = (a: number[], b: number[]) => { const d = a.map((v, i) => v - b[i]); const l = Math.hypot(...d); return d.map((v) => v / l); };
const trackBed = { position: [0, 0, 0] as [number, number, number], size: [12, 0.6, 3] as [number, number, number] };
const well = { position: [4.2, 2.4, 1.6] as [number, number, number], size: [2.4, 3.6, 2.4] as [number, number, number] };
const a = framePose(home, [0, 0, 0], trackBed, 40, lim);
assert.deepEqual(a.target, [0, 0, 0]);
dirOf(a.position, a.target).forEach((v, i) => assert.ok(Math.abs(v - dirOf(home, [0, 0, 0])[i]) < 1e-9, 'direction kept'));
assert.ok(a.distance > lim.min && a.distance < Math.hypot(...home), 'closer than the default view but not at the limit');
// a smaller zone is framed closer, and is still aimed at its own centre
const b = framePose(home, [0, 0, 0], well, 40, lim);
assert.ok(b.distance >= lim.min && b.distance < a.distance, 'small zone is framed closer than a long one');
assert.deepEqual(b.target, well.position);
// one so small it would want to be inside the minimum distance is clamped to it
assert.equal(framePose(home, [0, 0, 0], { position: [0, 0, 0], size: [1, 1, 1] }, 40, lim).distance, lim.min);
dirOf(b.position, b.target).forEach((v, i) => assert.ok(Math.abs(v - dirOf(home, [0, 0, 0])[i]) < 1e-9));
// an already-orbited viewpoint keeps ITS direction, not the default one
const orbited = [-15, 4, 10] as [number, number, number];
const c = framePose(orbited, [0, 0, 0], trackBed, 40, lim);
dirOf(c.position, c.target).forEach((v, i) => assert.ok(Math.abs(v - dirOf(orbited, [0, 0, 0])[i]) < 1e-9, 'orbited direction kept'));
// far zones cap at the maximum, and a camera sitting exactly on its target still gets a direction
assert.equal(framePose(home, [0, 0, 0], { position: [0, 0, 0], size: [200, 200, 200] }, 40, lim).distance, lim.max);
assert.ok(Number.isFinite(framePose([1, 1, 1], [1, 1, 1], trackBed, 40, lim).position[0]));

console.log('All focus checks passed');
