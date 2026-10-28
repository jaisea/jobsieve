/**
 * A posting with no advert text must not be judged.
 *
 * d691a117 — "Senior Cloud Solutions Architect (m/w/d)" at AOE — reached the
 * report at 70/100 and had to be rejected by hand. The advert says
 * "Verhandlungssichere Deutsch- und Englischkenntnisse in Wort und Schrift",
 * and the language gate grades that phrasing `required` correctly. It never saw
 * it: LinkedIn returned HTTP 429, so the description was empty, the rules found
 * no language requirement because there was no text, and the model was asked to
 * guess from the title.
 *
 * Eight LinkedIn fetches were throttled in that one run. Five of those postings
 * reached the queue unread; four of them turned out to demand German.
 *
 * The failure is not that a judgement was wrong. It is that a judgement was
 * MADE. "No description" and "a description that says nothing" are different
 * facts, and the pipeline already knows this elsewhere — detectLanguage()
 * returns `unknown` rather than `en` for empty text, for exactly this reason.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { p } from '../src/util.js';
import * as parked from '../src/parked.js';
import { isTransient } from '../src/enrich.js';
import * as enrich from '../src/enrich.js';
import { detectGermanRequirement } from '../src/language.js';

const INDEX = readFileSync(p('src', 'index.js'), 'utf8');
const ENRICH = readFileSync(p('src', 'enrich.js'), 'utf8');

test('the phrasing that started this grades as required', () => {
  // Including the hyphenated compound, which is the awkward form: the language
  // is named once and shared across two nouns.
  for (const phrase of [
    'Verhandlungssichere Deutsch- und Englischkenntnisse in Wort und Schrift',
    'Verhandlungssichere Deutschkenntnisse in Wort und Schrift',
    'Sehr gute Deutsch- und Englischkenntnisse',
    'Fließende Deutsch- und Englischkenntnisse in Wort und Schrift',
  ]) {
    assert.equal(detectGermanRequirement(phrase, 'de').level, 'required', phrase);
  }
});

test('an empty description is a reason to come back, not an answer', () => {
  // The guest card serves the description inconsistently — the same posting
  // returned 41KB with no description block one minute and 74KB with it the
  // next. Cached as a success, that blankness becomes a permanent fact.
  assert.ok(isTransient('description came back empty'));
  assert.ok(isTransient('HTTP 429'));
  assert.ok(!isTransient('no JobPosting structured data on the page'),
    'a page that never had structured data will not grow any');
  assert.ok(!isTransient('HTTP 410'), 'gone is gone');
});

test('a blank extraction is refused before it can be stored', () => {
  assert.match(ENRICH, /if \(!text\) return \{ ok: false, error: 'description came back empty'/,
    'the guard must sit where the text is accepted');
});

test('only transient failures are parked', () => {
  // Parking a permanent failure would hold a posting forever, and it would
  // never appear in any verdict at all — worse than judging it thinly.
  //
  // Asserted through livenessOf() rather than by grepping the pipeline, which
  // is where this lived before the phases were split out: `unknown` is the
  // state that parks, and it is reachable only from a transient error or from
  // never having fetched at all.
  assert.equal(enrich.livenessOf({ error: 'HTTP 429' }).state, 'unknown', 'come back next run');
  assert.equal(enrich.livenessOf({ error: 'description came back empty' }).state, 'unknown');
  assert.equal(enrich.livenessOf({ error: 'timed out' }).state, 'unknown');
  assert.equal(enrich.livenessOf(undefined).state, 'unknown', 'never fetched is not an answer either');

  assert.equal(enrich.livenessOf({ error: 'no JobPosting structured data on the page' }).state, 'unreadable',
    'a page that never had structured data will not grow any — gate it unread, except for a source that only ever gives a teaser');
  assert.equal(enrich.livenessOf({ error: 'HTTP 403' }).state, 'unreadable');

  const block = INDEX.slice(INDEX.indexOf('const teaser ='), INDEX.indexOf('if (parked.length)'));
  assert.match(block, /descriptionText \|\| ''\)\.trim\(\)\.length/, 'and only when the text is still a teaser');
});

test('nothing is parked when nothing was fetched', () => {
  // Parking means "we asked and the advert did not arrive", not "we never
  // looked". `--no-enrich` fetches nothing by design, so every posting without
  // text looked transiently unavailable and got held instead of judged — 401 of
  // them in the first run of the phased pipeline, on the one flag whose entire
  // purpose is to skip the network and gate on what the sources gave.
  assert.match(INDEX, /const askedTheNetwork = didFetch && !replay;/);
  assert.match(INDEX, /if \(askedTheNetwork && teaser && \(l\.state === 'unknown'/,
    'the parking branch must be gated on having actually tried');
});

test('a replay parks nothing either, but for a subtler reason', () => {
  // --replay requests nothing, so a posting missing from the advert cache was
  // never asked about and must not be held.
  //
  // But it is NOT the same as --no-enrich, and conflating the two cost a
  // faithful replay: skipping the enrich step entirely to avoid the network
  // threw away the 1,126 adverts already on disk, and 890 postings went to the
  // model instead of 236. A replay READS the cache and REQUESTS nothing.
  assert.match(INDEX, /const askedTheNetwork = didFetch && !replay;/,
    'a replay asks nothing, so it parks nothing');
  assert.match(INDEX, /offline: replay/,
    'but it still reads the advert cache — that is the difference from --no-enrich');
  assert.ok(!/const didFetch = !has\('--no-enrich'\) && !replay/.test(INDEX),
    'a replay must not be treated as "no enrichment at all"');
});

test('a parked posting never reaches a verdict path at all', () => {
  // It used to be gated first and then spliced back out of `passed` and
  // `uncertain`. Now the parking decision happens while `toJudge` is being
  // built, so a held posting is never gated, never scored and never sent to the
  // model — which is the exact thing that judged d691a117.
  const loop = INDEX.slice(INDEX.indexOf('  for (const job of survivors) {'), INDEX.indexOf('if (parked.length)'));
  assert.match(loop, /parked\.push/, 'parking happens inside the loop that decides what to judge');
  assert.match(loop, /parked\.push[\s\S]{0,200}continue;/, 'and it continues rather than falling through');
  assert.ok(!loop.includes('toJudge.push(job);\n      parked'), 'never both');

  const after = INDEX.slice(INDEX.indexOf('if (parked.length)'), INDEX.indexOf('parkedStore.save'));
  assert.ok(!/passed\.splice|uncertain\.splice/.test(after),
    'no splicing back out — it was never in');
});

test('LinkedIn gets a slower gap than everything else', () => {
  assert.match(ENRICH, /linkedin\[\.\]com\$\/, 2500\]/, 'and 2.5s between LinkedIn requests');
  assert.match(ENRICH, /const DEFAULT_GAP_MS = 400;/, 'others keep the measured 400ms');
});

test('one request at a time PER HOST, with unrelated hosts overlapping', async () => {
  // This used to assert `CONCURRENCY = 1` in the source. That was a global cap,
  // which made a run the sum of every host rather than the maximum — 13.9
  // minutes against 9.4 over the 864 postings a run actually fetches. The cap
  // never bound anything either: LinkedIn alone is 225 of those fetches at
  // 2500ms, which is the whole 9.4 minutes.
  //
  // Politeness is unchanged and that is the half worth testing. Asserted
  // through the queue rather than through a constant, because the constant was
  // never the guarantee — a timestamp read before an await and written after it
  // let two requests to the same host both pass the check before either
  // recorded itself, which is no gap at all at exactly the sites that answer
  // 429.
  const { politeWait } = enrich.__testables;
  const t0 = Date.now();
  const seen = [];

  await Promise.all([
    'https://one.example/a', 'https://one.example/b', 'https://one.example/c',
    'https://two.example/a', 'https://three.example/a', 'https://four.example/a',
  ].map(async (u) => {
    await politeWait(u);
    seen.push([new URL(u).host, Date.now() - t0]);
  }));

  const times = (host) => seen.filter(([h]) => h === host).map(([, t]) => t).sort((a, b) => a - b);

  const one = times('one.example');
  assert.equal(one.length, 3);
  for (let i = 1; i < one.length; i++) {
    assert.ok(one[i] - one[i - 1] >= 380, `same host must keep its gap, saw ${one[i] - one[i - 1]}ms`);
  }

  // Three other hosts, each one request: they must not have queued behind
  // one.example or behind each other.
  const others = ['two.example', 'three.example', 'four.example'].map((h) => times(h)[0]);
  for (const t of others) {
    assert.ok(t < 380 * 2, `unrelated hosts must overlap, saw ${t}ms`);
  }
});

test('Retry-After is honoured rather than guessed at', () => {
  assert.match(ENRICH, /function retryAfterMs\(res\)/);
  assert.match(ENRICH, /retry-after/);
  assert.match(ENRICH, /RETRY_AFTER_CAP_MS/, 'and capped, so one hostile header cannot stall a whole run');
});

test('a 429 parks the host, not just the one posting', () => {
  // Carrying on at the normal gap is what turned one 429 into eight.
  assert.match(ENRICH, /if \(res\.status === 429\)/);
  assert.match(ENRICH, /throttled\.set\(host/);
});

/* --------------------------------------------------------- the parked file */

test('a posting stuck for several runs is distinguishable from one throttled once', () => {
  let store = {};
  const job = { fingerprint: 'aa', title: 'Cloud Architect', company: 'X', parkedReason: 'HTTP 429' };
  parked.record(store, [job]);
  parked.record(store, [job]);
  parked.record(store, [job]);
  assert.equal(store.aa.attempts, 3);
  assert.equal(store.aa.firstParked, store.aa.firstParked, 'and keeps the first date');
});

test('a posting whose text finally arrives stops being parked', () => {
  let store = {};
  parked.record(store, [{ fingerprint: 'aa', title: 'A', company: 'X', parkedReason: 'HTTP 429' }]);
  const { store: after, freed } = parked.release(store, ['aa']);
  assert.equal(freed, 1);
  assert.deepEqual(Object.keys(after), []);
});

test('the most stuck postings are listed first', () => {
  let store = {};
  parked.record(store, [{ fingerprint: 'new', title: 'N', company: 'X', parkedReason: 'HTTP 429' }]);
  for (let i = 0; i < 4; i++) parked.record(store, [{ fingerprint: 'old', title: 'O', company: 'X', parkedReason: 'HTTP 429' }]);
  assert.deepEqual(parked.list(store).map((x) => x.fingerprint), ['old', 'new']);
});

test('the parked file is separate from seen.json, and must stay so', () => {
  // Anything in seen.json is suppressed from re-reporting. A parked posting has
  // to come back, so it cannot live there — the same reason rejections do not.
  const src = readFileSync(p('src', 'parked.js'), 'utf8');
  assert.match(src, /separate file[^]{0,20}from seen[.]json/i);
  assert.ok(!src.includes("p('data', 'seen.json')"));
});

/**
 * And a posting whose advert is never coming stops being parked.
 *
 * Parking means "we asked and it did not arrive, so come back next run" — a
 * claim about a TRANSIENT failure. After five runs it is not transient, and the
 * entry has stopped describing reality: it reports "waiting for the advert" on
 * every report, for ever, about a posting nothing will fetch. Eleven such
 * entries were on disk, all first parked the same day a week earlier.
 *
 * pending.js and rejects.js both bound themselves; this was the one store that
 * never did.
 */
test('a posting stuck for five runs is released, not held for ever', () => {
  const now = new Date().toISOString();
  const store = {
    stuck: { fingerprint: 'stuck', attempts: 5, firstParked: now },
    trying: { fingerprint: 'trying', attempts: 2, firstParked: now },
    ancient: { fingerprint: 'ancient', attempts: 1, firstParked: new Date(Date.now() - 20 * 86400e3).toISOString() },
  };
  const { store: after, removed } = parked.prune(store);
  assert.equal(removed, 2);
  assert.deepEqual(Object.keys(after), ['trying'], 'one still plausibly transient stays');
});

test('releasing is not a loss — it is judged on what the sources gave', () => {
  // The reason this is safe to do at all, recorded so nobody "fixes" it back
  // into an unbounded list: an advert that cannot be read is gated unread
  // everywhere else in this pipeline. `unreadable` is not a drop.
  const src = readFileSync(p('src', 'parked.js'), 'utf8');
  assert.match(src, /unreadable. is gated, not held/);
  assert.match(readFileSync(p('src', 'index.js'), 'utf8'),
    /parkedStore\.prune\(parkedFile\)\.removed/, 'and the run must actually call it');
});

test('a run that did not ask the network leaves the parked list alone', () => {
  // Parking is gated on having tried, and RELEASING has to be gated the same
  // way — which it was not. `release()` clears every fingerprint in `toJudge`,
  // and a replay puts the unread postings there precisely BECAUSE it cannot
  // park them. So a replay emptied the list of postings still waiting for an
  // advert, and the next real run had no memory that they were waiting.
  //
  // Two LinkedIn postings went through it. Fetched at 08:10 and refused with
  // HTTP 429, parked by the real run, then released and judged by an 18:56
  // replay: 1205fa21 (DAK-Gesundheit, Hamburg) and 065790db (Vattenfall,
  // Berlin). Both reached the report on `workMode: 'onsite'` assumed from the
  // city in the alert email, with nothing read, and both were turned down by
  // hand — one of them as `closed`, which nobody could know without the advert.
  //
  // --dry-run is here for the plainer reason: it promises to write nothing, and
  // parked.json was the one write that happened anyway.
  const block = INDEX.slice(INDEX.indexOf('if (parked.length)'), INDEX.indexOf('phase 2.1'));

  assert.match(block, /if \(askedTheNetwork && !dryRun\) \{/,
    'the whole parked-file block is gated on having tried, and on writing at all');

  for (const call of ['parkedStore.load', 'parkedStore.release', 'parkedStore.record', 'parkedStore.save']) {
    const at = block.indexOf(call);
    assert.ok(at > block.indexOf('if (askedTheNetwork && !dryRun)'),
      `${call}() must sit inside the guard, not before it`);
  }
});
