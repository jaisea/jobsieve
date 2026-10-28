import { httpJson, stripHtml, pool } from '../util.js';

/**
 * JSearch via RapidAPI — aggregates Google Jobs, which in turn indexes LinkedIn,
 * Indeed, StepStone and company sites. This is the practical, ToS-clean route to
 * those platforms; none of them offer a usable public API directly.
 *
 * Free tier is ~200 requests/MONTH, so this is deliberately frugal: one request
 * per query, and `maxQueries` caps how many queries run at all.
 */
export const id = 'jsearch';
export const label = 'JSearch';
export const requiresKey = ['RAPIDAPI_KEY'];

export async function fetchJobs({
  queries = [], maxQueries = 4, concurrency = 2,
  host = 'jsearch.p.rapidapi.com', path = '/search-v2', country = 'de',
} = {}) {
  const key = process.env.RAPIDAPI_KEY;
  if (!key) return { jobs: [], errors: ['missing RAPIDAPI_KEY'], skipped: true };

  const errors = [];
  const out = [];
  // maxQueries is the caller's BUDGET, not a preference: one query is one
  // request against a ~200/month free tier, and src/quota.js paces it against
  // what is left in the cycle. Slice, never exceed.
  const picked = queries.slice(0, Math.max(0, maxQueries));
  let calls = 0;

  await pool(picked, concurrency, async (q) => {
    // v2 takes an explicit `country` rather than baking it into the query
    // string; without it the API silently defaults to country=us and returns
    // nothing relevant for a German search.
    const params = new URLSearchParams({
      query: q,
      country: country || 'de',
      num_pages: '1',
      date_posted: 'month',
    });
    calls++;
    const res = await httpJson(`https://${host}${path}?${params}`, {
      headers: { 'X-RapidAPI-Key': key, 'X-RapidAPI-Host': host },
    });
    if (!res.ok) {
      // 404 here means the host does not match the subscribed API, not a bad key.
      const hint = res.status === 404
        ? ` — host "${host}" does not match your subscription; copy X-RapidAPI-Host from your RapidAPI code snippet into config/sources.json`
        : res.status === 403
          ? ' — key is valid but not subscribed to this API (subscribe on its Pricing tab)'
          : '';
      errors.push(`${q}: ${res.error}${hint}`);
      return;
    }

    // v2 nests the array: data.jobs, where v1 returned data directly. Accept
    // both so a future rename does not silently produce zero results.
    const rows = Array.isArray(res.data?.data) ? res.data.data : (res.data?.data?.jobs || []);

    for (const j of rows) {
      // v2 leaves job_city / job_state / job_country null on most German rows
      // and puts the readable value in job_location instead.
      const loc = j.job_location
        || [j.job_city, j.job_state, j.job_country].filter(Boolean).join(', ');
      out.push({
        source: id,
        sourceLabel: `${label}${j.job_publisher ? ` · ${j.job_publisher}` : ''}`,
        sourceId: j.job_id,
        title: j.job_title,
        company: j.employer_name || 'Unknown',
        companyUrl: j.employer_website || null,
        location: j.job_is_remote ? `Remote${loc ? ` · ${loc}` : ''}` : loc,
        isRemote: j.job_is_remote === true,
        workMode: j.job_is_remote === true ? 'remote' : null,
        descriptionHtml: '',
        descriptionText: stripHtml(j.job_description || ''),
        applyUrl: j.job_apply_link,
        postedAt: j.job_posted_at_datetime_utc || j.job_posted_at_timestamp,
        employmentType: j.job_employment_type || null,
        salary: j.job_min_salary && j.job_max_salary
          ? `${j.job_salary_currency || ''}${j.job_min_salary}–${j.job_max_salary}`.trim()
          : null,
      });
    }
  });

  return { jobs: out, errors, calls };
}
