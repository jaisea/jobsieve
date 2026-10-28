/**
 * A recruiting agency is a KIND of source, and the kind has one defining
 * property: the employer is a secret.
 *
 * Every apriori posting reports `hiringOrganization: "APRIORI – BUSINESS
 * SOLUTIONS AG"` — 38 of 38 sampled — and names the client only as "Unser Kunde
 * ist ein inhabergeführtes Familienunternehmen". So `company` is the SAME
 * STRING on every posting the source will ever return, and hashing
 * company|title|location is not a weak key, it is a wrong one: two different
 * clients hiring a "DevOps Engineer (m/w/d)" in Frankfurt would be one posting
 * and the second would be silently swallowed.
 *
 * Two more things were measured on the live site and both cut against the
 * obvious implementation:
 *
 *   - its ld+json says `employmentType: "contract"` on 37 of 38 postings,
 *     INCLUDING ones its own search card labels "Permanent". A live run of the
 *     adapter returned 152 postings, every one of them Permanent on the card.
 *     The card is maintained; the ld+json field is a template default.
 *
 *   - the search matches DESCRIPTION text, not titles: `?text=terraform`
 *     returns "Senior DevOps Engineer" and "Cloud Engineer – Hybrid &
 *     Multi-Cloud". That is why this is queried by keyword and never crawled —
 *     the sitemap holds 4,337 postings and a sample of 38 recent ones had 2 in
 *     scope.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { p, readJson } from '../src/util.js';
import { normalize } from '../src/normalize.js';
import { __testables } from '../src/sources/agencies.js';
import { SOURCES } from '../src/sources/index.js';

const { AGENCIES, employmentFrom, jobPosting } = __testables;
const apriori = AGENCIES.find((a) => a.id === 'apriori');
const profile = readJson(p('config', 'examples', 'devops.profile.json'));

/* ------------------------------------------------------------- the card */

/** Reproduced from the live results page, entities and whitespace included. */
const CARD = `<ul class="items"><li><div is="basis-vincere-job-kachel">
<a href="https://www.apriori.de/job-finden/job/255448/" class="item boxPadding" data-industry="IT">
<span class="item-content"><h3> DevOps Engineer (m/w/d) </h3>
<p> IT <span class="dot" aria-hidden="true">·</span> Permanent </p>
<span class="button button--tertiary"> Mehr erfahren </span></span></a></div></li></ul>`;

test('a card yields the id, the title and the contract type', () => {
  const [card] = apriori.cards(CARD);
  assert.equal(card.postingId, '255448');
  assert.equal(card.title, 'DevOps Engineer (m/w/d)');
  assert.equal(card.contract, 'Permanent', 'the last field after the dot, not the industry');
  assert.equal(card.url, 'https://www.apriori.de/job-finden/job/255448/');
});

test('"Mehr erfahren" does not become a title', () => {
  // The anchor wraps the whole card, so everything inside it is a candidate.
  const [card] = apriori.cards(CARD);
  assert.ok(!/mehr erfahren/i.test(card.title));
});

test('the contract type is read from the CARD, never from the ld+json', () => {
  // The single most important line in the adapter, and the one a future reader
  // is most likely to "fix". apriori's ld+json says contract on a posting its
  // own card calls Permanent.
  const src = readFileSync(p('src', 'sources', 'agencies.js'), 'utf8');
  assert.ok(!/j\.employmentType\s*=\s*jp\.employmentType/.test(src));
  assert.ok(!/employmentType:\s*jp\.employmentType/.test(src));
  assert.match(src, /NOT jp\.employmentType/, 'and the reason is written down beside it');
});

test('the German employment types map to concepts the gate knows', () => {
  // Arbeitnehmerüberlassung is a real contract type here and matches neither
  // word `employmentKinds` looks for, so it is mapped rather than passed
  // through.
  assert.match(employmentFrom('Arbeitnehmerüberlassung'), /Zeitarbeit/);
  assert.equal(employmentFrom('Contracting'), 'Contract');
  assert.equal(employmentFrom('Permanent'), 'Permanent');
  assert.equal(employmentFrom(''), null);
});

/* --------------------------------------------------------- the identity */

const agencyJob = (sourceId, title, location) => normalize({
  source: 'agencies', sourceLabel: 'apriori agency', sourceId,
  title, company: 'APRIORI (Personalvermittlung)',
  employerUnknown: true, agency: 'APRIORI – BUSINESS SOLUTIONS AG',
  location, descriptionText: '', descriptionHtml: '', applyUrl: 'https://x.test',
  postedAt: null,
}, profile);

test('two clients hiring the same role in the same city stay two postings', () => {
  // The whole reason the flag exists. Without it both hash
  // "apriori|devops engineer|frankfurt" and one disappears.
  const a = agencyJob('apriori:1001', 'DevOps Engineer (m/w/d)', 'Frankfurt am Main');
  const b = agencyJob('apriori:2002', 'DevOps Engineer (m/w/d)', 'Frankfurt am Main');
  assert.notEqual(a.fingerprint, b.fingerprint);
});

test('the identity does not move when the detail fetch fills in the location', () => {
  // The listing carries no location; it arrives from a later request. Keying on
  // the posting id means that cannot shift the fingerprint underneath a
  // decision — which is exactly the drift reconcile() exists to clean up after.
  const before = agencyJob('apriori:1001', 'DevOps Engineer (m/w/d)', '');
  const after = agencyJob('apriori:1001', 'DevOps Engineer (m/w/d)', 'Berlin, BE');
  assert.equal(before.fingerprint, after.fingerprint);
});

test('a title edit does not create a second posting either', () => {
  const a = agencyJob('apriori:1001', 'DevOps Engineer (m/w/d)', 'Berlin');
  const b = agencyJob('apriori:1001', 'DevOps Engineer (m/w/d) Kubernetes', 'Berlin');
  assert.equal(a.fingerprint, b.fingerprint);
});

test('a normal posting is fingerprinted exactly as before', () => {
  // The branch must be invisible to every other source. Same three inputs,
  // same hash — anything else would re-open the whole archive.
  const mk = (over = {}) => normalize({
    source: 'adzuna', sourceId: 'x1', title: 'DevOps Engineer',
    company: 'Real Employer GmbH', location: 'München',
    descriptionText: '', descriptionHtml: '', applyUrl: 'https://x.test', ...over,
  }, profile);

  assert.equal(mk().fingerprint, mk({ sourceId: 'DIFFERENT' }).fingerprint,
    'the posting id must NOT enter a normal fingerprint');
  assert.notEqual(mk().fingerprint, mk({ company: 'Other GmbH' }).fingerprint);
});

test('the flag survives into the record, or a replay would disagree', () => {
  // npm run why re-normalizes the archived record. If employerUnknown is not
  // stored, the replay hashes the posting the other way and reports a different
  // identity from the run that filed it.
  const j = agencyJob('apriori:1001', 'DevOps Engineer (m/w/d)', 'Berlin');
  assert.equal(j.employerUnknown, true);
  assert.equal(j.agency, 'APRIORI – BUSINESS SOLUTIONS AG');
  assert.equal(normalize({
    source: 'adzuna', sourceId: 'x', title: 'T', company: 'C', location: 'Berlin',
    descriptionText: '', descriptionHtml: '', applyUrl: 'https://x.test',
  }, profile).employerUnknown, false, 'and is false everywhere else');
});

/* ------------------------------------------------------------- plumbing */

test('the employer reads as the agency, not as a guess at the client', () => {
  // "Unser Kunde ist ein inhabergeführtes Familienunternehmen" is not a company
  // name, and turning it into one would be inventing a fact about a posting.
  assert.match(apriori.display, /Personalvermittlung/);
  assert.ok(!/Kunde/i.test(apriori.display));
});

test('ld+json is read defensively — a broken block loses nothing', () => {
  const good = '<script type="application/ld+json">{"@type":"JobPosting","title":"X"}</script>';
  assert.equal(jobPosting(good).title, 'X');
  assert.equal(jobPosting('<script type="application/ld+json">{oops</script>' + good).title, 'X',
    'an unparseable block must not stop the good one being found');
  assert.equal(jobPosting('<html>nothing here</html>'), null);
});

test('the source is registered and switchable', () => {
  assert.ok(SOURCES.agencies, 'sources/index.js must export it');
  const cfg = readJson(p('config', 'sources.json'));
  assert.equal(cfg.agencies?.enabled, true);
  const per = readJson(p('config', 'agencies.json'));
  assert.equal(per.apriori?.enabled, true, 'and each agency has its own switch');
});

test('a posting starved by the detail ceiling is dropped, not parked', () => {
  // Parking means "we asked and it did not arrive". A posting that never got a
  // request because it fell over the ceiling was not asked about, and emitting
  // it with no description would park it on a false premise — the same mistake
  // --no-enrich made with 401 postings.
  const src = readFileSync(p('src', 'sources', 'agencies.js'), 'utf8');
  // The ceiling counts REQUESTS (a cached posting is free), so a posting over it is the one that
  // would have needed a request and did not get one.
  assert.match(src, /const starved = new Set\(\);/);
  assert.match(src, /if \(requested >= MAX_DETAIL\) \{ starved\.add\(j\); continue; \}/);
  assert.match(src, /jobs\.filter\(\(j\) => !starved\.has\(j\)\)/);
  assert.match(src, /not judged this run/, 'and it is reported rather than silent');
});

/**
 * And every request goes through the SHARED per-host queue.
 *
 * This file's own header claimed exactly that while `getText` called `fetch()`
 * directly with no gap at all: 36 list requests plus up to 120 detail requests
 * at one host, as fast as the network allows. A comment asserting politeness is
 * not politeness, and a wrong comment is worse than none — it stops the next
 * reader checking.
 *
 * Shared matters as much as present. `politeWait` keys its queue by HOST across
 * the whole run, so a source fetching a site and the advert step fetching the
 * same site cannot each keep a private idea of the gap.
 */
test('both web-scraping sources wait on the shared per-host queue', () => {
  for (const file of ['agencies.js', 'careersites.js']) {
    const src = readFileSync(p('src', 'sources', file), 'utf8');
    assert.match(src, /import \{ politeWait \} from '\.\.\/enrich\.js'/,
      `${file} must use the project's queue, not its own idea of politeness`);
    assert.match(src, /await politeWait\(url\);\s*\n\s*const res = await fetch\(/,
      `${file} must wait BEFORE fetching, not after`);
  }
});

test('politeWait is a real export, not reached through __testables', () => {
  // It was only exposed for tests, which is why two new sources quietly did
  // without it.
  const enrich = readFileSync(p('src', 'enrich.js'), 'utf8');
  assert.match(enrich, /export function politeWait\(url\)/);
});
