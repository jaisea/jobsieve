/**
 * Which CEFR level an advert is actually asking for.
 *
 * Five postings were reported in one sitting as showing a German requirement
 * while sitting at the top of the report. Four were the report never re-gating.
 * The fifth was real, and the two cases below came out of chasing it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { detectGermanRequirement } from '../src/language.js';

const level = (s) => detectGermanRequirement(s, 'de', { complete: true, chars: 900 }).level;

test('a range is graded at its ceiling, not its floor', () => {
  // "Deutsch B2/C1" was graded B2. The C1 patterns need the level next to the
  // noun and the range sits in between, so the B2 tier matched first. What you
  // are measured against in the interview is the ceiling they named.
  for (const s of ['Deutsch B2/C1', 'Deutsch: B2/C1', 'Deutsch (B2/C1)', 'German B2-C1', 'Deutsch B2 / C1']) {
    assert.equal(level(s), 'required', s);
  }
});

test('a level is not stolen from the language before it', () => {
  // slug() drops the comma, so "Englisch C1, Deutsch B2" becomes
  // "englisch c1 deutsch b2" and a bare "c1 … deutsch" matched straight across
  // it — grading German at C1 when the advert asked for B2. That is a wrong
  // drop, which costs an opportunity you never see.
  assert.equal(level('Englisch C1, Deutsch B2'), 'conversational');
  assert.equal(level('gutes Englisch C1 und Deutsch B2'), 'conversational');
  assert.equal(level('Französisch C1, Deutsch B1'), 'basic');
});

test('a genuine C1-in-German is still caught', () => {
  // The guard above must not blunt the pattern it protects.
  for (const s of ['C1 in Deutsch', 'C1 level German', 'Sprachkenntnisse: C1 Deutsch']) {
    assert.equal(level(s), 'required', s);
  }
});

test('single levels are unchanged', () => {
  assert.equal(level('Deutsch B2'), 'conversational');
  assert.equal(level('Deutsch C1'), 'required');
  assert.equal(level('Deutsch B1'), 'basic');
  assert.equal(level('gute Deutschkenntnisse'), 'conversational');
});

test('the wordings reported from real adverts all grade as required', () => {
  for (const s of [
    'Deutsch Muttersprache oder mindestens C1 Deutsch',
    'verhandlungssichere Deutschkenntnisse',
    'Sehr gute Deutschkenntnisse (mind. C1)',
    'Deutsch verhandlungssicher',
    'Fließende Deutschkenntnisse in Wort und Schrift (mindestens Niveau B2)',
    'Deutsch B2/C1',
  ]) {
    assert.equal(level(s), 'required', s);
  }
});

test('a posting saying German is NOT needed is not read as requiring it', () => {
  // The inversion. "Deutsch nicht erforderlich" matched no tier, fell through to
  // the "posting is written in German" inference, and came out as a hard
  // requirement — the opposite of what it says, on exactly the postings that
  // are most worth having. A first fix put these patterns in the requirement
  // tier by mistake, which made every negation grade as required.
  const de = (s) => detectGermanRequirement(s, 'de', { complete: true, chars: 900 }).level;
  const en = (s) => detectGermanRequirement(s, 'en', { complete: true, chars: 900 }).level;

  for (const s of ['Deutsch nicht erforderlich', 'Deutsch ist nicht zwingend erforderlich',
    'keine Deutschkenntnisse erforderlich', 'kein Deutsch notwendig']) {
    assert.equal(de(s), 'basic', s);
  }
  assert.equal(en('no German required'), 'basic');
  assert.equal(en('German is not required'), 'none');
});

test('the negation guard does not blunt the requirement it guards', () => {
  const de = (s) => detectGermanRequirement(s, 'de', { complete: true, chars: 900 }).level;
  assert.equal(de('Deutschkenntnisse erforderlich'), 'required');
  assert.equal(de('Deutsch ist Voraussetzung'), 'required');
  assert.equal(de('gute Deutschkenntnisse'), 'conversational');
});

test('a CEFR level stated after a language LIST is still a requirement', () => {
  // Every level pattern needs the level ADJACENT to the language — "Deutsch
  // C1", "German at C1". In a list the level trails both names instead:
  // "German and English skills at C1 level". One posting asked for
  // exactly that and fell through to the fallback "posting written in German",
  // which is an INFERENCE and therefore a soft drop — so it escalated to the
  // model for a requirement the advert stated outright.
  for (const s of [
    'German and English skills at C1 level',
    'Deutsch- und Englischkenntnisse auf C1-Niveau',
    'German and English at C1',
    'English and German at C1 level',
    'Deutsch und Englisch auf C2-Niveau',
  ]) {
    assert.equal(detectGermanRequirement(s, 'en', { complete: true, chars: 900 }).level, 'required', s);
  }
});

test('and the trailing level does not steal a level from the other language', () => {
  // The trap the lookbehind exists for: "Englisch C1, Deutsch B2" must stay B2,
  // because the C1 belongs to English. The new patterns require an explicit
  // "and"/"und", which a comma-separated list does not have.
  assert.equal(detectGermanRequirement('Deutsch B2, Englisch C1', 'de', { complete: true, chars: 900 }).level,
    'conversational');
  assert.equal(detectGermanRequirement('Englisch C1, Deutsch B2', 'de', { complete: true, chars: 900 }).level,
    'conversational');
  assert.equal(detectGermanRequirement('English at C1 level', 'en', { complete: true, chars: 900 }).level,
    'none', 'English alone is not a German requirement');

  // And the window is short enough not to reach across two separate statements.
  assert.equal(detectGermanRequirement(
    'German and English are used daily. We sponsor courses; C1 certification is available.',
    'en', { complete: true, chars: 900 }).level, 'none');
});

test('a QUOTED level settles it; an inferred one still asks', () => {
  // This is what the fix actually buys. The verdict was already "required"
  // either way — but from the fallback it is an inference, and an inference
  // escalates. Quoting the level makes it a fact the rules can act on alone.
  const quoted = detectGermanRequirement('German and English skills at C1 level', 'en',
    { complete: true, chars: 900 });
  assert.match(quoted.evidence, /c1/i, 'the evidence must be the quote, not the fallback');
  assert.ok(!/posting written in German/.test(quoted.evidence));
});
