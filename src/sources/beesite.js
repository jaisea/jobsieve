import { politeWait } from '../enrich.js';

/**
 * BEESITE — the JSON search behind a family of German career sites
 * (Rexx-fronted portals, one tenant per employer). The first is Markant, a
 * retail-services and IT group: a Cloud Platform Engineer, a Senior
 * Cloud DevOps and an SRE were on its board the day this was built, and it had
 * no feed any other reader here could use.
 *
 *     GET https://{host}/search/?data={"LanguageCode":"EN",
 *         "SearchParameters":{"FirstItem":1,"CountItem":100},"SearchCriteria":[]}
 *
 * The host is NOT guessable — `markant-beesite-production-gjb.app.beesite.de` —
 * and was found from the career page's own XHR calls, so it is configuration
 * (`companies.beesite[].host`), not something derived from the employer's name.
 *
 * The listing carries no advert. Each posting's own page has JobPosting ld+json,
 * which the existing enrich step already reads, so this module only lists —
 * the same arrangement as Personio. `PositionURI` is that page.
 *
 * WHY THIS IS NOT THE SEARCH API ROBOTS.TXT FORBIDS. `jobs.markant.com/robots.txt`
 * holds only a Sitemap line, and the API host answers its own robots.txt with a
 * 404 JSON error — nothing is disallowed on either. Checked 2026-10-01.
 */
export const id = 'beesite';
export const label = 'Beesite boards';

const UA = 'Mozilla/5.0 (compatible; jobsieve/1.0; +https://github.com/jaisea/jobsieve)';

/** Items per request. The board answered 100 without complaint. */
const PAGE = 100;
/** A runaway guard: 20 pages is 2,000 postings, far past any employer here. */
const MAX_PAGES = 20;

export const searchUrl = (host, first = 1) => {
  const data = { LanguageCode: 'EN', SearchParameters: { FirstItem: first, CountItem: PAGE }, SearchCriteria: [] };
  return `https://${host}/search/?data=${encodeURIComponent(JSON.stringify(data))}`;
};

/**
 * Every office listed, joined — a multi-site role must keep the mention that
 * anchors it near home, the same reasoning as the Personio and Teamtailor
 * readers.
 */
function locationOf(descriptor) {
  const places = (descriptor.PositionLocation || [])
    .map((l) => [l.CityName, l.CountryName].filter(Boolean).join(', '))
    .filter(Boolean);
  return [...new Set(places)].join(' · ');
}

export function parseSearch(data, { slug, name } = {}) {
  const items = data?.SearchResult?.SearchResultItems;
  if (!Array.isArray(items)) return null;

  const out = [];
  for (const item of items) {
    const d = item?.MatchedObjectDescriptor;
    const jobId = d?.ID || item?.MatchedObjectId;
    const title = String(d?.PositionTitle || '').trim();
    const url = d?.PositionURI;
    // index.js drops anything without a title and a link, so do not emit it.
    if (!jobId || !title || !url) continue;

    out.push({
      source: id,
      sourceLabel: `${label} — ${name || slug}`,
      // An id, not the URL: normaliseSourceId() strips the query string, and
      // this site's postings differ ONLY in `?ac=jobad&id=494`, so a URL-shaped
      // id would collapse every posting into one — the Indeed collision again.
      sourceId: `beesite:${slug}:${jobId}`,
      title,
      // The legal entity actually hiring: a group board lists several
      // ("Markant Services International GmbH", "Markant European Payment
      // Services GmbH"), and the fingerprint is built from it.
      company: String(d.ParentOrganizationName || name || slug).trim(),
      location: locationOf(d),
      applyUrl: url,
      postedAt: d.PublicationStartDate || null,
      employmentType: d.PositionSchedule?.[0]?.Name || null,
      descriptionText: '',
      descriptionHtml: '',
    });
  }
  return out;
}

export async function fetchJobs({ boards = [] } = {}) {
  const errors = [];
  const out = [];

  for (const board of boards) {
    if (board.enabled === false) continue;
    const { slug, host, name } = board;
    if (!slug || !host) { errors.push(`${name || 'a Beesite board'}: needs both a slug and a host`); continue; }

    let total = Infinity;
    let got = 0;
    for (let page = 0; page < MAX_PAGES && got < total; page++) {
      const url = searchUrl(host, got + 1);
      await politeWait(url);
      let res;
      try {
        res = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json' } });
      } catch (e) {
        errors.push(`${name || slug}: ${e.message}`);
        break;
      }
      if (!res.ok) { errors.push(`${name || slug}: HTTP ${res.status} from ${host}`); break; }

      let data;
      try { data = await res.json(); } catch { errors.push(`${name || slug}: the response was not JSON`); break; }

      const jobs = parseSearch(data, { slug, name });
      if (jobs === null) { errors.push(`${name || slug}: unexpected response shape — the API may have changed`); break; }

      total = Number(data.SearchResult.SearchResultCountAll) || 0;
      const returned = data.SearchResult.SearchResultItems.length;
      out.push(...jobs);
      got += returned;
      if (!returned) break;
    }
    if (!got && !errors.some((e) => e.startsWith(`${name || slug}:`))) {
      errors.push(`${name || slug}: the board returned no postings`);
    }
  }

  return { jobs: out, errors, calls: null };
}

export const __testables = { searchUrl, locationOf, PAGE };
