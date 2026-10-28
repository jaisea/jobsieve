/**
 * How long a captured advert is trusted.
 *
 * The cache used to be permanent. A remote DevOps posting was captured
 * at 09:03 and the employer added "Deutsch Muttersprache oder mindestens C1
 * Deutsch" later the same day. Every run afterwards re-judged the old snapshot:
 * the language gate saw no requirement, escalated, and the adjudicator answered
 * — correctly — that the ad stated no language requirement. Nothing in the chain
 * was wrong except the age of the text.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { p } from '../src/util.js';
import { __testables } from '../src/enrich.js';

const { staleBy, MAX_AGE_DAYS } = __testables;
const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString();

test('a description older than the limit is re-read', () => {
  assert.equal(staleBy(daysAgo(MAX_AGE_DAYS + 1), MAX_AGE_DAYS), true);
  assert.equal(staleBy(daysAgo(1), MAX_AGE_DAYS), false);
});

test('a missing timestamp is not treated as stale', () => {
  // Older cache entries predate the field. Treating them as stale would
  // re-fetch every posting at once on the first run after an upgrade.
  assert.equal(staleBy(null, MAX_AGE_DAYS), false);
  assert.equal(staleBy(undefined, MAX_AGE_DAYS), false);
});

test('a zero limit disables re-reading rather than expiring everything', () => {
  // The obvious off-by-one: 0 must mean "never re-read", not "always".
  assert.equal(staleBy(daysAgo(999), 0), false);
});

test('an advert is re-read before an application is generated for it', () => {
  // The most expensive thing this tool does with the user's time. A job that has since
  // grown a C1 German requirement must not reach the point of a tailored CV.
  const src = readFileSync(p('src', 'apply', 'index.js'), 'utf8');
  assert.match(src, /async function recheck\(/, 'apply must re-read the advert');
  assert.match(src, /enrich\(\[job\], \{ force: true \}\)/, 'and must bypass the cache when it does');
  assert.match(src, /!re\.verdict\.keep && re\.verdict\.certain/, 'and must stop on a certain drop');
});

test('a re-read that fails is reported, not swallowed', () => {
  // The first version used .catch(() => null), which made a failed re-read
  // indistinguishable from "the advert has not changed" — the silent downgrade
  // this project treats as a bug. Each outcome now has its own status.
  const src = readFileSync(p('src', 'apply', 'index.js'), 'utf8');
  for (const status of ['unavailable', 'unchanged', 'changed', 'skipped']) {
    assert.ok(src.includes(`'${status}'`), `recheck must distinguish "${status}"`);
  }
  assert.ok(!src.includes('recheck(job, profile).catch(() => null)'), 'errors must not be swallowed');
  assert.match(src, /could not re-read the advert/, 'and a failure must be said out loud');
});

test('the report UI re-checks the advert too', () => {
  // serve.js omitted the profile, so recheck() returned early and the button
  // generated against a stale advert while the CLI refused to.
  const src = readFileSync(p('src', 'serve.js'), 'utf8');
  const call = src.slice(src.indexOf('applyMod.apply('), src.indexOf('applyMod.apply(') + 260);
  assert.match(call, /profile:/, 'serve.js must pass the profile through to apply()');
});

test('a blocked application leaves no folder behind', () => {
  // mkdirSync used to run before the re-check, so a blocked job left an empty
  // directory that reads as "an application exists".
  const src = readFileSync(p('src', 'apply', 'index.js'), 'utf8');
  const beforeGate = src.slice(src.indexOf('export async function apply('), src.indexOf('const re = recheckAd'));
  assert.ok(!beforeGate.includes('mkdirSync'), 'the folder must not be created before the advert is re-checked');
});
