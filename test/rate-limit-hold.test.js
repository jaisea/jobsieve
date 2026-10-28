/**
 * A rate limit holds postings; it does not decide them.
 *
 * When the model said "slow down" or "that is enough for today", every posting
 * not yet reached took its RULES verdict — the verdict of the very rules that
 * were not sure, which is why it was sent to the model. A keep was a coin toss
 * and a drop was a job the user would never see, filed as though it had been judged.
 *
 * These run the real adjudicator against a fake Gemini that answers with
 * whatever the test says, and a throwaway data directory.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DIR = mkdtempSync(join(tmpdir(), 'jobhunt-limit-'));
process.env.JOBHUNT_DATA_DIR = DIR;
process.env.GEMINI_API_KEY_JUDGE = 'test-key';
process.env.GEMINI_MODEL_JUDGE = 'gemini-flash-lite-latest';
process.env.GEMINI_MAX_CONCURRENCY_JUDGE = '1';
process.env.JOBHUNT_NO_LOGFILE = '1';
delete process.env.GEMINI_ENABLED;
delete process.env.LLM_PROVIDERS;

const { adjudicate } = await import('../src/adjudicate.js');
const { p, readJson } = await import('../src/util.js');

const profile = readJson(p('config', 'examples', 'devops.profile.json'));

const realFetch = globalThis.fetch;
let script = [];     // one entry per call: 'ok' | 'minute' | 'day'
let calls = 0;

const reply = (status, body) => ({ ok: status < 400, status, text: async () => JSON.stringify(body), headers: new Headers() });

before(() => {
  globalThis.fetch = async () => {
    const step = script[Math.min(calls++, script.length - 1)];
    if (step === 'ok') {
      return reply(200, { candidates: [{ content: { parts: [{ text: JSON.stringify({
        decision: 'keep', confidence: 'high', category: 'none', reason: 'fine', resolved: [],
      }) }] } }] });
    }
    if (step === 'day') {
      return reply(429, { error: { message: 'Quota exceeded for metric: generate_content_free_tier_requests, limit: 500 per day, model: gemini-3.5-flash-lite' } });
    }
    // A per-minute limit with an immediate retry delay, so the retries finish at once.
    return reply(429, { error: { message: 'Quota exceeded: limit: 15 per minute', details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '0s' }] } });
  };
});

after(() => {
  globalThis.fetch = realFetch;
  rmSync(DIR, { recursive: true, force: true });
});

const item = (n) => ({
  job: {
    fingerprint: `fp${n}`, title: `DevOps Engineer ${n}`, company: 'Acme', location: 'München',
    descriptionText: 'We run Kubernetes and Terraform on Azure. '.repeat(10), source: 'adzuna',
  },
  uncertainties: [{ kind: 'german', question: 'Is German required?', evidence: 'x' }],
  fallback: { keep: true, reason: null, category: null, reasons: [] },
});

const run = async (steps, n) => {
  script = steps; calls = 0;
  return adjudicate(Array.from({ length: n }, (_, i) => item(i + 1)), profile, { refresh: true });
};

test('a spent daily quota holds the rest of the batch: no verdict, no rules fallback', async () => {
  const r = await run(['ok', 'ok', 'day'], 5);

  assert.deepEqual([...r.verdicts.keys()].sort(), ['fp1', 'fp2'], 'only the two the model answered have a verdict');
  assert.deepEqual(r.held.map((i) => i.job.fingerprint), ['fp3', 'fp4', 'fp5'], 'the one refused and the two never reached');
  assert.equal([...r.verdicts.values()].some((v) => v.source === 'rules-fallback'), false, 'nothing was decided by the rules');
  assert.equal(r.halt.scope, 'day');
  assert.ok(new Date(r.halt.until) > new Date(), 'and it says when to come back');
  // 2 answered + the refused one (httpJson retries a 429 once). Five postings, so the
  // two never reached would add two more requests if it carried on.
  assert.ok(calls <= 4, `it stopped asking once refused, but sent ${calls} requests`);
});

test('the daily reset is the next midnight Pacific, not a guess', async () => {
  const r = await run(['day'], 1);
  const until = new Date(r.halt.until);
  const hoursAway = (until - Date.now()) / 3600000;
  assert.ok(hoursAway > 0 && hoursAway <= 24.1, `expected within a day, got ${hoursAway}h`);
});

test('a per-minute limit that outlasts its retries holds the batch for a few minutes', async () => {
  const r = await run(['ok', 'minute'], 3);
  assert.deepEqual([...r.verdicts.keys()], ['fp1']);
  assert.deepEqual(r.held.map((i) => i.job.fingerprint), ['fp2', 'fp3']);
  assert.equal(r.halt.scope, 'minute');
  const minutes = (new Date(r.halt.until) - Date.now()) / 60000;
  assert.ok(minutes > 0 && minutes < 10, `a short wait, got ${minutes} min`);
});

test('a batch that fits inside the limit is untouched', async () => {
  const r = await run(['ok'], 3);
  assert.equal(r.verdicts.size, 3);
  assert.deepEqual(r.held, []);
  assert.equal(r.halt, null);
  assert.equal(r.mode, 'llm');
});

test('a run that only waited is not reported as judged by rules', async () => {
  const r = await run(['day'], 2);
  assert.equal(r.verdicts.size, 0);
  assert.equal(r.mode, 'waiting');
});

test('what the model did answer is written down as it arrives', async () => {
  // A scan cut off half way must not throw away the answers it paid for: with a
  // quota of 500 a day, asking them all again on resume is real money.
  await run(['ok', 'ok', 'ok', 'day'], 4);
  const file = join(DIR, 'verdicts.json');
  assert.ok(existsSync(file));
  const saved = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual(Object.keys(saved.verdicts).sort(), ['fp1', 'fp2', 'fp3'], 'and the held one has none');
});

test('a bad key is still a fallback, not a wait: waiting would never fix it', async () => {
  globalThis.fetch = async () => reply(400, { error: { message: 'API key not valid. Please pass a valid API key.' } });
  try {
    const r = await adjudicate([item(1), item(2)], profile, { refresh: true });
    assert.deepEqual(r.held, [], 'not held');
    assert.equal([...r.verdicts.values()].every((v) => v.source === 'rules-fallback'), true);
  } finally {
    globalThis.fetch = async () => reply(200, {});
  }
});
