/**
 * When the free daily quota is spent, judging may continue on the billed project.
 *
 * Opt-in (`GEMINI_JUDGE_OVERFLOW_TO_APPLY`), because it is the one thing here that costs
 * money. It switches on a spent DAILY quota only — a per-minute limit clears in seconds and
 * the billed key would only be paying for a hiccup — and it asks the cheap judging model, not
 * the writing one.
 *
 * Runs the real provider against a fake Google that answers per key, with a throwaway data
 * directory (the "free project is spent until X" memory is a file).
 */
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DIR = mkdtempSync(join(tmpdir(), 'jobhunt-overflow-'));
process.env.JOBHUNT_DATA_DIR = DIR;
process.env.JOBHUNT_NO_LOGFILE = '1';
process.env.GEMINI_API_KEY_JUDGE = 'FREE';
process.env.GEMINI_MODEL_JUDGE = 'gemini-flash-lite-latest';
process.env.GEMINI_MODEL_APPLY = 'gemini-3.7-flash';
delete process.env.GEMINI_ENABLED;
delete process.env.LLM_PROVIDERS;

const realFetch = globalThis.fetch;
/** What each key's next calls do: 'ok' | 'day' | 'minute' | 'bad'. The last entry repeats. */
let plan = {};
let seen = [];     // [key, model] per request that reached "Google"

const reply = (status, body) => ({ ok: status < 400, status, text: async () => JSON.stringify(body), headers: new Headers() });
const VERDICT = { decision: 'keep', confidence: 'high', category: 'none', reason: 'fine', resolved: [] };

globalThis.fetch = async (url, init) => {
  const key = init.headers['x-goog-api-key'];
  const model = String(url).match(/models\/([^:]+):/)?.[1];
  seen.push([key, model]);
  const steps = plan[key] || ['ok'];
  const n = seen.filter(([k]) => k === key).length - 1;
  const step = steps[Math.min(n, steps.length - 1)];
  if (step === 'ok') return reply(200, { candidates: [{ content: { parts: [{ text: JSON.stringify(VERDICT) }] } }] });
  if (step === 'bad') return reply(400, { error: { message: 'API key not valid. Please pass a valid API key.' } });
  if (step === 'minute') {
    return reply(429, { error: { message: 'limit: 15 per minute', details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '0s' }] } });
  }
  return reply(429, { error: { message: 'Quota exceeded for metric ... limit: 500 per day, model: gemini-3.5-flash-lite' } });
};

after(() => { globalThis.fetch = realFetch; rmSync(DIR, { recursive: true, force: true }); });

let fresh = 0;
/** A new copy of the provider, so "spent" memory and the resolved model start empty. */
const provider = () => import(`../src/providers/gemini.js?fresh=${++fresh}`);
const ask = (g, extra = {}) => g.complete({ system: 's', user: 'u', schema: { type: 'object' }, ...extra });
const stateFile = join(DIR, 'llm-keys.json');

beforeEach(() => {
  plan = {}; seen = [];
  rmSync(stateFile, { force: true });
  process.env.GEMINI_API_KEY_APPLY = 'BILLED';
  process.env.GEMINI_JUDGE_OVERFLOW_TO_APPLY = 'true';
});

test('off by default: a spent daily quota holds, and the billed key is never touched', async () => {
  delete process.env.GEMINI_JUDGE_OVERFLOW_TO_APPLY;
  plan = { FREE: ['day'] };
  const r = await ask(await provider());
  assert.equal(r.rateLimited, true);
  assert.equal(r.scope, 'day');
  assert.equal(seen.some(([k]) => k === 'BILLED'), false, 'it costs money, so it is a choice');
});

test('on: the daily quota is spent, so the SAME call is answered by the billed key', async () => {
  plan = { FREE: ['day'], BILLED: ['ok'] };
  const r = await ask(await provider());
  assert.equal(r.ok, true);
  assert.equal(r.overflow, true, 'and the caller is told, because it cost money');
  const billed = seen.find(([k]) => k === 'BILLED');
  assert.equal(billed[1], 'gemini-flash-lite-latest', 'the cheap judging model, not the writing model');
});

test('once spent, the free project is not asked again — within the run or the next one', async () => {
  plan = { FREE: ['day'], BILLED: ['ok'] };
  const g = await provider();
  await ask(g);
  const freeCalls = seen.filter(([k]) => k === 'FREE').length;
  await ask(g);
  await ask(g);
  assert.equal(seen.filter(([k]) => k === 'FREE').length, freeCalls, 'later calls go straight to the billed key');

  // A new run is a new process; what it knows is the file.
  const saved = JSON.parse(readFileSync(stateFile, 'utf8'));
  assert.ok(new Date(saved.judgeSpentUntil) > new Date(), 'remembered until the quota resets');
  const before = seen.filter(([k]) => k === 'FREE').length;
  const next = await provider();
  const r = await ask(next);
  assert.equal(r.overflow, true);
  assert.equal(seen.filter(([k]) => k === 'FREE').length, before, 'a fresh process does not re-ask the spent project');
});

test('after the reset the free project is used again', async () => {
  writeFileSync(stateFile, JSON.stringify({ judgeSpentUntil: new Date(Date.now() - 60000).toISOString() }));
  plan = { FREE: ['ok'] };
  const r = await ask(await provider());
  assert.equal(r.ok, true);
  assert.equal(r.overflow, undefined, 'free again, no charge');
  assert.deepEqual(seen.map(([k]) => k), ['FREE']);
});

test('a per-minute limit is NOT a reason to switch: the billed key would pay for a hiccup', async () => {
  plan = { FREE: ['minute'] };
  const r = await ask(await provider());
  assert.equal(r.rateLimited, true);
  assert.equal(r.scope, 'minute');
  assert.equal(seen.some(([k]) => k === 'BILLED'), false);
  assert.equal(existsSync(stateFile), false, 'and the free project is not marked spent');
});

test('without an apply key the flag does nothing', async () => {
  delete process.env.GEMINI_API_KEY_APPLY;
  plan = { FREE: ['day'] };
  const r = await ask(await provider());
  assert.equal(r.rateLimited, true);
  assert.equal(r.overflow, undefined);
});

test('writing is never moved to the free key, and never counts as overflow', async () => {
  plan = { BILLED: ['ok'] };
  const r = await ask(await provider(), { purpose: 'apply', model: 'gemini-3.7-flash' });
  assert.equal(r.ok, true);
  assert.equal(r.overflow, undefined);
  assert.deepEqual(seen, [['BILLED', 'gemini-3.7-flash']]);
});

test('a broken billed key must not turn a spent quota into rules verdicts: the postings wait', async () => {
  plan = { FREE: ['day'], BILLED: ['bad'] };
  const r = await ask(await provider());
  assert.equal(r.ok, false);
  assert.equal(r.rateLimited, true, 'reported as the quota it is, so the caller holds the posting');
  assert.equal(r.scope, 'day');
  assert.match(r.error, /billed key could not take over/);
});

test('if the billed project is limited too, the posting waits as it always did', async () => {
  plan = { FREE: ['day'], BILLED: ['day'] };
  const r = await ask(await provider());
  assert.equal(r.rateLimited, true);
  assert.equal(r.scope, 'day');
});

test('the adjudicator carries on to the end of the batch instead of holding it, and counts the paid calls', async () => {
  const { adjudicate } = await import('../src/adjudicate.js');
  const { p, readJson } = await import('../src/util.js');
  const profile = readJson(p('config', 'examples', 'devops.profile.json'));
  const item = (n) => ({
    job: { fingerprint: `ov${n}`, title: `DevOps Engineer ${n}`, company: 'Acme', location: 'München', descriptionText: 'Kubernetes. '.repeat(30), source: 'adzuna' },
    uncertainties: [{ kind: 'german', question: '?', evidence: 'x' }],
    fallback: { keep: true, reason: null, category: null, reasons: [] },
  });

  // 2 answered free, then the quota is gone; the billed key takes the other 3.
  plan = { FREE: ['ok', 'ok', 'day'], BILLED: ['ok'] };
  process.env.GEMINI_MAX_CONCURRENCY_JUDGE = '1';
  const r = await adjudicate([1, 2, 3, 4, 5].map(item), profile, { refresh: true });

  assert.equal(r.verdicts.size, 5, 'everything was judged');
  assert.deepEqual(r.held, [], 'nothing waits for tomorrow');
  assert.equal(r.halt, null);
  assert.equal(r.overflow, 3, 'three calls were paid for, and the run says so');
  assert.equal([...r.verdicts.values()].some((v) => v.source === 'rules-fallback'), false);
});

test('a billed call is COUNTED, a refused one is not, and the count survives in a file', async () => {
  const ks = await import('../src/keystate.js');
  rmSync(stateFile, { force: true });
  plan = { FREE: ['day'], BILLED: ['ok'] };
  const g = await provider();
  await ask(g);
  await ask(g);
  assert.equal(ks.billedUsage().calls, 2, 'two answers paid for');

  plan = { FREE: ['day'], BILLED: ['day'] };
  await ask(await provider());
  assert.equal(ks.billedUsage().calls, 2, 'a refused request is not charged, so it is not counted');
});

test('the count is per month and priced as an estimate', async () => {
  const ks = await import('../src/keystate.js');
  rmSync(stateFile, { force: true });
  ks.countBilled(10, new Date('2026-09-30T12:00:00Z'));
  ks.countBilled(4, new Date('2026-10-01T12:00:00Z'));
  assert.equal(ks.billedUsage(ks.load(), new Date('2026-10-15T00:00:00Z')).calls, 4, 'a new month starts at zero');
  assert.equal(ks.billedUsage(ks.load(), new Date('2026-09-15T00:00:00Z')).calls, 10);
  assert.equal(ks.describeUsage({ calls: 1, usd: ks.EST_USD_PER_CALL }), '1 call this month, about $<0.01');
  assert.equal(ks.describeUsage({ calls: 4000, usd: 4000 * ks.EST_USD_PER_CALL }), '4000 calls this month, about $1.20');
});
