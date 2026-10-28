import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/* ---------- paths & json ---------- */

// `JOBHUNT_DATA_DIR` and `JOBHUNT_REPORTS_DIR` move data/ and reports/ elsewhere, for tests (and
// trial runs) that must run the real stores without touching the user's. It has to be set
// before the module that builds its path is imported — they compute it at load.
const MOVED = { data: 'JOBHUNT_DATA_DIR', reports: 'JOBHUNT_REPORTS_DIR' };
export const p = (...parts) => {
  const dir = MOVED[parts[0]] && process.env[MOVED[parts[0]]];
  return dir ? join(dir, ...parts.slice(1)) : join(ROOT, ...parts);
};

/**
 * "No fallback was given" and "the fallback is null" are different facts, and
 * conflating them broke four features.
 *
 * The guard used to be `if (fallback !== null) return fallback`, so
 * `readJson(path, null)` — which reads as "give me null if it is not there" —
 * could never return null and always threw. Four callers in apply/index.js pass
 * exactly that and each follows it with `if (!x) continue`, so each was written
 * against behaviour the function did not have: the applications list, the
 * salary fill-in on an existing folder, `apply --diff`, and `learn()`.
 *
 * It surfaced as a 500 on /api/feedback, which took down the whole "What you
 * rewrote" panel because ONE application folder had no
 * `.generation/baseline.json`. That folder is not a broken one — marking a job
 * applied without tailoring is a supported path and deliberately writes no
 * generation data, so a folder without it is the normal case, not an edge one.
 *
 * Same class as `chars === 0` rather than `!chars` in language.js: absent is
 * not empty, and a default is not a value.
 */
const NO_FALLBACK = Symbol('no fallback');

export function readJson(path, fallback = NO_FALLBACK) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    if (fallback !== NO_FALLBACK) return fallback;
    throw new Error(`Could not read JSON at ${path}: ${e.message}`);
  }
}

/**
 * Write JSON, or leave the previous file untouched.
 *
 * Every state file goes through here, and they are the whole memory of the job
 * search — `seen.json` is what stops a posting being shown twice, and losing it
 * means the next run reports four thousand jobs as new. A partial write during
 * a ten-minute run (Ctrl-C, a full disk, a crash) would truncate it.
 *
 * Write to a sibling temp file, then rename over the target. Rename is atomic
 * on one volume, and on Windows Node maps it to MoveFileEx with
 * MOVEFILE_REPLACE_EXISTING, so an existing file is replaced rather than
 * refused. A crash therefore leaves either the old file or the new one.
 */
/**
 * A one-line progress counter with an ETA measured from its own throughput.
 *
 * Three steps in a run are long enough to look hung — normalizing 7,000
 * postings, reading 1,500 adverts, adjudicating a couple of hundred — and each
 * printed a heading and then nothing for minutes.
 *
 * The rate is MEASURED rather than assumed. A constant ("~4ms a posting") is
 * right on the machine it was measured on and wrong everywhere else, and goes
 * stale the first time a gate gets more expensive. Extrapolating from what this
 * run has actually done so far needs no maintenance and self-corrects.
 *
 * No ETA is shown before there is evidence for one. The first few items include
 * warm-up — a cold regex cache, the first HTTP connection — and an estimate
 * from two samples is a number pulled out of the air with a decimal point on it.
 *
 * Writes with  and no newline, so it occupies one line and the finished
 * output stays readable. Silent when not a TTY, because a redirected log should
 * not collect thousands of progress lines.
 */
export function progress(total, { label = '', every = 25, minSamples = 20 } = {}) {
  const started = Date.now();
  const live = Boolean(process.stdout.isTTY) && total > 0;
  let done = 0;

  return {
    tick(n = 1) {
      done += n;
      if (!live || (done % every && done !== total)) return;
      const elapsed = Date.now() - started;
      let eta = '';
      if (done >= minSamples && done < total) {
        const remaining = ((elapsed / done) * (total - done)) / 1000;
        eta = remaining < 90
          ? ` · ~${Math.round(remaining)}s left`
          : ` · ~${Math.round(remaining / 60)} min left`;
      }
      process.stdout.write(`  ${done}/${total}${label ? ' ' + label : ''}${eta}   \r`);
    },
    done() {
      if (live) process.stdout.write(' '.repeat(60) + '\r');
    },
  };
}

/**
 * Run `fn`, retrying while Windows says the file is in use.
 *
 * Replacing a file another process holds open is refused with EPERM (or EBUSY / EACCES):
 * Windows will not rename over a file that was opened without delete-sharing. The holder is a
 * backup, an antivirus scan, a file-manager preview or a plain copy of the data folder, and it
 * lets go within a moment. A scan that had spent minutes judging a batch died on exactly this
 * — "EPERM: rename 'rejected.json.tmp' -> 'rejected.json'" — because a copy of the folder was
 * reading rejected.json at that instant. Nothing was lost (the batch was still owed and was
 * resumed), but a second of patience is cheaper than a failed scan.
 *
 * Only these three codes are retried; anything else is a real error and surfaces at once.
 * Backoff 25ms, 50ms, 100ms… for 8 tries is about 3 seconds in all, then the original error.
 */
const LOCKED = new Set(['EPERM', 'EBUSY', 'EACCES']);

export function retryLocked(fn, { tries = 8, wait = sleepSync } = {}) {
  for (let i = 0; ; i++) {
    try {
      return fn();
    } catch (e) {
      if (!LOCKED.has(e?.code) || i >= tries - 1) throw e;
      wait(25 * 2 ** i);
    }
  }
}

/** A blocking sleep: writeJson is synchronous, and so is everything that calls it. */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function writeJson(path, data, { pretty = true } = {}) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    // `pretty: false` exists for one caller: data/fetched.json is ~34MB, and
    // two-space indentation on a file that size buys nothing anyone will read
    // while costing a large fraction of it again. It is a machine artefact,
    // overwritten every run.
    //
    // The atomic part is NOT optional, which is why this is a flag here rather
    // than a writeFileSync somewhere else. fetched.js used to write directly,
    // and it is the file that represents real API spend — a crash mid-write
    // leaves a truncated snapshot that is only discovered later, when --replay
    // refuses to run.
    writeFileSync(tmp, pretty ? JSON.stringify(data, null, 2) : JSON.stringify(data), 'utf8');
    retryLocked(() => renameSync(tmp, path));
  } catch (e) {
    try { if (existsSync(tmp)) unlinkSync(tmp); } catch { /* the write already failed; this is tidying */ }
    throw e;
  }
}

/** Minimal .env loader — avoids a dotenv dependency. */
export function loadEnv() {
  const envPath = p('.env');
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/i);
    if (!m) continue;
    let val = m[2].trim();

    // Quoted values are taken whole — a password may legitimately contain #.
    // Unquoted, a # preceded by whitespace starts a comment, matching dotenv.
    // Note this does NOT rescue `KEY=value#oldvalue`: with no space that is one
    // value, in every dotenv implementation, and silently truncating it would
    // be worse than leaving it visibly wrong.
    const quoted = /^(["']).*\1$/.test(val);
    if (quoted) val = val.slice(1, -1);
    else val = val.replace(/\s+#.*$/, '').trim();

    if (val && !process.env[m[1]]) process.env[m[1]] = val;
  }
}

/* ---------- strings ---------- */

export const sha1 = (s) => createHash('sha1').update(s).digest('hex').slice(0, 16);

/** Lowercase, strip diacritics/umlauts, collapse to single spaces. */
export function slug(s = '') {
  return String(s)
    .toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * "50% remote - ", "100 % Homeoffice | ", "Hybrid: ": a work-mode or percentage
 * label written before the real title. Only a label made of these words is
 * removed, so "Remote Sales Engineer - Berlin" keeps its role.
 */
const LEADING_TAG = /^\s*(?:\d{1,3}\s*%\s*)?(?:(?:fully\s+|full\s+)?remote|home\s*-?\s*office|hybrid|mobiles?\s+arbeiten|onsite)(?:\s*(?:\/|&|und|and)\s*(?:remote|home\s*-?\s*office|hybrid))*\s*[-–—|:/]\s+/i;

/**
 * Strip the noise German/EU postings wrap around titles, so the same role from
 * two sources fingerprints identically.
 *   "Senior DevOps Engineer (m/w/d) - Remote | Req #4821"  ->  "devops engineer"
 */
export function canonicalTitle(title = '') {
  let t = String(title)
    .replace(/\((?:m|w|f|d|x|a|s)(?:\s*[\/|]\s*(?:m|w|f|d|x|a|s))+\)/gi, ' ')
    .replace(/\b(?:m|w|f|d|x)\s*[\/|]\s*(?:m|w|f|d|x)(?:\s*[\/|]\s*(?:m|w|f|d|x))?\b/gi, ' ')
    .replace(/\b(?:req(?:uisition)?|job|ref(?:erence)?)\.?\s*#?\s*\d+\b/gi, ' ')
    .replace(/#\d+/g, ' ')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\((?:remote|hybrid|onsite|vollzeit|teilzeit|full[- ]time|part[- ]time|befristet|unbefristet)[^)]*\)/gi, ' ')
    // A promo tag IN FRONT of the title is not the title. Adzuna carries
    // "50% remote - Azure DevOps Engineer" and "50% remote - Cloud Platform
    // Engineer" for one employer: the suffix cut below kept "50% remote" and
    // threw the ROLE away, so both postings got one fingerprint and one was
    // swallowed (911267cd). Strip the tag first so the cut only ever removes
    // what follows the real title.
    .replace(LEADING_TAG, ' ');

  // The cut must never leave nothing to identify the role. If the part before
  // the separator carries no word of its own (a bare number, a lone tag not
  // listed above), the title is what follows the separator.
  const cut = t.replace(/\s+[-–—|/]\s+.*$/, ' ');
  t = /[a-zà-ÿ]{3,}/i.test(cut) ? cut : t;

  t = slug(t);

  const drop = new Set([
    'senior', 'sr', 'junior', 'jr', 'staff', 'lead', 'principal', 'head', 'of',
    'chief', 'expert', 'experienced', 'the', 'a', 'an', 'i', 'ii', 'iii', 'iv',
    'w', 'm', 'd', 'f', 'x', 'mwd', 'fmd', 'mfd', 'gn',
    'vollzeit', 'teilzeit', 'remote', 'hybrid', 'onsite', 'fulltime', 'parttime',
  ]);

  // Job titles use these interchangeably. Folding them makes "Kubernetes
  // Developer" match a "kubernetes engineer" target, and improves dedupe.
  const synonyms = {
    developer: 'engineer', dev: 'engineer', entwickler: 'engineer',
    k8s: 'kubernetes', ingenieur: 'engineer',
  };

  return t.split(' ')
    .filter((w) => w && !drop.has(w))
    .map((w) => synonyms[w] || w)
    .join(' ');
}

/**
 * Whole-word / whole-phrase containment on slugged text.
 *
 * THE ONLY approved way to test whether text contains a term. Plain
 * `.includes()` caused real false drops: "intern" matched "International" and
 * "Internal Platform Engineer", "sales" matched "Salesforce". Every keyword
 * gate routes through here.
 *
 * @param {string} text  raw or already-slugged text
 * @param {string} term  word or multi-word phrase
 */
export function hasPhrase(text, term) {
  const t = slug(term);
  if (!t) return false;
  const hay = ` ${slug(text)} `;
  return new RegExp(`(^|\\s)${t.replace(/\s+/g, '\\s+')}($|\\s)`).test(hay);
}

/**
 * Does `text` name this skill, however the writer chose to punctuate it?
 *
 * One definition, because there were four near-copies of this regex and they
 * had already drifted: the stack matcher tolerated a trailing plural and the
 * scorer did not, so the two disagreed about whether "containers" was a match.
 *
 * The separator inside a term is OPTIONAL, which is the part that matters.
 * Adverts write CI/CD, CI-CD, CI CD and CICD; ArgoCD and Argo CD; Key Vault and
 * KeyVault. slug() flattens punctuation to a space, so `[^a-z0-9]*` lets one
 * config entry cover every spelling — "ci/cd" alone now catches all four, and
 * "argo cd" catches ArgoCD. Without it each spelling needed its own entry, and
 * an advert using two of them counted twice.
 *
 * Still WHOLE-word at the ends: `git` cannot match inside github, and the
 * concatenated forms this admits — cicd, argocd, keyvault, sqlserver — are not
 * words that occur by accident.
 */
/**
 * Two caches, because this is called 87 times per posting with the same text.
 *
 * `matchStack` asks about every term in profile.skills in a row, and the scorer
 * asks again. Each call used to slug the WHOLE advert — six string passes and a
 * Unicode normalize over ~6,000 characters — and compile a fresh RegExp for a
 * term that has not changed since the file was read. Neither depends on the
 * loop, so both were pure repetition: measured at 30.97ms a posting, where
 * normalizing 7,017 of them is two and a half minutes of a run.
 *
 * The term cache is unbounded on purpose: the terms come from the profile, so
 * there are under a hundred of them and they never vary at runtime.
 *
 * The text cache holds exactly ONE entry, which is the shape of the access —
 * 87 consecutive questions about one advert, then the next advert. A larger
 * cache would keep every advert in a 7,000-posting run alive in memory to serve
 * a hit rate this already gets.
 */
const skillPatterns = new Map();
let lastSkillText = null;
let lastSkillSlug = '';

export function hasSkill(text, term) {
  const t = slug(term);
  if (!t) return false;

  let re = skillPatterns.get(t);
  if (!re) {
    // No /g flag, so .test() keeps no lastIndex and the instance is safe to
    // share between calls. With /g it would match every other time.
    re = new RegExp(`(^|[^a-z0-9])${t.replace(/ /g, '[^a-z0-9]*')}s?([^a-z0-9]|$)`);
    skillPatterns.set(t, re);
  }

  const str = String(text);
  if (str !== lastSkillText) {
    lastSkillText = str;
    lastSkillSlug = ` ${slug(str)} `;
  }
  return re.test(lastSkillSlug);
}

/** First term in `list` that appears as a whole word/phrase in `text`. */
export const findPhrase = (text, list) => list.find((term) => hasPhrase(text, term));

/** Company names differ cosmetically across sources: "SAP SE" vs "SAP". */
export function canonicalCompany(name = '') {
  const drop = new Set([
    'gmbh', 'ag', 'se', 'kg', 'gmbhcokg', 'co', 'mbh', 'inc', 'llc', 'ltd',
    'limited', 'corp', 'corporation', 'holding', 'group', 'gruppe', 'deutschland',
    'germany', 'international', 'the', 'and', 'sa', 'nv', 'bv', 'aps', 'oy', 'ab',
  ]);
  return slug(name).split(' ').filter((w) => w && !drop.has(w)).join(' ') || slug(name);
}

export function stripHtml(html = '') {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    // Named entities beyond the five above. `&middot;` is the one that mattered:
    // LinkedIn separates company from location with it, so leaving it encoded
    // meant the separator was invisible — 60 postings kept a literal "&middot;"
    // in their title and 64 recorded their company as "LinkedIn".
    .replace(/&(middot|bull|ndash|mdash|hellip|rsquo|lsquo|rdquo|ldquo|apos|euro|deg|times|laquo|raquo|shy);/g,
      (_, n) => ({
        middot: '\u00b7', bull: '\u2022', ndash: '\u2013', mdash: '\u2014', hellip: '\u2026',
        rsquo: '\u2019', lsquo: '\u2018', rdquo: '\u201d', ldquo: '\u201c', apos: "'",
        euro: '\u20ac', deg: '\u00b0', times: '\u00d7', laquo: '\u00ab', raquo: '\u00bb', shy: '',
      }[n] ?? ''))
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export const escapeHtml = (s = '') =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/* ---------- dates ---------- */

export function parseDate(v) {
  if (!v) return null;
  if (typeof v === 'number') return new Date(v < 1e12 ? v * 1000 : v);
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

export const daysSince = (d) => (d ? (Date.now() - d.getTime()) / 86400000 : null);

export const isoDay = (d = new Date()) => d.toISOString().slice(0, 10);

/* ---------- http ---------- */

let HTTP = { timeoutMs: 30000, retries: 2, userAgent: 'jobsieve/1.0' };
export const configureHttp = (cfg) => { HTTP = { ...HTTP, ...cfg }; };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * fetch with timeout, retry on 429/5xx, and a descriptive error.
 * Returns { ok, status, data, text, error }. Never throws — callers decide.
 */
export async function httpJson(url, { headers = {}, method = 'GET', body, retries = HTTP.retries } = {}) {
  let lastErr = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        method,
        body,
        headers: { 'User-Agent': HTTP.userAgent, Accept: 'application/json', ...headers },
        signal: AbortSignal.timeout(HTTP.timeoutMs),
      });
      const text = await res.text();

      if ((res.status === 429 || res.status >= 500) && attempt < retries) {
        await sleep(800 * (attempt + 1));
        continue;
      }
      if (!res.ok) return { ok: false, status: res.status, error: `HTTP ${res.status}`, text };

      try {
        return { ok: true, status: res.status, data: JSON.parse(text), text };
      } catch {
        return { ok: false, status: res.status, error: 'invalid JSON', text };
      }
    } catch (e) {
      lastErr = e;
      if (attempt < retries) await sleep(800 * (attempt + 1));
    }
  }
  return { ok: false, status: 0, error: lastErr?.message || 'network error' };
}

/** Run async tasks with bounded concurrency, preserving input order. */
export async function pool(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      try {
        results[i] = await fn(items[i], i);
      } catch (e) {
        results[i] = { __error: e.message };
      }
    }
  });
  await Promise.all(workers);
  return results;
}

/* ---------- console ---------- */

const C = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', blue: '\x1b[36m',
};
export const log = {
  info: (m) => console.log(m),
  dim: (m) => console.log(`${C.dim}${m}${C.reset}`),
  ok: (m) => console.log(`${C.green}✓${C.reset} ${m}`),
  warn: (m) => console.log(`${C.yellow}!${C.reset} ${m}`),
  err: (m) => console.log(`${C.red}✗${C.reset} ${m}`),
  head: (m) => console.log(`\n${C.bold}${m}${C.reset}`),
  step: (m) => console.log(`${C.blue}→${C.reset} ${m}`),
};
