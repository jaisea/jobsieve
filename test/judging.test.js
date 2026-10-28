/**
 * What is waiting to be judged, and how the app and the page come to know.
 *
 * A posting the model could not answer is in no list, so without a sign on the page
 * and in the tray it would simply be missing — a job quietly not there. These pin
 * the one answer the tray, the page and the scheduler all read.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DIR = mkdtempSync(join(tmpdir(), 'jobhunt-judging-'));
process.env.JOBHUNT_DATA_DIR = DIR;
mkdirSync(DIR, { recursive: true });

const { status } = await import('../src/judging.js');
const { idleDelayMs } = await import('../src/daemon.js');
const { RUNS } = await import('../src/runner.js');
const { p } = await import('../src/util.js');

const put = (name, data) => writeFileSync(join(DIR, name), JSON.stringify(data));
const clear = () => { put('awaiting.json', { version: 1, items: {}, hold: null }); put('batches.json', { version: 1, owed: {} }); };
const waiting = (n, hold) => {
  const items = {};
  for (let i = 0; i < n; i++) {
    items[`fp${i}`] = { item: { job: { fingerprint: `fp${i}` } }, queuedAt: new Date().toISOString(), attempts: 1 };
  }
  return { version: 1, items, hold };
};
const src = (...parts) => readFileSync(p(...parts), 'utf8');

test('with nothing waiting there is nothing to say and nothing due', () => {
  clear();
  const s = status();
  assert.equal(s.any, false);
  assert.equal(s.due, false);
  assert.equal(s.text, '');
});

test('postings held by the daily limit are described, and not due until it resets', () => {
  const now = new Date('2026-10-02T08:00:00');
  put('awaiting.json', waiting(3, { scope: 'day', until: new Date('2026-10-02T09:02:00').toISOString(), reason: 'quota', since: now.toISOString() }));
  put('batches.json', { version: 1, owed: {} });

  const s = status(now);
  assert.equal(s.waiting, 3);
  assert.match(s.text, /3 postings waiting for the AI — daily limit reached, resumes about 09:02/);
  assert.equal(s.due, false, 'a run now would only be refused again');
  assert.equal(s.any, true, 'but the person is still told');

  assert.equal(status(new Date('2026-10-02T09:03:00')).due, true, 'and it is due the moment the limit is over');
});

test('a source fetched and never judged is due at once, and a stuck one is reported but not retried by itself', () => {
  put('awaiting.json', waiting(0, null));
  put('batches.json', { version: 1, owed: { adzuna: { label: 'Adzuna', count: 40, fetchedAt: new Date().toISOString(), attempts: 0 } } });
  let s = status();
  assert.equal(s.due, true);
  assert.match(s.text, /Adzuna: 40 fetched postings not judged yet/);

  put('batches.json', { version: 1, owed: { adzuna: { label: 'Adzuna', count: 1, fetchedAt: new Date().toISOString(), attempts: 3 } } });
  s = status();
  assert.equal(s.due, false, 'giving up is not retried every half hour');
  assert.equal(s.any, true);
  assert.match(s.text, /could not be judged after repeated tries/);
});

test('the app sleeps until the limit lifts when that is sooner than its next look', () => {
  const now = new Date('2026-10-02T08:50:00');
  const tick = 30 * 60000;
  const at = new Date('2026-10-02T09:02:00');
  const d = idleDelayMs(tick, at, now);
  assert.ok(d >= 12 * 60000 && d < 13 * 60000, `about 12 minutes, got ${d / 60000}`);
  assert.equal(idleDelayMs(tick, null, now), tick, 'nothing waiting: the usual tick');
  assert.equal(idleDelayMs(tick, new Date('2026-10-02T14:00:00'), now), tick, 'a reset hours away: the usual tick');
  assert.equal(idleDelayMs(tick, new Date(now.getTime() + 10000), now), 60000, 'never busier than once a minute');
});

test('the app can start a judging-only run, and the allowlist has it', () => {
  assert.deepEqual(RUNS.judge.argv, ['search', '--judge-queue']);
  const main = src('src', 'electron', 'main.js');
  assert.match(main, /if \(!due\.length && !judge\) \{/, 'idle only when no source is due AND nothing waits');
  assert.match(main, /startScan\('judge'\)/, 'and nothing due to fetch still judges what waits');
  assert.match(main, /judgeNow,/, 'one implementation, offered to the page through controls');
  assert.match(main, /Judge the waiting postings now/);
});

test('the page shows what is waiting, served or not, and offers the button only to the app', () => {
  const report = src('src', 'report.js');
  assert.match(report, /id="judgebar" hidden/);
  assert.match(report, /fetch\('\/api\/judging'\)/);
  assert.match(report, /judgeBtn\.hidden = !appState\.available;/, 'a button that does nothing is worse than none');
  assert.match(report, /post\('\/api\/app\/judge', \{\}\)/);

  const serve = src('src', 'serve.js');
  assert.match(serve, /url\.pathname === '\/api\/judging'/);
  assert.match(serve, /url\.pathname === '\/api\/app\/judge'/);
});

test('the report banner no longer calls a rate limit "rules fallback"', () => {
  const report = src('src', 'report.js');
  assert.match(report, /waiting for the AI \(see the bar above\)/);
});

test('a waiting posting that the rules now settle on their own leaves the queue', () => {
  // Its source returned it again, or a rule changed: asking the model would spend a
  // request on a question that no longer exists.
  const index = src('src', 'index.js');
  assert.match(index, /const certain = \[\.\.\.passed\.map\(\(j\) => j\.fingerprint\), \.\.\.drops\.map\(\(d\) => d\[0\]\.fingerprint\)\];/);
  assert.match(index, /awaiting\.resolve\(waiting, certain\);/);
});

test('while judging is on the billed key the page and tray say so, with the month so far', async () => {
  const ks = await import('../src/keystate.js');
  put('awaiting.json', waiting(0, null));
  put('batches.json', { version: 1, owed: {} });
  const now = new Date('2026-10-02T08:00:00Z');

  put('llm-keys.json', {});
  assert.equal(status(now).any, false, 'nothing to say while the free quota holds');

  put('llm-keys.json', { judgeSpentUntil: '2026-10-03T07:02:00Z', billed: { '2026-10': 120 } });
  const s = status(now);
  assert.equal(s.any, true, 'money is being spent, so the bar shows even with nothing waiting');
  assert.equal(s.due, false, 'but there is no work to start');
  assert.match(s.text, /Free daily quota spent — judging on the billed key \(120 calls this month, about \$0\.04; an estimate\)/);
  assert.equal(s.billed.active, true);

  put('llm-keys.json', { judgeSpentUntil: '2026-10-02T07:02:00Z', billed: { '2026-10': 120 } });
  assert.equal(status(now).any, false, 'after the reset it is free again and the bar goes');
  assert.ok(ks.EST_USD_PER_CALL > 0);
});
