import { httpJson, stripHtml } from '../util.js';
import { politeWait } from '../enrich.js';

/**
 * Himalayas — a remote-jobs board with a free, keyless search API that can be
 * asked "who accepts someone based in Germany".
 *
 *     GET https://himalayas.app/jobs/api/search?q=devops&country=Germany&limit=20&page=2
 *
 * WHY IT IS WORTH HAVING NEXT TO REMOTIVE AND REMOTEOK. The company boards read
 * here cover named employers; this finds the long tail — Nebius, Exoscale,
 * team.blue, Megaport, Runware — whose own boards nobody here has configured.
 *
 * WHAT `locationRestrictions` MEANS, which is the part worth getting right: an
 * EMPTY list is a worldwide role (Canonical, Chess.com), a list naming Germany is
 * an explicit Germany-eligible role, and `country=Germany` already excludes the
 * lists that do not name it. So the location reads "Worldwide" or "Germany", and
 * an unrelated country list is passed through for the remote-scope gate to drop.
 * Measured: of 20 SRE results, 12 were worldwide and 8 named Germany.
 *
 * PAGING IS `page=`, NOT `offset=`. The API's own notice calls `offset`
 * deprecated, and on /search it is silently ignored — `offset=20` returned the
 * first page again, which would have made every second page a duplicate of the
 * first with nothing to say so. `page=2` reports `offset: 20` and a different
 * set of jobs.
 *
 * TERMS (stated on the API page, kept here so nobody reinstates the opposite):
 * credit Himalayas with a link — `attribution` below, rendered in the report
 * footer — and do not republish the data to LinkedIn, Google Jobs or Jooble.
 * robots.txt disallows `?page=` only on the HTML listing paths, not on
 * `/jobs/api/`.
 */
export const id = 'himalayas';
export const label = 'Himalayas';
export const attribution = { text: 'Remote jobs via Himalayas', url: 'https://himalayas.app' };

const PAGE_SIZE = 20;
/** Three pages is 60 postings a query, past the point where results are noise. */
const MAX_PAGES = 3;

export const searchUrl = (query, page = 1, country = 'Germany') =>
  `https://himalayas.app/jobs/api/search?${new URLSearchParams({
    q: query, country, limit: String(PAGE_SIZE), page: String(page),
  })}`;

/** Where the role can be done from, in words the remote-scope gate understands. */
export function locationOf(restrictions) {
  const list = Array.isArray(restrictions) ? restrictions.filter(Boolean) : [];
  if (!list.length) return 'Worldwide';
  if (list.includes('Germany')) return 'Germany';
  // Several countries and none of them ours: say so rather than hide it, so the
  // gate can drop it on the stated scope instead of guessing.
  return list.slice(0, 8).join(', ');
}

const salaryOf = (j) => {
  const range = [j.minSalary, j.maxSalary].filter((x) => x != null).join('–');
  return range ? `${range} ${j.currency || ''}${j.salaryPeriod ? `/${j.salaryPeriod}` : ''}`.trim() : null;
};

export function parseJobs(data) {
  const rows = data?.jobs;
  if (!Array.isArray(rows)) return null;

  const out = [];
  for (const j of rows) {
    const title = String(j?.title || '').trim();
    const url = j?.applicationLink || j?.guid;
    if (!title || !url || !j.companyName) continue;

    const html = String(j.description || '');
    out.push({
      source: id,
      sourceLabel: label,
      sourceId: `himalayas:${j.guid || url}`,
      title,
      company: j.companyName,
      location: locationOf(j.locationRestrictions),
      isRemote: true,
      // A HINT, like Remotive's: the advert is complete here, so the text
      // decides and this only stands when there is nothing to read.
      workMode: 'remote',
      descriptionHtml: html,
      descriptionText: stripHtml(html),
      applyUrl: url,
      // Unix SECONDS, not milliseconds.
      postedAt: Number.isFinite(+j.pubDate) ? new Date(+j.pubDate * 1000).toISOString() : null,
      salary: salaryOf(j),
      employmentType: j.employmentType || null,
      tags: j.categories,
    });
  }
  return out;
}

export async function fetchJobs({ queries = [] } = {}) {
  const errors = [];
  const byId = new Map();

  for (const q of queries) {
    for (let page = 1; page <= MAX_PAGES; page++) {
      const url = searchUrl(q, page);
      await politeWait(url);
      const res = await httpJson(url);
      if (!res.ok) { errors.push(`${q} p${page}: ${res.error}`); break; }

      const jobs = parseJobs(res.data);
      if (jobs === null) { errors.push(`${q}: unexpected response shape — the API may have changed`); break; }
      for (const j of jobs) if (!byId.has(j.sourceId)) byId.set(j.sourceId, j);

      // The last page is short; there is no point asking for one more.
      if (res.data.jobs.length < PAGE_SIZE) break;
    }
  }

  return { jobs: [...byId.values()], errors, calls: null };
}

export const __testables = { searchUrl, locationOf, salaryOf, PAGE_SIZE, MAX_PAGES };
