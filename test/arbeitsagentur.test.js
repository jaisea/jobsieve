/**
 * The source that was dead for the life of the project, for the wrong reason.
 *
 * It returned HTTP 403 on every run. The code said "this API blocks some
 * networks; retry from your normal German connection" — which the user was already on
 * — and both the README and CLAUDE.md repeated it as a WAF block on the egress
 * IP. It was not. `/pc/v4/jobs` is retired, and a retired endpoint here answers
 * 403 exactly as a rejected key does. The OAuth exchange in front of it made it
 * look even more like an auth problem.
 *
 * From the same machine, the same minute:
 *
 *   /pc/v4/jobs      X-API-Key   403
 *   /pc/v6/jobs      no auth     403
 *   /pc/v6/jobs      X-API-Key   200   51 jobs across six queries
 *
 * These tests are offline. They pin the shape of the call and the field mapping,
 * because the failure that cost months was a URL, not logic.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { p } from '../src/util.js';
import { normalize } from '../src/normalize.js';

const SRC = readFileSync(p('src', 'sources', 'arbeitsagentur.js'), 'utf8');
const profile = JSON.parse(readFileSync(p('config', 'examples', 'devops.profile.json'), 'utf8'));

test('the search endpoint is v6, and v4 is not referenced as live', () => {
  assert.match(SRC, /jobsuche-service\/pc\/v6\/jobs/);
  const code = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/pc\/v4\/jobs/.test(code), 'v4 must not be called — it is retired');
});

test('authentication is the published key, with no OAuth and no secrets', () => {
  assert.match(SRC, /'X-API-Key': API_KEY/);
  assert.match(SRC, /const API_KEY = 'jobboerse-jobsuche'/);

  // The old path carried two hardcoded UUIDs in a public repository, for a
  // token exchange that was never needed.
  assert.ok(!/CLIENT_SECRET|gettoken_cc|OAuthAccessToken/.test(SRC),
    'the OAuth exchange and its credentials must be gone');
});

test('the source filters to real jobs, matching the saved searches on the website', () => {
  // angebotsart=1 is WORK — it drops Ausbildung, internships and
  // self-employment before the title gate has to. arbeitszeit=vz is full-time.
  assert.match(SRC, /angebotsart: OFFER_TYPE_WORK/);
  assert.match(SRC, /arbeitszeit: FULL_TIME/);
  assert.match(SRC, /const OFFER_TYPE_WORK = '1'/);
  assert.match(SRC, /const FULL_TIME = 'vz'/);
});

test('the freshness filter is deliberately NOT sent', () => {
  // veroeffentlichtseit filters on a date it does not report: a posting whose
  // veroeffentlichungszeitraum.von reads 119 days old still passes a 45-day
  // filter. A pre-filter whose behaviour cannot be predicted from the data is
  // exactly what the looksReachable note forbids.
  const code = SRC.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(!/veroeffentlichtseit:/.test(code), 'must not be a request parameter');
  assert.match(SRC, /`veroeffentlichtseit` is NOT sent, deliberately/, 'and the reason is written down');
});

test('no detail request is made per posting', () => {
  // Descriptions need /pc/v4/jobdetails/{base64(refnr)}, one call each. Doing
  // that here would spend a request on postings the title and location gates
  // discard for free — the trap workday.js documents. enrich fetches text for
  // survivors only.
  assert.ok(!/jobdetails/.test(SRC.replace(/\/\*[\s\S]*?\*\//g, '')));
});

/* ------------------------------------------------------- the field mapping */

const RESULT = {
  stellenangebotsTitel: 'DevOps Engineer (m/w/d)',
  firma: 'FERCHAU GmbH Niederlassung München',
  referenznummer: '10000-1197058931-S',
  entfernung: 4,
  arbeitszeitVollzeit: true,
  gehaltsspanneVon: 55000,
  gehaltsspanneBis: 75000,
  hauptberuf: 'DevOps Engineer',
  datumErsteVeroeffentlichung: '2025-01-31',
  veroeffentlichungszeitraum: { von: '2026-08-18' },
  aenderungsdatum: '2026-09-02T09:38:49.984',
  stellenlokationen: [{
    adresse: { ort: 'München', region: 'BADEN_WUERTTEMBERG', land: 'DEUTSCHLAND' },
  }],
};

/** The module keeps toJob private; this mirrors what fetchJobs pushes. */
const mapped = () => ({
  source: 'arbeitsagentur',
  title: RESULT.stellenangebotsTitel,
  company: RESULT.firma,
  location: 'München, BADEN_WUERTTEMBERG, DEUTSCHLAND',
  distanceKm: RESULT.entfernung,
  applyUrl: `https://www.arbeitsagentur.de/jobsuche/jobdetail/${encodeURIComponent(RESULT.referenznummer)}`,
  postedAt: RESULT.veroeffentlichungszeitraum.von,
  descriptionText: '',
});

test('the posted date is the current listing, not the first ever publication', () => {
  // Employers here post once and re-list. This posting first appeared
  // 2025-01-31 and was re-listed 2026-08-18; reading the first date would age
  // an open role out of the report by nineteen months.
  assert.match(SRC, /postedAt: j\.veroeffentlichungszeitraum\?\.von/);

  const j = normalize(mapped(), profile);
  assert.equal(j.postedAt.slice(0, 10), '2026-08-18');
});

test('the apply URL points at the public page, which enrich can read', () => {
  const j = normalize(mapped(), profile);
  assert.match(j.applyUrl, /^https:\/\/www\.arbeitsagentur\.de\/jobsuche\/jobdetail\//);
  // rest.arbeitsagentur.de needs the key; www does not, and carries ld+json.
  assert.ok(!/rest\.arbeitsagentur/.test(j.applyUrl));
});

test("the agency's own distance survives when the gazetteer cannot place a town", () => {
  // Schönau im Schwarzwald is not in the gazetteer, resolved to null, and was
  // escalating on location for no reason. entfernung had the answer all along.
  const unknown = { ...mapped(), location: 'Schönau im Schwarzwald', distanceKm: 24 };
  const j = normalize(unknown, profile);
  assert.equal(j.distanceKm, 24);
});

test('but the gazetteer still wins where it has an answer', () => {
  // One measurement for every source is worth more than each source's own, so
  // the source figure is a fallback and never an override.
  const j = normalize({ ...mapped(), distanceKm: 999 }, profile);
  assert.ok(j.distanceKm < 50, `gazetteer should win, got ${j.distanceKm}`);
});

/* --------------------------------------------- the remote pass, without `wo` */

/**
 * Was the API queried for remote jobs with no location constraint? It was
 * not, and that was the Roche Workday facet trap rebuilt: a
 * remote German role is posted under whichever office owns it, so anchoring on
 * the home city drops exactly the remote roles worth having.
 *
 * Dropping the location filter alone does not fix it — of 100 nationwide
 * results only ONE says remote in its title, so the gate discards 99. The
 * keyword does fix it, because the API searches the description.
 */

test('the remote pass runs without a location, and the local pass keeps one', () => {
  assert.match(SRC, /if \(local\) \{[\s\S]{0,120}params\.set\('wo', city\)/,
    'wo and umkreis only on the local pass');
  assert.match(SRC, /const REMOTE_TERMS = \['remote', 'homeoffice'\]/);
});

test('both remote words are searched separately, not combined', () => {
  // Of 68 hits for "homeoffice", 55 are absent from the 90 for "remote".
  // Combining them is worse than running two: "remote homeoffice" misses 28
  // that "remote" alone found.
  assert.match(SRC, /REMOTE_TERMS\.map\(\(term\) => \(\{ was: `\$\{q\} \$\{term\}`/);
});

test('remote is a hint from the search, never a finding', () => {
  // The posting outranks the aggregator. Setting workMode as a fact here is the
  // bug that put a Hannover job in the report at 93 on a "remote" tag while its
  // text offered only "the possibility of home office". normalize runs
  // detectWorkMode first and uses this only when the text says nothing — which
  // is true at fetch time and false after enrich.
  assert.match(SRC, /workMode: remoteHint \? 'remote' : undefined/);
  assert.match(SRC, /A HINT, never a finding/);

  // And the fallback order in normalize is what makes that safe.
  const norm = readFileSync(p('src', 'normalize.js'), 'utf8');
  const at = norm.indexOf('detectWorkMode');
  assert.ok(at > 0 && at < norm.indexOf('raw.workMode'), 'detectWorkMode must run before raw.workMode');
});

test('a description overrides the hint', () => {
  // The whole safety argument in one assertion: same job, once with no text and
  // once with text that says onsite.
  const base = {
    source: 'arbeitsagentur', title: 'DevOps Engineer (m/w/d)', company: 'X',
    location: 'Hamburg', applyUrl: 'https://example.invalid', workMode: 'remote',
  };
  assert.equal(normalize({ ...base, descriptionText: '' }, profile).workMode, 'remote',
    'with no text the hint stands');

  const onsite = normalize({
    ...base,
    descriptionText: 'Die Tätigkeit erfolgt ausschließlich vor Ort in unserem Büro in Hamburg. '.repeat(12),
  }, profile);
  assert.notEqual(onsite.workMode, 'remote', 'the posting wins once it can be read');
});

test('a full advert that never mentions remote is NOT remote', () => {
  // The hint survived enrichment, and my earlier reasoning for why that was
  // safe was wrong. Detection only overrides when the text positively states
  // onsite, and most adverts simply never discuss it — so silence let the tag
  // stand. A Site Reliability Engineer at Bundesdruckerei reached the report at
  // 81, badged "Remote (Germany)", scoring 20/20 on location, 639km away in
  // Berlin. Its 1718-character description says one thing about where the work
  // happens: "für den Standort Berlin".
  //
  // Silence in a full advert is evidence AGAINST remote. An employer offering
  // it says so.
  const berlin = {
    source: 'arbeitsagentur', title: 'Site Reliability Engineer (m/w/d)',
    company: 'Bundesdruckerei Gruppe GmbH', location: 'Berlin, BERLIN, DEUTSCHLAND',
    applyUrl: 'https://example.invalid', workMode: 'remote',
    descriptionText: 'Zum nächstmöglichen Zeitpunkt suchen wir Sie als Site Reliability Engineer '
      + 'für den Standort Berlin. '.repeat(30),
  };
  assert.notEqual(normalize(berlin, profile).workMode, 'remote');
});

test('but the hint still stands while there is nothing to read', () => {
  // Otherwise the remote pass is pointless: the job would be dropped on
  // location before enrich ever fetches the description that would settle it.
  const j = normalize({
    source: 'arbeitsagentur', title: 'DevOps Engineer', company: 'X',
    location: 'Berlin', applyUrl: 'https://example.invalid',
    descriptionText: '', workMode: 'remote',
  }, profile);
  assert.equal(j.workMode, 'remote');
});

test('the threshold is the same one truncation uses', () => {
  // A 200-character aggregator stub is not an advert. MIN_DESCRIPTION_CHARS
  // already draws that line for the language check; drawing it somewhere else
  // here would mean two different ideas of "enough text to judge".
  const norm = readFileSync(p('src', 'normalize.js'), 'utf8');
  assert.match(norm, /readable = \(descriptionText \|\| ''\)\.trim\(\)\.length >= MIN_DESCRIPTION_CHARS/);
});
