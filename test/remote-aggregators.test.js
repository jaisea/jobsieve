/**
 * Himalayas and Jobicy — two remote-jobs boards with free, keyless APIs, read
 * for the long tail of employers whose own boards are not configured here.
 *
 * Fixtures are trimmed real responses (2026-10-01).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { p, readJson } from '../src/util.js';
import { SOURCES, attributions } from '../src/sources/index.js';
import * as himalayas from '../src/sources/himalayas.js';
import * as jobicy from '../src/sources/jobicy.js';

const read = (f) => readFileSync(p('src', 'sources', f), 'utf8');

/* ---------------------------------------------------------------- Himalayas */

const hjob = (over = {}) => ({
  title: 'Senior Site Reliability Engineer', companyName: 'Nebius',
  guid: 'https://himalayas.app/companies/nebius/jobs/senior-sre',
  applicationLink: 'https://himalayas.app/companies/nebius/jobs/senior-sre',
  description: '<p>We run <strong>Kubernetes</strong> at scale.</p>',
  locationRestrictions: ['Germany', 'France'], pubDate: 1789795620,
  employmentType: 'Full Time', categories: ['Site-Reliability-Engineer'],
  ...over,
});

test('an empty restriction list is a worldwide role, a list naming Germany is a Germany role', () => {
  // The part of this API that is easy to read backwards: empty means NO
  // restriction (Canonical, Chess.com), not "unknown".
  assert.equal(himalayas.locationOf([]), 'Worldwide');
  assert.equal(himalayas.locationOf(undefined), 'Worldwide');
  assert.equal(himalayas.locationOf(['France', 'Germany', 'Spain']), 'Germany');
});

test('a list that does not name Germany is passed through for the remote-scope gate to drop', () => {
  assert.equal(himalayas.locationOf(['United States', 'Canada']), 'United States, Canada');
});

test('Himalayas: a posting yields its fields, with the date converted from unix SECONDS', () => {
  const [j] = himalayas.parseJobs({ jobs: [hjob()] });
  assert.equal(j.title, 'Senior Site Reliability Engineer');
  assert.equal(j.company, 'Nebius');
  assert.equal(j.location, 'Germany');
  assert.equal(j.postedAt, new Date(1789795620 * 1000).toISOString());
  assert.equal(j.workMode, 'remote');
  assert.match(j.descriptionText, /Kubernetes at scale/);
  assert.doesNotMatch(j.descriptionText, /<strong>/);
});

test('Himalayas: a response of the wrong shape is null, an empty board is []', () => {
  assert.equal(himalayas.parseJobs({ error: 'x' }), null);
  assert.deepEqual(himalayas.parseJobs({ jobs: [] }), []);
});

test('Himalayas: a posting without a title, link or company is skipped', () => {
  const got = himalayas.parseJobs({ jobs: [hjob({ title: '' }), hjob({ companyName: '' }), hjob({ applicationLink: '', guid: '' }), hjob()] });
  assert.equal(got.length, 1);
});

test('Himalayas pages with page=, because offset= is silently ignored on /search', () => {
  // offset=20 returned the first page again, so every second page would have
  // been a duplicate of the first with nothing to say so.
  const u = new URL(himalayas.searchUrl('devops', 2));
  assert.equal(u.searchParams.get('page'), '2');
  assert.equal(u.searchParams.get('country'), 'Germany');
  assert.equal(u.searchParams.get('offset'), null);
  assert.doesNotMatch(read('himalayas.js'), /offset=\$\{/);
});

/* ------------------------------------------------------------------- Jobicy */

const jjob = (over = {}) => ({
  id: 152146, url: 'https://jobicy.com/jobs/152146-azure-devops-engineer-kd-pharma',
  jobTitle: 'Azure DevOps Engineer | KD Pharma', companyName: 'GT', jobGeo: 'LATAM,  Europe,  USA',
  jobType: ['Contract'], jobDescription: '<p>Support the <b>Azure</b> platform.</p>',
  pubDate: '2026-10-01T03:55:22+00:00', ...over,
});

test('Jobicy: the padded region list is tidied and the id is the source id', () => {
  const [j] = jobicy.parseJobs({ jobs: [jjob()] });
  assert.equal(j.location, 'LATAM, Europe, USA');
  assert.equal(j.sourceId, 'jobicy:152146');
  assert.equal(j.company, 'GT');
  assert.equal(j.employmentType, 'Contract');
  assert.match(j.descriptionText, /Support the Azure platform/);
});

test('Jobicy: a role tagged only "Europe" stays Europe, not promoted to Germany', () => {
  // Europe includes Germany, but promoting it would state a fact the board did
  // not; the scope gate and the model settle it.
  assert.equal(jobicy.locationOf('Europe'), 'Europe');
  assert.equal(jobicy.locationOf(''), 'Remote');
});

test('Jobicy: the applicant is sent to the URL the feed provides', () => {
  // The API notice requires application buttons to go to the original job URL.
  const [j] = jobicy.parseJobs({ jobs: [jjob()] });
  assert.equal(j.applyUrl, 'https://jobicy.com/jobs/152146-azure-devops-engineer-kd-pharma');
});

test('Jobicy: wrong shape is null, and the search is geo=germany with a tag', () => {
  assert.equal(jobicy.parseJobs({}), null);
  const u = new URL(jobicy.searchUrl('site reliability engineer'));
  assert.equal(u.searchParams.get('geo'), 'germany');
  assert.equal(u.searchParams.get('tag'), 'site reliability engineer');
});

/* ------------------------------------------------------------------- shared */

test('both are registered, switchable, and credited in the report footer', () => {
  const cfg = readJson(p('config', 'sources.json'));
  for (const id of ['himalayas', 'jobicy']) {
    assert.ok(SOURCES[id], id);
    assert.equal(cfg[id]?.enabled, true, id);
  }
  // Both ToS require a visible credit; the report renders `attribution`.
  const credits = attributions(new Set(['himalayas', 'jobicy'])).map((a) => a.url);
  assert.deepEqual(credits.sort(), ['https://himalayas.app', 'https://jobicy.com']);
});

test('both go through the shared per-host gap rather than calling fetch bare', () => {
  for (const f of ['himalayas.js', 'jobicy.js']) assert.match(read(f), /await politeWait\(url\)/, f);
});

test('the data is not republished to the boards Himalayas forbids', () => {
  // Recorded beside the code; nothing in this project posts jobs anywhere.
  assert.match(read('himalayas.js'), /LinkedIn, Google Jobs or Jooble/);
});
