/**
 * A block holds more than three kinds of line, so reading it positionally is
 * only safe once the lines that are not fields have been removed.
 *
 * `extractTextBlocks` collects the lines before each apply link and reads them
 * by count: three is title/company/location, two is title/location. That is
 * right for the shape it was written against and wrong for three others, and
 * every eFinancialCareers and Indeed defect on file is one of them.
 *
 * Measured over 40 days of live mail, 279 postings: 40 were wrong before,
 * 0 after, and no posting lost a value it already had.
 *
 *   21  Indeed glued company and city    "greenventory GmbH - München"
 *   16  a section heading became the title, shifting the rest down one
 *   14  furniture filed as the location  "Schnellbewerbung", a salary
 *    3  the whole advert filed as the location (7,163 characters of it)
 *
 * The fourth fault was not visible in any field. Indeed's links are tracking
 * redirects, /rc/clk/dl and /pagead/clk/dl, and sourceId stripped the query —
 * so all 21 postings shared one of TWO ids.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { __testables } from '../src/sources/mailalerts.js';
import { normaliseSourceId } from '../src/store.js';

const { extractJobs, pickParser } = __testables;

const efc = pickParser('emails@efinancialcareers.de');
const indeed = pickParser('donotreply@jobalert.indeed.com');
const run = (parser, lines) =>
  extractJobs(parser, { html: '', text: lines.join('\n'), subject: 'x', date: null });

/* ------------------------------------------------- a heading is not a title */

test('a section heading does not become the first card’s title', () => {
  // The heading sits in the same block as the card beneath it, so the block was
  // four lines and the positional read took the first three. 16 postings
  // recorded their title as "Jobs ähnlich Ihrer letzten Aktivitäten" with the
  // real title in the company field and the company in the location field.
  // Only the FIRST card of each digest is affected, which is why it looked rare.
  for (const heading of [
    'Jobs ähnlich Ihrer letzten Aktivitäten',
    'Empfohlen basierend auf Ihren Aktivitäten',
    'Die neuesten Stellenangebote basierend auf Ihren Aktivitäten',
  ]) {
    const [job] = run(efc, [
      heading,
      '',
      'DevOps Engineer (Platform & Cloud) (w/m/d)',
      'Spendit AG',
      'Munich, Germany',
      'Hybrid',
      'Competitive',
      '',
      'Jetzt bewerben: https://www.efinancialcareers.de/jobs-Deutschland-Munich-DevOps.id111',
    ]);
    assert.equal(job.title, 'DevOps Engineer (Platform & Cloud) (w/m/d)', heading);
    assert.equal(job.company, 'Spendit AG');
    assert.equal(job.location, 'Munich, Germany');
  }
});

/* ------------------------------------------------ a description is not a field */

test('the advert is captured, not filed as the location', () => {
  // The single-job template puts the whole posting in the block. After
  // BLOCK_NOISE removed "Festanstellung" and "Competitive" the block was three
  // lines — title|company, location, advert — so it looked exactly like
  // title/company/location and the advert became the location. One record held
  // 7,163 characters there.
  const advert = 'At Broadridge, we&apos;ve built a culture where the highest goal is to '
    + 'empower others to accomplish more. <br /> <br /> Responsibilities include Linux, '
    + 'Terraform and Kubernetes across cloud and on-prem environments.';

  const [job] = run(efc, [
    'Lead DevOps Engineer | Broadridge Trading & Connectivity Solutions',
    'London, United Kingdom',
    '',
    'Festanstellung',
    'Competitive',
    '',
    advert,
    '',
    'Jetzt bewerben: https://www.efinancialcareers.de/jobs-UK-London-Lead_DevOps_Engineer.id246',
  ]);

  assert.equal(job.title, 'Lead DevOps Engineer');
  assert.equal(job.company, 'Broadridge Trading & Connectivity Solutions',
    'the pipe carries the company when the block is two lines');
  assert.equal(job.location, 'London, United Kingdom');

  // And the prose is not discarded — it is the advert, and for this sender it
  // is the whole one. 95% of eFinancialCareers postings arrive without a
  // description otherwise.
  assert.ok(job.descriptionText.includes('empower others'), 'the advert is kept');
  assert.ok(!/<br|&apos;/.test(job.descriptionText), 'and decoded on the way in');
  assert.ok(!job.location.includes('Broadridge'), 'the location is a place');
});

test('a long TITLE is never mistaken for prose', () => {
  // The trap that decides where the prose threshold can sit. A real
  // eFinancialCareers title runs to 109 characters while the shortest Indeed
  // teaser is 119 — there is no length that separates them. Position does: the
  // title is always the first line of a block, so prose is only looked for
  // after it.
  const longTitle = 'Lead Architect / Senior Technology Lead - Cloud, AI, & DevOps '
    + 'Engineering for Capital Markets Technology';
  assert.ok(longTitle.length > 100, 'this test is pointless if the title is short');

  const [job] = run(efc, [
    longTitle,
    'State Street Corporation',
    'Hyderabad, India',
    '',
    'Jetzt bewerben: https://www.efinancialcareers.de/jobs-India-Lead_Architect.id222',
  ]);
  assert.equal(job.title, longTitle);
  assert.equal(job.company, 'State Street Corporation');
  assert.equal(job.location, 'Hyderabad, India');
});

/* ---------------------------------------------------------------- Indeed */

const indeedMail = (company, extra = []) => [
  'Indeed Job Alert',
  '1 Cloud Engineer Job in München, Baden-Württemberg',
  '',
  'Jobs 1-1 of 1 new job',
  'See matching results on Indeed: https://de.indeed.com/jobs?q=Cloud+Engineer',
  '',
  'Junior Cloud & Platform Engineer (m/w/d)',
  company,
  ...extra,
  'https://de.indeed.com/rc/clk/dl?jk=972a1f1b718af165&from=ja&tk=abc',
];

test('Indeed’s "Company - City" line is split, not stored whole', () => {
  const [job] = run(indeed, indeedMail('Hectronic GmbH - Bonndorf im Schwarzwald'));
  assert.equal(job.company, 'Hectronic GmbH - Bonndorf im Schwarzwald'.split(' - ')[0]);
  assert.equal(job.location, 'Bonndorf im Schwarzwald');
});

test('only the LAST spaced hyphen splits, and an unspaced one never does', () => {
  // "s.Oliver Bernd Freier GmbH & Co. KG - Rottendorf" must keep its company
  // whole, and "DRK-Blutspendedienst" must not be touched at all.
  const [a] = run(indeed, indeedMail('s.Oliver Bernd Freier GmbH & Co. KG - Rottendorf'));
  assert.equal(a.company, 's.Oliver Bernd Freier GmbH & Co. KG');
  assert.equal(a.location, 'Rottendorf');

  const [b] = run(indeed, indeedMail('DRK-Blutspendedienst Baden-Württemberg'));
  assert.equal(b.company, 'DRK-Blutspendedienst Baden-Württemberg');
  assert.equal(b.location, '');
});

test('an apply badge, a relative date and a teaser are none of them fields', () => {
  // All four reached the location field on real postings.
  const [job] = run(indeed, indeedMail('greenventory GmbH - München', [
    'Schnellbewerbung',
    'We are looking for a Working Student in Cloud & DevOps to support our team in '
      + 'building, maintaining and improving our infrastructure across Azure and Kubernetes.',
    'Vor 6 Tagen',
  ]));
  assert.equal(job.company, 'greenventory GmbH');
  assert.equal(job.location, 'München');
  assert.ok(job.descriptionText.includes('Working Student'), 'the teaser is the advert');
});

test('a salary is not a location', () => {
  const [job] = run(indeed, indeedMail('BTC Gruppe - Oldenburg', ['60.000 € – 80.000 € pro Jahr']));
  assert.equal(job.company, 'BTC Gruppe');
  assert.equal(job.location, 'Oldenburg');
});

/* ------------------------------------------------------------- identity */

test('two Indeed postings never share a sourceId', () => {
  // The fault with no visible symptom. Both link shapes are tracking
  // redirects, and sourceId stripped the query, so all 21 postings on file
  // shared one of two ids. reconcile() treats a known id under an unknown
  // fingerprint as the same posting MOVING, so the next new Indeed job would
  // have been absorbed into an old one's identity and inherited its status.
  const jk = (k) => run(indeed, [
    'Cloud Engineer', 'ACME GmbH - München',
    `https://de.indeed.com/rc/clk/dl?jk=${k}&from=ja&tk=fresh-every-email`,
  ])[0];

  const a = jk('972a1f1b718af165');
  const b = jk('05519a40c08ac2a4');
  assert.notEqual(a.sourceId, b.sourceId);

  // And they must still differ AFTER normalisation, which strips the query —
  // so the job key cannot live in one. "…/viewjob?jk=abc" would collapse back
  // to "…/viewjob" and collide exactly as the tracking links did.
  assert.notEqual(normaliseSourceId(`mailalerts:${a.sourceId}`),
    normaliseSourceId(`mailalerts:${b.sourceId}`));
  assert.match(a.sourceId, /^indeed:972a1f1b718af165$/);
});

test('the same posting in two emails keeps one id', () => {
  // The other half: the tracking parameters change in every email, so the id
  // has to survive that or the posting is new every day.
  const one = run(indeed, ['Cloud Engineer', 'ACME GmbH - München',
    'https://de.indeed.com/rc/clk/dl?jk=972a1f1b718af165&tk=aaa&alid=1'])[0];
  const two = run(indeed, ['Cloud Engineer', 'ACME GmbH - München',
    'https://de.indeed.com/rc/clk/dl?jk=972a1f1b718af165&tk=zzz&alid=9'])[0];
  assert.equal(one.sourceId, two.sourceId);
});

test('a sponsored posting gets NO id rather than a shared one', () => {
  // /pagead/clk/dl carries no jk. Inventing one from the tracking blob would be
  // a guess, and a wrong id is worse than none — no id simply means reconcile's
  // second opinion does not apply and the fingerprint decides, as it does for
  // every posting.
  const [job] = run(indeed, ['Cloud Engineer', 'ACME GmbH - München',
    'https://de.indeed.com/pagead/clk/dl?mo=r&ad=LONGBLOB&plid=1']);
  assert.equal(job.sourceId, '');
});

test('an id that is only a source prefix is not indexable', () => {
  // The guard that makes "no id" actually mean no id. `${source}:${sourceId}`
  // with an empty sourceId gives "mailalerts:", which is a perfectly good map
  // key — and every id-less posting would have shared it, rebuilding the exact
  // collision one level up.
  assert.equal(normaliseSourceId('mailalerts:'), '');
  assert.equal(normaliseSourceId('mailalerts:   '), '');
  assert.equal(normaliseSourceId(''), '');
  assert.notEqual(normaliseSourceId('mailalerts:indeed:abc'), '');
});

/* --------------------------------------------------- the shape still holds */

test('the ordinary three-line card is unchanged', () => {
  // Everything above is a correction to an edge case. 229 of 249
  // eFinancialCareers postings parsed correctly before and must still.
  const [job] = run(efc, [
    'DevOps Engineer m/w/d',
    'PACE Mobility GmbH',
    'Karlsruhe, Germany',
    'Hybrid',
    'Competitive',
    '',
    'Jetzt bewerben: https://www.efinancialcareers.de/jobs-Deutschland-Karlsruhe-DevOps.id247',
  ]);
  assert.equal(job.title, 'DevOps Engineer m/w/d');
  assert.equal(job.company, 'PACE Mobility GmbH');
  assert.equal(job.location, 'Karlsruhe, Germany');
  assert.equal(job.descriptionText, '', 'and no advert was invented for it');
});
