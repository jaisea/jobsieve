/**
 * The last fetch, kept so a gate can be changed without paying for one.
 *
 * Iterating on a gate used to mean a full `npm run search`: 42 Adzuna calls, an
 * IMAP round trip, and — before the budgets went in — a JSearch call against a
 * 200-a-month allowance. Four such runs in one afternoon took JSearch to 95%
 * used. The postings themselves had not changed; only the rules being applied
 * to them had.
 *
 * So the raw output of every source adapter is written here, and `--replay`
 * runs the whole judging pipeline over it with no network at all.
 *
 * WHAT IS STORED is the adapter output, BEFORE normalize(). That is the
 * important choice. Storing normalized jobs would replay the gates but freeze
 * everything normalize derives — work mode, the German tiers, the stack match,
 * the distance — which is where a good half of the interesting bugs live.
 * Storing one step earlier means a replay re-derives all of it.
 *
 * What a replay still cannot reach is the source adapters themselves: the
 * LinkedIn card parser, the alert-email readers. Those run before this file
 * exists. A parser change needs a real fetch, and the header says which run
 * this came from so it is obvious when the snapshot is stale.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';

import { p, log, stripHtml, writeJson } from './util.js';

const FILE = () => p('data', 'fetched.json');

/**
 * The HTML is dropped, and it costs nothing to drop.
 *
 * descriptionHtml was 39 of the 73 MB the first snapshot took — more than half
 * the file — and NOT ONE of the 6,787 postings had HTML without also having
 * text. normalize() prefers descriptionText and only falls back to stripping
 * the markup, so the fallback was never reached; and every consumer downstream
 * already passes descriptionHtml: '' explicitly. Keeping it stored a second
 * copy of every advert, in a bulkier form, for nobody.
 *
 * Anything that genuinely arrives as HTML alone is converted rather than lost.
 */
const slim = (job) => {
  if (!job?.descriptionHtml) return job;
  const { descriptionHtml, ...rest } = job;
  const text = rest.descriptionText || stripHtml(descriptionHtml);
  return text ? { ...rest, descriptionText: text } : rest;
};

/**
 * The snapshot is "the latest fetch of EACH source", not "whatever the last run
 * fetched".
 *
 * Before the background app a run always asked every source, so the two were the
 * same. Now a half-hourly run may ask only the inbox, and saving just that would
 * leave `--replay` judging forty mail postings and nothing else — no error, just
 * a replay of a fraction of the corpus. A source that was asleep, refused or
 * failed keeps the slice it had.
 *
 * `ranges` maps source -> [start, end) in `jobs`. `carry` is the sources worth
 * keeping, i.e. the ones currently enabled: a source switched off should stop
 * haunting the snapshot. A previous snapshot with no `ranges` predates this and
 * cannot be sliced, so nothing is carried from it.
 */
export function carryOver(prev, raw, ranges = {}, carry = []) {
  const out = { ...ranges };
  if (!prev?.ranges) return { jobs: raw, ranges: out };

  const jobs = raw.slice();
  for (const key of carry) {
    if (out[key] || !prev.ranges[key]) continue;
    const [from, to] = prev.ranges[key];
    const start = jobs.length;
    jobs.push(...prev.jobs.slice(from, to));
    out[key] = [start, jobs.length];
  }
  return { jobs, ranges: out };
}

/**
 * A source that returns only what is NEW — the job-alert mailbox, once it has a bookmark —
 * still owes the snapshot its whole window, or `--replay` would judge only the latest batch.
 *
 * `add` is the new postings; the stored slice is read back, anything older than the
 * window is dropped (the source's own window, so the slice does not grow for ever), and the
 * new ones go on the end. A posting is identified by its id and the date it was posted:
 * the same job in two different alerts is two rows, as it was before, and the same alert
 * read twice (a scan that died before moving its bookmark) is one.
 */
export function mergeSlice(key, add, { days } = {}) {
  const snap = load();
  const range = snap?.ranges?.[key];
  const prev = range ? snap.jobs.slice(range[0], range[1]) : [];
  const cutoff = days ? Date.now() - days * 86400000 : null;

  const id = (j) => `${j.sourceId || j.applyUrl}|${j.postedAt || ''}`;
  const fresh = new Set(add.map(id));
  const kept = prev.filter((j) => {
    if (fresh.has(id(j))) return false;
    if (cutoff === null || !j.postedAt) return true;
    const at = new Date(j.postedAt).getTime();
    return Number.isNaN(at) || at >= cutoff;
  });
  return [...kept, ...add];
}

/**
 * Kept out of the archive rather than merged into it.
 *
 * `data/jobs.json` holds only the 217 postings that were KEPT, and
 * `data/rejected.json` holds a 1,200-character excerpt — or nothing at all for
 * the 6,994 already reviewed. Neither can answer "what would this gate change
 * do to the 6,600 postings a run actually sees", which is the only question
 * worth asking before shipping a gate.
 */
export function save(raw, meta = {}) {
  const file = FILE();
  const { jobs, ranges } = carryOver(meta.carry?.length ? load() : null, raw, meta.ranges, meta.carry);

  // Through writeJson, which writes a temp file and renames — every other store
  // does. This one wrote directly, and it is the file that represents real API
  // spend: a crash mid-write leaves a truncated 34MB snapshot that nothing
  // notices until `--replay` refuses to run, by which point the fetch it stood
  // in for is gone.
  writeJson(file, {
    version: 1,
    fetchedAt: new Date().toISOString(),
    count: jobs.length,
    // [start, end) of each source's postings in `jobs`, so the next partial run
    // can carry the slices it did not refresh.
    ranges,
    // Which sources were actually asked. A source skipped for a spent quota or
    // a missing key contributed nothing, and a replay that silently reported
    // "0 from JSearch" would look like a fetch failure rather than a budget.
    sources: meta.sources || [],
    warnings: meta.warnings || [],
    jobs: jobs.map(slim),
  }, { pretty: false });
  return file;
}

export function load() {
  const file = FILE();
  if (!existsSync(file)) return null;
  try {
    const data = JSON.parse(readFileSync(file, 'utf8'));
    return Array.isArray(data?.jobs) ? data : null;
  } catch {
    return null;
  }
}

/** Age in hours, so a replay can say how stale the snapshot is. */
export function ageHours(snapshot) {
  if (!snapshot?.fetchedAt) return null;
  return (Date.now() - new Date(snapshot.fetchedAt).getTime()) / 3600000;
}

export function describe(snapshot) {
  if (!snapshot) return null;
  const h = ageHours(snapshot);
  const when = h === null ? 'unknown age'
    : h < 1 ? `${Math.round(h * 60)} minutes old`
      : h < 48 ? `${Math.round(h)} hours old`
        : `${Math.round(h / 24)} days old`;
  return `${snapshot.count} postings, ${when} (${snapshot.fetchedAt.slice(0, 16).replace('T', ' ')})`;
}

/**
 * Size on disk, reported after a save so the cost is visible rather than
 * discovered. The file is deliberately overwritten each run — a history of
 * fetches is not useful, and this is already the largest thing the tool writes
 * after the reject archive.
 */
export function sizeMb() {
  try { return statSync(FILE()).size / 1048576; } catch { return 0; }
}

