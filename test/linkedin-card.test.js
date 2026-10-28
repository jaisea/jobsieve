/**
 * A LinkedIn alert anchor wraps the whole job CARD, not just the title.
 *
 * 64 postings recorded their company as "LinkedIn" — the sender — and 60 kept a
 * literal "&middot;" in their title. Two of them had been applied to.
 *
 * The anchor is a nested table, and stripHtml() turns its rows into lines:
 *
 *     Staff Site Reliability Engineer (d/f/m)
 *     Personio · Berlin (Remote)
 *     Easy Apply
 *
 * The parser did `label.replace(/\s+/g, ' ')`, which threw that structure away
 * and jammed everything into the title. The company and location were then meant
 * to come from a lookup in the plain-text part — but that searched for a title
 * containing "&middot;" inside text containing "·", so it never matched and the
 * company fell back to the sender's name.
 *
 * Two faults, one symptom: an entity that was never decoded, and a structure
 * that was collapsed before it could be read.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { p, stripHtml } from '../src/util.js';

const SRC = readFileSync(p('src', 'sources', 'mailalerts.js'), 'utf8');

/* ------------------------------------------------------------- entities */

test('the entities that actually appear are decoded', () => {
  // stripHtml handled five named entities and `&middot;` was not one of them.
  // It is the character LinkedIn separates company from location with, so
  // leaving it encoded made the separator invisible.
  assert.equal(stripHtml('Personio &middot; Berlin'), 'Personio · Berlin');

  // The neighbours, so the next one does not cost another 64 records.
  assert.equal(stripHtml('A &ndash; B'), 'A – B');
  assert.equal(stripHtml('A &mdash; B'), 'A — B');
  assert.equal(stripHtml('it&rsquo;s'), 'it’s');
  assert.equal(stripHtml('&euro;85.000'), '€85.000');
  assert.equal(stripHtml('&bull; one'), '• one');

  // Hex numeric, which was also unhandled — only decimal was.
  assert.equal(stripHtml('&#x2019;'), '’');
  assert.equal(stripHtml('&#8217;'), '’');
});

test('an unknown entity does not leak its markup', () => {
  // Better an empty string than "&zzz;" reaching a title or a fingerprint.
  assert.ok(!/&\w+;/.test(stripHtml('A &middot; B &ndash; C')));
});

/* ------------------------------------------------------- the card layout */

test('the anchor is read line by line, not collapsed', () => {
  assert.match(SRC, /const lines = label\.split\('\\n'\)/,
    'the card structure must survive long enough to be read');
  assert.ok(!/const title = label\.replace\(\/\\s\+\/g, ' '\)/.test(SRC),
    'collapsing the whole label is what jammed company and location into the title');
});

test('company and location are only taken when the separator is there', () => {
  // Without the middot the two halves cannot be told apart, and a wrong company
  // is worse than none — the fingerprint is built from it, so a guess would
  // give the posting a false identity.
  const walk = SRC.slice(SRC.indexOf('const lines = label.split'), SRC.indexOf('jobs.push(job)'));
  assert.match(walk, /lines\.slice\(1\)\.find\(\(l\) => l\.includes\('·'\)\)/);
  assert.match(walk, /if \(meta\) \{/, 'and nothing is set when it is absent');
});

test('card furniture is not mistaken for a field', () => {
  // "Easy Apply" sits on its own line inside the same anchor and reached the
  // report as part of a title.
  const noise = SRC.match(/const CARD_NOISE = (\/.*\/i);/);
  assert.ok(noise, 'there must be a noise list');
  const re = new Function('return ' + noise[1])();

  for (const s of ['Easy Apply', 'Promoted', 'Actively recruiting', 'Be an early applicant',
    'Sofort bewerben', 'Neu', 'Viewed']) {
    assert.ok(re.test(s), `${s} should be dropped`);
  }
  // And nothing that could be a real title or company.
  for (const s of ['Senior DevOps Engineer', 'New Relic', 'Applied Materials', 'Newstore']) {
    assert.ok(!re.test(s), `${s} must NOT be dropped`);
  }
});

test('the whole card parses the way the real emails do', () => {
  // Reproduced from live mail: the anchor's inner HTML, through stripHtml, is
  // three lines. This is the shape the fix is built on.
  const card = 'Cloud Architect<br>SoftServe &middot; Germany (Remote)<br>Easy Apply';
  const CARD_NOISE = new Function('return ' + SRC.match(/const CARD_NOISE = (\/.*\/i);/)[1])();

  const lines = stripHtml(card).split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .filter((l) => !CARD_NOISE.test(l));

  assert.deepEqual(lines, ['Cloud Architect', 'SoftServe · Germany (Remote)']);

  const [company, ...rest] = lines[1].split('·').map((x) => x.trim());
  assert.equal(lines[0], 'Cloud Architect');
  assert.equal(company, 'SoftServe');
  assert.equal(rest.join(' · '), 'Germany (Remote)');
});

test('a single-line anchor is unchanged', () => {
  // The digest template puts only the title in the anchor and the company in the
  // plain-text part. That path already worked and must keep working.
  const CARD_NOISE = new Function('return ' + SRC.match(/const CARD_NOISE = (\/.*\/i);/)[1])();
  const lines = stripHtml('Azure Infrastructure Customer Engineer').split('\n')
    .map((l) => l.trim()).filter(Boolean).filter((l) => !CARD_NOISE.test(l));

  assert.deepEqual(lines, ['Azure Infrastructure Customer Engineer']);
  assert.equal(lines.slice(1).find((l) => l.includes('·')), undefined,
    'no meta line, so the plain-text lookup still supplies company and location');
});
