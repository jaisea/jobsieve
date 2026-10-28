/**
 * A board you have looked at and said no to is a DECISION, and a decision that
 * leaves no trace gets made again.
 *
 * Deleting the entry from `boards` was the obvious move and the wrong one: the
 * next `npm run discover` probes the same slug, finds postings and puts it
 * straight back — with nothing anywhere recording that it had already been
 * considered and refused. Worse, `discover --add` would re-add it the moment
 * the same link was pasted, which is exactly how it got there the first time.
 *
 * The case that produced this: the Bertelsmann SmartRecruiters board serves the
 * same 1,005 postings the `careersites` source reads from the group sitemap,
 * but reports `company: "Bertelsmann-Jobs"` on every one of them. Running both
 * shows each job twice under two different employers — and a constant company
 * makes `sha1(company|title|city)` collide: 17 title+city pairs on that board
 * are shared, which would silently swallow 18 postings.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { p, readJson } from '../src/util.js';

const companies = readJson(p('config', 'companies.json'));
const INDEX = readFileSync(p('src', 'index.js'), 'utf8');

test('the ignore list exists and every entry carries its reason', () => {
  // A list of slugs with no reasons would be the same problem one step along:
  // you would know something was refused and not why.
  assert.ok(Array.isArray(companies.ignored), 'config/companies.json needs an "ignored" array');
  for (const x of companies.ignored) {
    assert.ok(x.ats, 'an entry needs a platform');
    assert.ok(x.slug, 'an entry needs a slug');
    assert.ok(x.reason && x.reason.length > 40, `${x.slug}: the reason must actually explain it`);
    assert.match(x.decidedAt || '', /^\d{4}-\d{2}-\d{2}$/, `${x.slug}: needs the date it was decided`);
  }
});

test('an ignored board is not in the polled list', () => {
  // The two halves must agree, or the ignore list is decoration.
  for (const x of companies.ignored) {
    const still = (companies.boards || []).find((b) =>
      b.ats.toLowerCase() === x.ats.toLowerCase() && b.slug.toLowerCase() === x.slug.toLowerCase());
    assert.equal(still, undefined, `${x.ats}/${x.slug} is ignored but still configured as a board`);
  }
});

test('the full probe drops an ignored board even when it answers', () => {
  // The board is live and returns 1,005 postings, so the probe succeeds. The
  // decision has to be applied AFTER a successful probe, not instead of one.
  assert.match(INDEX, /if \(r\.ok && r\.count > 0 && !isIgnored\(t\.ats, t\.slug\)\)/);
});

test('--add refuses, and says why and when', () => {
  // This is the path that would undo the decision: pasting the same link a
  // month later is exactly how a ruled-out board comes back, and the reason is
  // not something anyone will remember.
  assert.match(INDEX, /const veto = hit && isIgnored\(/);
  assert.match(INDEX, /is on the ignore list — not added/);
  assert.match(INDEX, /veto\.reason/, 'the recorded reason is read back');
  assert.match(INDEX, /Decided \$\{veto\.decidedAt\}/);
  assert.match(INDEX, /Remove it from "ignored"/, 'and it says how to override');
});

test('matching is case-insensitive on both fields', () => {
  // "Bertelsmann-Jobs" in a URL, "bertelsmann-jobs" from a probe. A decision
  // that depends on capitalisation is not a decision.
  assert.match(INDEX, /x\.ats\.toLowerCase\(\) === String\(ats \|\| ''\)\.toLowerCase\(\)/);
  assert.match(INDEX, /x\.slug\.toLowerCase\(\) === String\(slug \|\| ''\)\.toLowerCase\(\)/);
});

test('a malformed entry cannot silently ignore everything', () => {
  // An entry missing ats or slug would match with String(undefined) on both
  // sides if it were not filtered out, quietly suppressing real boards.
  assert.match(INDEX, /companies\.ignored \|\| \[\]\)\.filter\(\(x\) => x && x\.ats && x\.slug\)/);
});
