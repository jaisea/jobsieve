/**
 * Personal facts belong in config, never in a source file.
 *
 * The home city once sat hardcoded in score labels, escalation messages, an
 * Adzuna query and an Arbeitsagentur URL — while the profile carried the same
 * city in a field that some of those places never read. Switching
 * profile.location.city to another city did not catch it, because a literal
 * never reads the city in the first place. So the rule is checked mechanically.
 *
 * Comments are exempt: the convention is that they cite the incident that
 * produced the code.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

import { p, readJson } from '../src/util.js';
import { __testables as ADJ } from '../src/adjudicate.js';

const systemPrompt = ADJ.systemPrompt;

/** Source with comments removed — what actually reaches the user. */
function code(file) {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1'))
    .join('\n');
}

const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? walk(`${dir}/${e.name}`) : e.name.endsWith('.js') ? [`${dir}/${e.name}`] : []);

const profile = readJson(p('config', 'examples', 'devops.profile.json'));

test('no source file states the home city as a literal', () => {
  // The gazetteer in geo.js is reference data — every German city is in it, and
  // it is not a claim about the user.
  const city = new RegExp(`\\b${profile.location.city}\\b`, 'i');
  const offenders = walk(p('src'))
    .filter((f) => !f.endsWith('geo.js'))
    .filter((f) => city.test(code(f)));

  assert.deepEqual(offenders, [],
    'read profile.location.city instead — see the score labels for the pattern');
});

test('the adjudicator prompt states no country or city as a literal', () => {
  // The candidate block is the one place the model is forbidden to contradict,
  // so a literal there is asserted to the model as fact about the user.
  const moved = structuredClone(profile);
  moved.location.city = 'Rotterdam';
  moved.location.country = 'NL';
  moved.location.reaches = 'Antwerp (Belgium)';
  moved.workRights.sponsorshipFreeIn = ['NL'];

  const out = systemPrompt(moved);
  assert.ok(out.includes('Based in Rotterdam, the Netherlands'), 'city and country come from the profile');
  assert.ok(out.includes('reaches Antwerp (Belgium)'), 'so does what the radius reaches');
  assert.ok(out.includes('no sponsorship in the Netherlands'), 'and where sponsorship is not needed');
  assert.ok(!out.includes(profile.location.city), 'and nothing of the shipped profile survives');
});

test('the radius clause follows location.reaches', () => {
  // ("reaches" also appears in unrelated sentences of the prompt, so this
  // matches the clause, not the word.)
  const reach = structuredClone(profile);
  reach.location.reaches = 'Salzburg (Austria)';
  assert.ok(systemPrompt(reach).includes('which reaches Salzburg (Austria)'));

  const noReach = structuredClone(profile);
  delete noReach.location.reaches;
  assert.ok(!systemPrompt(noReach).includes('which reaches'), 'and goes when the config does');
  assert.match(systemPrompt(noReach), /Will commute up to 70km./, 'leaving a clean sentence');
});
