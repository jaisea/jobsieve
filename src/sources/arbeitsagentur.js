import { httpJson, pool } from '../util.js';

/**
 * Bundesagentur für Arbeit — the official German federal employment agency, and
 * the best coverage there is for roles anywhere in Germany.
 *
 * IT HAS BEEN RETURNING 403 FOR THE WHOLE LIFE OF THIS PROJECT, AND THE
 * DIAGNOSIS WAS WRONG. Every run reported "auth refused — this API blocks some
 * networks; retry from your normal German connection", and both the README and
 * CLAUDE.md repeated it as a WAF block on the egress IP. It was not. The
 * endpoint being called, `/pc/v4/jobs`, is retired, and a retired endpoint here
 * answers 403 exactly like a rejected key does. The OAuth dance made it look
 * even more like an auth problem, which is why nobody looked further.
 *
 * Measured, all from the same machine that had been "blocked" for months:
 *
 *   /pc/v4/jobs      X-API-Key   403
 *   /pc/v4/app/jobs  X-API-Key   403
 *   /pc/v6/jobs      no auth     403
 *   /pc/v6/jobs      X-API-Key   200   23 results
 *
 * So: v6, and the key is a published constant rather than a credential —
 * `X-API-Key: jobboerse-jobsuche`, documented by the agency itself. No token
 * exchange, no client secret. The OAuth path and the two hardcoded UUIDs it
 * needed are gone.
 *
 * Still `failSoft`: a public API with no contract can disappear again, and a
 * dead source must degrade the run rather than end it.
 */

export const id = 'arbeitsagentur';
export const label = 'Arbeitsagentur';
export const failSoft = true;

/** Published by the agency in its own documentation. Not a secret. */
const API_KEY = 'jobboerse-jobsuche';
const SEARCH = 'https://rest.arbeitsagentur.de/jobboerse/jobsuche-service/pc/v6/jobs';

/**
 * Filter at the source, which this API is unusually good at.
 *
 * `angebotsart=1` is WORK — it excludes self-employment, Ausbildung and
 * internships, which the title gate would otherwise have to catch one by one.
 * `arbeitszeit=vz` is full-time. Both match the filters set on the
 * website for the email alerts, deliberately: the two routes into the same
 * source should not disagree about what counts.
 */
const OFFER_TYPE_WORK = '1';
const FULL_TIME = 'vz';

/**
 * `veroeffentlichtseit` is NOT sent, deliberately.
 *
 * It works, but it filters on a date it does not report. A posting whose
 * `veroeffentlichungszeitraum.von` reads 2026-05-07 — 119 days old — still
 * comes back under `veroeffentlichtseit=45`, presumably because the agency
 * counts from a re-listing rather than the field it hands over. Sending it
 * would therefore be a pre-filter whose behaviour cannot be predicted from the
 * data, and a pre-filter that silently drops something is the one failure this
 * project will not accept (see the note above `looksReachable`).
 *
 * The local age gate is precise and reads the date actually returned. It drops
 * 11 of 51 on a real run, which is the gate working rather than a gap.
 */

/**
 * One page is 100 results and `maxErgebnisse` says how many there are. Three
 * pages is 300 per query, which no query has come near — the widest measured
 * was 23. The cap exists so a badly-chosen keyword cannot walk the whole board.
 */
const PAGE_SIZE = 100;
const MAX_PAGES = 3;

/**
 * A second pass for remote roles, with no location constraint at all.
 *
 * The local pass sends `wo` and `umkreis`, which is the same trap the Roche
 * Workday facet sets: a remote German role is posted under whichever office
 * owns it, so anchoring on the home city drops exactly the remote roles worth
 * having. Measured — "DevOps Engineer" within 70km returns 8; nationwide, 577.
 *
 * Dropping the location filter alone does not work. Of 100 nationwide results
 * only ONE mentions remote in its title, so the location gate discards 99 and
 * finds the one by luck. What does work is the keyword: the API's free-text
 * search reads the DESCRIPTION, so "DevOps Engineer remote" returns 90 results
 * that are genuinely remote.
 *
 * Both words are needed. Of 68 hits for "homeoffice", 55 do not appear in the
 * 90 hits for "remote" — German adverts use either. Combining them into one
 * query is worse than running two: "remote homeoffice" misses 28 that "remote"
 * alone found.
 */
const REMOTE_TERMS = ['remote', 'homeoffice'];

const headers = { 'X-API-Key': API_KEY, Accept: 'application/json' };

/** The public posting page, which is also what `enrich` can read for the text. */
const applyUrlFor = (refnr) =>
  `https://www.arbeitsagentur.de/jobsuche/jobdetail/${encodeURIComponent(refnr)}`;

/**
 * The search result carries no description — that needs `/pc/v4/jobdetails/`
 * with the reference number base64-encoded, one request per posting.
 *
 * Deliberately NOT done here. Fetching a detail for every hit would spend a
 * request on postings the location and title gates discard for free, which is
 * the trap `src/sources/workday.js` documents. `enrich` fetches descriptions
 * for survivors only, and the public page it reads carries the same text as
 * ld+json.
 */
function toJob(j, { remoteHint = false } = {}) {
  const addr = j.stellenlokationen?.[0]?.adresse || {};
  const location = [addr.ort, addr.region, addr.land].filter(Boolean).join(', ');

  return {
    // A HINT, never a finding. It says only that this posting matched a
    // free-text search for "remote" or "homeoffice" somewhere in its
    // description — which could equally be "kein Homeoffice". normalize runs
    // detectWorkMode FIRST and falls back to this only when the text says
    // nothing, and at this point there is no text at all. Once enrich fetches
    // the description the second gating pass reads the real thing and this is
    // overridden. Setting it as a finding would be the aggregator-outranks-the-
    // posting bug that put a Hannover job in the report at 93.
    workMode: remoteHint ? 'remote' : undefined,
    source: id,
    sourceLabel: label,
    sourceId: j.referenznummer,
    title: j.stellenangebotsTitel || j.hauptberuf,
    company: j.firma || 'Unknown',
    location,
    // The agency computes the distance from `wo` itself. geo.js recomputes it
    // from the gazetteer, and the two agree; this is here because a posting
    // whose town the gazetteer does not know still arrives with a real number.
    distanceKm: Number.isFinite(j.entfernung) ? j.entfernung : null,
    descriptionHtml: '',
    descriptionText: '',
    applyUrl: applyUrlFor(j.referenznummer),
    // Three dates, and picking the wrong one ages live jobs out of the report.
    // Employers here post once and then re-list, so `datumErsteVeroeffentlichung`
    // is the first appearance ever and is routinely a year or more stale — one
    // open DevOps role reads 2025-01-31 first published, 2026-08-18 re-listed.
    // `veroeffentlichungszeitraum.von` is the start of the CURRENT listing, which
    // is what "posted" should mean. `aenderungsdatum` is last-touched and is what
    // the agency's own `veroeffentlichtseit` filter counts from — too generous,
    // since editing a stale advert would make it permanently fresh.
    postedAt: j.veroeffentlichungszeitraum?.von || j.aenderungsdatum || j.datumErsteVeroeffentlichung || null,
    employmentType: j.arbeitszeitVollzeit ? 'Vollzeit' : null,
    salary: j.gehaltsspanneVon && j.gehaltsspanneBis
      ? `${j.gehaltsspanneVon}–${j.gehaltsspanneBis} EUR`
      : null,
  };
}

export async function fetchJobs({ queries = [], profile, concurrency = 2 } = {}) {
  const errors = [];
  const out = [];

  const { city, radiusKm } = profile.location;
  let blocked = false;

  // Two passes. The local one anchors on the profile's city; the remote one
  // has no location at all and leans on the keyword instead.
  const passes = [
    ...queries.map((q) => ({ was: q, local: true })),
    ...queries.flatMap((q) => REMOTE_TERMS.map((term) => ({ was: `${q} ${term}`, local: false }))),
  ];

  const search = async ({ was, local }, page) => {
    const params = new URLSearchParams({
      was,
      angebotsart: OFFER_TYPE_WORK,
      arbeitszeit: FULL_TIME,
      size: String(PAGE_SIZE),
      page: String(page),
    });
    if (local) {
      params.set('wo', city);
      params.set('umkreis', String(radiusKm));
    }
    return httpJson(`${SEARCH}?${params}`, { headers, retries: 1 });
  };

  await pool(passes, concurrency, async (pass) => {
    if (blocked) return;
    const q = pass.was;

    for (let page = 1; page <= MAX_PAGES; page++) {
      const res = await search(pass, page);

      if (!res.ok) {
        if (res.status === 403 || res.status === 401) {
          // Stop asking a host that is refusing us — but say what to check,
          // because "blocked" was the wrong answer for months.
          blocked = true;
          errors.push(
            `refused (HTTP ${res.status}) — the key is a published constant, so this is the `
            + 'endpoint rather than the credentials. Check whether /pc/v6/jobs has been retired.',
          );
          return;
        }
        errors.push(`${q}: ${res.error}`);
        return;
      }

      const list = res.data?.ergebnisliste || [];
      for (const j of list) if (j.referenznummer) out.push(toJob(j, { remoteHint: !pass.local }));

      const total = res.data?.maxErgebnisse ?? list.length;
      if (page * PAGE_SIZE >= total || !list.length) break;
    }
  });

  return { jobs: out, errors, skipped: blocked };
}
