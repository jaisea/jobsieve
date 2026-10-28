/**
 * The tray icon's number, and what feeds it.
 *
 * The badge has to agree with the page, and both are worked out from the live data
 * rather than from a saved list. Counting the status `new` alone would not do:
 * markShown() turns every `new` into `shown` at the end of each run, so that count
 * is always zero. "Open" is its own definition — see queue.js.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';

import { p } from '../src/util.js';
import * as queue from '../src/queue.js';
import * as daemon from '../src/daemon.js';
import { badgePng, labelFor, crc32 } from '../src/electron/badge.js';

const NOW = Date.parse('2026-10-01T12:00:00Z');
const daysAgo = (n) => new Date(NOW - n * 86400000).toISOString();

/** A state with one job per entry: `{ a: ['shown', 2, 'keep'] }` = status, days since first seen, verdict. */
const world = (spec) => {
  const state = { seen: {}, jobs: {} };
  for (const [fp, [status, age = 1, decision]] of Object.entries(spec)) {
    state.seen[fp] = { status, firstSeen: daysAgo(age) };
    state.jobs[fp] = { fingerprint: fp, ...(decision ? { verdict: { decision } } : {}) };
  }
  return state;
};

/* ------------------------------------------------------------ the count */

test('open means new, shown or interested — and nothing else', () => {
  const state = world({
    a: ['new'], b: ['shown'], c: ['interested'],
    d: ['applied'], e: ['rejected'], f: ['hidden'],
  });
  assert.deepEqual(queue.openJobs(state, NOW).map((j) => j.fingerprint).sort(), ['a', 'b', 'c']);
});

test('waiting counts new and shown; interested is counted apart', () => {
  const state = world({ a: ['new'], b: ['shown'], c: ['interested'], d: ['shown'] });
  assert.deepEqual(queue.counts(state, NOW), { waiting: 3, interested: 1 });
});

test('marking a job decided lowers the count with no new run', () => {
  assert.equal(queue.counts(world({ a: ['shown'], b: ['shown'], c: ['shown'] }), NOW).waiting, 3);
  assert.equal(queue.counts(world({ a: ['applied'], b: ['shown'], c: ['rejected'] }), NOW).waiting, 1);
  assert.equal(queue.counts(world({ a: ['hidden'], b: ['applied'], c: ['rejected'] }), NOW).waiting, 0);
});

test('a job restored from Turned down is counted at once — the failure this replaces', () => {
  // It went back to `shown` but was in neither the page nor the snapshot the
  // count was read from, so it was open in the data and invisible in the app.
  // There is no snapshot now: the count is worked out from the data.
  const before = world({ a: ['rejected'], b: ['shown'] });
  assert.equal(queue.counts(before, NOW).waiting, 1);
  const after = world({ a: ['interested'], b: ['shown'] });
  assert.deepEqual(queue.counts(after, NOW), { waiting: 1, interested: 1 });
});

test('a role the rules now reject is not open, unless you picked it', () => {
  // The same exception rejudge() makes: a gate does not overrule you.
  const state = world({ dropped: ['shown', 1, 'drop'], picked: ['interested', 1, 'drop'], kept: ['shown', 1, 'keep'], unjudged: ['shown', 1] });
  assert.deepEqual(queue.openJobs(state, NOW).map((j) => j.fingerprint).sort(), ['kept', 'picked', 'unjudged']);
});

test('a shown role fades out of the queue after the window; a new one and a pick do not', () => {
  const state = world({
    fresh: ['shown', 20], stale: ['shown', 22], brandNew: ['new', 40], picked: ['interested', 90],
  });
  assert.deepEqual(queue.openJobs(state, NOW).map((j) => j.fingerprint).sort(), ['brandNew', 'fresh', 'picked']);
});

test('a job with no record is never open', () => {
  assert.equal(queue.isOpen(undefined, { fingerprint: 'x' }, NOW), false);
  assert.deepEqual(queue.counts({ seen: {}, jobs: {} }, NOW), { waiting: 0, interested: 0 });
  assert.deepEqual(queue.counts({}, NOW), { waiting: 0, interested: 0 });
});

test('the window is one definition, shared by the search, the page and the badge', () => {
  // A second copy of 21, or of "which statuses carry", would let what the report
  // keeps and what the app counts disagree the first time someone changed one.
  const src = readFileSync(p('src', 'index.js'), 'utf8');
  assert.match(src, /queueStore\.carries\(e\)/, 'the search carries forward by the shared rule');
  assert.doesNotMatch(src, /OPEN_WINDOW_DAYS/, 'and keeps no window of its own');
  assert.equal(queue.OPEN_WINDOW_DAYS, 21);
});

test('there is no saved queue to go stale', () => {
  // data/queue.json was a snapshot of what the last report showed. It went stale
  // the moment anything changed without a new report, which is how a restored job
  // ended up open in the data and missing from the app.
  // Code only: queue.js explains this history in a comment, and should.
  const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const f of ['index.js', 'daemon.js', 'queue.js', 'serve.js', 'electron/main.js']) {
    assert.doesNotMatch(code(readFileSync(p('src', f), 'utf8')), /queue\.json|queueStore\.save|seedQueue/,
      `${f} no longer reads or writes a saved queue`);
  }
});

test('launching the tray never rebuilds the report', () => {
  // `report` re-judges the archive against today's rules. Run on first start it
  // replaced a report of open jobs with an empty one, because every carried role
  // was by then past the age gate.
  const main = readFileSync(p('src', 'electron', 'main.js'), 'utf8');
  const start = main.slice(main.indexOf('async function start()'));
  assert.doesNotMatch(start, /startScan\('report'/);
});

test('the live state is re-read only when the data files change', () => {
  const src = readFileSync(p('src', 'daemon.js'), 'utf8');
  assert.match(src, /statSync\(p\('data', f\)\)\.mtimeMs/);
  assert.match(src, /if \(cachedState\.stamp !== stamp\) cachedState = \{ stamp, state: store\.load\(\) \}/);
  assert.match(src, /export const openCounts = \(\) => queueStore\.counts\(liveState\(\)\)/);
});

test('the badge counts every open job, and an Interested one is open', () => {
  // Counting only the untouched ones hid the badge entirely while a single
  // Interested job was waiting to be applied for. It is open until you apply or
  // turn it down, and it is on the report's queue — so it is in the number.
  assert.equal(daemon.openTotal({ waiting: 0, interested: 1 }), 1);
  assert.equal(daemon.openTotal({ waiting: 4, interested: 2 }), 6);
  assert.equal(daemon.openTotal({ waiting: 0, interested: 0 }), 0, 'and it reaches zero when everything is handled');
});

test('describeOpen reads naturally at none, one, many and with picks', () => {
  assert.equal(daemon.describeOpen({ waiting: 0, interested: 0 }), 'No open jobs');
  assert.equal(daemon.describeOpen({ waiting: 1, interested: 0 }), '1 open job');
  assert.equal(daemon.describeOpen({ waiting: 12, interested: 0 }), '12 open jobs');
  assert.equal(daemon.describeOpen({ waiting: 0, interested: 3 }), '3 open jobs — interested');
  assert.equal(daemon.describeOpen({ waiting: 5, interested: 2 }), '7 open jobs — 5 waiting, 2 interested');
});

test('every place that shows the number shows the open total', () => {
  const main = readFileSync(p('src', 'electron', 'main.js'), 'utf8');
  assert.match(main, /const open = daemon\.openTotal\(counts\);/);
  assert.match(main, /const tone = failed \? 'error' : open > 0 \? 'open' : 'idle';/);
  assert.match(main, /const label = labelFor\(open, tone\);/);
  assert.doesNotMatch(main, /labelFor\(counts\.waiting/, 'the tray icon, window and taskbar all use one number');
});

/* ------------------------------------------------------------ next fetch */

test('the next fetch is the first TICK at or after a source wakes, not the wake itself', () => {
  const tick = new Date('2026-10-01T14:00:00Z');
  const half = 30;
  assert.equal(daemon.nextFetchAt(tick, null, half).toISOString(), '2026-10-01T14:00:00.000Z', 'something is due now');
  assert.equal(daemon.nextFetchAt(tick, new Date('2026-10-01T13:00:00Z'), half).toISOString(), '2026-10-01T14:00:00.000Z');
  assert.equal(daemon.nextFetchAt(tick, new Date('2026-10-01T14:07:00Z'), half).toISOString(), '2026-10-01T14:30:00.000Z');
  assert.equal(daemon.nextFetchAt(tick, new Date('2026-10-01T14:30:00Z'), half).toISOString(), '2026-10-01T14:30:00.000Z');
  assert.equal(daemon.nextFetchAt(tick, new Date('2026-10-01T16:01:00Z'), half).toISOString(), '2026-10-01T16:30:00.000Z');
});

/* ------------------------------------------------------------ the icon */

test('crc32 matches the standard check value', () => {
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
});

test('the badge is a valid PNG of the size asked for', () => {
  const png = badgePng('7', { size: 32 });
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.equal(png.readUInt32BE(16), 32, 'width');
  assert.equal(png.readUInt32BE(20), 32, 'height');
  assert.equal(png.readUInt32BE(8), 13, 'IHDR is the first chunk');

  const idatLen = png.readUInt32BE(33);
  assert.equal(png.subarray(37, 41).toString('ascii'), 'IDAT');
  const pixels = inflateSync(png.subarray(41, 41 + idatLen));
  assert.equal(pixels.length, 32 * (32 * 4 + 1), 'one filter byte plus RGBA for every row');
  assert.equal(png.subarray(-8, -4).toString('ascii'), 'IEND');
});

test('different numbers and tones draw different icons', () => {
  const a = badgePng('5').toString('hex');
  assert.notEqual(a, badgePng('6').toString('hex'));
  assert.notEqual(a, badgePng('5', { tone: 'idle' }).toString('hex'));
  assert.notEqual(a, badgePng('5', { tone: 'error' }).toString('hex'));
  assert.notEqual(badgePng('12').toString('hex'), badgePng('1').toString('hex'));
});

test('the label is capped at two digits and an error shows a bang', () => {
  assert.equal(labelFor(7), '7');
  assert.equal(labelFor(99), '99');
  assert.equal(labelFor(250), '99', 'three digits do not fit');
  assert.equal(labelFor(-3), '0');
  assert.equal(labelFor(Number.NaN), '0');
  // A failed scan must not look like "nothing new".
  assert.equal(labelFor(12, 'error'), '!');
});

/* ------------------------------------------------------------ boundaries */

test('the decision modules stay free of Electron so they can be tested', () => {
  for (const f of ['daemon.js', 'schedule.js', 'queue.js']) {
    assert.doesNotMatch(readFileSync(p('src', f), 'utf8'), /from 'electron'/, `${f} must not import electron`);
  }
});

test('the runner makes its child behave as plain Node when inside Electron', () => {
  // process.execPath is electron.exe in the tray app. Without this the "search"
  // child would be a second tray app.
  assert.match(readFileSync(p('src', 'runner.js'), 'utf8'), /ELECTRON_RUN_AS_NODE/);
});
