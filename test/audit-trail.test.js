/**
 * What an application folder keeps.
 *
 * The requirements promise the tool keeps "what was sent, what came back, what
 * was flagged, and a frozen copy of the generated text". Three of the four were
 * true: baseline.json held the generated lines, checks.json what the verifier
 * refused, review.json what the reviewer said, meta.json the provider and model.
 *
 * The prompt was not kept. So a letter that came out wrong could be read, and
 * the model named, but the instructions behind it were gone — which is the one
 * question worth asking of something that went out under the user's name. The model
 * name alone explains nothing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { p } from '../src/util.js';
import { __testables as T } from '../src/apply/tailor.js';

const TAILOR = readFileSync(p('src', 'apply', 'tailor.js'), 'utf8');
const APPLY = readFileSync(p('src', 'apply', 'index.js'), 'utf8');

// Shaped like the real master.json — leanMaster() reaches into voice, and
// pickSamples() reads voice.samples. A flat fixture threw rather than failing.
const master = {
  facts: { technologies: ['Azure', 'Kubernetes', 'Terraform'] },
  positioning: { headline: 'DevOps leader with 12 years' },
  identity: { workRights: 'permanent resident', noticePeriod: '3 months', location: 'somewhere' },
  voice: {
    samples: [{ id: 'sample-1', tags: ['platform'], text: 'A sample letter in the candidate voice, long enough to be worth picking.' }],
  },
};
const job = {
  title: 'Platform Engineer', company: 'Example GmbH', location: 'München',
  descriptionText: 'We run Kubernetes on Azure and want someone to own the platform.',
  applyUrl: 'https://example.invalid',
};

test('the prompt travels back with the answer', () => {
  // call() is private and every path returns through it, so this is the single
  // point where a saved prompt can be lost.
  const at = TAILOR.indexOf('async function call(');
  const ret = TAILOR.indexOf('if (res.ok) return', at);
  assert.ok(ret > at, 'call() must still return on success');
  assert.match(TAILOR.slice(ret, ret + 200), /sent: \{ system, user \}/,
    'the success return must carry what was sent');
});

test('all three model calls record their prompt, including the conditional ones', () => {
  // repair runs only when something was refused and review only when a provider
  // answers, so both are easy to leave out. Seeded null rather than omitted, so
  // the file says which calls happened.
  assert.match(APPLY, /const sent = \{ generate: g\.sent, repair: null, review: null \}/);
  assert.match(APPLY, /sent\.repair = r\.sent/, 'repair must record its prompt');
  assert.match(APPLY, /sent\.review = r\.sent/, 'review must record its prompt');
});

test('the prompt file is written before any document', () => {
  // Same rule the rest of the audit trail follows: if generation blocks, the
  // record of what was asked must survive anyway.
  const write = APPLY.indexOf("writeJson(join(gen, 'prompts.json')");
  const docs = APPLY.indexOf('/* ---- documents ---- */');
  assert.ok(write > 0, 'prompts.json must be written');
  assert.ok(docs > write, 'and written before the documents are produced');
});

test('what gets saved is the real prompt, not a stub', () => {
  // The value of the file is entirely in its content. These are the exact two
  // strings call() stores, so an empty or templated prompt would be caught here
  // rather than discovered when a letter needs explaining months later.
  const system = T.systemPrompt(master, T.pickSamples(master, job));
  const user = T.userPrompt(job, {
    summary: [{ index: 3, text: 'A line from the CV.' }],
    employers: [{ name: 'Example Employer', bullets: [{ index: 9, text: 'A bullet worth editing.' }] }],
  });

  assert.ok(system.length > 500, `system prompt is only ${system.length} chars`);
  assert.ok(user.includes(job.company), 'the user prompt must name the employer');
  assert.ok(user.includes('A line from the CV.'), 'and carry the lines being edited');
  assert.ok(system.includes('Azure'), 'and the whitelist the user is held to');
});

test('the requirements no longer promise more than the folder holds', () => {
  const doc = readFileSync(p('docs', 'requirements.html'), 'utf8');
  const a8 = doc.slice(doc.indexOf('>A8<'), doc.indexOf('>A8<') + 400);
  assert.match(a8, /sent/i, 'A8 still claims the prompt is kept');
  // And the claim is now backed by a file, not by prose.
  assert.ok(APPLY.includes("'prompts.json'"), 'so prompts.json must exist to back it');
});
