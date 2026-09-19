// Run: node --experimental-strip-types scripts/test-zones.ts  (from frontend/)
import assert from 'node:assert/strict';
import { deniedTaskIds, isDenied, zoneProgress, zoneVisual } from '../src/lib/theme.ts';

const task = (id: string, state: string) => ({ id, state }) as never;
const report = (task_id: string, owner_decision: string) => ({ task_id, owner_decision }) as never;
const none = new Set<string>();

// completed work shows only when nothing is left; active outranks blocked
assert.equal(zoneVisual([task('a', 'verified'), task('b', 'verified')], none), 'verified');
assert.equal(zoneVisual([task('a', 'verified'), task('b', 'active'), task('c', 'blocked')], none), 'active');
assert.equal(zoneVisual([task('a', 'blocked'), task('b', 'pending')], none), 'blocked');
assert.equal(zoneVisual([task('a', 'active'), task('b', 'under_review')], none), 'under_review');
assert.equal(zoneVisual([task('a', 'active'), task('b', 'disputed')], none), 'disputed');
assert.equal(zoneVisual([], none), 'pending');

// a denied task turns its zone red, above everything else
const t = [task('a', 'active'), task('b', 'disputed')];
assert.equal(zoneVisual(t, new Set(['a'])), 'denied');

// denied = active + latest report rejected; clears on resubmit and on approve
const a = task('a', 'active');
assert.equal(isDenied(a, [report('a', 'rejected')]), true);
assert.equal(isDenied(a, [report('a', 'rejected'), report('a', 'pending')]), false);
assert.equal(isDenied(task('a', 'under_review'), [report('a', 'rejected')]), false);
assert.equal(isDenied(task('a', 'verified'), [report('a', 'rejected'), report('a', 'approved')]), false);
assert.deepEqual([...deniedTaskIds([a, task('b', 'active')], [report('a', 'rejected')])], ['a']);

assert.equal(zoneProgress([task('a', 'verified'), task('b', 'active'), task('c', 'blocked')]), '1/3 verified');
assert.equal(zoneProgress([]), null);
console.log('All zone checks passed');
