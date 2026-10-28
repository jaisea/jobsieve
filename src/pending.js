import { existsSync } from 'node:fs';
import { p, readJson, writeJson } from './util.js';

/**
 * DEFERRED ADJUDICATION QUEUE
 *
 * There is no call cap any more: a run adjudicates everything it can until the
 * provider says stop (per-day quota, hard rate limit). Whatever it did not
 * reach lands here, and the next run picks it up.
 *
 * Ordering is deliberate — today's postings are judged FIRST, then the backlog.
 * A fresh posting is worth more than a day-old one you have already survived
 * without, and if the quota runs out again the backlog simply waits another
 * day rather than crowding out new work.
 *
 * The queue stores fingerprints only. The postings themselves come back from
 * the sources on the next run anyway, so there is nothing to keep alive here —
 * this is a record of *what still owes a verdict*, not a copy of the data.
 */
const FILE = p('data', 'pending.json');

export function load() {
  if (!existsSync(FILE)) return {};
  return readJson(FILE, {});
}

export const save = (q) => writeJson(FILE, q);

/** Mark fingerprints as still owing a verdict. */
export function defer(queue, items, reason) {
  const now = new Date().toISOString();
  for (const item of items) {
    const fp = item.job.fingerprint;
    const prev = queue[fp];
    queue[fp] = {
      title: item.job.title,
      company: item.job.company,
      firstDeferred: prev?.firstDeferred || now,
      lastDeferred: now,
      attempts: (prev?.attempts || 0) + 1,
      reason,
    };
  }
  return queue;
}

/** A verdict arrived — it no longer owes one. */
export function resolve(queue, fingerprints) {
  for (const fp of fingerprints) delete queue[fp];
  return queue;
}

/**
 * Drop entries that keep failing. Without this, a posting that always errors
 * would sit at the front of the queue forever and starve the rest.
 */
export function prune(queue, { maxAttempts = 5, maxAgeDays = 14 } = {}) {
  const cutoff = Date.now() - maxAgeDays * 86400000;
  let removed = 0;
  for (const [fp, e] of Object.entries(queue)) {
    if (e.attempts >= maxAttempts || new Date(e.firstDeferred).getTime() < cutoff) {
      delete queue[fp];
      removed++;
    }
  }
  return { queue, removed };
}

export const size = (queue) => Object.keys(queue).length;

/**
 * Today's postings first, yesterday's leftovers after — the whole point of the
 * queue. Returns the same items, reordered.
 */
export function orderNewFirst(items, queue) {
  const fresh = [];
  const backlog = [];
  for (const item of items) {
    (queue[item.job.fingerprint] ? backlog : fresh).push(item);
  }
  // Oldest backlog entries first, so nothing starves indefinitely.
  backlog.sort((a, b) =>
    new Date(queue[a.job.fingerprint].firstDeferred) - new Date(queue[b.job.fingerprint].firstDeferred));
  return { ordered: [...fresh, ...backlog], fresh: fresh.length, backlog: backlog.length };
}
