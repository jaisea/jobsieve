import { existsSync } from 'node:fs';
import { p, readJson, writeJson } from './util.js';
import { explain } from './filter.js';

/**
 * The rejection archive — every posting the pipeline threw away, and why.
 *
 * Deliberately a SEPARATE file from seen.json/jobs.json. Rejections must never
 * enter the seen index, because that index suppresses re-reporting: a job you
 * rejected under an old rule has to be re-fetched and re-judged on every run,
 * or editing a rule would have no effect on anything already seen.
 *
 * What this buys: `npm run why` can explain a decision after the fact, and the
 * drop-reason histogram stops being the only record of what was discarded.
 *
 * Descriptions are stored as a short excerpt rather than in full. The point is
 * to eyeball whether a rule fired correctly, not to archive the posting — the
 * ones that PASS are archived in full in jobs.json. Full text here would put
 * this file into the hundreds of megabytes within a fortnight.
 */

const FILE = p('data', 'rejected.json');

/** Enough to see the requirements paragraph that usually decides it. */
const EXCERPT_CHARS = 1200;

/**
 * Bounds on the archive. Generous because reviewed entries are slimmed to a
 * few hundred bytes, and evicting one would resurrect a posting you already
 * dismissed. Unreviewed backlog is what actually gets cut.
 */
export const LIMITS = { maxEntries: 20000, maxAgeDays: 60 };

export function load() {
  if (!existsSync(FILE)) return {};
  return readJson(FILE, {}).rejected || {};
}

/**
 * How a rejection reads today.
 *
 * The fingerprint is permanent; the wording is not. Reasons are phrased at
 * decision time, so freezing the string into the archive means every rewording
 * or rule change strands thousands of stale entries needing a migration.
 *
 * So the string is DERIVED here instead, by replaying the gates against the
 * signals the entry already stores. Change a message in filter.js and the whole
 * archive reads correctly on the next render, with nothing to migrate.
 *
 * Two things cannot be derived and so are stored verbatim:
 *   - `aiReason`, free text the model wrote about this specific posting
 *   - `reason`, the decision-time record, kept for categories with no gate
 *     behind them (a low score) and as provenance for what was decided then
 */
export function describeRejection(entry, profile) {
  if (entry.aiReason) return entry.aiReason;
  if (!profile) return entry.reason || 'not a fit';

  const { checks } = explain(entry, profile);
  // Match the gate that owns this entry's category, so the text can never
  // contradict the group it is filed under.
  const hit = checks.find((c) => !c.keep && c.category === entry.category);
  return hit?.reason || entry.reason || 'not a fit';
}

export function save(archive) {
  writeJson(FILE, { version: 1, savedAt: new Date().toISOString(), rejected: archive });
}

/**
 * Fold this run's rejections into the archive.
 *
 * `decidedBy` distinguishes a rules drop from an LLM one, because they are
 * tuned differently: a rules drop that looks wrong is a regex to fix, while an
 * AI drop that looks wrong is a prompt or a missing rule.
 */
/**
 * Everything a gate reads, kept so `npm run why` replays the same verdict the
 * run reached rather than re-deriving it from a truncated excerpt.
 *
 * One definition, used for a fresh entry and for refreshing a reviewed one, so
 * the two cannot drift. Adding a gate that reads a new field means adding it
 * here — `test/replay-agrees.test.js` fails if you forget.
 */
function signalsOf(job) {
  return {
    // Whether the advert had actually been READ. The location gate softens when
    // it has not, because "onsite" is then an assumption from a resolved city
    // rather than something the text said.
    descriptionComplete: job.descriptionComplete ?? null,
    // The door is shut, or the posting is not there at all.
    closed: job.closed ?? null,
    closedEvidence: job.closedEvidence ?? null,

    language: job.language ?? null,
    germanRequired: job.germanRequired ?? null,
    germanEvidence: job.germanEvidence ?? null,
    // The posting discusses German as a language and no tier matched, which is
    // what makes `findUncertainties` escalate instead of accepting "none".
    // Missing here, the archive replayed as a plain `none`, the escalation never
    // fired, and the rules alone said KEEP for a posting the model had rejected
    // on German. Third time this exact class has bitten — descriptionComplete,
    // then closed, now this — and every time it is a field added to a gate after
    // this list was written.
    germanTalkUngraded: job.germanTalkUngraded ?? null,
    // The advert discusses working from home and the rules did not conclude
    // remote — what makes the location gate soften instead of dropping.
    workModeUngraded: job.workModeUngraded ?? null,
    programmingRequired: job.programmingRequired ?? null,
    programmingEvidence: job.programmingEvidence ?? null,
    programmingLanguage: job.programmingLanguage ?? null,
  };
}

/**
 * The same second opinion `reconcile()` gives seen.json, for the archive.
 *
 * A fingerprint is `sha1(company|title|locationKey)` and every one of those is
 * DERIVED, so it improves: an alert email carries no description, the posting is
 * keyed on its city, the advert arrives, the text says remote, and the key
 * becomes `remote`. store.js has handled that since the identity-drift work —
 * it takes the posting id as a second opinion and keeps the original.
 *
 * `record()` never did, and it is keyed on the fingerprint alone. So the same
 * posting comes back under a new fingerprint as a brand-new UNREVIEWED
 * rejection, while the review you already gave it sits on a fingerprint nothing
 * will look up again. Measured on the archive: **550 source+applyUrl pairs are
 * filed under more than one fingerprint**, and of the drifts visible through
 * `alsoKnownAs`, 3 of 7 had a stranded review.
 *
 * `applyUrl` is the basis because it is on 100% of the 12,410 entries — the
 * archive stores no sourceId — normalised the way store.js normalises a posting
 * id, and for the same reason: LinkedIn puts a fresh trackingId in every email,
 * so the raw URL is never equal to itself twice.
 *
 * THE TITLE IS PART OF THE KEY, and leaving it out was measured and rejected.
 * A URL is not a posting id here. Stripping the query turns every Indeed job
 * into `jsearch:https://de.indeed.com/viewjob` — the same collapse the Indeed
 * mail parser had — and plenty of boards give every posting one apply page
 * (`fastly.com/about/jobs/apply`, `jobs.elastic.co/jobs`). Across the archive:
 *
 *     source + url                 550 groups, 206 joining DIFFERENT titles
 *     source + url + query kept    534 groups, 187 joining different titles
 *     source + url + title         407 groups,   0
 *
 * So url alone would have silently merged 206 unrelated rejections, which is
 * worse than the bug — a missed merge re-shows a posting, a wrong merge deletes
 * one. Company is deliberately NOT in the key: adding it loses 12 groups, and
 * those 12 are the LinkedIn drifts where the company itself was wrong
 * ("LinkedIn" → "Perspix.ai GmbH"), which is exactly what needs catching.
 *
 * The index is built once per archive object and then maintained, not rebuilt:
 * record() runs once per rejection, and rebuilding 12,410 entries each time
 * would be quadratic.
 */
const urlIndexes = new WeakMap();

const urlKey = (source, applyUrl, title) => {
  const bare = String(applyUrl || '').split(/[?#]/)[0].replace(/\/+$/, '').toLowerCase();
  if (!bare) return null;
  return `${source || ''}:${bare}|${String(title || '').toLowerCase().trim()}`;
};

function urlIndex(archive) {
  let idx = urlIndexes.get(archive);
  if (idx) return idx;
  idx = new Map();
  for (const [fp, e] of Object.entries(archive)) {
    const k = urlKey(e.source, e.applyUrl, e.title);
    if (k && !idx.has(k)) idx.set(k, fp);
  }
  urlIndexes.set(archive, idx);
  return idx;
}

export function record(archive, job, { reason, category, decidedBy = 'rules', reasons = null, now = new Date().toISOString() } = {}) {
  let fp = job.fingerprint;
  const idx = urlIndex(archive);
  const key = urlKey(job.source, job.applyUrl, job.title);

  // Unknown fingerprint, but a posting URL already filed: the identity moved
  // rather than a new rejection appearing. Keep the original entry — it is the
  // one carrying the review — and note where it moved from.
  if (!archive[fp] && key && idx.has(key)) {
    const known = idx.get(key);
    if (known !== fp) {
      const original = archive[known];
      original.alsoKnownAs = [...new Set([...(original.alsoKnownAs || []), fp])];
      fp = known;
    }
  }
  if (key && !idx.has(key)) idx.set(key, fp);

  const prev = archive[fp];

  // Already dismissed: touch the timestamp so it does not age out while the
  // posting is still live, and leave it slim. Re-recording it in full every run
  // would undo the review slimming and grow the archive right back.
  //
  // The DERIVED SIGNALS are refreshed even so. `npm run why` replays the gates
  // against this record, so a signal a gate reads that the archive does not
  // keep makes the replay disagree with the run — which is exactly what
  // happened when the location gate learned to read `descriptionComplete`.
  // 7,807 of these entries are reviewed, and without this they could never gain
  // a field again: the replay would say "would pass" where the run said
  // "closed". Scalars only; the excerpt stays dropped, which is what the
  // slimming was for.
  if (prev?.reviewedAt && prev.category === category) {
    prev.lastRejected = now;
    prev.runs = (prev.runs || 0) + 1;
    Object.assign(prev, signalsOf(job), { reasons: reasons || prev.reasons || null });
    return archive;
  }

  const entry = {
    fingerprint: fp,
    title: job.title,
    company: job.company,
    location: job.location,
    city: job.city ?? null,
    country: job.country ?? null,
    distanceKm: job.distanceKm ?? null,
    geoResolved: job.geoResolved ?? null,
    workMode: job.workMode,
    remoteScope: job.remoteScope ?? null,
    postedAt: job.postedAt ?? null,
    employmentType: job.employmentType ?? null,
    source: job.source,
    sourceLabel: job.sourceLabel ?? job.source,
    applyUrl: job.applyUrl,

    // The derived signals, kept so `why` can show what the gates actually saw
    // rather than re-deriving them from a truncated excerpt and disagreeing.
    ...signalsOf(job),

    score: job.score ?? null,
    scoreBreakdown: job.scoreBreakdown ?? null,

    // What was decided, and when. `reason` is the decision-time record — it is
    // provenance, not the display string; see describeRejection().
    reason,
    // Free text the model wrote about THIS posting. Nothing can regenerate it,
    // so unlike a rules reason it has to be kept.
    aiReason: decidedBy === 'rules' || decidedBy === 'rules-fallback' ? null : reason,
    category,
    decidedBy,
    // EVERY gate that failed, not just the one that owns the verdict. The
    // histogram says a rule fired 300 times; only this says whether it was the
    // only thing wrong with those postings. 8,703 of the archive carry more
    // than one, up to six.
    reasons: reasons || null,
    excerpt: (job.descriptionText || '').slice(0, EXCERPT_CHARS),
    excerptTruncated: (job.descriptionText || '').length > EXCERPT_CHARS,

    firstRejected: prev?.firstRejected || now,
    lastRejected: now,
    // A posting rejected on ten consecutive runs for the same reason is a
    // stable verdict; one whose reason keeps changing is a rule that is unsure.
    runs: (prev?.runs || 0) + 1,

    // Once you have eyeballed a rejection it stays out of the review list, on
    // every future run, without being deleted — the fingerprint has to survive
    // so the next run can tell "already checked" from "new".
    reviewedAt: prev?.reviewedAt || null,
  };

  // Keep the decision history when the verdict changes — that transition is the
  // most interesting thing in the file, because it means a rule edit landed.
  if (prev && (prev.reason !== reason || prev.category !== category)) {
    entry.previously = [...(prev.previously || []).slice(-4), {
      reason: prev.reason, category: prev.category, decidedBy: prev.decidedBy, at: prev.lastRejected,
    }];
  } else if (prev?.previously) {
    entry.previously = prev.previously;
  }

  // A different gate is now deciding this job, so your earlier review may have
  // been of a different question. Put it back in the list rather than assuming
  // the old "checked, fine" still holds.
  //
  // But only when the gate you actually reviewed has stopped firing. Splitting
  // the walk into phases moved 1,050 postings from `age` to `role` — a posting
  // both too old AND off-target used to be caught by the age gate first, and
  // phase 1.1 now sees the title before age runs. Nothing about those postings
  // changed; the pipeline just reached the same conclusion by a different
  // route, and 794 reviewed rejections came back into the list for it.
  //
  // The question you answered was "should this gate have caught it". If that
  // gate still fires, the answer still stands. Only possible to know because
  // gate() now reports every reason rather than the first.
  const stillFails = (reasons || []).some((r) => r.category === prev?.category);
  if (prev?.reviewedAt && prev.category !== category && !stillFails) entry.reviewedAt = null;

  // Where this posting has been. The entry below is built fresh each time, so
  // without this the drift record is written and then immediately overwritten —
  // which is what happened, and it only showed on the un-reviewed path because
  // a reviewed entry returns earlier and is never rebuilt.
  if (prev?.alsoKnownAs) entry.alsoKnownAs = prev.alsoKnownAs;

  archive[fp] = entry;
  return archive;
}

/**
 * Mark rejections as reviewed so they stop appearing in the review list.
 *
 * `which` is a category name, the string 'all', or an array of fingerprints.
 * Nothing is deleted — the entry stays, carrying its fingerprint, which is the
 * whole point: that is what lets the next run distinguish a posting you have
 * already dismissed from one it has never shown you.
 */
export function markReviewed(archive, which, { now = new Date().toISOString() } = {}) {
  const targets = Array.isArray(which) ? new Set(which) : null;

  let marked = 0;
  for (const [fp, e] of Object.entries(archive)) {
    if (e.reviewedAt) continue;
    const hit = targets ? targets.has(e.fingerprint)
      : which === 'all' ? true
        : (e.category || 'other') === which;
    if (!hit) continue;
    archive[fp] = { ...slim(e), reviewedAt: now };
    marked++;
  }
  return { archive, marked };
}

/**
 * Once reviewed, an entry only has to answer "have I already seen this?".
 *
 * Excerpts are 47% of the archive by weight, so keeping them for postings you
 * have already dismissed would let the file grow without buying anything.
 *
 * The short evidence strings stay. They cost almost nothing and the gates read
 * them: the German check inspects `germanEvidence` to tell a quoted requirement
 * from one merely inferred, so dropping it would make `why` replay a DIFFERENT
 * verdict than the one that actually ran.
 */
function slim(e) {
  const { excerpt, excerptTruncated, scoreBreakdown, ...keep } = e;
  return { ...keep, slimmed: true };
}

/** Undo a review pass — for when you clear a gate before actually reading it. */
export function unmarkReviewed(archive, which) {
  let cleared = 0;
  for (const e of Object.values(archive)) {
    if (!e.reviewedAt) continue;
    if (which !== 'all' && (e.category || 'other') !== which) continue;
    e.reviewedAt = null;
    cleared++;
  }
  return { archive, cleared };
}

/** The rejections still awaiting a look, newest first. */
/**
 * Rejections still worth a look.
 *
 * `decided` is the set of fingerprints the user has already ruled on — applied,
 * rejected, hidden. Those are excluded, because the review list exists to ask
 * "did the filter get this wrong?" and there is no point asking about a job the
 * user has already answered for. Without it, 23 postings sat in the pile
 * asking to be reviewed, two of them jobs already applied to.
 */
export const unreviewed = (archive, decided = null) => Object.values(archive)
  .filter((e) => !e.reviewedAt)
  .filter((e) => !decided || !decided.has(e.fingerprint))
  .sort((a, b) => new Date(b.lastRejected) - new Date(a.lastRejected));

/** How many are outstanding per gate, for the CLI summary. */
export function pendingByCategory(archive) {
  const out = {};
  for (const e of unreviewed(archive)) {
    const k = e.category || 'other';
    out[k] = (out[k] || 0) + 1;
  }
  return out;
}

/**
 * Keep the archive bounded.
 *
 * Age is measured on `lastRejected`, which is touched every run a posting is
 * still being fetched — so nothing live ever ages out, and only listings that
 * have disappeared from the sources expire.
 *
 * The entry cap evicts UNREVIEWED backlog first. Evicting a reviewed entry
 * would delete the record that keeps a dismissed posting out of tomorrow's
 * list, so it would come straight back as if new — the exact thing reviewing
 * is meant to prevent. Reviewed entries are slim, so keeping them is cheap.
 */
export function prune(archive, { maxEntries = LIMITS.maxEntries, maxAgeDays = LIMITS.maxAgeDays } = {}) {
  const cutoff = Date.now() - maxAgeDays * 86400e3;
  let removed = 0;

  const alive = Object.entries(archive).filter(([, e]) => {
    if (new Date(e.lastRejected).getTime() < cutoff) { removed++; return false; }
    return true;
  });

  if (alive.length <= maxEntries) return { archive: Object.fromEntries(alive), removed };

  const newestFirst = (a, b) => new Date(b[1].lastRejected) - new Date(a[1].lastRejected);
  const reviewed = alive.filter(([, e]) => e.reviewedAt).sort(newestFirst);
  const backlog = alive.filter(([, e]) => !e.reviewedAt).sort(newestFirst);

  // Only if reviews alone overflow the cap does the oldest review get dropped.
  const keptReviewed = reviewed.slice(0, maxEntries);
  const room = Math.max(0, maxEntries - keptReviewed.length);
  const keptBacklog = backlog.slice(0, room);

  removed += (reviewed.length - keptReviewed.length) + (backlog.length - keptBacklog.length);
  return { archive: Object.fromEntries([...keptReviewed, ...keptBacklog]), removed };
}

export const size = (archive) => Object.keys(archive).length;

/**
 * Find rejections by fingerprint prefix, apply URL, or free text over the
 * title and company — you rarely have a fingerprint to hand when the question
 * is "why didn't this show up?".
 */
export function find(archive, query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return [];

  const entries = Object.values(archive);
  const byFp = entries.filter((e) => e.fingerprint.startsWith(q));
  if (byFp.length) return byFp;

  if (/^https?:\/\//.test(q)) {
    const bare = (u) => String(u || '').split(/[?#]/)[0].toLowerCase().replace(/\/+$/, '');
    const target = bare(q);
    const hit = entries.filter((e) => bare(e.applyUrl) === target);
    if (hit.length) return hit;
  }

  return entries.filter((e) =>
    `${e.title} ${e.company}`.toLowerCase().includes(q));
}
