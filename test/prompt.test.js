/**
 * What the adjudicator is told.
 *
 * Measured failure: postings with `remoteScope: 'DE'` were escalated for an
 * unrelated question and the model dropped them on LOCATION, reasoning that
 * "remote within Germany" did not explicitly permit München. München is in
 * Germany, and the location gate had already passed them — the model just could
 * not see that. Four of six model disagreements in a 20-posting comparison were
 * this one error.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { __testables } from '../src/adjudicate.js';
import { classify } from '../src/filter.js';
import { readJson, p } from '../src/util.js';

const { systemPrompt, userPrompt } = __testables;
const profile = readJson(p('config', 'examples', 'devops.profile.json'));

const job = (over = {}) => ({
  fingerprint: 'f', title: 'DevOps Engineer', company: 'Acme',
  location: 'Remote, Germany', workMode: 'remote', remoteScope: 'DE',
  postedAt: new Date().toISOString(), descriptionText: 'Azure and Kubernetes.',
  germanRequired: 'none', programmingRequired: 'no',
  ...over,
});

test('a settled location is stated as reachable, not left to inference', () => {
  const j = job({ germanRequired: 'conversational', germanEvidence: 'posting written in German' });
  const u = classify(j, profile, {}).uncertainties;
  const prompt = userPrompt(j, u, profile);

  assert.match(prompt, /Already settled/);
  assert.match(prompt, /Location: REACHABLE — remote \(DE\)/);
});

test('a dimension being asked about is never also declared settled', () => {
  // Otherwise the prompt would contradict itself: "do not revisit location"
  // alongside a question about location.
  const j = job({ remoteScope: null });          // raises the remote-scope question
  const u = classify(j, profile, {}).uncertainties;
  assert.ok(u.some((x) => x.kind === 'remote-scope'));

  const prompt = userPrompt(j, u, profile);
  const settled = prompt.split('# Questions')[0];
  assert.doesNotMatch(settled, /Location: REACHABLE/);
});

test('the remote-scope question cannot be read as requiring a city', () => {
  // The old wording — "accepts someone based in Germany? Look for country
  // restrictions" — led to "restricted to Germany, does not allow München".
  const j = job({ remoteScope: null });
  const q = classify(j, profile, {}).uncertainties.find((x) => x.kind === 'remote-scope');

  assert.match(q.question, /Germany-wide, EU-wide or worldwide/);
  assert.match(q.question, /does not need to mention any particular city/i);
  assert.match(q.question, /DIFFERENT country/);
});

test('the system prompt says plainly that the home city is in Germany', () => {
  const s = systemPrompt(profile);
  assert.match(s, new RegExp(`${profile.location.city} is in Germany`));
  assert.match(s, /"remote \(Germany\)" is a pass, not a restriction/);
});

test('the model is told not to decide against a settled dimension', () => {
  assert.match(systemPrompt(profile), /never\s*\n?drop a posting on a dimension that appears there/);
});

test('settled facts are omitted when nothing is resolved', () => {
  // No location, no signals — there is nothing honest to assert, so the section
  // must not appear at all rather than claiming reachability.
  const j = job({ workMode: 'unknown', remoteScope: null, distanceKm: null, location: 'Musterhausen' });
  const u = classify(j, profile, {}).uncertainties;
  const settled = userPrompt(j, u, profile).split('# Questions')[0];
  assert.doesNotMatch(settled, /Location: REACHABLE/);
});
