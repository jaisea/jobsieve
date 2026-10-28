/**
 * `npm run why` must reach the same verdict the pipeline reached.
 *
 * It replays the gates against the ARCHIVED record rather than the live job, so
 * every signal a gate reads has to be stored. rejects.js says as much where it
 * lists them — "kept so `why` can show what the gates actually saw rather than
 * re-deriving them from a truncated excerpt and disagreeing" — but the list is
 * hand-maintained, and adding a gate that reads a new field is exactly when it
 * gets forgotten.
 *
 * It was. `descriptionComplete` became a signal when an unread far posting
 * turned into a soft drop, and the archive did not keep it: a Senior Cloud
 * DevOps Engineer at Deutsche Börse replayed as a certain drop at 243km while
 * the pipeline had escalated it. Same posting, same rules, two answers.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { p } from '../src/util.js';
import { gate } from '../src/filter.js';
import * as rejects from '../src/rejects.js';

const profile = JSON.parse(readFileSync(p('config', 'examples', 'devops.profile.json'), 'utf8'));

/** A far German posting whose advert never arrived — the case that broke. */
const unreadAndFar = {
  fingerprint: 'a'.repeat(16),
  title: 'Senior Cloud DevOps Engineer (f/m/d)',
  company: 'Some Employer',
  location: 'Frankfurt am Main, Germany',
  city: 'Frankfurt Am Main',
  country: 'DE',
  distanceKm: 243,
  geoResolved: true,
  workMode: 'onsite',
  postedAt: new Date().toISOString(),
  source: 'mailalerts',
  applyUrl: 'https://example.invalid/job/1',
  descriptionText: '',
  descriptionComplete: false,
  language: 'unknown',
  germanRequired: 'unknown',
  programmingRequired: 'none',
};

test('the archive keeps every signal the gates read, so a replay cannot disagree', () => {
  const live = gate(unreadAndFar, profile);
  assert.equal(live.certain, false, 'an unread far posting is a soft drop — it has not been read yet');

  const archived = rejects.record({}, unreadAndFar, {
    reason: live.reason, category: live.category, decidedBy: 'rules',
  });
  const entry = Object.values(archived)[0] || archived[unreadAndFar.fingerprint];

  // What `why` replays: the archived record, with the excerpt back as the text.
  const replay = gate({ ...entry, descriptionText: entry.excerpt || '' }, profile);

  assert.equal(replay.certain, live.certain,
    'the replay must be as certain as the run was');
  assert.equal(replay.keep, live.keep);
  assert.equal(replay.category, live.category);
});

test('and it happened again with closed, which is why this test is generalised', () => {
  // `closed` became a signal the moment liveness turned into a real phase. It
  // is the same failure as descriptionComplete: a gate reads a field, the
  // archive does not keep it, and `npm run why` replays a different verdict
  // than the run reached.
  const shut = {
    ...unreadAndFar,
    descriptionText: 'x'.repeat(900),
    descriptionComplete: true,
    closed: true,
    closedEvidence: 'the posting is no longer there (HTTP 410)',
  };

  const live = gate(shut, profile);
  assert.equal(live.category, 'closed');
  assert.equal(live.certain, true);

  const archived = rejects.record({}, shut, {
    reason: live.reason, category: live.category, decidedBy: 'rules', reasons: live.reasons,
  });
  const entry = Object.values(archived)[0];

  const replay = gate({ ...entry, descriptionText: entry.excerpt || '' }, profile);
  assert.equal(replay.category, 'closed', 'the replay must reach the same gate');
  assert.equal(replay.certain, live.certain);
  assert.equal(replay.reason, live.reason, 'and give the same reason, evidence included');
});

test('every signal a gate reads is one the archive stores', () => {
  // The list in rejects.js is hand-maintained, and adding a gate that reads a
  // new field is exactly when it gets forgotten. This walks the gates' actual
  // source for `job.<field>` reads and checks each one survives a round trip.
  const filterSrc = readFileSync(p('src', 'filter.js'), 'utf8');
  const gatesOnly = filterSrc.slice(filterSrc.indexOf('export const CHECKS'), filterSrc.indexOf('export const PHASES'));
  const read = new Set([...gatesOnly.matchAll(/\bjob\.([a-zA-Z][a-zA-Z0-9_]*)/g)].map((m) => m[1]));

  const job = {
    ...unreadAndFar, descriptionText: 'x'.repeat(900), descriptionComplete: true,
    closed: false, closedEvidence: null, employmentType: 'Vollzeit', salary: null,
    programmingEvidence: null, programmingLanguage: null,
    awsEvidence: null, azureMentioned: false, germanTalkUngraded: false,
  };
  const v = gate(job, profile);
  const entry = Object.values(rejects.record({}, job, {
    reason: v.reason, category: v.category, reasons: v.reasons,
  }))[0];

  // `title`/`company` are identity and always stored; `descriptionText` is
  // deliberately kept only as a capped excerpt.
  const exempt = new Set(['title', 'company', 'descriptionText']);
  const missing = [...read].filter((k) => !exempt.has(k) && !(k in entry));
  assert.deepEqual(missing, [],
    `these gates read fields the archive does not keep, so \`why\` will disagree: ${missing.join(', ')}`);
});

test('a read posting at the same distance is still a certain drop', () => {
  // The soft drop is about the advert being unread, not about the distance —
  // otherwise nothing far ever gets rejected and the location gate stops
  // meaning anything.
  const read = {
    ...unreadAndFar,
    descriptionText: 'Für den Standort Frankfurt am Main suchen wir. '.repeat(30),
    descriptionComplete: true,
  };
  const v = gate(read, profile);
  assert.equal(v.keep, false);
  assert.equal(v.certain, true, 'with the advert in hand, 243km is settled');
});

/**
 * Every field a gate reads must survive into the archive — checked by
 * ENUMERATION, not by remembering.
 *
 * This has now bitten three times, always the same way: a gate gains a signal,
 * signalsOf() is not updated, and `npm run why` replays a different verdict from
 * the run that filed it.
 *
 *   descriptionComplete  the location gate softens on an unread advert
 *   closed               the liveness verdict
 *   germanTalkUngraded   escalate when German is discussed but ungraded
 *
 * Each was found by someone noticing a wrong answer. The existing replay test
 * builds a FRESH entry and compares, so it only catches a field that is wrong,
 * never one that is absent — an absent field reads as null on both sides and
 * agrees perfectly while being wrong together.
 *
 * Reading filter.js for `job.x` is crude and that is the point: it needs no
 * maintenance and it fails the moment a gate reaches for something new.
 */
test('no gate reads a field the archive does not keep', () => {
  const filter = readFileSync(p('src', 'filter.js'), 'utf8');
  const rejectsSrc = readFileSync(p('src', 'rejects.js'), 'utf8');

  const read = new Set([...filter.matchAll(/\bjob\.([a-zA-Z][a-zA-Z0-9_]*)/g)].map((m) => m[1]));

  const signals = rejectsSrc.slice(
    rejectsSrc.indexOf('function signalsOf'), rejectsSrc.indexOf('export function record'));
  const record = rejectsSrc.slice(rejectsSrc.indexOf('export function record'));
  const kept = new Set([
    ...[...signals.matchAll(/^\s{4}([a-zA-Z][a-zA-Z0-9_]*):/gm)].map((m) => m[1]),
    ...[...record.matchAll(/^\s{4}([a-zA-Z][a-zA-Z0-9_]*):/gm)].map((m) => m[1]),
  ]);

  // The one deliberate exception: the full text is stored as a 1,200-character
  // `excerpt`, because keeping every advert would be the whole corpus twice.
  // `npm run why` says so when it replays from a truncated one.
  const byDesign = new Set(['descriptionText']);

  const missing = [...read].filter((k) => !kept.has(k) && !byDesign.has(k)).sort();
  assert.deepEqual(missing, [],
    `these are read by a gate and never archived, so a replay cannot see them: ${missing.join(', ')}`);
});
