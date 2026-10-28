/**
 * Each source rests for its own interval.
 *
 * The background app wakes every half hour. Without a per-source sleep that is one
 * of two bad choices: fetch all fifteen sources every half hour (Adzuna alone is
 * 42 requests a run against 250 a day, Workday up to 355), or use one slow global
 * interval and read the inbox hours late. A source declares how long it rests, and
 * a wake-up only fetches the ones whose rest is over.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { p, readJson } from '../src/util.js';
import * as schedule from '../src/schedule.js';

const empty = () => ({ version: 1, sources: {} });
const at = (iso) => new Date(iso);
const CFG = { enabled: true, sleepMinutes: 120 };

test('a source that has never run is due', () => {
  assert.equal(schedule.isDue(empty(), 'ats', CFG, at('2026-10-01T10:00:00Z')), true);
});

test('a source is not due until its own sleep is over', () => {
  const state = schedule.touch(empty(), 'ats', CFG, { now: at('2026-10-01T10:00:00Z') });
  assert.equal(schedule.isDue(state, 'ats', CFG, at('2026-10-01T11:59:00Z')), false);
  assert.equal(schedule.isDue(state, 'ats', CFG, at('2026-10-01T12:00:00Z')), true);
});

test('two sources with different sleeps wake at different times', () => {
  const mail = { enabled: true, sleepMinutes: 30 };
  const workday = { enabled: true, sleepMinutes: 360 };
  const state = empty();
  const t0 = at('2026-10-01T10:00:00Z');
  schedule.touch(state, 'mailalerts', mail, { now: t0 });
  schedule.touch(state, 'workday', workday, { now: t0 });

  const cfg = { mailalerts: mail, workday };
  assert.deepEqual(schedule.dueSources(cfg, state, at('2026-10-01T10:30:00Z')), ['mailalerts']);
  assert.deepEqual(schedule.dueSources(cfg, state, at('2026-10-01T16:00:00Z')).sort(), ['mailalerts', 'workday']);
});

test('a source with no sleepMinutes rests the slow default, not the tick', () => {
  // "Not overdoing it" is the default. A forgotten setting must not mean a fetch
  // every half hour.
  assert.equal(schedule.sleepMinutes({ enabled: true }), schedule.DEFAULT_SLEEP_MINUTES);
  assert.equal(schedule.sleepMinutes({ enabled: true, sleepMinutes: 'soon' }), schedule.DEFAULT_SLEEP_MINUTES);
  assert.equal(schedule.sleepMinutes({ enabled: true, sleepMinutes: -5 }), schedule.DEFAULT_SLEEP_MINUTES);
});

test('a sleep of zero is always due', () => {
  const cfg = { enabled: true, sleepMinutes: 0 };
  const state = schedule.touch(empty(), 'x', cfg, { now: at('2026-10-01T10:00:00Z') });
  assert.equal(schedule.isDue(state, 'x', cfg, at('2026-10-01T10:00:00Z')), true);
});

test('only enabled sources count, and config keys that are not sources are ignored', () => {
  // sources.json also holds `queries` (an array), `http` (an object with no
  // `enabled`) and underscore comment keys. None of them is a source.
  const cfg = {
    _comment: 'text',
    queries: ['DevOps Engineer'],
    http: { timeoutMs: 30000 },
    on: { enabled: true },
    off: { enabled: false },
  };
  assert.deepEqual(schedule.dueSources(cfg, empty(), at('2026-10-01T10:00:00Z')), ['on']);
});

test('a failed fetch is retried soon instead of sleeping its full interval', () => {
  // A laptop that wakes without a network would otherwise put Workday to sleep
  // for six hours on the strength of a fetch that returned nothing.
  const long = { enabled: true, sleepMinutes: 360 };
  const t0 = at('2026-10-01T10:00:00Z');
  const state = schedule.touch(empty(), 'workday', long, { now: t0, failed: true });
  assert.equal(schedule.isDue(state, 'workday', long, at('2026-10-01T10:29:00Z')), false);
  assert.equal(schedule.isDue(state, 'workday', long, at('2026-10-01T10:30:00Z')), true);
});

test('a failure never LENGTHENS a short sleep', () => {
  const short = { enabled: true, sleepMinutes: 10 };
  const t0 = at('2026-10-01T10:00:00Z');
  const state = schedule.touch(empty(), 'x', short, { now: t0, failed: true });
  assert.equal(schedule.wakesAt(state, 'x', short).toISOString(), '2026-10-01T10:10:00.000Z');
});

test('nextWake is null while anything is already due, else the earliest wake', () => {
  const a = { enabled: true, sleepMinutes: 60 };
  const b = { enabled: true, sleepMinutes: 240 };
  const cfg = { a, b };
  const t0 = at('2026-10-01T10:00:00Z');
  const state = empty();
  schedule.touch(state, 'a', a, { now: t0 });
  assert.equal(schedule.nextWake(cfg, state, at('2026-10-01T10:05:00Z')), null, 'b has never run, so it is due');

  schedule.touch(state, 'b', b, { now: t0 });
  assert.equal(schedule.nextWake(cfg, state, at('2026-10-01T10:05:00Z')).toISOString(), '2026-10-01T11:00:00.000Z');
});

test('every source in sources.json declares its own sleep', () => {
  // The point of the feature. A source that quietly inherits the default is one
  // somebody forgot to think about.
  const cfg = readJson(p('config', 'sources.json'));
  const missing = Object.entries(cfg)
    .filter(([k, v]) => !k.startsWith('_') && v && typeof v === 'object' && !Array.isArray(v) && 'enabled' in v)
    .filter(([, v]) => !Number.isFinite(Number(v.sleepMinutes)))
    .map(([k]) => k);
  assert.deepEqual(missing, [], `no sleepMinutes: ${missing.join(', ')}`);
});

test('a metered source never sleeps less than its quota allows', () => {
  // The sleep composes with the quota; it must not undercut it. JSearch is one
  // run a day, so waking it hourly would only produce refusals.
  const cfg = readJson(p('config', 'sources.json'));
  for (const [key, v] of Object.entries(cfg)) {
    if (!v?.quota?.maxRunsPerDay) continue;
    const perDayAtThisSleep = 1440 / schedule.sleepMinutes(v);
    assert.ok(perDayAtThisSleep <= v.quota.maxRunsPerDay + 1e-9,
      `${key}: sleeps ${v.sleepMinutes} min = ${perDayAtThisSleep.toFixed(1)} runs a day, quota allows ${v.quota.maxRunsPerDay}`);
  }
});

test('commit records every attempted source, and a failed one is retried soon', () => {
  const long = { enabled: true, sleepMinutes: 360 };
  const short = { enabled: true, sleepMinutes: 120 };
  const t0 = at('2026-10-01T10:00:00Z');
  const state = schedule.commit(empty(), {
    workday: { cfg: long, failed: false },
    ats: { cfg: short, failed: true },
  }, { now: t0 });

  assert.equal(schedule.isDue(state, 'workday', long, at('2026-10-01T15:59:00Z')), false);
  assert.equal(schedule.isDue(state, 'workday', long, at('2026-10-01T16:00:00Z')), true);
  assert.equal(schedule.isDue(state, 'ats', short, at('2026-10-01T10:29:00Z')), false);
  assert.equal(schedule.isDue(state, 'ats', short, at('2026-10-01T10:30:00Z')), true, 'failed: retried in 30, not 120');
});

test('a run that never commits leaves its sources due', () => {
  // The scan cut off mid-run — tray quit, laptop shut. Nothing was saved, so
  // nothing may be marked fetched: the same sources must come round again.
  const cfg = { enabled: true, sleepMinutes: 1440 };
  const state = empty();
  assert.equal(schedule.isDue(state, 'jsearch', cfg, at('2026-10-01T10:30:00Z')), true);
  assert.deepEqual(state.sources, {});
});

test('the pipeline notes attempts as it goes and writes them only when the run completes', () => {
  const src = readFileSync(p('src', 'index.js'), 'utf8');
  assert.match(src, /has\('--due-only'\)/, 'the flag is read');
  assert.doesNotMatch(src, /schedule\.touch\(/, 'nothing writes the time mid-run');

  const sleepCheck = src.indexOf('dueOnly && !schedule.isDue(');
  const noted = src.indexOf('attempts[key] = { cfg, failed: false }');
  const requiresKey = src.indexOf('mod.requiresKey?.some(');
  const budget = src.indexOf('quota.budgetFor(');
  assert.ok(sleepCheck > 0, 'a sleeping source is skipped');
  assert.ok(noted > sleepCheck, 'the attempt is noted after deciding the source is due');
  assert.ok(requiresKey > noted, 'and before the skips, so a skipped source rests its interval too');
  assert.ok(budget > noted, 'the quota still has the last word');
  assert.match(src, /attempts\[key\]\.failed = true/, 'a fetch that returned only errors is marked failed');
});

test('the schedule is committed after memory is saved, and on the empty-run exits', () => {
  const src = readFileSync(p('src', 'index.js'), 'utf8');
  const def = src.slice(src.indexOf('const commitSchedule = (only = null) => {'), src.indexOf('const snapshot = replay'));
  assert.match(def, /if \(dryRun\) return;/, 'a dry run records nothing');

  const calls = [...src.matchAll(/commitSchedule\(\);/g)].map((m) => m.index);
  assert.equal(calls.length, 4, 'three empty-fetch exits (offline, due-only, full) and the normal end');

  const finalSave = src.indexOf('persistVerdicts(state);\n  store.save(state);\n  commitSchedule();');
  assert.ok(finalSave > 0, 'the normal end commits straight after store.save, never before it');

  // And each source is committed the moment it is judged and saved, so a scan cut
  // off after four sources keeps those four asleep instead of recording nothing.
  assert.match(src, /await settle\(prepared\);[\s\S]{0,700}commitSchedule\(key\);/,
    'a source commits straight after its own batch is saved');

  const empty = src.slice(src.indexOf('if (!run.fetched && !run.drained) {'), src.indexOf('persistVerdicts(state);'));
  assert.equal((empty.match(/commitSchedule\(\);/g) || []).length, 3, 'every empty-run branch commits before returning');
});

test('the due run exists and uses the flag', async () => {
  const { RUNS } = await import('../src/runner.js');
  assert.deepEqual(RUNS.due.argv, ['search', '--due-only']);
});
