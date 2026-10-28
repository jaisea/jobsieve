import { sha1, slug, canonicalTitle, canonicalCompany, stripHtml, parseDate } from './util.js';
import { resolveLocation, detectRemoteScope, detectWorkMode, EUROPE } from './geo.js';
import { detectLanguage, detectGermanRequirement, mentionsGermanAsLanguage, MIN_DESCRIPTION_CHARS } from './language.js';
import { mentionsWorkMode } from './geo.js';
import { detectProgrammingRequirement, isDeveloperTitle } from './requirements.js';

/**
 * Turn a raw source record into the canonical Job shape and enrich it with
 * everything the gates and scorer need. Source adapters only have to produce
 * the loose fields below; all derivation happens here, once, in one place.
 */
export function normalize(raw, profile) {
  const title = String(raw.title || '').trim();
  const company = String(raw.company || '').trim() || 'Unknown';
  const locationText = String(raw.location || '').trim();

  const descriptionHtml = raw.descriptionHtml || '';
  const descriptionText = (raw.descriptionText || stripHtml(descriptionHtml) || '').trim();

  // Everything the detectors read: title + location + body.
  const haystack = `${title} ${locationText} ${descriptionText}`;

  // Whether we actually have the posting, or just a teaser. Adzuna cuts every
  // description at 500 characters and job-alert emails carry none, so for most
  // results "no German requirement mentioned" says nothing about the real ad.
  // Every detector below needs to know that before concluding an absence.
  const descriptionComplete = descriptionText.length >= MIN_DESCRIPTION_CHARS;

  const language = detectLanguage(descriptionText || title);
  const german = detectGermanRequirement(haystack, language, {
    complete: descriptionComplete,
    chars: descriptionText.length,
  });

  const geo = resolveLocation(locationText, profile.location);

  // The POSTING outranks the aggregator's tag. JSearch tagged a Hannover job
  // "remote" while its text offered only "the possibility of home office"; the
  // tag won, the job scored 20/20 on location hundreds of km away, and reached the report
  // at 93. Detection runs first and the tag is the fallback for when the text
  // says nothing.
  //
  // And the tag is only a fallback while there is nothing to read. Once a full
  // advert is in hand, SILENCE ABOUT REMOTE IS EVIDENCE AGAINST IT — an employer
  // offering remote work says so. Letting the tag survive a description that
  // simply never mentions it put a Site Reliability Engineer at Bundesdruckerei
  // in the report at 81, marked "Remote (Germany)", scoring 20/20 on location,
  // hundreds of km away in Berlin. Its 1718-character description says exactly one thing
  // about where the work happens: "für den Standort Berlin".
  //
  // That job came from the Arbeitsagentur remote pass, whose hint means only
  // "matched a free-text search for remote somewhere the API can see". The
  // earlier reasoning — that enrichment would correct it — was wrong: detection
  // only overrides when the text positively states onsite, and most adverts
  // simply do not discuss it.
  const detected = detectWorkMode(haystack, locationText, title);
  const readable = (descriptionText || '').trim().length >= MIN_DESCRIPTION_CHARS;

  let workMode = detected || (readable ? null : raw.workMode);
  if (raw.isRemote === true && !workMode && !readable) workMode = 'remote';
  if (!workMode) workMode = geo.resolved ? 'onsite' : 'unknown';

  // Remote scope only matters for remote roles.
  //
  // An explicit statement in the text always wins. Failing that, the location
  // field anchors the role: "Remote — Bangalore, India" is an India role, not an
  // open one, and treating it as unscoped would rank it as a viable match.
  let remoteScope = null;
  if (workMode === 'remote') {
    const explicit = detectRemoteScope(haystack);
    const anchored = geo.country
      ? (geo.country === 'DE' ? 'DE'
        : EUROPE.has(geo.country) ? 'EU'
        : geo.country === 'US' ? 'US-only'
        : 'other-only')
      : null;

    // Precedence matters. "Globally" / "fully distributed" is usually company
    // boilerplate, so a concrete country in the location field outranks it —
    // otherwise a US-anchored role reads as open to anyone. An explicit
    // restriction or an explicit DE/EU statement still wins outright.
    if (explicit === 'US-only' || explicit === 'other-only') remoteScope = explicit;
    else if (explicit === 'DE' || explicit === 'EU') remoteScope = explicit;
    else if (anchored) remoteScope = anchored;
    else remoteScope = explicit;
  }

  // Skill-shape check: does this role really demand a developer? It reads the
  // description, so it runs once here.
  const prog = isDeveloperTitle(title)
    ? { level: 'required', evidence: `job title is a software-development role: "${title}"`, language: 'software development' }
    : detectProgrammingRequirement(descriptionText);

  const postedAt = parseDate(raw.postedAt);

  // Remote roles are fingerprinted on 'remote' rather than the location string:
  // the same posting shows up as "Remote", "Remote - Germany" and "Remote/EU"
  // across sources, which would otherwise defeat the duplicate check.
  const locKey = workMode === 'remote' ? 'remote' : slug(geo.city || locationText || '');

  // A recruiting agency posts on behalf of a client it does not name, so
  // `company` is the SAME STRING on every posting it will ever return — every
  // apriori advert reports "APRIORI – BUSINESS SOLUTIONS AG" and describes the
  // client only as "Unser Kunde ist ein inhabergeführtes Familienunternehmen".
  //
  // Hashing company|title|location there is not a weak key, it is a wrong one:
  // two different clients hiring a "DevOps Engineer (m/w/d)" in Frankfurt would
  // be ONE posting and the second would be silently swallowed.
  //
  // So when the employer is unknown, identity comes from the agency's own
  // posting id, which is exactly what that id is for. Title and location are
  // left out on purpose — location arrives from a later detail fetch and the
  // title gets edited, and either would move the fingerprint underneath a
  // decision, which is the drift `reconcile()` exists to clean up after.
  //
  // The cost is real and worth stating: this posting can never merge with the
  // same role listed under its true employer elsewhere, so it may appear twice.
  // That is unavoidable while the employer is a secret, and a visible duplicate
  // is a better failure than an invisible deletion.
  const fingerprint = raw.employerUnknown
    ? sha1([canonicalCompany(company), String(raw.sourceId)].join('|'))
    : sha1([canonicalCompany(company), canonicalTitle(title), locKey].join('|'));

  return {
    id: `${raw.source}:${raw.sourceId}`,
    fingerprint,
    source: raw.source,
    sourceLabel: raw.sourceLabel || raw.source,
    sourceId: String(raw.sourceId),

    title,
    company,
    companyUrl: raw.companyUrl || null,

    location: locationText || geo.city || (workMode === 'remote' ? 'Remote' : 'Unspecified'),
    city: geo.city,
    country: geo.country,
    // The gazetteer first, because it is the same measurement for every source.
    // But a source that computed the distance itself is better than nothing:
    // the Arbeitsagentur API returns `entfernung` from the searched location,
    // and it knows small towns the gazetteer does not — one village resolved to
    // null and was escalated on location for no reason.
    distanceKm: geo.distanceKm ?? (Number.isFinite(raw.distanceKm) ? raw.distanceKm : null),
    geoResolved: geo.resolved,

    workMode,
    remoteScope,

    postedAt: postedAt ? postedAt.toISOString() : null,
    salary: raw.salary || null,
    employmentType: raw.employmentType || null,

    // Carried through so the card, the archive and `npm run why` can all say
    // "this employer is an agency, not the place you would work". It also has
    // to survive into the archive, or a replay would fingerprint the posting
    // differently from the run that filed it.
    employerUnknown: raw.employerUnknown === true,
    agency: raw.agency || null,

    descriptionText,
    descriptionHtml,
    // Carried onto the job so the report can say plainly that a verdict rests
    // on a partial posting, rather than presenting it with the same confidence
    // as one derived from the whole thing.
    descriptionComplete,
    // The advert says it is no longer accepting applications, or its URL says
    // the posting is not there at all. Not a judgement about the role — the
    // door is simply shut. The evidence rides along so a 410 and a LinkedIn
    // closure read differently in the report without the gate having to know
    // which one it was.
    closed: Boolean(raw.closed),
    closedEvidence: raw.closedEvidence || null,
    applyUrl: raw.applyUrl,

    language,
    germanRequired: german.level,
    germanEvidence: german.evidence,
    // The posting talks about German as a language, yet no tier matched. Almost
    // always an unseen phrasing, so it escalates instead of passing silently.
    germanTalkUngraded: german.level === 'none' && mentionsGermanAsLanguage(descriptionText),

    /**
     * The advert discusses where the work happens, the rules did NOT conclude
     * remote, and the posting is too far to commute. Any one of those alone is
     * not interesting; together they are the case where a wrong answer costs a
     * job.
     *
     * Two were lost that way — dropped at 309km and 639km on adverts saying
     * "100% im Homeoffice möglich" and "die Möglichkeit, zu fast 100% im
     * Homeoffice zu arbeiten". Both full-time home office; both read as hybrid
     * because a hedge word sat beside the claim.
     *
     * Requires a READ advert. With no text there is nothing to hand the model,
     * and `workMode: 'unknown'` already escalates on its own.
     */
    workModeUngraded: workMode !== 'remote'
      && descriptionComplete
      && geo.distanceKm !== null
      && geo.distanceKm > (profile.location?.radiusKm ?? 70)
      && mentionsWorkMode(descriptionText),

    programmingRequired: prog.level,
    programmingEvidence: prog.evidence,
    programmingLanguage: prog.language,
  };
}
