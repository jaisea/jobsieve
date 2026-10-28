import { httpJson, stripHtml } from '../util.js';
import { politeWait } from '../enrich.js';

/**
 * Jobicy — a remote-jobs board with a free, keyless API.
 *
 *     GET https://jobicy.com/api/v2/remote-jobs?count=50&geo=germany&tag=devops
 *
 * `geo=germany` returns roles whose region includes Germany, which in practice
 * means a posting tagged "Europe", "Anywhere" or Germany by name — so the
 * location here is `jobGeo` as the board states it, and a role tagged only
 * "Europe" is left for the remote-scope gate and the model to settle rather than
 * being promoted to "Germany" on a guess.
 *
 * `tag` is a keyword search over the posting, so one request per shared query.
 * Measured 2026-10-01 with geo=germany: devops 4, sre 14, platform 78, cloud 32.
 * The platform count is inflated by "product platform" roles; the title gate
 * downstream is what removes them.
 *
 * TERMS (from the API's own notice, kept here so nobody reinstates the
 * opposite): credit Jobicy with a direct link — `attribution` below, rendered in
 * the report footer — and send applicants to the original job URL the feed
 * provides, which is `applyUrl`.
 *
 * One cosmetic fault is NOT corrected: titles often end " | <Client>" ("Azure
 * DevOps Engineer | KD Pharma") because Jobicy reposts agency adverts. Stripping
 * after a pipe would also cut "Backend | Remote", and the fingerprint is built
 * from the title, so it is left as the board wrote it.
 */
export const id = 'jobicy';
export const label = 'Jobicy';
export const attribution = { text: 'Remote jobs via Jobicy', url: 'https://jobicy.com' };

const COUNT = 50;

export const searchUrl = (query, geo = 'germany') =>
  `https://jobicy.com/api/v2/remote-jobs?${new URLSearchParams({ count: String(COUNT), geo, tag: query })}`;

/** `jobGeo` is "Europe" or "LATAM,  Europe,  USA" — padded, so tidy it. */
export const locationOf = (geo) =>
  String(geo || '').split(',').map((s) => s.trim()).filter(Boolean).join(', ') || 'Remote';

export function parseJobs(data) {
  const rows = data?.jobs;
  if (!Array.isArray(rows)) return null;

  const out = [];
  for (const j of rows) {
    const title = String(j?.jobTitle || '').trim();
    if (!title || !j?.url || !j.id) continue;

    const html = String(j.jobDescription || '');
    out.push({
      source: id,
      sourceLabel: label,
      sourceId: `jobicy:${j.id}`,
      title,
      company: j.companyName || '',
      location: locationOf(j.jobGeo),
      isRemote: true,
      workMode: 'remote',
      descriptionHtml: html,
      descriptionText: stripHtml(html),
      applyUrl: j.url,
      postedAt: j.pubDate || null,
      employmentType: Array.isArray(j.jobType) ? j.jobType.join(', ') : null,
    });
  }
  return out;
}

export async function fetchJobs({ queries = [] } = {}) {
  const errors = [];
  const byId = new Map();

  for (const q of queries) {
    const url = searchUrl(q);
    await politeWait(url);
    const res = await httpJson(url);
    if (!res.ok) { errors.push(`${q}: ${res.error}`); continue; }

    const jobs = parseJobs(res.data);
    if (jobs === null) { errors.push(`${q}: unexpected response shape — the API may have changed`); continue; }
    for (const j of jobs) if (!byId.has(j.sourceId)) byId.set(j.sourceId, j);
  }

  return { jobs: [...byId.values()], errors, calls: null };
}

export const __testables = { searchUrl, locationOf, COUNT };
