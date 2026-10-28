/**
 * How a 429 is told to be "the day is spent" rather than "slow down".
 *
 * Google's documentation says a 429 happens and how to back off; it does not document the
 * body. The body below is a real captured one (inspect_ai issue 5526). Its message —
 * "You exceeded your current quota, please check your plan and billing details" — does not
 * say "per day" anywhere: the quota ID in details[].violations[] does. Reading the message
 * would have treated a spent day as a 3-minute wait, and, with overflow on, left the billed
 * key idle.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.GEMINI_API_KEY_JUDGE = 'k';
process.env.GEMINI_MODEL_JUDGE = 'gemini-flash-lite-latest';
delete process.env.GEMINI_JUDGE_OVERFLOW_TO_APPLY;
const realFetch = globalThis.fetch;
after(() => { globalThis.fetch = realFetch; });

const { complete, __testables } = await import('../src/providers/gemini.js');
const { isDailyQuota } = __testables;

/** A response as httpJson hands it on: the status and the raw body. */
const asRes = (payload) => ({ ok: false, status: 429, text: JSON.stringify(payload) });
const scopeOf = (payload) => (isDailyQuota(asRes(payload)) ? 'day' : 'minute');

const body = (violations, message = 'You exceeded your current quota, please check your plan and billing details. For more information on this error, head to: https://ai.google.dev/gemini-api/docs/rate-limits.') => ({
  error: {
    code: 429, message, status: 'RESOURCE_EXHAUSTED',
    details: [
      { '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations },
      { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '0.01s' },
    ],
  },
});
const violation = (quotaId, extra = {}) => ({
  quotaMetric: 'generativelanguage.googleapis.com/generate_content_free_tier_requests',
  quotaId, quotaDimensions: { location: 'global', model: 'gemini-2.5-flash' }, quotaValue: '20', ...extra,
});

const answer = async (payload) => {
  globalThis.fetch = async () => ({ ok: false, status: 429, text: async () => JSON.stringify(payload), headers: new Headers() });
  return complete({ system: 's', user: 'u', schema: { type: 'object' } });
};

test('the captured daily body is a spent DAY, though its message never says so', async () => {
  const r = await answer(body([violation('GenerateRequestsPerDayPerProjectPerModel-FreeTier')]));
  assert.equal(r.rateLimited, true);
  assert.equal(r.scope, 'day');
  assert.match(r.error, /20\/day on gemini-2\.5-flash/, 'the limit and model are read from the violation, not guessed from prose');
});

test('the per-minute quota id is a short wait', async () => {
  assert.equal(scopeOf(body([violation('GenerateRequestsPerMinutePerProjectPerModel-FreeTier', { quotaValue: '15' })])), 'minute');
});

test('a token-per-minute quota is a minute too', async () => {
  assert.equal(scopeOf(body([violation('GenerateContentInputTokensPerModelPerMinute-FreeTier', { quotaValue: '250000' })])), 'minute');
});

test('refused by two quotas at once, it is refused until the longer one lifts', async () => {
  assert.equal(scopeOf(body([
    violation('GenerateRequestsPerMinutePerProjectPerModel-FreeTier'),
    violation('GenerateRequestsPerDayPerProjectPerModel-FreeTier'),
  ])), 'day');
});

test('the structured answer beats the words: "per day" in a message about a per-minute quota is still a minute', async () => {
  assert.equal(scopeOf(body(
    [violation('GenerateRequestsPerMinutePerProjectPerModel-FreeTier')],
    'Quota exceeded. See your usage per day and per minute at the dashboard.',
  )), 'minute');
});

test('with no structured details the words are still read, as before', async () => {
  globalThis.fetch = async () => ({ ok: false, status: 429, headers: new Headers(),
    text: async () => JSON.stringify({ error: { code: 429, message: 'Quota exceeded for metric: x, limit: 500 per day, model: gemini-3.5-flash-lite' } }) });
  const r = await complete({ system: 's', user: 'u', schema: { type: 'object' } });
  assert.equal(r.scope, 'day');
  assert.match(r.error, /500\/day on gemini-3\.5-flash-lite/);
});

test('a daily quota is not retried for its retryDelay: the day does not end in 34 seconds', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return { ok: false, status: 429, headers: new Headers(),
      text: async () => JSON.stringify(body([violation('GenerateRequestsPerDayPerProjectPerModel-FreeTier')])) };
  };
  const t0 = Date.now();
  await complete({ system: 's', user: 'u', schema: { type: 'object' } });
  assert.ok(calls <= 2, `one request plus the transport's single retry, got ${calls}`);
  assert.ok(Date.now() - t0 < 3000, 'and it did not sleep');
});
