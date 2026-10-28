/**
 * Rule-layer regression tests.  Run with:  npm test
 *
 * The rules layer is the half of the pipeline that must be foolproof — the LLM
 * layer only ever sees what these rules declare *uncertain*. A silent rule bug
 * therefore never reaches adjudication: it just deletes good jobs. Every bug
 * found in the rules gets a case here.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { hasPhrase, findPhrase, canonicalTitle, slug } from '../src/util.js';
import { detectGermanRequirement, gateGerman } from '../src/language.js';
import { detectProgrammingRequirement, isDeveloperTitle } from '../src/requirements.js';
import { resolveLocation, detectRemoteScope } from '../src/geo.js';
import { CHECKS } from '../src/filter.js';

/* ---------------------------------------------------------------- matching */

test('hasPhrase matches whole words only', () => {
  // The bug this file exists for: substring matching dropped good jobs.
  assert.equal(hasPhrase('Senior International Platform Engineer', 'intern'), false);
  assert.equal(hasPhrase('Internal Tools Platform Engineer', 'intern'), false);
  assert.equal(hasPhrase('Salesforce Platform Engineer', 'sales'), false);
  assert.equal(hasPhrase('Javascript Engineer', 'java'), false);
  assert.equal(hasPhrase('Gamechanger Platform Engineer', 'game'), false);

  // ...while still catching the real thing.
  assert.equal(hasPhrase('Summer Intern - Cloud', 'intern'), true);
  assert.equal(hasPhrase('Sales Engineer', 'sales'), true);
  assert.equal(hasPhrase('Java Backend Engineer', 'java'), true);
  assert.equal(hasPhrase('Game Developer', 'game'), true);
});

test('hasPhrase handles multi-word and punctuated phrases', () => {
  assert.equal(hasPhrase('Working Student DevOps', 'working student'), true);
  assert.equal(hasPhrase('Pre-Sales Solutions Engineer', 'pre-sales'), true);
  assert.equal(hasPhrase('Cloud Engineer', 'working student'), false);
});

test('findPhrase returns the matching term', () => {
  assert.equal(findPhrase('Senior Sales Engineer', ['intern', 'sales']), 'sales');
  assert.equal(findPhrase('Platform Engineer', ['intern', 'sales']), undefined);
});

/* ------------------------------------------------------------------ titles */

test('canonicalTitle strips gender tags, req ids and seniority', () => {
  assert.equal(canonicalTitle('Senior DevOps Engineer (m/w/d) - Remote | Req #4821'), 'devops engineer');
  assert.equal(canonicalTitle('DevOps Engineer m/w/d'), 'devops engineer');
});

test('canonicalTitle folds developer/engineer synonyms', () => {
  assert.equal(canonicalTitle('Kubernetes Developer'), 'kubernetes engineer');
  assert.equal(canonicalTitle('Cloud Ingenieur'), 'cloud engineer');
});

test('generic seniority titles do not collapse to a bare role word', () => {
  // "staff engineer" -> "engineer" once matched every "...Engineer" title at
  // full marks. The target list must not contain such entries.
  assert.equal(canonicalTitle('staff engineer'), 'engineer');
});

test('isDeveloperTitle exempts target infrastructure roles', () => {
  assert.equal(isDeveloperTitle('Platform Engineer'), false);
  assert.equal(isDeveloperTitle('Cloud Architect'), false);
  assert.equal(isDeveloperTitle('Site Reliability Engineer'), false);

  assert.equal(isDeveloperTitle('Software Engineer - Infrastructure'), true);
  assert.equal(isDeveloperTitle('Senior Backend Engineer'), true);
});

/* ----------------------------------------------------------------- German */

test('German requirement grades into four tiers', () => {
  assert.equal(detectGermanRequirement('Verhandlungssichere Deutschkenntnisse', 'en').level, 'required');
  assert.equal(detectGermanRequirement('Gute Deutschkenntnisse erwuenscht', 'en').level, 'conversational');
  assert.equal(detectGermanRequirement('German is a plus', 'en').level, 'basic');
  assert.equal(detectGermanRequirement('We work in English across the team', 'en').level, 'none');
});

test('A2 clears basic German but not B2', () => {
  assert.equal(gateGerman('none', 'A2'), 'pass');
  assert.equal(gateGerman('basic', 'A2'), 'pass');
  assert.equal(gateGerman('conversational', 'A2'), 'hide');
  assert.equal(gateGerman('required', 'A2'), 'hide');
});

test('raising germanLevel to B1 keeps B2 as a stretch, B2 promotes it', () => {
  assert.equal(gateGerman('conversational', 'B1'), 'hide');
  assert.equal(gateGerman('conversational', 'B2'), 'pass');
});

/* ------------------------------------------------------------- programming */

test('programming requirement separates must-have from nice-to-have', () => {
  assert.equal(
    detectProgrammingRequirement('5+ years of experience in backend software engineering (Java)').level,
    'required');
  assert.equal(
    detectProgrammingRequirement('Python, Go, or similar to improve workflows is a plus').level,
    'niceToHave');
});

test('bash and powershell never count as a programming requirement', () => {
  const r = detectProgrammingRequirement('Strong shell scripting skills in Bash and PowerShell required');
  assert.notEqual(r.level, 'required');
});

test('symbol languages survive slugging', () => {
  // slug('c#') collapses to "c", which once matched 50 of 51 postings.
  const r = detectProgrammingRequirement('Deep expertise in C# and .NET required');
  assert.equal(r.level, 'required');
  assert.ok(['C#', '.NET'].includes(r.language), `unexpected language: ${r.language}`);
});

test('ambiguous language names need programming context', () => {
  assert.equal(detectProgrammingRequirement('You must be ready to go to production daily').level, 'none');
  assert.equal(detectProgrammingRequirement('Strong Go programming experience required').level, 'required');
});

/* --------------------------------------------------------------- location */

const HOME = { lat: 48.137, lon: 11.575, radiusKm: 70 };

test('local cities resolve inside the radius, distant ones outside', () => {
  assert.ok(resolveLocation('München', HOME).distanceKm <= 5);
  assert.ok(resolveLocation('Rosenheim, Germany', HOME).distanceKm <= 70);
  assert.ok(resolveLocation('Berlin, Germany', HOME).distanceKm > 70);
});

test('Basel resolves as Switzerland', () => {
  assert.equal(resolveLocation('Basel', HOME).country, 'CH');
});

test('remote scope detects explicit restrictions', () => {
  assert.equal(detectRemoteScope('This role is US only'), 'US-only');
  assert.equal(detectRemoteScope('Remote within Germany'), 'DE');
  assert.equal(detectRemoteScope('Anywhere in Europe'), 'EU');
});

test('non-European locations resolve to their country', () => {
  assert.equal(resolveLocation('Bangalore, India', HOME).country, 'IN');
  assert.equal(resolveLocation('United States', HOME).country, 'US');
});

/* ---------------- German compound requirements (the f2e9cb5e miss) -------- */

test('hyphenated compounds are graded, not missed', () => {
  // "gute Deutsch- und Englischkenntnisse" shares one noun across two
  // languages and is how German ads usually phrase it. Matching only the
  // joined "Deutschkenntnisse" missed these, so they fell through to the weak
  // "posting is written in German" inference and were graded by guesswork.
  assert.equal(detectGermanRequirement('Du verfügst über gute Deutsch- und Englischkenntnisse', 'de').level, 'conversational');
  assert.equal(detectGermanRequirement('Gute Englisch- und Deutschkenntnisse', 'de').level, 'conversational');
  assert.equal(detectGermanRequirement('Sehr gute Deutsch- und Englischkenntnisse', 'de').level, 'required');
  assert.equal(detectGermanRequirement('Verhandlungssichere Deutsch- und Englischkenntnisse', 'de').level, 'required');
});

test('a quoted requirement beats the language-guess fallback', () => {
  // The fallback grades a German-language posting as `required`. A posting that
  // actually states B2 must be graded B2 — that is the difference between a
  // hard drop and a Stretch-band card.
  const r = detectGermanRequirement(
    'Wir suchen einen Kollegen. Du verfügst über gute Deutsch- und Englischkenntnisse und arbeitest gerne im Team.',
    'de'
  );
  assert.equal(r.level, 'conversational');
  assert.notEqual(r.evidence, 'posting written in German, no English signal');
});

test('a stated B2 requirement is a plain drop at A2 (stretchB2 off)', () => {
  assert.equal(gateGerman('conversational', 'A2'), 'hide');
});

test('a closed posting is dropped before anything else is asked', () => {
  // Cheapest possible certainty: the advert itself says the door is shut, so
  // no question about German, location or seniority can matter.
  const closed = CHECKS.find((c) => c.id === 'closed');
  assert.ok(closed, 'there must be a closed check');
  assert.equal(CHECKS.indexOf(closed), 0, 'and it must run first');

  assert.equal(closed.run({ closed: true }).keep, false);
  assert.equal(closed.run({ closed: true }).category, 'closed');
  assert.equal(closed.run({ closed: false }).keep, true);
  assert.equal(closed.run({}).keep, true, 'a job with no flag is not assumed closed');
});

test('canonicalTitle keeps the ROLE when a work-mode tag leads the title (911267cd)', () => {
  // "50% remote - " used to survive the suffix cut and the role was thrown away,
  // so two different Nemensis roles shared one fingerprint and one was swallowed.
  const a = canonicalTitle('50% remote - Azure DevOps Engineer (m/w/d)');
  const b = canonicalTitle('50% remote - Cloud Platform Engineer (Automation) (m/w/d)');
  assert.equal(a, 'azure devops engineer');
  assert.equal(b, 'cloud platform engineer automation');
  assert.notEqual(a, b);
  assert.equal(canonicalTitle('100 % Homeoffice | Site Reliability Engineer'), 'site reliability engineer');
  assert.equal(canonicalTitle('Hybrid: Platform Engineer (w/m/d)'), 'platform engineer');
});

test('canonicalTitle never cuts a title down to nothing but a tag or a number', () => {
  assert.equal(canonicalTitle('2026 - Cloud Engineer'), '2026 cloud engineer');
  // The established behaviour is untouched: a trailing qualifier is still noise.
  assert.equal(canonicalTitle('Engineering Manager - Data Platform'), 'engineering manager');
  assert.equal(canonicalTitle('Remote Sales Engineer - Berlin'), 'sales engineer');
});
