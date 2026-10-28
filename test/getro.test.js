/**
 * VC portfolio boards.
 *
 * One board covers every company a fund has invested in, which makes this the
 * only source here that reaches small employers nobody would add one at a
 * time. Measured 2026-09-29 across six funds: 9,397 postings, 929 of them
 * remote, 109 unique hits on six infrastructure terms, 18 passing a real title
 * gate, 12 not US/APAC-anchored — for 42 requests.
 *
 * Cost scales with QUERIES, not postings. That is the property worth
 * protecting: Workday costs up to 355 requests a run and apriori up to 162,
 * while six Getro boards holding 9,400 postings cost 42.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { p, readJson } from '../src/util.js';
import { normalize } from '../src/normalize.js';
import { __testables, fetchJobs } from '../src/sources/getro.js';

const { searchBody, headers, toRaw } = __testables;
const profile = readJson(p('config', 'examples', 'devops.profile.json'));

test('the two filter keys are exactly where the API wants them', () => {
  // The failure mode this guards is silent. A wrong key does not error and
  // does not return zero — it returns the FULL unfiltered board, so the source
  // looks like it is working while filtering nothing. Probed live: every one
  // of searchQuery (root and nested), filters.q, filters.search,
  // filters.keyword, filters.remote and filters.workMode was ignored and
  // returned the same 2,274 as an empty body.
  const b = searchBody('DevOps');
  assert.equal(b.query, 'DevOps', 'the search term is `query`, at the ROOT');
  assert.deepEqual(b.filters, { work_mode: ['remote'] }, 'work mode is `filters.work_mode`');

  assert.equal(b.searchQuery, undefined);
  assert.equal(b.filters.q, undefined);
  assert.equal(b.filters.remote, undefined);
  assert.equal(b.filters.workMode, undefined);
});

test('Accept: application/json is not optional', () => {
  // Without it the API answers 406 — a content-negotiation refusal that reads
  // like a malformed request and sent the first probe looking at the body.
  const h = headers('https://hv.getro.com/jobs');
  assert.equal(h.Accept, 'application/json');
  assert.equal(h.Referer, 'https://hv.getro.com/jobs');
  assert.equal(h.Origin, 'https://hv.getro.com', 'origin is the board, not the API host');
});

test('the collection id is a STRING in the page, and the resolver must accept that', () => {
  // `"network":{"id":"617"}` — quoted. A resolver expecting `"id":617` matched
  // nothing and reported every board as unresolved, which is how this was
  // found.
  const src = readFileSync(p('src', 'sources', 'getro.js'), 'utf8');
  const re = src.match(/const m = html\.match\((\/.*?\/)\);/);
  assert.ok(re, 'the resolver must still use a regex over the page');

  const pattern = new Function('return ' + re[1])();
  assert.ok(pattern.test('…,"network":{"id":"617","name":"Earlybird"},…'), 'quoted id');
  assert.ok(pattern.test('…,"network":{"id":617,"name":"x"},…'), 'and a bare one, if they ever change it');
  assert.equal('x"network":{"id":"44081"}'.match(pattern)[1], '44081');
});

test('work mode from the board is a hint, never a conclusion', () => {
  // Same rule as the Arbeitsagentur remote pass: a board's tag means somebody
  // ticked a box in a form. normalize() only honours it while there is no
  // advert, and enrich fetches the advert. The posting outranks the aggregator.
  const raw = toRaw({ title: 'Platform Engineer', url: 'https://boards.greenhouse.io/x/jobs/1', work_mode: 'remote', organization: { name: 'Acme' }, searchable_locations: ['Berlin, Germany'] }, 'Fund');
  assert.equal(raw.workMode, 'remote');

  // With a real advert that says otherwise, the text wins.
  const job = normalize({ ...raw, descriptionText: 'Sie arbeiten an unserem Standort Berlin vor Ort. '.repeat(20) }, profile);
  assert.notEqual(job.workMode, 'remote', 'a read advert overrides the board tag');

  // A board that does not say remote must not have one invented for it.
  assert.equal(toRaw({ url: 'https://x.test/1', work_mode: 'hybrid' }, 'F').workMode, undefined);
});

test('the whole location list is carried, because the tail anchors the country', () => {
  // Taking only the first entry is tidier and measurably worse. Getro widens:
  // ["Remote", "Greece", "Europe"]. normalize() derives remoteScope from the
  // resolved country, and on a remote posting the first entry is often just
  // "Remote", which resolves to nothing.
  const wide = toRaw({ url: 'https://x.test/1', title: 'Platform Engineer', work_mode: 'remote', organization: { name: 'finmid' }, searchable_locations: ['Remote', 'Greece', 'Europe'] }, 'F');
  assert.equal(wide.location, 'Remote, Greece, Europe');

  const full = normalize(wide, profile);
  const firstOnly = normalize({ ...wide, location: 'Remote' }, profile);
  assert.equal(full.country, 'GR');
  assert.equal(full.remoteScope, 'EU');
  assert.equal(firstOnly.remoteScope, null, 'the first entry alone loses the anchor');
});

test('identity is the ATS url, so a job on two funds\' boards is one posting', () => {
  // Point Nine and Cherry both list Berlin companies, and `url` is the
  // canonical ATS posting rather than a Getro redirect — so the same role
  // reached twice dedupes here, and dedupes again downstream against a board
  // already polled through companies.json.
  const a = toRaw({ url: 'https://boards.greenhouse.io/workist/jobs/9', title: 'X', organization: { name: 'Workist' } }, 'Point Nine');
  const b = toRaw({ url: 'https://boards.greenhouse.io/workist/jobs/9', title: 'X', organization: { name: 'Workist' } }, 'Cherry');
  assert.equal(a.sourceId, b.sourceId);
  assert.match(a.applyUrl, /boards\.greenhouse\.io/, 'the canonical ATS url, not a getro.com redirect');
});

test('nothing is billed, because nothing here is metered', () => {
  // Reporting 0 would charge a source with no budget; careersites and agencies
  // return null for the same reason.
  return fetchJobs({ boards: [] }).then((r) => {
    assert.deepEqual(r.jobs, []);
    assert.equal(r.calls, null);
  });
});

test('a disabled board is skipped without a request', async () => {
  const r = await fetchJobs({ boards: [{ name: 'off', url: 'https://example.test/jobs', enabled: false }] });
  assert.deepEqual(r.jobs, []);
  assert.deepEqual(r.errors, [], 'and says nothing about it');
});

test('every configured board carries a cached collection id', () => {
  // Resolving costs an extra page fetch per board per run. The ids are stable,
  // and the source prints the one it resolved so it can be pasted back here.
  const boards = readJson(p('config', 'companies.json')).getro || [];
  assert.ok(boards.length >= 4, 'the measured set is six funds');
  for (const b of boards) {
    assert.match(String(b.collection || ''), /^\d+$/, `${b.name} should cache its collection id`);
    assert.match(b.url, /^https:\/\//);
  }
});

/**
 * Board-driven sources resolve their list from companies.json, and the
 * mapping is HARDCODED in index.js rather than derived.
 *
 * `src/index.js` has a chain — ats → companies.boards, workday →
 * companies.workday, getro → companies.getro, personio → companies.personio.
 * A source registered in SOURCES without a branch there is handed
 * `boards: undefined`, fetches nothing, and reports no error: it simply
 * contributes zero postings every run, silently, which is the worst failure
 * shape this project has.
 */
test('every board-driven source is wired to its list in companies.json', async () => {
  const { SOURCES } = await import('../src/sources/index.js');
  const index = readFileSync(p('src', 'index.js'), 'utf8');
  const companies = readJson(p('config', 'companies.json'));
  const sources = readJson(p('config', 'sources.json'));

  for (const [key, listKey] of [['ats', 'boards'], ['workday', 'workday'], ['getro', 'getro'], ['personio', 'personio']]) {
    assert.ok(SOURCES[key], `${key} must be in the SOURCES map`);
    assert.ok(sources[key]?.enabled !== undefined, `${key} needs an entry in sources.json`);
    // Plain substring, not a built regex. `\?` inside a template literal is
    // just `?`, and `\b` would be a backspace — building patterns by
    // interpolation is how the docs test failed against a correct document.
    assert.ok(index.includes(`key === '${key}' ? companies.${listKey}`),
      `${key} must map to companies.${listKey} in the source loop`);
    assert.ok(Array.isArray(companies[listKey]) && companies[listKey].length,
      `companies.${listKey} must hold at least one board`);
    // And an empty list must warn rather than pass silently.
    assert.ok(index.includes(`key === '${key}' && (!boards || !boards.length)`),
      `${key} must warn when its list is empty`);
  }
});
