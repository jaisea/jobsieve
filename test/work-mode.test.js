/**
 * What counts as a statement that the job is remote.
 *
 * Two postings were marked remote. Neither was, and they failed
 * differently — which is the point: "remote" is a common word, and this corpus
 * is German DevOps adverts, where it appears as a technical term, as a perk, and
 * as a hedge far more often than as a claim about the role.
 *
 * Every case below is from a real posting in the archive.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { detectWorkMode } from '../src/geo.js';

const mode = (text, loc = '') => detectWorkMode(text, loc);

/* ------------------------------------------------- "remote" the technical word */

test('Prometheus Remote Write is not a work mode', () => {
  // A Tech Lead posting listed "OTLP, Prometheus Remote Write, syslog" among
  // the protocols it works with, and came through remote. In a DevOps search
  // this is not an edge case — it is the vocabulary.
  assert.notEqual(mode('We handle OTLP, Prometheus Remote Write, syslog and OpenTelemetry.'), 'remote');
});

test('Terraform remote state is not a work mode', () => {
  assert.notEqual(mode('You will deal with state migrations, drift and broken remote states.'), 'remote');
});

test('the other technical uses go too', () => {
  for (const s of ['remote repository', 'remote branch', 'remote desktop support',
    'remote access gateway', 'remote host monitoring', 'remote API calls']) {
    assert.notEqual(mode(`Experience with ${s} is required.`), 'remote', s);
  }
});

/* --------------------------------------------------------- "remote" the perk */

test('a bare perk bullet is hybrid, not remote', () => {
  // Monitoring & Observability Engineer at Brunel, Kiel — 721km — scored 20/20
  // on location because of one line in a benefits list:
  //
  //   Individuelle Förderkonzepte und Weiterbildungen
  //   Remote Work                                       <- the only mention
  //   Zuschuss zum Jobticket
  //
  // Some remote is offered; the role has not been called remote. Hybrid is
  // still distance-gated, so Kiel drops either way.
  const brunel = [
    'Ihre Vorteile', 'Unbefristeter Arbeitsvertrag', '30 Tage Urlaub',
    'Individuelle Förderkonzepte und Weiterbildungen', 'Remote Work',
    'Zuschuss zum Jobticket', 'Corporate Benefits Programm',
  ].join('\n\n');
  assert.equal(mode(brunel), 'hybrid');
});

test('a home office budget is money, not a place', () => {
  assert.notEqual(mode('Benefits include a home office budget of 500 EUR.'), 'remote');
  assert.notEqual(mode('Wir bieten einen Homeoffice-Zuschuss.'), 'remote');
});

test('but the position of the mention is NOT the discriminator', () => {
  // Most genuinely remote jobs also state it under a benefits heading. Judging
  // by section rather than by phrase was tried and dropped: of 27 remote jobs
  // whose only mention sat below a "Vorteile"/"Benefits" heading, most said
  // "100% remote role" or "Fully Remote" there.
  const underHeading = 'Ihre Vorteile\n\n30 Tage Urlaub\n\n100% Remote\n\nJobticket';
  assert.equal(mode(underHeading), 'remote');
});

/* ------------------------------------------------------- German, which was absent */

test('German hedges are hedges', () => {
  // These were missing entirely. Every "Homeoffice möglich" in a German advert
  // read as a fully remote role — in a German job search.
  for (const s of [
    'Wir bieten Ihnen die Möglichkeit auf Homeoffice.',
    'Homeoffice möglich nach Absprache.',
    'Teilweise Homeoffice und flexible Arbeitszeiten.',
    'Option auf mobiles Arbeiten.',
    'Gelegentlich Homeoffice.',
  ]) {
    assert.equal(mode(s), 'hybrid', s);
  }
});

test('German statements that the role IS remote still win', () => {
  for (const s of [
    'Diese Position kann zu 100 % aus dem Homeoffice ausgeübt werden.',
    'Die Stelle ist vollständig remote.',
    'Komplett im Homeoffice möglich.',
  ]) {
    assert.equal(mode(s), 'remote', s);
  }
});

test('"full remote" is as strong as "fully remote"', () => {
  // The strong list had "fully remote" and not "full remote", so a Senior
  // DevOps Engineer whose TITLE read "(Full Remote)" was not remote and was
  // dropped at 639km. German adverts write it both ways, and "full remote
  // möglich" is a claim about the role rather than a hedge — so the strong
  // match has to beat the "möglich" hedge, which is why order matters here.
  assert.equal(mode('Cloud Infrastructure Engineer (m/w/d) – full remote möglich'), 'remote');
  assert.equal(mode('Senior DevOps Engineer (Full Remote)'), 'remote');
});

/* ------------------------------------------------------------------ unchanged */

test('the English hedge that started all this still hedges', () => {
  // "we also offer you the possibility of home office" made a Hannover posting
  // remote, which then earned full location points at 505km.
  assert.equal(mode('We also offer you the possibility of home office or temporary work from abroad.'), 'hybrid');
});

test('an explicit onsite statement is still onsite', () => {
  assert.equal(mode('Die Tätigkeit erfolgt vor Ort in Kiel.'), 'onsite');
});

test('remote in the location field still counts', () => {
  assert.equal(mode('A normal job description with no work mode statement.', 'Remote, Germany'), 'remote');
});

/* ------------------------------------ German perk boilerplate, from the corpus */

/**
 * A third false remote — an HPC Systems Engineer at Tübingen, 107km — on this:
 *
 *   "Flexible Arbeitszeiten und die Möglichkeit, teilweise im Homeoffice zu arbeiten"
 *
 * Patching one phrasing at a time was not working: this was the third posting
 * that had to be flagged by hand. So the sentences below were pulled out of the
 * archive first — every German line in a posting the detector called remote —
 * sorted by hand, and the rules written to fit all of them at once.
 */

test('German perk boilerplate is a benefit, not a work mode', () => {
  // "Flexible Arbeitszeiten und Homeoffice" is standard in German adverts and
  // was reading as fully remote on postings 400km away. Either order, with or
  // without the conjunction surviving slug().
  for (const s of [
    'Flexible Arbeitszeiten und die Möglichkeit, teilweise im Homeoffice zu arbeiten',
    'BENEFITS Flexible Arbeitszeiten & Homeoffice: individuelle Lösungen',
    'bieten wir all unseren Kollegen flexible Arbeitszeiten und Home Office an',
    'Home Office und flexible Arbeitszeiten geben Dir außerdem die Chance',
    'Die Position bietet durch flexibles, mobiles Arbeiten moderne Arbeitsbedingungen',
    'Persönliche Arbeitsgestaltung, Home Office, Arbeitszeiten stehen dem Mitarbeiter frei',
  ]) {
    assert.equal(mode(s), 'hybrid', s.slice(0, 60));
  }
});

test('the qualifier and the noun are rarely adjacent in German', () => {
  // "Möglichkeit, teilweise im Homeoffice zu arbeiten" — a comma and an "im"
  // sit between them, so an adjacency rule misses it entirely.
  assert.equal(mode('die Möglichkeit, teilweise im Homeoffice zu arbeiten'), 'hybrid');
  assert.equal(mode('Teilweise im Homeoffice'), 'hybrid');
});

test('"remote" describing someone else, or a thing, is not a work mode', () => {
  for (const s of [
    'Du sorgst dafür, dass unsere Mitarbeitenden – remote wie vor Ort – arbeiten können',
    'Offene Persönlichkeit und ein Teamplayer, trotz Remote-Arbeit',
    'Technische Ausstattung für mobiles Arbeiten',
    'jährlich bis zu 4 Wochen Workation – mobiles Arbeiten aus dem europäischen Ausland',
  ]) {
    assert.notEqual(mode(s), 'remote', s.slice(0, 60));
  }
});

test('German statements that the role IS remote survive all of that', () => {
  for (const s of [
    'Diese Position kann zu 100 % aus dem Homeoffice ausgeübt werden',
    '100 % Remote bei iits-consulting GmbH',
    'Die Position ist ab sofort, remote aus ganz Deutschland verfügbar',
    'Als Remote-first-Unternehmen ermöglichen wir, von überall aus zu arbeiten',
    'Homeoffice zu 100% möglich',
    'attraktive Homeoffice-Optionen (bis zu 100%)',
  ]) {
    assert.equal(mode(s), 'remote', s.slice(0, 60));
  }
});

/* ----------------------------------------------- the title is a headline claim */

test('remote in the TITLE outranks perk language in the body', () => {
  // "Remote Cloud Software Engineer (m/w/d)" was demoted to hybrid because the
  // same advert also offered "flexible Arbeitszeiten und Homeoffice" further
  // down. The title is the employer's own claim about the role; a benefits list
  // is not, and it must not outvote it.
  const perkBody = 'Wir bieten flexible Arbeitszeiten und Homeoffice sowie 30 Tage Urlaub.';
  for (const title of [
    'Remote Cloud Software Engineer (m/w/d) Azure',
    'DevOps Engineer (m/w/d) 100% Remote',
    'Senior DevOps Engineer (Full Remote)',
  ]) {
    assert.equal(detectWorkMode(`${title} ${perkBody}`, '', title), 'remote', title);
  }
});

test('but an onsite headline still wins', () => {
  assert.notEqual(
    detectWorkMode('Remote support duties', 'Berlin', 'Systems Engineer – vor Ort in Berlin'),
    'remote',
  );
});

/* --------------------------------------------------------- a known limitation */

test('one real sentence stays ambiguous, and that is recorded rather than forced', () => {
  // "Ansprechpartner und Berater für die DevOps-Kolleg:innen der Kunden (remote)"
  // — the "(remote)" could qualify the role or the colleagues. A human cannot
  // tell either. A rule narrow enough to catch it would be fitted to one
  // sentence, so it is left alone and noted here instead.
  const s = 'Ansprechpartner und Berater für die DevOps-Kolleg:innen der Kunden (remote)';
  assert.equal(mode(s), 'remote', 'currently reads as remote — accepted, not endorsed');
});
