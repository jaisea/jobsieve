/**
 * Postings the title has already settled are recognised, not re-analysed.
 *
 * Phase 1.1 drops 78% of everything fetched on its TITLE. Each of those postings was fully
 * analysed every scan — 6,088 company-board postings, about 110 seconds of single-threaded CPU
 * that froze everything else — to re-derive an answer that cannot have changed. What would make
 * it change is a gate edit, a profile edit, or the posting itself, and each of those is covered.
 */
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DIR = mkdtempSync(join(tmpdir(), 'jobhunt-titledrops-'));
process.env.JOBHUNT_DATA_DIR = DIR;
after(() => rmSync(DIR, { recursive: true, force: true }));

const td = await import('../src/titledrops.js');
const FILE = join(DIR, 'title-drops.json');
const job = (over = {}) => ({ source: 'ats', sourceId: 'greenhouse:acme:1', title: 'Account Executive', company: 'Acme', location: 'Berlin', applyUrl: 'https://x.test/1?utm=a', ...over });
const day = (iso) => new Date(`${iso}T12:00:00Z`);
const reasons = [{ id: 'relevance', certain: true }, { id: 'age', certain: false }];

beforeEach(() => rmSync(FILE, { force: true }));

/* ------------------------------------------------------------------- identity */

test('the same posting is the same key, however it is cased or padded', () => {
  assert.equal(td.keyOf(job()), td.keyOf(job({ title: '  account executive ', company: 'ACME' })));
});

test('a changed title, company, location or id is a DIFFERENT posting, analysed in full', () => {
  const base = td.keyOf(job());
  for (const over of [{ title: 'Account Executive II' }, { company: 'Beta' }, { location: 'Munich' }, { sourceId: 'greenhouse:acme:2' }]) {
    assert.notEqual(td.keyOf(job(over)), base, JSON.stringify(over));
  }
});

test('the advert text is NOT part of it — a title decision does not depend on it', () => {
  assert.equal(td.keyOf(job({ descriptionText: 'one' })), td.keyOf(job({ descriptionText: 'quite different' })));
});

test('without an id of its own the URL identifies it, minus the tracking query that changes in every email', () => {
  const a = job({ sourceId: undefined, applyUrl: 'https://l.test/jobs/view/42?trackingId=aaa' });
  const b = job({ sourceId: undefined, applyUrl: 'https://l.test/jobs/view/42?trackingId=bbb' });
  assert.equal(td.keyOf(a), td.keyOf(b));
  assert.notEqual(td.keyOf(a), td.keyOf(job({ sourceId: undefined, applyUrl: 'https://l.test/jobs/view/43' })));
});

/* ----------------------------------------------------------------- recognising */

test('a posting settled on its title is recognised on the next scan', () => {
  const memo = td.load({ rules: 'r1' });
  assert.equal(td.lookup(memo, job()), null, 'unknown the first time');
  td.remember(memo, job(), { reason: 'excluded title term: account executive', reasons, now: day('2026-10-02') });
  const hit = td.lookup(memo, job(), { now: day('2026-10-03') });
  assert.equal(hit.reason, 'excluded title term: account executive');
  assert.deepEqual(td.reasonsOf(hit), reasons, 'with the gates it failed, so the per-gate counts stay whole');
});

test('after a few days it is analysed in full again, which keeps its archive entry alive', () => {
  const memo = td.load({ rules: 'r1' });
  td.remember(memo, job(), { reason: 'x', reasons, now: day('2026-10-01') });
  assert.ok(td.lookup(memo, job(), { now: day('2026-10-03') }), 'two days: trusted');
  assert.equal(td.lookup(memo, job(), { now: day('2026-10-05') }), null, `${td.REEVALUATE_DAYS}+ days: analysed again`);
});

/* ------------------------------------------------------------ what invalidates it */

test('a change to the rules or the profile discards every entry', () => {
  const memo = td.load({ rules: 'r1' });
  td.remember(memo, job(), { reason: 'x', reasons });
  td.save(memo);
  assert.ok(td.lookup(td.load({ rules: 'r1' }), job()), 'same rules: kept');
  const changed = td.load({ rules: 'r2' });
  assert.equal(td.lookup(changed, job()), null, 'new rules: nothing is trusted');
  assert.deepEqual(changed.drops, {});
});

test('a file from before the memo existed, or a damaged one, is simply empty', () => {
  assert.deepEqual(td.load({ rules: 'r1' }).drops, {});
  writeFileSync(FILE, '{"not":"ours"}');
  assert.deepEqual(td.load({ rules: 'r1' }).drops, {});
});

/* ------------------------------------------------------------------- the file */

test('what is no longer listed is forgotten, and nothing is written when nothing changed', () => {
  const memo = td.load({ rules: 'r1' });
  td.remember(memo, job(), { reason: 'x', reasons, now: day('2026-10-01') });
  td.remember(memo, job({ sourceId: 'b', title: 'Sales Manager' }), { reason: 'y', reasons, now: day('2026-10-01') });
  td.save(memo, { now: day('2026-10-02') });
  assert.equal(Object.keys(JSON.parse(readFileSync(FILE, 'utf8')).drops).length, 2);

  // The second posting is listed (and analysed again) on the 9th; the first is not listed at all.
  const later = td.load({ rules: 'r1' });
  td.remember(later, job({ sourceId: 'b', title: 'Sales Manager' }), { reason: 'y', reasons, now: day('2026-10-09') });
  td.save(later, { now: day('2026-10-09') });
  assert.equal(Object.keys(JSON.parse(readFileSync(FILE, 'utf8')).drops).length, 1, 'the one nobody listed for a week is gone');

  const quiet = td.load({ rules: 'r1' });
  assert.equal(td.save(quiet, { now: day('2026-10-09') }), false, 'an untouched memo writes nothing');
});

test('the file is compact: [gate, certain] pairs, no postings', () => {
  const memo = td.load({ rules: 'r1' });
  td.remember(memo, job({ description: 'a very long advert '.repeat(200) }), { reason: 'x', reasons });
  td.save(memo);
  const raw = readFileSync(FILE, 'utf8');
  assert.ok(raw.length < 500, `a few hundred bytes, got ${raw.length}`);
  assert.ok(!raw.includes('advert'));
  assert.ok(existsSync(FILE));
});
