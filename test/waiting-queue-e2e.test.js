/**
 * Postings the model could not answer wait, and are judged after the limit resets.
 *
 * This runs the REAL command — `search --judge-queue` — as a child process, against
 * a local server that plays Google, and a throwaway data directory. Nothing about
 * the queue is mocked: what is read is what the pipeline wrote.
 *
 * The scenario is the one that started it: the daily quota runs out half way through
 * a batch. Before, the rest took their rules verdicts and were reported or rejected
 * as though judged. Now they must be held, untouched, until the quota is back.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { p, readJson } from '../src/util.js';
import { normalize } from '../src/normalize.js';
import { score } from '../src/score.js';

const DIR = mkdtempSync(join(tmpdir(), 'jobhunt-e2e-'));
const DATA = join(DIR, 'data');
const REPORTS = join(DIR, 'reports');
const profile = readJson(p('config', 'examples', 'devops.profile.json'));

/** What the fake Google does with the next request: 'ok' or 'day'. */
let mode = 'ok';
let okBudget = Infinity;       // answer this many with 200, then switch to the daily-quota error
let requests = 0;
let server;
let base;

before(async () => {
  server = createServer((req, res) => {
    requests++;
    req.resume();
    req.on('end', () => {
      const out = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
      if (mode === 'ok' && okBudget > 0) {
        okBudget--;
        return out(200, { candidates: [{ content: { parts: [{ text: JSON.stringify({
          decision: 'keep', confidence: 'high', category: 'none', reason: 'a good fit', resolved: ['german'],
        }) }] } }] });
      }
      return out(429, { error: { message: 'Quota exceeded for metric: generate_content_free_tier_requests, limit: 500 per day, model: gemini-3.5-flash-lite' } });
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}/v1beta`;
});

after(async () => {
  await new Promise((r) => server.close(r));
  rmSync(DIR, { recursive: true, force: true });
});

/** A posting the way prepare() would have left it when the model was needed. */
const heldItem = (n) => {
  const raw = {
    source: 'adzuna', sourceId: `adzuna:e2e${n}`, title: `Senior DevOps Engineer ${n}`, company: `Acme ${n} GmbH`,
    location: 'München', applyUrl: `https://example.test/job/${n}`, postedAt: new Date().toISOString(),
    descriptionText: 'We run Kubernetes, Terraform and Azure in production. '.repeat(12),
  };
  const job = normalize(raw, profile);
  return {
    job: { ...job, ...score(job, profile), band: 'main' },
    uncertainties: [{ kind: 'german', question: 'Is German required?', evidence: 'x' }],
    fallback: { keep: true, reason: null, category: null, reasons: [] },
  };
};

const seedQueue = (n) => {
  const items = {};
  for (let i = 1; i <= n; i++) {
    const item = heldItem(i);
    items[item.job.fingerprint] = {
      item, source: 'adzuna', label: 'Adzuna', reason: 'daily limit',
      queuedAt: new Date(Date.now() - 3600000 * (n - i + 1)).toISOString(),   // 1 is the oldest
      lastTriedAt: new Date().toISOString(), attempts: 1,
    };
  }
  mkdirSync(DATA, { recursive: true });
  writeFileSync(join(DATA, 'awaiting.json'), JSON.stringify({
    version: 1, items,
    hold: { scope: 'day', until: new Date(Date.now() + 6 * 3600000).toISOString(), reason: 'daily quota', since: new Date().toISOString() },
  }));
  return Object.keys(items);
};



const runJudgeQueue = () => new Promise((resolve) => {
  const child = spawn(process.execPath, [p('src', 'index.js'), 'search', '--judge-queue'], {
    cwd: p('.'),
    env: {
      ...process.env,
      JOBHUNT_DATA_DIR: DATA, JOBHUNT_REPORTS_DIR: REPORTS, JOBHUNT_NO_LOGFILE: '1', JOBHUNT_PROFILE: p('config', 'examples', 'devops.profile.json'),
      GEMINI_API_BASE: base, GEMINI_API_KEY_JUDGE: 'test', GEMINI_MODEL_JUDGE: 'gemini-flash-lite-latest',
      GEMINI_MAX_CONCURRENCY_JUDGE: '1', GEMINI_ENABLED: 'true', LLM_PROVIDERS: 'gemini',
    },
  });
  let out = '';
  child.stdout.on('data', (c) => { out += c; });
  child.stderr.on('data', (c) => { out += c; });
  child.on('close', (code) => resolve({ code, out: out.replace(/\u001B\[[0-9;]*m/g, '') }));
});

const file = (name) => (existsSync(join(DATA, name)) ? JSON.parse(readFileSync(join(DATA, name), 'utf8')) : null);

test('the quota runs out half way: the rest WAIT, undecided, with a time to come back', async () => {
  const fps = seedQueue(4);
  mode = 'ok'; okBudget = 2; requests = 0;

  const r = await runJudgeQueue();
  assert.equal(r.code, 0, r.out);

  const q = file('awaiting.json');
  assert.equal(Object.keys(q.items).length, 2, `two answered, two still waiting\n${r.out}`);
  assert.deepEqual(Object.keys(q.items).sort(), fps.slice(2).sort(), 'the OLDEST were asked first, so the newest are the ones left');
  assert.equal(q.hold.scope, 'day');
  assert.ok(new Date(q.hold.until) > new Date(), 'and it knows when the quota is back');

  const seen = file('seen.json');
  assert.deepEqual(Object.keys(seen).sort(), fps.slice(0, 2).sort(), 'only the answered ones reached memory');
  for (const fp of fps.slice(2)) {
    assert.equal(seen[fp], undefined, 'a waiting posting is not reported as open');
  }
  const rejected = file('rejected.json') || {};
  for (const fp of fps.slice(2)) {
    assert.equal(JSON.stringify(rejected).includes(fp), false, 'nor archived as a rejection by the rules');
  }
  assert.match(r.out, /waiting for the AI/);
  assert.equal(file('verdicts.json').verdicts && Object.keys(file('verdicts.json').verdicts).length, 2, 'the two answers are cached');
});

test('after the reset the same command finishes the queue', async () => {
  mode = 'ok'; okBudget = Infinity;
  const before = Object.keys(file('awaiting.json').items);
  assert.equal(before.length, 2);

  const r = await runJudgeQueue();
  assert.equal(r.code, 0, r.out);

  const q = file('awaiting.json');
  assert.deepEqual(q.items, {}, `nothing left waiting\n${r.out}`);
  assert.equal(q.hold, null, 'and no stale hold is left behind');
  assert.equal(Object.keys(file('seen.json')).length, 4, 'all four are in memory now');
});

test('with nothing waiting it says so and asks the model nothing', async () => {
  requests = 0;
  const r = await runJudgeQueue();
  assert.equal(r.code, 0, r.out);
  assert.equal(requests, 0, 'no request was sent');
  assert.match(r.out, /nothing was waiting for the AI/);
});
