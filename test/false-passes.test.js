/**
 * Four ways a posting reached the report that should never have.
 *
 * All found by reading the output, not by any check here — which is the
 * point of writing them down. The two worst-scoring failures were the two
 * HIGHEST-scoring jobs in the report: 95 and 93.
 *
 * The shared shape is worth naming: each was a gate that had the right rule but
 * was fed the wrong input. Nothing was missing; something upstream lied.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { detectRemoteScope, detectWorkMode } from '../src/geo.js';
import { detectGermanRequirement } from '../src/language.js';
import { normalize } from '../src/normalize.js';
import { classify } from '../src/filter.js';
import { readJson, p } from '../src/util.js';

const profile = readJson(p('config', 'examples', 'devops.profile.json'));

test('a German requirement hidden in a language list is found', () => {
  // "You are fluent in English and German both spoken and written" was graded
  // 'none' because the pattern wanted "fluent" beside "german". Listing English
  // first hid a hard requirement, and the posting scored 93.
  assert.equal(detectGermanRequirement('You are fluent in English and German both spoken and written', 'en').level, 'required');
  assert.equal(detectGermanRequirement('Fluent in German and English', 'en').level, 'required');
  assert.equal(detectGermanRequirement('Fliessend in Deutsch und Englisch', 'en').level, 'required');
});

test('...without flagging English-only postings', () => {
  // The obvious over-correction: any sentence containing "fluent" becoming a
  // German requirement would drop most of the corpus.
  for (const t of ['You are fluent in English', 'Strong communication in English required', 'Fluent English is essential']) {
    assert.equal(detectGermanRequirement(t, 'en').level, 'none', t);
  }
});

test('an eligible-country list without Germany is out of reach', () => {
  // "We are looking for candidates in the UK, Spain and Ireland only" was read
  // as EU — several of those ARE European — and scored 95. What matters is
  // whether Germany is on the list, not whether the list looks European.
  assert.equal(detectRemoteScope('This is a remote position. We are looking for candidates in the UK, Spain and Ireland only.'), 'other-only');
});

test('...but a list that does include Germany is still reachable', () => {
  assert.equal(detectRemoteScope('Remote. We hire candidates in Germany, Austria and Switzerland only.'), 'DE');
  assert.equal(detectRemoteScope('Fully remote within Germany.'), 'DE');
  assert.equal(detectRemoteScope('Remote across Europe.'), 'EU');
});

test('home office offered as a perk is not a remote role', () => {
  // "we also offer you the possibility of home office or temporary work from
  // abroad" made a Hannover posting 'remote', which earned it full location
  // points at 505km. A benefit is not a work mode.
  assert.equal(detectWorkMode('We do not have core working hours and we also offer you the possibility of home office or temporary work from abroad', 'Hannover'), 'hybrid');
  assert.equal(detectWorkMode('Home office is possible up to 2 days per week', 'Munich'), 'hybrid');
});

test('...while a genuinely remote role still reads as remote', () => {
  assert.equal(detectWorkMode('This is a fully remote position', 'Remote'), 'remote');
  assert.equal(detectWorkMode('We are a remote-first company', 'Anywhere'), 'remote');
  assert.equal(detectWorkMode('100% remote within Germany', 'Germany'), 'remote');
});

test('the posting outranks the aggregator that indexed it', () => {
  // The root cause of the 93. JSearch tagged a Hannover job "remote" and
  // `raw.workMode || detect(...)` let the tag win, so the description never got
  // a say. Detection runs first now; the tag is the fallback for silence.
  const tagged = normalize({
    source: 'jsearch', sourceId: '1', title: 'Cloud Engineer', company: 'Acme',
    location: 'Hannover', applyUrl: 'https://x', workMode: 'remote',
    descriptionText: 'A great team. We also offer you the possibility of home office. Azure and Kubernetes.',
  }, profile);
  assert.equal(tagged.workMode, 'hybrid', 'the text says perk, not remote');
  assert.equal(classify(tagged, profile, {}).decision, 'drop', 'Hannover is far outside the radius');

  // When the text says nothing about mode, the tag is still used.
  const silent = normalize({
    source: 'jsearch', sourceId: '2', title: 'Cloud Engineer', company: 'Acme',
    location: 'Somewhere', applyUrl: 'https://x', workMode: 'remote',
    descriptionText: 'We run Azure and Kubernetes and Terraform.',
  }, profile);
  assert.equal(silent.workMode, 'remote', 'no contradicting evidence, so the tag stands');
});

/* ------------------------------------- a certain drop needs a certain reason */

/**
 * Had an eFinancialCareers link been processed? It had —
 * dropped the same morning, "Frankfurt Am Main is 243km away". Reasonable, until
 * you notice the advert had never been read.
 *
 * With no description, normalize falls back to `geo.resolved ? 'onsite' :
 * 'unknown'`. So "onsite" was an ASSUMPTION, and the location gate treated it as
 * a finding. eFinancialCareers and the alert emails carry no description at all,
 * so this is their normal case rather than an edge one.
 *
 * Measured before changing anything: of 20 German postings dropped this way and
 * then actually fetched, FIVE were remote — a Senior DevOps Engineer, a Senior
 * Cloud Engineer, two SREs, and one offering "bis zu 100%". A quarter of the
 * class, and exactly the roles worth having.
 */
test('a far posting whose advert has not been read escalates rather than dropping', () => {
  const profile = readJson(p('config', 'examples', 'devops.profile.json'));
  const far = normalize({
    source: 'efinancialcareers', title: 'Senior Cloud DevOps Engineer (f/m/d)',
    company: 'Deutsche Börse', location: 'Frankfurt am Main, Germany',
    applyUrl: 'https://example.invalid', postedAt: new Date().toISOString(),
    descriptionText: '',
  }, profile);

  assert.ok(far.distanceKm > profile.location.radiusKm, 'the posting is out of range');
  assert.equal(classify(far, profile).decision, 'uncertain');
});

test('but once the advert says onsite, the drop is certain again', () => {
  const profile = readJson(p('config', 'examples', 'devops.profile.json'));
  const read = normalize({
    source: 'efinancialcareers', title: 'Senior Cloud DevOps Engineer (f/m/d)',
    company: 'Deutsche Börse', location: 'Frankfurt am Main, Germany',
    applyUrl: 'https://example.invalid', postedAt: new Date().toISOString(),
    descriptionText: 'Die Tätigkeit erfolgt vor Ort in unserem Büro in Frankfurt. '.repeat(20),
  }, profile);

  const v = classify(read, profile);
  assert.equal(v.decision, 'drop');
  assert.equal(v.category, 'location');
});

test('a far COUNTRY stays a certain drop, read or not', () => {
  // Reading a US onsite posting does not make it commutable, and escalating
  // every one would spend enrichment on the largest class of all.
  const profile = readJson(p('config', 'examples', 'devops.profile.json'));
  const us = normalize({
    source: 'remotive', title: 'DevOps Engineer', company: 'X',
    location: 'Austin, Texas, United States', applyUrl: 'https://example.invalid',
    postedAt: new Date().toISOString(), descriptionText: '',
  }, profile);
  assert.equal(classify(us, profile).decision, 'drop');
});
