import { existsSync } from 'node:fs';
import { p, readJson, writeJson, pool, log, sha1 } from './util.js';
import { resolveChain } from './providers/index.js';
import * as pending from './pending.js';
import { nextQuotaReset, MINUTE_BACKOFF_MS } from './awaiting.js';

/**
 * LLM ADJUDICATION LAYER
 *
 * The rules layer decides everything it can decide certainly and escalates the
 * rest here. This module never sees a job the rules already settled, so its
 * cost scales with genuine ambiguity rather than with corpus size.
 *
 * Three guarantees this module owes the rest of the pipeline:
 *   1. It never throws. Any failure — no key, rate limit, out of credit, bad
 *      JSON — degrades to the rules verdict, tagged so the report can say so.
 *   2. Verdicts are cached by fingerprint, so a re-run costs nothing.
 *   3. Every verdict carries its reasoning, so a wrong call is diagnosable
 *      rather than mysterious.
 */

const CACHE = p('data', 'verdicts.json');
const CACHE_VERSION = 2;   // bumped: prompt now states settled facts, so v1 verdicts are not comparable

/** Structured-output schema. Constrains the reply so no parsing heuristics are needed. */
const VERDICT_SCHEMA = {
  type: 'object',
  properties: {
    decision: {
      type: 'string',
      enum: ['keep', 'drop'],
      description: 'keep = worth showing the candidate; drop = not a fit',
    },
    confidence: {
      type: 'string',
      enum: ['high', 'medium', 'low'],
      description: 'How clearly the posting supports this decision',
    },
    category: {
      type: 'string',
      enum: ['language', 'location', 'role', 'other'],
      description: 'If dropping, the single factor that decided it, so rejections can be counted by cause over time. Use "other" when keeping.',
    },
    reason: {
      type: 'string',
      description: 'One sentence, max 25 words, citing the posting. This is shown to the candidate.',
    },
    resolved: {
      type: 'array',
      description: 'One entry per question asked, in the order asked.',
      items: {
        type: 'object',
        properties: {
          kind: { type: 'string' },
          answer: { type: 'string', description: 'Max 20 words.' },
        },
        required: ['kind', 'answer'],
        additionalProperties: false,
      },
    },
  },
  required: ['decision', 'confidence', 'category', 'reason', 'resolved'],
  additionalProperties: false,
};

/**
 * The candidate block used to state "Germany", a neighbouring Swiss city and "no
 * sponsorship in Germany" as literals, next to fields read from the profile.
 * So a user elsewhere got a prompt that named someone else's country and
 * someone else's neighbouring city as fact, in the one block the model is
 * forbidden to contradict.
 *
 * These render the same words for the profile that shipped, which is checked by
 * a test — the prompt is byte-identical, so no verdict is invalidated by this.
 */
const COUNTRY_NAMES = { DE: 'Germany', CH: 'Switzerland', AT: 'Austria', FR: 'France', NL: 'the Netherlands' };
const countryName = (code) => COUNTRY_NAMES[code] || code;

/** Named only when the radius actually crosses a border worth mentioning. */
function reachClause(profile) {
  const reach = profile.location?.reaches;
  return reach ? `, which reaches ${reach}` : '';
}

function sponsorshipClause(workRights) {
  const free = (workRights.sponsorshipFreeIn || []).map(countryName);
  if (!free.length) return '';
  const list = free.length === 1 ? free[0] : `${free.slice(0, -1).join(', ')} and ${free.at(-1)}`;
  return `Needs no sponsorship in ${list}.`;
}

function systemPrompt(profile) {
  const { location, languages, avoid, targetTitles, workRights } = profile;
  return `You are screening job postings for one candidate. For each posting you are asked a small number of specific questions that an automated rules layer could not answer. Answer only those questions, then decide whether the posting is worth the candidate's time.

# The candidate
- ${profile.currentTitle}, ${profile.yearsExperience} years${profile.field ? `, ${profile.field}` : ''}.
- Based in ${location.city}, ${countryName(location.country)}. Will commute up to ${location.radiusKm}km${reachClause(profile)}.
- ${workRights.residence}, ${workRights.citizenship} citizen. ${sponsorshipClause(workRights)}
- Core stack: ${coreStack(profile).join(', ')}.
- German ${languages.germanLevel}, studying toward ${languages.germanTarget}. English fluent.
- Notice period ${profile.noticePeriodMonths} months, so a realistic start date is 4-6 months out.

# Target roles
${targetTitles.strong.join(', ')}. Equivalent roles under different names count.

# Hard exclusions
- Roles requiring German above ${languages.germanLevel}.

## German: use this mapping, do not estimate
German ads rarely name a CEFR level, so map the wording literally:

| Posting says | CEFR | Verdict at ${languages.germanLevel} |
|---|---|---|
| "Grundkenntnisse", "basic German", "German a plus", "willingness to learn" | A2-B1 | fits — keep |
| "gute Deutschkenntnisse", "gute Deutsch- und Englischkenntnisse", "sicher in Deutsch", "good command of German" | **B2** | **stretch — keep, but say it is above the candidate's level** |
| "sehr gute", "verhandlungssicher", "fließend", "C1", "C2", "Muttersprache" | C1+ | too high — drop |

Note the hyphenated compound: "gute Deutsch- und Englischkenntnisse" shares one noun
across two languages and means good German AND good English — treat it exactly as
"gute Deutschkenntnisse".

**"gute Deutschkenntnisse" is B2. It does NOT fit A2 or B1.** Never describe it as
matching the candidate's level. If the posting demands it, that is a stretch at best — say so
plainly in your reason rather than reasoning your way to a comfortable answer.
- Roles not reachable from ${location.city}: onsite beyond ${location.radiusKm}km, or remote roles restricted to another country.

**${location.city} is in Germany.** A role that is remote within Germany, remote in the EU,
or remote worldwide is therefore REACHABLE — it does not need to name ${location.city}, and
"remote (Germany)" is a pass, not a restriction. Only a remote role tied to a *different*
country is out of reach. Roles listing a German office while being fully remote are also
reachable; the office is where the team sits, not a requirement to be near it.

# How to decide
Judge only from the posting text. Where the posting is silent, say so rather than assuming — an unstated requirement is not a requirement. Prefer keeping a borderline posting over dropping it: a wrong keep costs the candidate one minute of reading, a wrong drop costs the candidate an opportunity they never see.

**Answer the questions you are asked.** Anything listed under "Already settled" has been
resolved by the rules from structured data you cannot see — do not revisit it, and never
drop a posting on a dimension that appears there. If something outside the questions looks
genuinely disqualifying, say so in your reason, but only decide against the posting when
the posting itself states it.

Your "reason" is shown to the candidate, so make it specific to this posting and quote the deciding phrase where there is one. Never write a generic reason like "good match".`;
}

/**
 * What the rules already resolved, stated as fact.
 *
 * Measured problem: postings with `remoteScope: 'DE'` were escalated for an
 * unrelated question — German, say — and the model dropped them on LOCATION
 * anyway, reasoning that "remote within Germany" did not explicitly permit
 * the home city. The home city is in Germany. The gate had already settled it; the model
 * simply could not see that, because the prompt only showed the raw fields.
 *
 * Only dimensions NOT being asked about appear here, so this can never
 * contradict a question.
 */
/**
 * Does this cached answer cover the questions being asked NOW?
 *
 * The cache is keyed on the fingerprint alone, so a posting that was judged
 * once is never judged again — including when a new escalation starts asking
 * something the model was never shown. That is silent: the new question is
 * written, the measurement says N postings will escalate, and the ones that
 * already hold a verdict quietly skip it.
 *
 * Found when the work-mode escalation was added: 5 of the 28 postings it was
 * built for held a verdict given before the question existed.
 *
 * An entry with no `asked` predates this and is accepted as before. Bumping
 * CACHE_VERSION instead would re-ask all 341 to correct 5.
 */
function answersCover(hit, uncertainties) {
  if (!Array.isArray(hit.asked)) return true;
  const answered = new Set(hit.asked);
  return uncertainties.every((u) => answered.has(u.kind));
}

function settledFacts(job, uncertainties, profile) {
  const asked = new Set(uncertainties.map((u) => u.kind));
  const facts = [];

  const locationAsked = asked.has('location') || asked.has('remote-scope') || asked.has('work-mode');
  if (!locationAsked) {
    if (job.workMode === 'remote') {
      facts.push(`Location: REACHABLE — remote${job.remoteScope ? ` (${job.remoteScope})` : ''}, which the candidate can take from ${profile.location.city}.`);
    } else if (job.distanceKm != null) {
      facts.push(`Location: REACHABLE — ${job.distanceKm}km from ${profile.location.city}, inside the ${profile.location.radiusKm}km limit.`);
    }
  }

  if (!asked.has('german') && job.germanRequired && job.germanRequired !== 'unknown') {
    facts.push(job.germanRequired === 'none'
      ? 'German: no requirement found in the posting.'
      : `German: "${job.germanRequired}" level, already checked against the candidate's ${profile.languages.germanLevel}.`);
  }

  return facts;
}

function userPrompt(job, uncertainties, profile) {
  const questions = uncertainties
    .map((u, i) => `${i + 1}. [${u.kind}] ${u.question}${u.evidence ? `\n   (rules found: "${String(u.evidence).slice(0, 200)}")` : ''}`)
    .join('\n');

  const facts = settledFacts(job, uncertainties, profile);

  // Descriptions run long; the deciding language is almost always in the first
  // few thousand characters (requirements sections lead), and this bounds cost.
  const body = (job.descriptionText || '').slice(0, 6000);

  return `# Posting
Title: ${job.title}
Company: ${job.company}
Location field: ${job.location}
Work mode (rules guess): ${job.workMode}${job.remoteScope ? ` / ${job.remoteScope}` : ''}
Posted: ${job.postedAt || 'unknown'}

# Description
${body || '(no description supplied by this source — judge from the title and location alone, and say so)'}

${facts.length ? `# Already settled — do not revisit\n${facts.map((f) => `- ${f}`).join('\n')}\n` : ''}
# Questions the rules could not answer
${questions}

Answer each question, then give your decision.`;
}

/* ------------------------------------------------------------------ cache */

/**
 * The profile facts that reach the prompt.
 *
 * A cached verdict was only invalidated by a hand-bumped CACHE_VERSION. But the
 * German level, the radius, the job titles and the core stack are all written
 * into the prompt, so raising the German level after an exam re-opened every
 * rules-based drop for free — as documented — while every job the MODEL had
 * dropped stayed dropped, on reasoning that no longer applied.
 *
 * Hashing them means changing the profile invalidates exactly the answers that
 * were given under the old profile, and nothing else.
 */
function profileFingerprint(profile) {
  return sha1(JSON.stringify([
    profile.languages?.germanLevel,
    profile.languages?.stretchB2,
    profile.location?.city,
    profile.location?.radiusKm,
    profile.currentTitle,
    profile.yearsExperience,
    profile.noticePeriodMonths,
    coreStack(profile),
    (profile.targetTitles?.strong || []),
    (profile.targetTitles?.good || []),
    profile.field,
    profile.relevance?.roleDescription,
  ]));
}

/**
 * The core stack, as the prompt states it and as the cache key hashes it.
 *
 * SORTED, deliberately. profile.skills is nested by kind (tools / practices /
 * adjacent) and then by tier, so flattening it produces an order that depends
 * on how the config happens to be arranged — and the prompt text is part of the
 * cache key, so a purely cosmetic reshuffle of the config would silently
 * re-open every settled verdict. Sorting makes the fingerprint depend on WHICH
 * skills are core, which is the thing that actually matters, and not on the
 * order they were typed in.
 */
function coreStack(profile) {
  const s = profile?.skills;
  if (!s) return [];
  // Flat arrays are the older shape; both are read so an unmigrated profile
  // still produces a prompt rather than throwing.
  const core = Array.isArray(s.core) ? s.core : [
    ...(s.tools?.core || []), ...(s.practices?.core || []), ...(s.adjacent?.core || []),
  ];
  return [...core].sort();
}

function loadCache(profile) {
  const profileHash = profile ? profileFingerprint(profile) : null;
  const fresh = { version: CACHE_VERSION, profileHash, verdicts: {} };

  if (!existsSync(CACHE)) return fresh;
  const c = readJson(CACHE, fresh);

  // A schema or prompt change invalidates old verdicts rather than silently
  // mixing reasoning from two different prompts.
  if (c.version !== CACHE_VERSION) return fresh;

  // So does a change to the facts the prompt states about the candidate.
  if (profileHash && c.profileHash && c.profileHash !== profileHash) {
    log.info('  profile changed — re-asking the model rather than reusing verdicts given under the old one');
    return fresh;
  }

  return { ...c, profileHash: profileHash || c.profileHash, verdicts: withoutRetired(c.verdicts) };
}

/**
 * Programming proficiency stopped being a hard exclusion on 2026-10-20, and the
 * prompt no longer names it. 195 of 1,291 cached verdicts were drops filed under
 * `programming` — reasoning from a rule that no longer exists — so those, and
 * only those, are forgotten and asked again. Bumping CACHE_VERSION instead would
 * re-ask all 1,291 to correct 195, the same trade `answersCover()` refuses.
 */
const RETIRED_CATEGORIES = new Set(['programming']);

function withoutRetired(verdicts = {}) {
  return Object.fromEntries(Object.entries(verdicts)
    .filter(([, v]) => !(v?.decision === 'drop' && RETIRED_CATEGORIES.has(v.category))));
}

const saveCache = (c) => writeJson(CACHE, c);

/** Verdicts between cache writes. Small enough to lose almost nothing, large enough not to rewrite the file per call. */
const SAVE_EVERY = 10;

/* ------------------------------------------------------------------- main */

/**
 * Adjudicate the uncertain jobs.
 *
 * @param {Array<{job, uncertainties, fallback}>} items - fallback is the rules
 *        verdict to use if the LLM cannot be reached.
 * @param {object} opts - `maxCalls` is the most requests to send (cached answers are free and do not count; the rest
 *        are held); `refresh` ignores the cache; `paused` answers from the cache only and
 *        holds the rest (the model is known to be rate limited); `onProgress` ticks per posting.
 * @returns {{verdicts: Map<fingerprint, verdict>, mode, warnings, calls, cached, held, halt}} -
 *        `held` are postings with NO verdict because the model had no room: the caller keeps and
 *        re-asks them. They are not given a rules verdict.
 */
export async function adjudicate(items, profile, opts = {}) {
  const cfg = profile.llm || {};
  const warnings = [];

  if (!items.length) {
    return { verdicts: new Map(), mode: 'rules', warnings, calls: 0, cached: 0 };
  }
  if (cfg.enabled === false) {
    warnings.push('LLM adjudication disabled in config/profile.json — using rules verdicts');
    return { verdicts: fallbackAll(items), mode: 'rules', warnings, calls: 0, cached: 0 };
  }

  const cache = loadCache(profile);

  // Stamp the profile immediately, not at save time. A run where every verdict
  // is a cache hit returns before saveCache() is ever reached, so a stamp
  // written only on save would never land on a settled cache — the
  // invalidation would then be armed only by a run that happened to do work,
  // which is not a property anyone can reason about.
  if (cache.profileHash && readJson(CACHE, {}).profileHash !== cache.profileHash) {
    saveCache(cache);
  }

  const verdicts = new Map();
  const todo = [];
  let cacheHits = 0;

  for (const item of items) {
    const hit = cache.verdicts[item.job.fingerprint];
    if (hit && !opts.refresh && answersCover(hit, item.uncertainties)) {
      verdicts.set(item.job.fingerprint, { ...hit, source: 'llm-cached' });
      cacheHits++;
    } else {
      todo.push(item);
    }
  }

  if (!todo.length) {
    return { verdicts, mode: 'llm', warnings, calls: 0, cached: cacheHits };
  }

  // The model is known to be out of room until some later moment. Answer from the
  // cache — free — and hold the rest without spending a request to be told again.
  if (opts.paused) {
    return { verdicts, mode: cacheHits ? 'llm' : 'waiting', warnings, calls: 0, cached: cacheHits, held: todo, halt: null };
  }

  const { chain, unknown } = resolveChain(cfg.providers);
  for (const u of unknown) warnings.push(`Unknown LLM provider "${u}" in LLM_PROVIDERS — ignored`);

  if (!chain.length) {
    warnings.push('No LLM provider configured — using rules verdicts. Set GEMINI_API_KEY_JUDGE in .env; the free tier needs no card.');
    for (const item of todo) verdicts.set(item.job.fingerprint, fallbackVerdict(item));
    return { verdicts, mode: 'rules-fallback', warnings, calls: 0, cached: cacheHits, providers: [] };
  }

  // Today's postings first, yesterday's leftovers after. If the quota runs out
  // again the backlog waits another day rather than crowding out new work.
  const queue = pending.load();
  const { ordered, fresh, backlog } = pending.orderNewFirst(todo, queue);

  const system = systemPrompt(profile);

  // A fatal failure (bad key, quota gone) retires the provider for the rest of
  // the run. There used to be a chain to fall through to; with Gemini alone it
  // ends adjudication, and the remaining postings take their rules verdict and
  // say so in the report — degrading rather than breaking, as before.
  const dead = new Set();
  const used = new Map();
  const judged = new Set();   // got a real verdict this run
  const deferred = [];        // failed for a reason of its own — takes its rules verdict, retried next run
  // HELD is not the same as deferred, and the difference is the point. A posting
  // the model could not answer because the project ran out of room has done
  // nothing wrong and says nothing about itself: giving it its rules verdict
  // would decide, on the strength of the very rules that were not sure, whether
  // the user ever sees it. So it gets NO verdict at all. The caller keeps it (see
  // awaiting.js) and asks again after the reset.
  const held = [];
  const limited = new Map();  // provider id -> { scope, until, reason }, once it says "not now"
  let halt = null;            // the first limit seen: what the caller records to know when to resume
  let calls = 0;
  let unsaved = 0;            // verdicts not yet written to the cache
  let overflow = 0;           // answered on the billed project because the free daily quota was spent

  // Respect the tightest limit in the chain — a free-tier provider that
  // allows one request at a time makes parallelism actively harmful.
  const limit = Math.max(1, Math.min(
    cfg.concurrency || 4,
    // Called, not read: a provider that reads .env has to do it now rather
    // than when its module loaded, or the value arrives too late to matter.
    ...chain.map((c) => (typeof c.maxConcurrency === 'function' ? c.maxConcurrency() : c.maxConcurrency) ?? 4)
  ));
  if (limit < (cfg.concurrency || 4)) {
    // Name the lever. "capped at 1 by Gemini" reads like a hard limit of the
    // API; it is a default meant for the free tier, and one line of .env lifts
    // it.
    const lever = limit === 1 && !(process.env.GEMINI_MAX_CONCURRENCY_JUDGE)
      ? ' — the free-tier default; set GEMINI_MAX_CONCURRENCY_JUDGE in .env if you are paying'
      : '';
    log.dim(`    concurrency capped at ${limit} by ${chain.map((c) => c.label).join('/')}${lever}`);
  }

  // The circuit breaker (`maxCalls`) counts calls to the MODEL, so it applies here — to what the
  // cache could not answer — and not to the whole batch. It used to slice the batch before the
  // cache was consulted, so a cached verdict, which costs nothing, used up the allowance: a
  // replay with 218 cached of 328 postings reported "28 over the cap" and held them for no reason.
  // What the breaker leaves is held, not decided, exactly like what a rate limit leaves.
  const room = Number.isFinite(opts.maxCalls) ? Math.max(opts.maxCalls, 0) : Infinity;
  const toAsk = ordered.slice(0, room);
  const capped = ordered.slice(room);

  await pool(toAsk, limit, async (item) => {
    const user = userPrompt(item.job, item.uncertainties, profile);

    for (const provider of chain) {
      if (dead.has(provider.id) || limited.has(provider.id)) continue;

      const res = await provider.complete({ system, user, schema: VERDICT_SCHEMA });
      calls++;

      if (res.rateLimited) {
        // Stop asking this provider for the rest of the run: every further call
        // would be refused too, and a refused call can still count against the
        // quota. The posting that hit it is held with all the ones not yet reached.
        const until = res.scope === 'day' ? nextQuotaReset() : new Date(Date.now() + MINUTE_BACKOFF_MS);
        limited.set(provider.id, { scope: res.scope, until, reason: res.error });
        halt = halt || { scope: res.scope, until: until.toISOString(), reason: res.error, provider: provider.label };
        warnings.push(`${provider.label} · ${res.error}`);
        continue;
      }

      if (res.ok) {
        const verdict = {
          decision: res.data.decision,
          confidence: res.data.confidence,
          category: res.data.category,
        reason: res.data.reason,
          resolved: res.data.resolved || [],
          provider: provider.id,
          model: res.model,
          at: new Date().toISOString(),
          // WHICH questions this answer covers. See `answersCover()`.
          asked: [...new Set(item.uncertainties.map((u) => u.kind))].sort(),
        };
        cache.verdicts[item.job.fingerprint] = verdict;
        verdicts.set(item.job.fingerprint, { ...verdict, source: 'llm' });
        used.set(provider.id, (used.get(provider.id) || 0) + 1);
        judged.add(item.job.fingerprint);
        if (res.overflow) overflow++;
        // Written as they arrive, not once at the end. A scan cut off half way
        // (the app quit, the laptop shut) would otherwise throw away every answer
        // it had paid for, and the resumed run would ask them all again — against
        // a quota of 500 a day.
        if (++unsaved >= SAVE_EVERY) { saveCache(cache); unsaved = 0; }
        return;
      }

      if (res.fatal) {
        if (!dead.has(provider.id)) {
          dead.add(provider.id);
          const next = chain.find((c) => !dead.has(c.id));
          warnings.push(
            `${provider.label} unavailable (${res.error})` +
            (next ? ` — falling back to ${next.label}` : ' — remaining jobs use rules verdicts')
          );
        }
        continue; // try the next provider for THIS posting
      }

      // Non-fatal: this posting failed on this provider, try the next one.
      warnings.push(`${provider.label} · ${item.job.title}: ${res.error}`);
    }

    // Out of room, not out of order: wait for the reset instead of guessing.
    if (chain.some((c) => limited.has(c.id)) && !chain.some((c) => !dead.has(c.id) && !limited.has(c.id))) {
      held.push(item);
      opts.onProgress?.();
      return;
    }

    // Every provider is dead or declined. Fall back to rules for now, but
    // remember it so the next run tries again rather than losing it silently.
    deferred.push(item);
    verdicts.set(item.job.fingerprint, fallbackVerdict(item));
    // One tick per posting, wherever it finished — a provider answered, every
    // provider failed, or the budget stopped it. Ticking only on success would
    // stall the counter on exactly the runs worth watching.
    opts.onProgress?.();
  });

  held.push(...capped);
  saveCache(cache);

  pending.resolve(queue, [...judged]);
  if (deferred.length) pending.defer(queue, deferred, 'provider unavailable or quota reached');
  const pruned = pending.prune(queue);
  if (pruned.removed) warnings.push(`${pruned.removed} posting(s) dropped from the retry queue after repeated failures`);
  pending.save(pruned.queue);

  const anyLlm = [...verdicts.values()].some((v) => v.source?.startsWith('llm'));
  const anyFallback = [...verdicts.values()].some((v) => v.source === 'rules-fallback');
  // Held postings are neither: they have no verdict. A run that only waited is
  // not "judged by rules", and saying so would be the false comfort this exists to remove.
  const mode = anyLlm && anyFallback ? 'mixed'
    : anyLlm ? 'llm'
      : anyFallback || !held.length ? 'rules-fallback'
        : 'waiting';

  // e.g. ["Gemini × 80"] — shown in the report so it is always clear which
  // model actually answered, and how many postings it settled.
  const providers = [...used.entries()].map(([pid, n]) => {
    const label = chain.find((c) => c.id === pid)?.label || pid;
    return `${label} × ${n}`;
  });

  return {
    verdicts, mode, warnings, calls, cached: cacheHits, providers,
    fresh, backlog,
    held, halt, overflow, capped: capped.length,
    deferred: deferred.length,
    queueSize: pending.size(pruned.queue),
  };
}

/**
 * The rules verdict, used verbatim when the LLM is unavailable. This is the
 * pre-LLM behaviour — degrading here changes nothing except that the report
 * says the judgement was made by rules.
 */
function fallbackVerdict(item) {
  return {
    decision: item.fallback.keep ? 'keep' : 'drop',
    confidence: 'low',
    reason: item.fallback.reason || 'rules could not fully resolve this posting',
    category: item.fallback.category,
    resolved: [],
    source: 'rules-fallback',
  };
}

const fallbackAll = (items) =>
  new Map(items.map((i) => [i.job.fingerprint, fallbackVerdict(i)]));

// Exposed for the model-comparison harness: judging two models against each
// other is only meaningful if both receive the byte-identical prompt this
// module actually sends.
export const __testables = { systemPrompt, userPrompt, VERDICT_SCHEMA };
