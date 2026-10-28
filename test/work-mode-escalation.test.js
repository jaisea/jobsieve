/**
 * When the rules cannot settle where the work happens, ask — the same escape
 * hatch German has, for the same reason.
 *
 * Two postings were pulled back out of the reject pile by hand. Both were
 * dropped on DISTANCE and both are remote:
 *
 *   608e9d40  Dedalus, Bonn 309km   "in Deutschland (100% im Homeoffice möglich)"
 *   e5bca332  DL Remote, Berlin 639km
 *             "die Möglichkeit, zu fast 100% im Homeoffice zu arbeiten"
 *
 * Each says full-time home office and each was read as `hybrid`, because a
 * hedge word (möglich / Möglichkeit) sits beside the claim and the strong list
 * wanted "100% homeoffice" with nothing in between. `slug()` gives
 * "100 im homeoffice".
 *
 * The instruction: "take that line with the word 'home office' and ask the LLM
 * if it is a remote job. I don't want to miss any potential job opportunity due
 * to a strict set of regexes that we use to gate posts."
 *
 * So two changes, and the second is the one that generalises. `strongPercent`
 * reads a percentage claim through an intervening preposition — it fixes the
 * phrasings already seen. The ESCALATION covers the next phrasing nobody has
 * seen yet: when the advert plainly discusses where the work happens and the
 * rules are about to throw the posting away on distance, the lines go to the
 * model instead of into the bin.
 *
 * Cost, measured over 5,849 read adverts: 28 escalate, 0.5%. Blast radius over
 * the whole corpus: 26 postings move drop -> uncertain, one moves
 * hybrid -> remote, and NOTHING applied to or marked interested is harmed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { detectWorkMode, mentionsWorkMode } from '../src/geo.js';
import { normalize } from '../src/normalize.js';
import { classify, explain, __testables } from '../src/filter.js';
import { readJson, p } from '../src/util.js';

const { workModeLines } = __testables;
const profile = readJson(p('config', 'examples', 'devops.profile.json'));

/** A far German posting with a real advert, which is the only case that escalates. */
const far = (descriptionText) => normalize({
  source: 'test',
  sourceId: 'wm-1',
  title: 'Site Reliability Engineer (m/w/d)',
  company: 'Example GmbH',
  location: 'Berlin',
  descriptionText,
  applyUrl: 'https://example.test/1',
}, profile);

/**
 * Long enough to count as read — below MIN_DESCRIPTION_CHARS nothing escalates
 * — and naming real tools, or the STACK gate drops it first and the location
 * verdict never gets a say. `classify()` returns on the first certain drop.
 */
const advert = (line) => `${line}\n`
  + ('Du betreibst unsere Kubernetes-Cluster mit Terraform und Azure DevOps, '
    + 'baust CI/CD-Pipelines und verantwortest Monitoring mit Prometheus und Grafana. ').repeat(8);

test('a percentage claim survives a preposition and a hedge', () => {
  // The two postings that produced this work. Both were `hybrid`.
  assert.equal(detectWorkMode('Arbeitsort: in Deutschland (100% im Homeoffice möglich)'), 'remote');
  assert.equal(detectWorkMode('Wir bieten die Möglichkeit, zu fast 100% im Homeoffice zu arbeiten'), 'remote');

  // The same claim in the spellings the corpus actually uses.
  for (const s of [
    '100% remote',
    '100 % im Home Office',
    '95% aus dem Homeoffice',
    'zu 100 Prozent im Homeoffice',
  ]) {
    assert.equal(detectWorkMode(s), 'remote', s);
  }
});

test('a partial percentage is not a strong claim', () => {
  // 90 and up only, which is why this is a range and not `\d+`. Read against
  // the explicit hybrid word, because that is what the number has to beat:
  // `strongPercent` is tested before it and wins, so a low number losing to it
  // is exactly the evidence that the range is doing the work.
  assert.equal(detectWorkMode('Hybrides Arbeitsmodell mit 40% im Homeoffice'), 'hybrid');
  assert.equal(detectWorkMode('Hybrides Arbeitsmodell mit 50 % im Home Office'), 'hybrid');
  assert.equal(detectWorkMode('Hybrides Arbeitsmodell mit 100% im Homeoffice'), 'remote');

  // NOT asserted here, and worth knowing: "40% im Homeoffice, der Rest vor Ort"
  // with no hybrid word reads `remote` through the catch-all at the foot of
  // detectWorkMode. That is pre-existing and is the CHEAP failure — a wrong
  // keep costs a minute of reading. Narrowing the catch-all is measured work of
  // its own; see CLAUDE.md on the mobiles-Arbeiten hedge that was almost added.
});

test('the advert has to be TALKING about where the work happens', () => {
  // What gates the escalation. Without this every far posting would escalate
  // and the model would be asked about adverts that say nothing on the subject.
  for (const s of [
    'Die Möglichkeit auf Homeoffice nach Absprache',
    'Remote work is possible two days a week',
    'Mobiles Arbeiten wird bei uns gelebt',
    'Telearbeit nach Vereinbarung',
  ]) {
    assert.ok(mentionsWorkMode(s), s);
  }

  for (const s of [
    'Erfahrung mit Prometheus Remote Write und Thanos',
    'Terraform remote state in einem S3-Backend',
    'Wir bieten Gleitzeit und flexible Arbeitszeitgestaltung',
    'Betrieb einer hybriden Cloud-/On-Prem-Infrastruktur',
    'Kubernetes, Terraform, Azure DevOps, GitOps',
  ]) {
    assert.ok(!mentionsWorkMode(s), s);
  }
});

test('the word "hybrid" alone is the employer answering, not the rules guessing', () => {
  // Leaving it out HALVES the cost, and the ones it removes are the ones the
  // advert had already settled: of 28 escalations, 14 name no home-working word
  // anywhere — 8 of them HelloFresh postings 639km away on "Balance your life
  // with our flexible hybrid model". Down to 14, 0.24% of read adverts.
  assert.ok(!mentionsWorkMode('Hybrides Arbeitsmodell mit festen Bürotagen'));
  assert.ok(!mentionsWorkMode('Balance your life with our flexible hybrid model.'));

  // But a hybrid advert that ALSO discusses working from home still escalates —
  // that combination is exactly the ambiguity this exists for.
  assert.ok(mentionsWorkMode('Hybrides Modell: überwiegend Homeoffice, gelegentlich im Büro'));
});

test('flexible working TIME is not flexible working PLACE', () => {
  // Five of the postings that prompted this work say only this, and they are
  // correctly onsite. Treating "flexible" as a work-mode signal is the easy,
  // wrong widening.
  const job = far(advert('Wir bieten Gleitzeit und flexible Arbeitszeiten sowie 30 Tage Urlaub.'));
  assert.equal(job.workModeUngraded, false);
  assert.equal(classify(job, profile, {}).decision, 'drop');
});

test('a far posting that discusses home office escalates instead of dropping', () => {
  // The fix, end to end, on the exact shape of the two postings that were
  // lost: a home-office claim with a hedge word beside it, which reads `hybrid`
  // and is then gated exactly like onsite.
  const job = far(advert('Wir bieten dir die Möglichkeit auf Homeoffice — unser Team arbeitet größtenteils von zu Hause.'));

  assert.equal(job.workMode, 'hybrid', 'the rules did not conclude remote');
  assert.ok(job.distanceKm > profile.location.radiusKm, 'and it is too far to commute');
  assert.ok(job.workModeUngraded, 'so the advert goes to the model');

  const v = classify(job, profile, {});
  assert.equal(v.decision, 'uncertain');
  assert.ok(v.uncertainties.some((u) => u.kind === 'work-mode'), 'asked as a work-mode question');
});

test('the soft drop lives in the GATE, not in findUncertainties', () => {
  // Where the first attempt at this failed, and it measured as zero effect.
  // classify() returns on a certain drop BEFORE it looks at uncertainties at
  // all, so an uncertainty alone can never rescue a posting the location gate
  // has already decided. The escalation only fires because gateLocation itself
  // softens.
  const job = far(advert('Wir bieten dir die Möglichkeit auf Homeoffice, das Büro steht dir offen.'));
  const hit = explain(job, profile).checks.find((c) => !c.keep && c.category === 'location');
  assert.ok(hit, 'the location gate still fires — it softens, it does not stand aside');
  assert.equal(hit.certain, false, 'the location drop softens rather than being certain');
  assert.match(hit.reason, /working from home/);
});

test('an advert that says nothing about it is still a certain drop', () => {
  // The other half. 639km with a read advert that never raises the question is
  // exactly what the location gate is for, and this must not widen into
  // escalating every far posting.
  const job = far(advert('Sie betreuen unsere Kubernetes-Cluster am Standort Berlin und arbeiten eng mit dem Netzwerkteam zusammen.'));
  assert.equal(job.workModeUngraded, false);
  const v = classify(job, profile, {});
  assert.equal(v.decision, 'drop');
  assert.equal(v.category, 'location');
});

test('an UNREAD advert does not escalate on work mode', () => {
  // There is nothing to hand the model. An unread far posting already softens
  // on its own — "onsite" is an assumption from a resolved city rather than
  // something the text said — and adding a second reason would only ask a
  // question about text nobody has.
  const job = far('Berlin. Homeoffice möglich.');
  assert.equal(job.descriptionComplete, false);
  assert.equal(job.workModeUngraded, false);
});

test('a posting inside the radius is never asked', () => {
  // The question only exists because the posting is about to be discarded for
  // being far away. One nearby needs no opinion.
  const job = normalize({
    source: 'test',
    sourceId: 'wm-2',
    title: 'Site Reliability Engineer (m/w/d)',
    company: 'Example GmbH',
    location: profile.location.city,
    descriptionText: advert('Homeoffice ist nach Absprache möglich.'),
    applyUrl: 'https://example.test/2',
  }, profile);
  assert.equal(job.workModeUngraded, false);
});

test('the model gets whole lines, deduplicated and capped', () => {
  // Same rule as germanLines(). A window either side of the first match cuts
  // the qualifier off the front — "im Homeoffice" without "100%" reads as a
  // perk — and a posting naming it twice could send the weaker mention.
  const text = [
    'Über uns: wir bauen Plattformen.',
    'Du arbeitest zu 100% im Homeoffice.',
    'Du arbeitest zu 100% im Homeoffice.',
    'Ein Büro in Berlin steht dir offen, Anwesenheit vor Ort ist freiwillig.',
  ].join('\n');

  const lines = workModeLines(text);
  assert.ok(lines.includes('100% im Homeoffice'), 'the qualifier survives');
  assert.ok(!lines.includes('wir bauen Plattformen'), 'lines that do not discuss it are left out');
  assert.equal(lines.split(' | ').length, 2, 'the repeated line is sent once');

  const many = Array.from({ length: 20 }, (_, i) => `Homeoffice Variante ${i}`).join('\n');
  assert.ok(workModeLines(many).split(' | ').length <= 6, 'a careers page cannot fill the prompt');

  const long = `Homeoffice ${'x'.repeat(400)}`;
  assert.ok(workModeLines(long).length < 260, 'and one very long line cannot either');
});

test('the archive keeps the signal, so `npm run why` agrees with the run', () => {
  // Fourth time this class has bitten — descriptionComplete, closed,
  // germanTalkUngraded, now this. A gate that reads a field the archive does
  // not store replays to a different verdict from the one the run reached.
  // test/replay-agrees.test.js enumerates it; this states why it matters here.
  const text = readFileSync(new URL('../src/rejects.js', import.meta.url), 'utf8');
  assert.match(text, /workModeUngraded: job\.workModeUngraded/);
});
