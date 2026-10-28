/**
 * Career sites that publish a sitemap and nothing else machine-readable.
 *
 * The first is SAP SuccessFactors Recruiting Marketing — the platform formerly
 * called Jobs2Web, which `mailalerts.js` already knows from the other end,
 * since its alert emails were the "Employer alert" parser. One deployment
 * serves a whole corporate group: `jobsearch.createyourowncareer.com` carries
 * **978 postings across 42 Bertelsmann brands** — Arvato Systems, Riverty, RTL,
 * smartclip and the rest — behind a single sitemap.
 *
 * WHY A SITEMAP AND NOT THE SEARCH API. The site's own search is a JavaScript
 * shell that calls `/services/`, and `/services/` is `Disallow:` in robots.txt.
 * The sitemap is not, so that is the route taken. Nothing here reads a
 * disallowed path.
 *
 * WHY THIS IS CHEAP DESPITE 978 POSTINGS. The sitemap URL encodes the city and
 * the title:
 *
 *     /smartclip/job/Berlin-DevOps-Engineer-%28wmd%29-Google-Cloud-Platform-10435/1414415033/
 *
 * so the title gate runs on the URL, for free, before a single job page is
 * fetched. 978 postings cost one request, and only the ~37 that survive cost a
 * second. Crawling all of them would be 978 requests for a corpus that is
 * mostly sales, law and internships.
 *
 * WHY IT PARSES HTML. These pages carry no JSON-LD at all, so `enrich.js`
 * cannot read them — it looks for a JobPosting block and there is none. They do
 * carry the same schema.org vocabulary as MICRODATA (`itemprop="streetAddress"`,
 * `itemprop="datePosted"`) plus an `og:title`, which is what is read here.
 * Checked across four brands and three countries; the shape held on every one.
 */
import { stripHtml } from '../util.js';
import { politeWait } from '../enrich.js';

export const id = 'careersites';
export const label = 'Corporate career sites';

const UA = 'Mozilla/5.0 (compatible; jobsieve/1.0; +https://github.com/jaisea/jobsieve)';

/** Job pages fetched per run. The title gate normally leaves far fewer. */
const MAX_DETAIL = 80;

const SITES = [
  {
    id: 'bertelsmann',
    label: 'Bertelsmann',
    sitemap: 'https://jobsearch.createyourowncareer.com/sitemap.xml',
    /**
     * `/<Brand>/job/<City-Title-Postcode>/<id>/`. The brand segment is the
     * employer and is the only place it appears — `og:site_name` is empty on
     * every page checked.
     */
    match: /^https:\/\/jobsearch\.createyourowncareer\.com\/([^/]+)\/job\/([^/]+)\/(\d+)\/?$/,
    /** `Arvato_Systems` is how the URL spells a company with a space in it. */
    brandName: (seg) => decodeURIComponent(seg).replace(/_/g, ' '),
  },

  /**
   * Four more deployments of the same platform, each ONE employer rather than a
   * group, so `company` is fixed and the optional first path segment is a
   * country or subsidiary, never the employer. Checked 2026-10-01 against the
   * live sitemaps: SICK 84 postings, Endress+Hauser 382, Bachem 100, Fraunhofer
   * 783 — all open, all with the same `/job/<City-Title-Postcode>/<id>/` shape.
   *
   * They are NOT identical to Bertelsmann underneath, which is why `parseLocation`
   * exists: Bachem splits the address into `addressLocality` and
   * `addressCountry`; Fraunhofer and Endress+Hauser write "City, CC, postcode"
   * into `streetAddress` (the opposite order to Bertelsmann); SICK carries no
   * location microdata at all and the city is only in the URL slug.
   *
   * Idorsia, Clariant and Vitra run the same platform and were left out on
   * purpose: 17, 121 and 16 postings, none of them IT roles at the time.
   */
  {
    id: 'endress',
    label: 'Endress+Hauser',
    sitemap: 'https://careers.endress.com/sitemap.xml',
    match: /^https:\/\/careers\.endress\.com\/(?:([^/]+)\/)?job\/([^/]+)\/(\d+)\/?$/,
    brandName: () => 'Endress+Hauser',
  },
  {
    id: 'sick',
    label: 'SICK',
    sitemap: 'https://jobs.sick.com/sitemap.xml',
    // No prefix = the German site; `/usa/job/…`, `/china/job/…` are the others.
    // Excluding them here saves a detail fetch each for a posting the location
    // gate would only discard.
    match: /^https:\/\/jobs\.sick\.com\/(?:(germany)\/)?job\/([^/]+)\/(\d+)\/?$/,
    brandName: () => 'SICK AG',
    slugLocation: true,
    country: 'Germany',
  },
  {
    id: 'bachem',
    label: 'Bachem',
    sitemap: 'https://careers.bachem.com/sitemap.xml',
    match: /^https:\/\/careers\.bachem\.com\/(?:([^/]+)\/)?job\/([^/]+)\/(\d+)\/?$/,
    brandName: () => 'Bachem AG',
  },
  {
    id: 'fraunhofer',
    label: 'Fraunhofer',
    sitemap: 'https://jobs.fraunhofer.de/sitemap.xml',
    match: /^https:\/\/jobs\.fraunhofer\.de\/(?:([^/]+)\/)?job\/([^/]+)\/(\d+)\/?$/,
    brandName: () => 'Fraunhofer-Gesellschaft',
  },

  /**
   * MEDICE, Iserlohn. Added 2026-10-20 for one posting worth having: a
   * (Senior) DevSecOps Engineer in its digital-health unit whose advert lists
   * "Remote Work" — the other 30 of 31 are pharma, marketing and apprenticeships.
   *
   * Like SICK it carries no location microdata, but the slug cannot stand in for
   * it: the DevSecOps URL is `/job/%28Senior%29-DevSecOps-Engineer-…/`, no city
   * at all, so `slugLocation` would file it in "(Senior)". The page states the
   * city under a "Stellenstandort:" label instead, which `locationLabel` reads.
   *
   * The company is the legal name because that is how Arbeitsagentur already
   * filed it in seen.json; the same string keeps the fingerprints together.
   * Job URLs answer 302 to a `/<id>-de_DE/` form, which fetch() follows.
   */
  {
    id: 'medice',
    label: 'MEDICE',
    sitemap: 'https://career.medice-health-family.com/sitemap.xml',
    match: /^https:\/\/career\.medice-health-family\.com\/(?:([^/]+)\/)?job\/([^/]+)\/(\d+)\/?$/,
    brandName: () => 'MEDICE Arzneimittel Pütter GmbH & Co. KG',
    locationLabel: 'Stellenstandort',
    country: 'Germany',
  },
];

async function getText(url) {
  // The shared per-host queue — see agencies.js. Up to 80 job pages come off one
  // host here, and a sitemap that lists 978 of them is an invitation to be rude.
  await politeWait(url);
  const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'text/html,application/xml' } });
  if (!res.ok) return { ok: false, status: res.status };
  return { ok: true, text: await res.text() };
}

const clean = (html) => stripHtml(String(html || '')).replace(/\s+/g, ' ').trim();

const ogTag = (html, prop) =>
  (html.match(new RegExp(`property=["']og:${prop}["'][^>]*content=["']([^"']*)["']`, 'i')) || [])[1] || '';

const itemprop = (html, prop) =>
  (html.match(new RegExp(`itemprop=["']${prop}["'][^>]*content=["']([^"']*)["']`, 'i')) || [])[1] || '';

/**
 * "10435, Berlin, Kastanienallee 97, Germany" — postcode, city, street, country,
 * and sometimes an extra street line ("…, Top 6, Austria"). The city is the
 * second field and the country the last, which holds across every sample; the
 * middle is a street address and is not wanted.
 */
export function splitAddress(addr) {
  const parts = String(addr || '').split(',').map((x) => x.trim()).filter(Boolean);
  if (parts.length < 2) return { city: parts[0] || '', country: '' };
  // "Waldkirch, DE, 79183" — Fraunhofer and Endress+Hauser put the city FIRST and
  // a two-letter country second. A postcode-first address never has a bare
  // two-letter code in second place, so the shape tells them apart.
  if (/^[A-Z]{2}$/.test(parts[1])) return { city: parts[0], country: countryName(parts[1]) };
  return { city: parts[1], country: parts.length > 2 ? parts[parts.length - 1] : '' };
}

/** ISO codes the location resolver will not know; the names it does. */
const COUNTRIES = {
  DE: 'Germany', CH: 'Switzerland', AT: 'Austria', FR: 'France', IT: 'Italy', NL: 'Netherlands',
  ES: 'Spain', GB: 'United Kingdom', US: 'United States', IN: 'India', CN: 'China', PL: 'Poland',
  CZ: 'Czech Republic', HU: 'Hungary', SE: 'Sweden', DK: 'Denmark', BE: 'Belgium', PT: 'Portugal',
};
const countryName = (code) => COUNTRIES[String(code).toUpperCase()] || String(code);

/**
 * Where the job is, from whichever of three layouts the page uses, falling back
 * to the city in the URL slug for a site that carries no location markup at all
 * (SICK). Returns '' when nothing is found — never a guess dressed up as a fact.
 */
export function parseLocation(html, site = {}, slug = '') {
  const locality = itemprop(html, 'addressLocality');
  if (locality) {
    const code = itemprop(html, 'addressCountry');
    return [locality, code && countryName(code)].filter(Boolean).join(', ');
  }
  const { city, country } = splitAddress(itemprop(html, 'streetAddress'));
  if (city) return [city, country].filter(Boolean).join(', ');
  if (site.locationLabel) {
    // `<span class="joblayouttoken-label">Stellenstandort: </span>` followed by
    // a span holding the city (MEDICE). The value is the NEXT span, not
    // anything after the label, or an empty field would take the next label's.
    const m = html.match(new RegExp(
      `joblayouttoken-label[^>]*>\\s*${site.locationLabel}:?\\s*</span>\\s*<span[^>]*>([^<]*)</span>`, 'i'));
    const value = m ? clean(m[1]) : '';
    if (value) return [value, site.country].filter(Boolean).join(', ');
  }
  if (site.slugLocation) {
    // "Waldkirch (bei Emmendingen) Duales Studium …" — the city is the first word,
    // optionally followed by a parenthesised area. A hyphenated town would be
    // cut short, which is why this is a per-site opt-in, not the default.
    const m = String(slug).match(/^([^\s()]+(?:\s\([^)]*\))?)/);
    if (m) return [m[1], site.country].filter(Boolean).join(', ');
  }
  return '';
}

/**
 * The advert lives in `<span class="jobdescription">`, nested inside the
 * `itemprop="description"` span.
 *
 * The container is a SPAN, not a div — which is what a first attempt assumed,
 * and it silently returned 0 characters for all 29 postings while every other
 * field looked perfect. A description that is empty rather than missing is the
 * worst shape this project has: the gates would read "no German requirement"
 * and "no tools named" as findings, from nothing.
 *
 * Cutting at the first `</span>` is safe because the advert's own markup is
 * headings, paragraphs and lists — there is no nested span inside it on any
 * page checked. The guard below is what makes that assumption fail loudly
 * instead of quietly.
 */
export function descriptionOf(html) {
  let start = html.search(/<span[^>]*class=["'][^"']*jobdescription/i);
  // SICK's pages have no `jobdescription` class; the advert is the first
  // `itemprop="description"` span (a second one holds the contact block).
  if (start === -1) start = html.search(/<span[^>]*itemprop=["']description["']/i);
  if (start === -1) return '';
  const rest = html.slice(html.indexOf('>', start) + 1);

  // BALANCED, not "up to the first </span>".
  //
  // Cutting at the first one worked on every page sampled — 12 brands, zero
  // nested spans — but "no page I looked at has one" is not a property of the
  // format, it is a property of my sample. These adverts are pasted out of a
  // rich-text editor, and one <span style="..."> around a bold phrase would
  // silently truncate the advert at that point. Silently is the problem: a
  // short description is not obviously wrong, it just quietly stops feeding the
  // gates, which is the same shape as the div-vs-span bug this replaced.
  const tag = /<(\/?)span\b/gi;
  let depth = 1;
  let end = -1;
  let firstClose = -1;
  for (let m = tag.exec(rest); m; m = tag.exec(rest)) {
    if (m[1] && firstClose === -1) firstClose = m.index;
    depth += m[1] ? -1 : 1;
    if (depth === 0) { end = m.index; break; }
  }

  // Unbalanced markup — an unclosed <span> — must not mean "take the rest of
  // the document". Falling through to a 60,000-character slice pulled the page
  // footer and navigation into the advert, which then reads as advert text to
  // every gate. Bounded by the first closing tag, and failing that by the page
  // furniture that always follows the block.
  if (end === -1) end = firstClose;
  if (end === -1) {
    const furniture = rest.search(/<(footer|script|nav)\b/i);
    end = furniture === -1 ? Math.min(rest.length, 60000) : furniture;
  }
  return clean(rest.slice(0, end));
}

export async function fetchJobs({ titleFilter = null, locationFilter = null, sites = null } = {}) {
  const errors = [];
  const jobs = [];

  for (const site of SITES.filter((s) => !sites || sites.includes(s.id))) {
    let res;
    try {
      res = await getText(site.sitemap);
    } catch (e) {
      errors.push(`${site.id}: sitemap — ${e.message}`);
      continue;
    }
    if (!res.ok) { errors.push(`${site.id}: sitemap — HTTP ${res.status}`); continue; }

    const locs = [...res.text.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
    const listed = [];
    for (const url of locs) {
      const m = url.match(site.match);
      if (!m) continue;
      listed.push({
        url,
        brand: site.brandName(m[1]),
        // The slug carries "<City>-<Title>-<postcode>". It is handed to the
        // title gate WHOLE rather than being split: the city can itself contain
        // a hyphen ("Baden-Baden") so there is no reliable split, and the real
        // title is read from og:title once the page is fetched anyway.
        slug: decodeURIComponent(m[2]).replace(/-/g, ' ').replace(/&amp;/g, '&'),
        postingId: m[3],
      });
    }

    if (!listed.length) {
      errors.push(`${site.id}: sitemap parsed but held no job URLs — the path shape may have changed`);
      continue;
    }

    // The slug begins with the city, so the location pre-filter can read it for
    // free. looksReachable is lenient by design — an unresolvable string passes —
    // which is why this is safe on a slug that also holds the title.
    const wanted = listed.filter((j) => (!titleFilter || titleFilter(j.slug))
      && (!locationFilter || locationFilter(j.slug)));
    const need = wanted.slice(0, MAX_DETAIL);
    if (wanted.length > need.length) {
      errors.push(`${site.id}: ${wanted.length - need.length} over the ${MAX_DETAIL}-detail ceiling — not judged this run`);
    }

    for (const j of need) {
      let page;
      try {
        page = await getText(j.url);
      } catch (e) {
        errors.push(`${site.id}: ${j.postingId} — ${e.message}`);
        continue;
      }
      if (!page.ok) { errors.push(`${site.id}: ${j.postingId} — HTTP ${page.status}`); continue; }

      const html = page.text;
      // Through clean() rather than used raw: og:title is an ATTRIBUTE, so its
      // ampersands are encoded and "IT Infrastructure &amp; Security Expert"
      // reached the report with the entity intact. Same class of bug as the
      // LinkedIn `&middot;`, and the title feeds the fingerprint.
      const title = clean(ogTag(html, 'title'))
        || clean((html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) || [])[1] || '');
      if (!title) continue;

      // "Wed Sep 09 02:00:00 UTC 2026" — not ISO, but Date parses it. Guarded
      // because an unparseable date must not become an Invalid Date on the card.
      const posted = new Date(itemprop(html, 'datePosted'));

      jobs.push({
        source: id,
        sourceLabel: `${j.brand} (${site.label})`,
        sourceId: `${site.id}:${j.postingId}`,
        title,
        // A real employer, unlike an agency posting — so the ordinary
        // company|title|location fingerprint applies and this merges with the
        // same role arriving from Adzuna or a job-alert email.
        company: j.brand,
        location: parseLocation(html, site, j.slug),
        descriptionText: descriptionOf(html),
        descriptionHtml: '',
        applyUrl: j.url,
        postedAt: Number.isFinite(posted.getTime()) ? posted.toISOString() : null,
      });
    }

    // A selector that stops matching returns an empty string for every posting,
    // and every other field still looks perfect — which is exactly what
    // happened here when the description container was assumed to be a div. An
    // empty advert is worse than a missing source: the postings are all parked,
    // silently, and the run reports nothing wrong. So say it out loud.
    const fetched = jobs.filter((j) => j.sourceId.startsWith(`${site.id}:`));
    const blank = fetched.filter((j) => !j.descriptionText).length;
    if (fetched.length >= 4 && blank > fetched.length / 2) {
      errors.push(`${site.id}: ${blank} of ${fetched.length} adverts came back empty — the page markup has probably changed`);
    }
  }

  return { jobs, errors, calls: null };
}

/** Ids of the sitemap deployments read, for the watchlist's coverage check. */
export const SITE_IDS = SITES.map((s) => s.id);

export const __testables = { SITES, splitAddress, descriptionOf, ogTag, itemprop, parseLocation };
