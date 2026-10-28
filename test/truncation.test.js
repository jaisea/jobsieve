/**
 * Truncated descriptions.
 *
 * Adzuna caps every description at exactly 500 characters and job-alert emails
 * carry none at all — together 39 of 54 kept jobs. So "the posting does not
 * mention German" is usually a fact about the API, not about the job.
 *
 * Two real failures motivated these:
 *   887e51b7 — a card claimed German was required; the actual JD never mentions it
 *   09599c21 — a role wanting good German was shown; the requirement sat past
 *              the 500-character cut, so nothing ever saw it
 */
import { test } from 'node:test';
import { readJson, p } from '../src/util.js';
import assert from 'node:assert/strict';

import { detectGermanRequirement, gateGerman, germanGap, MIN_DESCRIPTION_CHARS } from '../src/language.js';
import { classify } from '../src/filter.js';

const profile = {
  location: { city: 'München', country: 'DE', radiusKm: 70 },
  languages: { germanLevel: 'A2', germanTarget: 'B1', stretchB2: false },
  targetTitles: { strong: ['devops engineer'], good: [], exclude: ['junior'] },
  relevance: readJson(p('config', 'examples', 'devops.profile.json')).relevance,
  filters: { excludeRemoteScopes: ['US-only'], minScore: 25, maxAgeDays: 45 },
};

/** A German-language teaser of exactly the length Adzuna returns. */
const teaser = 'Wir sind ein Unternehmen und wir suchen für unser Team eine Person mit '
  + 'Erfahrung in der Cloud. '.repeat(6);

test('a German-language teaser does not become a German requirement', () => {
  // The old behaviour: language === 'de' and no phrase found -> 'required'.
  // On 500 characters that is a guess presented as a finding.
  const r = detectGermanRequirement(teaser.slice(0, 500), 'de', { complete: false });

  assert.equal(r.level, 'unknown');
  assert.match(r.evidence, /truncated/);
});

test('the same text in a full posting still infers a requirement', () => {
  // The inference is sound when we actually have the posting — only the
  // truncated case was unsafe.
  const r = detectGermanRequirement(teaser.repeat(4), 'de', { complete: true });
  assert.equal(r.level, 'required');
});

test('an explicit requirement is still caught inside a teaser', () => {
  // Truncation must not disable detection — only the inference from ABSENCE.
  const r = detectGermanRequirement('Wir suchen: sehr gute Deutschkenntnisse.', 'de', { complete: false });
  assert.equal(r.level, 'required');
  assert.match(r.evidence, /sehr gute/);
});

test('an unknown requirement is never rendered as a level', () => {
  const g = germanGap('unknown', 'description is truncated (500 chars)', 'A2');

  assert.equal(g.cefr, null);
  assert.doesNotMatch(g.text, /A1|A2|B1|B2|C1|C2/, 'no level may be claimed');
  assert.match(g.text, /not checked|truncated/);
});

test('a truncated posting is shown, not hidden', () => {
  // Hiding a job because its source truncates descriptions would punish the
  // job for the API's limit.
  assert.equal(gateGerman('unknown', 'A2'), 'pass');
});

test('...but it escalates instead of passing silently', () => {
  const v = classify({
    title: 'DevOps Engineer', company: 'Acme', location: 'München',
    city: 'München', country: 'DE', distanceKm: 5, geoResolved: true,
    workMode: 'hybrid', postedAt: new Date().toISOString(),
    descriptionText: teaser.slice(0, 500), descriptionComplete: false,
    language: 'de', germanRequired: 'unknown',
    germanEvidence: 'description is truncated (500 chars) — no requirement visible in the part we have',
    programmingRequired: 'no',
  }, profile, {});

  assert.equal(v.decision, 'uncertain', 'the adjudicator must look at this, not the rules');
  assert.ok(v.uncertainties.some((u) => u.kind === 'german'));
});

test('the completeness threshold is above the sources that truncate', () => {
  assert.ok(MIN_DESCRIPTION_CHARS > 500, 'Adzuna cuts at exactly 500');
});

test('a truncated ENGLISH posting is still taken at face value', () => {
  // Deliberately narrower than "any truncated posting". Escalating every
  // truncated English ad would push most of the run to a model that can see no
  // more of the posting than we can; the prior that an English ad which never
  // mentions German does not require it is strong enough to keep.
  const r = detectGermanRequirement('We run Azure and Kubernetes.', 'en', { complete: false });
  assert.equal(r.level, 'none');
});

test('no description at all is unknown, not "no German requirement"', () => {
  // detectLanguage() answers 'en' for anything under twelve words, empty text
  // included, so a posting with no body fell into the English branch and was
  // graded "no German requirement" — a finding, produced from nothing.
  //
  // 43 of 97 archived jobs had no description, every one from a LinkedIn alert
  // email: those carry no body and LinkedIn serves no structured data. One of
  // them said "Du kommunizierst klar auf Deutsch" on the page itself.
  const r = detectGermanRequirement('Senior DevOps Engineer Remote', 'en', { complete: false, chars: 0 });
  assert.equal(r.level, 'unknown');
  assert.match(r.evidence, /no description available/);
});

test('"chars not supplied" is not "chars is zero"', () => {
  // The first attempt tested `!chars`, which fired on the default of null and
  // broke three existing tests that pass text without a length. normalize()
  // always supplies it, so only an explicit 0 means an empty posting.
  assert.equal(detectGermanRequirement('We run Azure and Kubernetes.', 'en', { complete: false }).level, 'none');
  assert.equal(detectGermanRequirement('We run Azure and Kubernetes.', 'en').level, 'none');
});
