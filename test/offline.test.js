/**
 * No connection is not the same as a failed fetch.
 *
 * A scan started right after sleep or login, before Wi-Fi was back, recorded every
 * source as attempted. Each went onto a 30-minute retry, and the two metered
 * sources were charged a run for requests that never left the machine — JSearch
 * gets one run a day, so one early scan could cost the whole day. Offline is now
 * asked separately and, when true, records nothing: the sources stay due and the
 * app waits for a connection rather than a timer.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { p } from '../src/util.js';
import { isOnline, PROBES } from '../src/connectivity.js';
import * as schedule from '../src/schedule.js';
import * as quota from '../src/quota.js';

const index = readFileSync(p('src', 'index.js'), 'utf8');
const main = readFileSync(p('src', 'electron', 'main.js'), 'utf8');

/** A fetch that answers per URL: a status number resolves, an Error rejects. */
const fakeFetch = (plan) => async (url, opts) => {
  const r = plan[url];
  if (r instanceof Error) throw r;
  return { status: r, body: { cancel: async () => { fakeFetch.cancelled = (fakeFetch.cancelled || 0) + 1; } }, opts };
};

/* ------------------------------------------------------------ the probe */

test('online when any probe gets any response', async () => {
  const [a, b] = ['http://a.test/', 'http://b.test/'];
  assert.equal(await isOnline({ probes: [a, b], fetchImpl: fakeFetch({ [a]: 200, [b]: 200 }) }), true);
  assert.equal(await isOnline({ probes: [a, b], fetchImpl: fakeFetch({ [a]: new Error('down'), [b]: 204 }) }), true,
    'one endpoint being down does not read as offline');
  assert.equal(await isOnline({ probes: [a, b], fetchImpl: fakeFetch({ [a]: new Error('x'), [b]: 503 }) }), true,
    'even an error status proves a server was reached');
});

test('offline only when every probe fails', async () => {
  const [a, b] = ['http://a.test/', 'http://b.test/'];
  const err = Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' });
  assert.equal(await isOnline({ probes: [a, b], fetchImpl: fakeFetch({ [a]: err, [b]: err }) }), false);
  assert.equal(await isOnline({ probes: [], fetchImpl: fakeFetch({}) }), false, 'nothing to ask means nothing proven');
});

test('a redirect counts as a response, and the body is never downloaded', async () => {
  // A hotel Wi-Fi page redirects every request. It is a server answering, which is
  // all this asks; whether the fetches then work is the sources' own business.
  let seen;
  const fetchImpl = async (url, opts) => { seen = opts; return { status: 302, body: { cancel: async () => { seen.cancelled = true; } } }; };
  assert.equal(await isOnline({ probes: ['http://a.test/'], fetchImpl }), true);
  assert.equal(seen.redirect, 'manual', 'a redirect is not followed');
  assert.ok(seen.signal instanceof AbortSignal, 'and it is bounded by a timeout');
  assert.equal(seen.cancelled, true);
});

test('a probe that never answers is cut off by the timeout', async () => {
  const hang = (url, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))));
  // AbortSignal.timeout does not keep the event loop alive, and this fake has no
  // socket to — a real fetch does. Hold the loop open so the test can finish.
  const keepAlive = setTimeout(() => {}, 5000);
  try {
    const t0 = Date.now();
    assert.equal(await isOnline({ probes: ['http://slow.test/'], timeoutMs: 80, fetchImpl: hang }), false);
    assert.ok(Date.now() - t0 < 1500, 'it gives up promptly rather than hanging the scan');
  } finally {
    clearTimeout(keepAlive);
  }
});

test('a real dead address is reported offline quickly', async () => {
  // Port 1 on localhost refuses at once — a true "no route" without touching the network.
  const t0 = Date.now();
  assert.equal(await isOnline({ probes: ['http://127.0.0.1:1/'], timeoutMs: 3000 }), false);
  assert.ok(Date.now() - t0 < 3000);
});

test('the probes are two independent hosts, the first being the one Windows itself uses', () => {
  assert.equal(PROBES.length, 2);
  assert.match(PROBES[0], /msftconnecttest\.com/);
  assert.equal(new Set(PROBES.map((u) => new URL(u).hostname)).size, 2);
});

test('the probe list can be overridden for testing, and is read when called, not at load', async () => {
  const before = process.env.JOBHUNT_CONNECTIVITY_PROBES;
  process.env.JOBHUNT_CONNECTIVITY_PROBES = 'http://127.0.0.1:1/';
  try {
    assert.equal(await isOnline({ timeoutMs: 2000 }), false, 'pointed at a dead address, the app believes it is offline');
  } finally {
    if (before === undefined) delete process.env.JOBHUNT_CONNECTIVITY_PROBES;
    else process.env.JOBHUNT_CONNECTIVITY_PROBES = before;
  }
  const src = readFileSync(p('src', 'connectivity.js'), 'utf8');
  assert.doesNotMatch(src, /^const [^\n]*process\.env/m, 'nothing reads the environment at column zero');
});

/* ------------------------------------------------------------ nothing is recorded */

const CFG = { enabled: true, sleepMinutes: 120 };
const empty = () => ({ version: 1, sources: {} });
const at = (iso) => new Date(iso);

test('an offline attempt leaves the source due — not on a 30-minute retry', () => {
  const t0 = at('2026-10-01T10:00:00Z');
  const state = schedule.commit(empty(), { ats: { cfg: CFG, failed: false, offline: true } }, { now: t0 });
  assert.deepEqual(state.sources, {}, 'nothing was written down');
  assert.equal(schedule.isDue(state, 'ats', CFG, at('2026-10-01T10:00:05Z')), true, 'still due a moment later');
});

test('a source that failed WITH a connection is still retried after 30 minutes', () => {
  const t0 = at('2026-10-01T10:00:00Z');
  const state = schedule.commit(empty(), { ats: { cfg: CFG, failed: true } }, { now: t0 });
  assert.equal(schedule.isDue(state, 'ats', CFG, at('2026-10-01T10:29:00Z')), false);
  assert.equal(schedule.isDue(state, 'ats', CFG, at('2026-10-01T10:30:00Z')), true);
});

test('offline sources in a mixed run are skipped while the others are recorded', () => {
  const t0 = at('2026-10-01T10:00:00Z');
  const state = schedule.commit(empty(), {
    mail: { cfg: CFG, failed: false },
    ats: { cfg: CFG, failed: false, offline: true },
  }, { now: t0 });
  assert.deepEqual(Object.keys(state.sources), ['mail']);
});

test('a metered source is not charged a run for a fetch that never left the machine', () => {
  // The quota is a receipt for calls that reached the API. The pipeline must not
  // write one for an offline source — and if it did, JSearch (one run a day) would
  // be refused for the rest of the day.
  const jsearch = { perMonth: 200, cycleResetsOnDay: 14, maxRunsPerDay: 1, maxQueries: 4 };
  const now = at('2026-10-05T08:00:00Z');
  const untouched = quota.budgetFor(empty(), 'jsearch', jsearch, { now });
  assert.equal(untouched.allowed, true, 'an offline run records nothing, so the budget is still there');

  const spent = quota.record(empty(), 'jsearch', jsearch, 4, { now });
  assert.equal(quota.budgetFor(spent, 'jsearch', jsearch, { now }).allowed, false, 'whereas recording it uses the day up');

  // And in the pipeline the offline branch leaves BEFORE the quota is recorded.
  const offlineAt = index.indexOf('nothingBack && (offlineSeen || !(await connectivity.isOnline()))');
  const recordAt = index.indexOf('quota.record(quotaState, key, cfg.quota');
  assert.ok(offlineAt > 0 && recordAt > offlineAt, 'the offline check comes first');
  const branch = index.slice(offlineAt, recordAt);
  assert.match(branch, /attempts\[key\]\.offline = true;/);
  assert.match(branch, /return;/, 'it leaves land() for that source, so nothing below it runs');
  assert.doesNotMatch(branch, /quota\./);
});

/* ------------------------------------------------------------ the pipeline */

test('connectivity is asked only when a source came back empty, never after a success', () => {
  assert.match(index, /const nothingBack = Boolean\(result\.errors\?\.length\) && !result\.jobs\.length;/);
  assert.match(index, /if \(nothingBack && \(offlineSeen \|\| !\(await connectivity\.isOnline\(\)\)\)\)/);
  assert.equal(index.match(/connectivity\.isOnline\(\)/g).length, 1, 'one place, and only on an empty result');
});

test('once offline is seen, the remaining sources are not tried', () => {
  assert.match(index, /let offlineSeen = false;/);
  // Sources still waiting for a slot are not started at all (the pool asks before each start;
  // test/pool.test.js pins that it does)...
  assert.match(index, /shouldSkip: \(\) => offlineSeen,\s*\n\s*onSkip: \(next\) => \{\s*\n\s*attempts\[next\.key\]\.offline = true;/);
  // The ones already in flight are taken to have failed for the same reason, with no second probe.
  assert.match(index, /nothingBack && \(offlineSeen \|\|/);
});

test('a run that could reach nothing says so, records nothing and stays due', () => {
  const at0 = index.indexOf('if (!run.fetched && !run.drained) {');
  const block = index.slice(at0, at0 + 1000);
  assert.match(block, /tried\.every\(\(a\) => a\.offline\)/);
  assert.match(block, /no internet connection — nothing was fetched/);
  assert.match(block, /commitSchedule\(\);\s*return;/);
});

test('an offline source keeps its slice of the replay snapshot', () => {
  // `continue` skips the snapshot write, and a source with no range is carried
  // from the previous snapshot — so a connection dropping mid-run does not shrink
  // what --replay judges.
  const offlineAt = index.indexOf('nothingBack && !(await connectivity.isOnline())');
  const saveAt = index.indexOf('fetched.save(slice,');
  assert.ok(saveAt > offlineAt);
});

/* ------------------------------------------------------------ the app */

test('the app waits for a connection instead of a timer, and only when something is due', () => {
  const tick = main.slice(main.indexOf('async function tick()'), main.indexOf('/** The menu\'s "scan now"'));
  const dueAt = tick.indexOf('if (!due.length && !judge)');
  const probeAt = tick.indexOf('connectivity.isOnline()');
  const scanAt = tick.indexOf("startScan('due')");
  assert.ok(dueAt > 0 && probeAt > dueAt, 'nothing due means no probe at all');
  assert.ok(scanAt > probeAt, 'and the scan starts only after the connection is confirmed');
  assert.match(tick, /offline = true;\s*refresh\(\);\s*return OFFLINE_RETRY_MS;/, 'offline: look again in seconds');
  assert.match(main, /const OFFLINE_RETRY_MS = 20000;/);
  assert.match(tick, /if \(offline\) note\('the connection is back'\);/);
});

test('waking from sleep before Wi-Fi is back is harmless', () => {
  // Resume schedules a check 30 seconds out; that check finds no connection, waits
  // 20 seconds, and scans the moment one appears — recording nothing in between.
  assert.match(main, /powerMonitor\.on\('resume', \(\) => \{\s*clearTimeout\(timer\);\s*planTick\(RESUME_TICK_MS\);/);
});

test('"scan now" is refused politely offline, and the menu says what is happening', () => {
  // The refusal is a result both the tray and the page can show their own way.
  assert.match(main, /const r = await controls\.scanNow\(\);\s*if \(!r\.ok\) toast\(r\.error\);/);
  assert.match(main, /error: 'No internet connection — try again when you are online\.'/);
  assert.match(main, /if \(offline\) return 'Offline — waiting for a connection';/);
  assert.match(main, /Will fetch as soon as a connection is back/);
});

test('pausing clears the offline state, since you asked it to stop', () => {
  const paused = main.slice(main.indexOf('if (prefs.paused) {'), main.indexOf('if (prefs.paused) {') + 90);
  assert.match(paused, /offline = false;/);
});
