/**
 * The fingerprint moves. The decision must not.
 *
 * Identity is `sha1(company|title|locationKey)`, and locationKey is 'remote'
 * for a remote role or the city otherwise. Both halves matter, in opposite
 * directions:
 *
 *   - The 'remote' branch is load-bearing. Four of the five cross-board merges
 *     in the archive are remote roles that Adzuna, JSearch and the alert emails
 *     each place in a DIFFERENT city — eschborn, willich, duesseldorf. Keying
 *     them on the city splits every one.
 *
 *   - But workMode is DERIVED and it improves. An alert email carries no
 *     description, so the posting cannot be read as remote and is keyed on its
 *     city. When the LinkedIn guest card is fetched later the text says remote,
 *     the key becomes 'remote', and the job has a new identity.
 *
 * Five postings came back that way: three already applied to, one rejected, one
 * shown. Every stored pair had the SAME posting id, which is what these tests
 * are built on. The id cannot replace the fingerprint — a LinkedIn id never
 * equals an Adzuna id, so keying on it would double every multi-board job —
 * so it is a second opinion, not a new key. Both properties are pinned here,
 * because a fix for either one alone silently breaks the other.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { reconcile } from '../src/store.js';

const blank = () => ({ seen: {}, jobs: {} });
const job = (over) => ({
  fingerprint: 'aaaa000000000000', title: 'Site Reliability Engineer', company: 'Example',
  workMode: 'remote', applyUrl: 'https://example.invalid/1', descriptionText: 'd',
  source: 'mailalerts', id: 'mailalerts:https://www.linkedin.com/jobs/view/123', ...over,
});

test('a job whose identity moved is not reported as new', () => {
  const st = blank();
  reconcile(st, [job()]);
  st.seen['aaaa000000000000'].status = 'applied';

  // Enrichment flipped workMode, so the fingerprint is different. Same posting.
  const r = reconcile(st, [job({ fingerprint: 'bbbb111111111111' })]);

  assert.equal(r.fresh.length, 0, 'it must not come back as unseen');
  assert.equal(st.seen['aaaa000000000000'].status, 'applied', 'the decision stands');
  assert.equal(st.seen['bbbb111111111111'], undefined, 'and no second record appears');
});

test('the move is reported, not silently absorbed', () => {
  // A silent merge is how this went unnoticed for two days. It was spotted by
  // recognising a job already applied to sitting in the queue again.
  const st = blank();
  reconcile(st, [job()]);
  st.seen['aaaa000000000000'].status = 'applied';

  const r = reconcile(st, [job({ fingerprint: 'bbbb111111111111' })]);
  assert.equal(r.drifted.length, 1);
  assert.deepEqual(r.drifted[0], {
    from: 'bbbb111111111111', to: 'aaaa000000000000',
    title: 'Site Reliability Engineer', status: 'applied',
  });
});

test('the old fingerprint is remembered, so history can still be traced', () => {
  const st = blank();
  reconcile(st, [job()]);
  reconcile(st, [job({ fingerprint: 'bbbb111111111111' })]);
  assert.deepEqual(st.seen['aaaa000000000000'].alsoKnownAs, ['bbbb111111111111']);
});

test('the same job on two boards still collapses to one card', () => {
  // The property the posting id must NOT break. Two boards, two ids, one
  // fingerprint — this is what the hash is for, and it has five real cases.
  const st = blank();
  const r = reconcile(st, [
    job({ source: 'adzuna', id: 'adzuna:111' }),
    job({ source: 'jsearch', id: 'jsearch:222' }),
  ]);

  assert.equal(r.fresh.length, 1, 'one card, not two');
  const e = st.seen['aaaa000000000000'];
  assert.deepEqual(e.sources, ['adzuna', 'jsearch']);
  assert.deepEqual(e.sourceIds, ['adzuna:111', 'jsearch:222']);
  assert.deepEqual(r.drifted, [], 'two boards is not a drift');
});

test('a genuinely new posting from a known board is still new', () => {
  // The failure mode of an over-eager merge: everything from one source
  // collapsing onto the first thing that source ever produced.
  const st = blank();
  reconcile(st, [job()]);
  const r = reconcile(st, [job({
    fingerprint: 'cccc222222222222', id: 'mailalerts:https://www.linkedin.com/jobs/view/999',
    title: 'Platform Engineer',
  })]);

  assert.equal(r.fresh.length, 1, 'a different posting id is a different job');
  assert.ok(st.seen['cccc222222222222'], 'and gets its own record');
  assert.deepEqual(r.drifted, []);
});

test('a posting id filed this run can absorb a later drift in the same run', () => {
  // Both arrive together: the aggregator's copy and the enriched one. Without
  // keeping the index current inside the loop, the second creates a duplicate
  // that only the NEXT run would merge.
  const st = blank();
  const r = reconcile(st, [job(), job({ fingerprint: 'bbbb111111111111' })]);
  assert.equal(r.fresh.length, 1);
  assert.equal(st.seen['bbbb111111111111'], undefined);
});

test('reconcile does not reassign its loop variable by accident', () => {
  // `for (const job of ordered)` threw "Assignment to constant variable" the
  // first time a drift was simulated — and the whole suite passed regardless,
  // because nothing exercised the path. Adopting the old fingerprint has to
  // rewrite the job record, so the binding must stay mutable.
  const st = blank();
  assert.doesNotThrow(() => {
    reconcile(st, [job()]);
    reconcile(st, [job({ fingerprint: 'bbbb111111111111' })]);
  });
});

/**
 * And one merge event is one merge event.
 *
 * `merged` was incremented in two places for the same arrival: once when a new
 * source was added to an existing entry's provenance, and again in the
 * duplicate-this-run branch below it. A posting arriving from two sources in
 * the same run — the ordinary case the stat exists to describe — counted twice,
 * so a run reporting "32 duplicates merged" had merged 16.
 *
 * The three numbers partition the arrivals: every job is fresh, a repeat, or a
 * duplicate that collapsed onto one of those. Recording provenance is not a
 * fourth thing that also counts.
 */
test('a posting from two sources in one run is ONE merge', () => {
  const state = { seen: {}, jobs: {} };
  const arrival = (source) => ({
    fingerprint: 'aa', id: `${source}:1`, title: 'DevOps Engineer',
    company: 'X', source, descriptionText: '', score: 1,
  });

  const r = reconcile(state, [arrival('adzuna'), arrival('jsearch')]);
  assert.equal(r.fresh.length, 1, 'reported once');
  assert.equal(r.merged, 1, 'and merged once, not once per increment site');
  assert.deepEqual(state.seen.aa.sources, ['adzuna', 'jsearch'], 'provenance still recorded');
});

test('a known posting arriving from a new source is a repeat, not a merge', () => {
  const state = {
    seen: {
      bb: {
        fingerprint: 'bb', status: 'shown', sources: ['adzuna'],
        sourceIds: ['adzuna:9'], title: 'T', company: 'C', firstSeen: 'x', lastSeen: 'x',
      },
    },
    jobs: { bb: { fingerprint: 'bb' } },
  };
  const r = reconcile(state, [{
    fingerprint: 'bb', id: 'jsearch:9', title: 'T', company: 'C',
    source: 'jsearch', descriptionText: '', score: 1,
  }]);
  assert.equal(r.repeats.length, 1);
  assert.equal(r.merged, 0, 'nothing collapsed — it was already one posting');
  assert.deepEqual(state.seen.bb.sources, ['adzuna', 'jsearch']);
});
