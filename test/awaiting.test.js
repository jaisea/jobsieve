/**
 * Postings the model has not answered are held, not decided by the rules.
 *
 * A rate limit used to hand every unreached posting its rules verdict — the very
 * verdict that was uncertain enough to need the model. These pin down the queue
 * that replaces it: what is kept, when it is due again, and when it is given up.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  empty, add, resolve, entries, setHold, clearHold, isDue, resumeAt, expire, size,
  nextQuotaReset, describe, RESET_MARGIN_MS, MAX_AGE_DAYS,
} from '../src/awaiting.js';

const item = (fp, extra = {}) => ({
  job: { fingerprint: fp, title: `Job ${fp}`, company: 'Acme', source: 'adzuna', ...extra },
  uncertainties: [{ kind: 'german', question: '?' }],
  fallback: { keep: true, reason: null, category: null, reasons: [] },
});

test('a held posting keeps the whole question, not just its fingerprint', () => {
  // Its source is asleep for hours and may never return it, so a record of "what
  // owes a verdict" (pending.js) is not enough to ask the question later.
  const s = add(empty(), [item('a')], { label: 'Adzuna', reason: 'daily limit' });
  assert.equal(size(s), 1);
  const e = s.items.a;
  assert.equal(e.item.job.title, 'Job a');
  assert.equal(e.item.uncertainties[0].kind, 'german');
  assert.equal(e.label, 'Adzuna');
});

test('being refused again does not restart the fortnight', () => {
  const t0 = new Date('2026-10-01T08:00:00Z');
  const t1 = new Date('2026-10-02T08:00:00Z');
  const s = add(empty(), [item('a')], { now: t0 });
  add(s, [item('a')], { now: t1 });
  assert.equal(s.items.a.queuedAt, t0.toISOString(), 'counted from the FIRST refusal');
  assert.equal(s.items.a.lastTriedAt, t1.toISOString());
  assert.equal(s.items.a.attempts, 2);
});

test('the oldest is asked first, so nothing starves behind newer arrivals', () => {
  const s = empty();
  add(s, [item('new')], { now: new Date('2026-10-02T00:00:00Z') });
  add(s, [item('old')], { now: new Date('2026-09-30T00:00:00Z') });
  assert.deepEqual(entries(s).map((e) => e.item.job.fingerprint), ['old', 'new']);
});

test('it is due only when something waits and the hold has run out', () => {
  const now = new Date('2026-10-02T10:00:00Z');
  const s = empty();
  assert.equal(isDue(s, now), false, 'nothing waiting');

  add(s, [item('a')], { now });
  assert.equal(isDue(s, now), true, 'no hold: ask on the next scan');

  setHold(s, { scope: 'day', until: new Date('2026-10-03T07:02:00Z'), now });
  assert.equal(isDue(s, now), false, 'held until the quota resets');
  assert.equal(resumeAt(s, now).toISOString(), '2026-10-03T07:02:00.000Z');
  assert.equal(isDue(s, new Date('2026-10-03T07:02:00Z')), true, 'and due the moment it has');

  clearHold(s);
  assert.equal(isDue(s, now), true);
  assert.equal(resumeAt(s, now), null);
});

test('a posting that has its verdict leaves the queue', () => {
  const s = add(empty(), [item('a'), item('b')]);
  resolve(s, ['a']);
  assert.deepEqual(Object.keys(s.items), ['b']);
});

test('nothing waits for ever: past the limit it is handed back to be decided openly', () => {
  const now = new Date('2026-10-20T00:00:00Z');
  const s = empty();
  add(s, [item('stale')], { now: new Date(now.getTime() - (MAX_AGE_DAYS + 1) * 86400000) });
  add(s, [item('fresh')], { now });
  const gone = expire(s, { now });
  assert.deepEqual(gone.map((e) => e.item.job.fingerprint), ['stale']);
  assert.deepEqual(Object.keys(s.items), ['fresh']);
});

/* ---- when the daily quota resets ---- */

test('the daily quota resets at midnight Pacific — 09:00 in Germany in summer', () => {
  // 2026-10-02 12:00Z is 05:00 PDT; the next Pacific midnight is 00:00 PDT on the
  // 3rd = 07:00Z = 09:00 CEST.
  const at = nextQuotaReset(new Date('2026-10-02T12:00:00Z'));
  assert.equal(at.toISOString(), new Date(Date.parse('2026-10-03T07:00:00Z') + RESET_MARGIN_MS).toISOString());
});

test('...and at 08:00Z in winter, because Pacific time moves', () => {
  // 2026-12-01 12:00Z is 04:00 PST; midnight PST on the 2nd is 08:00Z = 09:00 CET.
  const at = nextQuotaReset(new Date('2026-12-01T12:00:00Z'));
  assert.equal(at.toISOString(), new Date(Date.parse('2026-12-02T08:00:00Z') + RESET_MARGIN_MS).toISOString());
});

test('just after the reset, the NEXT one is a day away, not now', () => {
  // 07:01Z on the 3rd is 00:01 PDT: the quota reset a minute ago.
  const now = new Date('2026-10-03T07:01:00Z');
  const at = nextQuotaReset(now);
  assert.ok(at - now > 23 * 3600000, `expected about a day ahead, got ${(at - now) / 3600000}h`);
});

test('across the autumn clock change the offset is read at the target, not at now', () => {
  // 2026-11-01 08:30Z is 01:30 PDT — the hour that repeats at 02:00 as PDT -> PST.
  // The next midnight (Nov 2, 00:00 PST) is 08:00Z, not the 07:00Z that using
  // today's offset would give.
  const at = nextQuotaReset(new Date('2026-11-01T08:30:00Z'));
  assert.equal(at.toISOString(), new Date(Date.parse('2026-11-02T08:00:00Z') + RESET_MARGIN_MS).toISOString());
});

/* ---- what it says ---- */

test('it says why it is waiting and when it will carry on', () => {
  const now = new Date('2026-10-02T08:00:00');
  const s = add(empty(), [item('a'), item('b')], { now });
  setHold(s, { scope: 'day', until: new Date('2026-10-02T09:02:00'), now });
  const d = describe(s, now);
  assert.equal(d.waiting, 2);
  assert.equal(d.scope, 'day');
  assert.match(d.text, /^2 postings waiting for the AI — daily limit reached, resumes about 09:02$/);

  setHold(s, { scope: 'minute', until: new Date('2026-10-02T08:03:00'), now });
  assert.match(describe(s, now).text, /rate limited, retrying about 08:03/);
});

test('with nothing waiting it says nothing at all', () => {
  assert.deepEqual(describe(empty()), { waiting: 0, scope: null, resumeAt: null, text: '' });
});

test('a lone posting is singular, and a past hold reads as "next scan"', () => {
  const now = new Date('2026-10-02T10:00:00');
  const s = add(empty(), [item('a')], { now });
  setHold(s, { scope: 'day', until: new Date('2026-10-02T09:02:00'), now });
  assert.equal(describe(s, now).text, '1 posting waiting for the AI — will be judged on the next scan');
});
