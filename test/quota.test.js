/**
 * Never spending more of a metered API than it gives away free.
 *
 * JSearch is ~200 requests a MONTH. Four `npm run search` invocations in one
 * afternoon — three of them `--dry-run`, which writes nothing but fetches
 * everything — took it from comfortable to 95% used with ten days of the cycle
 * left. Nothing in the tool noticed, because nothing was counting.
 *
 * The fix is not "call it less". It is three rules that make overspending
 * impossible without anyone having to remember.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { p } from '../src/util.js';
import * as quota from '../src/quota.js';

const CFG = { perMonth: 200, cycleResetsOnDay: 14, maxRunsPerDay: 1, maxQueries: 4 };
const empty = () => ({ version: 1, sources: {} });
const at = (iso) => new Date(iso);

test('a dry run never spends a metered budget', () => {
  // --dry-run promises to write nothing. It never promised to cost nothing, and
  // that is exactly how the budget was burned: three of the four runs that day
  // wrote nothing at all.
  const b = quota.budgetFor(empty(), 'jsearch', CFG, { dryRun: true, now: at('2026-09-04T08:00:00Z') });
  assert.equal(b.allowed, false);
  assert.equal(b.calls, 0);
  assert.match(b.reason, /dry run/);
});

test('a source with no quota configured is untouched', () => {
  // Adzuna allows 250 a DAY; the free ATS boards are unmetered. Only sources
  // that declare a quota are policed, so this cannot slow anything else down.
  const b = quota.budgetFor(empty(), 'adzuna', undefined, { now: at('2026-09-04T08:00:00Z') });
  assert.equal(b.allowed, true);
  assert.equal(b.calls, null, 'null means "use your own maxQueries"');
});

test('once a day, and the second run the same day is refused', () => {
  const now = at('2026-09-04T08:00:00Z');
  const state = empty();

  const first = quota.budgetFor(state, 'jsearch', CFG, { now });
  assert.equal(first.allowed, true);
  quota.record(state, 'jsearch', CFG, first.calls, { now });

  const second = quota.budgetFor(state, 'jsearch', CFG, { now: at('2026-09-04T19:00:00Z') });
  assert.equal(second.allowed, false);
  assert.match(second.reason, /already ran 1x today/);

  const tomorrow = quota.budgetFor(state, 'jsearch', CFG, { now: at('2026-09-05T08:00:00Z') });
  assert.equal(tomorrow.allowed, true, 'a new day opens it again');
});

test('the allowance is paced over the days left, not spent up front', () => {
  // This is the rule that actually keeps a free tier free. Without it a month's
  // budget disappears in its first week and the source is dead for three.
  const state = empty();
  const seeded = { ...CFG, assumeUsed: { cycle: '2026-08-14', calls: 190 } };

  const tight = quota.budgetFor(state, 'jsearch', seeded, { now: at('2026-09-04T08:00:00Z') });
  assert.equal(tight.calls, 1, '10 calls left over 10 days is 1 a day');

  const roomy = quota.budgetFor(state, 'jsearch', CFG, { now: at('2026-09-15T08:00:00Z') });
  assert.equal(roomy.calls, CFG.maxQueries, 'a fresh cycle is capped by maxQueries, not by pacing');
});

test('a spent budget stops the source entirely', () => {
  const spent = { ...CFG, assumeUsed: { cycle: '2026-08-14', calls: 200 } };
  const b = quota.budgetFor(empty(), 'jsearch', spent, { now: at('2026-09-04T08:00:00Z') });
  assert.equal(b.allowed, false);
  assert.match(b.reason, /budget spent \(200\/200\)/);
});

test('the head-start seed expires with its own cycle', () => {
  // A bare number would be added again every month, forever, and the source
  // would throttle itself harder each cycle for a debt it had already paid.
  const seeded = { ...CFG, assumeUsed: { cycle: '2026-08-14', calls: 190 } };

  assert.equal(quota.budgetFor(empty(), 'jsearch', seeded, { now: at('2026-09-04T08:00:00Z') }).calls, 1);
  assert.equal(quota.budgetFor(empty(), 'jsearch', seeded, { now: at('2026-09-20T08:00:00Z') }).calls, 4,
    'the next cycle must not inherit the debt');

  // An unpinned number is ignored rather than trusted, so a half-migrated
  // config fails open on the side of the source working.
  assert.equal(quota.budgetFor(empty(), 'jsearch', { ...CFG, assumeUsed: 190 }, { now: at('2026-09-04T08:00:00Z') }).calls, 4);
});

test('the cycle starts on the subscription day, not the first of the month', () => {
  // RapidAPI meters from the day you subscribed.
  assert.equal(quota.cycleStart(14, at('2026-09-04T08:00:00Z')).toISOString().slice(0, 10), '2026-08-14');
  assert.equal(quota.cycleStart(14, at('2026-09-20T08:00:00Z')).toISOString().slice(0, 10), '2026-09-14');
  assert.equal(quota.cycleStart(undefined, at('2026-09-04T08:00:00Z')).toISOString().slice(0, 10), '2026-09-01',
    'unconfigured falls back to calendar months');
});

test('the ledger records what was actually spent, not what was allowed', () => {
  // A source may return fewer calls than its budget — fewer queries configured,
  // or an early failure. Charging it for the allowance would throttle it for
  // requests it never made.
  const now = at('2026-09-04T08:00:00Z');
  const state = empty();
  quota.record(state, 'jsearch', CFG, 1, { now });
  assert.equal(state.sources.jsearch.used, 1);
  assert.equal(state.sources.jsearch.days['2026-09-04'].calls, 1);
  assert.equal(state.sources.jsearch.days['2026-09-04'].runs, 1);
});

test('the pipeline checks the budget before fetching and records after', () => {
  const src = readFileSync(p('src', 'index.js'), 'utf8');
  const before = src.indexOf('quota.budgetFor(');
  const fetchAt = src.indexOf('await mod.fetchJobs(');
  const landAt = src.indexOf('const land = async');
  const after = src.indexOf('quota.record(');
  assert.ok(before > 0 && fetchAt > before, 'the budget is checked before the request');
  // The ledger is written in land(), which runs only once a fetch has landed — never at launch.
  assert.ok(after > landAt && landAt > before, 'and the ledger written after it, when the source lands');
  assert.match(src, /result\.calls \?\? budget\.calls/, 'charging what the source reports it spent');
});

test('jsearch treats maxQueries as a hard budget', () => {
  // One query is one request. If it ever ignored the cap, every other rule here
  // would be decoration.
  const src = readFileSync(p('src', 'sources', 'jsearch.js'), 'utf8');
  assert.match(src, /queries\.slice\(0, Math\.max\(0, maxQueries\)\)/);
  assert.match(src, /calls\+\+/, 'and counts what it actually sent');
  assert.match(src, /return \{ jobs: out, errors, calls \}/);
});

/* -------------------------------------------- daily caps are a different animal */

test('a daily cap is enforced but does not refuse a dry run', () => {
  // Adzuna gives 250 a DAY and refills overnight, so overspending costs one
  // afternoon. JSearch gives 200 a MONTH, so overspending costs three weeks.
  // Only the second is worth skipping a dry run over — skipping Adzuna while
  // testing would change what the pipeline sees for a saving that expires
  // anyway.
  const daily = { perDay: 250, maxRunsPerDay: 5, skipOnDryRun: false };
  const dry = quota.budgetFor(empty(), 'adzuna', daily, { dryRun: true, now: at('2026-09-04T08:00:00Z') });
  assert.equal(dry.allowed, true, 'a daily budget still runs on a dry run');

  const monthly = quota.budgetFor(empty(), 'jsearch', CFG, { dryRun: true, now: at('2026-09-04T08:00:00Z') });
  assert.equal(monthly.allowed, false, 'a monthly one does not');
});

test('a daily cap needs no pacing — it refills tomorrow', () => {
  const daily = { perDay: 250, maxRunsPerDay: 5 };
  const now = at('2026-09-04T08:00:00Z');
  const state = empty();

  for (let i = 0; i < 5; i++) {
    const b = quota.budgetFor(state, 'adzuna', daily, { now });
    assert.equal(b.allowed, true, `run ${i + 1} should be allowed`);
    quota.record(state, 'adzuna', daily, 42, { now });
  }
  assert.equal(state.sources.adzuna.days['2026-09-04'].calls, 210, 'under the 250 cap');

  const sixth = quota.budgetFor(state, 'adzuna', daily, { now });
  assert.equal(sixth.allowed, false);

  const tomorrow = quota.budgetFor(state, 'adzuna', daily, { now: at('2026-09-05T08:00:00Z') });
  assert.equal(tomorrow.allowed, true, 'and it refills overnight with no pacing');
});

test('the run is counted even when the source reports no spend', () => {
  // Not every source returns a call count. maxRunsPerDay has to work for those
  // too — otherwise a quiet source is never throttled, which is the opposite of
  // what a budget is for. This bit: Adzuna reported nothing, the ledger recorded
  // zero, and the cap could never fill.
  const daily = { perDay: 250, maxRunsPerDay: 1 };
  const now = at('2026-09-04T08:00:00Z');
  const state = empty();

  quota.record(state, 'adzuna', daily, undefined, { now });
  assert.equal(state.sources.adzuna.days['2026-09-04'].runs, 1, 'the run counts');
  assert.equal(state.sources.adzuna.days['2026-09-04'].calls, 0, 'even with nothing to charge');
  assert.equal(quota.budgetFor(state, 'adzuna', daily, { now }).allowed, false);
});

test('adzuna reports what it sent', () => {
  const src = readFileSync(p('src', 'sources', 'adzuna.js'), 'utf8');
  assert.match(src, /let calls = 0;/);
  assert.match(src, /calls\+\+/);
  assert.match(src, /return \{ jobs: out, errors, calls \}/);
});
