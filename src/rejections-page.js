import { mkdirSync, writeFileSync } from 'node:fs';
import { p, readJson } from './util.js';
import * as rejects from './rejects.js';
import * as store from './store.js';
import { buildRejectionsPage } from './report.js';

/**
 * The rejection list, as a page of its own.
 *
 * It was the Discarded section of the report, and it was 9.6 MB of the page's
 * 10.06 — 96%, for a list that is looked at now and then. Everything else the
 * report holds is 0.44 MB. Moving it out means the report is cheap enough to
 * rewrite after every source (see `writeReport` in index.js), loads at once, and
 * does not carry eleven thousand rows around while you are looking at the queue.
 *
 * Two ways to reach it, both the same page:
 *   - served: `/rejections`, rendered from the archive on each request, so what
 *     "Mark all reviewed" just did is what you see on reload;
 *   - as a file: `reports/rejections.html`, written at the end of a run, for
 *     opening the report straight from disk.
 */

/**
 * Fingerprints the user has answered for, for the REVIEW LIST.
 *
 * Wider than decidedBy: it includes `interested`. The review list asks "did the
 * filter get this wrong?", and a posting pulled out of the rejections on
 * purpose is one already answered — leaving it there asks the same question
 * every run, and "Mark all reviewed" would then quietly bury the user's own
 * pick among four thousand rows.
 *
 * Deliberately NOT the same set as decidedBy. That one stops the model being
 * asked, and an interested posting still needs judging: the user has said they
 * want it, not that they know everything about it.
 */
export const answeredBy = (state) => new Set(
  Object.entries(state.seen || {})
    .filter(([, e]) => ['applied', 'rejected', 'hidden', 'interested'].includes(e.status))
    .map(([fp]) => fp),
);

/**
 * Fingerprints are permanent; wording is not. Rejection text is re-derived from
 * each entry's stored signals at render time rather than read back from the
 * archive, so editing a message in filter.js corrects the whole history at once
 * instead of stranding thousands of entries phrased the old way.
 */
export const describeAll = (entries, profile) =>
  entries.map((e) => ({ ...e, reason: rejects.describeRejection(e, profile) }));

const loadProfile = () =>
  readJson(process.env.JOBHUNT_PROFILE || p('config', 'profile.json'), null) ?? readJson(p('config', 'profile.example.json'));

/** How many are waiting, and how many have been looked at already. */
export function counts(archive = rejects.load(), state = store.load()) {
  const awaiting = rejects.unreviewed(archive, answeredBy(state)).length;
  return { awaiting, reviewed: rejects.size(archive) - awaiting };
}

/**
 * The page. `all` lists reviewed rejections too — what `report --all-rejected`
 * has always done; reviewed ones stay hidden otherwise, which is the whole point
 * of clearing a gate.
 */
export function rejectionsHtml({ profile = loadProfile(), all = false } = {}) {
  const archive = rejects.load();
  const state = store.load();
  const entries = all
    ? Object.values(archive).sort((a, b) => new Date(b.lastRejected) - new Date(a.lastRejected))
    : rejects.unreviewed(archive, answeredBy(state));
  const { reviewed } = counts(archive, state);
  return buildRejectionsPage({ rejected: describeAll(entries, profile), reviewedCount: reviewed, profile });
}

export function writeRejectionsPage(opts = {}) {
  mkdirSync(p('reports'), { recursive: true });
  const file = p('reports', 'rejections.html');
  writeFileSync(file, rejectionsHtml(opts), 'utf8');
  return file;
}
