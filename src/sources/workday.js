import { httpJson, stripHtml, pool, slug } from '../util.js';

/**
 * Workday — the missing half of "company websites".
 *
 * The five ATS platforms in ats.js cover remote-first tech companies well and
 * large German/Swiss industrials not at all: a discover run found boards for 2
 * of 19 regional candidates in Germany and 1 of 10 in Switzerland. Roche, Novartis,
 * ZEISS and their peers run Workday, which those adapters cannot see.
 *
 * Workday career sites are backed by a public JSON API — the same one the site's
 * own front-end calls — so this needs no scraping, no key and no browser:
 *
 *   POST /wday/cxs/{tenant}/{site}/jobs      -> paged listing
 *   GET  /wday/cxs/{tenant}/{site}{path}     -> full description
 *
 * Verified against Novartis: 964 postings, and detail records carrying ~3.6k
 * characters of description, a country code and a canonical apply URL.
 *
 * TENANTS CANNOT BE GUESSED. `*.myworkdayjobs.com` is a wildcard, so a made-up
 * tenant answers 422 rather than failing to resolve — probing invents companies
 * that do not exist. Each entry has to come from a real career-site URL; see
 * `parseWorkdayUrl` and the README.
 */
export const id = 'workday';
export const label = 'Workday boards';

/** Listing pages are 20 at a time; this bounds a single company's crawl. */
const PAGE = 20;
const MAX_PAGES = 10;

/**
 * Turn a career-site URL into the three parts the API needs.
 *
 * Given https://novartis.wd3.myworkdayjobs.com/en-US/Novartis_Careers
 * returns { tenant: 'novartis', pod: 'wd3', site: 'Novartis_Careers' }.
 *
 * This is how a company gets added: browse to its jobs page, copy the URL.
 * The locale segment (en-US, de-DE) is optional and ignored.
 */
export function parseWorkdayUrl(url) {
  const m = String(url).match(
    /https?:\/\/([\w-]+)\.(wd\d+)\.myworkdayjobs\.com\/(?:[a-z]{2}-[A-Z]{2}\/)?([\w-]+)/
  );
  if (!m) return null;
  return { tenant: m[1], pod: m[2], site: m[3] };
}

const cxs = ({ tenant, pod, site }) =>
  `https://${tenant}.${pod}.myworkdayjobs.com/wday/cxs/${tenant}/${site}`;

/**
 * Confirm a tenant/site combination is real and serving jobs.
 *
 * A wrong site name answers 422 and a wrong tenant 404, so only a 200 with a
 * numeric total counts — anything else means the entry is wrong, not that the
 * company has no openings.
 */
export async function probe(board) {
  const res = await httpJson(`${cxs(board)}/jobs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ appliedFacets: {}, limit: 1, offset: 0, searchText: '' }),
  });
  if (!res.ok) return { ok: false, error: `HTTP ${res.status}`, status: res.status };
  const total = res.data?.total;
  if (typeof total !== 'number') return { ok: false, error: 'no job total in response' };
  return { ok: true, count: total };
}

/** One page of the listing. */
async function page(board, searchText, offset, appliedFacets = {}) {
  const res = await httpJson(`${cxs(board)}/jobs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ appliedFacets, limit: PAGE, offset, searchText }),
  });
  if (!res.ok) return { error: `HTTP ${res.status}` };
  return { total: res.data?.total ?? 0, jobs: res.data?.jobPostings || [], facets: res.data?.facets || [] };
}

/**
 * Server-side country filtering.
 *
 * Worth far more than filtering after the fact: these are global employers, and
 * a search of Stryker returned 63 postings where restricting to Germany returned
 * 4. Each of the other 59 would otherwise cost a detail request
 * before the location gate discarded it.
 *
 * Two things about Workday's facets make this less obvious than it looks.
 *
 * THE KEY IS TENANT-SPECIFIC. Sanofi and Novartis nest `locationCountry` inside
 * `locationMainGroup`; Stryker and Pfizer expose a top-level `Location_Country`;
 * Roche offers no country facet at all. So the key is discovered per board by
 * walking the tree, not assumed.
 *
 * THE VALUES ARE PER-SEARCH, THE IDS ARE GLOBAL. A facet response lists only the
 * countries matching that search, so "devops engineer" at Novartis can come back
 * with Spain and Austria and no Germany — which says nothing about whether the
 * board can filter on Germany. Reading ids from one search alone concluded "no
 * such facet" and left three boards of five unfiltered. The ids themselves are
 * Workday reference data and proved identical across tenants (Germany is
 * dcc5b760… at Sanofi, Stryker and Novartis alike), so they are accumulated
 * across every response and shared between boards.
 */
const LEARNED = new Map();   // slug(country name) -> facet id

/** Record every country id seen, and return this board's facet key. */
function learnFacets(facets) {
  let key = null;
  const walk = (nodes) => {
    for (const n of nodes || []) {
      const values = n.values || [];
      if (/country/i.test(n.facetParameter || '') && values.some((v) => v.id && v.descriptor)) {
        key = key || n.facetParameter;
        for (const v of values) if (v.id && v.descriptor) LEARNED.set(slug(v.descriptor), v.id);
      }
      walk(values);
    }
  };
  walk(facets);
  return key;
}

/** The appliedFacets block for a board, or null if it cannot be built yet. */
function countryFacet(key, wanted) {
  if (!key) return null;
  const ids = wanted.map((w) => LEARNED.get(slug(w))).filter(Boolean);
  return ids.length ? { [key]: ids } : null;
}

/**
 * The listing carries title, location and a relative path — but no description
 * and no real date ("Posted Today"). The detail call supplies all three, so it
 * is worth one request for each posting that survives the title filter.
 */
async function detail(board, externalPath) {
  const res = await httpJson(`${cxs(board)}${externalPath}`);
  if (!res.ok) return null;
  return res.data?.jobPostingInfo || null;
}

/**
 * Workday reports recency as prose — "Posted Today", "Posted 30+ Days Ago" —
 * which the freshness score cannot use. The detail record carries a real
 * `startDate`; this is only the fallback when it does not.
 */
function approximateDate(postedOn) {
  const t = String(postedOn || '').toLowerCase();
  const days = /today/.test(t) ? 0
    : /yesterday/.test(t) ? 1
      : Number(t.match(/(\d+)\+?\s*day/)?.[1] ?? NaN);
  if (Number.isNaN(days)) return null;
  return new Date(Date.now() - days * 86400e3).toISOString();
}

export async function fetchJobs({
  boards = [], queries = [], concurrency = 3, titleFilter = null, locationFilter = null,
  countries = [],
} = {}) {
  const errors = [];
  const out = [];
  const seen = new Set();

  await pool(boards, concurrency, async (board) => {
    const cfg = { tenant: board.tenant, pod: board.pod, site: board.site };
    // An empty search returns the whole board; a term-by-term search is far
    // cheaper on a 964-posting tenant and is what the keyword sources do.
    const terms = queries.length ? queries : [''];

    // Re-evaluated on every response rather than settled once: the ids may only
    // become known from a later term, or from another board entirely.
    let facetKey = null;

    for (const term of terms) {
      for (let offset = 0; offset < PAGE * MAX_PAGES; offset += PAGE) {
        const r = await page(cfg, term, offset, countries.length ? (countryFacet(facetKey, countries) || {}) : {});
        if (r.error) { errors.push(`${board.name || board.tenant}: ${r.error}`); break; }
        if (countries.length) facetKey = learnFacets(r.facets || []) || facetKey;
        if (!r.jobs.length) break;

        const wanted = r.jobs.filter((j) => {
          const key = `${board.tenant}:${j.externalPath}`;
          if (seen.has(key)) return false;      // the same job matches several terms
          if (titleFilter && !titleFilter(j.title)) return false;
          // These are global employers: a plain search returns Hyderabad,
          // Budapest and Madrid alongside nearby offices. The listing already carries the
          // location, so filtering here avoids a detail request per posting that
          // the location gate would discard seconds later — 67 fetches to keep 1
          // in the first measured run.
          if (locationFilter && !locationFilter(j.locationsText || '')) return false;
          seen.add(key);
          return true;
        });

        await pool(wanted, 2, async (j) => {
          const d = await detail(cfg, j.externalPath);
          const html = d?.jobDescription || '';
          out.push({
            source: id,
            sourceId: `workday:${board.tenant}:${d?.jobReqId || j.externalPath}`,
            title: d?.title || j.title,
            company: board.name || board.tenant,
            location: d?.location || j.locationsText || '',
            country: d?.country?.descriptor || null,
            employmentType: d?.timeType || null,
            descriptionHtml: html,
            descriptionText: stripHtml(html),
            // externalUrl is the page a human should land on; the CXS path is
            // an API route and would be useless in the report.
            applyUrl: d?.externalUrl
              || `https://${board.tenant}.${board.pod}.myworkdayjobs.com/${board.site}${j.externalPath}`,
            postedAt: d?.startDate || approximateDate(j.postedOn),
          });
        });

        if (offset + PAGE >= (r.total ?? 0)) break;
      }
    }
  });

  return { jobs: out, errors };
}

export const __testables = { parseWorkdayUrl, approximateDate, cxs, learnFacets, countryFacet, LEARNED };
