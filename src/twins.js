/**
 * The same role listed twice, once by the employer and once by an aggregator.
 *
 * Himalayas and Jobicy hand back their OWN page as the apply link (the page
 * redirects to the employer, behind a Cloudflare challenge no fetch can pass), and
 * a location that is a region ("Germany", "Worldwide") where the employer's board
 * lists cities. So neither the posting id nor the fingerprint ever matches the
 * employer's copy: "Senior SRE (DevTools)" at Nebius was open from Himalayas while
 * the same role, applied to from Nebius's own board, sat under another fingerprint.
 *
 * Company + title alone is not safe, and neither is the advert alone. Measured over
 * 10,110 stored postings: employers post ONE template per city (Elastic's Search
 * Algorithms role in 8 countries, Datadog, HelloFresh), so same company, same title
 * and a >= 0.8 similar advert is routine among genuinely distinct postings of ONE
 * source. What separates a twin is a DIFFERENT source with an aggregator on one
 * side — 103 of 127 such pairs with text on both sides scored >= 0.8, and the
 * rest are mostly a city-per-copy board against an aggregator's rewritten text.
 *
 * So the rule is conservative: it only ever errs toward showing a job twice, which
 * is the cheaper failure (a wrong merge hides a job; a missed one shows it twice).
 */

/** Sources that re-list other employers' postings and cannot say where, or link to, the real one. */
export const AGGREGATORS = new Set(['himalayas', 'jobicy']);

export const MIN_ADVERT_CHARS = 300;
export const MIN_SIMILARITY = 0.8;

const GENDER_TAG = /\((?:\s*(?:[mwfdxgn*]|all genders)\s*[/|,]?)+\)/gi;
const LEGAL_FORM = /\b(gmbh|ag|se|inc|llc|ltd|limited|co kg|kg|corp|corporation|bv|plc)\b/g;

const words = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9äöüß]+/g, ' ').trim();

/** Company and title as one key. Parentheses that name a team ("(DevTools)") stay: they tell roles apart. */
export function twinKey(job) {
  const company = words(job.company).replace(LEGAL_FORM, ' ').replace(/\s+/g, ' ').trim();
  const title = words(String(job.title || '').replace(GENDER_TAG, ' '));
  return company && title ? `${company}|${title}` : '';
}

function shingles(text, n = 4) {
  const w = words(text).split(' ').filter(Boolean);
  const out = new Set();
  for (let i = 0; i + n <= w.length; i++) out.add(w.slice(i, i + n).join(' '));
  return out;
}

/** Jaccard similarity of two adverts' four-word phrases, or null when either is too short to judge. */
export function advertSimilarity(a, b) {
  if (String(a || '').length < MIN_ADVERT_CHARS || String(b || '').length < MIN_ADVERT_CHARS) return null;
  const A = shingles(a);
  const B = shingles(b);
  if (!A.size || !B.size) return null;
  let both = 0;
  for (const x of A) if (B.has(x)) both++;
  return both / (A.size + B.size - both);
}

/**
 * Is `job` (not yet known) the same role as `candidate` (already filed, with its
 * `sources`)? Same source never merges; an aggregator must be on one side.
 */
export function isTwin(job, candidate, candidateSources) {
  if (candidateSources.includes(job.source)) return false;
  const viaAggregator = AGGREGATORS.has(job.source) || candidateSources.some((s) => AGGREGATORS.has(s));
  if (!viaAggregator) return false;
  if (!twinKey(job) || twinKey(job) !== twinKey(candidate)) return false;
  const sim = advertSimilarity(job.descriptionText, candidate.descriptionText);
  return sim !== null && sim >= MIN_SIMILARITY;
}

/** company+title -> fingerprints, over the filed jobs. Kept up to date by the caller as jobs are added. */
export function indexTwins(state) {
  const byKey = new Map();
  for (const [fp, job] of Object.entries(state.jobs || {})) addToTwinIndex(byKey, fp, job);
  return byKey;
}

export function addToTwinIndex(byKey, fp, job) {
  const k = twinKey(job);
  if (!k) return;
  if (!byKey.has(k)) byKey.set(k, []);
  byKey.get(k).push(fp);
}

/** The fingerprint `job` is a twin of, or null. Longest advert wins ties, so the choice is stable. */
export function findTwin(job, state, byKey) {
  const k = twinKey(job);
  if (!k) return null;
  let best = null;
  for (const fp of byKey.get(k) || []) {
    const cand = state.jobs[fp];
    const entry = state.seen[fp];
    if (!cand || !entry || !isTwin(job, cand, entry.sources || [])) continue;
    if (!best || (cand.descriptionText?.length || 0) > (state.jobs[best].descriptionText?.length || 0)) best = fp;
  }
  return best;
}
