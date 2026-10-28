import { httpJson, stripHtml, pool } from '../util.js';

/**
 * Adzuna DE — free developer key (~250 calls/day).
 * Adzuna indexes a broad slice of the German market including listings that
 * originate on StepStone and XING, which have no usable public API of their own.
 */
export const id = 'adzuna';
export const label = 'Adzuna DE';
export const requiresKey = ['ADZUNA_APP_ID', 'ADZUNA_APP_KEY'];

export async function fetchJobs({ queries = [], profile, country = 'de', maxPages = 1, concurrency = 2 } = {}) {
  const appId = process.env.ADZUNA_APP_ID;
  const appKey = process.env.ADZUNA_APP_KEY;
  if (!appId || !appKey) return { jobs: [], errors: ['missing ADZUNA_APP_ID / ADZUNA_APP_KEY'], skipped: true };

  const { city, radiusKm } = profile.location;
  const errors = [];
  const out = [];
  // One task is one request. Reported so the daily budget in src/quota.js fills
  // on what was actually sent rather than on a guess.
  let calls = 0;

  // Two passes per query: local (radius around the home city) and nationwide remote.
  const tasks = [];
  for (const q of queries) {
    for (let page = 1; page <= maxPages; page++) {
      tasks.push({ q, page, mode: 'local' });
      tasks.push({ q, page, mode: 'remote' });
    }
  }

  await pool(tasks, concurrency, async ({ q, page, mode }) => {
    calls++;
    const params = new URLSearchParams({
      app_id: appId,
      app_key: appKey,
      results_per_page: '50',
      'content-type': 'application/json',
      max_days_old: '45',
    });
    if (mode === 'local') {
      params.set('what', q);
      params.set('where', city);
      params.set('distance', String(radiusKm));
    } else {
      params.set('what', `${q} remote`);
    }

    const url = `https://api.adzuna.com/v1/api/jobs/${country}/search/${page}?${params}`;
    const res = await httpJson(url);
    if (!res.ok) { errors.push(`${q} (${mode}) p${page}: ${res.error}`); return; }

    for (const j of res.data?.results || []) {
      out.push({
        source: id,
        sourceLabel: label,
        sourceId: String(j.id),
        title: j.title,
        company: j.company?.display_name || 'Unknown',
        location: j.location?.display_name || '',
        descriptionHtml: '',
        descriptionText: stripHtml(j.description || ''),
        applyUrl: j.redirect_url,
        postedAt: j.created,
        salary: j.salary_min && j.salary_max
          ? `€${Math.round(j.salary_min / 1000)}k–€${Math.round(j.salary_max / 1000)}k`
          : null,
        employmentType: j.contract_time || j.contract_type || null,
      });
    }
  });

  return { jobs: out, errors, calls };
}
