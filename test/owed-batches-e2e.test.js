/**
 * A source that was fetched but never judged is judged on the next start — without
 * fetching it again.
 *
 * The fetch of a source is the one step that cannot be repeated for free: it spends
 * quota, and the source is put to sleep on the strength of it. A scan that died
 * between that fetch and the save used to lose the postings; the source, never
 * committed, was then fetched all over again. Now the fetch is made durable first
 * (the replay snapshot) and marked owed (batches.js), and a scan that starts with
 * something owed judges it before it fetches anything.
 *
 * Like the waiting-queue test this runs the real command, here with `--no-enrich`
 * so no advert is requested, against a throwaway data directory.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { p } from '../src/util.js';

const DIR = mkdtempSync(join(tmpdir(), 'jobhunt-owed-'));
const DATA = join(DIR, 'data');
const REPORTS = join(DIR, 'reports');
mkdirSync(DATA, { recursive: true });
after(() => rmSync(DIR, { recursive: true, force: true }));

const raw = (n) => ({
  source: 'adzuna', sourceId: `adzuna:owed${n}`, title: `Senior DevOps Engineer ${n}`, company: `Owed ${n} GmbH`,
  location: 'München', applyUrl: `https://example.test/owed/${n}`, postedAt: new Date().toISOString(),
  descriptionText: 'We run Kubernetes, Terraform, Azure, GitOps and Grafana in production. '.repeat(15),
});

const write = (name, data) => writeFileSync(join(DATA, name), JSON.stringify(data));
const read = (name) => (existsSync(join(DATA, name)) ? JSON.parse(readFileSync(join(DATA, name), 'utf8')) : null);

const seed = ({ jobs = [], owed = {}, schedule = {} }) => {
  write('fetched.json', {
    version: 1, fetchedAt: new Date().toISOString(), count: jobs.length,
    ranges: jobs.length ? { adzuna: [0, jobs.length] } : {}, sources: [], warnings: [], jobs,
  });
  write('batches.json', { version: 1, owed });
  write('schedule.json', { version: 1, sources: schedule });
};

const run = (args = []) => new Promise((resolve) => {
  const child = spawn(process.execPath, [p('src', 'index.js'), 'search', '--judge-queue', '--no-enrich', ...args], {
    cwd: p('.'),
    env: {
      ...process.env,
      JOBHUNT_DATA_DIR: DATA, JOBHUNT_REPORTS_DIR: REPORTS, JOBHUNT_NO_LOGFILE: '1', JOBHUNT_PROFILE: p('config', 'examples', 'devops.profile.json'),
      // No provider: nothing here needs the model, and nothing may reach for one.
      GEMINI_ENABLED: 'false',
    },
  });
  let out = '';
  child.stdout.on('data', (c) => { out += c; });
  child.stderr.on('data', (c) => { out += c; });
  child.on('close', (code) => resolve({ code, out: out.replace(/\u001B\[[0-9;]*m/g, '') }));
});

const owedEntry = (over = {}) => ({ label: 'Adzuna', count: 2, fetchedAt: new Date(Date.now() - 600000).toISOString(), attempts: 0, ...over });

test('an owed source is judged from the snapshot, then no longer owed', async () => {
  seed({ jobs: [raw(1), raw(2)], owed: { adzuna: owedEntry() }, schedule: { adzuna: { lastRunAt: new Date().toISOString(), failed: false } } });

  const r = await run();
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /Resuming Adzuna/);
  assert.match(r.out, /never judged — no new request needed/);

  assert.deepEqual(read('batches.json').owed, {}, 'the marker is cleared once the batch is saved');
  const seen = read('seen.json') || {};
  assert.ok(Object.keys(seen).length >= 1, `the postings reached memory\n${r.out}`);
  assert.ok(read('schedule.json').sources.adzuna, 'and the source stays asleep: it was not touched');
});

test('a snapshot that no longer holds the slice sends the source back to be fetched', async () => {
  seed({ jobs: [], owed: { adzuna: owedEntry({ count: 5 }) }, schedule: { adzuna: { lastRunAt: new Date().toISOString(), failed: false } } });

  const r = await run();
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /the stored fetch is gone — it will be fetched again/);
  assert.deepEqual(read('batches.json').owed, {});
  assert.equal(read('schedule.json').sources.adzuna, undefined, 'its sleep is forgotten, so it is due at the next look');
});

test('a batch that keeps failing is left alone and reported — until asked for by hand', async () => {
  seed({ jobs: [raw(3)], owed: { adzuna: owedEntry({ count: 1, attempts: 3 }) } });

  // Without the flag a scan skips it (a due-only scan would also fetch, so that half is
  // pinned in the source test); here, the rule that decides.
  const { stuck } = await import('../src/batches.js');
  assert.equal(stuck({ attempts: 3 }), true);
  assert.equal(stuck({ attempts: 2 }), false);

  const r = await run();                         // --judge-queue IS by hand: it tries again
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(read('batches.json').owed, {}, 'and a fixed cause clears it');
});
