/**
 * Recruiting agencies — a KIND of source, not one website.
 *
 * An agency posts on behalf of a client it does not name. apriori is the first
 * one here and the reason the kind exists, but nothing below is about apriori
 * specifically: the shape of the problem repeats at every Personalvermittlung,
 * so the per-site details live in AGENCIES the way mail templates live in
 * PARSERS, and a second agency is a new entry rather than new machinery.
 *
 * What makes an agency different from every other source in this project:
 *
 *   1. THE EMPLOYER IS UNKNOWN. Every apriori posting reports
 *      `hiringOrganization: "APRIORI – BUSINESS SOLUTIONS AG"` — 38 of 38
 *      sampled — and names the client only as "Unser Kunde ist ein
 *      inhabergeführtes Familienunternehmen". So `employerUnknown` is set, and
 *      normalize() keys the fingerprint on the agency's own posting id instead
 *      of the company. Without that, `sha1(company|title|locationKey)` has a
 *      CONSTANT company and two different clients hiring a "DevOps Engineer
 *      (m/w/d)" in Frankfurt collapse into one posting.
 *
 *   2. ITS OWN METADATA CONTRADICTS ITSELF. apriori's ld+json says
 *      `employmentType: "contract"` on 37 of 38 postings including ones its own
 *      search card labels "Permanent". The card is right and the ld+json is a
 *      template default, so the card wins. This is the same rule as everywhere
 *      else here — prefer the field the site actually maintains — arriving from
 *      a new direction.
 *
 *   3. THE SEARCH READS THE DESCRIPTION. `?text=terraform` returns "Senior
 *      DevOps Engineer", "Cloud Engineer – Hybrid & Multi-Cloud" and "Microsoft
 *      Cloud Engineer" — none of which has "terraform" in the title. Same
 *      property that made the Arbeitsagentur two-pass design work, and the
 *      reason this is queried by keyword rather than crawled: the sitemap
 *      carries 4,337 postings and a sample of 38 recent ones had 2 in scope.
 *      The catalogue is mostly SAP consulting.
 *
 * Politeness: these are ordinary web pages, not an API. robots.txt permits it
 * (only /wp/wp-admin/ and the wpforms uploads are disallowed) and every request
 * goes through the same per-host gap as the rest of the project.
 */
import { stripHtml, readJson, writeJson, p } from '../util.js';
import { politeWait } from '../enrich.js';
import { existsSync } from 'node:fs';

export const id = 'agencies';
export const label = 'Recruiting agencies';

const UA = 'Mozilla/5.0 (compatible; jobsieve/1.0; +https://github.com/jaisea/jobsieve)';

/** Pages to walk per keyword before giving up. 13 results a page. */
const MAX_PAGES = 6;
/**
 * Detail fetches per run, across every agency. A ceiling, not a target — at the
 * shared per-host gap this is under a minute, and a real run needs about half
 * of it once the title gate has had its say.
 */
const MAX_DETAIL = 120;

const AGENCIES = [
  {
    id: 'apriori',
    name: 'APRIORI – BUSINESS SOLUTIONS AG',
    /**
     * How the employer reads on the card and in the archive. Naming the agency
     * is the honest answer — the client genuinely is not in the page, and
     * guessing one from "Unser Kunde ist …" would be inventing a fact about a
     * posting, which this project does not do anywhere else either.
     */
    display: 'APRIORI (Personalvermittlung)',
    home: 'https://www.apriori.de',
    search: (kw, page) =>
      `https://www.apriori.de/job-finden/?text=${encodeURIComponent(kw)}&location=&paged=${page}`,

    /**
     * One card, from the live page:
     *
     *   <a href="https://www.apriori.de/job-finden/job/255448/" class="item …"
     *      data-industry="IT"><span class="item-content">
     *      <h3> DevOps Engineer (m/w/d) </h3>
     *      <p> IT <span class="dot">·</span> Permanent </p>
     *
     * The contract type in that <p> is the field to trust — see (2) above.
     */
    cards: (html) => {
      const out = [];
      const re = /<a\s+href="(https:\/\/www\.apriori\.de\/job-finden\/job\/(\d+)\/?)"[^>]*>([\s\S]*?)<\/a>/gi;
      for (const m of html.matchAll(re)) {
        const inner = m[3];
        const title = stripHtml((inner.match(/<h3[^>]*>([\s\S]*?)<\/h3>/i) || [])[1] || '')
          .replace(/\s+/g, ' ').trim();
        if (!title) continue;
        const meta = stripHtml((inner.match(/<p[^>]*>([\s\S]*?)<\/p>/i) || [])[1] || '')
          .replace(/\s+/g, ' ').trim();
        // "IT · Permanent" — industry first, contract type last.
        const contract = meta.split('·').map((x) => x.trim()).filter(Boolean).pop() || '';
        out.push({ url: m[1], postingId: m[2], title, contract });
      }
      return out;
    },
  },
];

/**
 * Arbeitnehmerüberlassung is a real German employment type and reads as
 * neither of the two words `employmentKinds` looks for. Mapped here rather than
 * passed through, so the gate sees a concept it already knows.
 */
function employmentFrom(cardContract) {
  const c = String(cardContract || '').toLowerCase();
  if (/arbeitnehmer(ü|ue)berlassung/.test(c)) return 'Arbeitnehmerüberlassung (Zeitarbeit)';
  if (/contracting|freelance/.test(c)) return 'Contract';
  if (/permanent|festanstellung/.test(c)) return 'Permanent';
  return cardContract || null;
}

async function getText(url) {
  // The SHARED per-host queue, not a bare fetch. This file used to claim it
  // went "through the same per-host gap as the rest of the project" while
  // calling fetch() directly with no gap at all — 36 list requests and up to
  // 120 detail requests at one host, as fast as the network allows.
  //
  // Shared matters as much as present: the queue is keyed by host across the
  // whole run, so this source and the advert step cannot each keep their own
  // idea of the gap for the same site.
  await politeWait(url);
  const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'text/html' } });
  if (!res.ok) return { ok: false, status: res.status };
  return { ok: true, text: await res.text() };
}

/** The JobPosting block, or null. Agencies are WordPress sites; some pages have none. */
function jobPosting(html) {
  const blocks = [...html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  for (const b of blocks) {
    try {
      const parsed = JSON.parse(b[1].trim());
      const found = (Array.isArray(parsed) ? parsed : [parsed])
        .find((x) => x && x['@type'] === 'JobPosting');
      if (found) return found;
    } catch { /* a broken block is not a reason to lose the page */ }
  }
  return null;
}

function enabledAgencies() {
  const file = p('config', 'agencies.json');
  const cfg = existsSync(file) ? readJson(file, {}) : {};
  return AGENCIES
    .filter((a) => cfg[a.id]?.enabled !== false)
    .map((a) => ({ ...a, cfg: cfg[a.id] || {} }));
}

/**
 * The agency's detail pages, remembered between scans (see the block in fetchJobs).
 *
 * Keyed by the posting id, with the location, the text and the date the page carried. Kept for
 * the same time as every other advert (enrich.js: 7 days) and for the same reason: an advert is
 * a living document, and one that gains "Deutsch C1" later the same day must not be judged on
 * last week's text for ever. A page that could not be read is NOT remembered — it is asked for
 * again next scan, as before.
 */
export const DETAIL_MAX_AGE_DAYS = 7;
const DETAILS = () => p('data', 'agency-details.json');

function loadDetails() {
  const d = existsSync(DETAILS()) ? readJson(DETAILS(), null) : null;
  return d && typeof d === 'object' && d.entries ? d : { version: 1, entries: {} };
}

/** Written once per run, atomically, and only when something changed. Old entries go with it. */
function saveDetails(details, { changed, stale }) {
  let pruned = false;
  for (const [key, e] of Object.entries(details.entries)) {
    if (new Date(e.at).getTime() <= stale) { delete details.entries[key]; pruned = true; }
  }
  if (changed || pruned) writeJson(DETAILS(), { ...details, savedAt: new Date().toISOString() });
}

/** What a detail page contributes to a posting. */
function applyDetail(job, d) {
  job.location = d.location || '';
  job.descriptionHtml = d.descriptionHtml || '';
  job.descriptionText = d.descriptionText || '';
  job.postedAt = d.postedAt || null;
}

/**
 * `get` and `persist` exist for tests and for a dry run: a dry run promises to write nothing, and
 * the detail cache is a file.
 */
export async function fetchJobs({ queries = [], titleFilter = null, get = getText, persist = true } = {}) {
  const errors = [];
  const notes = [];
  const jobs = [];
  const agencies = enabledAgencies();
  if (!agencies.length) return { jobs, errors, skipped: true };

  const detailQueue = [];

  for (const agency of agencies) {
    const keywords = agency.cfg.queries?.length ? agency.cfg.queries : queries;
    if (!keywords.length) continue;

    const seen = new Set();

    for (const kw of keywords) {
      for (let page = 1; page <= MAX_PAGES; page++) {
        let res;
        try {
          res = await get(agency.search(kw, page));
        } catch (e) {
          errors.push(`${agency.id}: ${kw} p${page} — ${e.message}`);
          break;
        }
        if (!res.ok) {
          errors.push(`${agency.id}: ${kw} p${page} — HTTP ${res.status}`);
          break;
        }

        const cards = agency.cards(res.text);
        if (!cards.length) break;

        // The paginator repeats the last page rather than 404ing, so "no card
        // we have not already filed" is the only reliable end of the list.
        const fresh = cards.filter((c) => !seen.has(c.postingId));
        if (!fresh.length) break;

        for (const c of fresh) {
          seen.add(c.postingId);
          jobs.push({
            source: id,
            sourceLabel: `${agency.cfg.label || agency.display} agency`,
            sourceId: `${agency.id}:${c.postingId}`,
            title: c.title,
            company: agency.display,
            // The load-bearing flag. normalize() reads it and keys the
            // fingerprint on sourceId, because `company` is the same string on
            // every posting this source will ever return.
            employerUnknown: true,
            agency: agency.name,
            location: '',
            employmentType: employmentFrom(c.contract),
            descriptionText: '',
            descriptionHtml: '',
            applyUrl: c.url,
            postedAt: null,
            _detailUrl: c.url,
          });
          detailQueue.push(jobs[jobs.length - 1]);
        }
      }
    }
  }

  // The listing carries no location and no description, and both are needed
  // before the rules can say anything. Fetch them only for what survives the
  // title gate — the same bargain ats.js strikes, for the same reason: the
  // catalogue is mostly roles this search is not about.
  const wanted = detailQueue.filter((j) => !titleFilter || titleFilter(j.title));

  // A DETAIL PAGE IS READ ONCE A WEEK, NOT EVERY SCAN. This source took 6m27s of a 14m37s scan
  // to return 178 postings: the site answers in about two seconds, the per-host gap is on top
  // of that, and every scan re-read up to 120 detail pages whose text had not changed. The page
  // is the advert, so it follows the same rule as every other advert (descriptions.json): kept
  // for DETAIL_MAX_AGE_DAYS, then read again, because an advert is a living document.
  const details = loadDetails();
  const stale = Date.now() - DETAIL_MAX_AGE_DAYS * 86400000;
  let changed = false;
  let fromCache = 0;

  // The ceiling counts REQUESTS, not postings: a cached posting costs nothing, so it must not
  // use up the allowance of one that has to be fetched.
  let requested = 0;
  const starved = new Set();

  for (const j of wanted) {
    const hit = details.entries[j.sourceId];
    if (hit && new Date(hit.at).getTime() > stale) {
      applyDetail(j, hit);
      fromCache++;
      continue;
    }

    // A posting that passed the title gate and then hit the ceiling was never
    // ASKED about, and emitting it with no location and no description would get
    // it parked — which this project defines as "we asked and it did not
    // arrive". That is the --no-enrich mistake in a new place. Drop it from
    // this run instead and say so; the next run picks it up.
    if (requested >= MAX_DETAIL) { starved.add(j); continue; }
    requested++;

    let res;
    try {
      res = await get(j._detailUrl);
    } catch (e) {
      errors.push(`detail ${j.sourceId}: ${e.message}`);
      continue;
    }
    if (!res.ok) { errors.push(`detail ${j.sourceId}: HTTP ${res.status}`); continue; }

    const jp = jobPosting(res.text);
    if (!jp) continue;

    const addr = jp.jobLocation?.address || {};
    const entry = {
      at: new Date().toISOString(),
      location: [addr.addressLocality, addr.addressRegion].filter(Boolean).join(', '),
      descriptionHtml: jp.description || '',
      descriptionText: stripHtml(jp.description || ''),
      postedAt: jp.datePosted || null,
    };
    applyDetail(j, entry);
    // NOT jp.employmentType. It reads "contract" on postings this site's own
    // card labels Permanent, on 37 of 38 sampled — a template default, kept
    // out deliberately so nobody reinstates it as an obvious improvement.
    details.entries[j.sourceId] = { ...entry, descriptionHtml: '' };   // the text is what is read; the markup is not kept
    changed = true;
  }

  if (starved.size) {
    errors.push(`${starved.size} posting(s) over the ${MAX_DETAIL}-detail ceiling — not judged this run`);
  }
  if (fromCache) notes.push(`${fromCache} detail page${fromCache === 1 ? '' : 's'} from the cache, ${requested} fetched`);
  if (persist) saveDetails(details, { changed, stale });

  const out = jobs.filter((j) => !starved.has(j));
  for (const j of out) delete j._detailUrl;
  return { jobs: out, errors, notes, calls: null };
}

export const __testables = { AGENCIES, employmentFrom, jobPosting, loadDetails, DETAIL_MAX_AGE_DAYS };
