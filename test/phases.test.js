/**
 * The four phases, and what each one is allowed to know.
 *
 * The pipeline used to gate every posting before it had the advert, so the
 * rules spent most of their time judging teasers — Adzuna truncates at 500
 * characters and alert emails carry none. Splitting the walk lets the advert be
 * READ before the rules judge it, which is what allows a gate to be certain
 * where it previously had to guess.
 *
 * The phases are a running order, not a re-ranking. Which gate OWNS a verdict
 * is still array order, and that must not drift — a closed posting has to
 * archive as `closed` rather than as "639km away", and rejects.js clears
 * reviewedAt when a category changes, so a reorder would flood 7,807 reviewed
 * rejections back into the review list.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { p } from '../src/util.js';
import { CHECKS, PHASES, gate, classify, explain } from '../src/filter.js';

const profile = JSON.parse(readFileSync(p('config', 'examples', 'devops.profile.json'), 'utf8'));

test('every gate declares a phase, and the phases account for all of them', () => {
  // A typo in a phase name would silently skip that gate in every phase — the
  // silent-drop failure this project refuses, arriving as a silent KEEP.
  for (const c of CHECKS) {
    assert.ok(PHASES.includes(c.phase), `${c.id} has phase ${JSON.stringify(c.phase)}`);
  }
  const covered = PHASES.flatMap((ph) => CHECKS.filter((c) => c.phase === ph).map((c) => c.id));
  assert.equal(covered.length, CHECKS.length, 'the phases must union to exactly CHECKS');
  assert.deepEqual([...covered].sort(), CHECKS.map((c) => c.id).sort());
});

test('the title phase is exactly the gates that read only a title', () => {
  assert.deepEqual(
    CHECKS.filter((c) => c.phase === 'title').map((c) => c.id),
    ['title-exclude', 'relevance'],
  );
  assert.deepEqual(CHECKS.filter((c) => c.phase === 'liveness').map((c) => c.id), ['closed']);
});

test('the title phase reaches a verdict on a title alone', () => {
  // If a content signal ever creeps into these two gates, phase 1.1 would be
  // judging text it has not fetched yet — the exact bug the split exists to
  // fix, rebuilt one layer up.
  const bare = { title: 'Senior Sales Executive', company: 'X', location: 'Berlin' };
  const v = gate(bare, profile, { phases: ['title'] });
  assert.equal(v.keep, false);
  assert.equal(v.certain, true);
  assert.equal(v.category, 'role');

  const good = { title: 'Senior DevOps Engineer', company: 'X', location: 'Berlin' };
  assert.equal(gate(good, profile, { phases: ['title'] }).keep, true,
    'and a target title survives it with no description at all');
});

test('the title phase does not answer questions it has no evidence for', () => {
  // A posting 600km away in a German-language ad must NOT be dropped here — the
  // advert has not been read yet, and those gates belong to phase 2.1.
  const far = {
    title: 'Senior DevOps Engineer', company: 'X', location: 'Berlin, Germany',
    city: 'Berlin', country: 'DE', distanceKm: 639, geoResolved: true, workMode: 'onsite',
    germanRequired: 'required', germanEvidence: 'verhandlungssicher',
  };
  assert.equal(gate(far, profile, { phases: ['title'] }).keep, true,
    'phase 1.1 must not reach the location or German gates');
  assert.equal(gate(far, profile).keep, false, 'the full walk still drops it');
});

test('CHECKS order still decides which reason owns the verdict', () => {
  // Not the phase order. `closed` is index 0 and stays there.
  assert.equal(CHECKS[0].id, 'closed');
  assert.equal(CHECKS[0].phase, 'liveness', 'a liveness gate sitting first in the array is deliberate');

  const shutAndFar = {
    title: 'Senior DevOps Engineer', company: 'X', location: 'Berlin',
    city: 'Berlin', country: 'DE', distanceKm: 639, geoResolved: true, workMode: 'onsite',
    descriptionComplete: true,
    closed: true, closedEvidence: 'the posting is no longer there (HTTP 410)',
  };
  const v = gate(shutAndFar, profile);
  assert.equal(v.category, 'closed', 'closed owns it, not location');
  assert.match(v.reason, /HTTP 410/, 'and reports the evidence it was given');
  assert.ok(v.reasons.length >= 2, 'while still recording that it was also out of reach');
});

/* ------------------------------------------------- every reason, not the first */

test('gate reports every failing gate, not only the one that decided', () => {
  // `soft = soft || v` used to keep the first soft drop and throw the rest
  // away, so a posting dropped on its title never revealed it was ALSO out of
  // reach. That is the difference between "this rule is pulling its weight" and
  // "this rule got there first".
  const bad = {
    title: 'Senior Frontend Engineer', company: 'X', location: 'Austin, Texas',
    city: 'Austin', country: 'US', distanceKm: 8000, geoResolved: true, workMode: 'onsite',
    descriptionComplete: true, germanRequired: 'none',
  };
  const v = gate(bad, profile);
  const ids = v.reasons.map((r) => r.id);
  assert.ok(ids.includes('relevance'), 'off-track title');
  assert.ok(ids.includes('location'), 'and 8000km away');
  assert.ok(ids.length >= 2, `expected several reasons, got ${JSON.stringify(ids)}`);
  for (const r of v.reasons) {
    assert.ok(r.reason && r.category && r.phase, 'each reason names itself fully');
  }
});

test('a certain drop still owns the verdict over an earlier soft one', () => {
  // The regression barrier for removing the short-circuit. A job softly
  // off-target AND certainly out of reach must be settled by the rules, not
  // escalated to the model — 58 postings were escalated that way.
  const nearMissAndFar = {
    title: 'Cloud Operations Specialist', company: 'X', location: 'London, United Kingdom',
    city: 'London', country: 'GB', distanceKm: 900, geoResolved: true, workMode: 'onsite',
    descriptionComplete: true, germanRequired: 'none',
  };
  const v = gate(nearMissAndFar, profile);
  assert.equal(v.keep, false);
  assert.equal(v.certain, true, 'settled by the rules, not a question for the model');
  assert.equal(v.category, 'location');

  const x = explain(nearMissAndFar, profile);
  assert.equal(x.stoppedAt, 'location',
    'and `why` must name the gate that actually decided, not the first that flinched');
});

test('an uncertainty elsewhere cannot rescue a hard failure', () => {
  // Stated as a test because it is the property the phase split is built on.
  const hardFail = {
    title: 'Senior DevOps Engineer', company: 'X', location: 'Austin, Texas',
    city: 'Austin', country: 'US', distanceKm: 8000, geoResolved: true, workMode: 'onsite',
    descriptionComplete: true,
    germanRequired: 'unknown',      // an open question on another dimension
    programmingRequired: 'none',
  };
  assert.equal(classify(hardFail, profile).decision, 'drop',
    'the open German question must not turn a certain location drop into an escalation');
});

test('classify passes the full reason list through to the archive', () => {
  const bad = {
    title: 'Senior Frontend Engineer', company: 'X', location: 'Austin, Texas',
    city: 'Austin', country: 'US', distanceKm: 8000, geoResolved: true, workMode: 'onsite',
    descriptionComplete: true, germanRequired: 'none',
  };
  const v = classify(bad, profile);
  assert.ok(Array.isArray(v.reasons) && v.reasons.length >= 2,
    'rejects.record() stores these; without them the archive keeps one reason where several applied');
});

test('an adjudicated rejection still archives the rules\' own findings', () => {
  // A posting the model never answers falls back to the rules' reason — and a
  // posting it DOES answer is still worth knowing the rules' full view of.
  // Without this the whole uncertain path archives one reason each and the
  // review rows lose their "also failed" line, which is exactly the population
  // where a second opinion is most useful.
  const src = readFileSync(p('src', 'index.js'), 'utf8');
  assert.match(src, /fallback: \{ keep: !verdict\.reason,[^}]*reasons: verdict\.reasons \}/,
    'the uncertain item must carry the rules reasons');
  assert.match(src, /item\.fallback\.reasons\);/,
    'and noteDrop must be handed them when the verdict comes back');
});
