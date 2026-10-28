/**
 * GermanTechJobs.
 *
 * The board is a React shell; the data is `/api/jobsLight` (the whole board in
 * one request) and `/api/jobWithUrl/<slug>` (one advert). Measured 2026-10-01:
 * 1,032 listed, 209 past the title gate, all 209 read with no empty advert.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { p, readJson } from '../src/util.js';
import { normalize } from '../src/normalize.js';
import { SOURCES } from '../src/sources/index.js';
import { __testables, fetchJobs } from '../src/sources/germantechjobs.js';

const { advertOf, toRaw, LIST, DETAIL } = __testables;
const profile = readJson(p('config', 'examples', 'devops.profile.json'));

const LIGHT = {
  _id: '6ab298991e05c4e06b553c8d',
  jobUrl: 'Dly-Senior-Cloud--DevOps-Engineer-mfd',
  name: 'Senior Cloud / DevOps Engineer (m/f/d)',
  company: 'Dæly',
  actualCity: 'Wien',
  cityCategory: 'Munich',
  latitude: 48.2113483,
  longitude: 16.3744072,
  workplace: 'remote',
  jobType: 'Full-Time',
  annualSalaryFrom: 60000,
  annualSalaryTo: 90000,
  activeFrom: '2026-09-23T00:00:00.000+02:00',
  isPaused: false,
};

const DETAIL_RECORD = {
  ...LIGHT,
  description: 'We are building European tech for every household.',
  responsibilitiesTextArea: 'Own our Kubernetes platform end to end.',
  requirementsMustTextArea: '• Fließende Deutschkenntnisse (C1)\n• Terraform in production',
  requirementsNiceTextArea: '• Azure',
  isDisabledOrOutdated: false,
};

test('the requirements are part of the advert, because that is where German is stated', () => {
  // `description` alone is usually the company blurb. The must-haves are a
  // separate field, and they are where "Fließende Deutschkenntnisse" sits —
  // reading only the description would feed the German gate the half least
  // likely to mention it.
  const text = advertOf(DETAIL_RECORD);
  assert.match(text, /European tech/);
  assert.match(text, /Kubernetes platform/);
  assert.match(text, /Fließende Deutschkenntnisse/);
  assert.match(text, /Azure/);
  assert.ok(text.includes('\n'), 'lines survive — germanLines() reads whole lines');
});

test('the city is actualCity, never the board\'s filter bucket', () => {
  // A Vienna employer is filed under "Munich" for the board's city filter.
  const raw = toRaw(DETAIL_RECORD);
  assert.equal(raw.location, 'Wien');
  assert.ok(!/munich/i.test(raw.location));
});

test('the identity is the record id, not the slug built from the title', () => {
  const raw = toRaw(DETAIL_RECORD);
  assert.equal(raw.sourceId, 'germantechjobs:6ab298991e05c4e06b553c8d');
  assert.equal(raw.applyUrl, 'https://germantechjobs.de/jobs/Dly-Senior-Cloud--DevOps-Engineer-mfd');
});

test('the board\'s coordinates give a distance the gazetteer cannot', () => {
  const raw = toRaw(DETAIL_RECORD, profile.location);
  assert.ok(raw.distanceKm > 300 && raw.distanceKm < 450, `München to Vienna, got ${raw.distanceKm}`);
  assert.equal(toRaw(DETAIL_RECORD, null).distanceKm, null, 'no home, no invented distance');
});

test('workplace is a hint, and "office" is not turned into a claim', () => {
  assert.equal(toRaw(DETAIL_RECORD).workMode, 'remote');
  assert.equal(toRaw({ ...DETAIL_RECORD, workplace: 'hybrid' }).workMode, 'hybrid');
  assert.equal(toRaw({ ...DETAIL_RECORD, workplace: 'office' }).workMode, undefined);

  // With a read advert that says onsite, the text wins over the board.
  const onsite = { ...DETAIL_RECORD, description: 'Sie arbeiten an unserem Standort Wien vor Ort. '.repeat(20) };
  assert.notEqual(normalize(toRaw(onsite, profile.location), profile).workMode, 'remote');
});

test('salary, employment type and the board\'s own closed flag are carried', () => {
  const raw = toRaw(DETAIL_RECORD);
  assert.equal(raw.salary, '60000–90000 EUR');
  assert.equal(raw.employmentType, 'Full-Time');
  assert.equal(raw.closed, false);

  const shut = toRaw({ ...DETAIL_RECORD, isDisabledOrOutdated: true });
  assert.equal(shut.closed, true);
  assert.ok(shut.closedEvidence);
});

test('it is registered and enabled', () => {
  assert.ok(SOURCES.germantechjobs);
  assert.equal(readJson(p('config', 'sources.json')).germantechjobs.enabled, true);
});

async function withFetch(handler, fn) {
  const real = globalThis.fetch;
  globalThis.fetch = handler;
  try { return await fn(); } finally { globalThis.fetch = real; }
}

const json = (body, status = 200) => ({
  ok: status < 400, status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
});

test('the title gate runs on the list, and office postings are NOT pre-filtered on distance', async () => {
  // Six of the first 80 adverts the board files as "office" say remote in
  // their own text, 240–500km away. A distance pre-filter that trusted the tag
  // would have dropped every one unread.
  const far = { ...LIGHT, _id: 'b', jobUrl: 'far-office', workplace: 'office', actualCity: 'Hannover' };
  const off = { ...LIGHT, _id: 'c', jobUrl: 'sales', name: 'Sales Manager' };
  const asked = [];
  const out = await withFetch(async (url) => {
    asked.push(String(url));
    if (url === LIST) return json([LIGHT, far, off]);
    if (url === DETAIL('far-office')) return json({ ...far, description: '100% remote, deutschlandweit.' });
    if (url === DETAIL(LIGHT.jobUrl)) return json(DETAIL_RECORD);
    return json('Not Found', 404);
  }, () => fetchJobs({
    titleFilter: (t) => /devops/i.test(t),
    locationFilter: () => false,   // passed by index.js to every source; must be ignored here
    profile,
  }));

  assert.deepEqual(out.jobs.map((j) => j.sourceId).sort(), ['germantechjobs:6ab298991e05c4e06b553c8d', 'germantechjobs:b']);
  assert.ok(!asked.some((u) => u.includes('sales')), 'a title the gate refused costs no request');
  assert.deepEqual(out.errors, []);
  assert.equal(out.calls, null, 'unmetered — the quota ledger must never bill it');
});

test('a transient failure parks the posting; a 404 drops it', async () => {
  const gone = { ...LIGHT, _id: 'g', jobUrl: 'gone' };
  const flaky = { ...LIGHT, _id: 'f', jobUrl: 'flaky' };
  const out = await withFetch(async (url) => {
    if (url === LIST) return json([gone, flaky]);
    if (url === DETAIL('gone')) return json('Not Found', 404);
    throw new Error('socket hang up');
  }, () => fetchJobs({ profile }));

  assert.deepEqual(out.jobs.map((j) => j.sourceId), ['germantechjobs:f']);
  assert.equal(out.jobs[0].descriptionText, '', 'no advert, so it parks rather than being judged');
  assert.equal(out.errors.length, 2);
});
