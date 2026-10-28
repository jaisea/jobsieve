/**
 * Comparing posting ids the way two humans would.
 *
 * The identity fix used the posting id as its second opinion: an unknown
 * fingerprint whose source:sourceId is already on file is the same posting
 * moving, not a new job. It compared the ids as exact strings, and a duplicate
 * got through that differed by ONE character — a trailing slash:
 *
 *   mailalerts:https://www.linkedin.com/comm/jobs/view/4435227908/
 *   mailalerts:https://www.linkedin.com/comm/jobs/view/4435227908
 *
 * The same LinkedIn posting, arriving from two alert emails that formatted the
 * link differently. A job already applied to came back as unseen — the exact
 * failure the id check was added to prevent, one slash below where anyone was
 * looking. It was spotted in the report.
 *
 * Query strings matter more than the slash does. LinkedIn alert links carry a
 * fresh trackingId, refId and otpToken in every email, so the raw URL is never
 * equal to itself twice.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { normaliseSourceId, reconcile } from '../src/store.js';

const LI = 'mailalerts:https://www.linkedin.com/comm/jobs/view/4435227908';

test('a trailing slash is not a different posting', () => {
  assert.equal(normaliseSourceId(`${LI}/`), normaliseSourceId(LI));
});

test('tracking parameters are not a different posting', () => {
  // Every alert email carries different ones. Without this, the same job is new
  // every single day.
  assert.equal(
    normaliseSourceId(`${LI}/?trackingId=AAA&refId=BBB&otpToken=CCC`),
    normaliseSourceId(`${LI}?trackingId=ZZZ&refId=YYY`),
  );
});

test('a fragment is not a different posting', () => {
  assert.equal(normaliseSourceId(`${LI}#apply`), normaliseSourceId(LI));
});

test('but a different posting still is', () => {
  assert.notEqual(
    normaliseSourceId('mailalerts:https://www.linkedin.com/comm/jobs/view/111'),
    normaliseSourceId('mailalerts:https://www.linkedin.com/comm/jobs/view/222'),
  );
});

test('and the same id from two sources stays two sources', () => {
  // The source prefix has to survive, or an Adzuna id could collide with a
  // JSearch one and merge two unrelated postings.
  assert.notEqual(normaliseSourceId('adzuna:5841893079'), normaliseSourceId('jsearch:5841893079'));
});

test('an empty or malformed id does not match everything', () => {
  // A Map keyed on '' would collapse every posting missing an id into one.
  assert.equal(normaliseSourceId(''), '');
  assert.equal(normaliseSourceId(null), '');
  assert.equal(normaliseSourceId(undefined), '');
});

/* ------------------------------------------------- the failure, end to end */

const blank = () => ({ seen: {}, jobs: {} });
const job = (over) => ({
  fingerprint: 'aaaa000000000000', title: '(Senior) DevOps Engineer (m/w/d)', company: 'Bäckerei Shop',
  workMode: 'remote', applyUrl: 'https://example.invalid', descriptionText: 'd',
  source: 'mailalerts', id: `${LI}/`, ...over,
});

test('the same posting with a differently formatted link does not come back', () => {
  const st = blank();
  reconcile(st, [job()]);
  st.seen['aaaa000000000000'].status = 'applied';

  // Second email: no trailing slash, and enrichment has moved the fingerprint.
  const r = reconcile(st, [job({ fingerprint: 'bbbb111111111111', id: LI })]);

  assert.equal(r.fresh.length, 0, 'it must not be reported as unseen');
  assert.equal(st.seen['aaaa000000000000'].status, 'applied');
  assert.equal(st.seen['bbbb111111111111'], undefined, 'and no duplicate record');
  assert.equal(r.drifted.length, 1, 'and the move is reported, not absorbed silently');
});

test('the stored id list does not grow a near-duplicate every run', () => {
  // Both spellings map to one posting, so the entry should not accumulate a new
  // variant each time an email formats the link differently.
  const st = blank();
  reconcile(st, [job()]);
  reconcile(st, [job({ id: LI })]);
  reconcile(st, [job({ id: `${LI}/?trackingId=NEW` })]);

  assert.equal(st.seen['aaaa000000000000'].sourceIds.length, 1);
});
