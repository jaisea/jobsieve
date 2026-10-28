/**
 * Beesite — the JSON search behind Rexx-fronted German career sites. Markant
 * (Rosenheim) is the first.
 *
 * The fixture is a real response, trimmed to two items.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { p, readJson } from '../src/util.js';
import { SOURCES } from '../src/sources/index.js';
import { parseSearch, searchUrl, __testables } from '../src/sources/beesite.js';

const SRC = readFileSync(p('src', 'sources', 'beesite.js'), 'utf8');

const item = (id, title, org, city) => ({
  MatchedObjectId: id,
  MatchedObjectDescriptor: {
    ID: id,
    PositionTitle: title,
    PositionURI: `https://jobs.markant.com/index.php?ac=jobad&id=${id}`,
    ParentOrganizationName: org,
    PositionSchedule: [{ Code: '1', Name: 'Full time' }],
    PositionLocation: [{ CityName: city, CountryName: 'Germany', CountryCode: 'DE' }],
    PublicationStartDate: '2025-12-10',
  },
});

const FIXTURE = {
  LanguageCode: 'EN',
  SearchResult: {
    SearchResultCount: 2,
    SearchResultCountAll: 42,
    SearchResultItems: [
      item('494', 'Software Quality Engineer (m/w/d)', 'Markant Services International GmbH', 'Rosenheim'),
      item('585', 'KYC-Analyst (m/w/d)', 'Markant European Payment Services GmbH', 'Rosenheim'),
    ],
  },
};

test('a posting yields title, hiring entity, location, date and employment type', () => {
  const [a, b] = parseSearch(FIXTURE, { slug: 'markant', name: 'Markant' });
  assert.equal(a.title, 'Software Quality Engineer (m/w/d)');
  // The legal entity actually hiring, not the tenant name: a group board lists
  // several and the fingerprint is built from it.
  assert.equal(a.company, 'Markant Services International GmbH');
  assert.equal(b.company, 'Markant European Payment Services GmbH');
  assert.equal(a.location, 'Rosenheim, Germany');
  assert.equal(a.postedAt, '2025-12-10');
  assert.equal(a.employmentType, 'Full time');
  assert.equal(a.source, 'beesite');
});

test('the source id is the posting id, never the URL', () => {
  // The URL differs between postings ONLY in its query string, and
  // normaliseSourceId() strips the query: a URL-shaped id would collapse all 42
  // postings into one — the collision the Indeed parser had.
  const [a, b] = parseSearch(FIXTURE, { slug: 'markant' });
  assert.equal(a.sourceId, 'beesite:markant:494');
  assert.equal(b.sourceId, 'beesite:markant:585');
  assert.notEqual(a.sourceId, b.sourceId);
});

test('the listing carries no advert and says so rather than inventing one', () => {
  // The advert comes from the job page via the enrich step; an empty string here
  // is "not fetched yet", which is what lets the pipeline fetch it.
  const [a] = parseSearch(FIXTURE, { slug: 'markant' });
  assert.equal(a.descriptionText, '');
  assert.match(a.applyUrl, /ac=jobad&id=494$/);
});

test('an item with no title or no link is skipped, not emitted half-empty', () => {
  const broken = { SearchResult: { SearchResultItems: [
    { MatchedObjectId: '1', MatchedObjectDescriptor: { ID: '1', PositionTitle: '', PositionURI: 'https://x/1' } },
    { MatchedObjectId: '2', MatchedObjectDescriptor: { ID: '2', PositionTitle: 'Real', PositionURI: '' } },
    item('3', 'Kept', 'Org', 'Rosenheim'),
  ] } };
  assert.deepEqual(parseSearch(broken, { slug: 's' }).map((j) => j.title), ['Kept']);
});

test('a response of the wrong shape is reported as null, not as an empty board', () => {
  // null is "the API changed"; [] is "the employer has no jobs". Conflating them
  // is how a broken adapter looks like a quiet week.
  assert.equal(parseSearch({ error: { code: 404 } }, { slug: 's' }), null);
  assert.equal(parseSearch(null, { slug: 's' }), null);
  assert.deepEqual(parseSearch({ SearchResult: { SearchResultItems: [] } }, { slug: 's' }), []);
});

test('several offices are all kept in the location', () => {
  const d = { PositionLocation: [
    { CityName: 'Rosenheim', CountryName: 'Germany' },
    { CityName: 'Porto', CountryName: 'Portugal' },
    { CityName: 'Rosenheim', CountryName: 'Germany' },
  ] };
  assert.equal(__testables.locationOf(d), 'Rosenheim, Germany · Porto, Portugal');
});

test('the request is a paged GET against the configured host', () => {
  const u = new URL(searchUrl('example-beesite.app.beesite.de', 101));
  assert.equal(u.host, 'example-beesite.app.beesite.de');
  const data = JSON.parse(u.searchParams.get('data'));
  assert.equal(data.SearchParameters.FirstItem, 101);
  assert.equal(data.SearchParameters.CountItem, __testables.PAGE);
});

test('a board needs both a slug and a host, and the host is configuration', () => {
  // The host (markant-beesite-production-gjb.app.beesite.de) cannot be derived
  // from the employer's name, so nothing may guess it.
  assert.doesNotMatch(SRC, /\$\{slug\}\.app\.beesite/);
  const board = readJson(p('config', 'companies.json')).beesite[0];
  assert.ok(board.slug && board.host);
});

test('the source is registered, switchable and read from companies.json', () => {
  assert.ok(SOURCES.beesite);
  assert.equal(readJson(p('config', 'sources.json')).beesite?.enabled, true);
  assert.ok(readFileSync(p('src', 'index.js'), 'utf8').includes("key === 'beesite' ? companies.beesite"));
});
