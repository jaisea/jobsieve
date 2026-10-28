/**
 * What is open, worked out from the data every time it is asked.
 *
 * The badge and the page used to read a SNAPSHOT: the list of fingerprints the last
 * report showed, saved to data/queue.json beside the report itself. A snapshot goes
 * stale the moment anything changes without a new report — and restoring a job you
 * had turned down changed exactly that. Its status went back to `shown`, but it was
 * in neither the page nor the snapshot, so it was open in the data and invisible in
 * the app.
 *
 * So there is no snapshot. A job is open if its status and its stored verdict say it
 * is, and everything that shows a number or a card asks this one definition: the
 * tray icon, the taskbar badge, the window title, the live page, and the search's
 * own carry-forward.
 */

/** How long a shown-but-unactioned role keeps appearing in the carry-forward band. */
export const OPEN_WINDOW_DAYS = 21;

const DAY = 86400000;

/**
 * Does this seen.json entry carry forward into the next report?
 *
 * `interested` never expires: it is a pick, sorted first, and the window exists to
 * let a backlog you never got round to fade away — not to retire a job you flagged.
 */
export function carries(entry, now = Date.now()) {
  if (!entry) return false;
  if (entry.status === 'interested') return true;
  if (entry.status !== 'shown') return false;
  return (Date.parse(entry.firstSeen || '') || 0) >= now - OPEN_WINDOW_DAYS * DAY;
}

/**
 * Is this job open — on the queue, counted on the badge?
 *
 * Open means not yet applied for or turned down, and still worth showing: a
 * posting the rules have since come to reject is not, unless you picked it (the
 * same exception rejudge() makes — a gate does not overrule you). A job with no
 * stored verdict is shown rather than hidden, as the report does: unjudged is not
 * rejected.
 */
export function isOpen(entry, job, now = Date.now()) {
  if (!entry) return false;
  if (entry.status === 'interested') return true;
  if (entry.status !== 'new' && entry.status !== 'shown') return false;
  if (job?.verdict?.decision === 'drop') return false;
  return entry.status === 'new' || carries(entry, now);
}

/** The open jobs, from the live state. */
export function openJobs(state, now = Date.now()) {
  return Object.values(state.jobs || {}).filter((j) => isOpen(state.seen?.[j.fingerprint], j, now));
}

/**
 * `waiting` is what still needs a decision; `interested` is what you have flagged
 * but not yet applied for. They are returned apart so the tooltip can say which,
 * but both are open jobs and the badge counts both (see daemon.openTotal) — the
 * number reaches zero when everything has been applied for or turned down.
 */
export function counts(state, now = Date.now()) {
  let waiting = 0;
  let interested = 0;
  for (const j of openJobs(state, now)) {
    if (state.seen[j.fingerprint].status === 'interested') interested++;
    else waiting++;
  }
  return { waiting, interested };
}
