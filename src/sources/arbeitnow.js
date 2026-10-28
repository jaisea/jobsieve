import { httpJson, stripHtml } from '../util.js';

/**
 * Arbeitnow — free, no key, Germany-focused, and usefully tags visa sponsorship
 * and English-speaking roles. Verified live: 175 jobs, one page.
 */
export const id = 'arbeitnow';
export const label = 'Arbeitnow';

export async function fetchJobs({ pages = 3 } = {}) {
  const out = [];
  const errors = [];

  for (let page = 1; page <= pages; page++) {
    const url = `https://www.arbeitnow.com/api/job-board-api?page=${page}`;
    const res = await httpJson(url);
    if (!res.ok) {
      errors.push(`page ${page}: ${res.error}`);
      break;
    }
    const rows = res.data?.data || [];
    if (!rows.length) break;

    for (const j of rows) {
      out.push({
        source: id,
        sourceLabel: label,
        sourceId: j.slug,
        title: j.title,
        company: j.company_name,
        location: j.location,
        isRemote: j.remote === true,
        workMode: j.remote === true ? 'remote' : null,
        descriptionHtml: j.description,
        descriptionText: stripHtml(j.description),
        applyUrl: j.url,
        postedAt: j.created_at,
        employmentType: Array.isArray(j.job_types) ? j.job_types.join(', ') : null,
        tags: j.tags,
      });
    }
  }

  return { jobs: out, errors };
}
