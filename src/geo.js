import { slug } from './util.js';

/**
 * Built-in gazetteer — no geocoding API, no rate limits, no cache to invalidate.
 * Covers the Munich area, the south-west border region (Baden, Basel, Alsace)
 * and the major German cities needed to *reject* by distance. Living somewhere
 * else? Add your surroundings here — an unresolved location cannot be measured.
 */
const CITIES = {
  // --- Munich + surroundings ---
  'muenchen': [48.137, 11.575], 'munich': [48.137, 11.575], 'freising': [48.40, 11.75],
  'dachau': [48.26, 11.43], 'erding': [48.31, 11.91], 'starnberg': [48.00, 11.34],
  'garching': [48.25, 11.65], 'unterschleissheim': [48.28, 11.58], 'ismaning': [48.23, 11.67],
  'fuerstenfeldbruck': [48.18, 11.25], 'rosenheim': [47.86, 12.12], 'landshut': [48.54, 12.15],
  'ingolstadt': [48.77, 11.42], 'unterfoehring': [48.19, 11.64], 'oberhaching': [48.02, 11.59],

  // --- Baden + surroundings ---
  'freiburg': [47.999, 7.842], 'freiburg im breisgau': [47.999, 7.842],
  'freiburg i br': [47.999, 7.842], 'freiburg br': [47.999, 7.842],
  'gundelfingen': [48.062, 7.865], 'march': [48.06, 7.76], 'umkirch': [48.03, 7.75],
  'denzlingen': [48.07, 7.88], 'waldkirch': [48.093, 7.963], 'emmendingen': [48.121, 7.849],
  'kirchzarten': [47.95, 7.95], 'bad krozingen': [47.92, 7.70], 'staufen': [47.88, 7.73],
  'muellheim': [47.808, 7.63], 'breisach': [48.03, 7.58], 'titisee neustadt': [47.92, 8.21],
  'loerrach': [47.615, 7.66], 'weil am rhein': [47.593, 7.62], 'rheinfelden': [47.56, 7.79],
  'schopfheim': [47.65, 7.82], 'offenburg': [48.47, 7.94], 'lahr': [48.34, 7.87],
  'kehl': [48.57, 7.81], 'schwanau': [48.36, 7.77], 'ettenheim': [48.25, 7.81],
  'villingen schwenningen': [48.06, 8.46], 'donaueschingen': [47.95, 8.50],
  'waldshut tiengen': [47.62, 8.21], 'schiltach': [48.29, 8.34], 'furtwangen': [48.05, 8.20],
  'st georgen': [48.13, 8.33], 'triberg': [48.13, 8.23], 'bad saeckingen': [47.55, 7.95],
  'endingen': [48.14, 7.70], 'herbolzheim': [48.22, 7.78], 'elzach': [48.17, 8.07],

  // --- Switzerland (border zone) ---
  'basel': [47.559, 7.588], 'basel stadt': [47.559, 7.588], 'bale': [47.559, 7.588],
  'allschwil': [47.55, 7.53], 'pratteln': [47.52, 7.69], 'muttenz': [47.52, 7.64],
  'kaiseraugst': [47.53, 7.72], 'reinach': [47.49, 7.59], 'liestal': [47.48, 7.73],
  'stein': [47.54, 7.95], 'schaffhausen': [47.70, 8.63], 'zurich': [47.377, 8.54],
  'zuerich': [47.377, 8.54], 'bern': [46.948, 7.447], 'geneva': [46.204, 6.143],
  'lausanne': [46.52, 6.63], 'zug': [47.17, 8.52], 'lucerne': [47.05, 8.31],

  // --- France (Alsace border) ---
  'strasbourg': [48.573, 7.752], 'mulhouse': [47.75, 7.34], 'colmar': [48.08, 7.36],
  'saint louis': [47.59, 7.56],

  // --- rest of Germany (mostly to reject by distance) ---
  'karlsruhe': [49.007, 8.404], 'stuttgart': [48.775, 9.183], 'heidelberg': [49.40, 8.67],
  'mannheim': [49.487, 8.466], 'pforzheim': [48.89, 8.70], 'reutlingen': [48.49, 9.21],
  'tuebingen': [48.52, 9.06], 'ulm': [48.40, 9.99], 'konstanz': [47.66, 9.18],
  'friedrichshafen': [47.65, 9.48], 'ravensburg': [47.78, 9.61], 'sigmaringen': [48.09, 9.22],
  'tuttlingen': [47.98, 8.82], 'biberach': [48.10, 9.79], 'heilbronn': [49.14, 9.22],
  'esslingen': [48.74, 9.31], 'boeblingen': [48.69, 9.01], 'walldorf': [49.30, 8.64],
  'berlin': [52.52, 13.405],
  'hamburg': [53.551, 9.994], 'cologne': [50.937, 6.96], 'koeln': [50.937, 6.96],
  'frankfurt': [50.11, 8.682], 'frankfurt am main': [50.11, 8.682],
  'duesseldorf': [51.227, 6.773], 'dusseldorf': [51.227, 6.773], 'dortmund': [51.514, 7.466],
  'essen': [51.456, 7.012], 'leipzig': [51.34, 12.375], 'dresden': [51.05, 13.738],
  'hannover': [52.376, 9.74], 'nuremberg': [49.452, 11.077], 'nuernberg': [49.452, 11.077],
  'bremen': [53.079, 8.802], 'bonn': [50.737, 7.098], 'mainz': [49.992, 8.247],
  'wiesbaden': [50.083, 8.24], 'augsburg': [48.37, 10.90], 'regensburg': [49.01, 12.10],
  'kaiserslautern': [49.44, 7.77], 'saarbruecken': [49.24, 6.997], 'kassel': [51.31, 9.50],
  'muenster': [51.96, 7.63], 'aachen': [50.78, 6.08], 'bielefeld': [52.02, 8.53],
  'braunschweig': [52.27, 10.52], 'jena': [50.93, 11.59], 'erfurt': [50.98, 11.03],
  'potsdam': [52.40, 13.06], 'rostock': [54.09, 12.14], 'kiel': [54.32, 10.14],
};

/** Country hints when a posting gives no parseable city. */
const COUNTRY_WORDS = {
  DE: ['germany', 'deutschland', 'german', 'de'],
  CH: ['switzerland', 'schweiz', 'suisse', 'swiss', 'ch'],
  AT: ['austria', 'oesterreich', 'osterreich'],
  FR: ['france', 'french'],
  NL: ['netherlands', 'holland', 'dutch'], BE: ['belgium'], LU: ['luxembourg'],
  ES: ['spain', 'espana'], PT: ['portugal'], IT: ['italy', 'italia'],
  IE: ['ireland', 'republic of ireland'], PL: ['poland', 'polska'],
  SE: ['sweden'], DK: ['denmark'], FI: ['finland'], NO: ['norway'],
  CZ: ['czech republic', 'czechia'], RO: ['romania'], GR: ['greece'],
  HU: ['hungary'], BG: ['bulgaria'], HR: ['croatia'], EE: ['estonia'],
  LV: ['latvia'], LT: ['lithuania'], SK: ['slovakia'], SI: ['slovenia'],
  US: ['united states', 'usa', 'u s a', 'us', 'america', 'east coast', 'west coast'],
  GB: ['united kingdom', 'uk', 'england', 'scotland', 'britain'],
  IN: ['india', 'bengaluru', 'bangalore', 'hyderabad', 'pune', 'chennai', 'mumbai', 'gurgaon', 'noida'],
  CA: ['canada'], BR: ['brazil', 'brasil'], MX: ['mexico'], AR: ['argentina'],
  AU: ['australia'], NZ: ['new zealand'], SG: ['singapore'], JP: ['japan'],
  CN: ['china'], KR: ['south korea'], PH: ['philippines'], ID: ['indonesia'],
  ZA: ['south africa'], NG: ['nigeria'], KE: ['kenya'], EG: ['egypt'],
  AE: ['united arab emirates', 'dubai'], IL: ['israel'], TR: ['turkey'],
};

/**
 * EU/EEA + Switzerland — the set a user based in Germany can work in or from.
 * A remote role anchored outside this set is not viable from the home city,
 * regardless of how "remote" the posting claims to be.
 */
export const EUROPE = new Set([
  'DE', 'CH', 'AT', 'FR', 'NL', 'BE', 'LU', 'ES', 'PT', 'IT', 'IE', 'PL',
  'SE', 'DK', 'FI', 'NO', 'CZ', 'RO', 'GR', 'HU', 'BG', 'HR', 'EE', 'LV',
  'LT', 'SK', 'SI', 'IS', 'MT', 'CY',
]);

const R = 6371;
const rad = (d) => (d * Math.PI) / 180;

export function haversineKm(a, b) {
  const dLat = rad(b[0] - a[0]);
  const dLon = rad(b[1] - a[1]);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dLon / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(h)));
}

/**
 * Resolve a free-text location string.
 * Returns { city, country, coords, distanceKm, resolved }.
 */
/**
 * The city and country patterns, built ONCE.
 *
 * Both loops in resolveLocation used to construct their regexes inline, and the
 * country loop did it unconditionally: 86 `new RegExp` per posting, whatever
 * the text said. Over a run of 7,017 postings that is roughly 600,000 regex
 * compilations, and it was the whole cost of the step — normalize() measured
 * 21.7ms a posting, 152 seconds in total, for work that is pure string
 * matching.
 *
 * The patterns are constants. Nothing about them depends on the posting, so
 * they belong at module load rather than in the inner loop.
 *
 * Kept as arrays rather than one combined alternation, because the city loop
 * needs LONGEST-MATCH-WINS semantics — "freiburg im breisgau" must beat
 * "freiburg", and "bad saeckingen" must not be shadowed by a shorter key.
 */
const CITY_PATTERNS = Object.entries(CITIES).map(([name, coords]) => ({
  name, coords, re: new RegExp(`(^|\\s)${name}($|\\s)`),
}));

const COUNTRY_PATTERNS = Object.entries(COUNTRY_WORDS).map(([code, words]) => ({
  code, res: words.map((w) => new RegExp(`(^|\\s)${w}($|\\s)`)),
}));

export function resolveLocation(raw, home) {
  const text = String(raw || '').trim();
  if (!text) return { city: null, country: null, coords: null, distanceKm: null, resolved: false };

  const s = slug(text);

  // Longest-match wins so "freiburg im breisgau" beats "freiburg",
  // and "bad saeckingen" is not shadowed by a shorter key.
  let best = null;
  for (const { name, coords, re } of CITY_PATTERNS) {
    // The cheap includes() first: it rejects almost every city without the
    // regex being run at all, and the word boundary is what stops "essen"
    // matching inside "giessen".
    if (s === name || (s.includes(name) && re.test(s))) {
      if (!best || name.length > best.name.length) best = { name, coords };
    }
  }

  let country = null;
  for (const { code, res } of COUNTRY_PATTERNS) {
    if (res.some((re) => re.test(s))) { country = code; break; }
  }

  if (best) {
    const distanceKm = haversineKm(best.coords, [home.lat, home.lon]);
    // Swiss/French border towns: infer country from the gazetteer half we matched.
    if (!country) {
      const CH = ['basel', 'allschwil', 'pratteln', 'muttenz', 'kaiseraugst', 'reinach',
        'liestal', 'zurich', 'zuerich', 'bern', 'geneva', 'lausanne', 'zug', 'lucerne',
        'schaffhausen', 'stein', 'bale'];
      const FR = ['strasbourg', 'mulhouse', 'colmar', 'saint louis'];
      country = CH.includes(best.name) ? 'CH' : FR.includes(best.name) ? 'FR' : 'DE';
    }
    return { city: titleCase(best.name), country, coords: best.coords, distanceKm, resolved: true };
  }

  return { city: text.split(/[,|·]/)[0].trim() || null, country, coords: null, distanceKm: null, resolved: false };
}

const titleCase = (s) => s.replace(/\b\w/g, (c) => c.toUpperCase());

/** Remote scope from free text: who may actually sit where. */
export function detectRemoteScope(text = '') {
  const t = ` ${slug(text)} `;

  if (/\b(us only|usa only|united states only|must (be|reside) (located )?in the (us|united states)|us based only|authorized to work in the (us|united states)|work authorization in the us)\b/.test(t))
    return 'US-only';
  if (/\b(uk only|must reside in the uk|india only|canada only|australia only|latam only|brazil only)\b/.test(t))
    return 'other-only';
  // An explicit list of eligible countries that does NOT include Germany.
  // "We are looking for candidates in the UK, Spain and Ireland only" was read
  // as EU — several of those ARE in Europe — and scored 95. What matters is not
  // whether the list looks European but whether Germany is on it.
  const eligible = t.match(/\b(?:candidates?|applicants?|hiring|recruiting|employ)\b[^.]{0,60}?\b(?:in|from|based in|located in|residing in)\b([^.]{0,90}?)\bonly\b/)
    || t.match(/\bonly\b[^.]{0,20}\b(?:candidates?|applicants?)\b[^.]{0,20}\b(?:in|from)\b([^.]{0,90})/);
  if (eligible) {
    const list = eligible[1];
    const namesGermany = /\b(germany|deutschland|german|europe|european union|eu|emea|worldwide|anywhere)\b/.test(list);
    if (!namesGermany) return 'other-only';
  }

  // Proximity rather than an exact-phrase list: postings say "remote within
  // Germany", "remote across Germany", "Germany-based remote" and a dozen other
  // variants that a fixed list keeps missing.
  if (/\b(remote|homeoffice|home office|work from home)\b[^.]{0,40}\b(germany|deutschland)\b/.test(t) ||
      /\b(germany|deutschland)\b[^.]{0,40}\b(remote|homeoffice)\b/.test(t) ||
      /\bdeutschlandweit\b/.test(t))
    return 'DE';

  if (/\b(remote|homeoffice)\b[^.]{0,40}\b(eu|europe|european union|emea)\b/.test(t) ||
      /\b(eu|europe|european union|emea)\b[^.]{0,40}\b(remote|based)\b/.test(t) ||
      /\b(anywhere in (the )?(eu|europe)|emea|cet|cest|european time ?zone)\b/.test(t))
    return 'EU';
  if (/\b(worldwide|anywhere in the world|work from anywhere|globally|fully distributed|any time ?zone)\b/.test(t))
    return 'worldwide';
  return null;
}

/**
 * "remote" is a technical word, and this is a DevOps corpus.
 *
 * Prometheus REMOTE WRITE, Terraform REMOTE STATE, a git REMOTE REPOSITORY —
 * all of them made postings "remote" and earned full location points hundreds
 * of kilometres away. Two are in the archive right now. These phrases are never
 * a statement about where the work happens, so they are removed before anything
 * is read.
 */
const TECHNICAL_REMOTE = /\bremote[\s-]+(write|read|state|states|backend|repositor\w*|branch\w*|desktop|access|host|hosts|server|servers|execution|procedure|api|apis|call|calls|storage|cache|caching|config\w*|endpoint\w*)\b/gi;

/**
 * "hybrid" describing an ARCHITECTURE, not a work model.
 *
 * A hybrid cloud is the single commonest thing an infrastructure advert
 * discusses, and this corpus is nothing but infrastructure adverts — "Sie
 * bringen sie in eine hybride Cloud-/On-Prem-Infrastruktur ein" says nothing
 * whatever about where the person sits.
 *
 * The same trap as TECHNICAL_REMOTE above, and it was already live for the
 * English spelling before the German endings were added: `\bhybrid\b` has
 * always matched "hybrid cloud".
 */
const TECHNICAL_HYBRID = /\bhybrid(e|es|er|en|em)?[\s-]+(cloud\w*|infrastruktur\w*|infrastructure\w*|umgebung\w*|environment\w*|setup\w*|architektur\w*|architecture\w*|landschaft\w*|szenario\w*|deployment\w*|modell?\w*\s+aus\b|it[\s-]?landschaft\w*|betrieb\w*|storage\w*|network\w*|netzwerk\w*)\b/gi;

/**
 * "remote" describing someone other than the reader, or a thing rather than a
 * place. All from real postings:
 *
 *   "unsere Mitarbeitenden – remote wie vor Ort – zuverlässig arbeiten"  (users)
 *   "Teamplayer, trotz Remote-Arbeit"                                   (a trait)
 *   "Technische Ausstattung für mobiles Arbeiten"                       (kit)
 *   "bis zu 4 Wochen Workation"                                         (a holiday)
 */
const NOT_ABOUT_THIS_JOB = /\bremote wie vor ort\b|\btrotz\s+remote|\bausstattung\s+(fuer|zum|f(ü)r)\s+(mobiles arbeiten|home\s?office|remote)|\bworkation\b/gi;

/**
 * A perk bullet is not a work mode.
 *
 * German adverts list benefits one per line, and "Remote Work" sits among them
 * like any other. A Monitoring & Observability Engineer at Brunel in Kiel came
 * through as fully remote, scoring 20/20 on location far beyond the radius, on this:
 *
 *   Individuelle Förderkonzepte und Weiterbildungen
 *   Remote Work                                        <- the only mention
 *   Zuschuss zum Jobticket
 *
 * The discriminator is not WHERE the mention sits — most genuinely remote jobs
 * also say it under a benefits heading — but WHAT it says. "100% remote role",
 * "Fully Remote", "remote-first within Europe" are claims about the job. A bare
 * two-word line with no qualifier is an item in a list.
 *
 * Such a line is worth 'hybrid', not 'remote': the employer does offer
 * something, they just have not said the role is remote. Hybrid is still
 * distance-gated, so Kiel drops either way, and a nearby job keeps the benefit
 * of the doubt.
 */
const PERK_BULLET = /^[\s*•·\-–—]*(remote(\s+work(ing)?)?|home\s?office|mobiles arbeiten)[\s.:;,]*$/i;

/** Also an allowance, not a place: "Home office budget", "Remote work stipend". */
const PERK_ALLOWANCE = /\b(home\s?office|remote(\s+work)?)[\s-]+(budget|stipend|allowance|zuschuss|pauschale|ausstattung)\b/gi;

/**
 * Does the advert DISCUSS where the work happens?
 *
 * Not "is it remote" — that is detectWorkMode's job. This is the narrower
 * question the German check asks about language: has the posting raised the
 * subject at all, so that silence from the rules means "we could not grade it"
 * rather than "there was nothing there".
 *
 * The technical senses are stripped first, exactly as detectWorkMode strips
 * them. "Terraform remote state" and "hybride Cloud-Infrastruktur" are not the
 * advert discussing an arrangement, and escalating on them would send the model
 * a question no line of the posting answers — which is how a cheap escape hatch
 * turns into a bill.
 *
 * **The word "hybrid" on its own does NOT count, and that was measured.** It
 * looks like it belongs here and it halves the cost to leave it out: of the 28
 * postings that escalated with it, **14 name no home-working word anywhere in
 * the advert**. Their own word for the arrangement is "hybrid", which is the
 * employer stating it plainly rather than the rules guessing — 8 HelloFresh
 * postings 639km away on "Balance your life with our flexible hybrid model".
 *
 * This escape hatch exists for the case where the rules could not settle a
 * home-working claim. An advert that settled it is not that case.
 */
export function mentionsWorkMode(text = '') {
  const t = ` ${slug(String(text))} `
    .replace(TECHNICAL_REMOTE, ' ')
    .replace(TECHNICAL_HYBRID, ' ')
    .replace(NOT_ABOUT_THIS_JOB, ' ');
  return /\b(remote|home\s?office|homeoffice|mobiles? arbeit\w*|telearbeit|ortsunabhaengig)\b/.test(t);
}

export function detectWorkMode(text = '', locationText = '', titleText = '') {
  // The TITLE and the LOCATION are the employer's own headline claim about the
  // role. Everything else is body copy, where "Homeoffice" turns up in benefits
  // lists. Without this split, "Remote Cloud Software Engineer (m/w/d)" was
  // demoted to hybrid because the same advert also offered "flexible
  // Arbeitszeiten und Homeoffice" further down — the perk hedge outvoting the
  // job title.
  const headline = ` ${slug(`${titleText} ${locationText}`)} `
    .replace(TECHNICAL_REMOTE, ' ')
    .replace(TECHNICAL_HYBRID, ' ')
    .replace(NOT_ABOUT_THIS_JOB, ' ');
  if (/\b(remote|home\s?office|homeoffice|ortsunabhaengig|telearbeit)\b/.test(headline)
      && !/\b(vor ort|onsite|on site|praesenz|kein\s+home\s?office|no remote)\b/.test(headline)) {
    return 'remote';
  }

  // Symmetric, and for the same reason: a title saying vor Ort is a claim
  // about the role, and it must beat a body that merely mentions remote —
  // "Systems Engineer, vor Ort in Berlin" whose duties include remote support.
  if (/\b(vor ort|onsite|on site|praesenz)\b/.test(headline)) return 'onsite';

  const raw = String(text);

  // Lines that are bare perk bullets are pulled out before the text is read,
  // and remembered — if they were the ONLY mention, the answer is hybrid.
  const lines = raw.split(/\r?\n/);
  const perkOnlyLines = lines.filter((l) => PERK_BULLET.test(l.trim()));
  const body = lines
    .filter((l) => !PERK_BULLET.test(l.trim()))
    .join('\n')
    .replace(TECHNICAL_REMOTE, ' ')
    .replace(TECHNICAL_HYBRID, ' ')
    .replace(NOT_ABOUT_THIS_JOB, ' ')
    .replace(PERK_ALLOWANCE, ' ');

  const t = ` ${slug(`${body} ${locationText}`)} `;

  // A STRONG signal: the role itself is remote.
  // A HIGH PERCENTAGE of home office is a strong claim, however many words sit
  // between the number and the noun.
  //
  // Two postings pulled back out of the reject pile by hand say the same thing:
  //
  //     "in Deutschland (100% im Homeoffice moeglich)"
  //     "die Moeglichkeit, zu fast 100% im Homeoffice zu arbeiten"
  //
  // slug() drops the % and leaves "100 im homeoffice", so the literal
  // "100 homeoffice" above cannot match -- the "im" is in the way -- and the
  // moeglich/Moeglichkeit beside it then matched the HEDGE list instead. Both
  // were filed hybrid and dropped at 309km and 639km, on adverts offering
  // full-time home office.
  //
  // 90 and up only. "50% im Homeoffice" is genuinely hybrid and must stay so,
  // which is the whole reason this is a number range rather than d+.
  const strongPercent = /\b(fast\s+)?(100|9[0-9])\s*(prozent\s*)?(im|in|aus\s+dem|von)?\s*(home\s?office|remote)\b/.test(t);

  const strong = /\b(fully remote|full remote|vollstaendig remote|komplett remote|100 remote|100 aus dem homeoffice|100 homeoffice|komplett im homeoffice|dauerhaft im homeoffice|remote first|remote only|remote position|remote role|telearbeit|ortsunabhaengig|deutschlandweit remote|work from anywhere)\b/.test(t);

  // A HEDGED one: home office offered as flexibility, at a job with an office.
  // "we also offer you the possibility of home office or temporary work from
  // abroad" made a Hannover posting 'remote', which then earned full location
  // points far beyond the radius. A perk is not a work mode.
  const hedged = /\b(possibility|option|opportunity|chance|offer|offers|opportunity)\w*\s+(of|for|to)?\s*(home\s?office|remote|mobile\s+work|work\s+from\s+home)\b/.test(t)
    || /\b(home\s?office|remote|mobile\s+work)\b\s*(is\s+)?(possible|available|option|optional|arrangement)\b/.test(t)
    || /\b(up to|bis zu)\s+\d+\s*(days?|tage)\b[^.]{0,30}\b(home\s?office|remote)\b/.test(t)
    // German hedges, which were missing entirely. Every "Homeoffice möglich"
    // in a German advert therefore read as a fully remote role — in a German
    // job search, where most of the corpus comes from. The English list had
    // been built from English postings and never revisited.
    || /\b(moeglichkeit|moeglichkeiten|option|angebot)\w*\s+(auf|zu|zur|fuer|von|nach)?\s*(home\s?office|remote|mobiles arbeiten)\b/.test(t)
    || /\b(home\s?office|remote|mobiles arbeiten)\s+(moeglich|nach absprache|anteilig|teilweise|optional)\b/.test(t)
    || /\b(anteilig|teilweise|gelegentlich|zeitweise)\s+(im|in|aus dem)?\s*(home\s?office|remote|mobiles arbeiten)\b/.test(t)
    // "Möglichkeit, teilweise im Homeoffice zu arbeiten" — the qualifier and the
    // noun are rarely adjacent in German, so the gap has to be allowed for.
    || /\bmoeglichkeit\w*[^.]{0,40}\b(home\s?office|remote|mobiles arbeiten)\b/.test(t)
    // "Flexible Arbeitszeiten und Homeoffice" in either order. This pairing is
    // boilerplate in German adverts and is a benefits line, not a work mode —
    // it was reading as fully remote on postings 400km away.
    || /\bflexible\w*\s+arbeitszeiten\s*(und|oder|sowie|&|,|:)?\s*[^.]{0,25}\b(home\s?office|remote|mobiles arbeiten)\b/.test(t)
    || /\b(home\s?office|remote|mobiles arbeiten)\b[^.]{0,25}(und|oder|sowie|&|,)\s*flexible\w*\s+arbeitszeiten\b/.test(t)
    || /\bflexible\w*[,\s]+mobiles arbeiten\b/.test(t)
    // "Persönliche Arbeitsgestaltung, Home Office, Arbeitszeiten stehen frei"
    || /\barbeitsgestaltung\b[^.]{0,40}\b(home\s?office|remote|mobiles arbeiten)\b/.test(t)
    ;

// A bare "Mobiles Arbeiten für mehr Flexibilität" was ALMOST added here as a
// hedge, and measuring stopped it. It reads like an obvious gap — the phrase is
// plainly about working from home and no pattern above catches it without a
// möglich/Möglichkeit next to the noun.
//
// But a hedge returns `hybrid`, and hybrid is gated exactly like onsite. Adding
// it re-labelled 23 postings, which changes nothing anyone sees — and demoted
// 17 from remote, of which 13 sit beyond the radius and would have been DROPPED.
// One of the 13 had been applied to. Those postings reach `remote` through the
// catch-all at the foot of this function because they say "remote" somewhere
// too, and on the evidence of that application the catch-all is right about them.
//
// So the phrase stays unmatched on purpose: all the upside was cosmetic and all
// the downside was real. A wrong keep costs a minute of reading; a wrong drop
// costs an opportunity never seen.

  // A STRONG claim beats the word "hybrid", and this order is the whole point.
  //
  // The hybrid test used to run first and short-circuit, so an advert reading
  // "Ort: Hybrid oder 100% Remote", "Hybrid und Full Remote Modell" or
  // "Remote-first approach with the option for hybrid work" came out HYBRID —
  // and hybrid is gated exactly like onsite, so a "Full Remote Option" role
  // 639km away was dropped on distance. 16 postings in the archive say fully
  // remote and are filed as hybrid.
  //
  // This is the same rule already written down one list below, where "full
  // remote möglich" must beat the hedge word it contains. It was never applied
  // to `hybrid`, which is the commonest way an advert offers both.
  if (strong || strongPercent) return 'remote';

  // German inflects its adjectives, and `\bhybrid\b` cannot match any of them.
  // "Hybrides Arbeitsmodell" — about as explicit as an advert gets — was read
  // as no opinion at all, leaving the source's guess to stand.
  if (/\bhybrid(e|es|er|en|em)?\b|\b(teilweise remote|partly remote|2 days? (in|at) (the )?office|3 days? (in|at) (the )?office|office days)\b/.test(t)) return 'hybrid';
  if (hedged) return 'hybrid';
  if (/\b(homeoffice|home office|work from home|remote)\b/.test(t)) return 'remote';
  if (/\b(on site|onsite|vor ort|in office|office based|praesenz)\b/.test(t)) return 'onsite';

  // Nothing in the body said anything, but a perk bullet did. Some remote is on
  // offer; the role has not been called remote.
  if (perkOnlyLines.length) return 'hybrid';

  return null;
}
