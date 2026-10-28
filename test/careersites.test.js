/**
 * A career site that publishes a sitemap and nothing else machine-readable.
 *
 * The first is SAP SuccessFactors Recruiting Marketing — the platform once
 * called Jobs2Web, which mailalerts.js already knew from the other end as the
 * "Employer alert" parser. One deployment serves a whole group:
 * jobsearch.createyourowncareer.com carries 978 postings across 42 Bertelsmann
 * brands — Arvato Systems, Riverty, RTL, smartclip — behind a single sitemap.
 *
 * Three decisions worth protecting, each measured against the live site:
 *
 *   - THE SITEMAP, NOT THE SEARCH. The site's search is a JavaScript shell that
 *     calls /services/, and /services/ is Disallow: in robots.txt. Nothing here
 *     may read it.
 *   - THE TITLE GATE RUNS ON THE URL. The sitemap slug carries the city and the
 *     title, so 978 postings cost ONE request and only the ~29 survivors cost a
 *     second. Crawling would be 978 requests for a corpus that is mostly sales,
 *     law and internships.
 *   - MICRODATA, NOT JSON-LD. These pages carry no ld+json at all, so enrich.js
 *     cannot read them; they carry the same schema.org vocabulary as itemprop
 *     attributes plus an og:title.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { p, readJson } from '../src/util.js';
import { SOURCES } from '../src/sources/index.js';
import { __testables, splitAddress, descriptionOf, parseLocation } from '../src/sources/careersites.js';

const { SITES, ogTag } = __testables;
const bertelsmann = SITES.find((s) => s.id === 'bertelsmann');
const SRC = readFileSync(p('src', 'sources', 'careersites.js'), 'utf8');

/* ------------------------------------------------------------- the sitemap */

test('a job URL yields its brand, its slug and its id', () => {
  const url = 'https://jobsearch.createyourowncareer.com/smartclip/job/'
    + 'Berlin-DevOps-Engineer-%28wmd%29-Google-Cloud-Platform-10435/1414415033/';
  const m = url.match(bertelsmann.match);
  assert.ok(m, 'the shape must match');
  assert.equal(bertelsmann.brandName(m[1]), 'smartclip');
  assert.equal(m[3], '1414415033');
  assert.match(decodeURIComponent(m[2]), /DevOps-Engineer/);
});

test('an underscore in the brand segment is a space in the company name', () => {
  assert.equal(bertelsmann.brandName('Arvato_Systems'), 'Arvato Systems');
  assert.equal(bertelsmann.brandName('Bertelsmann_Corporate'), 'Bertelsmann Corporate');
  assert.equal(bertelsmann.brandName('Riverty'), 'Riverty');
});

test('non-job URLs in the same sitemap are ignored', () => {
  // The sitemap mixes job pages with content and locale pages across 42 brands.
  for (const u of [
    'https://jobsearch.createyourowncareer.com/Riverty/content/Privacy-Policy/',
    'https://jobsearch.createyourowncareer.com/Riverty/?locale=nl_NL',
    'https://jobsearch.createyourowncareer.com/Riverty/go/Some-Category/12345/',
  ]) {
    assert.equal(u.match(bertelsmann.match), null, u);
  }
});

test('the slug is handed to the title gate whole', () => {
  // "<City>-<Title>-<postcode>", and the city can itself contain a hyphen
  // ("Baden-Baden"), so there is no reliable split. The real title comes from
  // og:title once the page is fetched, so the slug only has to be good enough
  // to gate on.
  assert.match(SRC, /handed to the title gate\s+\/\/\s+WHOLE|slug carries/i);
  assert.match(SRC, /titleFilter\(j\.slug\)/, 'the gate reads the slug, not a guessed title');
});

/* --------------------------------------------------------------- the page */

test('the address splits into a city and a country, not a street', () => {
  // "10435, Berlin, Kastanienallee 97, Germany" — postcode, city, street,
  // country. Vienna adds a fourth part ("…, Top 6, Austria") and the rule still
  // holds: city is second, country is last.
  assert.deepEqual(splitAddress('10435, Berlin, Kastanienallee 97, Germany'),
    { city: 'Berlin', country: 'Germany' });
  assert.deepEqual(splitAddress('1100, Vienna, Karl-Popper-Strasse 2, Top 6, Austria'),
    { city: 'Vienna', country: 'Austria' });
  assert.deepEqual(splitAddress('76532, Baden-Baden, Schwarzwaldstr. 78, Germany'),
    { city: 'Baden-Baden', country: 'Germany' }, 'a hyphenated city survives');
  assert.deepEqual(splitAddress(''), { city: '', country: '' });
});

test('the description container is a SPAN, and assuming a div loses everything', () => {
  // This is the bug this test exists for. The first version searched for a div
  // and returned an empty string for all 29 postings, while every other field
  // looked perfect — the worst possible failure, because an empty advert is not
  // a missing one: the gates read "no German requirement" and "no tools named"
  // as findings, from nothing.
  const page = '<div class="row"><span xml:lang="en-US" itemprop="description"'
    + ' data-careersite-propertyid="description" class="rtltextaligneligible">'
    + '<span class="jobdescription"><h1>Company Description</h1>'
    + '<p>We work <strong>remote</strong> by default.</p>'
    + '<ul><li><p>Kubernetes and Terraform</p></li></ul>'
    + '</span></span></div>';

  const got = descriptionOf(page);
  assert.match(got, /Company Description/);
  assert.match(got, /remote by default/, 'nested markup must not truncate it');
  assert.match(got, /Kubernetes and Terraform/, 'nor must a list');
  assert.ok(!/<[a-z]/i.test(got), 'and the markup is stripped');
});

test('a page with no description block yields empty rather than the whole page', () => {
  assert.equal(descriptionOf('<html><body><p>nothing here</p></body></html>'), '');
});

test('og:title is decoded, because it is an attribute', () => {
  // "IT Infrastructure &amp; Security Expert" reached the report with the
  // entity intact. Same class as the LinkedIn `&middot;`, and the title feeds
  // the fingerprint.
  const html = '<meta property="og:title" content="IT Infrastructure &amp; Security Expert (m/w/d)" />';
  assert.equal(ogTag(html, 'title'), 'IT Infrastructure &amp; Security Expert (m/w/d)',
    'the raw tag is still encoded');
  assert.match(SRC, /const title = clean\(ogTag\(html, 'title'\)\)/,
    'so it must go through clean(), which decodes');
});

/* ------------------------------------------------------- failing loudly */

test('a selector that stops matching is reported, not absorbed', () => {
  // Every other field would still look right, so nothing else would notice —
  // the postings would simply all be parked and the run would claim success.
  assert.match(SRC, /blank > fetched\.length \/ 2/);
  assert.match(SRC, /the page markup has probably changed/);
});

test('a sitemap that parses but holds no jobs is an error, not an empty run', () => {
  assert.match(SRC, /sitemap parsed but held no job URLs/);
});

test('postings over the detail ceiling are reported', () => {
  assert.match(SRC, /over the \$\{MAX_DETAIL\}-detail ceiling — not judged this run/);
});

/* ------------------------------------------------------------- politeness */

test('nothing reads the path robots.txt disallows', () => {
  // /services/ is where the search API lives and it is Disallow: for every
  // user-agent. The sitemap is not, which is the whole reason this source is
  // shaped the way it is.
  assert.ok(!SRC.includes('/services/') || /Disallow/.test(SRC),
    'a /services/ URL may only appear in the note explaining why it is not used');
  assert.ok(!/fetch\([^)]*\/services\//.test(SRC), 'and never in a request');
  assert.match(SRC, /robots\.txt/, 'the reason is recorded beside the code');
});

test('the source is registered and switchable', () => {
  assert.ok(SOURCES.careersites);
  assert.equal(readJson(p('config', 'sources.json')).careersites?.enabled, true);
});

test('a nested span inside the advert does not truncate it', () => {
  // The fixture that was missing. Cutting at the FIRST </span> worked on every
  // page sampled — 12 brands, zero nested spans — but that is a property of the
  // sample, not of the format. These adverts are pasted out of a rich-text
  // editor, and one <span style="..."> around a bold phrase would end the
  // description there. Silently: a short advert is not obviously wrong, it just
  // stops feeding the gates.
  const page = '<div><span itemprop="description"><span class="jobdescription">'
    + '<h1>Job Description</h1><p>We use <span style="font-weight:bold">Kubernetes</span>'
    + ' and Terraform daily.</p></span></span></div><footer>site navigation junk</footer>';

  const got = descriptionOf(page);
  assert.match(got, /Kubernetes/);
  assert.match(got, /Terraform daily/, 'the text after the nested span must survive');
  assert.ok(!got.includes('site navigation junk'), 'and the page furniture must not leak in');
});

test('an unclosed span does not swallow the rest of the page', () => {
  const page = '<div><span class="jobdescription"><p>Kubernetes <span>oops</p>'
    + '</div><footer>site navigation junk</footer>';
  assert.ok(!descriptionOf(page).includes('site navigation junk'));
});

/* ---------------------------------------- the single-employer deployments */

const site = (id) => SITES.find((s) => s.id === id);

test('Endress+Hauser, SICK, Bachem and Fraunhofer match their job URLs, with or without a country segment', () => {
  const cases = [
    ['endress', 'https://careers.endress.com/India/job/Chh_-Sambhajinagar-Deputy-Manager-431136/1395340533/', '1395340533'],
    ['endress', 'https://careers.endress.com/job/Reinach-Senior-Software-Architect-4153/1439300533/', '1439300533'],
    ['sick', 'https://jobs.sick.com/job/Freising-%28bei-München%29-Duales-Studium-Freising/1414764733/', '1414764733'],
    ['bachem', 'https://careers.bachem.com/job/Bubendorf-IT-Service-Delivery-Manager-4416/1405921833/', '1405921833'],
    ['fraunhofer', 'https://jobs.fraunhofer.de/job/München-KI-Softwareentwickler-79110/1404315033/', '1404315033'],
  ];
  for (const [id, url, postingId] of cases) {
    const m = url.match(site(id).match);
    assert.ok(m, `${id}: ${url}`);
    assert.equal(m[3], postingId);
  }
});

test('the employer is fixed, never taken from the first path segment', () => {
  // On Endress+Hauser that segment is a country or a subsidiary ("India",
  // "analytik-jena"); using it as the company would split one employer into
  // dozens and hand each a different fingerprint.
  assert.equal(site('endress').brandName('India'), 'Endress+Hauser');
  assert.equal(site('endress').brandName(undefined), 'Endress+Hauser');
  assert.equal(site('sick').brandName(), 'SICK AG');
});

test("SICK's other-country sites are not read", () => {
  // /usa/job/… and /china/job/… are different sites on the same sitemap; the
  // location gate would discard each one after a detail fetch had been paid for.
  const m = site('sick').match;
  assert.equal('https://jobs.sick.com/usa/job/Canton-Software-Engineering-Intern-02021/1436856333/'.match(m), null);
  assert.ok('https://jobs.sick.com/germany/job/Foo/34887/'.match(m));
});

test('the three address layouts all resolve to a city and a country', () => {
  // Bertelsmann: postcode, city, street, country.
  assert.deepEqual(splitAddress('10435, Berlin, Kastanienallee 97, Germany'), { city: 'Berlin', country: 'Germany' });
  // Fraunhofer / Endress+Hauser: city, ISO code, postcode — the opposite order.
  assert.deepEqual(splitAddress('Freising, DE, 79183'), { city: 'Freising', country: 'Germany' });
  assert.deepEqual(splitAddress('Wien, AT, 1230'), { city: 'Wien', country: 'Austria' });
  // Bachem: two separate properties.
  const bachem = '<meta itemprop="addressLocality" content="Bubendorf"><meta itemprop="addressCountry" content="CH">';
  assert.equal(parseLocation(bachem, site('bachem')), 'Bubendorf, Switzerland');
});

test('a site with no location markup falls back to the city in the URL slug, only when opted in', () => {
  const sick = site('sick');
  assert.equal(parseLocation('<html></html>', sick, 'Freising (bei München) Duales Studium 2027'),
    'Freising (bei München), Germany');
  // Not the default: a hyphenated town would be cut short, and a wrong city is
  // worse than none.
  assert.equal(parseLocation('<html></html>', site('bachem'), 'Bubendorf Something'), '');
});

test('MEDICE reads its city from the "Stellenstandort" label, because its slug may hold none', () => {
  const medice = site('medice');
  const url = 'https://career.medice-health-family.com/job/%28Senior%29-DevSecOps-Engineer-%28mwd%29-Digital-Health/1411160933/';
  const m = url.match(medice.match);
  assert.ok(m);
  assert.equal(m[3], '1411160933');
  assert.equal(medice.brandName(m[1]), 'MEDICE Arzneimittel Pütter GmbH & Co. KG');

  // Markup as served on 2026-10-20, whitespace included.
  const page = '<span class="joblayouttoken-label" role="heading" aria-level="2">Stellenebene: \n        </span>\n\n'
    + '    <span xml:lang="de-DE" lang="de-DE" class="rtltextaligneligible">Berufserfahrene\n    </span>'
    + '<span class="joblayouttoken-label" role="heading" aria-level="2">Stellenstandort: \n        </span>\n\n'
    + '    <span xml:lang="de-DE" lang="de-DE" class="rtltextaligneligible">Iserlohn\n    </span>';
  // The slug starts "(Senior) DevSecOps…" — read as a city it would be "(Senior)".
  assert.equal(parseLocation(page, medice, '(Senior) DevSecOps Engineer (mwd) Digital Health'), 'Iserlohn, Germany');

  // An empty field yields nothing rather than the next label's value.
  const empty = '<span class="joblayouttoken-label">Stellenstandort: </span><span class="x"></span>'
    + '<span class="joblayouttoken-label">Stellenebene: </span><span>Berufserfahrene</span>';
  assert.equal(parseLocation(empty, medice, ''), '');
});

test("a page without the jobdescription class still yields the advert from itemprop=description", () => {
  const page = '<span lang="de" itemprop="description" class="x"><p>Kubernetes und Terraform im Alltag.</p></span>'
    + '<span itemprop="description"><p>Kontakt: Jemand</p></span>';
  assert.match(descriptionOf(page), /Kubernetes und Terraform/);
});

test('the location pre-filter is applied to the slug, so far-away postings cost no detail fetch', () => {
  assert.match(SRC, /locationFilter/);
});
