import { existsSync } from 'node:fs';
import { p, readJson, writeJson } from './util.js';

/**
 * Postings held back because their advert never arrived.
 *
 * A job with no description has nothing to judge. The rules find no language
 * requirement — because there is no text — the model is asked to guess from the
 * title, and whatever it says is filed under a reject category as though the
 * advert had been read. A Senior Cloud Solutions Architect role demanding
 * "Verhandlungssichere Deutsch- und Englischkenntnisse" reached the report at
 * 70/100 that way. Eight LinkedIn fetches were rate-limited in that one run and
 * five of those postings were judged blind.
 *
 * So they are parked instead: kept out of the verdict entirely, listed at the
 * end of the report, and retried on the next run. Deliberately a separate file
 * from seen.json — anything in that index is suppressed from re-reporting, and
 * a parked posting must come back.
 */

const FILE = p('data', 'parked.json');

export const load = () => (existsSync(FILE) ? readJson(FILE, {}).parked || {} : {});

export const save = (parked) =>
  writeJson(FILE, { version: 1, savedAt: new Date().toISOString(), parked });

/**
 * Fold this run's held postings into the file.
 *
 * `attempts` counts how many runs have failed to get the text. A posting stuck
 * at the same error for days is a different problem from one throttled once,
 * and only the count tells them apart.
 */
export function record(store, jobs, { now = new Date().toISOString() } = {}) {
  for (const j of jobs) {
    const prev = store[j.fingerprint];
    store[j.fingerprint] = {
      fingerprint: j.fingerprint,
      title: j.title,
      company: j.company,
      location: j.location,
      applyUrl: j.applyUrl,
      source: j.source,
      sourceLabel: j.sourceLabel ?? j.source,
      score: j.score ?? null,
      reason: j.parkedReason,
      firstParked: prev?.firstParked || now,
      lastParked: now,
      attempts: (prev?.attempts || 0) + 1,
    };
  }
  return store;
}

/** Clear the ones that finally came through, so the list only holds live problems. */
export function release(store, fingerprints) {
  let freed = 0;
  for (const fp of fingerprints) if (store[fp]) { delete store[fp]; freed++; }
  return { store, freed };
}

/** Oldest first — a posting stuck for three runs matters more than today's. */
export const list = (store) => Object.values(store)
  .sort((a, b) => (b.attempts - a.attempts) || new Date(a.firstParked) - new Date(b.firstParked));

/**
 * Give up on a posting whose advert is never going to arrive.
 *
 * Parking means "we asked and it did not arrive, so come back next run" — a
 * statement about a TRANSIENT failure. After five runs it is not transient any
 * more, and the entry has stopped describing reality: it reports "waiting for
 * the advert" on every report, for ever, about a posting nothing will ever
 * fetch. There are 11 such entries on disk right now, all first parked on the
 * same day a week ago.
 *
 * `pending.js` and `rejects.js` both bound themselves this way; this file was
 * the one store that never did.
 *
 * Releasing it is not a loss. The posting is simply judged next run on what the
 * sources gave, which is what happens to every advert that cannot be read —
 * `unreadable` is gated, not held. Better a thin verdict than a permanent
 * "pending" nobody can act on.
 */
export function prune(store, { maxAttempts = 5, maxAgeDays = 14 } = {}) {
  const cutoff = Date.now() - maxAgeDays * 86400000;
  let removed = 0;
  for (const [fp, e] of Object.entries(store)) {
    if (e.attempts >= maxAttempts || new Date(e.firstParked).getTime() < cutoff) {
      delete store[fp];
      removed++;
    }
  }
  return { store, removed };
}
