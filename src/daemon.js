/**
 * What the background app decides, with no Electron in it.
 *
 * The tray app is a thin shell: a timer, an icon and a menu. Everything it has to
 * DECIDE — which sources are due, how many jobs are waiting, when the next fetch
 * can happen — lives here as plain functions, so it can be tested under
 * `node --test` and so the shell has nothing clever left in it to get wrong.
 */
import { statSync } from 'node:fs';
import { p, readJson, writeJson } from './util.js';
import * as schedule from './schedule.js';
import * as queueStore from './queue.js';
import * as store from './store.js';
import * as judging from './judging.js';

/**
 * `tickMinutes` is how often the app LOOKS, not how often it fetches. Each source
 * still sleeps its own interval (sources.json), so a half-hour tick costs a cheap
 * check, not thirty-odd requests.
 */
export const DEFAULTS = { tickMinutes: 30, port: 8787, notifications: true };

const PREFS = () => p('data', 'daemon.json');

/** `profile.daemon` over the defaults. A fresh clone has no profile.json, so fall back to the example. */
export function settings() {
  const profile = readJson(process.env.JOBHUNT_PROFILE || p('config', 'profile.json'), null) ?? readJson(p('config', 'profile.example.json'), {});
  const d = profile.daemon || {};
  const tick = Number(d.tickMinutes);
  const port = Number(d.port);
  return {
    tickMinutes: Number.isFinite(tick) && tick >= 5 ? tick : DEFAULTS.tickMinutes,
    port: Number.isInteger(port) && port > 0 && port < 65536 ? port : DEFAULTS.port,
    notifications: d.notifications ?? DEFAULTS.notifications,
  };
}

/** What the menu toggles. Kept in data/ because it is state, not configuration. */
export const loadPrefs = () => ({ paused: false, ...readJson(PREFS(), {}) });
export const savePrefs = (prefs) => writeJson(PREFS(), prefs);

/** Which enabled sources are past their sleep, and when the first of the rest wakes. */
export function plan(now = new Date()) {
  const cfg = readJson(p('config', 'sources.json'));
  const state = schedule.load();
  const wait = judging.status(now);
  return {
    due: schedule.dueSources(cfg, state, now),
    wakes: schedule.nextWake(cfg, state, now),
    // Postings the model has not answered, or a source fetched and never judged: worth a
    // run of their own once the limit has reset, even when no source is due.
    judge: wait.due,
    // When the model's wait ends, if it has not already.
    judgeAt: wait.resumeAt ? new Date(wait.resumeAt) : null,
  };
}

/**
 * How long to sleep when nothing is due: the usual tick, or less if the model's rate
 * limit lifts before it. A quota that resets at 09:02 should be used at 09:02, not at
 * the first half-hour tick after it — but never busier than once a minute.
 */
export function idleDelayMs(tickMs, judgeAt, now = new Date()) {
  if (!judgeAt) return tickMs;
  const until = judgeAt.getTime() - now.getTime() + 5000;
  return until > 0 && until < tickMs ? Math.max(until, 60000) : tickMs;
}

const readSeen = () => readJson(p('data', 'seen.json'), {});

/** Fingerprints on file, taken before a run so the run's finds can be told apart afterwards. */
export const seenKeys = () => new Set(Object.keys(readSeen()));

/**
 * How many postings a run added. seen.json holds only what passed the gates —
 * rejections live elsewhere — so a fingerprint that was not there before is a job
 * that survived, which is exactly what "new" should mean here.
 */
export function freshSince(before) {
  let n = 0;
  for (const fp of Object.keys(readSeen())) if (!before.has(fp)) n++;
  return n;
}

/**
 * The live state, re-read only when seen.json or jobs.json has changed on disk.
 * The badge asks every fifteen seconds and jobs.json is several megabytes; the
 * modification times say whether anything is different without parsing it.
 */
let cachedState = { stamp: '', state: null };
function liveState() {
  const mtime = (f) => { try { return statSync(p('data', f)).mtimeMs; } catch { return 0; } };
  const stamp = `${mtime('seen.json')}:${mtime('jobs.json')}`;
  if (cachedState.stamp !== stamp) cachedState = { stamp, state: store.load() };
  return cachedState.state;
}

/** The numbers on the badge: worked out from the live data, never from a saved list. */
export const openCounts = () => queueStore.counts(liveState());

/**
 * The earliest moment a fetch can actually happen.
 *
 * A source waking at 14:07 does not fetch at 14:07; it fetches at the first tick
 * after that. Saying "next fetch 14:07" would be a small lie every time.
 */
export function nextFetchAt(nextTickAt, wakes, tickMinutes) {
  if (!wakes || wakes <= nextTickAt) return nextTickAt;
  const tickMs = tickMinutes * 60000;
  return new Date(nextTickAt.getTime() + Math.ceil((wakes - nextTickAt) / tickMs) * tickMs);
}

/**
 * Telling you about new jobs WHILE a scan is still running.
 *
 * The toast used to wait for the end of the scan, which is minutes after a source's results were
 * already on the page — a scan can take 5-15 minutes and a source lands every few seconds. So the
 * app now looks while the scan runs and says so as soon as something new is there.
 *
 * `fresh` is how many postings are new since the scan began; `notified` how many have already
 * been announced. A scan lands one source after another, so announcing each would be a stream of
 * toasts: at most one per `NOTICE_GAP_MS`, each saying how many MORE there are. The end of the scan
 * announces whatever is left, so the total is always accounted for and a quiet scan says nothing.
 *
 * Pure, so it runs under node --test; the shell only supplies the clock and the counts.
 */
export const NOTICE_GAP_MS = 60000;

const noun = (n) => `${n} new job${n === 1 ? '' : 's'}`;
const say = (n, more) => (more ? noun(n).replace(' new ', ' more new ') : noun(n));

/** Something worth saying while the scan runs, or null. */
export function progressNotice({ fresh, notified, lastAt = null, now, gapMs = NOTICE_GAP_MS }) {
  if (fresh <= notified) return null;
  if (lastAt !== null && now - lastAt < gapMs) return null;
  const n = fresh - notified;
  return { notified: fresh, text: say(n, notified > 0) };
}

/** What is left to say when the scan ends, or null. */
export function finalNotice({ fresh, notified }) {
  if (fresh <= notified) return null;
  const n = fresh - notified;
  return { notified: fresh, text: say(n, notified > 0) };
}

/**
 * The number on the badge: every job still open. Interested counts, because it is
 * open until you apply or turn it down — and it is the same set the report's queue
 * shows. Counting only the untouched ones hid the badge entirely while one
 * Interested job was waiting to be applied for.
 */
export const openTotal = ({ waiting, interested }) => waiting + interested;

export function describeOpen({ waiting, interested }) {
  const open = openTotal({ waiting, interested });
  if (!open) return 'No open jobs';
  const head = `${open} open job${open === 1 ? '' : 's'}`;
  if (waiting && interested) return `${head} — ${waiting} waiting, ${interested} interested`;
  return interested ? `${head} — interested` : head;
}
