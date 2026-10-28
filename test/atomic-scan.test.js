/**
 * A scan is a series of atomic per-source batches.
 *
 * It used to fetch every source and then judge one big batch, so nothing reached
 * the page until the slowest source had been fetched, read and adjudicated — ten
 * minutes on a full scan. Each source is now judged and saved as it returns.
 *
 * These read the source for the properties that make that safe, because nothing
 * here runs the pipeline (it spends API quota); `npm run replay` is the
 * behavioural check, and gave identical counts either side of the change.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { p } from '../src/util.js';
import * as schedule from '../src/schedule.js';

const INDEX = readFileSync(p('src', 'index.js'), 'utf8');
// From the start of the source loop: the checks, the landing function, the fetch pool.
const loopStart = INDEX.indexOf('const launchOrder = ');
const loop = INDEX.slice(loopStart, INDEX.indexOf('if (replay) {', loopStart));
// The judge lane's worker: what happens to a batch once it has been prepared.
const lane = INDEX.slice(INDEX.indexOf('const judgeLane = lane('), loopStart);

test('each source is handed to the judge lane the moment it has been prepared', () => {
  // The fetch side reads the adverts and runs the rules; the model and memory are the
  // judge lane's, so the next source is fetched while this one waits on its rate limit.
  assert.match(loop, /if \(result\.jobs\.length\) \{[\s\S]{0,400}const prepared = await prepare\(result\.jobs, cfg\.label\);[\s\S]{0,420}await judgeLane\.push\(\{ key, prepared, owed, commit: result\.commit \}\);/);
  // The loop must not collect everything and judge afterwards.
  assert.doesNotMatch(INDEX, /raw\.push\(\.\.\.result\.jobs\)/);
});

test('a replay is one batch of the whole snapshot', () => {
  assert.match(INDEX, /await judge\(snapshot\.jobs, 'The last fetch'\);/);
});

test('settle() saves its own memory, so a batch is visible before the next one is settled', () => {
  const judge = INDEX.slice(INDEX.indexOf('const settle = async ('));
  const body = judge.slice(0, judge.indexOf('\n  };\n'));
  assert.match(body, /store\.markShown\(state, toReport\);\s*\n\s*store\.save\(state\);/);
  assert.match(body, /rejects\.save\(archive\)/, 'and its rejections');
});

test('the archive settlement runs once, after every batch', () => {
  const afterLoop = INDEX.slice(INDEX.indexOf('if (!run.fetched && !run.drained) {'));
  assert.match(afterLoop, /persistVerdicts\(state\);\s*\n\s*store\.save\(state\);/);
  // And not inside the batch, where they would run once per source.
  const judge = INDEX.slice(INDEX.indexOf('const prepare = async'), INDEX.indexOf('const writeReport = '));
  assert.doesNotMatch(judge, /persistVerdicts\(/);
});

test('the report page is rewritten after a source that brought something new, and again at the end', () => {
  // A page opened as a FILE only shows what was written to it; the live page and
  // the tray read the store and never needed this.
  assert.match(lane, /const known = run\.reported\.size;/);
  assert.match(lane, /if \(!dryRun && run\.reported\.size > known\) \{[\s\S]{0,120}writeReport\(store\.load\(\), \{ quiet: true \}\);/);
  assert.match(INDEX, /const \{ toReport, dated \} = writeReport\(state\);/, 'and the end of the run writes it too');
});

test('a source that found nothing new does not pay for a 10MB report', () => {
  // The write is conditioned on the batch having added to what is reported.
  assert.match(lane, /run\.reported\.size > known/);
});

test('the per-source write is quiet and does not settle the archive', () => {
  const fn = INDEX.slice(INDEX.indexOf('const writeReport = '), INDEX.indexOf('/* ======== the postings that were waiting for the AI'));
  assert.match(fn, /retired\.length && !quiet/, 'the retired-roles log is not repeated per source');
  assert.doesNotMatch(fn, /persistVerdicts\(/, 'only the end of the run changes stored verdicts');
  assert.doesNotMatch(fn, /store\.save\(/);
  assert.doesNotMatch(fn, /commitSchedule\(/);
});

test('maxCallsPerRun is a budget for the run, not for each source', () => {
  // A per-batch cap would multiply the budget by the number of sources.
  assert.match(INDEX, /const room = cap && !noModel\(\) \? Math\.max\(cap - run\.asked, 0\) : Infinity;/);
  // It counts what was SENT to the model, not what was handed to the adjudicator: a cached
  // answer costs nothing, and counting it made a replay "exceed the cap" with 218 of 328 cached.
  assert.match(INDEX, /run\.asked \+= adjudication\.calls;/);
  assert.match(INDEX, /maxCalls: room,/);
  assert.doesNotMatch(INDEX, /askable\.slice\(0, (cap|room)\)/);
});

test('a source is committed to the schedule when ITS fetch is safe, not when the run ends', () => {
  // The fetch is durable (snapshot + owed marker) before the source is committed, and
  // the judge lane commits again once the batch is saved — a no-op after the first.
  assert.match(loop, /batches\.save\(owedState\);\s*\n\s*owed = true;[\s\S]{0,900}if \(owed\) commitSchedule\(key\);/);
  assert.match(lane, /await settle\(prepared\);[\s\S]{0,700}commitSchedule\(key\);/);

  // The helper commits only what has not been committed, so the final call at the
  // end of the run does not touch a source twice.
  const state = {};
  const attempts = { a: { cfg: { sleepMinutes: 60 }, failed: false }, b: { cfg: { sleepMinutes: 60 }, failed: false } };
  const committed = new Set();
  const commit = (only) => {
    const todo = Object.fromEntries(Object.entries(attempts).filter(([k]) => !committed.has(k) && (!only || k === only)));
    schedule.commit(state, todo, { now: new Date('2026-10-01T10:00:00Z') });
    for (const k of Object.keys(todo)) committed.add(k);
  };
  commit('a');
  assert.ok(state.sources?.a, 'a finished source is recorded');
  assert.ok(!state.sources?.b, 'a source still to come is not — an interrupted scan leaves it due');
  commit();
  assert.ok(state.sources?.b);
});

test('--only restricts the run but not the snapshot', () => {
  assert.match(INDEX, /const toRun = judgeQueue \? \[\] : onlyArg/);
  // carry stays the whole enabled list, or a partial run would shrink what --replay judges.
  assert.match(INDEX, /carry: enabled/);
  // An unknown name stops the run rather than quietly fetching nothing.
  assert.match(INDEX, /--only: unknown or disabled source/);
});
