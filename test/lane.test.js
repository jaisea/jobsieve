/**
 * The join between fetching and judging.
 *
 * What matters about it is what it refuses to do: reorder, run two jobs at once,
 * let the fetch side run away from a slow judge, or let a failed save go
 * unnoticed while more sources are fetched for it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { lane } from '../src/lane.js';

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

test('jobs are worked on strictly in the order pushed, one at a time', async () => {
  const log = [];
  let running = 0;
  let overlapped = false;
  const l = lane(async (n) => {
    running++;
    if (running > 1) overlapped = true;
    log.push(`start ${n}`);
    await tick(n === 1 ? 20 : 1);   // the first is the slowest: it must still finish first
    log.push(`end ${n}`);
    running--;
  }, { capacity: 3 });

  for (const n of [1, 2, 3]) await l.push(n);
  await l.close();

  assert.deepEqual(log, ['start 1', 'end 1', 'start 2', 'end 2', 'start 3', 'end 3']);
  assert.equal(overlapped, false, 'a save must never overlap the next');
});

test('the producer is held back while the worker is behind', async () => {
  // capacity 1: one in hand + one waiting. The third push must wait for room.
  let release;
  const gate = new Promise((r) => { release = r; });
  const started = [];
  const l = lane(async (n) => { started.push(n); await gate; }, { capacity: 1 });

  await l.push('a');                       // taken by the worker at once
  await tick();
  await l.push('b');                       // waits in the queue
  let thirdPushed = false;
  const third = l.push('c').then(() => { thirdPushed = true; });
  await tick(20);
  assert.equal(thirdPushed, false, 'a third batch must not be prepared while two are unsaved');
  assert.equal(l.depth, 1);

  release();
  await third;
  await l.close();
  assert.deepEqual(started, ['a', 'b', 'c']);
});

test('close waits for everything queued', async () => {
  const done = [];
  const l = lane(async (n) => { await tick(5); done.push(n); }, { capacity: 5 });
  for (const n of [1, 2, 3, 4]) await l.push(n);
  await l.close();
  assert.deepEqual(done, [1, 2, 3, 4]);
});

test('a failed save stops the lane, and the producer is told rather than left fetching', async () => {
  const worked = [];
  const l = lane(async (n) => {
    worked.push(n);
    if (n === 2) throw new Error('disk full');
    await tick(5);
  }, { capacity: 1 });

  await l.push(1);
  await l.push(2);
  // Whether the producer notices on its next push or at close, it must hear about it
  // — and nothing after the failure may be worked on.
  await assert.rejects(async () => { for (const n of [3, 4, 5]) await l.push(n); await l.close(); }, /disk full/);
  assert.deepEqual(worked, [1, 2], 'later batches are not saved after one failed');
});

test('a producer blocked on a full lane is released by a failure, not stuck for ever', async () => {
  let fail;
  const l = lane(() => new Promise((_, reject) => { fail = reject; }), { capacity: 1 });
  await l.push('a');
  await tick();
  await l.push('b');
  const blocked = l.push('c');
  await tick();
  fail(new Error('boom'));
  await assert.rejects(blocked, /boom/);
});

test('closing an idle lane returns at once', async () => {
  const l = lane(async () => {});
  await l.close();
});
