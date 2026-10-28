/**
 * Noticing that a gate moved.
 *
 * A gate fails by a vocabulary that stopped matching, and from outside that looks like a
 * quieter report. The comparison is per source — a half-hourly scan may read only the inbox,
 * and a changing mix would otherwise move every share with no gate touched.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { emptyTally, tally, record, shifts, describe, shiftText } from '../src/gatestats.js';

const reasons = (...ids) => ids.map((id) => ({ id, certain: !id.startsWith('~') })).map((r) => ({ ...r, id: r.id.replace('~', '') }));

/** A source of `n` postings in which `gate` drops `hard` and asks about `soft`. */
const run = (source, n, gate, hard, soft = 0) => {
  const t = emptyTally();
  for (let i = 0; i < n; i++) tally(t, source, i < hard ? reasons(gate) : i < hard + soft ? reasons('~' + gate) : []);
  return t;
};

test('a posting that passes every gate still counts, so shares are of what was judged', () => {
  const t = emptyTally();
  tally(t, 'ats', reasons('age'));
  tally(t, 'ats', []);
  assert.equal(t.sources.ats.postings, 2);
  assert.deepEqual(t.sources.ats.gates, { age: { hard: 1, soft: 0 } });
});

test('a posting that fails several gates counts under each of them', () => {
  const t = emptyTally();
  tally(t, 'ats', reasons('age', '~relevance', 'stack'));
  assert.deepEqual(Object.keys(t.sources.ats.gates).sort(), ['age', 'relevance', 'stack']);
  assert.deepEqual(t.sources.ats.gates.relevance, { hard: 0, soft: 1 });
});

test('a gate that moved 3+ points on the same source since its last run is reported', () => {
  const state = record({ sources: {} }, run('arbeitsagentur', 1000, 'relevance', 500));
  const moved = shifts(state, run('arbeitsagentur', 1000, 'relevance', 620));
  assert.equal(moved.length, 1);
  assert.equal(moved[0].gate, 'relevance');
  assert.equal(moved[0].kind, 'hard');
  assert.match(shiftText(moved[0]), /arbeitsagentur: "relevance" drops 62% of its postings, was 50%/);
});

test('a small wobble is not news', () => {
  const state = record({ sources: {} }, run('ats', 1000, 'relevance', 500));
  assert.deepEqual(shifts(state, run('ats', 1000, 'relevance', 520)), []);
});

test('questions are watched as well as drops', () => {
  const state = record({ sources: {} }, run('ats', 1000, 'title', 0, 30));
  const moved = shifts(state, run('ats', 1000, 'title', 0, 120));
  assert.equal(moved[0].kind, 'soft');
  assert.match(shiftText(moved[0]), /asks about 12%/);
});

test('sources are never compared with each other, or with a handful of postings', () => {
  // The mix changes run to run: an inbox-only scan has a different shape from a full one.
  const state = record({ sources: {} }, run('ats', 1000, 'relevance', 900));
  assert.deepEqual(shifts(state, run('mailalerts', 1000, 'relevance', 100)), [], 'a different source has no baseline');
  assert.deepEqual(shifts(state, run('ats', 20, 'relevance', 1)), [], 'twenty postings is noise');
});

test('recording keeps the previous figures beside the new ones', () => {
  let state = record({ sources: {} }, run('ats', 100, 'age', 10), { now: new Date('2026-10-01T00:00:00Z') });
  state = record(state, run('ats', 200, 'age', 50), { now: new Date('2026-10-02T00:00:00Z') });
  assert.equal(state.sources.ats.postings, 200);
  assert.equal(state.sources.ats.previous.postings, 100);
  assert.equal(state.sources.ats.previous.at, '2026-10-01T00:00:00.000Z');
});

test('a source with nothing judged is not recorded over a real one', () => {
  const state = record({ sources: {} }, run('ats', 100, 'age', 10));
  const t = emptyTally();
  t.sources.ats = { postings: 0, gates: {} };
  assert.equal(record(state, t).sources.ats.postings, 100);
});

test('the summary line names the biggest gates', () => {
  const lines = describe(run('ats', 100, 'relevance', 40, 5));
  assert.match(lines[0], /^ats: 100 judged · relevance 40% \(\+5% asked\)$/);
});
