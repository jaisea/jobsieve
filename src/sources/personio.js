import { stripHtml } from '../util.js';
import { politeWait } from '../enrich.js';

/**
 * PERSONIO — the German mid-market ATS.
 *
 * Three companies on the watchlist were blocked on this: Jedox, Solvares and
 * Basilea. They were recorded
 * `supported: false` with a note that a public XML feed exists, and nothing
 * read it.
 *
 * career-ops' discovery guide says of Personio: *"No stable public JSON API —
 * treat as Level 2/3 (render or search)"*. That is wrong, and it is the FOURTH
 * time in this project that "this page needs a browser" has been false — after
 * the LinkedIn guest card, the eFinancialCareers container and the
 * SuccessFactors sitemap. There is no JSON API; there is a perfectly good XML
 * one.
 *
 *     GET https://{slug}.jobs.personio.{de|com}/xml   ->  200, text/xml
 */
export const id = 'personio';
export const label = 'Personio boards';

const UA = 'Mozilla/5.0 (compatible; jobsieve/1.0; +https://github.com/jaisea/jobsieve)';

const feedUrl = (slug, tld = 'de') => `https://${slug}.jobs.personio.${tld}/xml`;

/**
 * The apply URL is CONSTRUCTED, because the feed does not carry one.
 *
 * There is no `<url>`, `<link>` or `<permalink>` anywhere in the document —
 * checked against every tag it emits. The id plus the tenant host is the whole
 * address, and it was verified to resolve: `/job/2700696` answers 200 and
 * carries ld+json.
 *
 * That last part is what makes this source cheap. Only 3 of Jedox's 18
 * postings fill `<jobDescriptions>`, so most arrive with no advert — but the
 * job page has a JobPosting ld+json with the full text (4,179 characters on
 * the one measured), which is exactly what `enrich.js` already reads. The feed
 * supplies the listing; the existing enrich step supplies the advert. No new
 * reader.
 */
const jobUrl = (slug, tld, jobId) => `https://${slug}.jobs.personio.${tld || 'de'}/job/${jobId}`;

/**
 * Everything between one pair of tags, CDATA unwrapped and entities decoded.
 *
 * **The decode is not cosmetic.** XML escapes `&` as `&amp;`, so a real
 * posting came through as *"Product Manager – Platform Experience &amp;
 * Cloud"* and a department as *"Technology, Innovation &amp; Cloud
 * Excellence"*. The title feeds the FINGERPRINT, so an undecoded entity gives
 * the posting a false identity that never merges with the same role from
 * another source.
 *
 * Third time this exact bug has appeared here — LinkedIn's `&middot;`, then
 * careersites' `og:title`, now this — and every time the fix was to route the
 * field through `stripHtml`, which is why it is the one decoder.
 */
function tag(xml, name) {
  const m = xml.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`));
  if (!m) return '';
  return stripHtml(m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')).trim();
}

const allTags = (xml, name) =>
  [...xml.matchAll(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, 'g'))]
    .map((m) => stripHtml(m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')).trim())
    .filter(Boolean);

/**
 * The description, when the employer filled it in.
 *
 * `<jobDescriptions>` holds repeated `<jobDescription><name>…</name>
 * <value><![CDATA[html]]></value></jobDescription>` blocks — "Was ist Jedox?",
 * "Deine Aufgaben", and so on. The heading is kept with its section because a
 * German advert puts the language requirement under a heading and the gate
 * reads whole lines.
 */
function descriptionOf(position) {
  const block = (position.match(/<jobDescriptions>([\s\S]*?)<\/jobDescriptions>/) || [, ''])[1];
  if (!block.trim()) return '';
  const parts = [...block.matchAll(/<jobDescription>([\s\S]*?)<\/jobDescription>/g)].map((m) => {
    const name = tag(m[1], 'name');
    const value = stripHtml(tag(m[1], 'value'));
    return [name, value].filter(Boolean).join('\n');
  });
  return parts.join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Where the work is, with every office joined.
 *
 * Same reasoning as the Getro source, and the same measurement behind it: the
 * tail of the list is what anchors a posting. Jedox's first record reads
 * `office: "Germany remote"` with two German cities as
 * additional offices — drop the extras and a genuinely local role loses the
 * only mention of the candidate's own city.
 */
function locationOf(position) {
  const main = tag(position, 'office');
  const extraBlock = (position.match(/<additionalOffices>([\s\S]*?)<\/additionalOffices>/) || [, ''])[1];
  return [main, ...allTags(extraBlock, 'office')].filter(Boolean).join(', ');
}

/**
 * Personio splits the employment question across two fields and only one of
 * them is the one the gate cares about. `employmentType` is permanent vs
 * intern; `schedule` is full-time vs part-time, which is what
 * `employmentKinds()` reads to catch a Teilzeit posting. Both are passed, so
 * neither axis is lost.
 */
const employmentOf = (position) =>
  [tag(position, 'employmentType'), tag(position, 'schedule')].filter(Boolean).join(' ') || null;

function salaryOf(position) {
  const block = (position.match(/<salaryInformation>([\s\S]*?)<\/salaryInformation>/) || [, ''])[1];
  if (!block) return null;
  const min = tag(block, 'min');
  const max = tag(block, 'max');
  const cur = tag(block, 'currencySymbol') || tag(block, 'currencyCode');
  if (!min && !max) return null;
  return [[min, max].filter(Boolean).join('–'), cur].filter(Boolean).join(' ');
}

export function parseFeed(xml, { slug, tld, name }) {
  const out = [];
  for (const position of String(xml).split('<position>').slice(1).map((s) => s.split('</position>')[0])) {
    const jobId = tag(position, 'id');
    const title = tag(position, 'name');
    if (!jobId || !title) continue;

    const text = descriptionOf(position);
    out.push({
      source: id,
      sourceLabel: `${label} — ${name || slug}`,
      sourceId: `personio:${slug}:${jobId}`,
      title,
      // `subcompany` is the legal entity actually hiring, which on a group
      // feed is more precise than the tenant name.
      company: tag(position, 'subcompany') || name || slug,
      location: locationOf(position),
      applyUrl: jobUrl(slug, tld, jobId),
      postedAt: tag(position, 'createdAt') || null,
      employmentType: employmentOf(position),
      salary: salaryOf(position),
      descriptionText: text,
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
    const { slug, tld = 'de', name } = board;
    if (!slug) { errors.push(`${name || 'a Personio board'}: no slug configured`); continue; }

    const url = feedUrl(slug, tld);
    await politeWait(url);
    let res;
    try {
      res = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/xml,text/xml' } });
    } catch (e) {
      errors.push(`${name || slug}: ${e.message}`);
      continue;
    }
    if (!res.ok) {
      // The tenant may be on .com rather than .de, and that is a per-company
      // fact rather than something to guess at runtime — say which to fix.
      errors.push(`${name || slug}: HTTP ${res.status} from ${url}${tld === 'de' ? ' — try "tld": "com"' : ''}`);
      continue;
    }

    const jobs = parseFeed(await res.text(), { slug, tld, name });
    if (!jobs.length) errors.push(`${name || slug}: the feed parsed to no positions — the shape may have changed`);
    out.push(...jobs);
  }

  // Unmetered, like every other board source.
  return { jobs: out, errors, calls: null };
}

export const __testables = { feedUrl, jobUrl, tag, descriptionOf, locationOf, employmentOf, salaryOf };
