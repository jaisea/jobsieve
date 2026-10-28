/**
 * The list of jobs you turned down by hand.
 *
 * A card leaves the queue the moment it is marked, so the page needs a place that
 * still says what you did. The rejection block at the foot of the report is not
 * it — that one lists what the gates threw away, from rejected.json, and a job
 * rejected by hand lives only in seen.json.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { p } from '../src/util.js';
import { turnedDown } from '../src/store.js';

const NOW = Date.parse('2026-10-01T12:00:00Z');
const daysAgo = (n) => new Date(NOW - n * 86400000).toISOString();
const entry = (status, n, extra = {}) => ({ status, statusChangedAt: daysAgo(n), title: `T-${status}-${n}`, company: 'Co', ...extra });

test('lists rejected and hidden jobs from the last 30 days, newest first', () => {
  const state = { seen: {
    aaaaaaaa1111: entry('rejected', 5, { rejectedReason: 'language' }),
    bbbbbbbb2222: entry('hidden', 1),
    cccccccc3333: entry('rejected', 29),
  } };
  const rows = turnedDown(state, { now: NOW });
  assert.deepEqual(rows.map((r) => r.id), ['bbbbbbbb', 'aaaaaaaa', 'cccccccc']);
  assert.equal(rows[1].reason, 'language');
  assert.equal(rows[0].reason, null);
});

test('leaves out everything else: open, interested, applied, and anything older', () => {
  const state = { seen: {
    aaaaaaaa1111: entry('shown', 1),
    bbbbbbbb2222: entry('new', 1),
    cccccccc3333: entry('interested', 1),
    dddddddd4444: entry('applied', 1),
    eeeeeeee5555: entry('rejected', 31),
  } };
  assert.deepEqual(turnedDown(state, { now: NOW }), []);
});

test('an entry with no date is left out rather than shown with a blank one', () => {
  const state = { seen: { aaaaaaaa1111: { status: 'rejected', title: 'x', company: 'y' } } };
  assert.deepEqual(turnedDown(state, { now: NOW }), []);
});

test('an empty or missing index gives an empty list', () => {
  assert.deepEqual(turnedDown({ seen: {} }, { now: NOW }), []);
  assert.deepEqual(turnedDown({}, { now: NOW }), []);
});

test('the id is the same short id the cards and /api/mark use', () => {
  const state = { seen: { '0123456789abcdef': entry('rejected', 1) } };
  assert.equal(turnedDown(state, { now: NOW })[0].id, '01234567');
});

test('the server exposes it, read-only', () => {
  const src = readFileSync(p('src', 'serve.js'), 'utf8');
  assert.match(src, /req\.method === 'GET' && url\.pathname === '\/api\/turned-down'/);
  assert.match(src, /store\.turnedDown\(store\.load\(\)\)/);
});

test('a turned-down row carries the posting link, so it can be opened like any other job', () => {
  const state = {
    seen: { aaaa000000000000: { title: 'SRE', company: 'X', status: 'rejected', statusChangedAt: new Date(NOW - 1000).toISOString() } },
    jobs: { aaaa000000000000: { applyUrl: 'https://example.invalid/job/1' } },
  };
  assert.equal(turnedDown(state, { now: NOW })[0].applyUrl, 'https://example.invalid/job/1');
  assert.equal(turnedDown({ ...state, jobs: {} }, { now: NOW })[0].applyUrl, null, 'no stored posting is a missing link, not a crash');
});
