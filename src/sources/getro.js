import { politeWait } from '../enrich.js';

/**
 * VC PORTFOLIO BOARDS.
 *
 * A fund runs one job board covering every company it has invested in, and the
 * job belongs to the portfolio company rather than to the fund. Getro is the
 * platform most European funds use for this.
 *
 * It is the only source here that answers "who is hiring across a whole
 * portfolio". Every other source either aggregates (Adzuna, JSearch), is a
 * government API, or polls a board we already knew to look for. These are small
 * employers nobody would think to add one at a time — measured below, they are
 * also where the genuinely remote German platform roles turn up.
 *
 * Cost scales with QUERIES, not with postings, which is what makes it worth
 * having: six boards holding 9,400 postings between them cost 42 requests.
 * Compare Workday at up to 355 and apriori at up to 162.
 */
export const id = 'getro';
export const label = 'VC portfolio boards';

const UA = 'Mozilla/5.0 (compatible; jobsieve/1.0; +https://github.com/jaisea/jobsieve)';

const API = (collection) => `https://api.getro.com/api/v2/collections/${collection}/search/jobs`;

/** One page is plenty: the term searches already narrow it hard. */
const PER_PAGE = 100;

/**
 * The two filter keys, neither of which is where you would guess.
 *
 * The search term is `query` at the ROOT of the body. Work mode is
 * `filters.work_mode`. Probed against a live board, these were all silently
 * ignored and returned the full unfiltered count: `searchQuery` (root and
 * nested), `filters.q`, `filters.search`, `filters.keyword`, `filters.remote`,
 * `filters.workMode`.
 *
 * That is the failure mode worth a test. A wrong key does not error — it
 * returns a plausible number that happens to be every posting on the board, so
 * the source would look like it was working while filtering nothing.
 */
const searchBody = (query, page = 0) => ({
  hitsPerPage: PER_PAGE,
  page,
  query,
  filters: { work_mode: ['remote'] },
});

/**
 * `Accept: application/json` is REQUIRED. Without it the API answers **406**,
 * not 400 and not 415 — a content-negotiation refusal that reads like a bad
 * request. Referer and Origin are checked too; the board URL supplies both.
 */
const headers = (board) => ({
  'Content-Type': 'application/json',
  Accept: 'application/json',
  Referer: board,
  Origin: new URL(board).origin,
  'user-agent': UA,
});

/**
 * The board's numeric network id, from the page's `__NEXT_DATA__`.
 *
 * **It is a STRING in the JSON** — `"network":{"id":"617"}` — which is what
 * broke the first version of this: a resolver expecting `"id":617` matched
 * nothing and every board reported "unresolved". The quote is optional in the
 * pattern for that reason.
 *
 * Resolving costs one page fetch, so a board that records its id in config
 * skips it. Ids are stable; they are cached in companies.json once found.
 */
export async function resolveCollection(boardUrl) {
  await politeWait(boardUrl);
  const res = await fetch(boardUrl, { headers: { 'user-agent': UA, accept: 'text/html' } });
  if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
  const html = await res.text();
  const m = html.match(/"network":\{"id":"?(\d+)"?/);
  return m ? { ok: true, collection: m[1] } : { ok: false, error: 'no network id in the page' };
}

async function search(collection, boardUrl, query) {
  await politeWait(boardUrl);
  const res = await fetch(API(collection), {
    method: 'POST',
    headers: headers(boardUrl),
    body: JSON.stringify(searchBody(query)),
  });
  if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
  const data = await res.json().catch(() => null);
  if (!data) return { ok: false, error: 'response was not JSON' };
  return { ok: true, jobs: data.results?.jobs || [], count: data.results?.count ?? null };
}

/**
 * Turn one Getro record into the raw shape normalize() expects.
 *
 * Two fields need stating plainly.
 *
 * `work_mode` is carried as `workMode`, which normalize() treats as a HINT and
 * only while there is no advert to read (`src/normalize.js:59`). That is
 * deliberate and is the same rule the Arbeitsagentur remote pass follows: a
 * board's own tag means "somebody ticked remote in a form", and the posting
 * outranks the aggregator. `enrich` fetches the real advert and the text
 * decides.
 *
 * `url` is the CANONICAL ATS posting — `boards.greenhouse.io/<co>/jobs/<id>` —
 * not a Getro redirect. So a company already polled through companies.json
 * produces the same applyUrl from both routes and the fingerprint merges them
 * with no extra work. That is worth knowing before anyone adds a dedup rule
 * here: there is nothing to dedup that the fingerprint does not already do.
 */
function toRaw(job, fundName) {
  const company = job.organization?.name || job.company?.name || '';
  return {
    source: id,
    sourceLabel: `${label} — ${fundName}`,
    // Getro's own id is not stable across boards and a posting can appear on
    // two funds' boards, so the ATS url is the identity. normaliseSourceId()
    // strips the query, which is what makes the two spellings equal.
    sourceId: `getro:${job.url}`,
    title: job.title || '',
    company,
    /* The WHOLE location list, joined, and it looks like noise but is not.
     *
     * Getro returns a widening list: ["Munich, Germany", "Upper Bavaria",
     * "Bavaria", "Germany", "Europe", "Remote"]. Taking only the first
     * looks tidier and measures WORSE, because normalize() derives
     * `remoteScope` from the resolved country, and on a remote posting the
     * first entry is often just "Remote":
     *
     *   "Remote, Greece, Europe"  -> country GR, remoteScope EU
     *   "Remote"                  -> country null, remoteScope null
     *
     * The trailing entries are what anchor a remote role to a continent, and
     * that is exactly the signal the location gate needs to tell a European
     * remote job from a US-only one. */
    location: (job.searchable_locations || []).join(', '),
    workMode: job.work_mode === 'remote' ? 'remote' : undefined,
    applyUrl: job.url,
    postedAt: job.created_at ? new Date(job.created_at * 1000).toISOString() : null,
    descriptionText: '',
    descriptionHtml: '',
  };
}

/**
 * Search terms.
 *
 * They are the profile's search queries (profile.searchQueries, falling back to
 * the target titles). The API's match is loose — searching infrastructure terms
 * returned a Salesforce Administrator and a Java developer — so the list only
 * has to be wide enough to reach the right corner of a 2,000-posting board. The
 * title gate does the real filtering afterwards, for free, in phase 1.1.
 *
 * Trusting Getro's relevance would be the mistake; it is worth having for its
 * REACH. Cost scales with the number of queries, so keep them few.
 */
export async function fetchJobs({ boards = [], queries = [], terms = queries } = {}) {
  const errors = [];
  const out = [];
  // Keyed on the ATS url: a role held by two funds is one posting, and both
  // Point Nine and Cherry list the same Berlin companies.
  const seen = new Set();

  for (const board of boards) {
    if (board.enabled === false) continue;
    const name = board.name || board.url;

    let collection = board.collection;
    if (!collection) {
      const r = await resolveCollection(board.url);
      if (!r.ok) { errors.push(`${name}: could not resolve the board id — ${r.error}`); continue; }
      collection = r.collection;
      // Said out loud, because the id is worth pasting into companies.json to
      // save a page fetch every run.
      errors.push(`${name}: resolved collection ${collection} — add "collection": "${collection}" to skip this lookup`);
    }

    let found = 0;
    for (const term of terms) {
      const r = await search(collection, board.url, term);
      if (!r.ok) { errors.push(`${name} "${term}": ${r.error}`); continue; }
      for (const job of r.jobs) {
        if (!job.url || seen.has(job.url)) continue;
        seen.add(job.url);
        out.push(toRaw(job, name));
        found++;
      }
    }
    if (!found) errors.push(`${name}: no remote postings matched any search term`);
  }

  // No `calls` — nothing here is metered, and reporting 0 would bill a source
  // that has no budget. careersites.js and agencies.js return null for the
  // same reason.
  return { jobs: out, errors, calls: null };
}

export const __testables = { searchBody, headers, toRaw, API };
