import { existsSync } from 'node:fs';
import { p, readJson, writeJson, sha1 } from './util.js';
import { rulesVersion } from './mailstate.js';

/**
 * Postings the title alone has already settled, remembered between scans.
 *
 * Phase 1.1 drops 78% of everything fetched on its TITLE, and every scan fetches the same
 * listings again. Each of those postings was fully analysed first — language tiers, programming
 * and AWS detection, 87 skill patterns over the advert — only so that the archive could record
 * every reason it fails. For the company boards that is 6,088 postings and about 110 seconds of
 * single-threaded CPU per scan, during which nothing else (a mail batch, another source's
 * saves) can run, to re-derive an answer that cannot have changed.
 *
 * It cannot have changed because the title gates are a pure function of the title, the code and
 * the profile. So the answer is kept, keyed by what identifies the posting, and a posting
 * recognised from the last scan is counted and skipped without being normalized at all.
 *
 * What invalidates it, and why each is enough:
 *   - the RULES VERSION (a hash of all of src/ and the profile — see mailstate.js) changed: every
 *     entry is discarded, so a gate edit takes effect on the next scan exactly as it did when
 *     everything was re-derived every time;
 *   - the posting's title, company, location or id changed: it is a different key, so it is
 *     analysed in full;
 *   - REEVALUATE_DAYS passed: it is analysed in full again, which also refreshes its archive
 *     entry (the archive forgets what it has not seen lately, and a skipped posting is not seen);
 *   - it was not listed for FORGET_DAYS: the entry is dropped, so the file does not grow for ever.
 *
 * Only CERTAIN title drops are remembered. A soft drop (a near-miss title) is a question for the
 * model and goes through the whole pipeline every time.
 */
const FILE = () => p('data', 'title-drops.json');

/** A remembered drop is analysed in full again after this long. */
export const REEVALUATE_DAYS = 3;
/** An entry for a posting no longer listed is forgotten after this long. */
export const FORGET_DAYS = 7;

/**
 * What identifies a posting for this purpose: the same fields the source reported, trimmed and
 * lower-cased. The advert text is deliberately NOT part of it — a title decision does not depend
 * on it. The id is the source's own where it has one, otherwise the apply URL without its tracking
 * query, which changes in every alert email.
 */
export function keyOf(job) {
  const id = job.sourceId || String(job.applyUrl || '').replace(/[?#].*$/, '');
  return sha1([job.source, id, job.title, job.company, job.location]
    .map((x) => String(x ?? '').trim().toLowerCase()).join('|'));
}

export function load({ rules = rulesVersion() } = {}) {
  const d = existsSync(FILE()) ? readJson(FILE(), null) : null;
  // Another rules version: every entry was decided under rules that no longer exist.
  if (!d || typeof d !== 'object' || d.rules !== rules || !d.drops) {
    return { version: 1, rules, drops: {}, changed: Boolean(d) };
  }
  return { ...d, changed: false };
}

const days = (ms) => ms / 86400000;

/** The remembered drop for this posting, if it is recent enough to trust; marks it as listed today. */
export function lookup(memo, job, { now = new Date() } = {}) {
  const e = memo.drops[keyOf(job)];
  if (!e) return null;
  if (days(now - new Date(e.at)) >= REEVALUATE_DAYS) return null;
  e.seen = now.toISOString();
  memo.changed = true;
  return e;
}

/** A posting the title settled, after it was analysed in full. */
export function remember(memo, job, { reason, reasons, now = new Date() }) {
  memo.drops[keyOf(job)] = {
    at: now.toISOString(),
    seen: now.toISOString(),
    reason,
    // Compact: [gate id, certain?]. Enough to count how often each gate fires without the posting.
    reasons: (reasons || []).map((r) => [r.id, r.certain ? 1 : 0]),
  };
  memo.changed = true;
}

/** The reasons a remembered posting failed, in the shape gatestats.tally() takes. */
export const reasonsOf = (entry) => (entry.reasons || []).map(([id, certain]) => ({ id, certain: Boolean(certain) }));

/** Forget what is no longer listed, and write — only if anything changed. */
export function save(memo, { now = new Date() } = {}) {
  for (const [k, e] of Object.entries(memo.drops)) {
    if (days(now - new Date(e.seen)) >= FORGET_DAYS) { delete memo.drops[k]; memo.changed = true; }
  }
  if (!memo.changed) return false;
  const { changed, ...out } = memo;
  writeJson(FILE(), { ...out, savedAt: now.toISOString() }, { pretty: false });
  memo.changed = false;
  return true;
}
