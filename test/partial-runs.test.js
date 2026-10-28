/**
 * What changes when a run may fetch only SOME of the sources.
 *
 * Before the background app every search asked every source, so two things were
 * quietly true: the replay snapshot held the whole corpus, and nobody ran two
 * searches at once. Neither holds when the tray wakes every half hour beside a
 * terminal. Both have to be made true on purpose.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { p } from '../src/util.js';
import { carryOver } from '../src/fetched.js';
import * as lock from '../src/lock.js';

const job = (id) => ({ title: id });

/* ------------------------------------------------------- the replay snapshot */

test('a partial run keeps the slices of the sources it did not ask', () => {
  // The last full fetch: ats then adzuna then mail.
  const prev = {
    jobs: [job('a1'), job('a2'), job('z1'), job('z2'), job('z3'), job('m1')],
    ranges: { ats: [0, 2], adzuna: [2, 5], mailalerts: [5, 6] },
  };
  // Half an hour later only the inbox was due.
  const raw = [job('m2'), job('m3')];
  const { jobs, ranges } = carryOver(prev, raw, { mailalerts: [0, 2] }, ['ats', 'adzuna', 'mailalerts']);

  assert.deepEqual(jobs.map((j) => j.title), ['m2', 'm3', 'a1', 'a2', 'z1', 'z2', 'z3']);
  assert.deepEqual(ranges.mailalerts, [0, 2], 'the refreshed source is replaced, not appended to');
  assert.deepEqual(jobs.slice(...ranges.ats).map((j) => j.title), ['a1', 'a2']);
  assert.deepEqual(jobs.slice(...ranges.adzuna).map((j) => j.title), ['z1', 'z2', 'z3']);
});

test('the carried ranges point at the right postings after several partial runs', () => {
  let snap = { jobs: [job('a1'), job('m1')], ranges: { ats: [0, 1], mailalerts: [1, 2] } };
  const keys = ['ats', 'mailalerts'];
  for (const [src, title] of [['mailalerts', 'm2'], ['ats', 'a2'], ['mailalerts', 'm3']]) {
    const out = carryOver(snap, [job(title)], { [src]: [0, 1] }, keys);
    snap = { jobs: out.jobs, ranges: out.ranges };
  }
  assert.deepEqual(snap.jobs.slice(...snap.ranges.ats).map((j) => j.title), ['a2']);
  assert.deepEqual(snap.jobs.slice(...snap.ranges.mailalerts).map((j) => j.title), ['m3']);
  assert.equal(snap.jobs.length, 2, 'nothing accumulates');
});

test('a source that failed keeps its old slice instead of a gap', () => {
  // The pipeline gives a source that returned only errors no range, so it is carried.
  const prev = { jobs: [job('a1'), job('a2')], ranges: { ats: [0, 2] } };
  const { jobs } = carryOver(prev, [job('m1')], { mailalerts: [0, 1] }, ['ats', 'mailalerts']);
  assert.deepEqual(jobs.map((j) => j.title), ['m1', 'a1', 'a2']);
});

test('a source switched off stops being carried', () => {
  const prev = { jobs: [job('a1'), job('o1')], ranges: { ats: [0, 1], remoteok: [1, 2] } };
  const { jobs, ranges } = carryOver(prev, [job('m1')], { mailalerts: [0, 1] }, ['ats', 'mailalerts']);
  assert.deepEqual(jobs.map((j) => j.title), ['m1', 'a1']);
  assert.equal(ranges.remoteok, undefined);
});

test('a snapshot from before ranges existed cannot be sliced, so nothing is carried from it', () => {
  const prev = { jobs: [job('old1'), job('old2')] };
  const { jobs, ranges } = carryOver(prev, [job('m1')], { mailalerts: [0, 1] }, ['ats', 'mailalerts']);
  assert.deepEqual(jobs.map((j) => j.title), ['m1']);
  assert.deepEqual(ranges, { mailalerts: [0, 1] });
});

test('no previous snapshot means the run is the snapshot', () => {
  const raw = [job('m1')];
  assert.deepEqual(carryOver(null, raw, { mailalerts: [0, 1] }, ['mailalerts']).jobs, raw);
});

test('the pipeline records a range per source and asks fetched.save to carry the enabled ones', () => {
  const src = readFileSync(p('src', 'index.js'), 'utf8');
  // Each source is saved as it lands, so its range is relative to its own batch.
  // `slice` is the source's own jobs — or, for a source that returns only what is new (the
  // mailbox), those merged into the stored window.
  assert.match(src, /ranges: \{ \[key\]: \[0, slice\.length\] \}/);
  assert.match(src, /fetched\.save\(slice, \{[^}]*carry: enabled/);
  assert.match(src, /if \(!dryRun && !nothingBack && !\(delta && !result\.jobs\.length\)\) \{\s*\n\s*const slice = /, 'a failed source gets no range');
});

test('an empty due-only run is quiet, and an empty full run is still an error', () => {
  const src = readFileSync(p('src', 'index.js'), 'utf8');
  const at = src.indexOf('if (!run.fetched && !run.drained) {');
  // After the offline exit, which has its own test in offline.test.js.
  const block = src.slice(src.indexOf('// An empty inbox is the ordinary result', at), at + 1500);
  assert.match(block, /if \(dueOnly\)/);
  assert.match(block, /log\.dim\(.*returned no postings/);
  assert.match(block, /log\.err\('No jobs fetched from any source/);
});

/* ------------------------------------------------------------- the search lock */

function withLockFile(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'jobhunt-lock-'));
  const file = join(dir, 'search.lock');
  const prior = process.env.JOBHUNT_LOCK_FILE;
  process.env.JOBHUNT_LOCK_FILE = file;
  try {
    return fn(file);
  } finally {
    if (prior === undefined) delete process.env.JOBHUNT_LOCK_FILE;
    else process.env.JOBHUNT_LOCK_FILE = prior;
    rmSync(dir, { recursive: true, force: true });
  }
}

test('a second search cannot take the lock while the first holds it', () => {
  withLockFile(() => {
    const first = lock.acquire();
    assert.equal(typeof first, 'function');
    assert.equal(lock.holder(), process.pid);
    assert.equal(lock.acquire(), null, 'refused while a live process holds it');
    first();
    assert.equal(lock.holder(), null);
    assert.equal(typeof lock.acquire(), 'function', 'free again after release');
  });
});

test('a lock left by a dead process does not block anyone', () => {
  withLockFile((file) => {
    // 2^31-2 is far above any real pid, so this process is certainly not running.
    writeFileSync(file, JSON.stringify({ pid: 2147483646, at: '2026-01-01T00:00:00Z' }));
    assert.equal(lock.holder(), null);
    const release = lock.acquire();
    assert.equal(typeof release, 'function', 'stale lock replaced');
    release();
  });
});

test('a corrupt lock file is treated as no lock rather than as a deadlock', () => {
  withLockFile((file) => {
    writeFileSync(file, 'not json');
    assert.equal(lock.holder(), null);
    assert.equal(typeof lock.acquire(), 'function');
  });
});

test('release removes the file', () => {
  withLockFile((file) => {
    const release = lock.acquire();
    assert.ok(existsSync(file));
    release();
    assert.ok(!existsSync(file));
  });
});

test('search takes the lock around the whole run and releases it when the SEARCH ends', () => {
  // `daily` goes on to serve for hours. A lock released only at process exit
  // would shut the background app out for as long as the server stayed up.
  const src = readFileSync(p('src', 'index.js'), 'utf8');
  const wrapper = src.slice(src.indexOf('async function search()'), src.indexOf('async function runSearch()'));
  assert.match(wrapper, /lock\.acquire\(\)/);
  assert.match(wrapper, /try \{\s*return await runSearch\(\);\s*\} finally \{\s*release\(\);/);
  assert.match(wrapper, /has\('--dry-run'\)\) return runSearch\(\)/, 'a dry run writes nothing to lose, so it may run alongside');
  assert.doesNotMatch(src, /process\.on\('exit', release\)/);
});

test('the tray refuses to start a search while another is running', () => {
  const src = readFileSync(p('src', 'electron', 'main.js'), 'utf8');
  assert.match(src, /mode !== 'report' && lock\.holder\(\)/);
  assert.match(src, /runner\.status\(\)\.running \|\| lock\.holder\(\)/, 'and the tick checks it too');
});
