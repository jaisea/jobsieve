import { stripHtml } from '../util.js';
import { politeWait } from '../enrich.js';

/**
 * BWI GmbH — the Bundeswehr's IT service provider, ~290 open postings at any
 * time, many of them exactly this search (CI/CD Platform Engineer, DevSecOps
 * Architect, Senior DevOps Engineer Bundesmessenger, Cloud Operation).
 *
 * WHAT IS READ, AND WHY IT IS ALLOWED. bwi.de is TYPO3 and publishes:
 *   - /sitemap.xml, an index whose `jobs` child lists every posting URL, and
 *   - one JobPosting ld+json block on each posting's own page.
 * robots.txt allows both explicitly (`Allow: /sitemap.xml?sitemap=*&cHash=*`) and
 * disallows only `/*cHash`, i.e. the TYPO3 cache-hash variants of a page. The
 * posting URLs read here carry no query string, so none of them is a cHash URL —
 * a link pasted from the browser (`…?tx_bwi_jobshow[external]=0&cHash=…`) is the
 * disallowed form of the same page and is never requested. Checked 2026-10-16.
 *
 * The listing page (/karriere/stellenangebote) was looked at and rejected: it is
 * 430 KB of ItemList URLs with no titles, so the sitemap says the same for a
 * fraction of the weight.
 *
 * THE TITLE GATE RUNS ON THE URL SLUG, before anything is fetched — the same
 * trick as careersites.js. `senior-devops-engineer-service-architekt-
 * bundesmessenger-m-w-d-70815` is the title plus a gender suffix and the posting
 * id, so ~290 postings cost one request and only the ones whose title passes cost
 * a second. The real title comes from the ld+json.
 *
 * THE ADVERT ARRIVES READ. ld+json carries the whole description, so these
 * postings never reach the enrich step — and a BWI advert that demands security
 * clearance or German is judged on that text rather than parked.
 *
 * The employer is real and fixed ("BWI GmbH"), so the ordinary
 * company|title|location fingerprint applies. Postings list several offices
 * (Berlin, Bonn, Leipzig, München, …); they are all kept, joined, because a
 * multi-site role must keep the mention that anchors it near home.
 */
export const id = 'bwi';
export const label = 'BWI GmbH';

const UA = 'Mozilla/5.0 (compatible; jobsieve/1.0; +https://github.com/jaisea/jobsieve)';
const BASE = 'https://www.bwi.de';
const INDEX_URL = `${BASE}/sitemap.xml`;

/** A runaway guard: the board holds ~290 postings; the title gate leaves a few dozen. */
const MAX_DETAIL = 120;

/** `/karriere/stellenangebote/job/<slug>-<id>` — the id is the trailing number. */
const JOB_URL = /\/karriere\/stellenangebote\/job\/([a-z0-9-]+?)-(\d+)\/?$/i;

async function getText(url, { follow = true } = {}) {
  await politeWait(url);
  const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'text/html,application/xml' }, redirect: follow ? 'follow' : 'manual' });
  // A redirect read as a redirect, not followed to the page it lands on.
  if (!follow && res.status >= 300 && res.status < 400) return { ok: false, status: res.status, redirected: true };
  if (!res.ok) return { ok: false, status: res.status };
  return { ok: true, text: await res.text() };
}

const locs = (xml) => [...String(xml).matchAll(/<loc>([^<]+)<\/loc>/g)]
  .map((m) => m[1].replace(/&amp;/g, '&'));

/**
 * The jobs sitemap's address, read from the index. It carries a `cHash` that
 * changes, so it is never hardcoded — and robots.txt allows exactly this form.
 */
export function jobsSitemapUrl(indexXml) {
  return locs(indexXml).find((u) => /[?&]sitemap=jobs(&|$)/.test(u)) || null;
}

/** Posting URLs from the jobs sitemap, each with the readable slug and its id. */
export function parseSitemap(xml) {
  const out = [];
  for (const url of locs(xml)) {
    const m = url.match(JOB_URL);
    if (!m) continue;
    out.push({
      url,
      postingId: m[2],
      // "senior ci cd platform engineer architect" — the gender suffix is noise to
      // every gate and would only be a word for relevance to trip over.
      slug: m[1].replace(/-m-w-d$|-w-m-d$|-m-f-d$|-d-f-m$/i, '').replace(/-/g, ' '),
    });
  }
  return out;
}

/** The page's JobPosting node, or null. Tolerates a bare object, an array or an @graph. */
function jobPostingOf(html) {
  const blocks = String(html).matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi);
  for (const [, body] of blocks) {
    let data;
    try { data = JSON.parse(body.trim()); } catch { continue; }
    const node = [].concat(data?.['@graph'] || data).find((n) => n && n['@type'] === 'JobPosting');
    if (node) return node;
  }
  return null;
}

/** Every office, de-duplicated, with the country appended: "Berlin, Germany · Bonn, Germany". */
export function locationOf(posting) {
  const places = [].concat(posting?.jobLocation || []).map((l) => {
    const a = l?.address || {};
    const country = a.addressCountry === 'DE' ? 'Germany' : a.addressCountry;
    return [a.addressLocality, country].filter(Boolean).join(', ');
  }).filter(Boolean);
  return [...new Set(places)].join(' · ');
}

const text = (html) => {
  let t = stripHtml(String(html || '')).trim();
  // Some TYPO3 exports escape the markup inside the string; see extractDescription().
  if (/<\/?[a-z][a-z0-9]*(\s[^>]*)?>/i.test(t)) t = stripHtml(t).trim();
  return t.replace(/[ \t]+\n/g, '\n').trim();
};

/**
 * The advert proper. The ld+json `description` is only the two-sentence
 * "Als primärer Digitalisierungspartner der Bundeswehr …" intro — 199 characters
 * on every posting read — while Aufgaben, Profil and Wir bieten (where German,
 * clearance and the stack are stated) sit in the page body between
 * `jobDetailContent` and the `jobBottomNavi` footer. Taking the ld+json alone
 * would hand every gate an advert that says nothing, and "says nothing" reads as
 * "no German requirement" and "no tools named".
 *
 * The contact block (a recruiter's name) is cut: it is not part of the advert.
 */
export function advertOf(html) {
  const s = String(html);
  const at = (re, from = 0) => { const i = s.slice(from).search(re); return i === -1 ? -1 : i + from; };
  const start = at(/<div[^>]*class="[^"]*\bjobDetailContent\b/i);
  if (start === -1) return '';
  const footer = at(/<div[^>]*class="[^"]*\bjobBottomNavi\b/i, start);
  const stop = footer === -1 ? Math.min(s.length, start + 60000) : footer;

  // Order on the page: intro, contact block, then the jobRow with Aufgaben, Profil
  // and Wir bieten. The contact is skipped by taking the intro up to it and
  // resuming at the first jobRow; nested divs make cutting the block OUT fragile.
  const contact = at(/<div[^>]*class="[^"]*\bjobDetailContact\b/i, start);
  const rows = at(/<div[^>]*class="[^"]*\bjobRow\b/i, start);
  if (contact === -1 || rows === -1 || rows < contact) return text(s.slice(start, stop));
  return text(`${s.slice(start, contact)}\n${s.slice(rows, stop)}`);
}

export function parsePosting(html, { url, postingId } = {}) {
  const p = jobPostingOf(html);
  const title = text(p?.title);
  if (!title) return null;

  const type = [].concat(p.employmentType || [])[0];
  const posted = new Date(p.datePosted);
  const until = new Date(p.validThrough);
  return {
    source: id,
    sourceLabel: label,
    // An id, not the URL, like every other source here: the URL is an address and
    // the same posting is also reachable through its cHash variant.
    sourceId: `bwi:${postingId || p.identifier?.value}`,
    title,
    company: text(p.hiringOrganization?.name) || 'BWI GmbH',
    location: locationOf(p),
    // The longer of the page body and the ld+json intro: a page whose markup
    // changed falls back to the intro instead of to nothing.
    descriptionText: [advertOf(html), text(p.description)].sort((a, b) => b.length - a.length)[0],
    descriptionHtml: '',
    applyUrl: url,
    postedAt: Number.isFinite(posted.getTime()) ? posted.toISOString() : null,
    validThrough: Number.isFinite(until.getTime()) ? until.toISOString() : null,
    employmentType: type ? String(type).replace(/_/g, ' ').toLowerCase() : null,
  };
}

export async function fetchJobs({ titleFilter = null, locationFilter = null } = {}) {
  const errors = [];
  const jobs = [];

  let index;
  try { index = await getText(INDEX_URL); } catch (e) { return { jobs, errors: [`sitemap index — ${e.message}`], calls: null }; }
  if (!index.ok) return { jobs, errors: [`sitemap index — HTTP ${index.status}`], calls: null };

  const jobsUrl = jobsSitemapUrl(index.text);
  if (!jobsUrl) return { jobs, errors: ['the sitemap index lists no `jobs` sitemap — the site may have changed'], calls: null };

  let sm;
  try { sm = await getText(jobsUrl); } catch (e) { return { jobs, errors: [`jobs sitemap — ${e.message}`], calls: null }; }
  if (!sm.ok) return { jobs, errors: [`jobs sitemap — HTTP ${sm.status}`], calls: null };

  const listed = parseSitemap(sm.text);
  if (!listed.length) return { jobs, errors: ['the jobs sitemap parsed but held no posting URLs — the path shape may have changed'], calls: null };

  // The slug holds no location, so only the title gate can run before the fetch.
  // BWI is multi-site anyway: the decision belongs to the location gate, on the
  // full list of offices.
  const wanted = listed.filter((j) => !titleFilter || titleFilter(j.slug));
  let gone = 0;
  const need = wanted.slice(0, MAX_DETAIL);
  if (wanted.length > need.length) {
    errors.push(`${wanted.length - need.length} over the ${MAX_DETAIL}-detail ceiling — not judged this run`);
  }

  for (const j of need) {
    let page;
    try { page = await getText(j.url, { follow: false }); } catch (e) { errors.push(`${j.postingId} — ${e.message}`); continue; }
    // A posting that was withdrawn stays in the sitemap and answers 301/302 to the
    // listing — measured 2026-10-16: 7 of the first 8 postings that passed the
    // title gate. Following the redirect lands on a 200 listing page with no
    // JobPosting, which is how this first looked like a broken parser. It is the
    // site saying "closed", not a fault, so it is counted once and not warned per posting.
    if (page.redirected) { gone++; continue; }
    if (!page.ok) { errors.push(`${j.postingId} — HTTP ${page.status}`); continue; }

    const job = parsePosting(page.text, j);
    if (!job) { errors.push(`${j.postingId} — no JobPosting on the page (a withdrawn posting is served the listing page with a 200)`); continue; }
    // ANY office near enough keeps it: the offices are joined into one string and
    // a prefilter reading that whole string as one place would drop every
    // multi-site role — which is nearly all of them.
    if (locationFilter && job.location && !job.location.split(' · ').some((o) => locationFilter(o))) continue;
    jobs.push(job);
  }

  if (gone) errors.push(`${gone} posting(s) in the sitemap were withdrawn (redirected to the listing) — skipped`);

  // Empty adverts for most of a board mean the ld+json shape changed, and every
  // other field would still look perfect — say so rather than park everything.
  const blank = jobs.filter((j) => !j.descriptionText).length;
  if (jobs.length >= 4 && blank > jobs.length / 2) {
    errors.push(`${blank} of ${jobs.length} adverts came back empty — the page markup has probably changed`);
  }

  return { jobs, errors, calls: null };
}

export const __testables = { JOB_URL, jobPostingOf, advertOf, MAX_DETAIL };
