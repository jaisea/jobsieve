/**
 * When the rules cannot grade German, ask — and send the whole line.
 *
 * Four postings were rejected by hand for a German requirement. Three were
 * caught once their description finally arrived; the fourth said, in English,
 * "We need german speaking candidates min at C1 level" and was graded "none".
 *
 * The escape hatch existed but was too clever. It looked for "german" followed
 * within 30 characters by level, skills, speaking and so on, so that "Germany"
 * the place would not trigger it. English adverts put the language word first —
 * "Proficiency in both German and English at a professional level" — which
 * pushes any trailing "level" outside the window.
 *
 * The instruction: stop being strict about word placement. If the rules cannot
 * decide and the advert names German, extract the line and ask the model. Not
 * "Germany" the country — an office address or a market is not a requirement.
 *
 * Cost, measured: only 213 postings have ever reached the German check; the
 * rest are dropped earlier on title, age or location. The tiers settle 158 of
 * those. This takes the questions from 4 to 9. Matching the bare word instead —
 * letting "Germany" through — would have been 22.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mentionsGermanAsLanguage, detectGermanRequirement } from '../src/language.js';
import { explain, __testables } from '../src/filter.js';
import { readJson, p } from '../src/util.js';

const profile = readJson(p('config', 'examples', 'devops.profile.json'));

test('the language is named however the sentence is built', () => {
  // The point of dropping the word-order rule. Each of these was graded "none".
  for (const s of [
    'We need german speaking candidates min at C1 level',
    'Proficiency in both German and English at a professional level',
    'Full Fluency in German and English is mandatory for the role',
    'SAP FI/CO Consultant – German speaker',
    'You will write documentation and guidelines in German',
    'German language skills are a plus',
    'auf Deutsch',
  ]) {
    assert.ok(mentionsGermanAsLanguage(s), s);
  }
});

test('the country is not the language', () => {
  // Every posting in the country says "Germany" somewhere. Firing on it took
  // the questions from 9 to 22 and taught the model nothing.
  for (const s of [
    'Germany',
    'Headquartered in Chemnitz, Germany and New York City',
    'Drive expansion with clients in the DACH (Germany, Austria, Switzerland)',
    '#SREJobs #GermanyJobs #RemoteJobs',
    'Attraktive Zusatzleistungen wie vergünstigtes Deutschland-Ticket',
    'offices in Europe (France and Germany), India (Hyderabad)',
    '85774 Unterföhring | Germany | Phone +49 89 99228 0',
  ]) {
    assert.ok(!mentionsGermanAsLanguage(s), s);
  }
});

test('a phrasing the rules already grade is never escalated', () => {
  // The question only exists for what the tiers miss. "Deutschkenntnisse" and
  // "verhandlungssicher" are graded, so they cost no call.
  for (const s of [
    'Verhandlungssichere Deutsch- und Englischkenntnisse in Wort und Schrift',
    'Sehr gute Deutschkenntnisse (mind. C1)',
    'Fließende Deutschkenntnisse in Wort und Schrift',
  ]) {
    assert.equal(detectGermanRequirement(s, 'de').level, 'required', s);
  }
});

/* --------------------------------------------------- what the model is sent */

const { germanLines } = __testables;

test('the whole line is sent, not a window around the word', () => {
  // An 80-character window either side cut the level off the front:
  // "Deutsch- und Englischkenntnisse" without "Verhandlungssichere" reads as no
  // requirement at all.
  const out = germanLines('Was wir erwarten\nVerhandlungssichere Deutsch- und Englischkenntnisse in Wort und Schrift\nReisebereitschaft');
  assert.match(out, /^Verhandlungssichere Deutsch- und Englischkenntnisse in Wort und Schrift$/);
});

test('every line is sent, so a weak mention cannot hide a real one', () => {
  const out = germanLines([
    'Our office is in Munich, Germany.',
    'German language skills are a plus.',
    'Fluent German at C1 is required for this role.',
  ].join('\n'));

  assert.ok(out.includes('a plus'), 'the weak one');
  assert.ok(out.includes('C1 is required'), 'and the real one');
  assert.ok(!out.includes('office is in Munich'), 'but not the country line');
});

test('bullets and sentences both count as line breaks', () => {
  const out = germanLines('• Kubernetes experience • Fluency in German required • Terraform');
  assert.match(out, /^Fluency in German required$/, 'the bullet alone, not its neighbours');
});

test('the same line twice is sent once', () => {
  const out = germanLines('Fluent German required.\nFluent German required.');
  assert.equal(out.split(' | ').length, 1);
});

test('a careers page cannot fill the prompt', () => {
  // Six lines, and each capped, so a page listing every office does not push
  // the rest of the posting out of the model's view.
  const many = Array.from({ length: 20 }, (_, i) => `Line ${i}: fluency in German needed for team ${i}.`).join('\n');
  const out = germanLines(many);
  assert.equal(out.split(' | ').length, 6);

  const long = germanLines(`Fluent German ${'x'.repeat(400)}`);
  assert.ok(long.length < 240, `capped, got ${long.length}`);
});

test('a posting that names German only as a country asks nothing', () => {
  const job = {
    title: 'Platform Engineer', company: 'X', workMode: 'remote', remoteScope: 'DE',
    descriptionText: `We are a remote-first company with offices in Berlin, Germany. ${'Kubernetes and Terraform. '.repeat(40)}`,
    language: 'en', germanRequired: 'none', germanTalkUngraded: false,
    programmingRequired: 'none', score: 60, postedAt: new Date().toISOString(),
  };
  assert.ok(!explain(job, profile).uncertainties.some((u) => u.kind === 'german'));
});
