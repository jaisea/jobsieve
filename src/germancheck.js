import { existsSync } from 'node:fs';
import { p, readJson, writeJson, sha1 } from './util.js';
import { resolveChain } from './providers/index.js';
import { MIN_DESCRIPTION_CHARS } from './language.js';

/**
 * A second reading of German, for postings the rules are about to SHOW.
 *
 * The rules grade German from patterns, and the model is asked only about what the
 * rules could not settle — so a posting every gate passed reached the page with
 * nobody having read its German lines. This asks the model one narrow question of
 * each such posting: does the advert DEMAND German for the role, and where does it
 * say so?
 *
 * Narrow on purpose, and one-directional. It can only turn a keep into a drop, and
 * only when the model quotes a line that really is in the advert; "a plus", "helpful"
 * and "an advantage" are not a demand. Piloted on 27 of today's postings: 0 false
 * vetoes on a plus-line, and the one disagreement with a rules grade was a soft
 * "communicate in German and English" line on a posting already applied to — so the answer is
 * logged and reviewable under the language category, not hidden.
 *
 * Cached per posting AND advert text AND the profile's German level, so editing the profile
 * or re-reading a longer advert asks again and nothing else does. A refused call is
 * never a verdict: the posting is simply not checked this run.
 */

const FILE = p('data', 'german-checks.json');
export const CHECK_VERSION = 1;
const ADVERT_CAP = 9000;

const SYSTEM = `You read ONE job advert and answer a single question: does it DEMAND German for the role?
Quote the advert; never guess.
- "required": the advert makes German a requirement of the candidate — any level above beginner, e.g. "fluent German", "verhandlungssichere Deutschkenntnisse", "gute Deutschkenntnisse", "sicher auf Deutsch kommunizieren", C1/B2, native, or "German and English required".
- "nice_to_have": German is "a plus", "helpful", "an advantage", "von Vorteil", "wünschenswert", or only basic/beginner German is needed.
- "none": the advert does not ask for German.
An advert merely WRITTEN in German is not a demand unless it also asks for German. The company being German, or a German banking licence, is not a demand.
Return JSON only.`;

const SCHEMA = {
  type: 'object',
  properties: {
    german: { type: 'string', enum: ['none', 'nice_to_have', 'required'] },
    quote: { type: 'string', description: 'The exact line from the advert that demands German. Empty unless german is "required".' },
  },
  required: ['german', 'quote'],
};

const squash = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();

export const stampOf = (job, profile) => sha1(`${CHECK_VERSION}|${profile.languages?.germanLevel}|${job.descriptionText || ''}`);

export function loadChecks() {
  const fresh = { version: CHECK_VERSION, checks: {} };
  if (!existsSync(FILE)) return fresh;
  const c = readJson(FILE, fresh);
  return c.version === CHECK_VERSION ? c : fresh;
}

/** Which postings are worth a call: the advert was read, and nobody has already answered for it. */
export function isCheckable(job, { decided = new Set() } = {}) {
  if (!job?.descriptionText || job.descriptionText.length < MIN_DESCRIPTION_CHARS) return false;
  if (job.verdict?.source === 'user' || decided.has(job.fingerprint)) return false;
  return true;
}

/**
 * The model's quote must be IN the advert. A quote it made up is a hallucinated
 * requirement, and the cost of believing one is a job the user never sees.
 */
export function quoteIsReal(quote, text) {
  const q = squash(quote).replace(/^[•\-*\s]+/, '');
  return q.length >= 8 && squash(text).includes(q);
}

/** A cached "required" for exactly this advert and German level, as a drop — or null. Sync, no network. */
export function cachedDrop(job, profile, cache = loadChecks()) {
  const hit = cache.checks[job.fingerprint];
  if (!hit || hit.h !== stampOf(job, profile) || hit.german !== 'required') return null;
  return { reason: `AI: German required — "${hit.quote}"`, category: 'language', quote: hit.quote };
}

/**
 * Check the postings in `passed`. Returns the ones the model says demand German.
 *
 * `cacheOnly` (dry run, replay) answers from the cache and sends nothing: one promises
 * to write nothing and the other judges a snapshot that is not a fetch. `maxCalls` is the
 * run's remaining allowance. A rate limit stops the asking for the rest of the run and
 * leaves those postings unchecked — said so in `warnings` — rather than guessing.
 */
export async function checkGerman(passed, profile, { decided = new Set(), maxCalls = Infinity, cacheOnly = false, persist = true, pace = 0 } = {}) {
  const cache = loadChecks();
  const result = { dropped: new Map(), calls: 0, cached: 0, unchecked: 0, warnings: [], limited: null };
  const { chain } = resolveChain(profile.llm?.providers);
  const provider = chain[0];
  let dirty = false;

  for (const job of passed) {
    if (!isCheckable(job, { decided })) continue;
    const hit = cache.checks[job.fingerprint];
    if (hit && hit.h === stampOf(job, profile)) {
      result.cached++;
      const d = cachedDrop(job, profile, cache);
      if (d) result.dropped.set(job.fingerprint, d);
      continue;
    }
    if (cacheOnly || !provider || result.limited || result.calls >= maxCalls) { result.unchecked++; continue; }

    const user = `Title: ${job.title}\nCompany: ${job.company}\n\nADVERT:\n${job.descriptionText.slice(0, ADVERT_CAP)}`;
    const res = await provider.complete({ system: SYSTEM, user, schema: SCHEMA });
    result.calls++;
    if (res.rateLimited) { result.limited = res.scope || 'minute'; result.unchecked++; result.warnings.push(`German check stopped: ${res.error || 'rate limited'}`); continue; }
    if (!res.ok) { result.unchecked++; result.warnings.push(`German check failed for "${job.title}": ${res.error}`); continue; }

    let { german, quote } = res.data || {};
    // Not a verdict unless it quotes something the advert really says.
    if (german === 'required' && !quoteIsReal(quote, job.descriptionText)) { german = 'none'; quote = ''; }
    cache.checks[job.fingerprint] = { h: stampOf(job, profile), german, quote: quote || '', at: new Date().toISOString() };
    dirty = true;
    if (german === 'required') result.dropped.set(job.fingerprint, cachedDrop(job, profile, cache));
    if (pace) await new Promise((r) => setTimeout(r, pace));
  }

  if (dirty && persist) writeJson(FILE, cache);
  if (result.unchecked && !cacheOnly) result.warnings.push(`${result.unchecked} posting${result.unchecked === 1 ? '' : 's'} not German-checked this run (they are asked again next scan)`);
  return result;
}
