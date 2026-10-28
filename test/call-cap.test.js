/**
 * maxCallsPerRun counts calls to the MODEL.
 *
 * It used to slice the batch before the verdict cache was consulted, so an answer that
 * cost nothing used up the allowance. A replay with 218 of 328 postings cached reported
 * "28 over the cap" and held them — for a cap on spending that had spent nothing.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DIR = mkdtempSync(join(tmpdir(), 'jobhunt-cap-'));
process.env.JOBHUNT_DATA_DIR = DIR;
process.env.JOBHUNT_NO_LOGFILE = '1';
process.env.GEMINI_API_KEY_JUDGE = 'k';
process.env.GEMINI_MODEL_JUDGE = 'gemini-flash-lite-latest';
process.env.GEMINI_MAX_CONCURRENCY_JUDGE = '1';
delete process.env.GEMINI_ENABLED;
delete process.env.LLM_PROVIDERS;

const realFetch = globalThis.fetch;
let requests = 0;
globalThis.fetch = async () => {
  requests++;
  const text = JSON.stringify({ decision: 'keep', confidence: 'high', category: 'none', reason: 'fine', resolved: [] });
  return { ok: true, status: 200, headers: new Headers(), text: async () => JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }) };
};
after(() => { globalThis.fetch = realFetch; rmSync(DIR, { recursive: true, force: true }); });

const { adjudicate } = await import('../src/adjudicate.js');
const { p, readJson } = await import('../src/util.js');
const profile = readJson(p('config', 'examples', 'devops.profile.json'));
const item = (n) => ({
  job: { fingerprint: `cap${n}`, title: `DevOps Engineer ${n}`, company: 'Acme', location: 'München', descriptionText: 'Kubernetes. '.repeat(30), source: 'adzuna' },
  uncertainties: [{ kind: 'german', question: '?', evidence: 'x' }],
  fallback: { keep: true, reason: null, category: null, reasons: [] },
});

test('cached answers are free: they do not use up the allowance', async () => {
  // Three get answered and cached.
  await adjudicate([1, 2, 3].map(item), profile, { refresh: true });
  requests = 0;

  // Now seven postings: the three cached and four new, with room for two calls.
  const r = await adjudicate([1, 2, 3, 4, 5, 6, 7].map(item), profile, { maxCalls: 2 });

  assert.equal(r.cached, 3, 'the cached three were answered without counting');
  assert.equal(r.calls, 2, 'and exactly the allowance was spent on the rest');
  assert.equal(requests, 2);
  assert.equal(r.verdicts.size, 5);
  assert.equal(r.capped, 2);
  assert.deepEqual(r.held.map((i) => i.job.fingerprint).sort(), ['cap6', 'cap7'], 'what the breaker leaves WAITS, as a rate limit does');
  assert.equal(r.halt, null, 'and there is no limit to wait out: the next scan carries on');
});

test('with room to spare nothing is held', async () => {
  const r = await adjudicate([1, 2, 3, 4, 5, 6, 7].map(item), profile, { maxCalls: 50 });
  assert.equal(r.capped, 0);
  assert.deepEqual(r.held, []);
  assert.equal(r.verdicts.size, 7);
});

test('no allowance at all asks nothing and still serves the cache', async () => {
  requests = 0;
  const r = await adjudicate([1, 2, 3, 4, 5, 6, 7].map(item), profile, { maxCalls: 0 });
  assert.equal(requests, 0);
  assert.equal(r.verdicts.size, 7, 'all seven were cached by now');
});
