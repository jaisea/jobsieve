/**
 * Fetch several sources at once, deal with each as it lands.
 *
 * A scan measured at 14m37s spent 10m12s fetching, one source at a time: the recruiting agency
 * took 6m27s while mail (about twelve seconds of work) waited behind four slow sources and
 * reached the page 4m56s in. What must hold when fetching overlaps is spelled out here:
 * starting overlaps, LANDING does not, and results arrive in completion order.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runPool } from '../src/pool.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Items with a fetch time each; records what happened and when. */
function harness(times, { limit, landTime = () => 0, skipAfter = null } = {}) {
  const log = [];
  let inFlight = 0;
  let maxInFlight = 0;
  let landing = 0;
  let overlappedLanding = false;
  const t0 = Date.now();
  const at = () => Date.now() - t0;

  const run = runPool(Object.keys(times), {
    limit,
    start: async (name) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      log.push(`start ${name}`);
      await sleep(times[name]);
      inFlight--;
      return name.toUpperCase();
    },
    land: async (name, value) => {
      landing++;
      if (landing > 1) overlappedLanding = true;
      log.push(`land ${name}:${value}`);
      await sleep(landTime(name));
      landing--;
    },
    shouldSkip: skipAfter ? () => log.filter((l) => l.startsWith('land')).length >= skipAfter : undefined,
    onSkip: (name) => log.push(`skip ${name}`),
  });
  return { run, log, stats: () => ({ maxInFlight, overlappedLanding, ms: at() }) };
}

test('a fast source is not made to wait for a slow one that started before it', async () => {
  const h = harness({ slow: 200, fast: 20 }, { limit: 2 });
  await h.run;
  assert.deepEqual(h.log.filter((l) => l.startsWith('land')), ['land fast:FAST', 'land slow:SLOW'],
    'completion order, not the order they were started in');
});

test('no more than `limit` fetches are in flight at once', async () => {
  const h = harness({ a: 40, b: 40, c: 40, d: 40, e: 40 }, { limit: 2 });
  await h.run;
  assert.equal(h.stats().maxInFlight, 2);
  assert.equal(h.log.filter((l) => l.startsWith('land')).length, 5, 'and all five landed');
});

test('overlapping fetches finish in the time of the slowest, not the sum', async () => {
  const h = harness({ a: 100, b: 100, c: 100 }, { limit: 3 });
  await h.run;
  assert.ok(h.stats().ms < 220, `three 100ms fetches overlapped, took ${h.stats().ms}ms`);
  const serial = harness({ a: 60, b: 60, c: 60 }, { limit: 1 });
  await serial.run;
  assert.ok(serial.stats().ms >= 170, `and one at a time they add up, took ${serial.stats().ms}ms`);
});

test('LANDING never overlaps: everything shared is written by one source at a time', async () => {
  // All three fetches finish together, and each landing takes a while. They must queue.
  const h = harness({ a: 10, b: 10, c: 10 }, { limit: 3, landTime: () => 40 });
  await h.run;
  assert.equal(h.stats().overlappedLanding, false);
});

test('while one result is being landed the other fetches keep going', async () => {
  // `big` lands slowly (the real case: reading 6,000 adverts). `later` is fetched during that.
  const h = harness({ big: 10, later: 60 }, { limit: 2, landTime: (n) => (n === 'big' ? 150 : 0) });
  await h.run;
  const order = h.log;
  assert.equal(order[0], 'start big');
  assert.equal(order[1], 'start later', 'both were started up front');
  assert.deepEqual(order.filter((l) => l.startsWith('land')), ['land big:BIG', 'land later:LATER']);
  assert.ok(h.stats().ms < 230, `later was fetched WHILE big landed, took ${h.stats().ms}ms`);
});

test('limit 1 is strictly one at a time, in the order given (--serial)', async () => {
  const h = harness({ a: 30, b: 5, c: 20 }, { limit: 1 });
  await h.run;
  assert.deepEqual(h.log, ['start a', 'land a:A', 'start b', 'land b:B', 'start c', 'land c:C']);
});

test('once told to skip, the sources still waiting for a slot are not started', async () => {
  // How a scan stops starting sources after one has found the connection down.
  const h = harness({ a: 10, b: 10, c: 10, d: 10 }, { limit: 1, skipAfter: 1 });
  await h.run;
  assert.deepEqual(h.log, ['start a', 'land a:A', 'skip b', 'skip c', 'skip d']);
});

test('a failure in landing surfaces and nothing more is landed', async () => {
  const seen = [];
  await assert.rejects(
    runPool(['a', 'b'], {
      limit: 2,
      start: async (n) => { await sleep(n === 'a' ? 5 : 30); return n; },
      land: async (n) => { seen.push(n); if (n === 'a') throw new Error('disk full'); },
    }),
    /disk full/,
  );
  assert.deepEqual(seen, ['a']);
});

test('nothing to do resolves at once', async () => {
  await runPool([], { start: () => assert.fail('nothing to start'), land: () => assert.fail('nothing to land') });
});

/* ------------------------------------------------------------ how the scan uses it */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const read = (...parts) => readFileSync(join(ROOT, ...parts), 'utf8');

test('the scan fetches through the pool, serially on request, and stops starting sources once offline', () => {
  const index = read('src', 'index.js');
  assert.match(index, /const fetchAtOnce = has\('--serial'\) \? 1 : Math\.max\(1, Number\(sourcesCfg\.http\?\.sourcesAtOnce\) \|\| 6\);/);
  assert.match(index, /await runPool\(runnable, \{[\s\S]{0,200}limit: fetchAtOnce,/);
  assert.match(index, /shouldSkip: \(\) => offlineSeen,/);
  // land() is where everything shared is written, and it is the only place the quota ledger is.
  assert.match(index, /const land = async \(\{ source: \{ key, mod, cfg, budget \}, result, ms \}\) => \{/);
});

test('the launch order is data: mail first, the slow sources next, so their time overlaps', () => {
  const cfg = JSON.parse(read('config', 'sources.json'));
  assert.equal(cfg.mailalerts.priority, 0, 'mail is quick and the most time-sensitive');
  for (const slow of ['agencies', 'germantechjobs', 'getro', 'ats', 'workday', 'careersites']) {
    assert.equal(cfg[slow].priority, 10, `${slow} takes tens of seconds to minutes and is started early`);
  }
  assert.match(read('src', 'index.js'), /\(sourcesCfg\[a\]\.priority \?\? 50\) - \(sourcesCfg\[b\]\.priority \?\? 50\)/, 'a source with none sorts in the middle');
});
