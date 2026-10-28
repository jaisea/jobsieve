import { slug, canonicalTitle, daysSince, parseDate, hasPhrase, findPhrase } from './util.js';
import { gateGerman, germanGap } from './language.js';

/**
 * THREE-WAY CLASSIFICATION
 *
 * The rules layer answers only what it can answer *certainly*, and hands
 * everything else to the LLM adjudicator. Splitting it this way means:
 *   - certain drops and certain keeps cost nothing
 *   - the LLM only sees the genuinely ambiguous minority
 *   - a rules bug can no longer silently delete a good job, because anything
 *     the rules are unsure about escalates instead of being discarded
 *
 * Returns { decision: 'drop'|'keep'|'uncertain', reason, band, uncertainties[] }
 * where `uncertainties` names each thing the rules could not settle, so the
 * adjudication prompt can ask about exactly those and nothing else.
 */
export function classify(job, profile, opts = {}) {
  const certain = gate(job, profile, opts);
  const reasons = certain.reasons || [];

  // A certain drop is certain regardless of anything else. This is what makes
  // an uncertainty on an unrelated dimension unable to rescue a hard failure.
  if (!certain.keep && certain.certain) {
    return { decision: 'drop', reason: certain.reason, category: certain.category, band: null, uncertainties: [], reasons };
  }

  const uncertainties = findUncertainties(job, profile, certain);

  // A rules-drop that rests on an uncertain signal must escalate, not delete.
  if (!certain.keep) {
    if (uncertainties.length) {
      return { decision: 'uncertain', reason: certain.reason, category: certain.category, band: certain.band || 'main', uncertainties, reasons };
    }
    return { decision: 'drop', reason: certain.reason, category: certain.category, band: null, uncertainties: [], reasons };
  }

  if (uncertainties.length) {
    return { decision: 'uncertain', reason: null, band: certain.band, uncertainties, reasons };
  }
  return { decision: 'keep', reason: null, band: certain.band, uncertainties: [], reasons };
}

/**
 * Everything the rules layer knows it cannot settle. Each entry carries the
 * evidence the adjudicator needs, so the prompt never has to re-derive it.
 */
/**
 * Every line of the advert naming German or Deutsch, handed to the model.
 *
 * It used to send the FIRST match only, in an 80-character window either side.
 * That is a fragment, and a fragment loses the level: "Deutsch- und
 * Englischkenntnisse" without the "Verhandlungssichere" in front of it reads as
 * no requirement at all. A posting naming the language twice could also send
 * the weaker mention and hide the real one.
 *
 * Whole lines now, all of them, capped so a careers page cannot fill the prompt.
 */
const GERMAN_LINE_CAP = 6;
const GERMAN_WORD = /\bgerman\b|\bdeutsch(?!land)\w*/i;

function matchingLines(text, word, { cap = GERMAN_LINE_CAP, missing = 'the line could not be recovered' } = {}) {
  const lines = String(text || '')
    .split(/[\n\r\u2022\u00b7]+|(?<=[.!?])\s+/)
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter((l) => l && word.test(l));

  const seen = new Set();
  const out = [];
  for (const l of lines) {
    const k = l.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(l.length > 220 ? l.slice(0, 220) + '…' : l);
    if (out.length >= cap) break;
  }
  return out.join(' | ') || missing;
}

const germanLines = (text) =>
  matchingLines(text, GERMAN_WORD, { missing: 'German named, but the line could not be recovered' });

/**
 * Every line discussing where the work happens.
 *
 * The same escape hatch the German check has, for the same reason. Two postings
 * were dropped at 309km and 639km on adverts that said "100% im Homeoffice
 * möglich" and "die Möglichkeit, zu fast 100% im Homeoffice zu arbeiten" — both
 * full-time home office, both read as `hybrid` because a hedge word sat beside
 * the claim. Both were pulled back out of the reject pile by hand.
 *
 * Widening the patterns fixes the phrasings already seen and not the next one.
 * German has needed nine such widenings; work mode is a harder problem, because
 * "remote" is also a technical term, a perk bullet and a German hedge. So when
 * the advert plainly discusses the question and the rules are about to throw the
 * posting away on DISTANCE, the lines go to the model instead.
 *
 * A wrong keep costs a minute of reading. A wrong drop costs a job the user
 * would have wanted — which is exactly what happened twice.
 */
const WORKMODE_WORD = /\bremote\b|\bhome\s?office\b|\bhomeoffice\b|\bmobiles?\s+arbeit\w*\b|\btelearbeit\b|\bortsunabh\w*|\bhybrid\w*|\bvor ort\b|\bon[\s-]?site\b/i;

const workModeLines = (text) =>
  matchingLines(text, WORKMODE_WORD, { missing: 'remote work named, but the line could not be recovered' });

function findUncertainties(job, profile) {
  const out = [];
  const add = (kind, question, evidence) => out.push({ kind, question, evidence });

  // --- location ---
  // Only ambiguous when the country is unknown too — a resolved far-away
  // country is a certain drop handled in gateLocation().
  if (job.workMode !== 'remote' && !job.geoResolved && !job.country) {
    add('location', `Is "${job.location}" within ${profile.location.radiusKm}km of ${profile.location.city}, or otherwise commutable?`, job.location);
  }
  if (job.workMode === 'remote' && !job.remoteScope) {
    // Worded as "based in Germany", never "in <home city>". Asked the old way, the
    // model read "remote within Germany" as a restriction that failed to permit
    // the home city specifically, and dropped genuinely open roles on location.
    add('remote-scope', 'The candidate lives in Germany. Does this remote role accept someone based in Germany — i.e. is it open Germany-wide, EU-wide or worldwide? Only a restriction to a DIFFERENT country or an incompatible timezone rules it out. It does not need to mention any particular city.', job.location);
  }
  if (job.workMode === 'unknown') {
    add('work-mode', 'Is this role remote, hybrid, or onsite — and if onsite, where?', job.location);
  }

  // --- German ---
  // The description never reached us in full, so nothing can be concluded from
  // the fact that it does not mention German. Ask about the real posting.
  if (job.germanRequired === 'unknown') {
    add('german', `The description available is truncated and never mentions language. Judge from the title, company and location: is this role likely to require German beyond ${profile.languages?.germanLevel || 'A2'}?`, job.germanEvidence);
  }

  // Only escalate when the requirement was GUESSED. A quoted "gute
  // Deutschkenntnisse" is settled: the rules drop it without spending a call.
  const germanInferred = /posting written in German/.test(job.germanEvidence || '');
  if (job.germanRequired === 'conversational' && germanInferred) {
    add('german', `Does this posting actually require conversational German (B2), or is German optional? Candidate is ${profile.languages?.germanLevel || 'A2'} working toward ${profile.languages?.germanTarget || 'B1'}.`, job.germanEvidence);
  }
  // Graded from the posting's language rather than an explicit phrase — a guess.
  if (job.germanRequired === 'required' && /posting written in German/.test(job.germanEvidence || '')) {
    add('german', 'The posting is in German but never states a German requirement. Does the ROLE actually require German, or is it a German-language ad for an English-speaking team?', 'no explicit language requirement found');
  }

  // The tiers found nothing but the posting plainly discusses the language.
  // Without this the rules answer "none" with full confidence, and settledFacts
  // then tells the model German is settled — so nothing ever re-reads it.
  if (job.germanTalkUngraded) {
    add(
      'german',
      `The rules could not grade this. Below is every line of the advert naming German or Deutsch. Judge only what those lines say: is German required for the ROLE, and roughly what level? The candidate is ${profile.languages?.germanLevel || 'A2'} working toward ${profile.languages?.germanTarget || 'B1'}. "A plus", "nice to have" or "an advantage" is NOT a requirement.`,
      germanLines(job.descriptionText),
    );
  }

  // The advert discusses where the work happens, and the rules are about to
  // discard it for being too far away. Ask before throwing it out.
  //
  // Gated on the drop actually being about distance: a remote posting inside
  // the radius needs no opinion, and neither does one whose text never raises
  // the question. Without the second condition every far posting would escalate
  // and the model would be asked about adverts that say nothing.
  if (job.workModeUngraded) {
    add(
      'work-mode',
      'The rules could not settle where this work happens. Below is every line of the advert '
      + 'naming remote, home office, hybrid or on-site. Judge only what those lines say: can this '
      + 'role be done from home essentially full time? "Occasional home office", "2 days a week" '
      + 'or a perk list entry is NOT a remote role; "100% im Homeoffice", "fully remote" and '
      + '"remote-first" are.',
      workModeLines(job.descriptionText),
    );
  }

  // --- title relevance ---
  // One question about the title, worded for what made it uncertain.
  const conflict = titleConflict(job.title, profile);
  const excluded = excludeVerdict(job.title, profile);
  const field = roleDescription(profile);
  if (conflict) {
    add('title', `The title "${job.title}" mixes "${conflict.off}" with wording from the target field ("${conflict.dom}"). Is this a ${field} role, or is it a ${conflict.off} role?`, job.title);
  } else if (excluded?.soft) {
    add('title', `The title "${job.title}" contains "${excluded.term}", which is normally not wanted, but also names "${excluded.domain}". Is it a ${field} role, or a ${excluded.term} role?`, job.title);
  } else if (isTitleNearMiss(job.title, profile) && !isExactTarget(job.title, profile)) {
    add('title', `Is "${job.title}" effectively one of: ${(profile.targetTitles?.strong || []).join(', ')} — the same job under a different name?`, job.title);
  }

  return out;
}

function isExactTarget(title, profile) {
  const tokens = new Set(canonicalTitle(expandGerman(title)).split(' ').filter(Boolean));
  return [...profile.targetTitles.strong, ...profile.targetTitles.good].some((x) => {
    const toks = canonicalTitle(x).split(' ').filter(Boolean);
    return toks.length > 0 && toks.every((t) => tokens.has(t));
  });
}

/**
 * The gates, in the order they run. Cheap checks first, so an obvious
 * non-match never reaches the expensive ones.
 *
 * Declared as data rather than a straight-line function so `explain()` can run
 * every check and `gate()` can stop at the first failure — from ONE definition.
 * When `why` and the pipeline disagree, the explanation is worthless, so there
 * must not be a second copy of this logic anywhere.
 *
 * Each check returns { keep, certain, band, reason, category }.
 * `certain: true` means the rules are confident enough to decide alone.
 */
/**
 * Employment type, which every source reports and nothing read.
 *
 * A DevOps Engineer at Hays arrived tagged `employmentType: "Teilzeit"` and sat
 * in the queue as a normal full-time role. The field was captured at normalize,
 * stored in the archive and rendered as a badge on the card — and no gate ever
 * looked at it. `filters.excludeEmploymentTypes` existed in profile.json,
 * empty, read by nothing: the same dead-config shape as workRights.switzerland.
 *
 * The values are a mess because every source spells it differently. Across the
 * archive: Vollzeit, Full Time, Full-time, FullTime, full_time, Teilzeit, Part
 * time, parttime, and compounds like "Student, Working student, Part time".
 *
 * The trap is "FULL OR PART TIME", which appears in ten variants and means both
 * are on offer. So the test is not "does it say part-time" but "does it say
 * part-time AND NOT full-time" — otherwise "Experienced, Permanent, Full or
 * part time" is discarded as a part-time role.
 */
const PART_TIME = /\b(teilzeit|part[\s_/-]?time|parttime|minijob|aushilfe|nebenjob|geringf(ue|ü)gig)\b/i;
const FULL_TIME = /\b(vollzeit|full[\s_/-]?time|fulltime|full or part|part[\s_/-]*\/[\s_/-]*full)\b/i;

/**
 * Canonical categories, so profile.json names a concept rather than a spelling.
 *
 * The word lists were measured against 10,027 stored postings and were short: "Contractor"
 * matched `contract\b` no better than it matches "contracts" (the word boundary stops it),
 * so "Contractor", "Freelancer", "Interim", "Trainee", "Praktikant", "Aushilfe" and
 * "Arbeitnehmerüberlassung" all came back as NO kind at all. Nothing was lost yet, because
 * only `part-time` is excluded — but excluding `contract` would have silently missed them.
 *
 * `title` is a fallback for the 56% of postings that state no type at all. It is consulted
 * ONLY when the field is empty (a stated "Vollzeit" is trusted over a title) and only for
 * part-time, which is the one kind a title states plainly ("... in Teilzeit"). The
 * full-time guard still applies, so "Vollzeit oder Teilzeit" is not part-time.
 */
export function employmentKinds(raw, title = '') {
  const field = String(raw || '');
  const t = field.trim() ? field : String(title || '');
  if (!t.trim()) return [];
  const kinds = [];
  if (PART_TIME.test(t) && !FULL_TIME.test(t)) kinds.push('part-time');
  if (!field.trim()) return kinds;   // a title says "Teilzeit" plainly; it does not state the rest
  // "Permanent contract" is the opposite of a contract role, and the bare word `contract` used
  // to match it. Only the unambiguous words count when a permanent marker is present.
  const permanent = /\b(permanent|unbefristet\w*|festanstellung|open[\s-]?ended)\b/i.test(t);
  if (/\b(freelanc\w*|contractor\w*|auftragnehmer\w*|selbst(ae|ä)ndig\w*|interim|freiberuf\w*|werkvertrag|honorar\w*)\b/i.test(t)
    || (!permanent && /\bcontract\b/i.test(t))) kinds.push('contract');
  if (/\b(intern|internship|praktik\w*|werkstudent\w*|working student|trainee\w*|azubi|auszubildende\w*|ausbildung|duales studium|abschlussarbeit|thesis)\b/i.test(t)) kinds.push('internship');
  if (/\b(temporary|befristet\w*|fixed[\s-]?term|zeitarbeit|leiharbeit|arbeitnehmer(ue|ü)berlassung)\b/i.test(t)) kinds.push('temporary');
  return kinds;
}

/**
 * GERMAN TITLES.
 *
 * The title vocabularies below are English, and German writes a role as ONE word:
 * "Systemadministrator", "Netzwerkadministrator", "Cloud Architekt", "Infrastrukturarchitekt".
 * Whole-word matching cannot see "system administrator" inside "systemadministrator", so
 * "Systemadministrator Linux (m/w/d) | in München" — a Linux sysadmin role in the
 * home city, a term the domain list HAS in English — was a certain drop as "not a target role".
 * Measured over 10,027 stored postings: 89 distinct dropped titles carry such a compound.
 *
 * So the title is expanded before it is matched: a compound whose HEAD is a role noun is
 * split ("systemadministrator" -> "system administrator") and the heads are named in English
 * (architekt -> architect, ingenieur -> engineer, berater -> consultant). Only the role HEADS
 * are mapped. "Infrastruktur" is deliberately left alone here: mapping it would make
 * "Kapazitätsmanager Fahrplan & Infrastruktur" (a railway role) match the domain list. The
 * near-miss check, which only asks a question, reads the German infrastructure words instead.
 */
const COMPOUND_HEADS = 'administrator|administratorin|architekt|architektin|architekten|ingenieur|ingenieurin|spezialist|spezialistin|berater|beraterin|experte|expertin|techniker|technikerin';
const GERMAN_HEADS = {
  architekt: 'architect', architektin: 'architect', architekten: 'architect',
  administratorin: 'administrator', ingenieur: 'engineer', ingenieurin: 'engineer',
  spezialist: 'specialist', spezialistin: 'specialist', berater: 'consultant', beraterin: 'consultant',
  experte: 'expert', expertin: 'expert', techniker: 'technician', technikerin: 'technician',
};
const COMPOUND_SPLIT = new RegExp('([a-z]{2,})(' + COMPOUND_HEADS + ')\\b', 'g');
const HEAD_WORDS = new RegExp('\\b(' + Object.keys(GERMAN_HEADS).join('|') + ')\\b', 'g');

export function expandGerman(title = '') {
  const t = String(title).toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .replace(COMPOUND_SPLIT, '$1 $2');
  return t.replace(HEAD_WORDS, (m) => GERMAN_HEADS[m]);
}

/** Does the title name the target field, however it is spelled? */
const titleDomain = (title, profile) => findPhrase(slug(expandGerman(title)), relevanceOf(profile).domainTerms);

/**
 * A title that names BOTH a different specialisation and the infrastructure domain.
 *
 * The off-track list was tested before the domain list, so the off-track word always won:
 * 16 titles per fetch, among them "Site Reliability Engineer in Hardware Infrastructure",
 * "Fullstack-Entwickler mit DevOps- und OPS-Fokus" and "Senior Frontend Platform Engineer",
 * were certain drops on one stray word. Neither reading is certain, so it is a question.
 */
export function titleConflict(title, profile) {
  const x = slug(expandGerman(title));
  const { domainTerms, offTrack } = relevanceOf(profile);
  const off = findPhrase(x, offTrack);
  const dom = off ? findPhrase(x, domainTerms) : null;
  return off && dom ? { off, dom } : null;
}

/**
 * What the exclude list says about a title: nothing, a certain drop, or a question.
 *
 * Two kinds of term sit in one list. SENIORITY and employment terms (junior, intern,
 * werkstudent, trainee) say what the job IS and stay certain. FUNCTION terms (sales,
 * product manager, support engineer, solution engineer, recruiter) say what the job is
 * ABOUT, and a title can use one beside real infrastructure wording: "Cloud Solution
 * Engineer/Cloud Architect/Cloud Consultant", "DevOps Support Engineer". About 21 titles
 * per fetch. Those become a question when the title also names the domain.
 *
 * German compounds hide a banned word inside a longer one ("Pflichtpraktikum"), and
 * whole-word matching cannot see it. A short list of roots, which are safe to match inside
 * a word because nothing English contains them, covers that.
 *
 * Both lists are overridable in profile.json (targetTitles.excludeUnlessDomain,
 * targetTitles.excludeCompounds); absent, these defaults apply.
 */
const DEFAULT_SOFT_EXCLUDE = ['sales', 'product manager', 'program manager', 'support engineer', 'solution engineer', 'recruiter'];
const DEFAULT_EXCLUDE_COMPOUNDS = ['praktik', 'werkstudent', 'ausbildung', 'auszubildend', 'abschlussarbeit'];

export function excludeVerdict(title, profile) {
  const t = profile.targetTitles || {};
  const x = slug(expandGerman(title));
  const hits = (t.exclude || []).filter((term) => hasPhrase(x, term));
  for (const root of t.excludeCompounds ?? DEFAULT_EXCLUDE_COMPOUNDS) {
    if (x.includes(slug(root))) hits.push(root);
  }
  if (!hits.length) return null;

  const soft = new Set((t.excludeUnlessDomain ?? DEFAULT_SOFT_EXCLUDE).map(slug));
  const hard = hits.find((h) => !soft.has(slug(h)));
  if (hard) return { term: hard, soft: false };
  const domain = titleDomain(title, profile);
  return domain ? { term: hits[0], soft: true, domain } : { term: hits[0], soft: false };
}

/**
 * The age limit that applies to this posting.
 *
 * "Older than 45 days" is a guess that a posting has closed, and it is a good guess for an
 * aggregator, which keeps listings long after the employer removed them. It is a poor one
 * for the employer's OWN board: a posting still listed there today is open, however long it
 * has been. 51% of what the boards return (3,095 of 6,063) was over the limit, 242 of those
 * with a title that passes every title gate, and 802 archived rejections were dropped on age
 * alone. Those sources get a longer limit; scoring already gives an old posting no freshness
 * points, so it ranks low rather than vanishing.
 *
 * Overridable in profile.json (filters.authoritativeSources, filters.maxAgeDaysAuthoritative).
 */
const DEFAULT_AUTHORITATIVE = ['ats', 'workday', 'personio', 'teamtailor', 'beesite', 'careersites', 'bwi'];
const DEFAULT_AUTHORITATIVE_MAX_AGE = 180;

export function ageLimit(job, profile) {
  const f = profile.filters || {};
  const authoritative = f.authoritativeSources ?? DEFAULT_AUTHORITATIVE;
  if (authoritative.includes(job.source)) {
    return Math.max(f.maxAgeDaysAuthoritative ?? DEFAULT_AUTHORITATIVE_MAX_AGE, f.maxAgeDays);
  }
  return f.maxAgeDays;
}

export const CHECKS = [
  {
    id: 'closed',
    phase: 'liveness',
    label: 'Still open',
    // Cheapest possible certainty: the advert itself says the door is shut.
    // Runs before everything else because no other question matters once it is.
    run: (job) => (job.closed
      ? drop(job.closedEvidence || 'no longer accepting applications', 'closed')
      : keep()),
  },
  {
    id: 'title-exclude',
    phase: 'title',
    label: 'Excluded title term',
    // Whole-word only. Substring matching here dropped "Internal Platform
    // Engineer" on "intern" and "Salesforce Engineer" on "sales".
    run: (job, profile) => {
      const v = excludeVerdict(job.title, profile);
      if (!v) return keep();
      if (v.soft) return softDrop(`excluded title term: ${v.term} — but the title also names ${v.domain}`, 'role');
      return drop(`excluded title term: ${v.term}`, 'role');
    },
  },
  {
    id: 'employment-type',
    phase: 'rules',
    label: 'Employment type',
    // As cheap and as certain as the title check: one field, no network, and
    // the source has stated it outright. Empty config means the gate is off,
    // so this changes nothing for anyone who has not asked for it.
    run: (job, profile) => {
      const unwanted = profile.filters?.excludeEmploymentTypes || [];
      if (!unwanted.length) return keep();
      const hit = employmentKinds(job.employmentType, job.title).find((k) => unwanted.includes(k));
      if (!hit) return keep();
      const where = String(job.employmentType || '').trim() ? `stated as "${job.employmentType}"` : 'stated in the title';
      return drop(`${hit} role (${where})`, 'employment');
    },
  },
  {
    id: 'age',
    phase: 'rules',
    label: 'Posting age',
    run: (job, profile) => {
      const age = daysSince(parseDate(job.postedAt));
      const limit = ageLimit(job, profile);
      if (age !== null && age > limit) {
        return drop(`older than ${limit}d (${Math.round(age)}d)`, 'age');
      }
      return keep();
    },
  },
  {
    id: 'relevance',
    phase: 'title',
    label: 'Target role',
    // Broad sources (Remotive's software-dev feed, RemoteOK) return every kind
    // of engineering role. Without this, "Senior Frontend Engineer (Vue)"
    // survives on location and freshness points alone.
    run: gateRelevance,
  },
  {
    id: 'location',
    phase: 'rules',
    label: 'Location / work mode',
    run: gateLocation,
  },
  // The `programming` and `stack` ("names your tools") gates were removed on
  // 2026-10-20 on request: Python is not a must-have in most adverts that
  // mention it, and the pair were dropping a good number of postings worth
  // seeing. Their categories stay in REJECT_CATEGORIES so reasons already on
  // file still read.
  {
    id: 'german',
    phase: 'rules',
    label: 'German requirement',
    // Also the check that assigns the band: a B2 posting is a Stretch card
    // rather than a main result when stretchB2 is on.
    run: (job, profile, { includeGerman = false } = {}) => {
      const g = gateGerman(job.germanRequired, profile.languages.germanLevel, {
        stretchB2: profile.languages.stretchB2 === true,
      });
      if (g === 'hide' && !includeGerman) {
        // Name the level and the distance to it. "German required (have A2)"
        // lumped B2 and near-native together, so there was no way to tell a
        // near-miss from an impossible one.
        const gap = germanGap(job.germanRequired, job.germanEvidence, profile.languages.germanLevel);
        const r = gap ? gap.text : `German ${job.germanRequired} (have ${profile.languages.germanLevel})`;
        // A requirement QUOTED from the posting is a fact the rules can act on
        // alone. One merely INFERRED from the posting being in German is a
        // guess, so it escalates instead — a German-language ad may still be
        // an English-speaking workplace.
        const inferred = /posting written in German/.test(job.germanEvidence || '');
        return inferred ? softDrop(r, 'language') : drop(r, 'language');
      }
      return { keep: true, certain: true, band: g === 'stretch' ? 'stretch' : 'main', reason: null };
    },
  },
];

/**
 * Cheap gates, run before scoring. Stops at the first failure so the CLI can
 * report *why* something was dropped — a silent filter is impossible to tune.
 *
 * Verdict: { keep, certain, band: 'main'|'stretch', reason }
 */
/**
 * The order the pipeline runs them in. `title` needs only the posting's title,
 * `liveness` needs the advert to have been fetched, `rules` needs its text.
 * Splitting the walk this way is what lets the advert be READ before the rules
 * judge it — the gates used to run first and spend most of their time on
 * teasers, so "no German requirement mentioned" meant nothing.
 */
export const PHASES = ['title', 'liveness', 'rules'];

/**
 * Run the gates once and describe everything that happened.
 *
 * `gate()` and `explain()` used to walk CHECKS separately, which is how they
 * came to disagree about which gate was decisive. One walk, two projections.
 *
 * `phases` restricts the walk; omitting it runs all nine, which is what
 * `npm run why` and every existing caller want.
 */
function evaluate(job, profile, { phases = null, ...opts } = {}) {
  const checks = [];
  let band = 'main';

  for (const check of CHECKS) {
    if (phases && !phases.includes(check.phase)) continue;
    const v = check.run(job, profile, opts);
    checks.push({ id: check.id, label: check.label, phase: check.phase, ...v });
    if (v.keep && v.band) band = v.band;
  }

  const failed = checks.filter((c) => !c.keep);
  return { checks, band, hard: failed.filter((c) => c.certain), soft: failed.filter((c) => !c.certain) };
}

/**
 * The verdict, plus every reason that applied rather than only the first.
 *
 * The walk no longer short-circuits. It used to return on the first certain
 * drop and keep only the first soft one (`soft = soft || v`), so a posting
 * dropped on its title never revealed that it was ALSO 8,000km away and
 * AWS-only. That is the difference between "this rule is pulling its weight"
 * and "this rule got there first", which is the question the reject archive
 * exists to answer.
 *
 * The primary verdict is unchanged: the first CERTAIN drop in array order,
 * else the first soft one. `hard[0] || soft[0]` is exactly what the
 * short-circuiting loop returned, computed without short-circuiting — verified
 * against all 10,403 archived postings, every one identical. Array order still
 * decides which reason owns the verdict, which is why CHECKS is not reordered
 * to match the phases: a closed posting must archive as `closed`, not as
 * "639km away", and rejects.js clears reviewedAt when a category changes.
 *
 * An uncertainty on one dimension cannot rescue a job that hard-fails on
 * another — `hard[0]` wins over `soft[0]` here, and classify() returns on a
 * certain drop before it ever looks at the uncertainties.
 */
export function gate(job, profile, opts = {}) {
  const e = evaluate(job, profile, opts);
  const reasons = [...e.hard, ...e.soft].map(({ id, phase, reason, category, certain }) =>
    ({ id, phase, reason, category, certain }));

  const owner = e.hard[0] || e.soft[0];
  if (owner) {
    const { checks, ...rest } = owner;
    return { ...rest, band: null, reasons };
  }
  return { keep: true, certain: true, band: e.band, reason: null, reasons: [] };
}

/**
 * Every gate's verdict, not just the one that stopped the posting.
 *
 * `gate()` reports one reason, so a job dropped on its title never reveals
 * whether it would also have failed on location — which is exactly what you
 * need when deciding whether a rule is pulling its weight or firing on the
 * wrong things.
 *
 * `stoppedAt` names the gate that OWNS the verdict, which is the first certain
 * drop rather than the first failure of any kind. It used to be the latter, so
 * a posting softly off-target and certainly out of reach reported its title as
 * decisive when location was what actually settled it.
 */
export function explain(job, profile, opts = {}) {
  const e = evaluate(job, profile, opts);
  return {
    checks: e.checks,
    stoppedAt: (e.hard[0] || e.soft[0])?.id ?? null,
    uncertainties: findUncertainties(job, profile),
    verdict: classify(job, profile, opts),
  };
}

/** Countries close enough to the home city that an onsite role could be viable. */
const COMMUTABLE_COUNTRIES = new Set(['DE', 'CH', 'FR']);

/**
 * The role vocabulary is the USER'S field, not the tool's, so it lives in
 * `profile.relevance`:
 *
 *   domainTerms       words that put a title in the target field ("devops", "frontend").
 *                     A title naming one is kept even when it matches no target title.
 *   offTrack          specialisations that are clearly another track. A title naming one
 *                     is a certain drop — unless it ALSO names a domain term, which makes it
 *                     a question rather than a verdict (see titleConflict()).
 *   nearMissTerms     field words that, sitting within two words of a role noun
 *                     ("Cloud Operations Specialist"), make a title worth asking about.
 *   nearMissPatterns  regex strings for near misses a word list cannot express.
 *   roleDescription   how the model is told what the field is ("frontend / full-stack web").
 *
 * All optional. With none of them, relevance rests on targetTitles alone. See the two
 * example profiles in config/ for a full-stack and a DevOps vocabulary.
 */
const relevanceCache = new WeakMap();
function relevanceOf(profile) {
  if (!profile || typeof profile !== 'object') return relevanceOf({});
  let r = relevanceCache.get(profile);
  if (r) return r;
  const cfg = profile.relevance || {};
  const near = (cfg.nearMissTerms || []).map((x) => slug(x).replace(/\s+/g, '\\s+')).filter(Boolean).join('|');
  const role = ROLE_NOUNS.join('|');
  r = {
    domainTerms: cfg.domainTerms || [],
    offTrack: cfg.offTrack || [],
    nearMiss: near
      ? [new RegExp(`(^|\\s)(${near})(\\s+\\w+){0,2}\\s+(${role})($|\\s)`),
        new RegExp(`(^|\\s)(${role})(\\s+\\w+){0,2}\\s+(${near})($|\\s)`)]
      : [],
    patterns: (cfg.nearMissPatterns || []).map((x) => new RegExp(x)),
  };
  relevanceCache.set(profile, r);
  return r;
}

/** How a question to the model names the field. */
const roleDescription = (profile) => profile?.relevance?.roleDescription || 'target';

/**
 * The TITLE decides relevance, not the body.
 *
 * A body-based fallback was tried and removed: job ads at cloud companies
 * mention Kubernetes and Terraform regardless of the role, so "APAC
 * Partnerships Lead" and "Manager, People Analytics" sailed through it.
 */
function gateRelevance(job, profile) {
  const expanded = expandGerman(job.title);
  const title = slug(expanded);
  const titleTokens = new Set(canonicalTitle(expanded).split(' ').filter(Boolean));

  const { domainTerms, offTrack: offList } = relevanceOf(profile);
  const offTrack = findPhrase(title, offList);
  const domain = findPhrase(title, domainTerms);
  // Both: a question, not a verdict. See titleConflict().
  if (offTrack && domain) return softDrop(`title mixes "${offTrack}" with "${domain}"`, 'role');
  if (offTrack) return drop(`off-track specialisation: ${offTrack}`, 'role');

  if (domain) return keep();

  // Any configured target title, matched token-subset (same rule as scoring).
  const targets = [...profile.targetTitles.strong, ...profile.targetTitles.good];
  const matched = targets.some((x) => {
    const toks = canonicalTitle(x).split(' ').filter(Boolean);
    return toks.length > 0 && toks.every((tok) => titleTokens.has(tok));
  });
  if (matched) return keep();

  // Near-miss: field vocabulary in the title but no exact target match.
  // "Cloud Operations Specialist" / "IT Infrastructure Manager" land here — the
  // rules cannot tell those from genuinely unrelated roles, so they escalate.
  if (isTitleNearMiss(job.title, profile)) return softDrop('title is near, but not on, the target list', 'role');

  return drop('title is not a target role', 'role');
}

/**
 * Near-miss detection needs BOTH a field noun (`relevance.nearMissTerms`) and a
 * role noun. Requiring only the first produced 254 escalations from 4,289
 * postings: generic words like "operations" and "systems" pulled in "People
 * Operations Specialist" and "Casual Rugby Systems Operator". Keep words that
 * common out of nearMissTerms for exactly that reason.
 */
const ROLE_NOUNS = [
  'engineer', 'architect', 'administrator', 'admin', 'specialist', 'consultant',
  'lead', 'manager', 'developer', 'ingenieur', 'technician', 'analyst', 'expert',
];

/**
 * The field noun must sit within two words of the role noun, so the two are
 * actually one job title. Merely co-occurring anywhere in the string matched
 * "Senior Bid & Pursuit Manager / Proposal Manager – Cloud, Data & AI
 * Consulting" — a sales role — on `cloud` + `manager`.
 */
export function isTitleNearMiss(title = '', profile = {}) {
  const t = slug(expandGerman(title));
  const { nearMiss, patterns } = relevanceOf(profile);
  return nearMiss.some((re) => re.test(t)) || patterns.some((re) => re.test(t));
}

/**
 * Place names that mean "near enough" when the gazetteer cannot resolve a
 * location string.
 *
 * This was a hardcoded list — the country, the home city, its region and its
 * neighbours — which is one user's surroundings written into a gate. A
 * user in Hamburg got the original home city treated as local and Hamburg not,
 * so an unresolvable Hamburg address was dropped as a far-away office.
 *
 * Built from the profile now: the home city (and each word of it, since a
 * two-part name such as "Frankfurt am Main" appears in adverts as either half), the country, and
 * anything in `location.localTerms` for the region and neighbours the
 * gazetteer misses. Nothing here decides on its own — a match only keeps a
 * posting whose distance could not be computed.
 */
function localTerms(profile) {
  const { city = '', country = '', localTerms: extra = [] } = profile.location || {};
  const words = slug(city).split(' ').filter((w) => w.length > 3 && !STOP_PARTICLES.has(w));
  return [...new Set([
    slug(city),
    ...words,
    ...COUNTRY_WORDS[country] || [],
    ...extra.map(slug),
  ].filter(Boolean))];
}

/** "im", "am", "an der" — the joins in German place names carry no signal. */
const STOP_PARTICLES = new Set(['im', 'am', 'an', 'der', 'die', 'das', 'bei', 'auf', 'vor']);

/** A posting says the country in its own language as often as in English. */
const COUNTRY_WORDS = {
  DE: ['germany', 'deutschland'],
  CH: ['switzerland', 'schweiz', 'suisse'],
  AT: ['austria', 'osterreich'],
  FR: ['france'],
  NL: ['netherlands', 'nederland'],
};

function gateLocation(job, profile) {
  const { radiusKm } = profile.location;

  if (job.workMode === 'remote') {
    const scope = job.remoteScope;
    if (scope && profile.filters.excludeRemoteScopes.includes(scope)) {
      return drop(`remote but ${scope}`, 'location');
    }
    if (scope === 'other-only') return drop('remote but restricted to another region', 'location');
    // Unknown scope is kept: most postings simply do not say, and dropping them
    // would discard a large share of genuinely open remote roles.
    return keep();
  }

  // onsite / hybrid / unknown -> must be commutable
  if (job.distanceKm !== null && job.distanceKm > radiusKm) {
    const far = `${job.city ?? job.location} is ${job.distanceKm}km away (max ${radiusKm}km)`;

    // "Onsite" may be an ASSUMPTION rather than a finding. With no description,
    // normalize falls back to `geo.resolved ? 'onsite' : 'unknown'` — so a
    // posting with no text in a city beyond the radius is called onsite and dropped,
    // even if the advert says fully remote. eFinancialCareers and the alert
    // emails carry no description at all, so this is the common case for them.
    //
    // Measured: of 20 German postings dropped this way and then actually read,
    // FIVE were remote — a Senior DevOps Engineer, a Senior Cloud Engineer, two
    // SREs and one offering "bis zu 100%". A quarter of the class, and exactly
    // the roles worth having.
    //
    // So it is a soft drop while the advert is unread and the country is one
    // where a remote role would be reachable. The posting then survives to
    // enrich, gets its text, and is re-gated on what it actually says. A
    // resolved city in a far country stays a certain drop — a US onsite role
    // does not become commutable by being read.
    const unread = job.descriptionComplete === false;
    const couldBeRemote = !job.country || COMMUTABLE_COUNTRIES.has(job.country);
    if (unread && couldBeRemote) return softDrop(`${far} — and the advert has not been read`, 'location');

    // READ, and the advert plainly discusses where the work happens, but the
    // rules did not conclude remote. That is a judgement call, and a certain
    // drop here throws the posting away without asking anyone.
    //
    // Two were lost exactly this way — 309km and 639km, on adverts saying "100%
    // im Homeoffice möglich" and "die Möglichkeit, zu fast 100% im Homeoffice
    // zu arbeiten". Both full-time home office; both read as `hybrid` because a
    // hedge word sat beside the claim; both pulled back out of the reject pile
    // by hand.
    //
    // It has to be HERE rather than in findUncertainties, because classify()
    // returns on a certain drop before it looks at uncertainties at all — an
    // escalation added there could never fire for a posting this gate had
    // already settled.
    //
    // The same shape as an inferred German requirement: the rules may decide
    // when they are certain, and a guess escalates rather than deleting.
    if (job.workModeUngraded && couldBeRemote) {
      return softDrop(`${far} — but the advert discusses working from home`, 'location');
    }

    return drop(far, 'location');
  }

  if (job.distanceKm === null) {
    // Location string we could not resolve. Keep only if it at least smells local
    // or German; otherwise it is almost always a far-away office.
    const s = slug(`${job.location} ${job.city ?? ''}`);
    if (!s || s === 'unspecified') return softDrop('no location given for a non-remote role', 'location');
    if (findPhrase(s, localTerms(profile))) return keep();

    // The town is unknown to the gazetteer but the COUNTRY resolved. If that
    // country is nowhere near the home city, the rules are certain — no need to
    // spend an adjudication asking whether Austin, Texas is commutable.
    if (job.country && !COMMUTABLE_COUNTRIES.has(job.country)) {
      return drop(`onsite in ${job.country} — not commutable from ${profile.location.city}`, 'location');
    }

    // Country unknown too: genuinely ambiguous, escalate.
    return softDrop(`unresolved location: ${job.location}`, 'location');
  }

  return keep();
}

/**
 * Why a posting was rejected, for the run history. Assigned at the point of
 * decision rather than parsed back out of the reason text, so rewording a
 * message can never silently move jobs between buckets.
 */
export const REJECT_CATEGORIES = {
  language: 'German requirement',
  location: 'Location / work mode',
  programming: 'Programming required',
  aws: 'AWS-centric',
  role: 'Not a target role',
  employment: 'Wrong employment type',
  stack: 'Does not name your tools',
  age: 'Too old',
  closed: 'No longer accepting applications',
  score: 'Scored too low',
  advert: 'I read it and did not want it',
  other: 'Other',
};

/**
 * What the "Not for me" picker offers, which is NOT the list of gates.
 *
 * The two were the same list for the life of the project, and the reason given
 * was good: the reason you give and the reason the tool gave have to be the
 * same vocabulary or they cannot be compared. That still holds for what is
 * STORED. It does not hold for what is shown on a button.
 *
 * Eleven buttons ask you to do the gates' filing. Picking between "Programming
 * required", "AWS-centric" and "Does not name your tools" is a question about
 * which detector to blame, and the honest answer at the moment of clicking is
 * usually "the skills do not line up". Six buttons ask what you actually know.
 *
 * **The GATES are deliberately unchanged**, and this was measured rather than
 * assumed:
 *
 *   - `rejects.js` clears `reviewedAt` when an entry's category changes, so
 *     renaming or merging gate categories would flood thousands of already
 *     reviewed rejections back into the review list.
 *   - `CHECKS` array order decides which reason OWNS a verdict, so merging
 *     gates would move the primary category on thousands of archived postings.
 *   - Grouping the gates buys NOTHING in the audit. Replaying all 186 reasoned
 *     rejections, comparing at group level instead of category level moved
 *     **zero** from "the tool missed it" to "the tool had already flagged it".
 *
 * So this is a presentation layer over the same vocabulary, and the old keys
 * keep resolving: 186 rejections on file are stored as `aws`, `advert`, `age`
 * and the rest, and every one of them still reads correctly.
 *
 * `age` and `score` are gate categories with no button. A posting too old or
 * too low-scoring was already dropped by the gate, so one reaching your review
 * is one the gate did NOT catch that way — and neither has ever been picked.
 *
 * **What the skills merge costs, stated plainly.** Those three keys currently
 * split as aws 14 / programming 8 / stack 1, and 13 of the 14 have
 * `awsPrimary: false` — the AWS detector missed them. Merged, the
 * stored reason no longer says AWS specifically. Deriving
 * the specific gate back from the posting's signals was tried and does not
 * work: it resolves 9 of 23 and gets one of those 9 wrong, because these are by
 * construction the postings where no skill gate fired.
 */
export const PICKER_GROUPS = [
  { key: 'language', label: 'German requirement', gates: ['language'] },
  { key: 'location', label: 'Location / work mode', gates: ['location', 'employment'] },
  { key: 'skills', label: 'Skill gaps', gates: ['programming', 'aws', 'stack'] },
  { key: 'role', label: 'Not a target role', gates: ['role'] },
  { key: 'closed', label: 'No longer accepting applications', gates: ['closed'] },
  // Both of these were already judgement calls counted together, so merging
  // them loses nothing. `other` is also what a gate falls back to when it names
  // no category, which is why it is listed here rather than dropped.
  { key: 'notImpressed', label: 'I am not impressed', gates: ['advert', 'other'] },
];

/**
 * Rules are confident: decide alone, no LLM call.
 * `band: null` deliberately — only the German check assigns a band, so a check
 * added before it can never overwrite the Stretch classification.
 */
const keep = () => ({ keep: true, certain: true, band: null, reason: null });
const drop = (reason, category = 'other') => ({ keep: false, certain: true, band: null, reason, category });

/**
 * Rules lean this way but the signal is soft — `certain: false` lets
 * classify() escalate to the adjudicator when an uncertainty also applies.
 */
const softDrop = (reason, category = 'other') => ({ keep: false, certain: false, band: null, reason, category });

/** Exposed so a test can read the terms without reconstructing them. */
export const __testables = { localTerms, germanLines, workModeLines, matchingLines };
