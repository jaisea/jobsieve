/**
 * BWI GmbH — the Bundeswehr IT provider, read from its jobs sitemap and the
 * JobPosting ld+json on each posting's page.
 *
 * The fixtures are trimmed from the live site (2026-10-16).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { p, readJson } from '../src/util.js';
import { SOURCES } from '../src/sources/index.js';
import { extractDescription } from '../src/enrich.js';
import { jobsSitemapUrl, parseSitemap, parsePosting, locationOf, __testables } from '../src/sources/bwi.js';

const SRC = readFileSync(p('src', 'sources', 'bwi.js'), 'utf8');

const INDEX = `<sitemapindex>
  <sitemap><loc>https://www.bwi.de/sitemap.xml?sitemap=pages&amp;cHash=f4</loc></sitemap>
  <sitemap><loc>https://www.bwi.de/sitemap.xml?sitemap=jobs&amp;cHash=b8</loc></sitemap>
</sitemapindex>`;

const SITEMAP = `<urlset>
  <url><loc>https://www.bwi.de/karriere/stellenangebote/job/senior-ci-cd-platform-engineer-architect-m-w-d-70418</loc></url>
  <url><loc>https://www.bwi.de/karriere/stellenangebote/job/senior-ai-engineer-w-m-d-70835</loc></url>
  <url><loc>https://www.bwi.de/karriere/stellenangebote/job/devsecops-architect-cloud-m-w-d-66157</loc></url>
  <url><loc>https://www.bwi.de/karriere/stellenangebote</loc></url>
</urlset>`;

const place = (city, code = 'DE') => ({ '@type': 'Place', address: { addressLocality: city, addressCountry: code } });
const LD = {
  '@context': 'http://schema.org/', '@type': 'JobPosting', datePosted: '2026-09-28',
  title: 'Senior CI/CD Platform Engineer / Architect (m/w/d)',
  description: '<p>Als Digitalisierungspartner der Bundeswehr &hellip; GitLab, Kubernetes</p>',
  hiringOrganization: { '@type': 'Organization', name: 'BWI GmbH' },
  jobLocation: [place('Berlin'), place('Bonn'), place('Berlin')],
  employmentType: 'FULL_TIME', identifier: { '@type': 'PropertyValue', value: 70418 }, validThrough: '2026-12-27',
};
const PAGE = `<html><head><script type="application/ld+json">${JSON.stringify(LD)}</script></head></html>`;
const URL70418 = 'https://www.bwi.de/karriere/stellenangebote/job/senior-ci-cd-platform-engineer-architect-m-w-d-70418';

test('the jobs sitemap is found in the index, with the cHash it currently carries', () => {
  // The hash changes, so it is read each run and never hardcoded. robots.txt
  // allows exactly this form (`Allow: /sitemap.xml?sitemap=*&cHash=*`).
  assert.equal(jobsSitemapUrl(INDEX), 'https://www.bwi.de/sitemap.xml?sitemap=jobs&cHash=b8');
  assert.equal(jobsSitemapUrl('<sitemapindex></sitemapindex>'), null);
  assert.doesNotMatch(SRC, /cHash=[0-9a-f]{8}/);
});

test('posting URLs give a title slug without the gender suffix, and the id', () => {
  const rows = parseSitemap(SITEMAP);
  assert.equal(rows.length, 3, 'the bare listing URL is not a posting');
  assert.equal(rows[0].slug, 'senior ci cd platform engineer architect');
  assert.equal(rows[0].postingId, '70418');
  assert.equal(rows[1].slug, 'senior ai engineer', 'w-m-d order is stripped too');
});

test('a posting page yields title, employer, every office once, dates and an advert', () => {
  const j = parsePosting(PAGE, { url: URL70418, postingId: '70418' });
  assert.equal(j.title, 'Senior CI/CD Platform Engineer / Architect (m/w/d)');
  assert.equal(j.company, 'BWI GmbH');
  assert.equal(j.location, 'Berlin, Germany · Bonn, Germany');
  assert.equal(j.postedAt, '2026-09-28T00:00:00.000Z');
  assert.equal(j.employmentType, 'full time');
  assert.match(j.descriptionText, /Kubernetes/);
  assert.doesNotMatch(j.descriptionText, /<p>|&hellip;/, 'markup is stripped, entities decoded');
  assert.equal(j.source, 'bwi');
});

test('the source id is the posting id and the apply URL has no cHash', () => {
  // robots.txt disallows /*cHash, so a link pasted from the browser is the one
  // form of this page that must never be requested.
  const j = parsePosting(PAGE, { url: URL70418, postingId: '70418' });
  assert.equal(j.sourceId, 'bwi:70418');
  assert.doesNotMatch(j.applyUrl, /cHash|\?/);
  for (const r of parseSitemap(SITEMAP)) assert.doesNotMatch(r.url, /cHash/);
});

test('the advert arrives read, so the posting is never parked for a missing advert', () => {
  const j = parsePosting(PAGE, { url: URL70418, postingId: '70418' });
  assert.ok(j.descriptionText.length > 20);
  // Same reader the enrich step would use: the two must agree about the page.
  assert.ok(extractDescription(PAGE).text.includes('GitLab'));
});

test('a page with no JobPosting is reported null, not emitted half-empty', () => {
  assert.equal(parsePosting('<html><script type="application/ld+json">{"@type":"Organization"}</script></html>', {}), null);
  assert.equal(parsePosting('<html></html>', {}), null);
  assert.equal(parsePosting('<script type="application/ld+json">{broken</script>', {}), null);
});

test('ld+json as an @graph or an array is read too', () => {
  const g = `<script type="application/ld+json">${JSON.stringify({ '@graph': [{ '@type': 'WebSite' }, LD] })}</script>`;
  assert.equal(parsePosting(g, { postingId: '1' }).company, 'BWI GmbH');
  const a = `<script type="application/ld+json">${JSON.stringify([LD])}</script>`;
  assert.ok(parsePosting(a, { postingId: '1' }));
});

test('a single office given as an object, and a foreign one, are handled', () => {
  assert.equal(locationOf({ jobLocation: place('Ulm') }), 'Ulm, Germany');
  assert.equal(locationOf({ jobLocation: [place('Wien', 'AT')] }), 'Wien, AT');
  assert.equal(locationOf({}), '');
});

test('the source is registered, switchable and treated as an employer board', () => {
  assert.ok(SOURCES.bwi);
  assert.equal(readJson(p('config', 'sources.json')).bwi?.enabled, true);
  // An employer's own board holds postings for months; the aggregator age limit
  // would age live BWI roles out (see DEFAULT_AUTHORITATIVE in filter.js).
  assert.match(readFileSync(p('src', 'filter.js'), 'utf8'), /DEFAULT_AUTHORITATIVE = \[[^\]]*'bwi'/);
  assert.ok(__testables.MAX_DETAIL > 0);
});

const BODY = `<div class="jobDetailContent"><div class="jobDetailTop"><p>Als Digitalisierungspartner der Bundeswehr.</p></div>
<div class="jobDetailContact"><p>Kontakt: Erika Beispiel</p></div>
<div class="jobRow"><div class="jobBox jobTasks"><h2>Deine Aufgaben:</h2><ul><li>Pipelines mit GitLab CI</li></ul></div>
<div class="jobBox"><h2>Dein Profil:</h2><ul><li>Verhandlungssichere Deutschkenntnisse</li><li>Sicherheitsüberprüfung Ü2</li></ul></div></div>
<div class="jobBottomNavi">Zurück</div><footer>Impressum</footer></div>`;

test('the advert is the page body, not the two-sentence ld+json intro', () => {
  // The ld+json description is 199 characters on EVERY posting; German and
  // clearance requirements live only under Dein Profil in the body. Reading the
  // intro alone would make "no German requirement" a finding drawn from nothing.
  const a = __testables.advertOf(BODY);
  assert.match(a, /Deine Aufgaben/);
  assert.match(a, /Verhandlungssichere Deutschkenntnisse/);
  assert.match(a, /Ü2/);
  assert.doesNotMatch(a, /Erika Beispiel/, 'the recruiter contact is not advert text');
  assert.doesNotMatch(a, /Impressum|Zurück/, 'page furniture after the footer marker is not advert text');

  const page = `<script type="application/ld+json">${JSON.stringify(LD)}</script>${BODY}`;
  const j = parsePosting(page, { url: URL70418, postingId: '70418' });
  assert.match(j.descriptionText, /Verhandlungssichere/);
});

test('with no recognisable body the ld+json intro is still returned, not nothing', () => {
  assert.equal(__testables.advertOf('<html></html>'), '');
  const j = parsePosting(PAGE, { url: URL70418, postingId: '70418' });
  assert.match(j.descriptionText, /Kubernetes/);
});

test('fetchJobs: withdrawn postings (redirect to the listing) are counted, not parsed or warned one by one', async () => {
  const { fetchJobs } = await import('../src/sources/bwi.js');
  const real = globalThis.fetch;
  const live = 'https://www.bwi.de/karriere/stellenangebote/job/senior-ci-cd-platform-engineer-architect-m-w-d-70418';
  const gone = 'https://www.bwi.de/karriere/stellenangebote/job/senior-devops-engineer-m-w-d-69752';
  const requested = [];
  globalThis.fetch = async (url, opts = {}) => {
    requested.push(String(url));
    const u = String(url);
    const res = (body, init = {}) => new Response(body, { status: 200, ...init });
    if (u === 'https://www.bwi.de/sitemap.xml') return res(INDEX);
    if (u.includes('sitemap=jobs')) return res(`<urlset><url><loc>${live}</loc></url><url><loc>${gone}</loc></url></urlset>`);
    if (u === live) return res(PAGE);
    // The real site answers a withdrawn posting with a 302 to the listing.
    assert.equal(opts.redirect, 'manual', 'a posting page must be read without following redirects');
    return new Response(null, { status: 302, headers: { location: '/karriere/stellenangebote' } });
  };
  try {
    const r = await fetchJobs({ titleFilter: () => true, locationFilter: (o) => /Bonn/.test(o) });
    assert.equal(r.jobs.length, 1);
    assert.equal(r.jobs[0].sourceId, 'bwi:70418');
    assert.deepEqual(r.errors, ['1 posting(s) in the sitemap were withdrawn (redirected to the listing) — skipped']);
    // ANY office near enough keeps a multi-site role: the filter sees each office, not the joined string.
    const none = await fetchJobs({ titleFilter: () => true, locationFilter: (o) => /München/.test(o) });
    assert.equal(none.jobs.length, 0);
    // The cHash form of a page is the one robots.txt disallows; it is never requested.
    assert.ok(requested.every((u) => !/cHash=[0-9a-f]{32}/.test(u) || u.includes('sitemap=jobs')));
  } finally {
    globalThis.fetch = real;
  }
});
