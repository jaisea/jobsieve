import { existsSync } from 'node:fs';
import { p, readJson, writeJson } from './util.js';

/**
 * Postings that are waiting for the AI, not judged by the rules in its place.
 *
 * When the model answered "slow down" (a per-minute limit) or "that is enough for
 * today" (the daily quota), the pipeline used to give every posting it had not
 * reached its RULES verdict and carry on. That verdict is the one the rules
 * already could not settle — it is the reason the posting was sent to the model —
 * so a keep was a coin toss and a drop was a posting the user would never see.
 *
 * Now those postings are held here instead. They are not reported, not archived
 * as rejections and not counted as open jobs; they wait, whole, with the question
 * the rules could not answer, and are asked again once the limit has reset.
 *
 * WHAT IS STORED is the item the adjudicator was handed — the normalized, scored
 * posting plus its uncertainties and the rules' fallback. Unlike `pending.js`
 * (fingerprints only, because the posting comes back from its source next run)
 * this has to keep the posting: its source is asleep for hours and may not return
 * it at all, so a record of "what still owes a verdict" is not enough to ask the
 * question later.
 *
 * `hold` says WHEN to try again. It is one value for the whole queue, because the
 * limit is per project, not per posting: a daily quota that is spent is spent for
 * everything in the queue.
 */
const FILE = () => p('data', 'awaiting.json');

/** A little past the reset, so the first request does not land on the old day. */
export const RESET_MARGIN_MS = 2 * 60000;

/** A per-minute limit that outlasted its retries: come back in a few minutes. */
export const MINUTE_BACKOFF_MS = 3 * 60000;

/**
 * Give up after this long. Nothing waits for ever: after a fortnight the advert
 * the question was about is very likely gone, and the posting takes its rules
 * verdict, said out loud, like any other the model never answered.
 */
export const MAX_AGE_DAYS = 14;

export const empty = () => ({ version: 1, items: {}, hold: null });

export function load() {
  if (!existsSync(FILE())) return empty();
  const d = readJson(FILE(), null);
  return d && typeof d === 'object' && d.items ? { ...empty(), ...d } : empty();
}

export const save = (state) => writeJson(FILE(), { ...state, savedAt: new Date().toISOString() }, { pretty: false });

export const size = (state) => Object.keys(state.items).length;

/**
 * Hold postings. A posting already waiting keeps its original `queuedAt`, so the
 * fortnight is counted from the first time it was refused, not the last.
 */
export function add(state, items, { source = null, label = null, reason = null, now = new Date() } = {}) {
  const at = now.toISOString();
  for (const item of items) {
    const fp = item.job.fingerprint;
    const prev = state.items[fp];
    state.items[fp] = {
      item,
      source: source ?? prev?.source ?? item.job.source ?? null,
      label: label ?? prev?.label ?? null,
      reason: reason ?? prev?.reason ?? null,
      queuedAt: prev?.queuedAt || at,
      lastTriedAt: at,
      attempts: (prev?.attempts || 0) + 1,
    };
  }
  return state;
}

/** They have a verdict now — or were ruled on by hand, or went stale. */
export function resolve(state, fingerprints) {
  for (const fp of fingerprints) delete state.items[fp];
  return state;
}

/** Oldest first, so nothing is starved by a newer arrival. */
export const entries = (state) => Object.values(state.items)
  .sort((a, b) => new Date(a.queuedAt) - new Date(b.queuedAt));

/** Set when the model refuses; `until` is when to try again. */
export function setHold(state, { scope, until, reason = null, now = new Date() }) {
  state.hold = { scope, until: new Date(until).toISOString(), reason, since: now.toISOString() };
  return state;
}

export function clearHold(state) {
  state.hold = null;
  return state;
}

/** Anything waiting, and the hold (if any) has run out. */
export function isDue(state, now = new Date()) {
  if (!size(state)) return false;
  return !state.hold || new Date(state.hold.until) <= now;
}

/** When it will next be worth asking, or null if now is fine (or nothing waits). */
export function resumeAt(state, now = new Date()) {
  if (!size(state) || !state.hold) return null;
  const at = new Date(state.hold.until);
  return at > now ? at : null;
}

/**
 * Those that have waited past `MAX_AGE_DAYS`. Removed from the queue and handed
 * back, so the caller can give them their rules verdict openly.
 */
export function expire(state, { maxAgeDays = MAX_AGE_DAYS, now = new Date() } = {}) {
  const cutoff = now.getTime() - maxAgeDays * 86400000;
  const gone = [];
  for (const [fp, e] of Object.entries(state.items)) {
    if (new Date(e.queuedAt).getTime() < cutoff) { gone.push(e); delete state.items[fp]; }
  }
  return gone;
}

/**
 * The next midnight in Pacific time, plus a margin: when Google's per-project
 * daily quota resets. In Germany that is 09:00 (08:00 or 10:00 for the few weeks
 * a year the two sides' clocks disagree about daylight saving).
 *
 * Worked out with Intl rather than a fixed offset, because Pacific time moves.
 * The offset is taken twice — now and at the candidate instant — since a clock
 * change between the two would otherwise be off by an hour.
 */
export function nextQuotaReset(now = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles', hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const parts = (d) => Object.fromEntries(fmt.formatToParts(d).map((x) => [x.type, x.value]));
  /** Local Pacific clock read as if it were UTC, minus the real instant: the (negative) offset. */
  const offsetAt = (d) => {
    const q = parts(d);
    const asUtc = Date.UTC(+q.year, +q.month - 1, +q.day, +q.hour, +q.minute, +q.second);
    return asUtc - Math.floor(d.getTime() / 1000) * 1000;
  };

  const q = parts(now);
  const midnightAsUtc = Date.UTC(+q.year, +q.month - 1, +q.day + 1, 0, 0, 0);
  const guess = new Date(midnightAsUtc - offsetAt(now));
  const at = new Date(midnightAsUtc - offsetAt(guess));
  return new Date(at.getTime() + RESET_MARGIN_MS);
}

const hhmm = (d) => d.toTimeString().slice(0, 5);
const sameDay = (a, b) => a.toDateString() === b.toDateString();

/**
 * What to tell the person, in the words they would use. One place, so the tray,
 * the page and the terminal cannot describe the same wait three ways.
 */
export function describe(state, now = new Date()) {
  const waiting = size(state);
  if (!waiting) return { waiting: 0, scope: null, resumeAt: null, text: '' };

  const noun = `${waiting} posting${waiting === 1 ? '' : 's'} waiting for the AI`;
  const at = resumeAt(state, now);
  const scope = state.hold?.scope || null;
  if (!at) return { waiting, scope, resumeAt: null, text: `${noun} — will be judged on the next scan` };

  const when = sameDay(at, now) ? hhmm(at)
    : `${at.toLocaleDateString('en-GB', { weekday: 'short' })} ${hhmm(at)}`;
  const why = scope === 'day' ? 'daily limit reached, resumes about'
    : scope === 'minute' ? 'rate limited, retrying about'
      : 'resumes about';
  return { waiting, scope, resumeAt: at.toISOString(), text: `${noun} — ${why} ${when}` };
}
