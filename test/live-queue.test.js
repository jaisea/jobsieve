/**
 * The queue the page is matched against.
 *
 * The report is written when a scan finishes, so on its own it is a photograph. A
 * job restored from Turned down afterwards was open in the data and missing from
 * the app: not on the page, not in the count. The server now works out what is open
 * from the live data and hands the page the cards it lacks, rendered by the same
 * template the report uses.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { p, readJson } from '../src/util.js';
import { normalize } from '../src/normalize.js';
import { score } from '../src/score.js';
import { renderQueue } from '../src/report.js';
import * as store from '../src/store.js';
import * as queue from '../src/queue.js';

const profile = readJson(p('config', 'examples', 'devops.profile.json'));
const NOW = Date.parse('2026-10-01T12:00:00Z');
const serve = readFileSync(p('src', 'serve.js'), 'utf8');

const job = (title, company) => normalize({
  source: 'manual', sourceLabel: 'Added by you', sourceId: `https://jobs.example.com/${company}`,
  title, company, location: 'München',
  descriptionText: 'Kubernetes, Terraform, Azure und CI/CD. Sehr gute Deutschkenntnisse sind von Vorteil.',
  descriptionHtml: '', applyUrl: `https://jobs.example.com/${company}`, postedAt: null,
}, profile);

/** What serve.js does to a job before rendering it. */
const asServed = (j, state) => ({
  ...j, ...score(j, profile),
  band: 'main', status: state.seen[j.fingerprint].status, firstSeen: state.seen[j.fingerprint].firstSeen, carried: true,
});

function twoJobs() {
  const state = { seen: {}, jobs: {} };
  const a = job('Senior DevOps Engineer (m/w/d)', 'Alpha GmbH');
  const b = job('Site Reliability Engineer (m/w/d)', 'Beta GmbH');
  for (const j of [a, b]) {
    state.jobs[j.fingerprint] = j;
    state.seen[j.fingerprint] = { status: 'shown', firstSeen: new Date(NOW - 86400000).toISOString(), title: j.title, company: j.company };
  }
  return { state, a, b };
}

test('every open job is listed by id, and a card is rendered only for those the page lacks', () => {
  const { state, a, b } = twoJobs();
  const open = queue.openJobs(state, NOW).map((j) => asServed(j, state));

  const all = renderQueue(open, profile);
  assert.deepEqual(all.ids.sort(), [a.fingerprint.slice(0, 8), b.fingerprint.slice(0, 8)].sort());
  assert.equal(all.jobs.length, 2);

  const have = new Set([a.fingerprint.slice(0, 8)]);
  const delta = renderQueue(open, profile, have);
  assert.equal(delta.ids.length, 2, 'the list of open jobs is complete either way');
  assert.deepEqual(delta.jobs.map((j) => j.id), [b.fingerprint.slice(0, 8)], 'but only the missing card is rendered');

  assert.equal(renderQueue(open, profile, new Set(all.ids)).jobs.length, 0, 'a page that holds everything is sent nothing');
});

test('a rendered card is the report\'s own card, with its buttons and id', () => {
  const { state, a } = twoJobs();
  const [served] = renderQueue([asServed(a, state)], profile).jobs;
  assert.match(served.html, /^<article class="job( is-carried)?( is-partial)?"/);
  assert.match(served.html, new RegExp(`class="marks" data-id="${a.fingerprint.slice(0, 8)}"`));
  for (const status of ['applied', 'interested', 'rejected']) {
    assert.match(served.html, new RegExp(`data-status="${status}"`));
  }
  assert.match(served.html, /Alpha GmbH/);
});

test('each card names the band it belongs in, and the bands carry their titles', () => {
  const { state, a } = twoJobs();
  const out = renderQueue([asServed(a, state)], profile);
  assert.equal(out.bands.length, 4, 'strong, good, worth a look, stretch');
  assert.deepEqual(out.bands.map((b) => b.index), [0, 1, 2, 3]);
  assert.ok(out.bands.every((b) => typeof b.title === 'string' && b.title));
  assert.ok(out.jobs[0].band >= 0 && out.jobs[0].band < 4);
});

test('restoring a turned-down job puts it on the queue — the failure this was built for', () => {
  const { state, a, b } = twoJobs();
  // You turned a down. The page and the count lose it.
  store.setStatus(state, a.fingerprint, 'rejected', { reason: 'role' });
  let open = queue.openJobs(state, NOW).map((j) => j.fingerprint);
  assert.deepEqual(open, [b.fingerprint]);

  // Restore marks it interested. It is open again, and the server would send its card.
  store.setStatus(state, a.fingerprint, 'interested');
  open = queue.openJobs(state, NOW);
  assert.equal(open.length, 2);
  const served = renderQueue(open.map((j) => asServed(j, state)), profile, new Set([b.fingerprint.slice(0, 8)]));
  assert.deepEqual(served.jobs.map((j) => j.id), [a.fingerprint.slice(0, 8)]);
  assert.equal(queue.counts(state, NOW).interested, 1);
});

test('a restored job is not retired by the next scan, however old or however it scores', () => {
  // Restore is Interested precisely so this holds: the carry-forward ages a `shown`
  // role out after the window and rejudge() retires one the rules now reject, but
  // neither touches a pick.
  const old = new Date(NOW - 90 * 86400000).toISOString();
  assert.equal(queue.carries({ status: 'shown', firstSeen: old }, NOW), false);
  assert.equal(queue.carries({ status: 'interested', firstSeen: old }, NOW), true);
  assert.equal(queue.isOpen({ status: 'interested', firstSeen: old }, { verdict: { decision: 'drop' } }, NOW), true);
  assert.equal(queue.isOpen({ status: 'shown', firstSeen: old }, {}, NOW), false);
});

test('the endpoint answers from live data on every call and is read-only', () => {
  assert.match(serve, /req\.method === 'GET' && url\.pathname === '\/api\/queue'/);
  const handler = serve.slice(serve.indexOf("url.pathname === '/api/queue'"), serve.indexOf("url.pathname === '/api/turned-down'"));
  assert.match(handler, /store\.load\(\)/, 'read fresh each time, not cached across calls');
  assert.match(handler, /queueStore\.openJobs\(state\)/, 'by the one shared definition of open');
  assert.match(handler, /renderQueue\(open, profile, have\)/);
  assert.doesNotMatch(handler, /store\.save|writeJson|setStatus/, 'asking what is open never changes anything');
});

test('a mark tells the app at once, so its badge does not wait for a poll', () => {
  assert.match(serve, /onChange = null/);
  assert.match(serve, /try \{ onChange\?\.\(\); \} catch/);
  const main = readFileSync(p('src', 'electron', 'main.js'), 'utf8');
  assert.match(main, /onChange: \(\) => refresh\(\)/);
});
