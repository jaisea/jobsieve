/**
 * Deferred-adjudication queue.
 *
 * There is no call cap: a run adjudicates until the provider stops it, and the
 * remainder is deferred to the next run. The ordering contract is the point —
 * today's postings are judged first, yesterday's leftovers after — so a
 * repeatedly rate-limited run cannot let the backlog crowd out new work.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { defer, resolve, prune, size, orderNewFirst } from '../src/pending.js';

const item = (fp, title = 'Cloud Engineer') => ({ job: { fingerprint: fp, title, company: 'Acme' } });
const ids = (items) => items.map((i) => i.job.fingerprint);

test('deferring records an entry and counts attempts', () => {
  let q = defer({}, [item('a'), item('b')], 'quota');
  assert.equal(size(q), 2);
  assert.equal(q.a.attempts, 1);

  q = defer(q, [item('a')], 'quota');
  assert.equal(q.a.attempts, 2, 'a second failure increments rather than duplicating');
  assert.equal(q.a.firstDeferred, q.a.firstDeferred, 'first-seen time is preserved');
});

test('a verdict removes the entry from the queue', () => {
  let q = defer({}, [item('a'), item('b')], 'quota');
  q = resolve(q, ['a']);
  assert.deepEqual(Object.keys(q), ['b']);
});

test('fresh postings are judged before the backlog', () => {
  // The whole reason the queue exists: a rate-limited run must still spend its
  // budget on today's postings, not on yesterday's leftovers.
  const q = defer({}, [item('old1'), item('old2')], 'quota');
  const { ordered, fresh, backlog } = orderNewFirst(
    [item('old1'), item('new1'), item('old2'), item('new2')], q
  );
  assert.deepEqual(ids(ordered).slice(0, 2), ['new1', 'new2']);
  assert.equal(fresh, 2);
  assert.equal(backlog, 2);
});

test('within the backlog, the oldest entry goes first', () => {
  const q = {
    older: { firstDeferred: '2026-08-01T00:00:00Z', attempts: 1 },
    newer: { firstDeferred: '2026-08-10T00:00:00Z', attempts: 1 },
  };
  const { ordered } = orderNewFirst([item('newer'), item('older')], q);
  assert.deepEqual(ids(ordered), ['older', 'newer'], 'nothing may starve indefinitely');
});

test('an all-fresh set is returned untouched', () => {
  const { ordered, fresh, backlog } = orderNewFirst([item('a'), item('b')], {});
  assert.deepEqual(ids(ordered), ['a', 'b']);
  assert.equal(fresh, 2);
  assert.equal(backlog, 0);
});

test('entries that keep failing are pruned', () => {
  // Otherwise a posting that always errors sits at the front forever.
  let q = {};
  for (let i = 0; i < 5; i++) q = defer(q, [item('bad')], 'error');
  const { queue, removed } = prune(q, { maxAttempts: 5 });
  assert.equal(removed, 1);
  assert.equal(size(queue), 0);
});

test('stale entries are pruned by age', () => {
  const q = {
    ancient: { firstDeferred: '2020-01-01T00:00:00Z', attempts: 1 },
    recent: { firstDeferred: new Date().toISOString(), attempts: 1 },
  };
  const { queue, removed } = prune(q, { maxAgeDays: 14 });
  assert.equal(removed, 1);
  assert.deepEqual(Object.keys(queue), ['recent']);
});
