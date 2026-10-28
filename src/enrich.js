import { existsSync } from 'node:fs';
import { p, readJson, writeJson, stripHtml, log, pool } from './util.js';
import { needsFix, fetchWithIntermediate } from './tlsfix.js';

/**
 * Full descriptions, fetched from the posting itself.
 *
 * Aggregators hand back a teaser: Adzuna cuts every description at exactly 500
 * characters and job-alert emails carry none at all — 39 of 54 kept jobs in a
 * measured run. Every content check (German, programming, AWS) was therefore
 * judging text it had never seen, in both directions: asserting a German
 * requirement no real posting contained, and missing a stated one that sat past
 * the cut.
 *
 * The ad pages publish a schema.org JobPosting in ld+json — the machine-readable
 * form sites provide for search engines. Parsing that beats scraping HTML: it is
 * the description as the publisher defines it, with none of the page chrome that
 * makes a naive tag-strip return "Top-Arbeitgeber · Amazon · Deutsche Bahn".
 *
 * Fetches are cached by fingerprint forever, so a posting is retrieved once
 * across all runs, and failures are cached too — a page that blocks us should
 * not be retried on every run.
 */

const FILE = p('data', 'descriptions.json');

/** Browsers get served the ld+json; a bare fetch UA sometimes does not. */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/**
 * Politeness. Concurrency 3 earned 19 × HTTP 429 from Adzuna in one run, so
 * requests are serialised PER HOST with a gap between them.
 *
 * This used to be 1 globally, which made a run the SUM of every host instead of
 * the maximum. Measured over the 864 postings a run actually has to fetch,
 * across 92 hosts: 13.9 minutes serialised globally, 9.4 with hosts overlapping
 * — and a global cap never binds anyway, because one host dominates. LinkedIn
 * is 225 of those fetches at a 2500ms gap, which is the 9.4 minutes on its own.
 *
 * Politeness is unchanged: `politeWait` chains each host's requests one after
 * another, so no site sees more traffic than before. Only unrelated hosts now
 * overlap.
 */
const CONCURRENCY = 12;

/**
 * Per-host gap. 400ms was tuned against Adzuna, which was the source producing
 * 429s at the time. LinkedIn is stricter: one run took 8 × HTTP 429 from it, and
 * five of those postings reached the report with NO description — judged from
 * the title alone. One of them demanded verhandlungssichere Deutschkenntnisse
 * and had to be rejected by hand.
 *
 * The whole step is slower now, deliberately. Being throttled out of the text
 * is not faster, it just moves the cost onto the person reading the report.
 */
const HOST_GAP_MS = [
  [/(^|[.])linkedin[.]com$/, 2500],
];
const DEFAULT_GAP_MS = 400;
const TIMEOUT_MS = 12000;

/** Hosts that said 429 with a Retry-After: waited out, then asked again. */
const throttled = new Map();

/**
 * Hosts that said 429 and gave no way back: no Retry-After, or a bot CHALLENGE.
 * They are left alone for the rest of the run — which is what the throttle above
 * was documented as doing and did not. Every request QUEUED for a throttled host
 * slept out the full backoff and then asked again, was refused again and re-armed
 * the backoff, so one refusing host cost 60 seconds per posting. Three Vercel
 * boards (Helsing, PostHog, Black Forest Labs) answer every page request with a
 * JS challenge and no Retry-After; a run stalled on them for over twelve minutes
 * with the CPU idle and ten sockets open to one address.
 */
const refused = new Set();

/**
 * A failure worth retrying tomorrow, as opposed to one that will never change.
 *
 * Caching every failure forever was wrong: a page with no structured data will
 * still have none next week, but a 429 is the server asking us to come back
 * later, and pinning it meant 19 postings would never be fetched again.
 */
export const isTransient = (error) => /HTTP (429|5\d\d)|timed out|fetch failed|ECONN|ENOTFOUND|socket|came back empty/i.test(error);

/**
 * Is this status code the advert saying it is not there any more?
 *
 * Measured against eight postings marked by hand as "no longer accepting
 * applications", re-fetched with two known-live ones as a control.
 *
 * **410 counts, from anyone.** Adzuna and Arbeitsagentur both return it
 * correctly for a withdrawn posting. It is a deliberate "this is gone" and the
 * only status a server sends when it means exactly that.
 *
 * **404 counts only from an endpoint keyed by job id** — the LinkedIn guest
 * card is `/jobPosting/{id}`, so a 404 there means no such posting. From a
 * human page or an aggregator redirect a 404 is often just a broken link, and
 * the bias here is that a wrong keep costs a minute of reading while a wrong
 * drop costs an opportunity never seen.
 *
 * **403 never counts.** This project spent months believing the Arbeitsagentur
 * API was WAF-blocked when the endpoint had simply been retired, and its
 * jobdetails endpoint still answers 403 for LIVE postings today. A 403 is
 * "we could not read it", not "it is gone".
 */
export const isGoneStatus = (status, idKeyed = false) =>
  status === 410 || (idKeyed && status === 404);

/**
 * What one cache entry says about whether the posting is still there.
 *
 * Five states, so search(), rejudge() and `npm run why` cannot form different
 * opinions from the same entry — which is how `closed` came to fire on carried
 * jobs and never on fresh ones.
 *
 *   open        judge it on the text
 *   closed      the advert says applications are shut  -> certain drop
 *   gone        the URL says the posting is not there  -> certain drop
 *   unreadable  fetched, but nothing to read           -> gate it unread
 *   unknown     not fetched, or a transient failure    -> park it
 *
 * `unreadable` is deliberately NOT a drop. A page that has never carried
 * structured data will not grow any, and 37 of the entries on disk are exactly
 * that — dropping them would delete postings for the sin of a bad careers page.
 */
export function livenessOf(hit) {
  if (!hit) return { state: 'unknown', evidence: 'the advert has not been fetched' };
  if (hit.gone) return { state: 'gone', evidence: `the posting is no longer there (${hit.error})` };
  if (hit.closed) return { state: 'closed', evidence: 'the advert says it is no longer accepting applications' };
  if (hit.text) return { state: 'open', evidence: null };
  if (isTransient(hit.error)) return { state: 'unknown', evidence: hit.error };
  return { state: 'unreadable', evidence: hit.error };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * A promise chain per host, so requests to one site stay strictly serial while
 * different sites overlap.
 *
 * A timestamp was not enough once more than one request could be in flight:
 * `politeWait` read the last-hit time, awaited the gap, and only then wrote the
 * new one, so two requests to the same host could both pass the check before
 * either recorded itself — turning a 400ms gap into no gap at all, at exactly
 * the sites most likely to answer 429.
 */
const hostQueue = new Map();

const hostOf = (url) => { try { return new URL(url).host; } catch { return null; } };
const gapFor = (host) => HOST_GAP_MS.find(([re]) => re.test(host))?.[1] ?? DEFAULT_GAP_MS;

/**
 * Exported because it is the ONLY thing standing between this project and
 * hammering a site. Two new sources fetched with a bare fetch() and no gap --
 * agencies.js can fire 36 list requests and 120 detail requests at one host as
 * fast as the network allows -- while their own comments claimed they went
 * through "the same per-host gap as the rest of the project". They did not.
 *
 * A shared queue is also the point: it is per HOST across the whole run, so a
 * source fetching apriori.de and the advert step fetching the same host cannot
 * each keep their own idea of the gap.
 */
export function politeWait(url) {
  const host = hostOf(url);
  if (!host) return Promise.resolve();

  // Join this host's queue. Each request waits for the one before it to have
  // taken its turn, so the gap is enforced no matter how many are in flight.
  const turn = (hostQueue.get(host) || Promise.resolve()).then(async () => {
    // Honour Retry-After before the normal gap. The server has told us exactly
    // how long to wait; guessing a smaller number just earns another 429.
    // A host that refused the run outright is not waited for: the caller checks
    // `refused` right after this and gives up, so sleeping out a backoff first
    // is the 60-seconds-per-posting stall this guard exists to remove.
    if (refused.has(host)) return;
    const backoff = (throttled.get(host) || 0) - Date.now();
    if (backoff > 0) await sleep(backoff);
    await sleep(gapFor(host));
  });

  // Swallow rejections on the stored chain so one failure cannot poison the
  // queue for every later request to that host.
  hostQueue.set(host, turn.catch(() => {}));
  return turn;
}

/**
 * Retry-After is seconds or an HTTP date. Capped: a server asking us to come
 * back in an hour is asking us to come back on the next run, not to stall this
 * one — the posting is parked and retried tomorrow.
 */
const RETRY_AFTER_CAP_MS = 60000;
function retryAfterMs(res) {
  const h = res.headers?.get?.('retry-after');
  if (!h) return null;
  const secs = Number(h);
  const ms = Number.isFinite(secs) ? secs * 1000 : new Date(h).getTime() - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return null;
  return Math.min(ms, RETRY_AFTER_CAP_MS);
}

export const load = () => (existsSync(FILE) ? readJson(FILE, {}) : {});
export const save = (cache) => writeJson(FILE, cache);

/**
 * Pull the JobPosting description out of a page's structured data.
 * Exported for testing — this is the part most likely to drift.
 */
export function extractDescription(html) {
  const blocks = [...String(html).matchAll(
    /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
  )];

  for (const [, body] of blocks) {
    let data;
    try { data = JSON.parse(body.trim()); } catch { continue; }

    // Sites publish either a bare object, an array, or an @graph wrapper.
    const nodes = [].concat(data['@graph'] || data);
    const posting = nodes.find((n) => n && n['@type'] === 'JobPosting');
    if (!posting?.description) continue;

    let text = stripHtml(String(posting.description)).trim();
    // Some boards HTML-escape the markup INSIDE the ld+json string (Markant's
    // Beesite pages: 52 literal tags left in a 3,100-character advert), so one
    // pass decodes the entities and leaves the tags it just revealed. Only a
    // second pass when tags are actually still there — text that merely
    // contains a '<' is left alone.
    if (/<\/?[a-z][a-z0-9]*(\s[^>]*)?>/i.test(text)) text = stripHtml(text).trim();
    if (text) return { text, title: posting.title || null };
  }
  return null;
}

/**
 * LinkedIn publishes no ld+json, so every posting from a job-alert email
 * arrived with an empty description — 43 of 97 archived jobs.
 *
 * That is not a small gap. With no text, the language check cannot see a
 * requirement, and one of these adverts read "Du kommunizierst klar auf
 * Deutsch" on the page itself while the tool showed it as a match.
 *
 * The guest endpoint below is the one LinkedIn's own public job page calls for
 * a logged-out visitor, and it returns the description as ordinary HTML. Note
 * this is a judgement call, not a free lunch: LinkedIn's terms discourage
 * automated access. It runs at the same one-request-per-400ms as every other
 * host, only for postings the user was already emailed, and only to read the
 * advert they were invited to read.
 */
/**
 * LinkedIn says so on the card itself, in a class name as well as in prose.
 * The class is the one to read: "No longer accepting applications" is
 * translated, the class is not.
 */
export const looksClosed = (html) => /closed-job__flavor--closed|no longer accepting applications/i.test(String(html));

const linkedInJobId = (url) => String(url || '').match(/\/jobs\/view\/(\d+)/)?.[1] || null;

/** The description block on the guest job card, which carries no ld+json. */
function extractLinkedIn(html) {
  const m = String(html).match(/<div[^>]*class="[^"]*description__text[^"]*"[\s\S]*?<\/div>\s*<\/div>/i)
    || String(html).match(/<section[^>]*show-more-less-html[\s\S]*?<\/section>/i);
  if (!m) return null;
  const text = stripHtml(m[0]).trim();
  return text.length > 200 ? { text, title: null } : null;
}

/**
 * eFinancialCareers publishes no ld+json either, and it is the source that
 * suffers most from it.
 *
 * Five Swiss postings reached the report unread and four were rejected by hand
 * in one sitting: onsite roles in Zurich and Geneva, two of
 * them plainly requiring German. Both failures have ONE cause — the advert was
 * never read:
 *
 *   - the location gate SOFTENS for an unread onsite posting in a commutable
 *     country, because "onsite" is then an assumption from a resolved city
 *     rather than something the text said. Switzerland qualifies, so both
 *     escalated instead of dropping.
 *   - German graded `unknown`, because there was nothing to grade.
 *
 * The advert was in the HTML the whole time. These are Angular pages, and the
 * server still renders the posting into a job-description container — 2,283
 * characters of German on the Zurich role, opening "Senior DevOps Engineer
 * Position bei unserem Kunden aus der Branche Bankwesen in Zürich". enrich.js
 * looked only for ld+json, found none, and reported "no JobPosting structured
 * data" about a page that was carrying the whole advert.
 *
 * Same shape as the LinkedIn guest card above: a source whose pages hold the
 * text somewhere other than where the standard says, needing one reader rather
 * than a new idea.
 */
function extractEfc(html) {
  const s = String(html);
  const at = s.search(/<[a-z]+[^>]*class="[^"]*job-description[^"]*"/i);
  if (at === -1) return null;

  // To the end of the container, counting nesting — these pages wrap the
  // advert in several levels of div, and stopping at the first </div> returns
  // the opening sentence and nothing else.
  const open = s.indexOf('>', at);
  const rest = s.slice(open + 1);
  const tag = /<(\/?)div\b/gi;
  let depth = 1;
  let end = -1;
  for (let m = tag.exec(rest); m; m = tag.exec(rest)) {
    depth += m[1] ? -1 : 1;
    if (depth === 0) { end = m.index; break; }
  }

  const text = stripHtml(end === -1 ? rest.slice(0, 40000) : rest.slice(0, end)).trim();
  // The same floor the LinkedIn reader uses: a container that yields a line or
  // two is chrome, not an advert.
  return text.length > 200 ? { text, title: null } : null;
}

const isEfc = (url) => /(^|[.])efinancialcareers[.][a-z]{2,6}([.][a-z]{2})?$/i.test(hostOf(url) || '');

/**
 * How long the advert step will take, from the only thing that decides it.
 *
 * Requests are serial PER HOST and overlap across hosts, so the wall clock is
 * not the total divided by the concurrency — it is the busiest host alone. That
 * was measured when the per-host queue went in: a run of 864 fetches took 9.4
 * minutes, and LinkedIn's 225 of them at a 2,500ms gap WERE those 9.4 minutes.
 * Every other host finished inside that.
 *
 * So: max over hosts of (its requests x its gap). A floor rather than a guess —
 * the gap is enforced, the requests themselves only add to it.
 *
 * It reports WHICH host sets the figure because that is the only actionable
 * part. The number moves when that host's gap or its share moves, and nothing
 * else: adding concurrency cannot help, which is the mistake the global
 * CONCURRENCY = 1 made in the other direction.
 */
export function fetchEstimate(jobs) {
  const perHost = new Map();
  for (const j of jobs) {
    const url = linkedInJobId(j.applyUrl) ? 'https://www.linkedin.com/' : j.applyUrl;
    const h = hostOf(url);
    if (h) perHost.set(h, (perHost.get(h) || 0) + 1);
  }
  let worst = null;
  for (const [host, n] of perHost) {
    const gap = gapFor(host);
    const ms = n * gap;
    if (!worst || ms > worst.ms) worst = { host, n, gap, ms };
  }
  return worst;
}

/** Minutes past a minute and a half; seconds below it. */
export const describeEta = (ms) => {
  const secs = Math.round(ms / 1000);
  return secs < 90 ? `~${secs}s` : `~${Math.round(secs / 60)} min`;
};

async function fetchOne(job) {
  // A LinkedIn tracking URL from an alert email carries the job id; the guest
  // card is the readable form of the same posting.
  const linkedIn = linkedInJobId(job.applyUrl);
  const url = linkedIn
    ? `https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/${linkedIn}`
    : job.applyUrl;

  await politeWait(url);
  // Checked AFTER the wait, not before: postings for one host queue up behind each
  // other, and the one that was refused has to be seen by the ones behind it.
  if (refused.has(hostOf(url))) {
    return { ok: false, error: 'HTTP 429 — this host refused earlier in the run; retried next run' };
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    // A host that omits its intermediate certificate gets it supplied — see
    // tlsfix.js. Everything else takes the ordinary path, unchanged.
    const doFetch = needsFix(url) ? fetchWithIntermediate : fetch;
    const res = await doFetch(url, {
      headers: { 'User-Agent': UA, 'Accept-Language': 'de-DE,de;q=0.9,en;q=0.8' },
      redirect: 'follow',
      signal: ctrl.signal,
    });
    if (res.status === 429) {
      // Park the host, not just the posting. Continuing to ask at the normal
      // gap is what turned one 429 into eight in a single run.
      const host = hostOf(url);
      const wait = retryAfterMs(res) ?? RETRY_AFTER_CAP_MS;
      if (host) throttled.set(host, Date.now() + wait);
      // No Retry-After, or a challenge page, is not a promise that waiting helps.
      const challenged = /challenge/i.test(res.headers?.get?.('x-vercel-mitigated') || '');
      if (host && (retryAfterMs(res) == null || challenged)) refused.add(host);
      return { ok: false, error: `HTTP 429`, retryAfterMs: wait };
    }
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}`, gone: isGoneStatus(res.status, linkedIn) };

    // Greenhouse 302s a dead job to its board index and says so in the query
    // string. Checked against a deliberately bogus job id on the same board,
    // which redirects identically, so this is their standard "no such job"
    // rather than one employer's quirk. Note a LIVE Greenhouse job ALSO
    // redirects — to a slug URL on the employer's own domain — so the redirect
    // by itself proves nothing and only the explicit marker counts.
    if (/[?&]error=true(&|$)/.test(res.url)) {
      return { ok: false, error: 'the board no longer lists this job', gone: true };
    }

    const html = await res.text();
    const closed = linkedIn ? looksClosed(html) : false;
    const found = extractDescription(html)
      || (linkedIn ? extractLinkedIn(html) : null)
      || (isEfc(url) ? extractEfc(html) : null);
    if (!found) return { ok: false, error: 'no JobPosting structured data on the page', closed };

    // An empty answer is not an answer. The guest card serves the description
    // inconsistently — the same posting returned 41KB with no description block
    // one minute and 74KB with it the next — so a blank result has to be a
    // reason to come back, not a fact about the advert. Without this the
    // posting is judged on its title alone and filed under a reject category
    // as if the text had been read.
    const text = String(found.text || '').trim();
    if (!text) return { ok: false, error: 'description came back empty', closed };

    return { ok: true, text, closed };
  } catch (e) {
    return { ok: false, error: e.name === 'AbortError' ? 'timed out' : e.message };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fill in full descriptions for the jobs that need one.
 *
 * Only called for postings that already survived the gates, so this fetches
 * hundreds of pages per run rather than thousands — and only once each, because
 * the cache is permanent.
 *
 * Returns { descriptions, fetched, cached, failed } where `descriptions` maps
 * fingerprint -> full text for every job that has one.
 */
/**
 * How long a captured description is trusted.
 *
 * It used to be forever. A remote DevOps posting was captured at 09:03
 * and the employer added "Deutsch Muttersprache oder mindestens C1 Deutsch" to
 * it later the same day; every run afterwards re-judged the old snapshot, the
 * gate saw no language requirement, and the adjudicator correctly answered a
 * question about text that was no longer true. An ad is a living document.
 */
const MAX_AGE_DAYS = 7;

/**
 * How long a FAILURE is trusted, which is not the same question.
 *
 * A non-transient failure used to be cached forever: a page behind a WAF on one
 * bad day, or an employer who fixed their structured data next week, was judged
 * unread for the life of the project. Long enough not to re-ask every run,
 * short enough that "permanent" means this quarter rather than always.
 */
const MAX_FAILURE_AGE_DAYS = 30;

const staleBy = (at, maxAgeDays) => {
  if (!at || !maxAgeDays) return false;
  return (Date.now() - new Date(at).getTime()) / 86400000 > maxAgeDays;
};

export async function enrich(jobs, {
  cache = load(), verbose = false, force = false, maxAgeDays = MAX_AGE_DAYS, offline = false,
} = {}) {
  // A transient failure is not a cached answer — it is a reason to try again.
  const settled = (fp) => {
    if (force) return false;
    const hit = cache[fp];
    if (!hit) return false;
    // A stale success is worth re-reading, and so is a stale failure — just on
    // a much longer clock.
    if (hit.text && staleBy(hit.at, maxAgeDays)) return false;
    if (!hit.text && staleBy(hit.at, MAX_FAILURE_AGE_DAYS)) return false;
    return Boolean(hit.text || !isTransient(hit.error));
  };
  // Offline: use what is on disk and ask for nothing. --replay needs the 1,126
  // adverts already cached — without them the content gates judge teasers and
  // escalate everything, which is the opposite of a faithful replay. Skipping
  // the whole enrich step to avoid the network threw the cache away with it:
  // 890 postings went to the model instead of 236.
  const need = offline ? [] : jobs.filter((j) => j.applyUrl && !settled(j.fingerprint));
  if (need.length && !offline) {
    const w = fetchEstimate(need);
    if (w) log.dim(`  ${need.length} to fetch, ${describeEta(w.ms)} — set by ${w.host} (${w.n} at ${w.gap}ms apart)`);
  }

  const refetched = new Set();
  let fetched = 0;
  let failed = 0;
  let retry = 0;

  if (need.length) {
    await pool(need, CONCURRENCY, async (job) => {
      const r = await fetchOne(job);
      // `closed` rides on the failure branches too. It was only stored when the
      // fetch succeeded, so a LinkedIn card that said "no longer accepting
      // applications" AND failed to yield a description lost the flag entirely
      // — the two things most likely to happen together.
      cache[job.fingerprint] = r.ok
        ? { text: r.text, at: new Date().toISOString(), closed: Boolean(r.closed) }
        : { error: r.error, at: new Date().toISOString(), transient: isTransient(r.error),
            closed: Boolean(r.closed), gone: Boolean(r.gone) };
      if (r.ok) { fetched++; refetched.add(job.fingerprint); }
      else {
        failed++;
        if (isTransient(r.error)) retry++;
        if (verbose) log.dim(`      ${job.company}: ${r.error}`);
      }
    });
  }

  const descriptions = {};
  for (const j of jobs) {
    const hit = cache[j.fingerprint];
    // Only an improvement counts. Some pages carry a shorter summary than the
    // aggregator did, and overwriting a fuller text with a thinner one would
    // make the checks worse, not better.
    // Normally only an improvement counts. But when the page was deliberately
    // re-read, the new text is the truth even if the ad got shorter — an
    // employer trimming an ad must not leave us judging the longer old one.
    if (hit?.text && (refetched.has(j.fingerprint) || hit.text.length > (j.descriptionText || '').length)) {
      descriptions[j.fingerprint] = hit.text;
    }
  }

  // Derived from the cache rather than from this run's results, so a posting
  // whose 410 was recorded weeks ago still reports `gone` without a fetch.
  const liveness = {};
  for (const j of jobs) liveness[j.fingerprint] = livenessOf(cache[j.fingerprint]);

  const count = (state) => Object.values(liveness).filter((l) => l.state === state).length;

  return {
    descriptions,
    liveness,
    cache,
    fetched,
    failed,
    retry,          // transient failures — these come round again next run
    cached: jobs.length - need.length,
    improved: Object.keys(descriptions).length,
    gone: count('gone'),
    closed: count('closed'),
  };
}

export const __testables = { staleBy, MAX_AGE_DAYS, MAX_FAILURE_AGE_DAYS, hostQueue, gapFor, politeWait, extractEfc, isEfc, refused, throttled };
