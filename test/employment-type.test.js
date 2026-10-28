/**
 * The field every source reports and nothing read.
 *
 * A DevOps Engineer at Hays sat in the queue as a normal role.
 * It arrived tagged `employmentType: "Teilzeit"` — part-time, stated outright.
 * The field was captured at normalize, stored in the archive and rendered as a
 * badge on the card, and no gate ever looked at it.
 *
 * `filters.excludeEmploymentTypes` was already in profile.json, empty, read by
 * nothing — the same dead-config shape as `workRights.switzerland`: a key that
 * looks like a setting, so editing it feels like it should do something.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { p, readJson } from '../src/util.js';
import { classify, employmentKinds, CHECKS, REJECT_CATEGORIES } from '../src/filter.js';

const profile = readJson(p('config', 'examples', 'devops.profile.json'));

const job = (over) => ({
  title: 'DevOps Engineer (m/w/d)', company: 'Hays', location: 'München',
  applyUrl: 'https://example.invalid', workMode: 'remote', remoteScope: 'DE',
  distanceKm: 0, geoResolved: true, postedAt: new Date().toISOString(),
  language: 'en', germanRequired: 'none', programmingRequired: 'none', score: 70,
  ...over,
});

test('a part-time role is dropped, and says so', () => {
  const v = classify(job({ employmentType: 'Teilzeit' }), profile);
  assert.equal(v.decision, 'drop');
  assert.equal(v.category, 'employment');
  assert.match(v.reason, /part-time/);
  assert.match(v.reason, /Teilzeit/, 'and quotes what the source actually said');
});

test('"Full or part time" offers both and is kept', () => {
  // The trap. It appears in ten variants across the archive — "Experienced,
  // Permanent, Full or part time" — and testing only for "part time" discards
  // every one of them.
  for (const t of ['Experienced, Permanent, Full or part time', 'Vollzeit und Teilzeit',
    'Entry, Working student, Full or part time']) {
    // Not deepEqual([]): the last one really is a working-student role, and
    // saying so is correct. The claim here is only that offering both does not
    // make it part-time.
    assert.ok(!employmentKinds(t).includes('part-time'), t);
  }
});

test('every spelling the sources use maps to one kind', () => {
  // Across the archive: Vollzeit, Full Time, Full-time, FullTime, full_time,
  // Teilzeit, Part time, parttime, "Mid, parttime permanent".
  for (const t of ['Teilzeit', 'Part time', 'Part-time', 'PartTime', 'part_time',
    'Mid, parttime permanent', 'Contract: Part-Time', 'Mid, parttime minijob']) {
    assert.ok(employmentKinds(t).includes('part-time'), t);
  }
  for (const t of ['Vollzeit', 'Full Time', 'Full-time', 'FullTime', 'full_time', 'Full time']) {
    assert.ok(!employmentKinds(t).includes('part-time'), t);
  }
});

test('a missing employment type is not a reason to drop anything', () => {
  // Most sources send nothing. Treating absent as part-time would empty the
  // report.
  assert.deepEqual(employmentKinds(null), []);
  assert.deepEqual(employmentKinds(''), []);
  assert.equal(classify(job({ employmentType: null }), profile).decision !== 'drop', true);
});

test('the gate is off when the config is empty', () => {
  // A personal profile may enable it, but an empty list must change nothing for
  // anyone who has not asked — this is a new gate on an old field, and every
  // archived posting has that field.
  const noFilter = { ...profile, filters: { ...profile.filters, excludeEmploymentTypes: [] } };
  assert.notEqual(classify(job({ employmentType: 'Teilzeit' }), noFilter).category, 'employment');
});

test('it runs early, because it is as cheap and as certain as the title check', () => {
  const ids = CHECKS.map((c) => c.id);
  assert.ok(ids.indexOf('employment-type') < ids.indexOf('location'), 'before location');
  assert.ok(ids.indexOf('employment-type') < ids.indexOf('german'), 'before German');
  assert.ok(ids.indexOf('employment-type') > ids.indexOf('closed'), 'after the closed check');
});

test('it has its own reject category rather than hiding under role', () => {
  // Filed under "role" it would sit among four thousand obviously irrelevant
  // titles and never be reviewed.
  assert.equal(REJECT_CATEGORIES.employment, 'Wrong employment type');
  const rep = readFileSync(p('src', 'report.js'), 'utf8');
  assert.match(rep, /'employment'/, 'and a place in the review order');
});

test('the config names a concept, not a spelling', () => {
  // "part-time" rather than "Teilzeit", or the setting would have to list every
  // way each source writes it.
  assert.deepEqual(profile.filters.excludeEmploymentTypes, ['part-time']);
});
