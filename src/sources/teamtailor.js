import { stripHtml } from '../util.js';
import { politeWait } from '../enrich.js';

/**
 * TEAMTAILOR — RSS, not JSON, which is why it is a module and not a row.
 *
 * It was nearly added to the `ATS` table in ats.js alongside BambooHR and
 * Breezy. That would have been wrong in a way worth recording: every entry in
 * that table is fetched through `httpJson()`, so an RSS url there parses as
 * JSON, fails, and reports the same "unexpected shape" a dead board does. A
 * platform that publishes XML needs its own reader, the way Personio does.
 *
 *     GET https://{slug}.teamtailor.com/jobs.rss
 *
 * Unlike the other two speculative providers, this one is VERIFIED — built
 * against Teamtailor's own careers board, which runs on Teamtailor:
 * `career.teamtailor.com/jobs.rss` answers 200 with 17 items.
 *
 * The feed is unusually complete. It carries the whole advert in
 * `<description>`, so these postings arrive READ and never reach the enrich
 * step or the unread soft-drops — better than Personio, where 3 of 18 fill
 * their description field.
 */
export const id = 'teamtailor';
export const label = 'Teamtailor boards';

const UA = 'Mozilla/5.0 (compatible; jobsieve/1.0; +https://github.com/jaisea/jobsieve)';

const feedUrl = (slug) => `https://${slug}.teamtailor.com/jobs.rss`;

/**
 * One tag's contents, CDATA unwrapped and entities decoded.
 *
 * The decode is load-bearing rather than cosmetic, for the reason Personio
 * records: the title feeds the FINGERPRINT, so `&amp;` surviving into it
 * gives the posting an identity that can never merge with the same role from
 * another source. Fourth time this class has appeared here.
 */
function tag(xml, name) {
  const m = xml.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`));
  if (!m) return '';
  return stripHtml(m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')).trim();
}

/**
 * Where the work is, every listed office joined.
 *
 * `<tt:locations>` holds repeated `<tt:location>` blocks, each with its own
 * city and country. Same measured reasoning as the Getro and Personio
 * sources: the tail of the list is what anchors a posting, and dropping it
 * costs a multi-site role the one mention of the home city.
 */
function locationOf(item) {
  const block = (item.match(/<tt:locations>([\s\S]*?)<\/tt:locations>/) || [, ''])[1];
  const places = [...block.matchAll(/<tt:location>([\s\S]*?)<\/tt:location>/g)]
    .map((m) => [tag(m[1], 'tt:city'), tag(m[1], 'tt:country')].filter(Boolean).join(', '))
    .filter(Boolean);
  // Some boards put a single location outside a <tt:locations> wrapper.
  if (!places.length) {
    const flat = [tag(item, 'tt:city'), tag(item, 'tt:country')].filter(Boolean).join(', ');
    if (flat) places.push(flat);
  }
  return [...new Set(places)].join(' · ');
}

/**
 * `remoteStatus` is a HINT and only when it plainly says remote.
 *
 * Same rule as the Arbeitsagentur remote pass and the Getro work_mode field:
 * a board's own tag means somebody ticked a box in a form, and the posting
 * outranks the aggregator. normalize() honours it only while there is no
 * advert to read — and here there almost always IS one, so in practice the
 * text decides and this changes nothing. It is carried anyway for the case
 * where a board serves an empty description.
 *
 * Deliberately narrow: anything that is not clearly "fully remote" returns
 * undefined rather than a guess. "hybrid" and "temporary" are not remote, and
 * an empty string is not evidence of anything.
 */
function workModeOf(item) {
  const status = tag(item, 'remoteStatus').toLowerCase();
  return /^(fully|full|remote)/.test(status) ? 'remote' : undefined;
}

export function parseFeed(xml, { slug, name } = {}) {
  const out = [];
  for (const item of String(xml).split('<item>').slice(1).map((s) => s.split('</item>')[0])) {
    const title = tag(item, 'title');
    const link = tag(item, 'link');
    // index.js drops anything without both, so there is no point emitting it.
    if (!title || !link) continue;

    const html = (item.match(/<description>([\s\S]*?)<\/description>/) || [, ''])[1]
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');

    out.push({
      source: id,
      sourceLabel: `${label} — ${name || slug}`,
      // guid where the board supplies one, else the link — which is the
      // canonical posting URL either way.
      sourceId: `teamtailor:${slug}:${tag(item, 'guid') || link}`,
      title,
      company: name || slug,
      location: locationOf(item),
      workMode: workModeOf(item),
      applyUrl: link,
      postedAt: tag(item, 'pubDate') || null,
      descriptionHtml: '',
      // The feed HTML-escapes its markup, so this is decoded once by stripHtml
      // and then stripped — the same double duty `tag` does everywhere else.
      descriptionText: stripHtml(stripHtml(html)).replace(/\n{3,}/g, '\n\n').trim(),
    });
  }
  return out;
}

export async function fetchJobs({ boards = [] } = {}) {
  const errors = [];
  const out = [];

  for (const board of boards) {
    if (board.enabled === false) continue;
    const { slug, name } = board;
    if (!slug) { errors.push(`${name || 'a Teamtailor board'}: no slug configured`); continue; }

    const url = feedUrl(slug);
    await politeWait(url);
    let res;
    try {
      res = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/rss+xml,application/xml,text/xml' } });
    } catch (e) {
      errors.push(`${name || slug}: ${e.message}`);
      continue;
    }
    if (!res.ok) { errors.push(`${name || slug}: HTTP ${res.status} from ${url}`); continue; }

    const jobs = parseFeed(await res.text(), { slug, name });
    if (!jobs.length) errors.push(`${name || slug}: the feed parsed to no items — the shape may have changed`);
    out.push(...jobs);
  }

  return { jobs: out, errors, calls: null };
}

export const __testables = { feedUrl, tag, locationOf, workModeOf };
