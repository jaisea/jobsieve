import { httpJson } from '../util.js';
import { parseWorkdayUrl } from './workday.js';

/**
 * Work out which applicant-tracking system a careers URL belongs to.
 *
 * Adding a company used to mean two different chores depending on the platform:
 * append a slug to `candidates` and re-run 385 probes, or hand-edit a Workday
 * entry. Both required knowing which ATS the company used before you started.
 *
 * You do not know that. What you have is the URL in your address bar. So this
 * takes that URL and works backwards, in two stages:
 *
 *   1. Match it against the known board URL shapes — instant, no request.
 *   2. If it is the company's own careers domain, fetch it and look for an
 *      embedded board. Career sites are JS shells with no job data (verified on
 *      six German/Swiss employers: zero carried JobPosting markup), but the
 *      HTML still names the board it loads from, which is all we need.
 */

/** Direct URL shapes, most specific first. */
const PATTERNS = [
  { ats: 'workday', test: (u) => (parseWorkdayUrl(u) ? { workday: parseWorkdayUrl(u) } : null) },
  { ats: 'greenhouse', re: /(?:boards|job-boards)\.greenhouse\.io\/(?:embed\/job_board\?for=)?([\w-]+)/ },
  { ats: 'lever', re: /jobs\.lever\.co\/([\w-]+)/ },
  { ats: 'ashby', re: /jobs\.ashbyhq\.com\/([\w-]+)/ },
  { ats: 'smartrecruiters', re: /(?:careers|jobs)\.smartrecruiters\.com\/([\w-]+)/ },
  { ats: 'recruitee', re: /([\w-]+)\.recruitee\.com/ },
  { ats: 'bamboohr', re: /([\w-]+)\.bamboohr\.com\/careers/ },
  { ats: 'breezy', re: /([\w-]+)\.breezy\.hr/ },
  // Personio is not in the ATS table -- its feed is XML, so it has its own
  // source module. Recognised here anyway, because `discover --add <url>`
  // should say what a Personio careers link IS rather than "unrecognised".
  { ats: 'personio', re: /([\w-]+)\.jobs\.personio\.(?:de|com)/ },
];

/** Recognise a board from a URL alone. Returns { ats, slug } or { ats:'workday', board }. */
export function fromUrl(url = '') {
  const u = String(url);
  for (const pat of PATTERNS) {
    if (pat.test) {
      const hit = pat.test(u);
      if (hit) return { ats: 'workday', board: hit.workday };
      continue;
    }
    const m = u.match(pat.re);
    if (m) return { ats: pat.ats, slug: m[1] };
  }
  return null;
}

/**
 * Last resort: fetch the page and find the board it embeds.
 *
 * Only the FIRST match per platform is taken. Career pages link to plenty of
 * unrelated boards in footers and "jobs at our partners" blocks, so collecting
 * every match would attach the wrong company.
 */
export async function fromPage(url) {
  const res = await httpJson(url, { headers: { Accept: 'text/html' } });
  // httpJson returns parsed JSON when it can; for HTML the raw text is what we want.
  const html = res.text || (typeof res.data === 'string' ? res.data : '');
  if (!html) return { error: res.error || `HTTP ${res.status}` };

  for (const pat of PATTERNS) {
    if (pat.test) {
      const m = html.match(/https?:\/\/[\w-]+\.wd\d+\.myworkdayjobs\.com\/[^\s"'<>]+/);
      if (m) {
        const board = parseWorkdayUrl(m[0]);
        if (board) return { ats: 'workday', board, via: m[0] };
      }
      continue;
    }
    const m = html.match(pat.re);
    if (m) return { ats: pat.ats, slug: m[1], via: m[0] };
  }
  return { error: 'no known job board referenced on that page' };
}

/** Platforms this can recognise, for help text. */
export const SUPPORTED = ['greenhouse', 'lever', 'ashby', 'smartrecruiters', 'recruitee', 'workday', 'bamboohr', 'breezy', 'personio'];
