/**
 * How long each source sleeps between fetches.
 *
 * The background app wakes every half hour, but the SOURCES do not all deserve
 * that. Adzuna is 42 requests a run against 250 a day, Workday is up to 355, a
 * company board changes a few times a week. One global interval is either too
 * slow for the inbox or hammers everything else — so each source declares its own
 * `sleepMinutes` in sources.json, and a wake-up only fetches the ones whose sleep
 * is over.
 *
 * This is deliberately NOT part of quota.js. A quota protects a metered API and
 * only exists for the two sources that are metered; a sleep applies to every
 * source, including the ones with no quota at all. The two compose — a source can
 * be due here and still be refused there.
 *
 * Only a `--due-only` search CONSULTS this. A manual `npm run search` fetches
 * everything, because you asked for it by hand — but it still records the time,
 * so the app does not fetch the same source again the minute after.
 */
import { p, readJson, writeJson } from './util.js';

const FILE = () => p('data', 'schedule.json');

/** A source with no `sleepMinutes` of its own. Slow on purpose: not overdoing it is the default. */
export const DEFAULT_SLEEP_MINUTES = 360;

/** After a failed fetch, try again this soon instead of waiting out the whole sleep. */
export const RETRY_MINUTES = 30;

export const load = () => readJson(FILE(), { version: 1, sources: {} });
export const save = (state) => writeJson(FILE(), { ...state, savedAt: new Date().toISOString() });

const isSource = (key, v) =>
  !key.startsWith('_') && v && typeof v === 'object' && !Array.isArray(v) && v.enabled;

export function sleepMinutes(cfg) {
  const n = Number(cfg?.sleepMinutes);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_SLEEP_MINUTES;
}

/** When the source wakes up. `null` means it has never run, so it is due now. */
export function wakesAt(state, key, cfg) {
  const last = state.sources?.[key]?.lastRunAt;
  if (!last) return null;
  return new Date(new Date(last).getTime() + sleepMinutes(cfg) * 60000);
}

export function isDue(state, key, cfg, now = new Date()) {
  const at = wakesAt(state, key, cfg);
  return !at || at <= now;
}

/** Keys of the enabled sources whose sleep is over. */
export function dueSources(sourcesCfg, state, now = new Date()) {
  return Object.entries(sourcesCfg)
    .filter(([key, v]) => isSource(key, v) && isDue(state, key, v, now))
    .map(([key]) => key);
}

/**
 * Record that a source was attempted.
 *
 * `failed` shortens the sleep rather than skipping the record. A laptop that
 * wakes without a network would otherwise put Workday to sleep for six hours on
 * the strength of a fetch that returned nothing; retrying in half an hour is the
 * right answer to "it did not arrive", and a full sleep is the right answer to
 * "it arrived and there was nothing new".
 */
export function touch(state, key, cfg, { now = new Date(), failed = false } = {}) {
  const sleepMs = sleepMinutes(cfg) * 60000;
  const retryMs = RETRY_MINUTES * 60000;
  const at = failed && sleepMs > retryMs ? new Date(now.getTime() - (sleepMs - retryMs)) : now;
  state.sources = { ...state.sources, [key]: { lastRunAt: at.toISOString(), failed } };
  return state;
}

/**
 * Write down every source a run attempted, once the run has completed.
 *
 * `attempts` is `{ key: { cfg, failed } }`. This is called at the END of a search,
 * after its results are saved — never when a request is sent. A source is done
 * when what it returned is safely on disk, not before: recording it at the start
 * meant a scan cut off mid-run (the tray quit, a laptop closed) left its sources
 * asleep for hours, with up to a day for JSearch, over results that were never
 * saved. An interrupted run now records nothing, so the same sources are simply
 * due again at the next look.
 *
 * An `offline` attempt is not recorded either. Nothing was fetched and nothing failed
 * in a way worth waiting out: there was no connection, so the source stays due and
 * is tried the moment one is back — not after a 30-minute retry meant for a server
 * that answered badly.
 */
export function commit(state, attempts, { now = new Date() } = {}) {
  for (const [key, a] of Object.entries(attempts)) {
    if (a.offline) continue;
    touch(state, key, a.cfg, { now, failed: a.failed });
  }
  return state;
}

/** For the tray: when something will next be worth fetching, or null if it already is. */
export function nextWake(sourcesCfg, state, now = new Date()) {
  let soonest = null;
  for (const [key, v] of Object.entries(sourcesCfg)) {
    if (!isSource(key, v)) continue;
    const at = wakesAt(state, key, v);
    if (!at || at <= now) return null;
    if (!soonest || at < soonest) soonest = at;
  }
  return soonest;
}
