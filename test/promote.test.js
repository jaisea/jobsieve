/**
 * Taking a job back off the reject pile.
 *
 * Two Roche postings in the review list were worth applying to, and the list
 * gave no way to act: the rows showed a title, a company and a
 * reason, and nothing else — no id to pass to `npm run apply`, and no button.
 *
 * The awkward part is structural. A rejection lives in rejected.json and is
 * deliberately kept OUT of seen.json, because that index suppresses
 * re-reporting and a rejected job must be re-fetched and re-judged every run for
 * a rule edit to take effect. So a rejection has no record anywhere the report
 * can render, and "I want this one anyway" had nowhere to write itself.
 *
 * promote() copies the archived record into the live set and stamps a verdict
 * the rules cannot overturn. Three things then have to hold, and each has been
 * wrong in some earlier version of this project:
 *
 *   - the next run must not drop it again
 *   - "Mark all reviewed" must not bury it
 *   - it must be findable, which means the top of the page, because a posting a
 *     gate caught almost always scores badly
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { p } from '../src/util.js';
import { promote, setStatus } from '../src/store.js';
import * as rejects from '../src/rejects.js';

const INDEX = readFileSync(p('src', 'index.js'), 'utf8');
const REPORT = readFileSync(p('src', 'report.js'), 'utf8');

const entry = () => ({
  fingerprint: 'aaaa000000000000',
  title: 'DevOps Infrastructure Engineer',
  company: 'Roche',
  location: 'Shanghai',
  applyUrl: 'https://example.invalid/job',
  source: 'workday',
  excerpt: 'A short archived excerpt of the advert.',
  reason: 'requires programming/dev proficiency (python)',
  category: 'programming',
  firstRejected: '2026-08-01T00:00:00.000Z',
  lastRejected: '2026-08-20T00:00:00.000Z',
});

const blank = () => ({ seen: {}, jobs: {} });

test('a promoted rejection becomes a job the report can render', () => {
  const state = blank();
  promote(state, entry());
  const j = state.jobs.aaaa000000000000;

  assert.ok(j, 'it must exist in jobs.json');
  assert.equal(j.title, 'DevOps Infrastructure Engineer');
  assert.ok(state.seen.aaaa000000000000, 'and be tracked in seen.json');
});

test('the excerpt becomes the description, so there is something to read', () => {
  // The archive stores a 1200-character excerpt rather than the full advert.
  // Promoting without it produced a card with an empty body.
  const state = blank();
  promote(state, entry());
  assert.equal(state.jobs.aaaa000000000000.descriptionText, 'A short archived excerpt of the advert.');
});

test('the rules cannot overturn it on the next run', () => {
  // `source: 'user'` is the record that the user read the posting and disagreed with a
  // gate. rejudge() also holds anything marked interested, and both paths matter
  // — the verdict survives a report rebuild, the status survives a re-judge.
  const state = blank();
  promote(state, entry());
  const v = state.jobs.aaaa000000000000.verdict;
  assert.equal(v.decision, 'keep');
  assert.equal(v.source, 'user');

  assert.match(INDEX, /const held = state\.seen\[j\.fingerprint\]\?\.status === 'interested'/,
    'rejudge must hold an interested posting against the gates');
});

test('the archive entry is left alone', () => {
  // It is the audit trail of what the gates did. Deleting it would lose the
  // record that the rules got this one wrong, which is the thing worth keeping.
  const state = blank();
  const e = entry();
  promote(state, e);
  assert.equal(e.reason, 'requires programming/dev proficiency (python)');
  assert.equal(e.category, 'programming');
});

test('"Mark all reviewed" does not touch the user\'s pick', () => {
  // The two live in different files, which is what makes this safe — but it was
  // worth asserting, because the review list and the live set are otherwise
  // easy to confuse.
  const state = blank();
  promote(state, entry());
  setStatus(state, 'aaaa000000000000', 'interested');

  const archive = { aaaa000000000000: entry() };
  rejects.markReviewed(archive, 'all');

  assert.equal(state.seen.aaaa000000000000.status, 'interested');
  assert.ok(state.jobs.aaaa000000000000);
});

test('a promoted posting stops being asked about in the review list', () => {
  // `answeredBy` is wider than `decidedBy` on purpose: the user has answered for an
  // interested posting, so the list must stop asking whether the filter erred.
  // It moved to rejections-page.js so the server can render the list too.
  const decl = readFileSync(p('src', 'rejections-page.js'), 'utf8')
    .match(/const answeredBy = \(state\) =>[\s\S]*?\n\);/)[0];
  const statuses = [...decl.matchAll(/'([a-z]+)'/g)].map((m) => m[1]).sort();
  assert.deepEqual(statuses, ['applied', 'hidden', 'interested', 'rejected']);
});

test('but it is still judged — answered is not the same as settled', () => {
  // decidedBy stops the model being asked. An interested posting still needs a
  // verdict: the user has said they want it, not that they know everything about it.
  const decl = INDEX.match(/const decidedBy = \(state\) =>[\s\S]*?\n\);/)[0];
  const statuses = [...decl.matchAll(/'([a-z]+)'/g)].map((m) => m[1]).sort();
  assert.deepEqual(statuses, ['applied', 'hidden', 'rejected'],
    'interested must NOT be here, or the model stops being asked about it');
});

test('the user\'s picks sort above everything, whatever they score', () => {
  // A posting a gate caught almost always scores badly — that is why it was
  // caught. Ranking on score alone buries the one job on the page the user has
  // already said they want.
  const state = { seen: { pick: { status: 'interested' }, hi: { status: 'shown' } }, jobs: {} };
  const src = INDEX.match(/const pickedFirst = \(state\) =>[\s\S]*?\n};/)[0];
  // eslint-disable-next-line no-new-func
  const pickedFirst = new Function(`${src}; return pickedFirst;`)();

  const jobs = [
    { fingerprint: 'hi', score: 95 },
    { fingerprint: 'pick', score: 12 },
  ].sort(pickedFirst(state));

  assert.deepEqual(jobs.map((j) => j.fingerprint), ['pick', 'hi']);
});

/* ------------------------------------------------------------ the review row */

test('every review row carries its id and a button', () => {
  // The row used to show a title, a company and a reason. Wanting one of them
  // meant having no handle on it at all.
  assert.match(REPORT, /<code class="rej-id"/, 'the id, for npm run apply');
  assert.match(REPORT, /class="marks rej-marks"/, 'and a button that posts a status');
  assert.match(REPORT, /data-status="interested"[\s\S]{0,160}Want it/, 'labelled for what it does');
});

test('the server accepts an id that is only in the rejections', () => {
  // resolveFingerprint reads seen.json, and a rejection is deliberately absent
  // from it — so the button 404'd until the server learned to look in the
  // archive and promote what it finds.
  const serve = readFileSync(p('src', 'serve.js'), 'utf8');
  const block = serve.slice(serve.indexOf('let fp = store.resolveFingerprint'), serve.indexOf('store.setStatus'));
  assert.match(block, /rejects\.load\(\)/, 'it must look in the archive');
  assert.match(block, /store\.promote\(state, hit\)/, 'and promote what it finds');
});

/**
 * The guarantee promote() documents is now the one rejudge() implements.
 *
 * Both promote() and addManual() say `verdict.source === 'user'` is what stops
 * a later run retiring the job. rejudge() checked only
 * `status === 'interested'`, so the promise held by accident: addManual() sets
 * that status itself, and promote() survived only because serve.js happens to
 * pair it with a setStatus call. That is the caller's habit, not a guarantee —
 * a promoted job whose status stayed `new` would have been retired by the next
 * run, which is precisely what promoting it was meant to prevent.
 */
test('rejudge holds a job on the user verdict, not only on the status', () => {
  const index = readFileSync(p('src', 'index.js'), 'utf8');
  const held = index.slice(index.indexOf('const held = state.seen[j.fingerprint]'));
  assert.match(held.slice(0, 200), /status === 'interested'/);
  assert.match(held.slice(0, 200), /j\.verdict\?\.source === 'user'/,
    'a user verdict must hold the job on its own');
});

test('promote() and addManual() both stamp the thing that protects them', () => {
  const store = readFileSync(p('src', 'store.js'), 'utf8');
  const promote = store.slice(store.indexOf('export function promote'), store.indexOf('export function addManual'));
  const manual = store.slice(store.indexOf('export function addManual'), store.indexOf('export function setStatus'));
  for (const [name, body] of [['promote', promote], ['addManual', manual]]) {
    assert.match(body, /source: 'user'/, `${name} must stamp the verdict it relies on`);
  }
});
