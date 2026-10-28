/**
 * A strong claim beats the word "hybrid", and "hybrid cloud" is not a work mode.
 *
 * Two faults, found by reading the adverts behind postings that had been
 * rejected by hand.
 *
 * 1. THE ORDER. The hybrid literal was tested before `strong` and returned
 *    immediately, so an advert offering both came out hybrid:
 *
 *      "Ort: Hybrid oder 100% Remote"
 *      "Hybrid und Full Remote Modell"
 *      "Remote-first approach with the option for hybrid work from our office"
 *
 *    Hybrid is gated exactly like onsite — `filter.js` says "onsite / hybrid /
 *    unknown -> must be commutable" — so a "Senior DevOps Engineer (Full
 *    Remote)" 639km away was dropped on distance. This is the same rule already
 *    written down for the hedge list, where "full remote möglich" must beat the
 *    hedge word it contains; it had simply never been applied to `hybrid`.
 *
 * 2. GERMAN INFLECTS ITS ADJECTIVES. `\bhybrid\b` cannot match "Hybrides
 *    Arbeitsmodell" — about as explicit as an advert gets — so the detector had
 *    no opinion and the source's guess stood.
 *
 * Widening for the endings then exposed a trap the English spelling had carried
 * all along: a HYBRID CLOUD is the commonest thing an infrastructure advert
 * discusses, and this corpus is nothing but infrastructure adverts. "Sie bringen
 * sie in eine hybride Cloud-/On-Prem-Infrastruktur ein" says nothing about where
 * anyone sits. TECHNICAL_HYBRID strips those first, exactly as TECHNICAL_REMOTE
 * does for "Remote Write".
 *
 * Measured over 4,616 read adverts: 12 postings become remote and stop being
 * dropped on distance, 17 false hybrids from "hybrid cloud" disappear, 2 are
 * correctly demoted, and nothing applied to is harmed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { detectWorkMode } from '../src/geo.js';

const mode = (text) => detectWorkMode(text, '', 'DevOps Engineer');

test('a full-remote claim beats the word hybrid in the same advert', () => {
  for (const advert of [
    'Ort : Hybrid oder 100% Remote I Beginn : ab sofort I Umfang : Vollzeit',
    'Weiterbildungen. Hybrid und Full Remote Modell. PC Ausstattung.',
    'Remote-first approach with the option for hybrid work from our office',
    'Diese Position kann vor Ort, hybrid oder vollstaendig remote besetzt werden.',
    'Wir bieten Full Remote Option, mit der Option das HQ zu besuchen, falls gewuenscht',
  ]) {
    assert.equal(mode(advert), 'remote', advert.slice(0, 50));
  }
});

test('hybrid still wins when that is all the advert offers', () => {
  // The fix must not turn every hybrid posting remote.
  for (const advert of [
    'Lead Cloud System Engineer (m/w/d), hybrides Arbeiten. In Festanstellung, Vollzeit.',
    'Gepaart mit einem hybriden Arbeitskonzept - remote, vor Ort beim Kunden und im Buero.',
    'Benefits: Hybrides Arbeitsmodell. Flexible Arbeitszeiten durch Vertrauensarbeitszeit.',
    'We work hybrid, with 2 days in the office each week.',
  ]) {
    assert.equal(mode(advert), 'hybrid', advert.slice(0, 50));
  }
});

test('German adjective endings are matched', () => {
  // The whole reason "Hybrides Arbeitsmodell" was invisible.
  for (const ending of ['hybrid', 'hybride', 'hybrides', 'hybrider', 'hybriden', 'hybridem']) {
    assert.equal(mode(`Wir bieten ${ending} Arbeiten in unserem Team.`), 'hybrid', ending);
  }
});

test('a hybrid CLOUD is not a work mode', () => {
  // The trap the widening exposed, and which the English spelling always had.
  // 17 postings were classified hybrid on this alone.
  for (const advert of [
    'Sie evaluieren neue Technologien und bringen sie in eine hybride Cloud-/On-Prem-Infrastruktur ein.',
    'You will design and operate our hybrid cloud environment across AWS and on-prem.',
    'Betrieb einer hybriden Infrastruktur mit Kubernetes und VMware.',
    'Erfahrung mit hybriden Cloud-Architekturen und Netzwerken.',
  ]) {
    assert.notEqual(mode(advert), 'hybrid', advert.slice(0, 56));
  }
});

test('an advert can discuss a hybrid cloud AND be a hybrid job', () => {
  // Stripping the technical phrase must not blind the detector to the real one.
  assert.equal(
    mode('Wir betreiben eine hybride Cloud-Infrastruktur. Wir bieten hybrides Arbeiten mit zwei Buerotagen.'),
    'hybrid');
});

/* ------------------------------------------------- what must NOT be caught */

test('flexible working TIME is not flexible working PLACE', () => {
  // Five of the postings that led to this change say only this, and they are
  // correctly onsite. "Gleitzeit" is about WHEN, not WHERE — treating it as a
  // work-mode signal would have been the easy, wrong widening.
  for (const advert of [
    'Gleitzeitmodell zur flexiblen Arbeitszeitgestaltung. Einladendes Betriebsrestaurant.',
    'Flexible working hours and attractive employee benefits. A motivated team.',
    'Flexible Arbeitszeitgestaltung durch Gleitzeitregelungen und Teilzeitmoeglichkeiten.',
    'Gesunde Work-Life Balance mit vollem Ueberstundenausgleich und Gleitzeit.',
  ]) {
    assert.notEqual(mode(advert), 'hybrid', advert.slice(0, 50));
    assert.notEqual(mode(advert), 'remote', advert.slice(0, 50));
  }
});

test('a bare "Mobiles Arbeiten" is deliberately left alone', () => {
  // It reads like an obvious gap and measuring said otherwise: adding it as a
  // hedge re-labelled 23 postings — which changes nothing anyone sees, because
  // hybrid is gated like onsite — and demoted 17 from remote, of which 13 sit
  // beyond the radius and would have been DROPPED. One was an application
  // already sent, 287km away. All the upside was cosmetic; all the downside was real.
  const advert = 'Deine Vorteile: Mobiles Arbeiten fuer mehr Flexibilitaet und Work-Life-Balance. '
    + 'Wir arbeiten viel remote und treffen uns gelegentlich im Buero.';
  assert.equal(mode(advert), 'remote',
    'the catch-all still calls this remote, and the application says it is right');
});

test('a technical remote is still not a work mode', () => {
  assert.notEqual(mode('Betreuung lokaler Systeme sowie externer Remote-Server und Proxmox.'), 'remote');
});
