import { slug, findPhrase } from './util.js';

/**
 * Detects two shapes of role the profile can opt out of, via `avoid` in
 * config/profile.json:
 *
 *   1. Roles that genuinely require software-development / programming-language
 *      proficiency (as opposed to the near-universal "Python is a plus").
 *   2. Roles built around one cloud specifically. As configured that is AWS:
 *      dropped when it is the whole job, kept when the posting also mentions
 *      Azure, since "any major cloud" is squarely in scope.
 *
 * Both work at SENTENCE level. A posting-wide keyword search would fire on every
 * DevOps ad ever written, because they all list Python somewhere.
 */

/** Words that mark a real requirement rather than a wish. */
const REQUIRED_CUES = [
  'must have', 'must be', 'must possess', 'required', 'requirement', 'mandatory',
  'essential', 'we expect', 'you bring', 'you have', 'you are', 'proven',
  'strong', 'proficient', 'proficiency', 'expert', 'expertise', 'advanced',
  'solid', 'deep', 'extensive', 'excellent', 'demonstrated', 'significant',
  'hands on experience', 'years of experience', 'years experience', 'yrs experience',
];

/** Words that downgrade the same sentence to a nice-to-have. */
const OPTIONAL_CUES = [
  'nice to have', 'nice if', 'a plus', 'plus point', 'bonus', 'advantage',
  'advantageous', 'preferred', 'preferably', 'desirable', 'desired', 'ideally',
  'would be great', 'would be nice', 'familiarity', 'familiar with', 'exposure to',
  'basic knowledge', 'basic understanding', 'some knowledge', 'some experience',
  'willingness', 'openness', 'appreciated', 'welcome', 'optional', 'not required',
  'no need', 'helpful', 'beneficial', 'good to have', 'we do not expect',
];

/**
 * Full programming languages — proficiency in these is what an infrastructure
 * search usually wants to skip.
 * NOTE: symbol-bearing names (C#, C++) are matched on the RAW text instead,
 * because slug() strips punctuation and would reduce them to a bare "c" that
 * matches almost every sentence.
 */
const PROGRAMMING_LANGUAGES = [
  'python', 'golang', 'go lang', 'java', 'c sharp', 'csharp', 'dot net', 'dotnet',
  'net core', 'scala', 'kotlin', 'typescript', 'javascript', 'node js', 'nodejs',
  'php', 'elixir', 'erlang', 'haskell', 'clojure', 'groovy',
];

/** Matched on raw (un-slugged) text so the punctuation survives. */
const SYMBOL_LANGUAGES = [
  { name: 'C#', re: /\bC#/ },
  { name: 'C++', re: /\bC\+\+/ },
  { name: '.NET', re: /\.NET\b/ },
];

/**
 * Language names that are also ordinary English words. Requiring nearby
 * programming context stops "go to production" and "a rusty pipeline" from
 * reading as language requirements.
 */
const AMBIGUOUS_LANGUAGES = ['go', 'rust', 'ruby', 'swift', 'perl', 'dart'];
const PROGRAMMING_CONTEXT = [
  'programming', 'language', 'languages', 'code', 'coding', 'develop',
  'development', 'developer', 'software', 'scripting', 'backend', 'api',
  'microservice', 'microservices', 'compile', 'framework',
];

/** Phrases that describe a software-development role regardless of language. */
const DEV_PHRASES = [
  'software development experience', 'software engineering experience',
  'software developer', 'software engineering background', 'development background',
  'programming skills', 'programming experience', 'coding skills',
  'coding experience', 'write production code', 'production grade code',
  'application development', 'develop software', 'building applications',
  'object oriented programming', 'software design patterns', 'algorithms and data structures',
];

/**
 * Scripting every infrastructure engineer already does (Bash, PowerShell). These must never count as a
 * programming requirement — every infrastructure role asks for them.
 */
const SCRIPTING_OK = ['bash', 'shell', 'powershell', 'shell scripting', 'yaml', 'sql'];

/** Returns { raw, s } pairs — raw keeps punctuation so C#/C++ stay detectable. */
const splitSentences = (text) =>
  String(text)
    .split(/[.!?\n\r•;·]|(?:\s-\s)/)
    .map((raw) => ({ raw, s: ` ${slug(raw)} ` }))
    .filter((x) => x.s.trim().length > 8);

/**
 * Whole-word matching only, via the shared helper. No substring fallback — that
 * is what let "c" (from slugging "C#") match every sentence, and would let
 * "java" fire on "javascript" or "go" on "going".
 */
const hasAny = (sentence, list) => findPhrase(sentence, list);

/** Language mentioned in this sentence, honouring the ambiguity rules. */
function languageIn(sentence, rawSentence, extra = []) {
  const direct = hasAny(sentence, [...PROGRAMMING_LANGUAGES, ...extra]);
  if (direct) return direct;

  for (const { name, re } of SYMBOL_LANGUAGES) if (re.test(rawSentence)) return name;

  const ambiguous = hasAny(sentence, AMBIGUOUS_LANGUAGES);
  if (ambiguous && hasAny(sentence, PROGRAMMING_CONTEXT)) return ambiguous;

  return null;
}

/**
 * @returns {{level:'none'|'niceToHave'|'required', evidence:string|null, language:string|null}}
 */
export function detectProgrammingRequirement(text = '', extraLanguages = []) {
  const languages = [...PROGRAMMING_LANGUAGES, ...extraLanguages];
  const sentences = splitSentences(text);

  let niceToHave = null;

  for (const { s, raw } of sentences) {
    const lang = languageIn(s, raw, languages);
    const devPhrase = hasAny(s, DEV_PHRASES);
    if (!lang && !devPhrase) continue;

    // Pure scripting sentences ("strong Bash/shell scripting") are existing
    // skillset, not a developer requirement. But only when no full programming
    // language is named — "works with Go, Python and Shell" is not scripting.
    const scriptingOnly = !lang && !devPhrase && hasAny(s, SCRIPTING_OK) &&
      /scripting|automation script|shell/.test(s);

    const optional = hasAny(s, OPTIONAL_CUES);
    const required = hasAny(s, REQUIRED_CUES);

    if (optional || scriptingOnly) {
      if (!niceToHave) niceToHave = { evidence: trim(raw), language: lang || devPhrase };
      continue;
    }
    if (required) {
      return { level: 'required', evidence: trim(raw), language: lang || devPhrase };
    }
  }

  if (niceToHave) return { level: 'niceToHave', ...niceToHave };
  return { level: 'none', evidence: null, language: null };
}

/**
 * Titles that ARE software-development roles, whatever the body says.
 * "Software Engineer — Infrastructure" is still a coding job; the description
 * often never spells out a language requirement because the title already did.
 */
export function isDeveloperTitle(title = '') {
  const t = ` ${slug(title)} `;
  if (/(^|\s)(platform|cloud|devops|infrastructure|reliability|systems|network|security)\s+(engineer|architect)(\s|$)/.test(t)) {
    return false; // target roles keep priority over the generic check below
  }
  return /(^|\s)(software|backend|back end|frontend|front end|fullstack|full stack|application|api|mobile|web)\s+(engineer|developer|architect)(\s|$)/.test(t)
    || /(^|\s)software\s+development\s+engineer(\s|$)/.test(t)
    || /(^|\s)(programmer|software developer)(\s|$)/.test(t);
}

const trim = (s) => s.trim().replace(/\s+/g, ' ').slice(0, 160);
