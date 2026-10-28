import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { stripHtml } from '../util.js';
import * as mailstate from '../mailstate.js';
import { rulesVersion } from '../mailstate.js';

/**
 * JOB-ALERT EMAILS
 *
 * LinkedIn, StepStone and XING have no usable public API and block scraping,
 * but all three will happily email you a saved search. Reading your own inbox
 * is the one route to them that is unambiguously legitimate — they sent the
 * mail, you are parsing it.
 *
 * This is also the ONLY route that reaches StepStone (RSS returns 403) and
 * XING (redirects) at all.
 *
 * Set up: create a saved search + daily alert on each site, route the alerts
 * into a dedicated folder, and point IMAP_FOLDER at it.
 */
export const id = 'mailalerts';
export const label = 'Job-alert emails';
export const requiresKey = ['IMAP_HOST', 'IMAP_USER', 'IMAP_PASSWORD'];

/**
 * One parser per sender. Each returns {title, company, location, applyUrl}.
 *
 * Alert emails are marketing HTML — tables, tracking pixels, wrapper links —
 * so the strategy is: find anchors whose href matches the site's job-permalink
 * shape, then read the human-readable text out of the anchor itself. That
 * survives layout changes far better than matching on CSS classes.
 */
const PARSERS = [
  /**
   * Indeed's RECOMMENDATION mail, which is a different sender and a different
   * template from its saved-search digest — and must be matched FIRST.
   *
   * `PARSERS` is searched with `.find()`, so the generic `/indeed\./i` rule
   * below would claim `match.indeed.com` and then extract **nothing**:
   * verified against three real messages, 0 jobs each. Its `link` pattern
   * wants `/viewjob`, `/rc/clk` or `/pagead`, and this mail links through
   * `cts.indeed.com/v3/<base64>`. Labelling these into the folder without
   * this entry would add fifteen dead messages a month, counted under Indeed
   * and invisible.
   *
   * The template is one job per mail, as plain lines:
   *
   *     DEVOPS ENGINEER (M/W/D)
   *     42DigitalSolutions GmbH
   *     Home Office
   *     Anstellungsart: Festanstellung
   *     Arbeitsort: Hybrides Arbeiten
   *     Job anzeigen: https://cts.indeed.com/v3/<opaque>
   *
   * So title / company / location fall out positionally, and the labelled
   * lines are skipped rather than read — `Arbeitsort: Hybrides Arbeiten` is a
   * work mode, and filing it as a city is exactly the mistake the
   * eFinancialCareers block parser was rewritten to stop.
   *
   * NO id. The link is an opaque tracking blob with no `jk=`, and the rule
   * already written for sponsored Indeed postings applies unchanged: a wrong
   * id is worse than none, because `reconcile()` treats a known id under an
   * unknown fingerprint as the same posting moving. Company is present here,
   * so the ordinary fingerprint identifies it.
   */
  {
    id: 'indeed-match',
    label: 'Indeed',
    match: /match\.indeed\.com/i,
    link: /https?:\/\/cts\.indeed\.com\/[^\s"'<>]+/gi,
    extract: (ctx) => extractTextBlocks(ctx, {
      urlRe: /^(?:Job anzeigen|View job|Stelle ansehen):\s*(https?:\/\/\S+)/i,
      label: 'Indeed',
      skip: /^(guten tag|hello|aufgrund ihres profils|based on your profile|bitte reichen|anstellungsart:|arbeitsort:|gehalt:|job anzeigen|diese e-mail|abbestellen|unsubscribe|© \d{4} indeed|indeed ireland)/i,
      idFrom: () => '',
    }),
  },

  {
    id: 'linkedin',
    label: 'LinkedIn',
    match: /linkedin\.com/i,
    // /jobs/view/<slug>-<id> and the tracking-wrapped /comm/jobs/view/ variant
    link: /https?:\/\/[a-z.]*linkedin\.com\/(?:comm\/)?jobs\/view\/[^\s"'<>]+/gi,
  },
  {
    id: 'stepstone',
    label: 'StepStone',
    match: /stepstone\./i,
    link: /https?:\/\/[a-z.]*stepstone\.[a-z.]+\/(?:stellenangebote|jobs|cmp)[^\s"'<>]+/gi,
  },
  {
    id: 'xing',
    label: 'XING',
    match: /xing\.com/i,
    link: /https?:\/\/[a-z.]*xing\.com\/jobs\/[^\s"'<>]+/gi,
  },
  {
    /**
     * Read from the TEXT part, like eFinancialCareers and Arbeitsagentur, and
     * for the same reason the others were moved: the anchor gives a title and
     * nothing else, while the text part carries company, location, a teaser
     * and a date in a regular block.
     *
     * Every one of the 21 Indeed postings on file was wrong. The anchor path
     * left company as "Example GmbH - München" and location as
     * "Schnellbewerbung", a salary, or nothing.
     */
    id: 'indeed',
    label: 'Indeed',
    match: /indeed\./i,
    link: /https?:\/\/[a-z.]*indeed\.[a-z.]+\/(?:viewjob|rc\/clk|pagead)[^\s"'<>]+/gi,
    extract: (ctx) => extractTextBlocks(ctx, {
      urlRe: /^(https?:\/\/[a-z.]*indeed\.[a-z.]+\/(?:viewjob|rc\/clk|pagead)\S+)/i,
      label: 'Indeed',
      skip: /^(indeed job alert|jobs \d+-\d+|see matching results|\d+ .*job.* in |geben sie diese e-mail|diese e-mail enthält|fehlen angaben|© \d{4} indeed|theo-champion|datenschutzerkl|nutzungsbedingungen|hilfebereich|job-benachrichtigungen|von dieser job|don't share this email|this email contains)/i,
      // "Company - City", on one line. Split on the SPACED hyphen only, and
      // only on the last one, so "s.Oliver Bernd Freier GmbH & Co. KG -
      // Rottendorf" keeps its company whole and "DRK-Blutspendedienst" is not
      // touched at all. A city is never the half with the legal form in it.
      splitCompany: (line) => {
        const at = line.lastIndexOf(' - ');
        if (at <= 0) return null;
        const company = line.slice(0, at).trim();
        const location = line.slice(at + 3).trim();
        if (!company || !location || location.length > 60) return null;
        return { company, location };
      },
      // /rc/clk/dl carries jk=<job key>, which is Indeed's own stable id.
      // /pagead/clk/dl (sponsored) carries none, and inventing one from the
      // tracking blob would be a guess — so those get no id at all and are
      // deduplicated on the fingerprint like every other posting.
      //
      // NOT a URL, deliberately. normaliseSourceId() strips the query string —
      // LinkedIn alert links carry a fresh trackingId in every email, so a raw
      // URL is never equal to itself twice — and jk lives in the query, so
      // "…/viewjob?jk=abc" would normalise straight back to "…/viewjob" and
      // collide exactly as the tracking links did. An id is an identity, not an
      // address: ats.js writes "greenhouse:slug:id" and workday.js
      // "workday:tenant:reqid" for the same reason. The address is applyUrl.
      idFrom: (url) => {
        const jk = url.match(/[?&]jk=([A-Za-z0-9]+)/);
        return jk ? `indeed:${jk[1]}` : '';
      },
    }),
  },
  {
    /**
     * The Bundesagentur für Arbeit alert, and the reason it matters: the
     * Arbeitsagentur REST API returns HTTP 403 from this network, so the source
     * skips on every run. The email alert delivers the same postings, and its
     * links are clean permalinks — the exact URL shape src/sources/arbeitsagentur.js
     * builds for applyUrl.
     *
     * By far the best coverage for regional German roles, which
     * is what made losing the API expensive.
     *
     * The link pattern is anchored on /jobsuche/jobdetail/ deliberately. The same
     * email also carries a saved-search link (/jobsuche/suche?…), a profile link
     * and an unsubscribe link on rest.arbeitsagentur.de, and none of those are
     * jobs.
     */
    id: 'arbeitsagentur',
    label: 'Arbeitsagentur',
    match: /arbeitsagentur\.de/i,
    link: /https?:\/\/[a-z.]*arbeitsagentur\.de\/jobsuche\/jobdetail\/[^\s"'<>]+/gi,
    extract: (ctx) => extractTextBlocks(ctx, {
      urlRe: /^(https?:\/\/[a-z.]*arbeitsagentur\.de\/jobsuche\/jobdetail\/\S+)/i,
      label: 'Arbeitsagentur',
      skip: /^Guten Tag|gespeicherten Stellensuche|^Ihre Stellensuche/i,
    }),
  },
  {
    /**
     * eFinancialCareers, and the only parser that reads the PLAIN-TEXT part.
     *
     * Its HTML routes every link through post.spmailtechnolo.com, so the anchor
     * approach yields tracking redirects rather than postings. The text part
     * carries the real URLs AND more than the HTML does — company, location and
     * work mode, in a fixed block:
     *
     *   DevOps Engineer m/w/d
     *   PACE Mobility GmbH
     *   Karlsruhe, Germany
     *   Hybrid
     *   Competitive
     *
     *   Jetzt bewerben: https://www.efinancialcareers.de/jobs-…id24706428?stlt=…
     *
     * Finance-sector board, so most of what it sends is out of range on
     * location. The gates handle that; it is not a reason to skip the source.
     */
    id: 'efinancialcareers',
    label: 'eFinancialCareers',
    match: /efinancialcareers\./i,
    link: /https?:\/\/[a-z.]*efinancialcareers\.[a-z.]+\/jobs-[^\s"'<>]+/gi,
    extract: (ctx) => extractTextBlocks(ctx, {
      urlRe: /^Jetzt bewerben:\s*(https?:\/\/\S+)/i,
      label: 'eFinancialCareers',
      // A section heading sits in the same block as the first card under it,
      // so it was read as that card's TITLE and shifted company and location
      // down one — 16 postings recorded their title as "Jobs ähnlich Ihrer
      // letzten Aktivitäten" with the real title in the company field. Only
      // the first card of each digest is affected, which is why it looked rare.
      //
      // This list is hand-maintained and that is its weakness. It cannot be
      // replaced by a shape rule: the heading and the title are both single
      // short lines, and grouping on the blank line between them breaks the
      // single-job template, where the advert is a separate group entirely.
      skip: /^eFinancialCareers$|basierend auf Ihren|^Jobs ähnlich|^Die neuesten|^Passende Jobs?:/i,
    }),
  },
  {
    /**
     * jobs2web is the SuccessFactors career-site mailer, so one parser covers
     * every employer using it rather than one per company. Endress+Hauser is
     * the first — an employer already on the watchlist.
     *
     * The anchor text carries the title AND the location:
     *   "SAP BTP Engineer - Solution Delivery (f/m/d) - München, DE, 80331"
     * and the company is nowhere in the link, only in the subject line.
     */
    id: 'jobs2web',
    label: 'Employer alert',
    match: /jobs2web\./i,
    link: /https?:\/\/[a-z0-9.-]*careers\.[a-z0-9.-]+\/[^\s"'<>]*\/job\/[^\s"'<>]+/gi,
    refine(job, { subject }) {
      // Trailing "- City, CC, 12345" or "- City, CC". Anchored on the country
      // code so an ordinary hyphen in a job title survives: "Solution Delivery"
      // must not be mistaken for a place.
      const m = job.title.match(/^(.*)\s+-\s+([^,]+,\s*[A-Z]{2}(?:,\s*[\w-]+)?)\s*$/);
      if (m) {
        job.title = m[1].trim();
        job.location = m[2].replace(/,\s*\d[\w-]*\s*$/, '').trim();
      }

      // "Career Opportunities at Endress+Hauser Group"
      const co = String(subject || '').match(/\bat\s+(.+?)\s*$/i);
      if (co) job.company = co[1].trim();
      return job;
    },
  },
  {
    /**
     * haystack.cv, a job-alert aggregator. Five cards an email, real employers named
     * (unlike Instaffo or JobLeads, which are why those are ignored), laid out as
     *
     *     Technology
     *     DevOps Cloud-Applikation (m/w/d) #60344
     *     🏢 Instaffo GmbH
     *     📍 Berlin, Germany 🇩🇪
     *     Apply Now →
     *     https://haystack.cv/go?j=<uuid>&…&u=<appcast|jobg8 redirect>&t=<title>&c=<company>
     *
     * The title and company are read from the link's own `t=` and `c=` parameters rather than
     * from the lines above it: a card may carry a "🔥 23 hours ago" prefix on the category line,
     * and the parameters are the exact strings the site itself uses. Only the location comes
     * from the text, off the 📍 line.
     *
     * The id is `haystack:<j>`, the site's own job uuid. NOT the URL — `u=` and `sub=` change
     * per email, and normaliseSourceId() would strip the query and collapse every card to
     * `https://haystack.cv/go` (the Indeed collision again).
     *
     * The trailing " #60344" is the board's reference number, not part of the title; it is
     * removed so the fingerprint matches the same role from any other source.
     */
    id: 'haystack',
    label: 'Haystack',
    match: /haystack\.cv/i,
    link: /https?:\/\/haystack\.cv\/go\?[^\s"'<>]+/gi,
    extract: ({ text, date }) => {
      const out = [];
      const seen = new Set();
      let where = '';
      for (const raw of String(text || '').split(/\r?\n/)) {
        const line = raw.trim();
        const pin = line.match(/^📍\s*(.+)$/u);
        if (pin) {
          // "Berlin, Germany 🇩🇪" — drop the flag and the country, keep the city.
          where = pin[1].replace(/[\u{1F1E6}-\u{1F1FF}]+/gu, '').replace(/,\s*Germany\s*$/i, '').trim();
          continue;
        }
        const hit = line.match(/^(https?:\/\/haystack\.cv\/go\?\S+)/i);
        if (!hit) continue;
        let q;
        try { q = new URL(hit[1]).searchParams; } catch { continue; }
        const j = q.get('j');
        const title = (q.get('t') || '').replace(/\s*#\d+\s*$/, '').trim();
        const company = (q.get('c') || '').trim();
        const location = where;
        where = '';
        if (!j || !title || title.length < 4 || seen.has(j)) continue;
        seen.add(j);
        out.push({
          source: 'mailalerts',
          sourceLabel: 'Haystack alert',
          sourceId: `haystack:${j}`,
          title,
          company: company || 'Haystack',
          location,
          descriptionText: '',
          descriptionHtml: '',
          applyUrl: hit[1],
          postedAt: date || null,
        });
      }
      return out;
    },
  },
];

/**
 * Senders looked at and deliberately not parsed.
 *
 * Without this the "could not read" warning cries wolf every run about mail
 * that will never contain a job, and a warning you learn to ignore is worse
 * than none — the next genuinely new sender would scroll past unnoticed.
 *
 * Each entry says why, because "we tried" is the useful part. Instaffo sends
 * every link through trk.instaffo.com/ls/click?upn=<opaque>, so there is no
 * permalink to read without following redirects, and its subjects are
 * marketing ("Time for a fresh start", "No match yet? No problem!") rather
 * than job listings. It is a matching platform where employers approach you;
 * there is no job board behind it to link to.
 */
const IGNORED = [
  { match: /instaffo\./i, why: 'links are opaque tracking redirects, and the mail is marketing rather than job listings' },
  /**
   * JobLeads. A parser for this WAS written, worked, and was then deleted —
   * which is the useful part of the record, because the shape is tractable and
   * someone will reach for it again.
   *
   * It reads cleanly: five job cards an email, typed bullets under a title,
   * a stable id in the URL path. None of that is the problem.
   *
   * **Applying is behind a paywall**, checked by hand on the actual postings.
   * A listing you cannot act on without paying is not a lead, and putting it
   * in the queue spends review time on something already decided. That is a
   * different and stronger reason than Instaffo's above: Instaffo is
   * unreadable, this is readable and not worth reading.
   *
   * Second sender on this footing — BeBee is pay-to-apply too, confirmed
   * twice. If a third turns up, that is the point to stop recording them one
   * at a time and give the profile a list of publishers to exclude.
   *
   * The secondary objection, kept because it would matter even without the
   * paywall: the employer is never named, so every posting is
   * `employerUnknown` and can never merge with the same role listed under its
   * real employer elsewhere.
   */
  { match: /jobleads\./i, why: 'applying is behind a paywall, and the employer is never named' },
];

const ignoredReason = (from) => IGNORED.find((x) => x.match.test(from || ''))?.why || null;

const pickParser = (from) => PARSERS.find((p) => p.match.test(from || ''));

/**
 * Card furniture that is not part of any field.
 *
 * LinkedIn appends these to the job card, inside the same anchor, so they end
 * up as lines of their own. "Easy Apply" reached the report as part of a title.
 */
const CARD_NOISE = /^(easy apply|promoted|actively recruiting|be an early applicant|viewed|applied|new|sofort bewerben|beworben|angesehen|neu)$/i;

// The furniture LinkedIn puts between a card's location and its link. Observed
// in live mail rather than imagined: a card without a location line would
// otherwise file "Apply with resume & profile" or "16 school alumni" as a city.
const PLAIN_NOISE = /^(view job:|apply with resume|this company is actively hiring|\d+ (school alumni|connections?)|easy apply|see all jobs|show all)/i;

/** Anchor text is the job title in every alert format seen so far. */
function anchorsFrom(html) {
  const out = [];
  const re = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    out.push({ href: decodeEntities(m[1]), text: stripHtml(m[2]).trim() });
  }
  return out;
}

const decodeEntities = (s) => String(s)
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d));

/**
 * Extract jobs from one alert email.
 *
 * Company and location are best-effort: alert layouts vary, and a missing
 * value is better than a wrong one — the pipeline treats an unresolved
 * location as *uncertain* and escalates it rather than guessing.
 */
/**
 * Postings read from the PLAIN-TEXT part rather than the HTML.
 *
 * Two senders need this, for different reasons. eFinancialCareers routes every
 * HTML link through post.spmailtechnolo.com, so the anchor walk yields tracking
 * redirects and nothing else. Arbeitsagentur does publish real permalinks in its
 * HTML, but the anchor text there is numbered — "1. Sales Manager", "2.
 * IT-Workplace…" — and the number is the position in that day's email, not part
 * of the title. Fingerprints are built from the title, so the same posting at a
 * different position in tomorrow's email would have been filed as a new job.
 * That is exactly the identity drift the store fix exists to prevent, arriving
 * from a new direction.
 *
 * Both lay a posting out the same way: title, company, location, then some
 * optional lines, then the URL. So the block is everything since the previous
 * URL, and the first three non-empty lines are what matter.
 */
/**
 * The lines that are metadata rather than identity.
 *
 * Positional reading — first line title, second company, third location —
 * broke on the first block that omitted the company: "Festanstellung",
 * "Home-Office" and "Hybrid" were filed as cities, which the gazetteer cannot
 * resolve and the location gate then has to guess about. Both senders put work
 * mode, employment type and salary in the same block as the title, and neither
 * puts them in a fixed position.
 *
 * So these are removed first, and what remains is read by how many lines are
 * left rather than by index.
 */
const BLOCK_NOISE = [
  /^(home-?office|hybrid|remote|vor ort|im büro|on-?site|flexible)$/i,
  /^(festanstellung|vollzeit|teilzeit|befristet|unbefristet|praktikum|werkstudent|freelance|contract)$/i,
  /^competitive$/i,
  /^[\d.,\s€$£–—-]+(\s*(pro|\/)\s*(jahr|monat|year|month|annum))?$/i,
  // Indeed puts an apply badge and a relative date in the same block, and both
  // were reaching the location field: "Schnellbewerbung" was the location of
  // three postings, and a salary line of a fourth.
  /^(schnellbewerbung|easily apply|easy apply|sofort bewerben)$/i,
  /^(vor \d+ (minute|stunde|tag|monat)\w*|gerade geschaltet|heute|gestern|neu|posted (today|yesterday)|\d+ days? ago)$/i,
];

const isNoise = (line) => BLOCK_NOISE.some((re) => re.test(line));

/**
 * A description is not a field, and it was being filed as one.
 *
 * eFinancialCareers' single-job template puts the whole advert in the block:
 *
 *     Lead DevOps Engineer | Broadridge Trading & Connectivity Solutions
 *     London, United Kingdom
 *     Festanstellung                        <- BLOCK_NOISE
 *     Competitive                           <- BLOCK_NOISE
 *     At Broadridge, we&apos;ve built a culture where ... (6,000 characters)
 *     Jetzt bewerben: https://...
 *
 * so the positional read gave company "London, United Kingdom" and location the
 * entire advert. Indeed does the same with a shorter teaser.
 *
 * LENGTH ALONE CANNOT SEPARATE THESE, and that is the trap. A real
 * eFinancialCareers title runs to 109 characters ("Lead Architect / Senior
 * Technology Lead - Cloud, AI, & DevOps...") while the shortest Indeed teaser
 * is 119. There is no threshold between them.
 *
 * What does separate them is position: the title is always the FIRST line of a
 * block. So prose is only ever looked for after that, and the threshold then
 * only has to clear a company (longest real one, 66 characters) and a location
 * (99th percentile, 77) — not a title.
 */
const isProse = (line) => line.length >= 100 || /<[a-z/!]/i.test(line);

function extractTextBlocks({ text, date }, { urlRe, label, skip, splitCompany, idFrom }) {
  const out = [];
  let block = [];
  let prose = [];

  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    const hit = line.match(urlRe);

    if (!hit) {
      if (!line || skip.test(line) || isNoise(line)) continue;
      // Never the first line — that is the title, and a title can be longer
      // than any threshold worth setting. See isProse.
      if (block.length && isProse(line)) prose.push(line);
      else block.push(line);
      continue;
    }

    const lines = block;
    const body = prose;
    block = [];
    prose = [];
    if (!lines.length) continue;

    // Three lines is title / company / location. Two is title / location, with
    // the company inside the title after a pipe — eFinancialCareers writes
    // "Senior DevOps Engineer (m/w/d) | Mittwald CM Service" that way. One is a
    // title and nothing else.
    let [title, company, location] = lines;

    if (splitCompany) {
      // Indeed writes company and location as ONE line — "Example GmbH -
      // München" — so the whole thing became the company on all 21 of its
      // postings. The second line is therefore never a location by itself, and
      // the two-line rule below must not be applied to this sender: it would
      // read "DRK-Blutspendedienst Baden-Württemberg" as a place and fall back
      // to the sender's name for the employer.
      //
      // The separator is a SPACED hyphen, and only the last one, so
      // "s.Oliver Bernd Freier GmbH & Co. KG - Rottendorf" keeps its company
      // whole and "DRK-Blutspendedienst" is not touched at all.
      const split = company ? splitCompany(company) : null;
      if (split) ({ company, location } = split);
      else location = location || '';
    } else if (lines.length === 2) {
      location = company;
      company = null;
    }

    if (!company && /\|/.test(title)) {
      const parts = title.split('|').map((x) => x.trim());
      title = parts[0];
      company = parts.slice(1).join(' | ') || null;
    }

    if (!title || title.length < 4) continue;

    const url = hit[1];
    out.push({
      source: id,
      sourceLabel: `${label} alert`,
      // Indeed's links are tracking redirects — /rc/clk/dl and /pagead/clk/dl —
      // and stripping the query left every posting sharing one of TWO ids.
      // That is worse than having none: reconcile() treats a known id under an
      // unknown fingerprint as the same posting moving, so the next new Indeed
      // job would have been absorbed into an old one's identity and inherited
      // its status. `idFrom` recovers the real job key where there is one and
      // returns null where there is not, because no id is safe and a shared id
      // is not.
      sourceId: idFrom ? idFrom(url) : url.split(/[?#]/)[0],
      title,
      company: company || label,
      // Arbeitsagentur appends its own distance — "Baden-Baden (84 km)" — which
      // the gazetteer cannot resolve and does not need, since geo computes it.
      location: (location || '').replace(/\s*\(\s*\d+\s*km\s*\)\s*$/i, '').trim(),
      // The prose we just refused to file as a location is the advert, and it
      // was being thrown away. eFinancialCareers' single-job template carries
      // the whole thing — 6,000 characters, which is more than the fetch step
      // recovers for that sender 95% of the time. Passed through stripHtml
      // because it arrives with `<br />` and `&apos;` in it.
      //
      // It does NOT make the posting look fully read: descriptionComplete is
      // derived from MIN_DESCRIPTION_CHARS downstream, so a short Indeed teaser
      // stays incomplete and the soft drops that protect an unread posting
      // still apply.
      descriptionText: body.length ? stripHtml(body.join('\n')).trim() : '',
      descriptionHtml: '',
      applyUrl: url,
      postedAt: date || null,
    });
  }

  return out;
}

function extractJobs(parser, { html, text, subject, date }) {
  // A parser may replace the anchor walk entirely. eFinancialCareers has to,
  // because its HTML carries only tracking redirects.
  if (parser.extract) return parser.extract({ html, text, subject, date });

  const body = html || '';
  const anchors = anchorsFrom(body);
  const seen = new Set();
  const jobs = [];

  for (const { href, text: label } of anchors) {
    parser.link.lastIndex = 0;
    if (!parser.link.test(href)) continue;

    // Strip tracking query strings so the same job in two emails dedupes.
    const clean = href.split(/[?#]/)[0];
    if (seen.has(clean)) continue;

    // The anchor wraps the whole job CARD, not just the title — a nested table
    // whose rows stripHtml() turns into lines:
    //
    //     Staff Site Reliability Engineer (d/f/m)
    //     Personio · Berlin (Remote)
    //     Easy Apply
    //
    // Collapsing that with `\s+` threw the structure away and left the company
    // and location jammed onto the end of the title. 64 postings recorded their
    // company as "LinkedIn" — the sender — because the fallback below was all
    // that was left. Read the lines instead.
    const lines = label.split('\n')
      .map((l) => l.replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .filter((l) => !CARD_NOISE.test(l));

    const title = lines[0] || '';
    if (!title || title.length < 4 || /^(view|see|apply|mehr|alle|show)\b/i.test(title)) continue;
    if (/^https?:/i.test(title)) continue;

    seen.add(clean);
    const job = { title, applyUrl: href, cleanUrl: clean };

    // "Company · Location" on a line of its own. Only trusted when the
    // separator is actually there — without it the halves cannot be told apart,
    // and a wrong company is worse than none, since the fingerprint is built
    // from it.
    const meta = lines.slice(1).find((l) => l.includes('·'));
    if (meta) {
      const [company, ...rest] = meta.split('·').map((x) => x.trim());
      if (company && company.length < 80) job.company = company;
      const where = rest.join(' · ').trim();
      if (where && where.length < 80) job.location = where;
    }

    jobs.push(job);
  }

  // Company / location sit in the plain-text part right under the title. The
  // layout is regular — read from live mail rather than assumed:
  //
  //     Kubernetes Platform Architect
  //     Broadcom
  //     Germany
  //     16 school alumni
  //     View job: https://www.linkedin.com/comm/jobs/view/4453568342/...
  //     ---------------------------------------------------------
  //
  // A CARD TITLE IS ALWAYS A WHOLE LINE. That is the load-bearing rule, and
  // matching a substring instead is what produced 40e10f3a. Every alert opens
  // with a header naming the SEARCH TERM inside a sentence --
  //
  //     Your job alert for Cloud Architect in Germany
  //     New jobs match your preferences.
  //
  // -- so indexOf('Cloud Architect') landed on line 0, thirteen lines above the
  // card it belonged to, and the two lines it then took were the rest of that
  // sentence and the strapline: company "in Germany", location "New jobs match
  // your preferences." Ten records were filed that way, seven of them still in
  // the last fetch. "Your job alert has been created: X in Germany." is the
  // same fault arriving from the alert-created mail.
  const plainLines = (text || stripHtml(body)).replace(/\r/g, '').split(/\n/).map((l) => l.trim());

  // A digest can list the same title twice -- the primary list and a "jobs
  // similar to" block below it. A cursor hands each job the next unclaimed
  // occurrence rather than giving every one of them the first.
  let cursor = 0;
  for (const job of jobs) {
    const at = plainLines.indexOf(job.title, cursor);
    if (at === -1) continue;
    cursor = at + 1;

    // Read forward only to the card's own end. Without the stop a card missing
    // its company line would reach across the separator and take the next
    // card's, which is a wrong company rather than an absent one -- and the
    // fingerprint is built from the company, so a guess gives the posting a
    // false identity.
    const field = [];
    for (let i = at + 1; i < plainLines.length && field.length < 2; i++) {
      const l = plainLines[i];
      if (!l) continue;
      if (/^-{5,}$/.test(l) || /^view job:/i.test(l)) break;
      if (PLAIN_NOISE.test(l) || CARD_NOISE.test(l)) continue;
      if (l.length >= 80) break;
      field.push(l);
    }

    // Fill gaps only. When the anchor carried "Company " + SEP + " Location" it
    // has already answered, and it read them off the card itself -- overwriting
    // that with a positional guess can only lose.
    if (!job.company && field[0]) job.company = field[0];
    if (!job.location && field[1]) job.location = field[1];
  }

  // A parser may correct what the generic pass guessed. The generic pass reads
  // a title out of the anchor and a company out of the line below it, which is
  // right for a job board and wrong for an employer's own alert — there the
  // anchor holds title and location together and the company is in the subject.
  if (parser.refine) for (const j of jobs) parser.refine(j, { subject, text, html });

  return jobs.map((j) => ({
    source: id,
    sourceLabel: `${parser.label} alert`,
    sourceId: j.cleanUrl,
    title: j.title,
    company: j.company || parser.label,
    location: j.location || '',
    descriptionText: '',
    descriptionHtml: '',
    applyUrl: j.applyUrl,
    postedAt: date || null,
    _alertSubject: subject,
  }));
}

/**
 * Read the job-alert folder.
 *
 * Only what is NEW since the last scan is downloaded and parsed (see mailstate.js for why the
 * bookmark is a UID and what sends this back to reading the whole window). The result says how
 * to treat the postings it returns:
 *
 *   merge   set on a read of new mail only: the jobs are a DELTA, to be merged into the stored
 *           replay slice rather than replacing it, or `--replay` would judge only the latest
 *           batch of mails (and none at all after a scan that found no new mail).
 *   commit  moves the bookmark. The caller runs it only AFTER the batch is saved, so a scan
 *           that dies in between re-reads some mail — duplicates merge, nothing is lost.
 *
 * Three kinds of message come back, because they are three different things. `errors` are
 * real failures; the loop treats "errors and no jobs" as "nothing came back" and checks the
 * connection. `warnings` are actionable (a sender with no parser) and must be seen, but they
 * are not a failed fetch. `notes` are information. They used to share one list, so a scan
 * that found no new mail, or only mail with no jobs in it, looked like a failure.
 *
 * `imap` and `rules` exist so a test can supply a fake mailbox and a fixed rules version.
 */
export async function fetchJobs({ profile, imap = (cfg) => new ImapFlow(cfg), rules = rulesVersion() } = {}) {
  const errors = [];
  const warnings = [];
  const notes = [];
  const out = [];

  const host = process.env.IMAP_HOST;
  const user = process.env.IMAP_USER;
  const pass = process.env.IMAP_PASSWORD;
  if (!host || !user || !pass) {
    return { jobs: [], errors: ['missing IMAP_HOST / IMAP_USER / IMAP_PASSWORD'], skipped: true };
  }

  const folder = process.env.IMAP_FOLDER || 'INBOX';
  const sinceDays = Number(process.env.IMAP_SINCE_DAYS || 7);
  const since = new Date(Date.now() - sinceDays * 86400000);

  const client = imap({
    host,
    port: Number(process.env.IMAP_PORT || 993),
    secure: String(process.env.IMAP_TLS ?? 'true') !== 'false',
    auth: { user, pass },
    logger: false,
  });

  try {
    await client.connect();
  } catch (e) {
    return { jobs: [], errors: [`connect failed: ${describeImapError(e)}`], skipped: true };
  }

  let lock;
  try {
    lock = await client.getMailboxLock(folder);
  } catch (e) {
    await client.logout().catch(() => {});
    return { jobs: [], errors: [`cannot open folder "${folder}": ${e.message}`], skipped: true };
  }

  let summary = '';
  let merge;
  let commit;

  try {
    const uidValidity = String(client.mailbox?.uidValidity ?? '');
    // Read BEFORE searching: anything that arrives after this has a UID at or above it, so
    // "everything below uidNext" is exactly what this scan is responsible for.
    const uidNext = Number(client.mailbox?.uidNext) || 0;
    const key = mailstate.keyFor({ host, user, folder });
    const plan = mailstate.decide(mailstate.load().mailboxes?.[key], { uidValidity, rules });

    let uids;
    if (plan.mode === 'delta') {
      // "UID n:*" always includes the LAST message, even when its UID is below n. That is how
      // IMAP defines a range ending in *, so anything not strictly above the bookmark is dropped.
      const found = await client.search({ uid: `${plan.after + 1}:*` }, { uid: true });
      uids = (found || []).filter((u) => u > plan.after);
      merge = { days: sinceDays };
      summary = uids.length
        ? `mail: ${uids.length} new message${uids.length === 1 ? '' : 's'} above UID ${plan.after}`
        : `mail: nothing new above UID ${plan.after}`;
    } else {
      uids = (await client.search({ since }, { uid: true })) || [];
      summary = `mail: read the last ${sinceDays} days (${uids.length} message${uids.length === 1 ? '' : 's'}) — ${plan.why}`;
      if (!uids.length) notes.push(`no messages in "${folder}" from the last ${sinceDays} days`);
    }

    const byParser = new Map();
    // Senders with no parser, by domain. Reported, never silently skipped.
    const unknown = new Map();
    // Senders on the ignore list, kept apart so the real warning stays rare.
    const skipped = new Map();
    let maxUid = 0;

    if (uids.length) {
      for await (const msg of client.fetch(
        { uid: uids },
        { source: true, envelope: true },
        { uid: true }
      )) {
        if (msg.uid > maxUid) maxUid = msg.uid;
        let parsed;
        try {
          parsed = await simpleParser(msg.source);
        } catch (e) {
          errors.push(`unparseable message: ${e.message}`);
          continue;
        }

        const from = parsed.from?.value?.[0]?.address || '';
        const parser = pickParser(from);

        // Four senders are understood. Anything else used to be dropped in
        // silence, which is the one thing this project says a source must never
        // do — add a job site to your alerts, point it at this folder, and the
        // run would look identical while reading none of it. Counted by sender
        // now and reported at the end, so an unread alert is visible the first
        // time it arrives rather than months later.
        if (!parser) {
          const domain = from.split('@')[1] || from || 'unknown sender';
          const known = ignoredReason(from);
          if (known) skipped.set(domain, { n: (skipped.get(domain)?.n || 0) + 1, why: known });
          else unknown.set(domain, (unknown.get(domain) || 0) + 1);
          continue;
        }

        const jobs = extractJobs(parser, {
          html: parsed.html || '',
          text: parsed.text || '',
          subject: parsed.subject || '',
          date: parsed.date?.toISOString() || null,
        });

        byParser.set(parser.label, (byParser.get(parser.label) || 0) + jobs.length);
        out.push(...jobs);
      }
    }

    for (const [name, n] of byParser) notes.push(`${name}: ${n} job(s) extracted`);

    // Loud, and specific about what to do. A count alone reads like noise; the
    // domain is the thing that tells you whether it was an alert you set up.
    for (const [domain, { n, why }] of skipped) {
      notes.push(`${n} email(s) from ${domain} skipped — ${why}`);
    }

    for (const [domain, n] of [...unknown.entries()].sort((a, b) => b[1] - a[1])) {
      warnings.push(`${n} email(s) from ${domain} were not read — no parser for that sender. `
        + 'Add one to PARSERS in src/sources/mailalerts.js if it is a job alert.');
    }

    // The bookmark. A full read covers every message that exists NOW — those in the window
    // are read, the older ones are skipped on purpose, as they always were — so it moves to
    // just below uidNext. A read of new mail moves to the highest UID it saw. Nothing moves
    // when there was nothing new: there is nothing to record.
    const lastUid = plan.mode === 'full' ? Math.max(uidNext - 1, maxUid) : Math.max(plan.after, maxUid);
    if (plan.mode === 'full' || uids.length) {
      commit = () => {
        const state = mailstate.load();
        mailstate.remember(state, key, { uidValidity, lastUid, rules });
        mailstate.save(state);
      };
    }
  } catch (e) {
    errors.push(`read failed: ${e.message}`);
    commit = undefined;     // a failed read must not move the bookmark
  } finally {
    lock.release();
    await client.logout().catch(() => {});
  }

  return { jobs: out, errors, warnings, notes, summary, merge, commit };
}

function describeImapError(e) {
  const m = e?.message || String(e);
  if (/authentication|AUTHENTICATIONFAILED|invalid credentials/i.test(m)) {
    return 'authentication failed — use an APP PASSWORD, not your normal login password';
  }
  if (/ENOTFOUND|EAI_AGAIN/i.test(m)) return `host not found — check IMAP_HOST`;
  if (/ECONNREFUSED/i.test(m)) return 'connection refused — check IMAP_PORT (993 for TLS)';
  if (/certificate/i.test(m)) return `TLS problem: ${m}`;
  return m;
}

/** Used by `npm run keys` to test the connection without fetching everything. */
export async function probeMailbox() {
  const host = process.env.IMAP_HOST;
  if (!host) return { ok: false, error: 'IMAP_HOST not set' };

  const client = new ImapFlow({
    host,
    port: Number(process.env.IMAP_PORT || 993),
    secure: String(process.env.IMAP_TLS ?? 'true') !== 'false',
    auth: { user: process.env.IMAP_USER, pass: process.env.IMAP_PASSWORD },
    logger: false,
  });

  try {
    await client.connect();
    const folder = process.env.IMAP_FOLDER || 'INBOX';
    const box = await client.mailboxOpen(folder).catch(() => null);
    if (!box) {
      const names = [];
      for await (const f of client.list()) names.push(f.path);
      await client.logout().catch(() => {});
      return { ok: false, error: `folder "${folder}" not found`, folders: names.slice(0, 25) };
    }
    const sinceDays = Number(process.env.IMAP_SINCE_DAYS || 7);
    const recent = await client.search(
      { since: new Date(Date.now() - sinceDays * 86400000) },
      { uid: true }
    );
    await client.logout().catch(() => {});
    return { ok: true, folder, total: box.exists, recent: recent?.length || 0, sinceDays };
  } catch (e) {
    await client.logout().catch(() => {});
    return { ok: false, error: describeImapError(e) };
  }
}

/** Exposed for tests — parsing is the part that must survive layout changes. */
export const __testables = { extractJobs, pickParser, anchorsFrom };
