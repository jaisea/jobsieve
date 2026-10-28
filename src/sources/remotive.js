import { httpJson, stripHtml } from '../util.js';

/**
 * Remotive — free, no key, remote-only. Filtered by CATEGORY to keep the
 * payload small; queries add nothing on top of that. The categories are the
 * user's field, so they come from sources.json (`remotive.categories`); see
 * https://remotive.com/api/remote-jobs/categories for the slugs.
 */
export const id = 'remotive';
export const label = 'Remotive';

export async function fetchJobs({ limit = 200, categories = ['software-dev'] } = {}) {
  const errors = [];
  const out = [];

  const urls = categories.map((c) =>
    `https://remotive.com/api/remote-jobs?category=${encodeURIComponent(c)}&limit=${limit}`);

  for (const url of urls) {
    const res = await httpJson(url);
    if (!res.ok) { errors.push(res.error); continue; }

    for (const j of res.data?.jobs || []) {
      out.push({
        source: id,
        sourceLabel: label,
        sourceId: String(j.id),
        title: j.title,
        company: j.company_name,
        companyUrl: j.company_logo ? null : null,
        location: j.candidate_required_location || 'Remote',
        isRemote: true,
        workMode: 'remote',
        descriptionHtml: j.description,
        descriptionText: stripHtml(j.description),
        applyUrl: j.url,
        postedAt: j.publication_date,
        salary: j.salary || null,
        employmentType: j.job_type || null,
        tags: j.tags,
      });
    }
  }

  return { jobs: out, errors };
}
