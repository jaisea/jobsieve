/**
 * A card title is a whole LINE in the plain-text part. A search term is not.
 *
 * Every LinkedIn alert opens by naming the SEARCH that produced it, inside a
 * sentence:
 *
 *     Your job alert for Cloud Architect in Germany
 *     New jobs match your preferences.
 *
 * and only later lists the cards, each one three lines of its own:
 *
 *     Kubernetes Platform Architect
 *     Broadcom
 *     Germany
 *     16 school alumni
 *     View job: https://www.linkedin.com/comm/jobs/view/4453568342/...
 *     ---------------------------------------------------------
 *
 * The lookup was `plain.indexOf(job.title)`, a SUBSTRING search, so a card
 * titled "Cloud Architect" matched the header thirteen lines above the card it
 * belonged to. It then took the next two lines: company "in Germany", location
 * "New jobs match your preferences." That is 40e10f3a, and 31 of 977 postings
 * across a month of real mail were filed the same way.
 *
 * Reading the title as a whole line separates the two cleanly, because the
 * header always wraps it in a sentence and a card never does.
 *
 * Two smaller faults travelled with it. The plain pass OVERWROTE whatever the
 * anchor walk had already read off the card — costing 51 postings the work-mode
 * suffix in "Germany (Remote)", which is a signal detectWorkMode reads. And it
 * took a fixed 200-character window, so a card missing its company line reached
 * across the separator into the next card and reported a wrong company, which
 * is worse than none: the fingerprint is built from it.
 *
 * Measured over 185 live emails, 1,275 postings: 42 furniture values repaired,
 * 109 other corrections, 0 postings lost a value they already had.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { __testables } from '../src/sources/mailalerts.js';

const { extractJobs, pickParser } = __testables;
const linkedin = pickParser('jobalerts-noreply@linkedin.com');

/** The anchor LinkedIn actually emits: a nested table, one job per row. */
const card = (title, href, meta) =>
  `<a href="${href}">${title}${meta ? `<br>${meta}` : ''}</a>`;

const run = (html, text) => extractJobs(linkedin, { html, text, subject: 'x', date: null });

/* ------------------------------------------------ the header is not a card */

test('the search term in the header is not mistaken for a card', () => {
  // Reproduced from the live message that produced 40e10f3a. The header names
  // "Cloud Architect"; the card by that name sits ten lines below it.
  const text = [
    'Your job alert for Cloud Architect in Germany',
    'New jobs match your preferences.',
    '',
    'Kubernetes Platform Architect',
    'Broadcom',
    'Germany',
    '',
    '16 school alumni',
    'View job: https://www.linkedin.com/comm/jobs/view/4453568342/',
    '',
    '---------------------------------------------------------',
    '',
    'Cloud Architect',
    'SoftServe',
    'Germany',
    'View job: https://www.linkedin.com/comm/jobs/view/4463393536/',
  ].join('\n');

  const html = card('Kubernetes Platform Architect', 'https://www.linkedin.com/comm/jobs/view/4453568342/')
    + card('Cloud Architect', 'https://www.linkedin.com/comm/jobs/view/4463393536/');

  const jobs = run(html, text);
  const architect = jobs.find((j) => j.title === 'Cloud Architect');

  assert.ok(architect, 'the card must still be found');
  assert.equal(architect.company, 'SoftServe', 'the company under the CARD, not under the header');
  assert.equal(architect.location, 'Germany');

  // The exact values the bug produced, named so a regression is unmistakable.
  assert.notEqual(architect.company, 'in Germany');
  assert.notEqual(architect.location, 'New jobs match your preferences.');
});

test('the alert-created mail cannot supply fields either', () => {
  // The other header wording, and the other bad pair it produced:
  // company "in Germany.", location the strapline that follows.
  const text = [
    'Your job alert has been created: Site Reliability Engineer in Germany.',
    'You will receive notifications when new jobs are posted that match your search preferences.',
    '',
    'Site Reliability Engineer',
    'Haystack',
    'Stuttgart Region',
    'View job: https://www.linkedin.com/comm/jobs/view/4400000001/',
  ].join('\n');

  const [job] = run(card('Site Reliability Engineer', 'https://www.linkedin.com/comm/jobs/view/4400000001/'), text);
  assert.equal(job.company, 'Haystack');
  assert.equal(job.location, 'Stuttgart Region');
});

/* ----------------------------------------- the card outranks the plain part */

test('what the card already said is not overwritten', () => {
  // The anchor carries "Company · Location" and read it off the card itself.
  // The plain part is a positional guess, and a guess must not replace a
  // reading. This is what cost 51 postings their "(Remote)" suffix: the card
  // said "Germany (Remote)", the plain part said "Germany", and the guess won.
  const html = card('Senior Infrastructure Engineer', 'https://www.linkedin.com/comm/jobs/view/4400000002/',
    'Jimdo &middot; Germany (Remote)');
  const text = [
    'Senior Infrastructure Engineer',
    'Jimdo',
    'Germany',
    'View job: https://www.linkedin.com/comm/jobs/view/4400000002/',
  ].join('\n');

  const [job] = run(html, text);
  assert.equal(job.company, 'Jimdo');
  assert.equal(job.location, 'Germany (Remote)', 'the richer value from the card survives');
});

/* --------------------------------------------- a card cannot borrow another */

test('a card with no company of its own reports none, not the next one', () => {
  // A wrong company is worse than an absent one — the fingerprint is built
  // from it, so a borrowed name gives the posting a false identity.
  const text = [
    'Lonely Role',
    'View job: https://www.linkedin.com/comm/jobs/view/4400000003/',
    '---------------------------------------------------------',
    'Some Other Role',
    'Definitely Not The Employer',
    'Berlin',
  ].join('\n');

  const [job] = run(card('Lonely Role', 'https://www.linkedin.com/comm/jobs/view/4400000003/'), text);
  assert.notEqual(job.company, 'Definitely Not The Employer');
  assert.equal(job.location, '', 'and nothing is taken from across the separator');
});

test('card furniture is not filed as a company or a city', () => {
  // All four strings observed in live mail.
  const text = [
    'Platform Engineer',
    'Apply with resume & profile',
    'This company is actively hiring',
    '16 school alumni',
    'Easy Apply',
    'View job: https://www.linkedin.com/comm/jobs/view/4400000004/',
  ].join('\n');

  const [job] = run(card('Platform Engineer', 'https://www.linkedin.com/comm/jobs/view/4400000004/'), text);
  for (const junk of ['Apply with resume & profile', 'This company is actively hiring',
    '16 school alumni', 'Easy Apply']) {
    assert.notEqual(job.company, junk);
    assert.notEqual(job.location, junk);
  }
});

test('a real employer whose name starts like furniture is kept', () => {
  // The noise list must not become a substring filter: "Viewsonic" begins with
  // "View", "Applied Materials" with "Apply", "Newstore" with "New".
  for (const employer of ['Viewsonic GmbH', 'Applied Materials', 'Newstore GmbH']) {
    const text = ['DevOps Engineer', employer, 'Munich',
      'View job: https://www.linkedin.com/comm/jobs/view/4400000005/'].join('\n');
    const [job] = run(card('DevOps Engineer', 'https://www.linkedin.com/comm/jobs/view/4400000005/'), text);
    assert.equal(job.company, employer);
    assert.equal(job.location, 'Munich');
  }
});

/* ------------------------------------------------------------- the cursor */

test('two cards with the same title read their own rows, not the first one twice', () => {
  // A digest lists one employer's roles together, and a "jobs similar to"
  // block repeats titles below the primary list. Taking the first occurrence
  // for every job gave several postings one company's details — three real
  // BWI GmbH postings all reported the first one's city.
  const text = [
    'Cloud Engineer',
    'Hyra',
    'Rhineland-Palatinate, Germany',
    'View job: https://www.linkedin.com/comm/jobs/view/4400000006/',
    '---------------------------------------------------------',
    'Cloud Engineer',
    'SINC GmbH',
    'Wiesbaden',
    'View job: https://www.linkedin.com/comm/jobs/view/4400000007/',
  ].join('\n');

  const html = card('Cloud Engineer', 'https://www.linkedin.com/comm/jobs/view/4400000006/')
    + card('Cloud Engineer', 'https://www.linkedin.com/comm/jobs/view/4400000007/');

  const jobs = run(html, text);
  assert.equal(jobs.length, 2);
  assert.deepEqual(jobs.map((j) => j.company), ['Hyra', 'SINC GmbH']);
  assert.deepEqual(jobs.map((j) => j.location), ['Rhineland-Palatinate, Germany', 'Wiesbaden']);
});

test('a company containing a pipe stays whole', () => {
  // The old split included "|", which cut a legitimate name in half and filed
  // the remainder as a city: "DRK-Blutspendedienst Baden-Württemberg" with
  // location "Hessen gemeinnützige GmbH".
  const name = 'DRK-Blutspendedienst Baden-Württemberg | Hessen gemeinnützige GmbH';
  const text = ['DevOps Engineer (m/w/d)', name, 'Mannheim',
    'View job: https://www.linkedin.com/comm/jobs/view/4400000008/'].join('\n');

  const [job] = run(card('DevOps Engineer (m/w/d)', 'https://www.linkedin.com/comm/jobs/view/4400000008/'), text);
  assert.equal(job.company, name);
  assert.equal(job.location, 'Mannheim');
});
