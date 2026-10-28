import { slug } from './util.js';

/**
 * Language handling — the single most important filter for a job search in
 * Germany with limited German. Two independent questions:
 *   1. What language is the posting written in?
 *   2. What German level does the posting actually demand?
 * A German-language posting usually implies German is required, but not always
 * (some German companies post in German for an English-speaking team), so the
 * explicit requirement always wins over the language guess.
 */

const DE_STOPWORDS = [
  'der', 'die', 'das', 'und', 'für', 'fuer', 'mit', 'wir', 'sie', 'ist', 'sind',
  'ein', 'eine', 'einen', 'einem', 'einer', 'von', 'zu', 'im', 'in', 'den', 'dem',
  'des', 'auf', 'als', 'bei', 'nicht', 'auch', 'oder', 'aus', 'über', 'ueber',
  'unser', 'unsere', 'unseren', 'ihre', 'ihren', 'sich', 'werden', 'wird', 'haben',
  'du', 'dein', 'deine', 'kenntnisse', 'erfahrung', 'aufgaben', 'profil', 'bieten',
];

const EN_STOPWORDS = [
  'the', 'and', 'for', 'with', 'you', 'we', 'are', 'is', 'to', 'of', 'in', 'on',
  'as', 'at', 'your', 'our', 'will', 'have', 'has', 'this', 'that', 'from', 'be',
  'experience', 'skills', 'team', 'role', 'about', 'work', 'their',
];

/** 'de' | 'en' — by relative stopword density, which is robust on short text. */
export function detectLanguage(text = '') {
  const words = slug(text).split(' ').filter(Boolean);
  if (words.length < 12) return 'en';
  const set = new Map();
  for (const w of words) set.set(w, (set.get(w) || 0) + 1);
  const count = (list) => list.reduce((n, w) => n + (set.get(slug(w)) || 0), 0);
  const de = count(DE_STOPWORDS);
  const en = count(EN_STOPWORDS);
  return de > en * 1.15 ? 'de' : 'en';
}


/**
 * Below this, a description is a teaser rather than a posting, and the absence
 * of a requirement in it means nothing. Adzuna cuts every description at
 * exactly 500 characters and alert emails supply none, which together covered
 * 39 of 54 kept jobs — so this is the common case, not an edge case.
 */
export const MIN_DESCRIPTION_CHARS = 600;

/**
 * Does this posting discuss German AS A LANGUAGE, whatever level it asks for?
 *
 * The escape hatch for a phrasing the tiers below have never seen. Nine of ten
 * real requirements taken from postings rejected by hand were graded "none" —
 * "*German Language must*", "Deutschkenntnisse erforderlich" — and because the
 * rules were certain, the adjudicator was told German was settled and forbidden
 * from revisiting it. A rules blind spot became invisible to the one layer that
 * could have caught it.
 *
 * So when the text mentions German at all and the tiers still find nothing,
 * that is worth a question rather than a silent "none".
 *
 * Deliberately blunt. The first version tried to match only the LANGUAGE sense —
 * "german" followed within 30 characters by level, skills, speaking and so on —
 * so that "Germany" the place would not trigger it. Being clever about word
 * order is what let four real requirements through: English adverts write
 * "Proficiency in both German and English at a professional level", which puts
 * the language word first and pushes "level" outside the window. Three of those
 * four were rejected by hand.
 *
 * So the test is now just: does the word appear. If the rules could not decide
 * and the advert says german or deutsch anywhere, extract the line and ask.
 *
 * The cost of being blunt is small and was measured. Only 213 postings have
 * ever reached the German check — the rest are dropped earlier on title, age or
 * location. The tiers settle 158 of those on their own. This takes the
 * escalations from 4 to 22: eighteen extra questions across everything the tool
 * has ever judged. A wrong "no German required" costs an application.
 */
export function mentionsGermanAsLanguage(text = '') {
  return /\bgerman\b|\bdeutsch(?!land)\w*/i.test(String(text));
}

/**
 * Grade the German requirement into four tiers, plus 'unknown'.
 *
 * `complete` says whether the description is long enough for "no requirement
 * mentioned" to be a finding rather than an artefact of truncation.
 * Returns { level, evidence } where evidence is the phrase that decided it.
 */
export function detectGermanRequirement(text = '', language = 'en', { complete = true, chars = null } = {}) {
  const raw = String(text);
  const t = ` ${slug(raw)} `;

  const find = (patterns) => {
    for (const re of patterns) {
      const m = t.match(re);
      if (m) return m[0].trim();
    }
    return null;
  };

  // Tier 4 — hard requirement. Out of reach at A2, and at B1 too.
  const required = find([
    /verhandlungssicher\w*/,
    /fliessend\w*\s+(in\s+)?deutsch/,
    /deutsch\w*\s+fliessend/,
    /fluent\s+(in\s+)?german/,
    // A language LIST hides the requirement from a pattern expecting "fluent"
    // beside "german": "fluent in English and German both spoken and written"
    // is a hard requirement, was graded 'none', and scored the posting 93.
    /(fluent|fliessend\w*|verhandlungssicher\w*)\s+(in\s+)?[\w\s]{0,24}\b(and|und|&)\s*(german|deutsch)\w*/,
    /(german|deutsch)\w*\s*(and|und|&)\s*[\w\s]{0,24}\b(fluent|fliessend\w*)/,

    // The same list, with a CEFR LEVEL stated after both languages rather than
    // a word like "fluent": "German and English skills at C1 level",
    // "Deutsch- und Englischkenntnisse auf C1-Niveau". Every level pattern above
    // needs the level ADJACENT to the language, and in this shape it is not —
    // it trails the whole list. One posting asked for exactly this and
    // was graded from the fallback "posting written in German" instead, which
    // is an INFERENCE and therefore a soft drop. It escalated to the model for
    // a requirement the advert stated outright.
    //
    // The window is deliberately short. "German and English are used daily —
    // we also sponsor C1 courses" is two separate statements, and 30 characters
    // is not enough to reach across one. Both orders, because either language
    // may be named first.
    /(german|deutsch)\w*\s*(and|und|&)\s*[\w\s]{0,30}\bc[12]\b/,
    /(english|englisch)\w*\s*(and|und|&)\s*(german|deutsch)\w*[\w\s]{0,30}\bc[12]\b/,
    /german\s+(is\s+)?(a\s+)?(hard\s+)?requirement/,
    /native\s+(level\s+)?german/,
    /muttersprach\w*/,
    /deutsch\w*\s+(auf\s+)?(niveau\s+)?c[12]/,
    /german\s+(at\s+)?(level\s+)?c[12]/,
    // The lookbehind stops a level being stolen from the language before it.
    // "Englisch C1, Deutsch B2" slugs to "englisch c1 deutsch b2", where a bare
    // "c1 ... deutsch" matched across the comma and graded German C1 when the
    // advert asked for B2 — a wrong drop, which costs an opportunity you never
    // see.
    /(?<!(englisch|english|franzoesisch|french|spanisch|spanish|italienisch|italian)\s)c[12]\s+(level\s+)?(in\s+)?(deutsch|german)/,
    // A RANGE takes its upper bound. "Deutsch B2/C1" matched the B2 tier first,
    // because the C1 patterns above need the level adjacent to the noun and the
    // range sits in between — so an advert asking for up to C1 was labelled B2.
    // What you are measured against in the interview is the ceiling they named.
    // slug() strips the separator, so "Deutsch B2/C1" arrives as "deutsch b2 c1".
    // Adjacency is what makes this safe: "Deutsch B2, Englisch C1" becomes
    // "deutsch b2 englisch c1" and must stay B2 — the C1 belongs to English.
    /(deutsch|german)\w*\s+[ab][12]\s+c[12]\b/,
    /sehr\s+gute\s+deutschkenntnisse/,
    // Same hyphenated-compound shape as the B2 tier, one level up.
    /sehr\s+gute\s+deutsch\s*(und|and|&)\s*\w*kenntnisse/,
    /sehr\s+gute\s+deutsch\b/,
    /verhandlungssichere?\s+deutsch\s*(und|and|&)\s*\w*kenntnisse/,
    /excellent\s+german/,
    /perfekte?\s+deutsch/,
    /business\s+fluent\s+german/,

    // Plain necessity, no CEFR level named. Nine of ten real phrasings from
    // postings rejected by hand were graded "none": "*German Language must*",
    // "German is a must", "Deutschkenntnisse erforderlich".
    //
    // TWO THINGS KEEP THIS SAFE.
    //
    // German must be named as a LANGUAGE, not as the country. "Must be based in
    // Germany" and "You must be legally authorised to work in Germany" pair the
    // same two words and are location rules — matching them would be a wrong
    // drop on a remote-DE role, the best kind of job here. Note `german\b`
    // rather than `german\w*`: slug() leaves "Germany" intact, so the word
    // boundary is what separates the language from the place.
    //
    // And a level qualifier wins over bare necessity: "Good German language
    // skills are required" is B2, and belongs in the tier below, so the
    // lookbehind hands it back.
    /(?<!\b(good|basic|some|solid|no|not|without|gute[rs]?|grundlegende|solide|keine?|ohne|nicht)\s)german\b(\s+language)?(\s+skills?)?(\s+(is|are))?\s*(a\s+)?(must|mandatory|essential|required|requirement)\b/,
    /(must|need\s+to)\s+speak\s+(fluent\s+)?german\b/,
    /(?<!\b(gute[rs]?|grundlegende|solide|keine?|ohne|nicht|no)\s)(deutschkenntnisse|deutsch)\s+(sind\s+|ist\s+)?(zwingend\s+)?(erforderlich|voraussetzung|notwendig|pflicht|bedingung)/,
    /german\b(\s+language)?\s+proficiency\s+(is\s+)?(essential|required|mandatory)/,
  ]);
  if (required) return { level: 'required', evidence: required };

  // Tier 3 — conversational/B2. A stretch now, realistic by the time anyone hires.
  const conversational = find([
    /gute\s+deutschkenntnisse/,
    // German ads overwhelmingly share the noun across a hyphenated pair:
    // "gute Deutsch- und Englischkenntnisse". Matching only the joined form
    // missed these entirely, and they fell through to the weak
    // "posting is in German" inference instead of a quoted requirement.
    /gute\s+deutsch\s*(und|and|&)\s*\w*kenntnisse/,
    /gute\s+\w*\s*(und|and|&)\s*deutschkenntnisse/,
    /gute\s+deutsch\b/,
    /deutsch\w*\s+(auf\s+)?(niveau\s+)?b2/,
    /german\s+(at\s+)?(level\s+)?b2/,
    /b2\s+(level\s+)?(in\s+)?(deutsch|german)/,
    /sicher\w*\s+(in\s+)?deutsch/,
    /good\s+(command\s+of\s+)?german/,
    /solid\s+german/,
    /conversational\s+german/,
    /working\s+proficiency\s+in\s+german/,
    /deutsch\s+in\s+wort\s+und\s+schrift/,
  ]);
  if (conversational) return { level: 'conversational', evidence: conversational };

  // Tier 2 — basic/nice-to-have. A2 already clears this.
  const basic = find([
    // A German-language advert saying German is NOT needed matched no tier, so
    // it fell through to the "posting is in German" inference and was graded a
    // hard requirement — the exact inversion of what it says. These belong
    // here, in the tier that clears at A2, and NOT in the requirement tier.
    /deutsch\w*\s+(ist\s+)?nicht\s+(zwingend\s+)?(erforderlich|notwendig|voraussetzung)/,
    /(kein|keine)\s+deutsch/,
    /grundkenntnisse\s+(in\s+)?deutsch/,
    /deutsch\w*\s+(auf\s+)?(niveau\s+)?[ab][12]/,
    /german\s+(at\s+)?(level\s+)?[ab][12]/,
    /basic\s+german/,
    /german\s+(is\s+)?(a\s+)?plus/,
    /german\s+(is\s+)?(a\s+)?(nice|bonus|advantage|beneficial|welcome)/,
    /willingness\s+to\s+learn\s+german/,
    /bereitschaft\w*\s+deutsch\s+zu\s+lernen/,
    /german\s+(skills\s+)?(are\s+)?(desirable|preferred|optional)/,
    /deutschkenntnisse\s+von\s+vorteil/,
    /keine\s+deutschkenntnisse\s+(erforderlich|notwendig)/,
    /no\s+german\s+(required|needed|necessary)/,
    /english\s+is\s+(our|the)\s+(company|working|office)\s+language/,
  ]);
  if (basic) return { level: 'basic', evidence: basic };

  // Nothing stated. The fallback below infers a requirement from the posting
  // being in German — sound when we have the posting, a fabrication when we
  // have 500 characters of it. Adzuna truncates every description to exactly
  // that, so the inference was firing on teasers.
  if (language === 'de' && !complete) {
    return {
      level: 'unknown',
      // `chars` is the DESCRIPTION length. The text searched also carries the
      // title and location, so measuring it here reported 586 for a 500-char
      // description and made the number look wrong.
      evidence: `description is truncated${chars != null ? ` (${chars} chars)` : ''}`
        + ' — no language requirement in the part we have',
    };
  }

  // A full German-language posting with no English signal effectively demands German.
  if (language === 'de') return { level: 'required', evidence: 'posting written in German, no English signal' };

  // NO description at all is not the same as a description that says nothing.
  //
  // detectLanguage() answers 'en' for anything under twelve words, empty text
  // included, so a posting with no body fell into the English branch below and
  // was graded "no German requirement" — a finding, from nothing. That is 43 of
  // 97 archived jobs, every one from a LinkedIn alert email: those carry no
  // description and LinkedIn serves no structured data, so the body never
  // arrives. One of them turned out to say "Du kommunizierst klar auf Deutsch"
  // on the page the user read for themselves.
  //
  // Saying `unknown` costs seven extra escalations, because most of these are
  // already uncertain for other reasons, and it is what the rest of this file
  // does when evidence is missing.
  // `=== 0`, not falsy: `chars` defaults to null when a caller does not supply
  // it, and "the caller did not say" is not "the posting is empty". normalize()
  // always passes it, so the real pipeline always gets the strict answer.
  if (chars === 0) {
    return {
      level: 'unknown',
      evidence: 'no description available — nothing to read for a language requirement',
    };
  }

  // An English posting that never mentions German is taken at face value even
  // when truncated. The prior is strong and the alternative — querying every
  // truncated English ad — would escalate most of the run to a model that can
  // see no more of the posting than we can. The card is chipped as partial so
  // the caveat is visible where it matters.
  return { level: 'none', evidence: null };
}

/**
 * Decide what happens to a job given the candidate's current level.
 * 'pass'    -> main results
 * 'stretch' -> shown, but banded separately with a warning chip
 * 'hide'    -> excluded unless --include-german
 */
export function gateGerman(requirement, germanLevel = 'A2', opts = {}) {
  const { stretchB2 = false } = opts;
  const have = String(germanLevel).toUpperCase();
  const haveRank = { A1: 0, A2: 1, B1: 2, B2: 3, C1: 4, C2: 4 }[have] ?? 1;

  switch (requirement) {
    case 'unknown':
      // We never saw enough of the posting to judge. Passing it on is right —
      // hiding a job because its description was truncated would be punishing
      // it for the source's API limit — but classify() raises an uncertainty so
      // the adjudicator (or you) looks at the real posting.
      return 'pass';
    case 'none':
      return 'pass';
    case 'basic':
      // A2 satisfies "Grundkenntnisse"/"German a plus".
      return haveRank >= 1 ? 'pass' : 'stretch';
    case 'conversational':
      // B2 clears once you actually have B2.
      if (haveRank >= 3) return 'pass';
      // Below that it is a drop by default — a stated B2 requirement is a real
      // requirement, and surfacing it as a "stretch" just adds noise you would
      // skip anyway. Set languages.stretchB2 to surface them in their own band.
      return stretchB2 ? 'stretch' : 'hide';
    case 'required':
      return haveRank >= 4 ? 'pass' : 'hide';
    default:
      return 'pass';
  }
}

/** CEFR ladder, so a gap can be stated in levels rather than adjectives. */
const CEFR = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'];
const rankOf = (l) => CEFR.indexOf(String(l).toUpperCase());

/**
 * Turn a tier plus its evidence into the level the posting actually wants.
 *
 * "German required" tells you nothing actionable — B2 and native are both
 * "required" and they are two very different distances from, say, A2. The tier is
 * coarse on purpose (it drives the gate), so the specific level is recovered
 * here from the phrase that triggered it.
 *
 * Returns { cefr, rank, label, inferred } — or null when nothing is demanded.
 * `cefr` is null when the posting never states a level, because claiming C1 on
 * the strength of "this ad is written in German" would be inventing a fact.
 */
export function describeGermanNeed(level, evidence = '') {
  const e = slug(evidence || '');
  const at = (cefr, label) => ({ cefr, rank: rankOf(cefr), label, inferred: false });

  switch (level) {
    case 'unknown':
      // Deliberately no cefr and no rank guess. The posting may demand nothing
      // or may demand C1; claiming either from a teaser would be a fabrication.
      return { cefr: null, rank: rankOf('A2'), label: 'not stated in the part of the posting we have', inferred: true, unknown: true };

    case 'basic':
      return at('A2', 'basic German');

    case 'conversational':
      return /b2/.test(e) ? at('B2', 'German B2')
        : at('B2', 'good conversational German');

    case 'required': {
      // Graded from the posting's language alone — no level was ever stated.
      if (/posting written in german/.test(e)) {
        return { cefr: null, rank: rankOf('C1'), label: 'German, level unstated', inferred: true };
      }
      if (/c2|muttersprach|native/.test(e)) return at('C2', 'near-native German');
      if (/c1/.test(e)) return at('C1', 'German C1');
      if (/verhandlungssicher/.test(e)) return at('C1', 'negotiation-level German');
      if (/sehr gute/.test(e)) return at('C1', 'very good German');
      if (/perfekt|excellent/.test(e)) return at('C1', 'excellent German');
      return at('C1', 'fluent German');
    }

    default:
      return null;
  }
}

/**
 * One line naming the level the posting wants.
 *
 * `steps` is the distance from your configured level. It is deliberately NOT in
 * `text` — the level alone is what you need to triage a rejection, and spelling
 * out the arithmetic on every row just crowded the list. Callers that want the
 * distance can read `steps`.
 */
export function germanGap(level, evidence, have = 'A2') {
  const need = describeGermanNeed(level, evidence);
  if (!need) return null;

  if (need.unknown) {
    return {
      ...need,
      steps: 0,
      text: 'German requirement not checked — description truncated by the source',
      short: 'German unchecked',
    };
  }

  return {
    ...need,
    steps: need.rank - rankOf(have),
    text: need.cefr ? `German ${need.cefr} required` : 'German required, level unstated',
    short: need.cefr ? `German ${need.cefr}` : 'German (level unstated)',
  };
}

