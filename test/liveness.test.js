/**
 * Whether a posting is still there — phase 1.2.
 *
 * The `closed` gate had never fired on a fresh posting in the life of the
 * project. `closed` was set only by the enricher, from a LinkedIn-specific HTML
 * class, and the re-gate after enrichment did not pass it back in. Meanwhile
 * 404 and 410 were cached as ordinary fetch failures and the posting went
 * through every gate unread.
 *
 * The rules below were MEASURED, not guessed. All eight postings that had been
 * marked "no longer accepting applications" were re-fetched, with two
 * known-live Arbeitsagentur postings as a control. Four of the eight were
 * detectable and three of those four were HTTP status:
 *
 *   adzuna.de            410                                    caught
 *   arbeitsagentur.de    410                                    caught
 *   linkedin guest card  404                                    caught
 *   linkedin guest card  200 + closed-job__flavor--closed       caught
 *   linkedin guest card  200, 8,310-char description, no marker missed
 *   linkedin guest card  200, 5,570-char description, no marker missed
 *   arbeitsagentur.de    200, ld+json intact, datePosted 59d    missed
 *   arbeitsagentur.de    200, ld+json intact, datePosted 583d   missed
 *
 * The four misses are accepted. Do not add speculative heuristics — description
 * length, apply-button presence, datePosted age — to chase them: each would
 * cost real postings, and a wrong drop costs an opportunity never seen.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { p } from '../src/util.js';
import { livenessOf, isGoneStatus, looksClosed, isTransient } from '../src/enrich.js';
import { normalize } from '../src/normalize.js';
import { gate } from '../src/filter.js';
import * as rejects from '../src/rejects.js';

const profile = JSON.parse(readFileSync(p('config', 'examples', 'devops.profile.json'), 'utf8'));
const ENRICH = readFileSync(p('src', 'enrich.js'), 'utf8');
const INDEX = readFileSync(p('src', 'index.js'), 'utf8');

/* ------------------------------------------------------ which status counts */

test('410 is gone, from anyone', () => {
  // Adzuna and Arbeitsagentur both return it correctly for a withdrawn
  // posting. It is the only status a server sends when it means exactly this.
  assert.equal(isGoneStatus(410, false), true);
  assert.equal(isGoneStatus(410, true), true);
});

test('404 is gone only from an endpoint keyed by job id', () => {
  // The LinkedIn guest card is /jobPosting/{id}, so a 404 there means no such
  // posting — and one of the eight was exactly that. From a human page or an
  // aggregator redirect a 404 is often just a broken link.
  assert.equal(isGoneStatus(404, true), true, 'guest card / job API');
  assert.equal(isGoneStatus(404, false), false, 'a human page or a redirect');
});

test('403 is never gone', () => {
  // This project spent months believing the Arbeitsagentur API was WAF-blocked
  // when the endpoint had simply been retired. Re-checked while planning this:
  // its jobdetails endpoint still answers 403 for LIVE postings.
  assert.equal(isGoneStatus(403, true), false);
  assert.equal(isGoneStatus(403, false), false);
  assert.equal(livenessOf({ error: 'HTTP 403' }).state, 'unreadable');
});

test('a Greenhouse board index redirect is gone, but a plain redirect is not', () => {
  // A dead Greenhouse job 302s to /{board}?error=true — confirmed against a
  // deliberately bogus job id on the same board, which behaves identically.
  // But a LIVE Greenhouse job ALSO redirects, to a slug URL on the employer's
  // own domain, and also carries no JobPosting ld+json. So neither
  // "redirected" nor "no ld+json" is a signal on its own.
  assert.match(ENRICH, /\[\?&\]error=true/, 'the explicit marker is what is detected');
  assert.match(ENRICH, /res\.url/, 'read from the FINAL url, after redirects');
  assert.ok(!/redirected\s*\?\s*true/.test(ENRICH), 'a bare redirect must never mean gone');
});

/* ------------------------------------------------------------- five states */

test('one cache entry, one liveness answer', () => {
  // Five states so search(), rejudge() and `npm run why` cannot form different
  // opinions from the same entry — which is how `closed` came to fire on
  // carried jobs and never on fresh ones.
  const cases = [
    [{ text: 'x'.repeat(900) }, 'open'],
    [{ error: 'no JobPosting structured data on the page', closed: true }, 'closed'],
    [{ error: 'HTTP 410', gone: true }, 'gone'],
    [{ error: 'no JobPosting structured data on the page' }, 'unreadable'],
    [{ error: 'HTTP 403' }, 'unreadable'],
    [{ error: 'HTTP 429' }, 'unknown'],
    [{ error: 'description came back empty' }, 'unknown'],
    [undefined, 'unknown'],
  ];
  for (const [hit, want] of cases) {
    assert.equal(livenessOf(hit).state, want, JSON.stringify(hit));
  }
});

test('gone and closed carry evidence a person can read', () => {
  assert.match(livenessOf({ error: 'HTTP 410', gone: true }).evidence, /no longer there.*HTTP 410/);
  assert.match(livenessOf({ closed: true }).evidence, /no longer accepting applications/);
});

test('unreadable is not a drop', () => {
  // 37 entries on disk are pages that have never carried structured data.
  // Dropping them would delete postings for the sin of a bad careers page; they
  // go through the gates on what little is known, exactly as before.
  assert.equal(livenessOf({ error: 'no JobPosting structured data on the page' }).state, 'unreadable');
  const block = INDEX.slice(INDEX.indexOf('  for (const job of survivors) {'), INDEX.indexOf('if (parked.length)'));
  assert.match(block, /l\.state === 'gone' \|\| l\.state === 'closed'/, 'only these two drop');
  // It may park a posting whose source only ever gives a teaser (Adzuna), never drop one.
  const uses = block.match(/l.state === 'unreadable'/g) || [];
  assert.equal(uses.length, 1, 'unreadable appears once, in the parking line');
  assert.ok(block.includes("l.state === 'unreadable' && TEASER_SOURCES.includes(job.source)"));
  assert.ok(!/noteDrop\([^)]*unreadable/.test(block), 'unreadable must not be a drop');
});

/* ----------------------------------------- the closed flag reaches the gate */

test('the closed marker survives a failed fetch', () => {
  // It was stored only when the fetch SUCCEEDED, so a LinkedIn card that said
  // "no longer accepting applications" and also failed to yield a description
  // lost the flag entirely — the two things most likely to happen together.
  assert.match(ENRICH, /transient: isTransient\(r\.error\)[\s\S]{0,120}closed: Boolean\(r\.closed\)/,
    'the failure branch of the cache write must persist closed');
  assert.match(ENRICH, /gone: Boolean\(r\.gone\)/, 'and gone');
});

test('looksClosed is exported, so its test cannot drift from the real one', () => {
  // The test used to re-implement the regex locally, which meant it could pass
  // while the shipped one rotted.
  assert.equal(typeof looksClosed, 'function');
  assert.equal(looksClosed('<div class="closed-job__flavor--closed">'), true, 'the class is the reliable half');
  assert.equal(looksClosed('No longer accepting applications'), true);
  assert.equal(looksClosed('<div class="jobs-apply-button">Apply</div>'), false);
});

test('a closed posting is a certain drop that names why', () => {
  const job = normalize({
    source: 'adzuna', sourceId: '1', title: 'Senior DevOps Engineer', company: 'Seqonis',
    location: 'Berlin, Germany', applyUrl: 'https://www.adzuna.de/details/5790092141',
    descriptionText: 'x'.repeat(900),
    closed: true, closedEvidence: 'the posting is no longer there (HTTP 410)',
  }, profile);

  assert.equal(job.closed, true, 'normalize must carry it');
  assert.equal(job.closedEvidence, 'the posting is no longer there (HTTP 410)');

  const v = gate(job, profile);
  assert.equal(v.keep, false);
  assert.equal(v.certain, true);
  assert.equal(v.category, 'closed');
  assert.match(v.reason, /HTTP 410/);
});

test('the four real cases each reach a certain closed drop', () => {
  const fixtures = [
    ['adzuna 410', { error: 'HTTP 410', gone: true }],
    ['arbeitsagentur 410', { error: 'HTTP 410', gone: true }],
    ['linkedin guest card 404', { error: 'HTTP 404', gone: true }],
    ['linkedin closed marker', { error: 'no JobPosting structured data on the page', closed: true }],
  ];
  for (const [label, hit] of fixtures) {
    const l = livenessOf(hit);
    assert.ok(l.state === 'gone' || l.state === 'closed', `${label}: got ${l.state}`);

    const job = normalize({
      source: 's', sourceId: '1', title: 'Senior DevOps Engineer', company: 'X',
      location: 'Berlin, Germany', applyUrl: 'https://example.invalid/1',
      descriptionText: 'x'.repeat(900), closed: true, closedEvidence: l.evidence,
    }, profile);
    const v = gate(job, profile);
    assert.equal(v.category, 'closed', label);
    assert.equal(v.certain, true, label);
  }
});

test('a live posting with a full description is never called gone', () => {
  // Two of the eight served 5-8k characters with no marker of any kind. They
  // are missed, and that is the accepted answer — but nothing may guess.
  const l = livenessOf({ text: 'x'.repeat(8310) });
  assert.equal(l.state, 'open');

  const job = normalize({
    source: 's', sourceId: '1', title: 'Senior DevOps Engineer', company: 'X',
    location: 'München, Germany', applyUrl: 'https://example.invalid/1',
    descriptionText: 'We are looking for a DevOps engineer. '.repeat(40),
  }, profile);
  assert.equal(job.closed, false);
  assert.notEqual(gate(job, profile).category, 'closed');
});

/* ------------------------------------------------ the archive keeps it too */

test('a closed drop is archived with the signal that caused it', () => {
  // `npm run why` replays the gates against the archive. A signal a gate reads
  // that the archive does not keep makes the replay disagree with the run.
  const job = normalize({
    source: 's', sourceId: '1', title: 'Senior DevOps Engineer', company: 'X',
    location: 'Berlin, Germany', applyUrl: 'https://example.invalid/1',
    descriptionText: 'x'.repeat(900), closed: true,
    closedEvidence: 'the posting is no longer there (HTTP 410)',
  }, profile);

  const v = gate(job, profile);
  const archive = rejects.record({}, job, { reason: v.reason, category: v.category, reasons: v.reasons });
  const entry = archive[job.fingerprint];

  assert.equal(entry.closed, true, 'the archive must keep it');
  assert.match(entry.closedEvidence, /HTTP 410/);

  const replay = gate({ ...entry, descriptionText: entry.excerpt || '' }, profile);
  assert.equal(replay.category, 'closed', 'and the replay must reach the same gate');
  assert.equal(replay.certain, v.certain);
});

test('a reviewed archive entry still gains a signal it did not have', () => {
  // record() early-returns for reviewed entries to keep them slim. 7,807 of the
  // archive are reviewed, so without refreshing the derived signals they could
  // never gain a field again — `why` would replay closed: undefined and say
  // "would pass" where the run said "closed".
  const job = normalize({
    source: 's', sourceId: '1', title: 'Senior DevOps Engineer', company: 'X',
    location: 'Berlin, Germany', applyUrl: 'https://example.invalid/1',
    descriptionText: 'x'.repeat(900),
  }, profile);

  const archive = {
    [job.fingerprint]: {
      fingerprint: job.fingerprint, title: job.title, company: job.company,
      category: 'closed', reason: 'old', reviewedAt: '2026-01-01T00:00:00.000Z',
      runs: 3, slimmed: true,
    },
  };

  const shut = { ...job, closed: true, closedEvidence: 'the posting is no longer there (HTTP 410)' };
  rejects.record(archive, shut, { reason: 'gone', category: 'closed' });

  const e = archive[job.fingerprint];
  assert.equal(e.reviewedAt, '2026-01-01T00:00:00.000Z', 'still reviewed');
  assert.ok(!e.excerpt, 'still slim — the excerpt is what the slimming was for');
  assert.equal(e.closed, true, 'but the signal is refreshed');
  assert.match(e.closedEvidence, /HTTP 410/);
});

/* ------------------------------------------------------------- carried jobs */

test('a carried job that is gone is retired even with no new text', () => {
  // rejudge() returned early unless the cached text was LONGER than the stored
  // one. A gone entry has no text at all, so it left untouched and the `closed`
  // flag was never applied — the only path that ever applied it.
  const fn = INDEX.slice(INDEX.indexOf('function rejudge('), INDEX.indexOf('function rejudge(') + 2200);
  assert.match(fn, /const live = livenessOf\(hit\)/, 'rejudge must ask about liveness');
  assert.match(fn, /if \(!better && live\.state !== 'closed' && live\.state !== 'gone'\) return j;/,
    'and being gone must be a reason to re-normalize even with nothing new to read');
  assert.match(fn, /closedEvidence: shut \? live\.evidence : null/);
});

test('transient failures still park rather than being called gone', () => {
  assert.ok(isTransient('HTTP 429'));
  assert.equal(livenessOf({ error: 'HTTP 429' }).state, 'unknown');
  assert.notEqual(livenessOf({ error: 'HTTP 429' }).state, 'gone');
});
