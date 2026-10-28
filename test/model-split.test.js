/**
 * Two models, one provider.
 *
 * Judging job adverts runs about twenty calls per search and only decides what
 * the user reads. Writing a CV and a letter runs two or three per application and is
 * what an employer sees. The free tier draws the same line: the newer models
 * cap at roughly twenty requests a day, which judging would exhaust in a single
 * run and writing would never approach.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { p } from '../src/util.js';
import * as gemini from '../src/providers/gemini.js';

/** Capture which model each call asks for, without touching the network. */
async function modelsRequestedBy(calls) {
  const real = globalThis.fetch;
  const asked = [];
  globalThis.fetch = async (url) => {
    asked.push(String(url).match(/models\/([^:]+):/)?.[1]);
    return { ok: true, status: 200, text: async () => JSON.stringify({ candidates: [{ content: { parts: [{ text: '{}' }] } }] }) };
  };
  try {
    for (const opts of calls) await gemini.complete({ system: 's', user: 'u', schema: { type: 'object' }, ...opts });
  } finally {
    globalThis.fetch = real;
  }
  return asked;
}

test('a caller may ask for its own model without changing anyone else', async () => {
  process.env.GEMINI_API_KEY_JUDGE = 'test';
  process.env.GEMINI_MODEL_JUDGE = 'gemini-flash-lite-latest';

  const asked = await modelsRequestedBy([
    {},                              // judging
    { model: 'gemini-2.5-pro' },     // writing
    {},                              // judging again — must not have been dragged along
  ]);

  assert.equal(asked[0], 'gemini-flash-lite-latest');
  assert.equal(asked[1], 'gemini-2.5-pro');
  assert.equal(asked[2], 'gemini-flash-lite-latest', 'one caller opting out must not move the default');
});

test('writing falls back to the judging model when nothing is set', () => {
  // Unset means "carry on as before", so adding this feature changes nothing
  // until it is deliberately switched on.
  const src = readFileSync(p('src', 'apply', 'tailor.js'), 'utf8');
  assert.match(src, /process\.env\.GEMINI_MODEL_APPLY \|\| null/,
    'an unset GEMINI_MODEL_APPLY must resolve to null, which means "use the default"');
  assert.match(src, /model: writingModel\(\)/, 'and generation must pass it through');
});

test('writing may use its own key, and judging never borrows it', async () => {
  const real = globalThis.fetch;
  const keys = [];
  globalThis.fetch = async (_url, init) => {
    keys.push(init.headers['x-goog-api-key']);
    return { ok: true, status: 200, text: async () => JSON.stringify({ candidates: [{ content: { parts: [{ text: '{}' }] } }] }) };
  };
  process.env.GEMINI_API_KEY_JUDGE = 'judge-key';
  process.env.GEMINI_API_KEY_APPLY = 'write-key';
  try {
    const base = { system: 's', user: 'u', schema: { type: 'object' } };
    await gemini.complete(base);
    await gemini.complete({ ...base, purpose: 'apply' });
    delete process.env.GEMINI_API_KEY_APPLY;
    await gemini.complete({ ...base, purpose: 'apply' });
  } finally {
    globalThis.fetch = real;
    delete process.env.GEMINI_API_KEY_APPLY;
  }
  assert.deepEqual(keys, ['judge-key', 'write-key', 'judge-key'],
    'apply uses its own key when set, falls back to the judging key when not, and judging ignores it');
});

test('tailoring asks for the apply key', () => {
  const src = readFileSync(p('src', 'apply', 'tailor.js'), 'utf8');
  assert.match(src, /purpose: 'apply'/);
});

test('only the _JUDGE names configure judging; unsuffixed ones are ignored', async () => {
  const real = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, init) => {
    seen.push([String(url).match(/models\/([^:]+):/)?.[1], init.headers['x-goog-api-key']]);
    return { ok: true, status: 200, text: async () => JSON.stringify({ candidates: [{ content: { parts: [{ text: '{}' }] } }] }) };
  };
  Object.assign(process.env, { GEMINI_API_KEY: 'unsuffixed', GEMINI_MODEL: 'other-model',
    GEMINI_API_KEY_JUDGE: 'j', GEMINI_MODEL_JUDGE: 'jm', GEMINI_MAX_CONCURRENCY_JUDGE: '1', GEMINI_MAX_CONCURRENCY: '4' });
  try {
    await gemini.complete({ system: 's', user: 'u', schema: { type: 'object' } });
    assert.equal(gemini.maxConcurrency(), 1);
  } finally {
    globalThis.fetch = real;
    for (const k of ['GEMINI_API_KEY_JUDGE', 'GEMINI_MODEL_JUDGE', 'GEMINI_MAX_CONCURRENCY_JUDGE', 'GEMINI_API_KEY', 'GEMINI_MODEL', 'GEMINI_MAX_CONCURRENCY']) delete process.env[k];
  }
  assert.deepEqual(seen, [['jm', 'j']]);
});
