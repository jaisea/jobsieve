/**
 * The real scan skips postings the title already settled — and applies a rule edit to them.
 *
 * Runs `search --judge-queue --no-enrich` on a stored fetch that is marked owed, in a throwaway
 * data directory, with no model. The owed batch goes through the same prepare() every fetch does.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { p } from '../src/util.js';

const DIR = mkdtempSync(join(tmpdir(), 'jobhunt-drops-e2e-'));
const DATA = join(DIR, 'data');
const REPORTS = join(DIR, 'reports');
mkdirSync(DATA, { recursive: true });
after(() => rmSync(DIR, { recursive: true, force: true }));

const raw = (n, title) => ({
  source: 'adzuna', sourceId: `adzuna:drop${n}`, title, company: `Co ${n} GmbH`, location: 'München',
  applyUrl: `https://example.test/drop/${n}`, postedAt: new Date().toISOString(),
  descriptionText: 'We run Kubernetes, Terraform, Azure, GitOps and Grafana in production. '.repeat(15),
});
const JOBS = [raw(1, 'Account Executive, Enterprise'), raw(2, 'Frontend Engineer (React)'), raw(3, 'Senior DevOps Engineer (m/w/d)')];

const seed = () => {
  writeFileSync(join(DATA, 'fetched.json'), JSON.stringify({
    version: 1, fetchedAt: new Date().toISOString(), count: JOBS.length, ranges: { adzuna: [0, JOBS.length] },
    sources: [], warnings: [], jobs: JOBS,
  }));
  writeFileSync(join(DATA, 'batches.json'), JSON.stringify({ version: 1, owed: { adzuna: { label: 'Adzuna', count: JOBS.length, fetchedAt: new Date().toISOString(), attempts: 0 } } }));
};
const read = (name) => (existsSync(join(DATA, name)) ? JSON.parse(readFileSync(join(DATA, name), 'utf8')) : null);

const run = () => new Promise((resolve) => {
  seed();
  const child = spawn(process.execPath, [p('src', 'index.js'), 'search', '--judge-queue', '--no-enrich'], {
    cwd: p('.'),
    env: { ...process.env, JOBHUNT_DATA_DIR: DATA, JOBHUNT_REPORTS_DIR: REPORTS, JOBHUNT_NO_LOGFILE: '1', JOBHUNT_PROFILE: p('config', 'examples', 'devops.profile.json'), GEMINI_ENABLED: 'false' },
  });
  let out = '';
  child.stdout.on('data', (c) => { out += c; });
  child.stderr.on('data', (c) => { out += c; });
  child.on('close', (code) => resolve({ code, out: out.replace(/\u001B\[[0-9;]*m/g, '') }));
});

const runsOf = () => Object.values(read('rejected.json')?.rejected || {}).map((e) => e.runs).sort();

test('the first scan analyses everything and remembers what the title settled', async () => {
  const r = await run();
  assert.equal(r.code, 0, r.out);
  assert.doesNotMatch(r.out, /recognised/, 'nothing was known yet');
  assert.match(r.out, /Normalizing 3 postings/);

  const memo = read('title-drops.json');
  assert.equal(Object.keys(memo.drops).length, 2, 'the account executive and the frontend engineer — not the DevOps role');
  assert.ok(memo.rules, 'stamped with the rules version it was decided under');
  assert.deepEqual(runsOf(), [1, 1]);
});

test('the next scan recognises them: not normalized, not re-filed, still counted', async () => {
  const r = await run();
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /2 already settled on their title in the last 3 days — recognised, not re-analysed/);
  assert.match(r.out, /Normalizing 1 postings/, 'only the posting the title did not settle');
  assert.match(r.out, /2 recognised from the last scan/);
  assert.deepEqual(runsOf(), [1, 1], 'their archive entries were not touched: nothing re-derived');
  // They still count in the per-gate figures, or the drift watch would see the shares collapse.
  assert.match(r.out, /adzuna: 3 judged · relevance|adzuna: 3 judged · title-exclude/);
});

test('a change to the rules sends them back through the whole analysis', async () => {
  // What a gate edit does: the rules version the memo was made under no longer matches.
  const memo = read('title-drops.json');
  writeFileSync(join(DATA, 'title-drops.json'), JSON.stringify({ ...memo, rules: 'rules-of-yesterday' }));

  const r = await run();
  assert.equal(r.code, 0, r.out);
  assert.doesNotMatch(r.out, /recognised/);
  assert.match(r.out, /Normalizing 3 postings/);
  assert.deepEqual(runsOf(), [2, 2], 'analysed and filed again');
  assert.notEqual(read('title-drops.json').rules, 'rules-of-yesterday', 'and remembered under the current rules');
});
