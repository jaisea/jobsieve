/**
 * Workday's country facet.
 *
 * These are global employers — Roche, Novartis, Sanofi, Stryker, Pfizer — and a
 * plain search returns Hyderabad and Madrid alongside Basel. Filtering server
 * side is worth far more than filtering afterwards, because every posting that
 * survives the title check costs a detail request: a search of Stryker returned
 * 63 where restricting to Germany returned 4, all of them in one nearby city.
 *
 * Both bugs these tests protect against were found by running the real API and
 * measuring, not by reading the docs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { readFileSync } from 'node:fs';

import { p } from '../src/util.js';
import { __testables, id } from '../src/sources/workday.js';

const { learnFacets, countryFacet, LEARNED } = __testables;

const DE = 'dcc5b7608d8644b3a93716604e78e995';
const CH = '187134fccb084a0ea9b4b95f23890dbe';

/** Sanofi and Novartis: country nested inside a location group. */
const NESTED = [
  { facetParameter: 'JobFamilyGroup', values: [{ id: 'x', descriptor: 'IT' }] },
  { facetParameter: 'locationMainGroup', values: [
    { facetParameter: 'locationCountry', values: [
      { id: DE, descriptor: 'Germany', count: 4 },
      { id: 'es', descriptor: 'Spain', count: 57 },
    ] },
    { facetParameter: 'locations', values: [{ id: 'c1', descriptor: 'Berlin' }] },
  ] },
];

/** Stryker and Pfizer: country as a top-level group. */
const TOP_LEVEL = [
  { facetParameter: 'Location_Country', values: [
    { id: DE, descriptor: 'Germany', count: 4 },
    { id: 'in', descriptor: 'India', count: 24 },
  ] },
  { facetParameter: 'locationMainGroup', values: [
    { facetParameter: 'primaryLocation', values: [{ id: 'c2', descriptor: 'München' }] },
  ] },
];

/** Roche: cities only, no country facet anywhere. Verified against the live API. */
const CITIES_ONLY = [
  { facetParameter: 'locationMainGroup', values: [
    { facetParameter: 'locations', values: [
      { id: 'c3', descriptor: 'Basel', count: 13 },
      { id: 'c4', descriptor: 'Hyderabad', count: 11 },
    ] },
  ] },
];

test('the facet key is found whether it is nested or top-level', () => {
  // Matching one shape left three boards of five silently unfiltered.
  LEARNED.clear();
  assert.equal(learnFacets(NESTED), 'locationCountry');
  LEARNED.clear();
  assert.equal(learnFacets(TOP_LEVEL), 'Location_Country');
});

test('a board with no country facet reports none, rather than guessing at cities', () => {
  // Roche. Its cities cannot be filtered safely: a REMOTE German role is posted
  // under whichever office owns it, so filtering on city drops exactly the
  // remote roles worth having. Verified separately that Roche ignores the facet
  // key entirely — 152 results with or without it.
  LEARNED.clear();
  assert.equal(learnFacets(CITIES_ONLY), null);
  assert.equal(countryFacet(null, ['Germany']), null);
});

test('country ids learned from one board are usable on another', () => {
  // The values in a facet response are only the countries matching THAT search,
  // so "devops engineer" at Novartis can return Spain and Austria and no
  // Germany. Reading ids from a single search concluded "no such facet" and gave
  // up on the board permanently. The ids are Workday reference data and are
  // identical across tenants, so they accumulate.
  LEARNED.clear();
  learnFacets(NESTED);                       // Sanofi search: teaches us Germany
  const key = learnFacets(TOP_LEVEL);        // Stryker search: same id, new key
  assert.deepEqual(countryFacet(key, ['Germany']), { Location_Country: [DE] });
});

test('a country never seen contributes nothing rather than a broken filter', () => {
  // Asking for Switzerland before any response has mentioned it must not send
  // an empty or undefined id — that would filter the board down to nothing and
  // look exactly like a company with no openings.
  LEARNED.clear();
  const key = learnFacets(NESTED);
  assert.equal(countryFacet(key, ['Switzerland']), null);
  assert.deepEqual(countryFacet(key, ['Germany', 'Switzerland']), { locationCountry: [DE] });
});

test('every posting carries its source', () => {
  // These were reaching the archive with no source at all, so 85 postings
  // showed as "?" in the stats and the watchlist undercounted the board.
  const src = readFileSync(p('src', 'sources', 'workday.js'), 'utf8');
  const push = src.slice(src.indexOf('out.push({'), src.indexOf('applyUrl:'));
  assert.ok(push.includes('source: id'), 'fetchJobs must stamp source on each posting');
  assert.equal(id, 'workday');
});
