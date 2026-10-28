/**
 * Naming the German level, and the distance to it.
 *
 * The tier ("required") drives the gate and is deliberately coarse. But a
 * rejection reading "German required (have A2)" covered everything from B2 to
 * native, which is the difference between a near-miss and a non-starter. These
 * pin the level recovered from the evidence, and the honesty rule: never claim
 * a CEFR level the posting did not state.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { detectGermanRequirement, describeGermanNeed, germanGap } from '../src/language.js';

/** Grade a real phrase, then describe it — the path the pipeline actually takes. */
const from = (text, have = 'A2') => {
  const { level, evidence } = detectGermanRequirement(text, 'en');
  return germanGap(level, evidence, have);
};

test('an explicit CEFR level is reported as itself', () => {
  assert.equal(from('Deutsch auf Niveau C1').cefr, 'C1');
  assert.equal(from('German at level B2').cefr, 'B2');
  assert.equal(from('German C2 required').cefr, 'C2');
});

test('German phrases map to the level they actually mean', () => {
  assert.equal(from('verhandlungssichere Deutschkenntnisse').cefr, 'C1');
  assert.equal(from('sehr gute Deutschkenntnisse').cefr, 'C1');
  assert.equal(from('Muttersprachler Deutsch').cefr, 'C2');
  assert.equal(from('gute Deutschkenntnisse').cefr, 'B2');
  assert.equal(from('Grundkenntnisse in Deutsch').cefr, 'A2');
});

test('the distance is available to callers, from the configured level', () => {
  assert.equal(from('gute Deutschkenntnisse', 'A2').steps, 2, 'A2 -> B2');
  assert.equal(from('gute Deutschkenntnisse', 'B1').steps, 1);
  assert.equal(from('verhandlungssicher', 'A2').steps, 3, 'A2 -> C1');
  assert.equal(from('Muttersprache', 'A2').steps, 4);
});

test('the reason names the level and nothing else', () => {
  // The level alone is what you triage on. Spelling out the arithmetic on every
  // row crowded the list without telling you anything the level did not.
  assert.equal(from('gute Deutschkenntnisse').text, 'German B2 required');
  assert.equal(from('verhandlungssicher').text, 'German C1 required');
  assert.equal(from('Muttersprache').text, 'German C2 required');

  for (const phrase of ['gute Deutschkenntnisse', 'verhandlungssicher', 'Deutsch auf Niveau C1']) {
    assert.doesNotMatch(from(phrase).text, /level[s]? above|have|A2/,
      `"${phrase}" must not restate the gap`);
  }
});

test('an unstated level is never invented', () => {
  // The tier is 'required' because the ad is in German, not because it said C1.
  // Printing "German C1 needed" here would be fabricating a requirement.
  const inferred = germanGap('required', 'posting written in German, no English signal', 'A2');

  assert.equal(inferred.cefr, null);
  assert.equal(inferred.inferred, true);
  assert.match(inferred.text, /level unstated/);
  assert.doesNotMatch(inferred.text, /C1|C2|B2/);
});

test('no requirement produces no gap line', () => {
  assert.equal(describeGermanNeed('none'), null);
  assert.equal(germanGap('none', null), null);
});

test('the wording does not change with your own level', () => {
  // Only `steps` moves. The posting demands what it demands regardless of where
  // you are, so raising germanLevel must not reword the requirement.
  const a2 = germanGap('conversational', 'gute deutschkenntnisse', 'A2');
  const c1 = germanGap('conversational', 'gute deutschkenntnisse', 'C1');

  assert.equal(a2.text, c1.text);
  assert.equal(a2.steps, 2);
  assert.ok(c1.steps < 0);
});
