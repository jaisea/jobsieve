/**
 * Three-way classification tests.
 *
 * The contract this file defends: the rules layer may only decide `keep` or
 * `drop` when it is genuinely certain. Anything resting on a heuristic — an
 * inferred German requirement, an AWS inference, an unresolved town — must escalate to `uncertain` instead, so a
 * rules bug costs an adjudication rather than a lost opportunity.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { classify, isTitleNearMiss } from '../src/filter.js';
import { normalize } from '../src/normalize.js';
import { readJson, p } from '../src/util.js';

// The committed template, not the personal profile — profile.json is gitignored,
// so reading it here would make `npm test` fail on a fresh clone. The example
// carries the same gates and weights, which is what these tests exercise.
const profile = readJson(p('config', 'examples', 'devops.profile.json'));

/** Build a normalized job from the few fields a test cares about. */
const job = (over = {}) => normalize({
  source: 'test',
  sourceId: 't1',
  title: 'DevOps Engineer',
  company: 'Acme GmbH',
  location: 'München, Germany',
  descriptionText: 'We run Azure and Kubernetes. Terraform and ArgoCD in use.',
  applyUrl: 'https://example.com/job',
  postedAt: new Date().toISOString(),
  ...over,
}, profile);

const decide = (over) => classify(job(over), profile, {}).decision;
const kinds = (over) =>
  classify(job(over), profile, {}).uncertainties.map((u) => u.kind);

/* ------------------------------------------------------------ certain drops */

test('excluded title terms are a certain drop', () => {
  assert.equal(decide({ title: 'Werkstudent DevOps' }), 'drop');
  assert.equal(decide({ title: 'Junior Cloud Engineer' }), 'drop');
});

test('an old posting is a certain drop', () => {
  const old = new Date(Date.now() - 90 * 86400000).toISOString();
  assert.equal(decide({ postedAt: old }), 'drop');
});

test('a resolved location beyond the radius is a certain drop', () => {
  assert.equal(decide({ location: 'Berlin, Germany' }), 'drop');
});

test('an explicitly US-only remote role is a certain drop', () => {
  assert.equal(decide({
    location: 'Remote',
    descriptionText: 'Fully remote. This role is US only. Azure and Kubernetes.',
  }), 'drop');
});

test('an unknown town in a far-away country is a certain drop, not a question', () => {
  // The gazetteer need not know every town — the country is enough.
  assert.equal(decide({ location: 'Ann Arbor, United States' }), 'drop');
});

/* ------------------------------------------------------------- certain keep */

test('a clean local match with no flags is a certain keep', () => {
  const v = classify(job(), profile, {});
  assert.equal(v.decision, 'keep');
  assert.deepEqual(v.uncertainties, []);
});

/* --------------------------------------------------------------- escalation */

test('an unresolved town with no country escalates rather than dropping', () => {
  const v = classify(job({ location: 'Musterhausen-Kleindorf' }), profile, {});
  assert.equal(v.decision, 'uncertain');
  assert.ok(v.uncertainties.some((u) => u.kind === 'location'));
});

test('a remote role with no stated scope escalates', () => {
  assert.ok(kinds({
    location: 'Remote',
    descriptionText: 'Fully remote role. Azure, Kubernetes, Terraform.',
  }).includes('remote-scope'));
});

test('a QUOTED B2 requirement is a certain drop — no adjudication spent', () => {
  // Policy: a stated "gute Deutschkenntnisse" is a real requirement above A2.
  // The rules settle it alone; escalating would pay for a foregone conclusion.
  const v = classify(job({
    descriptionText: 'Gute Deutschkenntnisse erwuenscht. Azure and Kubernetes.',
  }), profile, {});
  assert.equal(v.decision, 'drop');
  // The level demanded, not the internal tier — "German conversational" told
  // you nothing about what the posting actually wants.
  assert.equal(v.reason, 'German B2 required');
});

test('an INFERRED German requirement still escalates', () => {
  // A German-language ad with no stated requirement may still be an
  // English-speaking workplace — that is a guess, so the model decides.
  const v = classify(job({
    title: 'Cloud Engineer',
    descriptionText: 'Wir sind ein Unternehmen und wir suchen fuer unser Team einen Kollegen der mit uns die Cloud betreibt und die Systeme mit Azure und Kubernetes verwaltet.',
  }), profile, {});
  assert.equal(v.decision, 'uncertain');
  assert.ok(v.uncertainties.some((u) => u.kind === 'german'));
});

test('a German requirement merely inferred from the language escalates', () => {
  const v = classify(job({
    title: 'Cloud Engineer',
    descriptionText: 'Wir sind ein Unternehmen und wir suchen fuer unser Team einen Kollegen der mit uns die Cloud betreibt und die Systeme mit Azure und Kubernetes verwaltet.',
  }), profile, {});
  assert.equal(v.decision, 'uncertain', 'inferred German must not hard-drop');
  assert.ok(v.uncertainties.some((u) => u.kind === 'german'));
});

/*
 * Programming is no longer a gate (removed 2026-10-20): most adverts that ask
 * for Python do not really need it, and the gate was costing postings the
 * user wanted. It is still detected and still scored, but it neither drops a
 * posting nor spends a model call asking about it.
 */
test('a nice-to-have programming mention is not a question for the model', () => {
  assert.ok(!kinds({
    descriptionText: 'Azure and Kubernetes. Python is a plus for automation.',
  }).includes('programming'));
});

test('a developer title is not asked about as a programming question', () => {
  assert.ok(!kinds({ title: 'Software Engineer - Infrastructure' }).includes('programming'));
});

test('an explicit programming requirement no longer drops a posting', () => {
  const v = classify(job({
    title: 'Platform Engineer',
    descriptionText: 'We run Azure and Kubernetes. 5+ years of experience in Python is required.',
  }), profile, {});
  assert.equal(v.decision, 'keep');
  assert.ok(!v.uncertainties.some((u) => u.kind === 'programming'));
});

test('a near-miss title escalates rather than being deleted', () => {
  const v = classify(job({ title: 'Cloud Operations Specialist' }), profile, {});
  assert.equal(v.decision, 'uncertain');
  assert.ok(v.uncertainties.some((u) => u.kind === 'title'));
});

/* ------------------------------------------------------- near-miss matching */

test('near-miss needs a field noun AND an adjacent role noun', () => {
  assert.equal(isTitleNearMiss('Cloud Operations Specialist', profile), true);
  assert.equal(isTitleNearMiss('IT Infrastructure Manager', profile), true);
  assert.equal(isTitleNearMiss('Platform Engineer', profile), true);

  // Generic business titles must not escalate — these cost real money.
  assert.equal(isTitleNearMiss('People Operations Specialist', profile), false);
  assert.equal(isTitleNearMiss('Casual Rugby Systems Operator', profile), false);
  assert.equal(isTitleNearMiss('Director, OTC Operations', profile), false);
});

test('the field vocabulary comes from the profile, so another field works the same way', () => {
  // Nothing in the code knows what an infrastructure title is. A full-stack
  // profile gets its own near misses and its own off-track drops.
  const fullstack = readJson(p('config', 'profile.example.json'));
  assert.equal(isTitleNearMiss('React Specialist', fullstack), true);
  assert.equal(isTitleNearMiss('Cloud Operations Specialist', fullstack), false);
  assert.equal(isTitleNearMiss('Cloud Operations Specialist', {}), false, 'no vocabulary, no near misses');

  const base = { location: 'München', city: 'München', country: 'DE', distanceKm: 0, geoResolved: true,
    workMode: 'hybrid', descriptionComplete: true, germanRequired: 'none', postedAt: new Date().toISOString() };
  assert.equal(classify({ ...base, title: 'Senior Full-Stack Developer (m/w/d)' }, fullstack, {}).decision, 'keep');
  assert.equal(classify({ ...base, title: 'Senior DevOps Engineer (m/w/d)' }, fullstack, {}).decision, 'drop');
});
