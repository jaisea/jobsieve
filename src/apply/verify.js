/**
 * The fact-check, between generation and PDF.
 *
 * The rest of this project refuses to fabricate facts about a job posting. This
 * is the same rule turned around, and it matters more: a wrong posting verdict
 * costs a minute of reading, a wrong CV claim goes out under the user's name and
 * has to be defended in an interview.
 *
 * Deterministic on purpose. The adversarial review call catches tone and
 * overclaiming; this catches the mechanical failures — a technology never used,
 * a number that appears nowhere, an employer quietly renamed — and it catches
 * them the same way every time.
 */

const norm = (s) => String(s || '').toLowerCase();

/** Keys in master.json that record what the user has NOT done. They never permit. */
const DENY_KEYS = new Set(['familiar', 'avoid', 'banned', 'notUsed']);

/**
 * Capitalised tokens, EXCLUDING the first word of a sentence.
 *
 * An earlier version required two CamelCase humps, which meant ordinary
 * technology names — Pulumi, Terraform, Docker, Azure — matched nothing at all
 * and the check waved through any invented tool. Most technology names are a
 * single capitalised word, so that shape has to be included.
 *
 * Sentence-initial words are skipped instead: "Built platforms with Pulumi"
 * should flag Pulumi and ignore Built. Capitalisation mid-sentence is the
 * signal; anything else is grammar.
 */
const TECH_SHAPED = /(?<![.!?]\s|^)\b([A-Z][A-Za-z0-9]*(?:[.+#-][A-Za-z0-9]+)*)\b/gm;

/**
 * English words that match TECH_SHAPED but are not technologies. Without this
 * every sentence-initial ALLCAPS heading or acronym like "SRE" trips the check.
 */
const NOT_TECH = new Set([
  // Common words that appear capitalised mid-sentence, plus generic acronyms and
  // company-name suffixes. Anything here is grammar or boilerplate, not a claim.
  'I', 'A', 'An', 'The', 'And', 'Or', 'It', 'In', 'On', 'At', 'To', 'As', 'By', 'Of',
  'My', 'We', 'Our', 'This', 'That', 'These', 'Those', 'For', 'From', 'With', 'While',
  'January', 'February', 'March', 'April', 'May', 'June', 'July', 'August',
  'September', 'October', 'November', 'December', 'Present',
  'CI', 'CD', 'IT', 'HR', 'QA', 'UAT', 'DR', 'SLA', 'SLO', 'KPI', 'ROI', 'EU', 'US', 'UK', 'DE',
  'PhD', 'MSc', 'BSc', 'GmbH', 'AG', 'SE', 'NV', 'BV', 'Ltd', 'Inc', 'Germany', 'India',
  // Letter and CV vocabulary — roles, sections and salutations, not tools.
  'Hiring', 'Manager', 'Team', 'Lead', 'Engineer', 'Consultant', 'Analyst', 'Administrator',
  'Senior', 'Staff', 'Principal', 'Summary', 'Experience', 'Skills', 'Certifications',
  'Education', 'Achievements', 'Key', 'Configuration', 'Management', 'Release', 'Build',
  // Generic capitalised nouns that job adverts and CVs use constantly but which
  // name no product: "Cloud", "Platform", "Infrastructure". A first run blocked
  // a PDF because the letter said "Cloud" and the whitelist only holds concrete
  // products like Azure and Kubernetes.
  'Cloud', 'Platform', 'Infrastructure', 'Security', 'Networking', 'Automation',
  'Monitoring', 'Logging', 'Alerting', 'Deployment', 'Pipeline', 'Pipelines',
  'Environments', 'Systems', 'Operations', 'Engineering', 'Development',
  'Architecture', 'Reliability', 'Scalability', 'Availability', 'Compliance',
  'Enterprise', 'Production', 'Provider', 'Service', 'Services', 'Solutions', 'Code',
  // 'Internal Developer Platforms' — the standard name for the thing, three
  // ordinary words, none of them a product.
  'Internal', 'External', 'Developer', 'Delivery', 'Governance', 'Resilience',
  // Found by comparing two models on one posting: both wrote ordinary English
  // that the check called an invented product.
  'API', 'APIs', 'European', 'Europe', 'Global', 'Regional', 'Digital', 'Technical',
].map((w) => w.toLowerCase()));

/**
 * A figure, as opposed to digits that happen to sit inside a name.
 *
 * The lookbehind is load-bearing: without it "Auth0," yielded the "figure" `0,`
 * and blocked a PDF over a technology name. Trailing punctuation is excluded
 * too, so "€200K." and "€200K" are the same claim.
 */
const NUMERIC = /(?<![A-Za-z\d])\d[\d.,]*\d|(?<![A-Za-z\d])\d(?![\d.,])/g;

/** Normalise a matched figure for comparison: drop trailing separators. */
const num = (s) => norm(String(s).trim().replace(/[.,]+$/, ''));

/**
 * Every number the user has ever claimed, gathered from master.json. A figure
 * in generated text that is not here was invented.
 */
function knownNumbers(master) {
  const found = new Set();
  const walk = (v) => {
    if (typeof v === 'string') for (const m of v.matchAll(NUMERIC)) found.add(num(m[0]));
    else if (typeof v === 'number') found.add(String(v));
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.entries(v).forEach(([k, x]) => { if (!k.startsWith('_')) walk(x); });
  };
  walk(master);
  // Years are dates, not claims — they appear throughout and are never invented.
  for (const y of [...found]) if (/^(19|20)\d\d$/.test(y)) found.delete(y);
  return found;
}

/**
 * Synonyms for whitelisted technologies.
 *
 * master.facts.technologies records what the user has used, not every name it goes
 * by. It holds "GCP"; the generated letter wrote "AWS, Azure, and Google
 * Cloud" — the same technology — and the check blocked it as two inventions,
 * "Google" and "Cloud". That is what stopped one application's PDF. A synonym is not a
 * fabrication, so it is resolved here rather than by loosening the check.
 *
 * Each alias is only allowed if the canonical name is actually in the
 * whitelist: someone who has never touched GCP still cannot claim Google Cloud.
 */
const ALIASES = {
  gcp: ['google cloud platform', 'google cloud', 'google'],
  aws: ['amazon web services', 'amazon'],
  azure: ['microsoft azure', 'microsoft'],
  kubernetes: ['k8s'],
  'azure devops': ['ado', 'vsts'],
  postgresql: ['postgres'],
  elasticsearch: ['elastic'],
};

/** Any capitalised word, wherever it sits. Used when harvesting what is ALLOWED. */
const ANY_CAPITALISED = /\b([A-Z][A-Za-z0-9]*(?:[.+#-][A-Za-z0-9]+)*)\b/g;

/**
 * Everything the generated text is allowed to say.
 *
 * The sentence-initial exclusion in TECH_SHAPED is right when hunting for
 * suspects and wrong when gathering permissions: a first run flagged
 * "Acme Security" as an invented technology because the company name only ever
 * appeared at the start of a sentence in its own job description, so it was
 * never harvested. Permissions therefore use ANY_CAPITALISED.
 *
 * Also allowed, and missing from that first run: the user's own city, work
 * rights and job titles. "German", "Permanent", "Resident", the home city's
 * name and "Staff" were all blocked as unrecognised technologies.
 */
function allowedTech(master, sourceText, job) {
  // A multi-word product must also permit its own words. The suspect scan
  // tokenises by capitalised word, so "Azure Key Vault" arrives as three tokens
  // while the whitelist held one string — and every one of the sixteen
  // multi-word entries blocked its own PDF, written exactly as listed:
  // "GitHub Actions", "Argo CD", "Docker Compose", "JFrog Artifactory". That
  // was the single largest source of blocked applications, and none of them
  // were inventions.
  const set = new Set();
  for (const tech of master.facts?.technologies || []) {
    const t = norm(tech);
    if (!t) continue;
    set.add(t);
    for (const word of t.split(/\s+/)) if (word) set.add(word);
  }
  const add = (s) => { for (const m of String(s ?? '').matchAll(ANY_CAPITALISED)) set.add(norm(m[0])); };

  for (const [canon, names] of Object.entries(ALIASES)) {
    if (!set.has(canon)) continue;
    for (const n of names) for (const word of n.split(' ')) set.add(word);
  }

  // A reworded bullet may repeat anything the original said.
  add(sourceText);

  // EVERYTHING master.json says, not a hand-picked list of fields.
  //
  // The rule is "the user may say what their own master data says", and that was
  // approximated by naming a dozen paths — which drifted the moment anything
  // was added. A story recorded under a new key described failing over from
  // West Europe to North Europe, and the letter was refused for inventing
  // "West", "Europe" and "North". Walking the whole document keeps the rule and
  // the implementation the same thing. Keys starting with _ are notes to the
  // human and are skipped, as they are everywhere else.
  // `familiar` is the one part of master.json that must NOT grant permission:
  // it records tools the user knows personally and has never operated in production,
  // and it exists precisely so those cannot be claimed. Walking the whole
  // document turned it into a permit list and let "Microsoft Copilot" through —
  // the exact claim an application had already been refused for.
  // master.json holds two kinds of fact: what the user HAS, and what they
  // explicitly have NOT. Walking the whole document conflates them, and the negative lists
  // then grant exactly the permission they exist to withhold. It has happened
  // twice — `familiar` let "Microsoft Copilot" through, and recording
  // `notUsed: ['Keycloak', ...]` made Keycloak claimable the moment it was
  // written down. A test asserts every value in these keys is still refused, so
  // the next negative list added to master.json fails loudly instead.
  const NEVER_PERMITS = DENY_KEYS;
  const walk = (v) => {
    if (typeof v === 'string') add(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) if (!k.startsWith('_') && !NEVER_PERMITS.has(k)) walk(x);
    }
  };
  walk(master);

  // Who the letter is written to. Naming the company and the role is the whole point.
  if (job) { add(job.company); add(job.title); add(job.location); }

  return set;
}

/**
 * Check one generated document.
 *
 * `source` is the text this was derived from — the original paragraphs for a
 * resume edit, or the whole posting plus template for a letter. Words already
 * present there are not inventions.
 */
export function verify({ generated, source, master, job = null, kind = 'document' }) {
  const issues = [];
  const text = String(generated);

  /* ---- technologies ---- */
  const allowed = allowedTech(master, source, job);
  const seen = new Set();
  for (const m of text.matchAll(TECH_SHAPED)) {
    const tok = m[0];
    // Plural tolerated: "Platform" was in the list and "Platforms" was not, so
    // "Internal Developer Platforms" blocked a PDF on all three words. Only a
    // trailing s is stripped, and only to consult this list — a real product
    // whose singular happens to be an English noun is not affected, because it
    // would have to BE that noun to match.
    const ordinary = (w) => NOT_TECH.has(w) || (w.endsWith('s') && NOT_TECH.has(w.slice(0, -1)));
    if (ordinary(norm(tok)) || seen.has(norm(tok))) continue;
    seen.add(norm(tok));

    // "Linux-based" and "Azure-hosted" are ordinary English built on an allowed
    // noun, not new technologies. Judge the base word.
    const base = norm(tok).split(/[-.]/)[0];
    if (allowed.has(base)) continue;

    if (!allowed.has(norm(tok))) {
      // WARNS rather than blocks, and the two checks have earned opposite
      // records. Over a day of real use this one refused Vault, GitHub Actions,
      // Argo CD, JFrog Artifactory, Internal Developer Platforms, Cloud, Code,
      // German, the home city's name, West Europe, APIs and European — every one
      // of them the user's own, not one an invention. The number check below has never
      // once been wrong, so that one still stops the PDF.
      //
      // This is not a free pass: a technology warning still triggers the repair
      // call, so the model is told and asked to say it another way. What changed
      // is the outcome when repair does not fix it — a warning you can read
      // rather than a document you cannot have.
      issues.push({ severity: 'warn', kind: 'technology', token: tok,
        detail: `"${tok}" is not in master.facts.technologies and does not appear in the source. If it is real, add it to master.json; the generator must never introduce one.` });
    }
  }

  /* ---- numbers ---- */
  const known = knownNumbers(master);
  const inSource = new Set([...String(source).matchAll(NUMERIC)].map((m) => num(m[0])));
  for (const m of text.matchAll(NUMERIC)) {
    const n = num(m[0]);
    if (/^(19|20)\d\d$/.test(n) || known.has(n) || inSource.has(n)) continue;
    issues.push({ severity: 'block', kind: 'number', token: num(m[0]),
      detail: `the figure "${num(m[0])}" appears in neither master.json nor the source text.` });
  }

  /* ---- banned phrasing ---- */
  for (const phrase of master.voice?.banned?.phrases || []) {
    if (norm(text).includes(norm(phrase))) {
      issues.push({ severity: 'warn', kind: 'style', token: phrase,
        detail: `"${phrase}" does not appear anywhere in your own letters — it reads as generated.` });
    }
  }

  /* ---- enthusiasm the user has not expressed ---- */
  const avoid = master.motivations?.avoid;
  if (avoid) {
    for (const a of [].concat(avoid)) {
      if (norm(text).includes(norm(a))) {
        issues.push({ severity: 'block', kind: 'motivation', token: a,
          detail: `claims interest in "${a}", which motivations.avoid says you do not want.` });
      }
    }
  }

  return {
    ok: !issues.some((i) => i.severity === 'block'),
    issues,
    blocks: issues.filter((i) => i.severity === 'block').length,
    warnings: issues.filter((i) => i.severity === 'warn').length,
    kind,
  };
}

/** Length and shape, checked against what was measured from the user's real letters. */
export function verifyLetter(paragraphs, master) {
  const issues = [];
  const words = paragraphs.join(' ').split(/\s+/).filter(Boolean).length;
  const [lo, hi] = master.voice?.measured?.range || [165, 400];

  if (words < lo) issues.push({ severity: 'warn', kind: 'length', detail: `${words} words — shorter than any letter you have sent (min ${lo}).` });
  if (words > hi) issues.push({ severity: 'warn', kind: 'length', detail: `${words} words — longer than any letter you have sent (max ${hi}). Risks running to a second page.` });

  return { ok: true, issues, words };
}


/**
 * Contradictions inside master.json itself.
 *
 * It holds both what the user HAS and what they explicitly have NOT, and nothing stopped
 * the same thing appearing in both. It happened: "Auth0" was recorded under
 * identity.notUsed while already sitting in facts.technologies, which it had
 * been all along. The check would then have quietly picked a winner — and
 * whichever it picked, the file was wrong about the user in one direction or
 * the other.
 *
 * Cheap to detect, so it is reported every run rather than left to be noticed.
 */
export function auditMaster(master) {
  const permitted = new Set((master.facts?.technologies || []).map(norm));

  const denied = new Map();          // term -> where it was denied
  const walkDenied = (v, where) => {
    if (typeof v === 'string') { denied.set(norm(v), where); return; }
    if (Array.isArray(v)) return v.forEach((x) => walkDenied(x, where));
    if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) {
        if (k.startsWith('_')) continue;
        walkDenied(x, DENY_KEYS.has(k) ? k : where);
      }
    }
  };
  for (const [k, v] of Object.entries(master)) {
    if (!k.startsWith('_')) walkDenied(v, null);
  }

  const clashes = [];
  for (const [term, where] of denied) {
    if (where && permitted.has(term)) {
      clashes.push({ term, deniedIn: where, detail: `"${term}" is in facts.technologies AND in ${where} — master.json contradicts itself about whether you have used it.` });
    }
  }
  return clashes;
}

/* ------------------------------------------------------- the summary title */

/**
 * The first summary line states who the user is, and it must survive tailoring.
 *
 * A real run re-titled the user to match the advert: "Cloud / Platform
 * Engineering lead with 12 years building and running cloud
 * platforms" came back as "Infrastructure platform engineering leader with 12
 * years administering enterprise Linux environments, virtualization, storage".
 * That is a demotion on the most-read line of the document, and it was caught
 * only because every diff is printed and read.
 *
 * The prompt forbids it in three sentences and the model did it anyway. Unlike
 * the edit cap or the letter's language, the title is a FIXED STRING, so it can
 * be checked the same way an invented number is — which is the one check that
 * has never produced a false positive.
 *
 * It blocks. A demotion is not a warning.
 */

/** Everything before " with " — the claim about who the user is, minus the elaboration. */
function titleOf(line) {
  const s = String(line || '').trim();
  if (!s) return null;
  const cut = s.split(/\s+with\s+/i)[0].trim();
  // No " with " means the whole line is the title, and requiring the rewrite to
  // reproduce it verbatim would forbid the edit entirely. Nothing to check.
  return cut && cut.length < s.length ? cut : null;
}

/**
 * Compared loosely on purpose. Capitalisation and the spacing around a slash
 * carry no meaning here, and blocking a PDF over "DevOps/SRE" vs "DevOps / SRE"
 * would be exactly the kind of false positive that got the technology check
 * demoted to a warning.
 */
const normaliseTitle = (s) => String(s || '')
  .toLowerCase()
  .replace(/\s*\/\s*/g, '/')
  .replace(/[\s\u00a0]+/g, ' ')
  .replace(/[.,;:]+$/, '')
  .trim();

export function verifySummaryTitle({ before, after, master }) {
  const issues = [];

  // Prefer the line actually being replaced. Falling back to master means the
  // check still works if the CV and master.positioning drift apart, but the
  // line itself is the truth about what is being changed.
  const expected = titleOf(before) || titleOf(master?.positioning?.headline);
  if (!expected) return { ok: true, issues, title: null };

  const got = titleOf(after);
  if (got === null) {
    // The rewrite dropped the " with " structure entirely, so the whole line is
    // now a title. Check it opens with the old one rather than giving up.
    if (normaliseTitle(after).startsWith(normaliseTitle(expected))) {
      return { ok: true, issues, title: expected };
    }
    issues.push({
      severity: 'block', kind: 'title', token: expected,
      detail: `the summary no longer opens with "${expected}" — it now reads "${String(after).slice(0, 80)}"`,
    });
    return { ok: false, issues, title: expected };
  }

  if (normaliseTitle(got) !== normaliseTitle(expected)) {
    issues.push({
      severity: 'block', kind: 'title', token: expected,
      detail: `your job title was changed from "${expected}" to "${got}". The summary line states who you are; tailor what follows it, not the title.`,
    });
  }

  return { ok: !issues.length, issues, title: expected };
}

// Last in the file: it names consts declared above, and `const` does not hoist.
export const __testables = { TECH_SHAPED, ANY_CAPITALISED, NUMERIC, knownNumbers, allowedTech, NOT_TECH, titleOf, normaliseTitle };
