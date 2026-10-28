import { existsSync } from 'node:fs';
import { p, readJson, writeJson } from './util.js';
import { AGGREGATORS, indexTwins, addToTwinIndex, findTwin } from './twins.js';

/**
 * Persistent memory. Two files:
 *   seen.json — the index: fingerprint -> status + provenance. Small, hot.
 *   jobs.json — the archive: full record incl. description, so postings stay
 *               readable long after the employer takes them down.
 *
 * Dedupe is two-layer:
 *   1. exact  — source + sourceId (same listing, same source, seen again)
 *   2. fuzzy  — fingerprint over canonical(company|title|city), so the same role
 *               arriving via Adzuna AND the employer's Greenhouse board collapses
 *               into one entry that lists both sources.
 */

const SEEN = p('data', 'seen.json');
const JOBS = p('data', 'jobs.json');

export const STATUSES = ['new', 'shown', 'interested', 'applied', 'rejected', 'hidden'];

export function load() {
  return {
    seen: existsSync(SEEN) ? readJson(SEEN, {}) : {},
    jobs: existsSync(JOBS) ? readJson(JOBS, {}) : {},
  };
}

export function save(state) {
  writeJson(SEEN, state.seen);
  writeJson(JOBS, state.jobs);
}

/**
 * Fold freshly-fetched jobs into memory.
 * Returns { fresh, repeats, merged } where `fresh` are the ones never shown before.
 */
/**
 * Where a posting already lives, regardless of what its fingerprint says today.
 *
 * The fingerprint is `sha1(company|title|locationKey)`, and the location key is
 * 'remote' for a remote role or the city otherwise. That `remote` branch is
 * load-bearing: four of the five cross-board merges in the archive are remote
 * roles that Adzuna, JSearch and the alert emails each place in a DIFFERENT
 * city — eschborn, willich, duesseldorf — so keying them on the city would
 * split every one of them.
 *
 * But `workMode` is DERIVED, and it improves. An alert email carries no
 * description, so the posting cannot be read as remote and is keyed on its
 * city; when the LinkedIn guest card is fetched later the text says remote and
 * the key becomes 'remote'. The job then has a new identity and comes back as
 * unseen. Four postings returned that way — two already applied to, one
 * rejected — because the identity moved underneath a decision.
 *
 * The posting id does not move. `source:sourceId` was identical across all four
 * pairs, so it is the signal that survives re-reading. It cannot REPLACE the
 * fingerprint — a LinkedIn id never equals an Adzuna id, so keying on it would
 * double every job that appears on two boards, which is the thing the
 * fingerprint exists to prevent. It is a second opinion, not a new key.
 */
/**
 * The posting id, compared the way two humans would compare it.
 *
 * The first version matched the strings exactly and missed a duplicate that
 * differed by ONE character — a trailing slash:
 *
 *   mailalerts:https://www.linkedin.com/comm/jobs/view/4435227908/
 *   mailalerts:https://www.linkedin.com/comm/jobs/view/4435227908
 *
 * Both are the same LinkedIn posting, arriving from two alert emails that
 * formatted the link differently. A job already applied to came back as unseen,
 * which is the exact failure the id check was added to prevent — it just
 * happened one slash below where anyone was looking.
 *
 * Query strings go too. LinkedIn alert links carry a different trackingId,
 * refId and otpToken on every email, so the raw URL is never equal to itself
 * twice; only the path identifies the posting.
 */
export function normaliseSourceId(id) {
  const raw = String(id || '').trim();
  if (!raw) return '';
  const cut = raw.indexOf(':');
  const source = cut < 0 ? '' : raw.slice(0, cut);
  const rest = cut < 0 ? raw : raw.slice(cut + 1);

  const bare = rest
    .split(/[?#]/)[0]
    .replace(/\/+$/, '')
    .toLowerCase();

  // A prefix with nothing after it is not an identifier. "mailalerts:" would
  // otherwise be a perfectly good map key shared by every posting whose source
  // could not supply an id, and reconcile() treats a known id under an unknown
  // fingerprint as the same posting moving — so the second such posting would
  // be absorbed into the first one's identity and inherit its status.
  if (!bare) return '';

  return source ? `${source}:${bare}` : bare;
}

function indexBySourceId(state) {
  const byId = new Map();
  for (const [fp, entry] of Object.entries(state.seen)) {
    for (const id of entry.sourceIds || []) {
      const k = normaliseSourceId(id);
      if (k && !byId.has(k)) byId.set(k, fp);
    }
  }
  return byId;
}

export function reconcile(state, jobs, { now = new Date().toISOString() } = {}) {
  const fresh = [];
  const repeats = [];
  let merged = 0;

  // Highest score first, so when duplicates collapse we keep the richest record
  // (ATS boards carry full descriptions; aggregators often truncate).
  const ordered = [...jobs].sort((a, b) => (b.descriptionText?.length || 0) - (a.descriptionText?.length || 0));

  const seenThisRun = new Set();
  const bySourceId = indexBySourceId(state);
  const drifted = [];
  const driftSeen = new Set();
  const twinIndex = indexTwins(state);

  for (let job of ordered) {
    let fp = job.fingerprint;
    let entry = state.seen[fp];

    // Unknown fingerprint, but a posting id we have already filed: the identity
    // moved rather than a new job appearing. Keep the original — it is the one
    // carrying the user's decision — and record where it moved from.
    if (!entry) {
      const known = bySourceId.get(normaliseSourceId(job.id));
      if (known && known !== fp) {
        const prev = state.seen[known];
        prev.alsoKnownAs = [...new Set([...(prev.alsoKnownAs || []), fp])];
        // Once per MOVE, not once per arrival. The same posting reaches a run
        // from several emails and several sources, and each copy takes this
        // branch — so one identity move was reported four times in a row, which
        // reads like four separate problems. `alsoKnownAs` was already deduped;
        // this list was not.
        if (!driftSeen.has(`${fp}>${known}`)) {
          driftSeen.add(`${fp}>${known}`);
          drifted.push({ from: fp, to: known, title: job.title, status: prev.status });
        }
        fp = known;
        entry = prev;
        job = { ...job, fingerprint: known };
      }
    }

    // Still unknown: the same role from another source? Only an aggregator pair
    // with matching adverts counts (src/twins.js). Same bookkeeping as an id move.
    if (!entry) {
      const twin = findTwin(job, state, twinIndex);
      if (twin) {
        const prev = state.seen[twin];
        prev.alsoKnownAs = [...new Set([...(prev.alsoKnownAs || []), fp])];
        if (!driftSeen.has(`${fp}>${twin}`)) {
          driftSeen.add(`${fp}>${twin}`);
          drifted.push({ from: fp, to: twin, title: job.title, status: prev.status, twin: true });
        }
        // The employer's link beats an aggregator's page, which only redirects there.
        const filed = state.jobs[twin];
        if (filed && AGGREGATORS.has(filed.source) && !AGGREGATORS.has(job.source) && job.applyUrl) {
          filed.applyUrl = job.applyUrl;
        }
        fp = twin;
        entry = prev;
        job = { ...job, fingerprint: twin };
      }
    }

    if (!entry) {
      state.seen[fp] = {
        fingerprint: fp,
        firstSeen: now,
        lastSeen: now,
        status: 'new',
        sources: [job.source],
        sourceIds: [job.id],
        title: job.title,
        company: job.company,
      };
      state.jobs[fp] = job;
      addToTwinIndex(twinIndex, fp, job);
      for (const id of state.seen[fp].sourceIds) bySourceId.set(normaliseSourceId(id), fp);
      fresh.push(job);
      seenThisRun.add(fp);
      continue;
    }

    // Known fingerprint — record the new provenance, but do not re-surface it.
    entry.lastSeen = now;
    // Recording a new source is NOT a merge event. It used to increment
    // `merged` here as well as in the duplicate-this-run branch below, so a
    // posting arriving from two sources in one run — the ordinary case this
    // stat exists to describe — counted twice, and the run reported 32 merges
    // for 16.
    //
    // The three numbers are meant to partition the arrivals: every job is
    // fresh, a repeat, or a duplicate collapsed onto one of those. The branch
    // below does that partitioning; this line was a second opinion about the
    // same event.
    if (!entry.sources.includes(job.source)) entry.sources.push(job.source);
    const seenIds = new Set(entry.sourceIds.map(normaliseSourceId));
    if (!seenIds.has(normaliseSourceId(job.id))) entry.sourceIds.push(job.id);
    bySourceId.set(normaliseSourceId(job.id), fp);

    // Upgrade the archive if this source has a fuller description.
    const existing = state.jobs[fp];
    if (existing && (job.descriptionText?.length || 0) > (existing.descriptionText?.length || 0)) {
      state.jobs[fp] = { ...job, applyUrl: existing.applyUrl || job.applyUrl };
    }

    if (seenThisRun.has(fp)) {
      merged++; // duplicate within this same run (two sources, one role)
    } else if (entry.status === 'new') {
      // Fetched again before ever being reported — still owed to the user.
      fresh.push(state.jobs[fp] || job);
      seenThisRun.add(fp);
    } else {
      repeats.push(job);
      seenThisRun.add(fp);
    }
  }

  return { fresh, repeats, merged, drifted };
}

/** Mark reported jobs as shown so the next run stays quiet about them. */
export function markShown(state, jobs, now = new Date().toISOString()) {
  for (const job of jobs) {
    const e = state.seen[job.fingerprint];
    if (e && e.status === 'new') {
      e.status = 'shown';
      e.shownAt = now;
    }
  }
}

/**
 * Pull a rejected posting back into the live set because the user asked for it.
 *
 * A rejection lives in rejected.json and deliberately never enters seen.json —
 * that index suppresses re-reporting, so a rejected job has to be re-fetched and
 * re-judged every run for a rule edit to take effect. The cost is that a
 * rejection has no record anywhere the report can render, so "I want this one
 * anyway" had nowhere to write itself.
 *
 * This copies the archived record into state.jobs and stamps a verdict the rules
 * cannot overturn. `source: 'user'` is what rejudge() checks: the user has read the
 * posting and decided, and no gate gets to argue with that on the next run.
 *
 * The archive entry is left alone. It is the audit trail of what the gates did,
 * and rewriting it would lose the fact that the rules got this one wrong.
 */
export function promote(state, entry, { now = new Date().toISOString(), reason = null } = {}) {
  const fp = entry.fingerprint;

  state.jobs[fp] = {
    ...entry,
    descriptionText: entry.descriptionText || entry.excerpt || '',
    verdict: {
      decision: 'keep',
      source: 'user',
      reason: reason || 'you asked for this one from the review list',
      category: null,
      band: 'main',
    },
  };

  state.seen[fp] = {
    ...(state.seen[fp] || {}),
    fingerprint: fp,
    firstSeen: state.seen[fp]?.firstSeen || entry.firstRejected || now,
    lastSeen: now,
    status: state.seen[fp]?.status || 'new',
    sources: state.seen[fp]?.sources || [entry.source].filter(Boolean),
    sourceIds: state.seen[fp]?.sourceIds || [],
    title: entry.title,
    company: entry.company,
    promotedAt: now,
  };

  return state.jobs[fp];
}

/**
 * A job you found somewhere this tool does not reach.
 *
 * Most of a job search happens outside any tool — a link from a friend, a
 * company page with no board, a posting on a site nothing here polls. Those
 * jobs still need a tailored CV, and `npm run apply` works off `state.jobs`, so
 * a posting that never came from a source could not be applied for at all.
 * The only way in was to wait for a source to happen to find it.
 *
 * This is `promote()`'s sibling: same idea, other direction. `promote()` takes
 * a posting the rules rejected and says "I want this one anyway"; this takes a
 * posting the rules never saw. Both stamp `verdict.source = 'user'`, which
 * `rejudge()` will not overturn — a job you typed in yourself must not be
 * retired next run for failing a gate you already decided to ignore.
 *
 * Status is `interested` rather than `new`, because it is: you found it and
 * chose to keep it. That also means `rejudge()` holds it and the report shows
 * it, which is the whole point.
 *
 * The caller normalizes. This module does storage and knows nothing about
 * geocoding or work modes, and the fingerprint has to be computed the same way
 * for a pasted job as for a fetched one or the same posting arriving later from
 * a real source would be filed twice.
 */
export function addManual(state, job, { now = new Date().toISOString() } = {}) {
  const fp = job.fingerprint;
  const already = state.seen[fp];

  const prev = state.jobs[fp];

  state.jobs[fp] = {
    ...(prev || {}),
    ...job,
    // Re-adding replaces what you typed, because you typed it deliberately —
    // except the advert, which is never replaced by nothing. Pasting the link
    // again to fix a typo in the title would otherwise wipe the text
    // `npm run apply` reads, and the loss would be silent.
    descriptionText: job.descriptionText || prev?.descriptionText || '',
    verdict: {
      decision: 'keep',
      source: 'user',
      reason: 'you added this one by hand',
      category: null,
      band: 'main',
    },
  };

  state.seen[fp] = {
    ...(already || {}),
    fingerprint: fp,
    firstSeen: already?.firstSeen || now,
    lastSeen: now,
    // An existing decision wins. Pasting a link to something already applied
    // for must not quietly reopen it.
    status: already?.status || 'interested',
    sources: [...new Set([...(already?.sources || []), job.source])],
    sourceIds: [...new Set([...(already?.sourceIds || []), job.id].filter(Boolean))],
    title: job.title,
    company: job.company,
    addedByHand: already?.addedByHand || now,
  };

  return { fingerprint: fp, job: state.jobs[fp], existed: Boolean(already) };
}

/**
 * Set a status, and record the one thing that status makes worth knowing.
 *
 * `detail` may be a plain string — the old shape, kept because it reads better
 * from the CLI — or `{ reason, salaryAsked }`. Which field a bare string fills
 * depends on the status, because only one of them applies to each.
 */
export function setStatus(state, fingerprint, status, detail = null) {
  if (!STATUSES.includes(status)) throw new Error(`Unknown status: ${status}. Use one of ${STATUSES.join(', ')}`);
  const e = state.seen[fingerprint];
  if (!e) return false;

  const opts = typeof detail === 'string' || typeof detail === 'number'
    ? (status === 'applied' ? { salaryAsked: String(detail) } : { reason: String(detail) })
    : (detail || {});

  e.status = status;
  e.statusChangedAt = new Date().toISOString();

  // WHY you rejected it, in the same vocabulary as the gates. Without it,
  // working out what the filter is getting wrong means guessing from the
  // postings themselves — and guessing was wrong: of 34 rejections blamed on
  // German, 19 never mentioned German at all. Recorded only for a rejection,
  // and cleared if the status changes again so a stale reason cannot mislead.
  if (status === 'rejected' && opts.reason) e.rejectedReason = opts.reason;
  else delete e.rejectedReason;

  // WHAT YOU ASKED FOR. The figure goes into the employer's application form
  // and then exists nowhere else — not in the advert, not in the CV, not in the
  // letter. Months later, when one of them comes back with an offer, the number
  // you named is the one fact you cannot reconstruct.
  //
  // Free text on purpose. "70000", "65–75k", "70.000 € p.a. + Bonus" and
  // "declined to state" are all real answers, and parsing them into a number
  // would throw away the half that matters. Optional, always: a form that
  // blocks marking a job applied would just stop it being marked.
  if (status === 'applied' && opts.salaryAsked) e.salaryAsked = String(opts.salaryAsked).trim();
  // Not cleared on a status change, unlike the reject reason. The reason
  // describes the current verdict and goes stale; what you asked for happened,
  // and stays true whatever the job becomes afterwards.

  return true;
}

/** Resolve a user-typed prefix to a full fingerprint (ids in the report are short). */
/**
 * The jobs you turned down by hand, newest first, for the page's "Turned down" list.
 *
 * A card leaves the queue the moment you mark it, so the page needs somewhere
 * that still says what you did — and the rejection block at the foot of the
 * report is not it: that one lists what the GATES threw away, from rejected.json,
 * and a job you reject by hand lives only in seen.json. Windowed, because 245
 * rejections is a list nobody reads; the CLI and seen.json keep all of them.
 */
export function turnedDown(state, { days = 30, now = Date.now() } = {}) {
  const cutoff = now - days * 86400000;
  return Object.entries(state.seen || {})
    .filter(([, e]) => (e.status === 'rejected' || e.status === 'hidden')
      && (Date.parse(e.statusChangedAt || '') || 0) >= cutoff)
    .map(([fp, e]) => ({
      id: fp.slice(0, 8),
      title: e.title,
      company: e.company,
      status: e.status,
      reason: e.rejectedReason || null,
      at: e.statusChangedAt,
      // The posting itself, so the row can link to it and read it like any other job.
      applyUrl: state.jobs?.[fp]?.applyUrl || null,
    }))
    .sort((a, b) => b.at.localeCompare(a.at));
}

export function resolveFingerprint(state, prefix) {
  const hits = Object.keys(state.seen).filter((k) => k.startsWith(prefix));
  if (hits.length === 1) return hits[0];
  if (hits.length === 0) return null;
  throw new Error(`Ambiguous id "${prefix}" — matches ${hits.length} jobs. Use more characters.`);
}

