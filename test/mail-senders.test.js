/**
 * Two senders that were arriving and being read by nobody — one now parsed,
 * one refused by name.
 *
 * A scan of the mailbox found job mail landing outside the folder the tool
 * reads, and one sender inside it with no parser. Two are worth reading and
 * both are now parsed:
 *
 *   jobleads.com       8 messages / 30 days, five job cards each
 *   match.indeed.com  15 messages / 30 days, one job each
 *
 * JobLeads was then REFUSED: applying is behind a paywall, checked by hand.
 * The parser was written and deleted, so the reason lives on the ignore list
 * instead — see the test at the foot of this file.
 *
 * match.indeed.com is the dangerous one. `match.indeed.com` already matched the
 * GENERIC `/indeed\./i` parser, which extracted **0 jobs** from all three
 * messages tested — its link pattern wants /viewjob, /rc/clk or /pagead while
 * this template links through cts.indeed.com. Labelling those into the folder
 * without a parser would have added fifteen dead messages a month, counted
 * under Indeed and invisible.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { p, readJson } from '../src/util.js';
import { readFileSync } from 'node:fs';
import { normalize } from '../src/normalize.js';
import { __testables } from '../src/sources/mailalerts.js';

const { extractJobs, pickParser } = __testables;
const profile = readJson(p('config', 'examples', 'devops.profile.json'));

/** Shaped from a real digest, tracking query and all. */
const JOBLEADS_TEXT = `Neue Jobs für 25. September

Developer Experience Engineer
- München
- hybrid
- EUR 140.000 - 190.000
- full_time
- Equity
Job ansehen: https://www.jobleads.com/job/ebb5fc599e164ee8e42f6b69f85126dfa?kuuid=000000&utm_source=vdb_is_saved_search&job_rank=1

Account Executive
- München
- Berlin
- München
- in_person
- EUR 90.000 - 145.000
- full_time
Job ansehen: https://www.jobleads.com/job/e25d2634037112c7d23d72dcf994873a6?kuuid=000000&job_rank=2
`;

const INDEED_MATCH_TEXT = `Guten Tag,

aufgrund Ihres Profils könnte diese Stelle als DEVOPS ENGINEER (M/W/D) für Sie passend sein.

DEVOPS ENGINEER (M/W/D)
42DigitalSolutions GmbH
Home Office
Anstellungsart: Festanstellung
Arbeitsort: Hybrides Arbeiten

Job anzeigen: https://cts.indeed.com/v3/H4sIAAAAAAAA_42RTY-bMBiE_wtScyobDARIJFQl7Cbp8t/maW
`;

const run = (from, text) => extractJobs(pickParser(from), { html: '', text, subject: '', date: new Date('2026-09-25') });

test('match.indeed.com must be matched BEFORE the generic Indeed rule', () => {
  // PARSERS is searched with .find(), so order is the whole fix. The generic
  // rule claims the sender and then reads nothing.
  const picked = pickParser('alerts@match.indeed.com');
  assert.equal(picked.id, 'indeed-match', 'the specific parser must win');
  assert.equal(pickParser('alert@jobalert.indeed.com').id, 'indeed', 'and the digest keeps the generic one');
});

test('an Indeed recommendation yields its title, company and location', () => {
  const [j] = run('alerts@match.indeed.com', INDEED_MATCH_TEXT);
  assert.ok(j, 'the generic parser returned 0 of these on three real messages');
  assert.equal(j.title, 'DEVOPS ENGINEER (M/W/D)');
  assert.equal(j.company, '42DigitalSolutions GmbH');
  assert.equal(j.location, 'Home Office');
  assert.match(j.applyUrl, /^https:\/\/cts\.indeed\.com\//);
});

test('a labelled line is skipped, never filed as a city', () => {
  // "Arbeitsort: Hybrides Arbeiten" is a work mode. Filing it as a location is
  // exactly the mistake the eFinancialCareers block parser was rewritten to
  // stop, where "Festanstellung" and "Home-Office" became cities.
  const [j] = run('alerts@match.indeed.com', INDEED_MATCH_TEXT);
  assert.ok(!/Arbeitsort|Anstellungsart|Hybrides/.test(j.location));
  assert.ok(!/Arbeitsort|Anstellungsart/.test(j.company));
});

test('an opaque Indeed tracking link gets NO id, rather than a guessed one', () => {
  // cts.indeed.com/v3/<base64> carries no jk=. The rule already written for
  // sponsored postings applies: a wrong id is worse than none, because
  // reconcile() reads a known id under an unknown fingerprint as the same
  // posting moving, and the next new job would inherit an old one's status.
  const [j] = run('alerts@match.indeed.com', INDEED_MATCH_TEXT);
  assert.equal(j.sourceId, '', 'no id at all');

  // Company is present here, so the ordinary fingerprint still identifies it.
  const n = normalize({ ...j, source: 'mailalerts' }, profile);
  assert.ok(n.fingerprint);
  assert.equal(n.employerUnknown, false);
});

/**
 * JobLeads is refused by name, and the refusal is the deliverable.
 *
 * A parser for it was written, verified against a real digest, and then
 * deleted. The shape is tractable — five cards an email, typed bullets, a
 * stable id in the URL path — so the reason has to be recorded or someone
 * reaches for it again in three months.
 *
 * Applying is behind a paywall, checked by hand on the postings themselves. A
 * listing you cannot act on without paying is not a lead, and putting it in
 * the queue spends review time on something already decided.
 */
test('JobLeads is on the ignore list, not parsed', () => {
  for (const from of ['noreply@jobleads.com', 'alerts@jobs.jobleads.com']) {
    assert.equal(pickParser(from), undefined, 'no parser may claim it');
  }

  const src = readFileSync(p('src', 'sources', 'mailalerts.js'), 'utf8');
  const ignored = src.slice(src.indexOf('const IGNORED = ['), src.indexOf('];', src.indexOf('const IGNORED = [')));
  assert.match(ignored, /jobleads/, 'it must be refused by name, not by silence');
  assert.match(ignored, /paywall/i, 'and the reason has to survive — "we tried" is the useful part');

  // No dead parser left behind.
  assert.ok(!src.includes('extractJobLeads'), 'the deleted parser must not linger');
  assert.ok(!/id: 'jobleads'/.test(src));
});

test('an ignored sender is reported, never silently dropped', () => {
  // The whole point of the list. An unrecognised sender is counted and named
  // so the next genuinely new one does not scroll past unnoticed; an IGNORED
  // one is kept apart so that warning stays rare and therefore worth reading.
  const src = readFileSync(p('src', 'sources', 'mailalerts.js'), 'utf8');
  assert.match(src, /const ignoredReason = /);
  assert.match(src, /no parser for that sender/, 'unknown senders still warn');
});
