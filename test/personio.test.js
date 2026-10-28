/**
 * Personio — the German mid-market ATS.
 *
 * Three watchlist companies were blocked on this, recorded
 * `supported: false` with a note that a public XML feed exists. Nothing read
 * it. Reading it returns 27 postings across the three tenants, **11 of them
 * within 70km**, including an AI Platform Engineer in the home city — which
 * is the most valuable shape of find this project has.
 *
 * career-ops' guide says Personio has *"no stable public JSON API — treat as
 * Level 2/3 (render or search)"*. There is no JSON API; there is an XML one.
 * Fourth time a "this needs a browser" claim has been false here.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { p, readJson } from '../src/util.js';
import { normalize } from '../src/normalize.js';
import { parseFeed, __testables } from '../src/sources/personio.js';

const { feedUrl, jobUrl, tag, locationOf, employmentOf, salaryOf } = __testables;
const profile = readJson(p('config', 'examples', 'devops.profile.json'));

/** Shaped from the real Jedox feed, entities and all. */
const FEED = `<?xml version="1.0"?><workzag-jobs>
<position>
  <id>2700696</id>
  <subcompany>Jedox GmbH</subcompany>
  <office>Germany remote</office>
  <additionalOffices><office>Hamburg</office><office>München</office></additionalOffices>
  <department>Technology, Innovation &amp; Cloud Excellence</department>
  <name>Product Manager – Platform Experience &amp; Cloud Administration (m/f/d)</name>
  <jobDescriptions></jobDescriptions>
  <employmentType>permanent</employmentType>
  <schedule>full-time</schedule>
  <createdAt>2026-07-06T15:07:49+00:00</createdAt>
</position>
<position>
  <id>2700697</id>
  <subcompany>Jedox GmbH</subcompany>
  <office>München</office>
  <name>Data Engineer (m/f/d)</name>
  <jobDescriptions>
    <jobDescription><name>Deine Aufgaben</name><value><![CDATA[<p>Du betreibst <strong>Kubernetes</strong>.</p>]]></value></jobDescription>
    <jobDescription><name>Dein Profil</name><value><![CDATA[<ul><li>Verhandlungssichere Deutschkenntnisse</li></ul>]]></value></jobDescription>
  </jobDescriptions>
  <employmentType>permanent</employmentType>
  <schedule>part-time</schedule>
  <salaryInformation><min>70000</min><max>90000</max><currencySymbol>€</currencySymbol></salaryInformation>
  <createdAt>2026-08-01T09:00:00+00:00</createdAt>
</position>
</workzag-jobs>`;

const parsed = () => parseFeed(FEED, { slug: 'jedox', tld: 'de', name: 'Jedox' });

test('an XML entity never reaches the title, because the title is the identity', () => {
  // A real posting came through as "Platform Experience &amp; Cloud
  // Administration". The title feeds the FINGERPRINT, so an undecoded entity
  // gives the posting a false identity that can never merge with the same role
  // from another source.
  //
  // Third time this exact bug: LinkedIn's &middot;, careersites' og:title, now
  // this. Every time the fix was to route the field through stripHtml.
  const [a] = parsed();
  assert.equal(a.title, 'Product Manager – Platform Experience & Cloud Administration (m/f/d)');
  assert.ok(!/&(amp|lt|gt|quot|#\d+);/.test(a.title + a.company + a.location));
});

test('the apply URL is constructed, because the feed carries none', () => {
  // There is no <url>, <link> or <permalink> anywhere in the document. The id
  // plus the tenant host is the whole address, and /job/{id} was verified to
  // answer 200 with a JobPosting ld+json.
  assert.ok(!/<(url|link|permalink)>/i.test(FEED), 'the fixture matches the real feed: no link field');
  assert.equal(jobUrl('jedox', 'de', '2700696'), 'https://jedox.jobs.personio.de/job/2700696');
  assert.equal(jobUrl('basilea', 'com', '9'), 'https://basilea.jobs.personio.com/job/9');
  assert.equal(feedUrl('jedox'), 'https://jedox.jobs.personio.de/xml', 'de is the default tld');

  // index.js drops any posting without one, so this is load-bearing.
  for (const j of parsed()) assert.match(j.applyUrl, /^https:\/\/jedox\.jobs\.personio\.de\/job\/\d+$/);
});

test('most postings arrive with no advert, and that is fine', () => {
  // Only 3 of Jedox's 18 fill <jobDescriptions>. The job page carries ld+json
  // with the full text, which enrich.js already reads — the feed supplies the
  // listing, the existing enrich step supplies the advert. No new reader.
  const [empty, full] = parsed();
  assert.equal(empty.descriptionText, '');
  assert.ok(full.descriptionText.length > 20);

  // Headings are kept with their section, because a German advert puts the
  // language requirement under one and the gate reads whole lines.
  assert.match(full.descriptionText, /Deine Aufgaben/);
  assert.match(full.descriptionText, /Verhandlungssichere Deutschkenntnisse/);
  assert.ok(!/<p>|<li>|<strong>/.test(full.descriptionText), 'markup is stripped');
});

test('every office is carried, because the tail is where the home city hides', () => {
  // Jedox's first record reads office "Germany remote" with Frankfurt and
  // München as additional offices. Taking only the main office
  // loses the one mention of the candidate's own city.
  const [a] = parsed();
  assert.equal(a.location, 'Germany remote, Hamburg, München');

  const n = normalize(a, profile);
  assert.equal(n.distanceKm, 0, 'and it resolves to the home city');
});

test('both employment axes survive, because only one of them is the gate', () => {
  // employmentType is permanent-vs-intern; schedule is full-vs-part-time, and
  // the part-time gate reads the second. Passing one would lose the other.
  const [a, b] = parsed();
  assert.equal(a.employmentType, 'permanent full-time');
  assert.equal(b.employmentType, 'permanent part-time');
  assert.equal(employmentOf('<employmentType>permanent</employmentType>'), 'permanent');
  assert.equal(employmentOf('<x>y</x>'), null, 'and absent stays absent');
});

test('salary is read when the employer published it', () => {
  assert.equal(parsed()[1].salary, '70000–90000 €');
  assert.equal(salaryOf('<salaryInformation></salaryInformation>'), null);
  assert.equal(salaryOf('<nothing/>'), null);
});

test('a malformed feed yields nothing rather than junk', () => {
  // The worst failure shape in this project is an EMPTY advert read as a
  // finding — "no German requirement" drawn from nothing. A position with no
  // id or no title is skipped outright.
  assert.deepEqual(parseFeed('<position><id>1</id></position>', { slug: 'x' }), []);
  assert.deepEqual(parseFeed('<position><name>No id</name></position>', { slug: 'x' }), []);
  assert.deepEqual(parseFeed('not xml at all', { slug: 'x' }), []);
  assert.deepEqual(parseFeed('', { slug: 'x' }), []);
});

test('CDATA is unwrapped wherever it appears', () => {
  assert.equal(tag('<name><![CDATA[Senior Engineer]]></name>', 'name'), 'Senior Engineer');
  assert.equal(tag('<name>Plain</name>', 'name'), 'Plain');
  assert.equal(tag('<other>x</other>', 'name'), '');
});

test('the configured tenants are the three the watchlist was blocked on', () => {
  const boards = readJson(p('config', 'companies.json')).personio || [];
  const slugs = boards.map((b) => b.slug);
  for (const want of ['jedox', 'solvares', 'basilea']) {
    assert.ok(slugs.includes(want), `${want} was recorded supported:false pending this source`);
  }
  // The tld differs per tenant and is a fact, not a guess made at runtime.
  for (const b of boards) assert.match(b.tld || 'de', /^(de|com)$/);
});

/**
 * Teamtailor — the same problem as Personio, and the reason it is a module.
 *
 * It was nearly added to the ATS table beside BambooHR and Breezy. Every
 * entry there is fetched through `httpJson()`, so an RSS url would parse as
 * JSON, fail, and report the same "unexpected shape" a dead board does. A
 * platform that publishes XML needs its own reader.
 *
 * Unlike the other two speculative providers this one is VERIFIED, against
 * Teamtailor's own board (it runs on Teamtailor): 17 items, and all 17 carry
 * the whole advert — so these arrive read and skip the enrich step entirely.
 */
test('Teamtailor is a module, not a row in the ATS table', async () => {
  const { ATS } = await import('../src/sources/ats.js');
  assert.ok(!ATS.teamtailor, 'an RSS feed in the JSON table fails like a dead board');
  const { SOURCES } = await import('../src/sources/index.js');
  assert.ok(SOURCES.teamtailor, 'it belongs in SOURCES instead');
});

test('a Teamtailor item carries the whole advert, locations and a remote hint', async () => {
  const { parseFeed, __testables } = await import('../src/sources/teamtailor.js');
  const feed = `<rss><channel><item>
    <title>Senior Platform Engineer &amp; SRE</title>
    <description>&lt;h4&gt;Role&lt;/h4&gt;&lt;p&gt;You run &lt;strong&gt;Kubernetes&lt;/strong&gt;.&lt;/p&gt;</description>
    <pubDate>Mon, 01 Sep 2026 09:00:00 +0000</pubDate>
    <link>https://career.teamtailor.com/jobs/1234</link>
    <remoteStatus>fully</remoteStatus>
    <guid>1234</guid>
    <tt:locations><tt:location><tt:city>Berlin</tt:city><tt:country>Germany</tt:country></tt:location>
    <tt:location><tt:city>Stockholm</tt:city><tt:country>Sweden</tt:country></tt:location></tt:locations>
  </item></channel></rss>`;

  const [j] = parseFeed(feed, { slug: 'career', name: 'Teamtailor' });
  assert.equal(j.title, 'Senior Platform Engineer & SRE', 'the entity is decoded — the title is the identity');
  assert.equal(j.applyUrl, 'https://career.teamtailor.com/jobs/1234');
  assert.equal(j.sourceId, 'teamtailor:career:1234');
  assert.equal(j.location, 'Berlin, Germany · Stockholm, Sweden', 'every office, because the tail anchors it');
  assert.match(j.descriptionText, /You run Kubernetes/);
  assert.ok(!/<p>|<strong>|&lt;/.test(j.descriptionText), 'escaped markup is decoded then stripped');

  // The remote tag is narrow on purpose: anything not clearly fully remote
  // returns undefined rather than a guess.
  const { workModeOf } = __testables;
  assert.equal(workModeOf('<remoteStatus>fully</remoteStatus>'), 'remote');
  assert.equal(workModeOf('<remoteStatus>hybrid</remoteStatus>'), undefined);
  assert.equal(workModeOf('<remoteStatus>temporary</remoteStatus>'), undefined);
  assert.equal(workModeOf('<remoteStatus></remoteStatus>'), undefined, 'empty is not evidence');
});

test('a Teamtailor item with no link is dropped, not emitted', async () => {
  const { parseFeed } = await import('../src/sources/teamtailor.js');
  assert.deepEqual(parseFeed('<item><title>No link</title></item>', { slug: 'x' }), []);
  assert.deepEqual(parseFeed('<item><link>https://x.test/1</link></item>', { slug: 'x' }), []);
  assert.deepEqual(parseFeed('', { slug: 'x' }), []);
});
