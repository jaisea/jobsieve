/**
 * GermanTechJobs — an IT-only job board for Germany, from the team behind
 * SwissDevJobs. Every posting carries a salary band and a tech stack, because
 * the board makes both mandatory.
 *
 * WHY THE JSON AND NOT THE PAGE. The site is a React shell: `/jobs/DevOps/remote`
 * returns 4.7 KB of `<div id="root">` and "Almost ready 😊". The data behind it
 * is `/api/jobsLight` — the WHOLE board in one response, 1,032 postings and
 * 1.5 MB on 2026-10-01. robots.txt disallows `/api/` for Meta-ExternalAgent
 * only; for everyone else it is open. `/api/jobs` is not the route: it answers
 * "ENDPOINT Deprecated" with a 200, which would parse as no jobs at all.
 *
 * WHY A SECOND REQUEST, AND WHY NOT THE PAGE. The light list has no advert.
 * `/api/jobWithUrl/<slug>` returns the full record — description,
 * responsibilities, must-have and nice-to-have requirements — and is what the
 * site's own client calls. The job PAGE was tried first: the server usually
 * injects the same record as `window.__detailedJob = {…}`, but not always — 6
 * of 80 pages came back as the bare shell with `"JOB_PLACEHOLDER"` in that
 * slot, and the client then falls back to this API. Going straight to it is one
 * code path instead of two, and JSON instead of a regex over HTML. There is no
 * JSON-LD anywhere, which is why `enrich.js` could not do this on its own.
 *
 * WHY THIS IS CHEAP. One request for the list, then the title gate on `name`
 * before any advert is fetched. Measured 2026-10-01: 1,032 listed, 209 pass the
 * title pre-filter — about 85 seconds at the shared 400ms gap.
 *
 * WHY THERE IS NO DISTANCE PRE-FILTER. The board files each posting as
 * office / hybrid / remote, and 184 of the 209 are "office" — which looks like a
 * licence to drop the far ones unread. It is not. Of the first 80 adverts read,
 * six the board calls office say remote in their own text: Debeka (Koblenz),
 * Adacor (Offenbach), Deloitte (Hannover), samecon twice (Eschborn), COC
 * (Hannover) — all beyond the radius, every one of them dropped by a pre-filter
 * that trusted the tag. The posting outranks the aggregator.
 */
import { stripHtml } from '../util.js';
import { politeWait } from '../enrich.js';
import { haversineKm } from '../geo.js';

export const id = 'germantechjobs';
export const label = 'GermanTechJobs';

const UA = 'Mozilla/5.0 (compatible; jobsieve/1.0; +https://github.com/jaisea/jobsieve)';
const ORIGIN = 'https://germantechjobs.de';
const LIST = `${ORIGIN}/api/jobsLight`;
const DETAIL = (jobUrl) => `${ORIGIN}/api/jobWithUrl/${encodeURIComponent(jobUrl)}`;
const pageUrl = (jobUrl) => `${ORIGIN}/jobs/${jobUrl}`;

/** Adverts fetched per run. 209 pass the title gate today; the headroom is for growth. */
const MAX_DETAIL = 300;

async function get(url, accept) {
  // The shared per-host queue. A couple of hundred requests come off one host here.
  await politeWait(url);
  const res = await fetch(url, { headers: { 'user-agent': UA, accept } });
  if (!res.ok) return { ok: false, status: res.status };
  return { ok: true, text: await res.text() };
}

/** Plain text with line breaks, decoded if the employer pasted markup. */
const text = (s) => {
  const t = String(s || '').trim();
  return /<[a-z/][^>]*>|&[a-z#0-9]+;/i.test(t) ? stripHtml(t) : t;
};

/**
 * The advert as ONE text, in the order the page shows it.
 *
 * The requirements are separate fields, and they are where a language
 * requirement is usually stated — "Fließende Deutschkenntnisse" sits under
 * must-haves, not in the company blurb. Reading `description` alone would hand
 * the German gate the half of the advert least likely to mention it.
 */
export function advertOf(job) {
  return [
    [null, job.description],
    ['Aufgaben / Responsibilities', job.responsibilitiesTextArea],
    ['Anforderungen / Requirements', job.requirementsMustTextArea],
    ['Nice to have', job.requirementsNiceTextArea],
  ]
    .map(([head, body]) => [head, text(body)])
    .filter(([, body]) => body)
    .map(([head, body]) => (head ? `${head}\n${body}` : body))
    .join('\n\n');
}

/**
 * The board's own workplace field, carried as a HINT. normalize() honours it
 * only while there is no advert to read, and these postings always arrive with
 * one — so in practice the advert decides, which is the rule everywhere else:
 * the posting outranks the aggregator. "office" maps to nothing rather than to
 * onsite; the resolved city already says that.
 */
const WORKPLACE = { remote: 'remote', hybrid: 'hybrid' };

const distanceFrom = (job, home) =>
  home && Number.isFinite(job.latitude) && Number.isFinite(job.longitude)
  && Number.isFinite(home.lat) && Number.isFinite(home.lon)
    ? haversineKm([home.lat, home.lon], [job.latitude, job.longitude])
    : null;

/**
 * One record (the light one, merged with the page's) in the shape normalize()
 * expects.
 */
export function toRaw(job, home = null) {
  const from = job.annualSalaryFrom;
  const to = job.annualSalaryTo;
  return {
    source: id,
    sourceLabel: label,
    // The board's own record id — an identity, not an address. `jobUrl` is a
    // slug built from company and title, so an edited title would move it.
    sourceId: `germantechjobs:${job._id}`,
    title: text(job.name),
    company: text(job.company),
    // `actualCity`, NOT `cityCategory`. The category is the board's nearest
    // filter bucket: a Vienna employer is filed under "Munich", 355km away.
    location: text(job.actualCity),
    // The board's coordinates, as a fallback for a town the gazetteer has never
    // heard of. normalize() still prefers its own measurement.
    distanceKm: distanceFrom(job, home),
    workMode: WORKPLACE[job.workplace],
    descriptionText: advertOf(job),
    descriptionHtml: '',
    applyUrl: pageUrl(job.jobUrl),
    postedAt: job.activeFrom || job.createdAt || null,
    salary: from && to ? `${from}–${to} EUR` : null,
    employmentType: job.jobType || null,
    // The board says so itself, on the page it is still serving. Only the
    // detail record carries the flag; the list never includes a dead posting.
    closed: job.isDisabledOrOutdated === true,
    closedEvidence: job.isDisabledOrOutdated === true ? 'germantechjobs: isDisabledOrOutdated' : null,
  };
}

export async function fetchJobs({ titleFilter = null, profile = null } = {}) {
  const errors = [];
  const jobs = [];
  const home = profile?.location || null;

  let list;
  try {
    const res = await get(LIST, 'application/json');
    if (!res.ok) return { jobs, errors: [`job list — HTTP ${res.status}`], calls: null };
    list = JSON.parse(res.text);
  } catch (e) {
    return { jobs, errors: [`job list — ${e.message}`], calls: null };
  }
  if (!Array.isArray(list) || !list.length) {
    return { jobs, errors: ['job list parsed but held no postings — the API may have changed'], calls: null };
  }

  const wanted = list.filter((j) => j && j._id && j.jobUrl && j.name && !j.isPaused
    && (!titleFilter || titleFilter(j.name)));

  const need = wanted.slice(0, MAX_DETAIL);
  if (wanted.length > need.length) {
    errors.push(`${wanted.length - need.length} over the ${MAX_DETAIL}-detail ceiling — not judged this run`);
  }

  for (const light of need) {
    let detail = null;
    try {
      const res = await get(DETAIL(light.jobUrl), 'application/json');
      // A 404 here is keyed by the posting's own slug, so it means the posting
      // went between the list and this request. Not emitted: it was never read,
      // and the next run's list will not carry it.
      if (!res.ok) { errors.push(`${light.jobUrl} — HTTP ${res.status}`); continue; }
      detail = JSON.parse(res.text);
    } catch (e) {
      // A transient failure. Emitted from the list alone, with no advert, so it
      // PARKS rather than being judged on its title.
      errors.push(`${light.jobUrl} — ${e.message}`);
    }
    jobs.push(toRaw({ ...light, ...(detail && typeof detail === 'object' ? detail : {}) }, home));
  }

  // Same guard as careersites.js: a renamed field returns empty adverts while
  // every other field looks perfect, and the run reports success.
  const blank = jobs.filter((j) => !j.descriptionText).length;
  if (jobs.length >= 4 && blank > jobs.length / 2) {
    errors.push(`${blank} of ${jobs.length} adverts came back empty — the page markup has probably changed`);
  }

  // Unmetered — `calls: null` so the quota ledger never bills it.
  return { jobs, errors, calls: null };
}

export const __testables = { advertOf, toRaw, LIST, DETAIL, pageUrl };
