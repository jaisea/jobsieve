/**
 * A job you found somewhere this tool does not reach.
 *
 * Most of a job search happens outside any tool — a link from a friend, a
 * company page with no board, a site nothing here polls. Those jobs still need
 * a tailored CV, and `apply` works off `state.jobs`, so a posting that never
 * came from a source could not be applied for at all. The only way in was to
 * wait for a source to happen to find it.
 *
 * This is promote()'s sibling: same idea, other direction. promote() takes a
 * posting the rules REJECTED and says "I want this one anyway"; addManual()
 * takes a posting the rules NEVER SAW.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { p, readJson } from '../src/util.js';
import { normalize } from '../src/normalize.js';
import * as store from '../src/store.js';

const profile = readJson(p('config', 'examples', 'devops.profile.json'));
const SERVE = readFileSync(p('src', 'serve.js'), 'utf8');
const REPORT = readFileSync(p('src', 'report.js'), 'utf8');

const typed = (over = {}) => normalize({
  source: 'manual', sourceLabel: 'Added by you',
  sourceId: 'https://jobs.example.com/devops-123',
  title: 'Senior DevOps Engineer (m/w/d)', company: 'Beispiel GmbH',
  location: 'München',
  descriptionText: 'Kubernetes, Terraform und Azure. Sehr gute Deutschkenntnisse erforderlich.',
  descriptionHtml: '', applyUrl: 'https://jobs.example.com/devops-123', postedAt: null,
  ...over,
}, profile);

const fresh = () => ({ seen: {}, jobs: {} });

test('a typed job lands in the queue, decided by you', () => {
  const state = fresh();
  const r = store.addManual(state, typed());

  assert.equal(r.existed, false);
  assert.equal(state.seen[r.fingerprint].status, 'interested',
    'you found it and kept it — that is what interested means');
  assert.equal(state.jobs[r.fingerprint].verdict.source, 'user');
  assert.equal(state.jobs[r.fingerprint].verdict.decision, 'keep');
});

test('the gates cannot retire it next run', () => {
  // verdict.source 'user' is what rejudge() refuses to overturn. Without it a
  // job typed in by hand would be dropped on the next search for failing a gate
  // its owner had already decided to ignore — which is the whole reason it was
  // typed in rather than waited for.
  const state = fresh();
  const r = store.addManual(state, typed());
  assert.equal(state.jobs[r.fingerprint].verdict.source, 'user');
  assert.match(readFileSync(p('src', 'index.js'), 'utf8'), /verdict\?\.source === 'user'|source === 'user'/,
    'rejudge must still honour a user verdict');
});

test('it is fingerprinted like any other posting', () => {
  // Normalized through the same function every source uses, so the same posting
  // arriving from a real source tomorrow collapses onto it instead of being
  // filed twice.
  const state = fresh();
  const r = store.addManual(state, typed());

  const fromASource = normalize({
    source: 'adzuna', sourceId: 'adz-1',
    title: 'Senior DevOps Engineer (m/w/d)', company: 'Beispiel GmbH',
    location: 'München', descriptionText: '', descriptionHtml: '',
    applyUrl: 'https://adzuna.example/1',
  }, profile);

  assert.equal(fromASource.fingerprint, r.fingerprint,
    'a typed job and the same job fetched later are ONE posting');
});

test('re-adding does not reopen a decision you already made', () => {
  // Pasting the link again to fix a typo must not drag an applied job back into
  // the queue.
  const state = fresh();
  const r = store.addManual(state, typed());
  store.setStatus(state, r.fingerprint, 'applied', '90.000 EUR');

  store.addManual(state, typed({ title: 'Senior DevOps Engineer (m/w/d)' }));
  assert.equal(state.seen[r.fingerprint].status, 'applied');
  assert.equal(state.seen[r.fingerprint].salaryAsked, '90.000 EUR', 'and the figure survives');
});

test('an empty description box never wipes the advert', () => {
  // The advert is the whole reason to type a job in — `apply` reads it, and a
  // cover letter written from a title alone is worth nothing. Re-adding to fix
  // a typo in the company would otherwise silently delete it.
  const state = fresh();
  const r = store.addManual(state, typed());
  const before = state.jobs[r.fingerprint].descriptionText.length;
  assert.ok(before > 0);

  store.addManual(state, typed({ descriptionText: '', company: 'Beispiel GmbH' }));
  assert.equal(state.jobs[r.fingerprint].descriptionText.length, before,
    'the advert survives an empty box');
});

test('but a new advert does replace the old one', () => {
  // You typed it deliberately. Only nothing is refused.
  const state = fresh();
  const r = store.addManual(state, typed());
  store.addManual(state, typed({ descriptionText: 'A completely different advert, pasted again.' }));
  assert.match(state.jobs[r.fingerprint].descriptionText, /completely different/);
});

/* ------------------------------------------------------------- the endpoint */

test('a title and a company are required, because the id is built from them', () => {
  // Without both, every job typed in would hash to the same fingerprint and
  // silently overwrite the last one.
  assert.match(SERVE, /a title and a company are required/);
  assert.match(SERVE, /if \(!title \|\| !company\)/);
});

test('the endpoint normalizes rather than storing what was typed', () => {
  assert.match(SERVE, /const job = normalize\(\{/);
  assert.match(SERVE, /source: 'manual'/);
});

test('the reported description length is the STORED one', () => {
  // A re-add with an empty box keeps the advert. Reporting the posted length
  // there would tell you tailoring has nothing to read when it does.
  assert.match(SERVE, /descriptionChars: \(r\.job\.descriptionText \|\| ''\)\.length/);
});

/* ---------------------------------------------------------------- the panel */

test('the form is offered only when the server is there', () => {
  // From disk the POST would go nowhere. A form that silently discards what you
  // typed is worse than no form — the same reason the source switches and the
  // applications panel start hidden.
  assert.match(REPORT, /<details class="source-toggles addjob" id="manbox" hidden>/);
  const js = REPORT.slice(REPORT.indexOf('add a job you found elsewhere'));
  assert.match(js.slice(0, 400), /if \(live\)/);
});

test('the panel asks for the advert and says why', () => {
  assert.match(REPORT, /id="m-desc"/);
  assert.match(REPORT, /id="m-url"/);
  assert.match(REPORT, /id="m-title"/);
  assert.match(REPORT, /id="m-company"/);
  assert.match(REPORT, /a cover letter written from a title alone is worth nothing/);
});

test('the answer hands back the id, because tailoring is the next step', () => {
  assert.match(REPORT, /npm run apply -- ' \+ d\.id/);
});
