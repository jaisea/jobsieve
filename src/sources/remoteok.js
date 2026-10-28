import { httpJson, stripHtml } from '../util.js';

/**
 * RemoteOK — free, no key.
 * NOTE: their API terms require a visible, followable link back to remoteok.com.
 * report.js renders that attribution; do not remove it while this source is on.
 */
export const id = 'remoteok';
export const label = 'RemoteOK';
export const attribution = { text: 'Remote jobs via RemoteOK', url: 'https://remoteok.com' };

export async function fetchJobs() {
  const res = await httpJson('https://remoteok.com/api');
  if (!res.ok) return { jobs: [], errors: [res.error] };

  const rows = Array.isArray(res.data) ? res.data : [];
  const out = [];

  for (const j of rows) {
    // First element is the legal/ToS notice, not a job.
    if (!j || !j.id || !j.position) continue;

    const desc = j.description || '';
    out.push({
      source: id,
      sourceLabel: label,
      sourceId: String(j.id),
      title: j.position,
      company: j.company,
      location: j.location || 'Remote',
      isRemote: true,
      workMode: 'remote',
      descriptionHtml: desc,
      descriptionText: stripHtml(desc),
      applyUrl: j.url || j.apply_url,
      postedAt: j.date || j.epoch,
      salary: j.salary_min && j.salary_max ? `$${j.salary_min}–$${j.salary_max}` : null,
      tags: j.tags,
    });
  }

  return { jobs: out, errors: [] };
}
