/**
 * "No fallback was given" and "the fallback is null" are different facts.
 *
 * readJson() guarded with `if (fallback !== null) return fallback`, so
 * `readJson(path, null)` — which reads as "give me null if it is not there" —
 * could never return null and always threw.
 *
 * Four callers in apply/index.js pass exactly that, and each follows it with
 * `if (!x) continue`. Every one was written against behaviour the function did
 * not have: listApplications(), the salary fill-in on an existing folder,
 * `apply --diff`, and learn().
 *
 * It surfaced as a 500 on /api/feedback that took down the whole "What you
 * rewrote" panel, because ONE application folder had no
 * `.generation/baseline.json`. That folder is not broken: marking a job applied
 * WITHOUT tailoring is a supported path that deliberately writes no generation
 * data, so a folder without it is the normal case rather than an edge one — the
 * panel was one un-tailored application away from failing for anybody.
 *
 * Same class as `chars === 0` rather than `!chars` in language.js: absent is not
 * empty, and a default is not a value.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { p, readJson } from '../src/util.js';

const MISSING = p('data', 'this-file-does-not-exist-on-purpose.json');

test('an explicit null fallback is returned, not treated as absent', () => {
  assert.equal(readJson(MISSING, null), null);
});

test('every other falsy fallback works too', () => {
  // These happened to work before, because they are !== null. Pinned so a
  // future "simplification" back to a truthiness check fails here.
  assert.deepEqual(readJson(MISSING, {}), {});
  assert.deepEqual(readJson(MISSING, []), []);
  assert.equal(readJson(MISSING, 0), 0);
  assert.equal(readJson(MISSING, false), false);
  assert.equal(readJson(MISSING, ''), '');
});

test('no fallback at all still throws, and still names the file', () => {
  // The other half of the contract. A missing config file must be loud —
  // silently returning null there would start a run with no profile.
  assert.throws(() => readJson(MISSING), /Could not read JSON at .*this-file-does-not-exist/);
});

test('a real file is still parsed', () => {
  assert.ok(readJson(p('package.json')).scripts.test);
});

test('the callers that depend on this all guard for a missing file', () => {
  // If one of them stops checking, the throw comes back through a different
  // door. Each of these reads generation data that only exists when an
  // application was actually tailored.
  const src = readFileSync(p('src', 'apply', 'index.js'), 'utf8');
  const nullReads = [...src.matchAll(/readJson\([^;]*?,\s*null\)/g)];
  assert.ok(nullReads.length >= 3,
    'apply/index.js is the file this was found in — it should still be reading this way');

  assert.match(src, /const baseline = readJson\(join\(dir, '\.generation', 'baseline\.json'\), null\);\s*\n\s*if \(!baseline\) (continue|return)/,
    'learn() and --diff must skip a folder with no generation data');
});

test('marking applied without tailoring is a supported path', () => {
  // The premise of the bug. If this ever stops being true the comment above
  // stops making sense, so it is asserted rather than assumed.
  const src = readFileSync(p('src', 'apply', 'index.js'), 'utf8');
  assert.match(src, /recordApplied/);
  assert.match(readFileSync(p('CLAUDE.md'), 'utf8'),
    /Marking a job applied keeps the advert, tailored or not/);
});
