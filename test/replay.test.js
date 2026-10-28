/**
 * Judging the last fetch again, without paying for a new one.
 *
 * Iterating on a gate used to mean a full `npm run search`: 42 Adzuna calls, an
 * IMAP round trip, and a JSearch call against a 200-a-month allowance. Four such
 * runs in one afternoon took JSearch to 95% used. The postings had not changed —
 * only the rules being applied to them.
 *
 * `analyze` already re-judged offline, but only over `data/jobs.json`, which
 * holds the 217 postings that were KEPT. A gate change that would now RESCUE
 * something previously dropped was invisible to it, and the reject archive
 * cannot stand in: 6,994 of its entries are slimmed to nothing and the rest are
 * capped at 1,200 characters.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

import { p } from '../src/util.js';
import * as fetched from '../src/fetched.js';

const INDEX = readFileSync(p('src', 'index.js'), 'utf8');

test('a replay reaches no network at all', () => {
  // Three separate ways out, because any one of them alone would still spend
  // something: the sources, the advert fetch, and the quota ledger they update.
  assert.match(INDEX, /for \(const key of launchOrder\(replay \? \[\] : toRun\)\)/,
    'the source loop must not run');
  assert.match(INDEX, /offline: replay/,
    'the advert step runs, but is forbidden from requesting anything');
  assert.match(readFileSync(p('src', 'enrich.js'), 'utf8'), /const need = offline \? \[\] :/,
    'offline means nothing is queued for fetching');
  assert.match(INDEX, /if \(!replay\) enrichSave/,
    'and nothing new was fetched, so nothing is written back');

  // The quota check lives inside the source loop, so skipping the loop skips
  // the spend AND the ledger write. Asserted so a later refactor that hoists
  // the budget check out of the loop cannot silently start charging replays.
  // The loop that decides who runs (and the budget), through the landing function (and the ledger).
  const loop = INDEX.slice(INDEX.indexOf('for (const key of launchOrder(replay ? [] : toRun))'),
    INDEX.indexOf('if (replay) {'));
  assert.match(loop, /quota\.budgetFor\(/, 'the budget check stays inside the loop');
  assert.match(loop, /quota\.record\(/, 'and so does the ledger write');
});

test('it refuses rather than fetching when there is no snapshot', () => {
  // Falling back to a real fetch would be the worst outcome: you asked for the
  // cheap path and got the expensive one, silently.
  assert.match(INDEX, /if \(replay && !snapshot\) \{[\s\S]{0,160}return;/,
    'no snapshot means stop, not fetch');
  assert.match(INDEX, /No stored fetch to replay/);
});

test('the snapshot is written before anything is judged', () => {
  // A crash in a gate must still leave a usable snapshot — not having to fetch
  // again is the entire point.
  // Each source is saved as it lands and THEN judged, so the order that matters is
  // the order of the calls in the loop, not the order the functions are defined in.
  const saveAt = INDEX.indexOf('fetched.save(slice,');
  const judgeAt = INDEX.indexOf('await prepare(result.jobs');
  assert.ok(saveAt > 0 && judgeAt > saveAt, 'save must come before the source is judged');
});

test('a dry run does not overwrite the snapshot', () => {
  // --dry-run promises to write nothing, and a stored fetch is a write. It also
  // means a dry run cannot quietly replace a good snapshot with a partial one.
  assert.match(INDEX, /if \(!dryRun && !nothingBack && !\(delta && !result\.jobs\.length\)\) \{\s*\n\s*const slice = [^\n]*\n\s*fetched\.save\(slice/);
  // And a replay never reaches it: the only write is inside the source loop, which
  // a replay does not run.
  assert.equal((INDEX.match(/fetched\.save\(/g) || []).length, 1, 'one write, inside the loop');
});

test('the stored shape is the adapter output, before normalize', () => {
  // The important choice. Storing NORMALIZED jobs would replay the gates but
  // freeze everything normalize derives — work mode, the German tiers, the
  // stack match, the distance — which is where half the interesting bugs live.
  // `slice` is result.jobs itself, or — for a source that returns only what is new — those jobs
  // merged into the stored window. Both are adapter output.
  assert.match(INDEX, /const slice = delta \? fetched\.mergeSlice\(key, result\.jobs, result\.merge\) : result\.jobs;/,
    'the adapter output, not normalized');
  assert.match(INDEX, /fetched\.save\(slice,/);

  // Anchored on the filter that FEEDS normalize rather than a variable name —
  // the step gained a progress counter and the old anchor () stopped existing, which failed this test for a reason that had
  // nothing to do with what it protects.
  // normalize() now lives inside judge(), which is DEFINED above the loop; what
  // matters is that the loop saves the adapter output before it calls judge().
  assert.ok(INDEX.indexOf('raw.filter((j) => j.title && j.applyUrl)') > 0, 'judge() still feeds normalize from its batch');
  assert.ok(INDEX.indexOf('fetched.save(slice,') < INDEX.indexOf('await prepare(result.jobs'),
    'and saved before normalize() runs on it');
});

test('a stale snapshot says so instead of pretending to be fresh', () => {
  assert.match(INDEX, /the stored fetch is \$\{Math\.round\(age \/ 24\)\} day\(s\) old/);
});

test('the snapshot carries forward what the fetch reported', () => {
  // A source skipped for a spent quota contributed nothing. A replay that
  // quietly showed zero from it would read as a fetch failure rather than a
  // budget, and send someone looking for a bug that is not there.
  assert.match(INDEX, /for \(const line of snapshot\.sources \|\| \[\]\) sourceLines\.push\(line\)/);
  assert.match(INDEX, /for \(const w of snapshot\.warnings \|\| \[\]\) warnings\.push\(w\)/);
});

/* ------------------------------------------------------------- the store */

test('a missing or corrupt snapshot loads as null, never as garbage', () => {
  // load() is the gate between a half-written file and the whole pipeline.
  const src = readFileSync(p('src', 'fetched.js'), 'utf8');
  assert.match(src, /if \(!existsSync\(file\)\) return null;/);
  assert.match(src, /catch \{\s*\n\s*return null;/, 'unparseable JSON is not a crash');
  assert.match(src, /Array\.isArray\(data\?\.jobs\) \? data : null/,
    'and a file without a jobs array is not a snapshot');
});

test('describe() reads as a human sentence at every age', () => {
  const mk = (minutesAgo, count) => ({
    count, fetchedAt: new Date(Date.now() - minutesAgo * 60000).toISOString(),
  });
  assert.match(fetched.describe(mk(20, 6600)), /6600 postings, 20 minutes old/);
  assert.match(fetched.describe(mk(60 * 5, 10)), /5 hours old/);
  assert.match(fetched.describe(mk(60 * 24 * 3, 10)), /3 days old/);
  assert.equal(fetched.describe(null), null);
});

test('the snapshot is gitignored — it holds job adverts, and this repo is public', () => {
  const ignore = readFileSync(p('.gitignore'), 'utf8');
  assert.match(ignore, /^data\/$/m, 'data/ covers data/fetched.json');
  assert.ok(!existsSync(p('fetched.json')), 'and nothing is written to the repo root');
});

test('a replay uses the advert cache — that is not the same as --no-enrich', () => {
  // The distinction that cost a faithful replay. Skipping the enrich step
  // entirely to avoid the network also threw away the 1,126 adverts already on
  // disk, so the content gates judged teasers: 890 postings escalated to the
  // model instead of 236, against an identical title phase.
  //
  //   --no-enrich   no step at all      — judge on whatever the sources gave
  //   --replay      the step, offline   — judge on every advert already cached
  assert.match(INDEX, /const didFetch = !has\('--no-enrich'\);/,
    'the enrich step is gated on --no-enrich alone');
  assert.match(INDEX, /const askedTheNetwork = didFetch && !replay;/,
    'and only the PARKING decision cares whether the network was asked');
});
