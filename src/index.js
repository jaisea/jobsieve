#!/usr/bin/env node
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import {
  p, readJson, writeJson, loadEnv, configureHttp, log, isoDay, slug, pool, progress } from './util.js';
import { SOURCES, attributions } from './sources/index.js';
import * as workday from './sources/workday.js';
import * as detect from './sources/detect.js';
import { SITE_IDS as careersiteIds } from './sources/careersites.js';
import { probe, ATS } from './sources/ats.js';
import { normalize } from './normalize.js';
import { resolveLocation } from './geo.js';
import { classify, explain, gate, PHASES } from './filter.js';
import { germanGap, MIN_DESCRIPTION_CHARS } from './language.js';
import { score } from './score.js';
import { adjudicate } from './adjudicate.js';
import { checkGerman, cachedDrop as germanDrop, loadChecks as germanChecksLoad } from './germancheck.js';
import * as store from './store.js';
import * as rejects from './rejects.js';
import * as parkedStore from './parked.js';
import * as pending from './pending.js';
import * as awaiting from './awaiting.js';
import * as batches from './batches.js';
import * as gatestats from './gatestats.js';
import { stopwatch, fmtMs } from './timing.js';
import { runPool } from './pool.js';
import * as titledrops from './titledrops.js';
import { billedUsage, describeUsage, judgeSpentUntil } from './keystate.js';
import { lane } from './lane.js';

/** Sources whose search result is a fixed-length teaser; the advert page is the only full text. */
const TEASER_SOURCES = ['adzuna'];
import { resolveChain } from './providers/index.js';
import * as watchlist from './watchlist.js';
import * as applyMod from './apply/index.js';
import * as quota from './quota.js';
import * as schedule from './schedule.js';
import * as queueStore from './queue.js';
import * as lock from './lock.js';
import * as connectivity from './connectivity.js';
import * as fetched from './fetched.js';
import { enrich, save as enrichSave, load as enrichLoad, isTransient as enrichIsTransient, livenessOf } from './enrich.js';
import { buildReport } from './report.js';
import { answeredBy, counts as rejectionCounts, writeRejectionsPage } from './rejections-page.js';
import { serve } from './serve.js';
import * as applog from './applog.js';
import { REJECT_CATEGORIES } from './filter.js';

loadEnv();

const argv = process.argv.slice(2);
const command = argv[0] && !argv[0].startsWith('-') ? argv[0] : 'search';
const flags = new Set(argv.filter((a) => a.startsWith('--')));
const positional = argv.slice(1).filter((a) => !a.startsWith('--'));
const has = (f) => flags.has(f);

const profile = loadProfile();
const sourcesCfg = readJson(p('config', 'sources.json'));
const companies = readJson(p('config', 'companies.json'));

// The contact address in the User-Agent is a courtesy to the APIs we poll, so
// an operator can reach a human. It lives in profile.json — which is personal
// config and stays out of version control — rather than being committed into
// sources.json where it would be published with the code.
configureHttp({
  ...sourcesCfg.http,
  userAgent: (sourcesCfg.http?.userAgent || 'jobsieve/1.0')
    .replace('{{contactEmail}}', profile.contact?.email || 'not set'),
});

/**
 * profile.json is deliberately gitignored, so a fresh clone will not have one.
 * Say what to do rather than dying on a null property twenty lines later.
 * JOBHUNT_PROFILE points at another file — the tests use it to run the CLI
 * against profile.example.json without writing into config/.
 */
function loadProfile() {
  const file = process.env.JOBHUNT_PROFILE || p('config', 'profile.json');
  if (existsSync(file)) return readJson(file);

  log.err('config/profile.json not found — that file is yours and is not in git.');
  log.info('  Create it from the template and edit it:');
  console.log('\n  cp config/profile.example.json config/profile.json\n');
  log.dim('  Set at least: name, location, languages.germanLevel, contact.email');
  process.exit(1);
}

// `companies:` maps to companiesCmd, not to a bare `companies` — that name is
// already taken by the companies.json config object above, and the command
// would silently resolve to it and fail as "not a function".
const COMMANDS = { search, daily, apply: applyCmd, report: reportOnly, mark, why, reviewed, companies: companiesCmd, discover, keys: checkKeys, serve: serveReport, help };

/* ------------------------------------------------------------------ search */

/**
 * Takes the cross-process lock around the whole run. A wrapper rather than a
 * try/finally inside runSearch(), which has a dozen early returns and is long
 * enough that re-indenting it would bury the change. Released when the SEARCH
 * ends, not when the process does — `daily` goes on to serve for hours.
 */
async function search() {
  // A dry run writes nothing the other search could lose, so it may run beside one.
  if (has('--dry-run')) return runSearch();

  const release = lock.acquire();
  if (!release) {
    const pid = lock.holder();
    log.err(`Another search is already running${pid ? ` (pid ${pid})` : ''} — two at once would overwrite each other's memory.`);
    log.dim('  If that process is gone, delete data/search.lock.');
    return;
  }
  try {
    return await runSearch();
  } finally {
    release();
  }
}

async function runSearch() {
  const dryRun = has('--dry-run');
  const verbose = has('--verbose');
  const includeGerman = has('--include-german');
  const showAll = has('--all');
  // Judge the last fetch again instead of fetching. Changing a gate does not
  // change the postings, and paying 42 Adzuna calls and an IMAP round trip to
  // find out what a threshold does is what took JSearch to 95% of its monthly
  // allowance in a single afternoon.
  const replay = has('--replay');

  log.head(`Job search · ${profile.location.city} +${profile.location.radiusKm}km · German ${profile.languages.germanLevel}`);

  // What the keyword APIs are asked for is part of the user's field, so it lives
  // in the profile. sources.json may still carry a shared list; the target
  // titles are the last resort.
  const queries = profile.searchQueries || sourcesCfg.queries || profile.targetTitles.strong;
  const warnings = [];
  const sourceLines = [];
  const quotaState = quota.load();
  // The background app asks for `--due-only`: fetch only the sources whose own
  // sleep is over. A hand-typed search fetches everything and still records the
  // time, so the app does not repeat it straight afterwards.
  const dueOnly = has('--due-only');
  const scheduleState = schedule.load();
  const loopNow = new Date();
  const attempts = {};
  // Set the first time a source comes back empty AND the connection is found to be
  // down. After that the remaining sources are not tried: each would only wait out
  // its own timeout to say the same thing.
  let offlineSeen = false;
  // Called per SOURCE, the moment that source's postings are judged and saved, and
  // once more at the end for the sources that never produced a batch (skipped, empty,
  // failed). Never on a dry run, and never for a source whose run died first — which
  // is the point: a scan cut off after four sources keeps those four asleep and the
  // rest due, where it used to record nothing at all.
  const committed = new Set();
  const commitSchedule = (only = null) => {
    if (dryRun) return;
    const todo = Object.fromEntries(Object.entries(attempts)
      .filter(([k]) => !committed.has(k) && (!only || k === only)));
    schedule.commit(scheduleState, todo, { now: loopNow });
    schedule.save(scheduleState);
    for (const k of Object.keys(todo)) committed.add(k);
  };

  const snapshot = replay ? fetched.load() : null;
  if (replay && !snapshot) {
    log.err('No stored fetch to replay — run `npm run search` once first.');
    return;
  }

  const enabled = Object.entries(sourcesCfg)
    .filter(([k, v]) => v && typeof v === 'object' && v.enabled && SOURCES[k])
    .map(([k]) => k);


  // `--only=a,b` runs just the named sources: for developing one adapter without
  // touching the rest, and for trying the per-source pipeline on cheap ones. An
  // unknown name stops the run rather than quietly fetching nothing. `enabled` stays
  // whole — the replay snapshot keeps the slices of every enabled source.
  const onlyArg = argv.find((a) => a.startsWith('--only='));
  // `--judge-queue` fetches nothing: it only asks the model about the postings that
  // were waiting for it. What the app starts when the limit has reset and no source is due.
  const judgeQueue = has('--judge-queue');
  const toRun = judgeQueue ? [] : onlyArg
    ? enabled.filter((k) => onlyArg.slice('--only='.length).split(',').map((s) => s.trim()).includes(k))
    : enabled;
  if (onlyArg) {
    const named = onlyArg.slice('--only='.length).split(',').map((s) => s.trim()).filter(Boolean);
    const unknown = named.filter((k) => !enabled.includes(k));
    if (unknown.length || !named.length) {
      log.err(`--only: unknown or disabled source ${unknown.join(', ') || '(none named)'} — enabled: ${enabled.join(', ')}`);
      return;
    }
    log.dim(`  --only: ${toRun.join(', ')}`);
  }

  // Shared by every batch. See judge().
  const dropReasons = new Map();
  // Every rejection is archived, not just counted. The histogram tells you a
  // rule fired 300 times; only the archive tells you whether it was right to.
  const rejectArchive = rejects.load();
  // Set once the archive has been pruned and written, so the report renders the
  // same set that is actually on disk rather than the pre-prune working copy.
  let savedRejects = rejectArchive;
  // Where the scan's time goes (timing.js). The lanes overlap, so these do not add up to the wall
  // clock: the point is which step a result is waiting behind.
  const scanStart = Date.now();
  const since = () => fmtMs(Date.now() - scanStart);
  const spent = { fetch: 0, snapshot: 0, prepare: 0, handoff: 0, settle: 0, report: 0, finish: 0 };
  const run = {
    fetched: 0, normalized: 0, passed: 0, uncertain: 0, calls: 0, cached: 0,
    repeats: 0, merged: 0, asked: 0, waiting: 0, drained: 0, overflow: 0,
    gates: gatestats.emptyTally(),      // how often each gate fired, per source: see gatestats.js
    usedSources: new Set(),
    reported: new Map(),               // fingerprint -> posting, for the report
    adjudication: { mode: 'rules', providers: [], reason: null },
  };

  /* ======== one source, end to end ========
     Everything from "normalize" to "saved" for ONE source's postings. It used to run
     once over every source's postings together, which meant nothing was visible until
     the slowest source had been fetched, read and judged; now each source lands as it
     finishes. A replay is a single batch (the whole snapshot), exactly as before.

     What is shared between batches lives in `run` and above it: the reject archive,
     the adjudication budget, the totals the report is built from.
     What is NOT: the postings, the gates' verdicts and the parked list, which are
     per-batch and re-derived. A posting two sources both carry is judged twice and
     merged once, by store.reconcile(), against the memory the first batch already
     saved. */
  /* ---- postings waiting for the AI ----
     When the model is out of room its postings are held here, whole, and asked again
     once the limit has reset (see awaiting.js). A dry run and a replay do not write
     the queue: one promises to write nothing, and the other judges a whole snapshot
     that is not a fetch, so what it could not answer is simply not judged. */
  const waiting = awaiting.load();
  const persistWaiting = !dryRun && !replay;
  /** No model to wait for (switched off, or no key): nothing is held, the rules decide, as they always did. */
  const noModel = () => profile.llm?.enabled === false || !resolveChain(profile.llm?.providers).chain.length;

  /* ---- batches fetched but not yet judged ----
     See batches.js. A source's fetch is made durable (the replay snapshot) and marked
     owed BEFORE it is judged, so the source can sleep on the strength of results that
     are safe, and a scan that dies between the two resumes the judging instead of
     fetching again. */
  const owedState = batches.load();

  /**
   * Hold `items`, release every other posting of the batch that now has an answer,
   * and say so. `batch` is everything that was asked about, held or not.
   */
  const holdForAI = (items, halt, label, batch = []) => {
    const heldNow = new Set(items.map((i) => i.job.fingerprint));
    const before = awaiting.size(waiting);
    awaiting.resolve(waiting, batch.map((i) => i.job.fingerprint).filter((fp) => !heldNow.has(fp)));
    if (items.length) {
      awaiting.add(waiting, items, { label, reason: halt?.reason || 'run limit' });
      if (halt) awaiting.setHold(waiting, { scope: halt.scope, until: halt.until, reason: halt.reason });
    }
    if (!awaiting.size(waiting)) awaiting.clearHold(waiting);

    if (items.length) {
      const d = awaiting.describe(waiting);
      log.warn(`  ${items.length} posting${items.length === 1 ? ' is' : 's are'} waiting for the AI, not decided by the rules`
        + (halt ? ` — ${halt.reason}` : ''));
      if (d.resumeAt) log.dim(`    ${d.text}`);
      if (!persistWaiting) log.dim('    (not queued: this run writes nothing, so they are simply not judged)');
    }
    if (persistWaiting && (items.length || awaiting.size(waiting) !== before)) awaiting.save(waiting);
  };

  /** The run's histogram of why postings were dropped (printed with --verbose). */
  const countDropReason = (reason) => {
    // Collapse only distance/age numbers so reasons aggregate; leave language
    // levels alone or "German A2" turns into the nonsense "German AN".
    const key = reason.replace(/\d+km/g, 'Nkm').replace(/\((\d+)d\)/g, '(Nd)');
    dropReasons.set(key, (dropReasons.get(key) || 0) + 1);
  };
  /** File one rejection: counted for the run's histogram and archived with every reason. */
  const recordDrop = (job, reason, category = 'other', decidedBy = 'rules', reasons = null) => {
    countDropReason(reason);
    rejects.record(rejectArchive, job, { reason, category, decidedBy, reasons });
  };

  /* ---- postings the title has already settled ----
     Remembered between scans (titledrops.js): a posting recognised from the last scan is counted
     and skipped without being normalized. Read in every mode; written only by a real scan —
     a dry run promises to write nothing, and a replay judges a snapshot that is not a fetch. */
  const titleMemo = titledrops.load();

  /* ---- the two halves of a batch ----
     A batch used to be one function, and that was fine while nothing could happen
     between its parts. Now it is two, because they wait on different things:

       prepare()  normalize, the title, the advert fetches, every rules gate.
                  Network and CPU. Reads the world; writes only the advert cache and
                  the parked list, and keeps its rejections to itself (`drops`).
       settle()   the model, then memory: reconcile, save, archive.
                  Waits on the model's rate limit. The only writer of seen.json and
                  the reject archive.

     Keeping prepare()'s rejections out of the shared archive until settle() is what
     lets the next source be prepared while this one is being judged without a
     half-finished batch leaking into a save. */
  const prepare = async (raw, label) => {
    log.head(label);
    const sw = stopwatch();
    /* ---- normalize, gate, score ---- */
    const candidates = raw.filter((j) => j.title && j.applyUrl);
    const toNormalize = [];
    let recognised = 0;
    for (const j of candidates) {
      const hit = titledrops.lookup(titleMemo, j);
      if (!hit) { toNormalize.push(j); continue; }
      recognised++;
      // Counted exactly as if it had been analysed: the per-gate shares and the drop histogram
      // must not shrink because a posting was recognised instead of re-derived.
      gatestats.tally(run.gates, j.source, titledrops.reasonsOf(hit));
      countDropReason(hit.reason);
    }
    log.step(`Normalizing ${toNormalize.length} postings…`);
    if (recognised) log.dim(`  ${recognised} already settled on their title in the last ${titledrops.REEVALUATE_DAYS} days — recognised, not re-analysed`);
    // Ticked rather than timed in advance: normalize() gets more expensive every
    // time a detector is added, so any constant here would be wrong within a
    // month. Measuring this run's own rate needs no maintenance.
    const normProgress = progress(toNormalize.length, { label: 'normalized', every: 250 });
    const normalized = toNormalize.map((j) => {
      const out = normalize(j, profile);
      normProgress.tick();
      return out;
    });
    normProgress.done();
    sw.lap('normalize');

    const passed = [];
    const uncertain = [];
    // Held back rather than judged — see the parking block after enrichment.
    const parked = [];

    // Held until settle(): see the note above prepare().
    const drops = [];
    const noteDrop = (job, reason, category = 'other', decidedBy = 'rules', reasons = null) => {
      drops.push([job, reason, category, decidedBy, reasons]);
    };

    /** Gate, score and file one posting. Used for both the first pass and the re-run after enrichment. */
    const triage = (job) => {
      const verdict = classify(job, profile, { includeGerman });
      gatestats.tally(run.gates, job.source, verdict.reasons);

      if (verdict.decision === 'drop') { noteDrop(job, verdict.reason, verdict.category, 'rules', verdict.reasons); return; }

      const scored = { ...job, ...score(job, profile), band: verdict.band };

      if (verdict.decision === 'uncertain') {
        uncertain.push({
          job: scored,
          uncertainties: verdict.uncertainties,
          // The rules' own findings ride along. A posting the model never answers
          // falls back to these, and one it DOES answer is still worth knowing the
          // rules' full view of — otherwise every adjudicated rejection archives
          // with a single reason and the review rows lose the "also failed" line.
          fallback: { keep: !verdict.reason, reason: verdict.reason, category: verdict.category, reasons: verdict.reasons },
        });
        return;
      }

      // Certain keep — a low score is still a certain drop.
      if (scored.score < profile.filters.minScore) {
        // ...unless it is only just under, which is exactly the boundary the
        // rules are worst at. Escalate the near-misses instead of deleting them.
        if (scored.score >= profile.filters.minScore - 10) {
          uncertain.push({
            job: scored,
            uncertainties: [{
              kind: 'fit',
              question: `This scored ${scored.score}/100 against the candidate's profile — just under the ${profile.filters.minScore} threshold. Is it genuinely worth the candidate's time?`,
              evidence: (scored.scoreBreakdown || []).map((b) => `${b.label} ${b.points >= 0 ? '+' : ''}${b.points}`).join('; '),
            }],
            fallback: { keep: false, reason: `score below ${profile.filters.minScore}`, category: 'score', reasons: verdict.reasons },
          });
          return;
        }
        noteDrop(scored, `score below ${profile.filters.minScore}`, 'score');
        return;
      }
      scored.verdictSource = 'rules';
      passed.push(scored);
    };

    /* ================= phase 1.1 — the title, and nothing else =================
       Two gates, both reading only `job.title`, and together they settle 73% of
       everything fetched. Running them alone and first is what makes phase 1.2
       affordable: the advert is fetched for 1,800 postings rather than 6,600.

       Only a CERTAIN drop is acted on here. A near-miss title is a soft drop, and
       a soft drop is not a decision — it survives to 2.1 and is re-derived once
       the advert has been read. */
    const survivors = [];
    for (const [i, job] of normalized.entries()) {
      const v = gate(job, profile, { includeGerman, phases: ['title'] });
      if (!v.keep && v.certain) {
        // The TITLE decides — that is the phase — but the archive gets every
        // reason, from a full walk. A phase-1.1 verdict on its own knows only
        // about titles, so 1,050 postings that are both off-target AND too old
        // recorded "wrong role" with no trace of the age, and 792 reviewed
        // rejections came back into the list because the gate they had been
        // reviewed under appeared to have stopped firing.
        //
        // These signals are pre-fetch, and for a posting dropped here they always
        // will be — its advert is never read. The archive stores
        // descriptionComplete alongside, so nothing downstream mistakes them for
        // conclusions drawn from a full advert. A regex walk over nine gates on
        // already-derived fields is free.
        const all = gate(job, profile, { includeGerman });
        gatestats.tally(run.gates, job.source, all.reasons);
        noteDrop(job, v.reason, v.category, 'rules', all.reasons);
        titledrops.remember(titleMemo, toNormalize[i], { reason: v.reason, reasons: all.reasons });
        continue;
      }
      survivors.push(job);
    }
    log.info(`  ${survivors.length} past the title, ${normalized.length - survivors.length + recognised} obviously off-target`
      + (recognised ? ` (${recognised} recognised from the last scan)` : ''));
    sw.lap('title gates');

    /* ================= phase 1.2 — is it there, and can it be read? =========
       Two questions with one answer each, and they are not the same question.

       "Still listed by the source that supplied it" costs nothing — the listings
       were already fetched above — and it is the only signal that catches an
       aggregator outliving the employer's own posting. A role marked closed by
       hand was still listed by Arbeitsagentur, still served a 200 page with
       intact ld+json, and was absent from the employer's own Greenhouse board.
       No amount of probing finds that; the board already knew.

       "Can the advert be read" is the HTTP fetch, and it is needed regardless,
       because 2.1 judges on the text. Liveness from the status code comes free
       with it: 410 anywhere, 404 from an id-keyed endpoint, a closed marker, or
       a redirect to a board index.

       This catches what can be caught, and no more. Of eight postings known to be
       closed, four were detectable and four served a full description with no
       marker of any kind. That is accepted — see CLAUDE.md. Do not add
       speculative heuristics to chase the rest. */
    const liveness = {};
    // --no-enrich skips the step entirely. A REPLAY still runs it, in OFFLINE
    // mode: the cached adverts are read, nothing is requested. Those are not the
    // same thing, and conflating them cost a faithful replay — judging without
    // the 1,126 cached adverts sent 890 postings to the model instead of 236.
    const didFetch = !has('--no-enrich');

    // Whether the NETWORK was actually asked. A replay reads the advert cache but
    // requests nothing, so a posting missing from that cache was never asked
    // about — parking it would hold it out of the very judgement the replay
    // exists to produce. Same rule as --no-enrich: parking means we asked and it
    // did not arrive, never that we did not look.
    const askedTheNetwork = didFetch && !replay;
    if (didFetch) {
      // Note what is NOT here: a check that the posting is still listed by its
      // source. Every survivor came out of THIS run's fetch, so that question is
      // vacuously true for all of them. It is a real signal, but only for a
      // posting shown days ago and re-checked — see stillListed() in rejudge().
      const readable = survivors;
      log.step(`Reading the advert for ${readable.length} posting${readable.length === 1 ? '' : 's'}…`);
      const e = await enrich(readable, { verbose, offline: replay });
      // Nothing new was fetched on a replay, so there is nothing to write back.
      if (!replay) enrichSave(e.cache);

      for (const j of readable) {
        const l = e.liveness[j.fingerprint];
        if (l && l.state !== 'open' && l.state !== 'unreadable') liveness[j.fingerprint] = l;
        const text = e.descriptions[j.fingerprint];
        // The HTML goes with it. normalize() prefers descriptionText, so a stale
        // descriptionHtml is inert — but leaving the aggregator's teaser markup
        // beside the full text it replaced would archive two versions of the same
        // advert and invite a later reader to strip the wrong one.
        if (text) { j.descriptionText = text; j.descriptionHtml = ''; }
      }

      log.info(`  ${e.fetched} fetched, ${e.cached} already cached, ${e.failed} unavailable`
        + ` · ${e.improved} now judged on the full advert`);
    }

    /* A posting whose advert never arrived is HELD, not judged. The rules see no
       language requirement because there is no text, the model is asked to guess
       from the title, and the answer is filed under a reject category as though
       the advert had been read — which is how a role demanding
       verhandlungssichere Deutschkenntnisse reached the report at 70/100.

       Only TRANSIENT failures park. A page that has never carried structured data
       will not grow any, so those go through the gates on what little is known. */
    const enrichCache = enrichLoad();
    const toJudge = [];
    for (const job of survivors) {
      const l = liveness[job.fingerprint] || livenessOf(enrichCache[job.fingerprint]);

      if (l.state === 'gone' || l.state === 'closed') {
        // Threaded through normalize rather than set on the job, so the gate and
        // the archive see the same field the carry-forward path sees. The gate
        // itself has never fired on a fresh posting before this: `closed` was
        // only ever set by the enricher and never passed back in.
        const shut = normalize({ ...job, closed: true, closedEvidence: l.evidence }, profile);
        const v = gate(shut, profile, { includeGerman, phases: ['liveness'] });
        gatestats.tally(run.gates, job.source, v.reasons);
        noteDrop({ ...shut, fingerprint: job.fingerprint }, v.reason, v.category, 'rules', v.reasons);
        continue;
      }

      // Only when the advert was actually ASKED for. `--no-enrich` fetches
      // nothing, so every posting without text would otherwise be held rather
      // than judged — 401 of them in the first run of this code, on a flag whose
      // whole purpose is to skip the network and gate on what the sources gave.
      // Parking means "we tried and it did not arrive", not "we never looked".
      // A TEASER counts as not arrived. Adzuna's API cuts every description at 500
      // characters, before the requirements, so the advert page is a second call
      // BY DESIGN and the posting is judged only on what that call returns.
      // Judging the teaser asserted an absence the advert contradicted (911267cd
      // asks for "Sehr gute Deutsch- und gute Englischkenntnisse" past the cut).
      // A failed or refused page parks for any source; for a source that ONLY
      // ever gives a teaser, a page that cannot be read (403, no ld+json) parks
      // too, because there is nothing else to judge. Other sources keep the old
      // rule: an unreadable page will not grow text, so they are gated as they are.
      const teaser = (job.descriptionText || '').trim().length < MIN_DESCRIPTION_CHARS;
      if (askedTheNetwork && teaser && (l.state === 'unknown' || (l.state === 'unreadable' && TEASER_SOURCES.includes(job.source)))) {
        parked.push({ ...job, parkedReason: l.evidence, parkedAt: new Date().toISOString() });
        continue;
      }

      toJudge.push(job);
    }

    if (parked.length) {
      log.warn(`  ${parked.length} posting(s) parked — the advert text did not arrive, so they are not judged`);
      for (const j of parked) log.dim(`      ${j.parkedReason} — ${j.title.slice(0, 50)}`);
    }

    /* A run that did not ask the network must not touch the parked list at all
       — not to add to it, and above all not to RELEASE from it.

       `release()` clears every posting in `toJudge`, and a replay puts the
       unread ones there precisely BECAUSE it cannot park them. So a replay
       emptied the list of postings still waiting for an advert, and the next
       real run had no memory that they were waiting. Two LinkedIn postings went
       through it: fetched at 08:10 and refused with HTTP 429, parked by the real
       run, then released and judged by an 18:56 replay. Both reached the report
       on `workMode: 'onsite'` assumed from the city in the alert email, with
       nothing read, and both were turned down by hand — one of them as
       `closed`, a fact no one could have known without the advert.

       `--dry-run` is here for the plainer reason: it promises to write nothing,
       and this was the one write that happened anyway. */
    if (askedTheNetwork && !dryRun) {
      const parkedFile = parkedStore.load();
      parkedStore.release(parkedFile, toJudge.map((j) => j.fingerprint));
      parkedStore.record(parkedFile, parked);

      // Give up on the ones that are never coming. Parking is a claim about a
      // TRANSIENT failure, and after five runs it has stopped being one — the
      // entry then reports "waiting for the advert" for ever about a posting
      // nothing will fetch. Released, it is judged next run on what the sources
      // gave, the same as any advert that cannot be read.
      const givenUp = parkedStore.prune(parkedFile).removed;
      if (givenUp) {
        log.dim(`  ${givenUp} released from the parked list — the advert never arrived after repeated tries`);
      }
      parkedStore.save(parkedFile);
    }

    /* ================= phase 2.1 — every gate, on the full advert ===========
       Pure rules, no model. Each posting is matched against all nine gates and
       every failing one is recorded, so the archive can answer "is this rule
       pulling its weight" rather than only "which rule got there first".

       Because 1.2 has already read the advert, the gates are certain where they
       used to have to guess — location most of all, which had to soften for
       unread postings because "onsite" was assumed from a resolved city. */
    sw.lap('adverts');
    for (const job of toJudge) triage(normalize({ ...job }, profile));
    sw.lap('rules');
    log.dim(`  prepared in ${fmtMs(sw.total())}: ${sw.text()}`);

    log.info(`  ${passed.length} certain keeps, ${uncertain.length} uncertain, ${normalized.length + recognised - passed.length - uncertain.length} certain drops`);

    return { label, normalizedCount: normalized.length + recognised, passed, uncertain, drops };
  };

  const settle = async ({ label, normalizedCount, passed, uncertain, drops, giveUp = new Set() }) => {
    const sw = stopwatch();
    const noteDrop = recordDrop;
    for (const d of drops) noteDrop(...d);

    // A waiting posting that has since been settled without the model (the rules changed,
    // or its source returned it again and the gates are now certain) no longer needs it.
    if (awaiting.size(waiting)) {
      const certain = [...passed.map((j) => j.fingerprint), ...drops.map((d) => d[0].fingerprint)];
      if (certain.some((fp) => waiting.items[fp])) {
        awaiting.resolve(waiting, certain);
        if (!awaiting.size(waiting)) awaiting.clearHold(waiting);
        if (persistWaiting) awaiting.save(waiting);
      }
    }

    /* ---- LLM adjudication of the uncertain minority ---- */
    let adjudication = { verdicts: new Map(), mode: 'rules', warnings: [], calls: 0, cached: 0 };
    let held = new Set();
    if (uncertain.length) {
      // No cap by default: adjudicate until the provider stops us, then defer
      // the remainder to the retry queue instead of silently discarding them.
      const cap = profile.llm?.maxCallsPerRun;

      // Never re-open a job the user has already ruled on. A rejection is deliberately
      // NOT written to seen.json, so a rejected posting is re-fetched and
      // re-judged every run — that is what lets a rule edit take effect. But once
      // the USER has answered for it, asking the model again buys nothing: the report
      // filters those statuses out, so the answer is thrown away. 82 of them were
      // being paid for on every run. Falling out of `toJudge` costs nothing else
      // — the missing verdict lands on the rules fallback below and archives the
      // job exactly as before.
      const decided = decidedBy(store.load());
      // `giveUp` are postings that have waited past the limit (or have no model to wait
      // for): they skip the model and take the rules' answer, said out loud.
      const askable = uncertain.filter((u) => !decided.has(u.job.fingerprint) && !giveUp.has(u.job.fingerprint));
      if (askable.length < uncertain.length) {
        log.dim(`    ${uncertain.length - askable.length} skipped — you have already marked them`);
      }

      // The cap is for the RUN, not for each source: with one batch per source a
      // per-batch cap would multiply the budget by the number of sources. It counts
      // calls to the MODEL (`run.asked += adjudication.calls`, below); the adjudicator
      // applies it after the cache, because a cached answer costs nothing.
      const room = cap && !noModel() ? Math.max(cap - run.asked, 0) : Infinity;
      const toJudge = askable;

      log.step(`Adjudicating ${toJudge.length} uncertain posting${toJudge.length === 1 ? '' : 's'}…`);
      // Only the postings that actually reach the model are counted. A cached
      // verdict returns instantly, so including them would report an ETA against
      // work that is not happening and then finish far too early.
      const adjProgress = progress(toJudge.length, { label: 'judged', every: 5 });
      adjudication = await adjudicate(toJudge, profile, {
        refresh: has('--refresh-verdicts'),
        maxCalls: room,
        // Already refused and told when to come back: spend no request to hear it again.
        paused: Boolean(awaiting.resumeAt(waiting)),
        onProgress: () => adjProgress.tick(),
      });
      adjProgress.done();
      run.asked += adjudication.calls;
      run.overflow += adjudication.overflow || 0;
      // Past the circuit breaker: WAIT for the next scan rather than take the rules'
      // answer. The cap is there to stop a gate regression from spending the quota,
      // not to decide postings, and what it leaves is exactly as unanswered as what a
      // rate limit leaves.
      if (adjudication.capped) {
        const msg = `maxCallsPerRun (${cap}) reached: ${adjudication.capped} uncertain posting${adjudication.capped === 1 ? '' : 's'} wait for the next scan`;
        warnings.push(msg);
        log.warn(`  ${msg}`);
      }
      if (adjudication.backlog) {
        log.dim(`    ${adjudication.fresh} new, ${adjudication.backlog} retried from the queue`);
      }
      if (adjudication.providers?.length) log.dim(`    via ${adjudication.providers.join(', ')}`);
      if (adjudication.overflow) {
        // Money was spent, so say so every time: it is the one thing here that is not free.
        const msg = `${adjudication.overflow} posting${adjudication.overflow === 1 ? '' : 's'} judged on the billed key — the free daily quota is spent (${describeUsage(billedUsage())}; an estimate)`;
        warnings.push(msg);
        log.warn(`    ${msg}`);
      }
      if (adjudication.deferred) {
        log.warn(`    ${adjudication.deferred} deferred to data/pending.json — retried on the next run`);
      }

      for (const e of adjudication.warnings) { warnings.push(e); if (verbose) log.warn(`    ${e}`); }

      // What the model could not answer WAITS. It is neither reported nor rejected:
      // no verdict has been given, and the rules' guess is not one.
      const heldItems = adjudication.held || [];
      holdForAI(heldItems, adjudication.halt, label, uncertain);
      held = new Set(heldItems.map((i) => i.job.fingerprint));
      run.waiting += heldItems.length;

      const resolvedItems = uncertain
        .filter((item) => !held.has(item.job.fingerprint))
        .map((item) => [item, adjudication.verdicts.get(item.job.fingerprint)]);

      for (const [item, v] of resolvedItems) {
        const verdict = v || { decision: item.fallback.keep ? 'keep' : 'drop', reason: item.fallback.reason, category: item.fallback.category, source: 'rules-fallback' };
        if (verdict.decision === 'keep') {
          passed.push({
            ...item.job,
            verdictSource: verdict.source || 'rules-fallback',
            verdictReason: verdict.reason,
            verdictConfidence: verdict.confidence,
            verdictResolved: verdict.resolved,
          });
        } else {
          // The model returns its own category so AI drops bucket alongside rule drops.
          noteDrop(item.job,
            `${verdict.source === 'rules-fallback' ? '' : 'AI: '}${verdict.reason || 'not a fit'}`,
            verdict.category || item.fallback.category || kindToCategory(item.uncertainties) || 'other',
            verdict.source || 'rules-fallback',
            item.fallback.reasons);
        }
      }

      const kept = passed.filter((j) => j.verdictSource && j.verdictSource !== 'rules').length;
      log.info(`  adjudication: ${adjudication.calls} call(s), ${adjudication.cached} cached, ${kept} of ${askable.length} kept · mode=${adjudication.mode}`);
    }

    /* ---- German, read once more for what is about to be shown (src/germancheck.js) ---- */
    if (passed.length) {
      const cap = profile.llm?.maxCallsPerRun;
      const gc = await checkGerman(passed, profile, {
        decided: decidedBy(store.load()),
        maxCalls: cap && !noModel() ? Math.max(cap - run.asked, 0) : Infinity,
        cacheOnly: dryRun || replay || noModel(),
        persist: !dryRun && !replay,
        pace: 4200,   // the free tier allows 15 a minute
      });
      run.asked += gc.calls;
      for (const w of gc.warnings) { warnings.push(w); log.warn(`    ${w}`); }
      if (gc.dropped.size) {
        for (let i = passed.length - 1; i >= 0; i--) {
          const d = gc.dropped.get(passed[i].fingerprint);
          if (!d) continue;
          noteDrop(passed[i], d.reason, d.category, 'ai-german', null);
          log.dim(`    German demanded, dropped: ${passed[i].title} — ${passed[i].company}`);
          passed.splice(i, 1);
        }
      }
      if (gc.calls || gc.cached) log.dim(`  German check: ${gc.calls} call(s), ${gc.cached} cached, ${gc.dropped.size} dropped`);
    }

    log.info(`  ${passed.length} passed in total`);
    if (verbose) {
      for (const [reason, n] of [...dropReasons].sort((a, b) => b[1] - a[1]).slice(0, 15)) {
        log.dim(`    ${String(n).padStart(4)} × ${reason}`);
      }
    }

    sw.lap('model');
    /* ---- memory ---- */
    const state = store.load();
    const { fresh, repeats, merged, drifted } = store.reconcile(state, passed);

    const toReport = showAll
      ? passed.sort((a, b) => b.score - a.score)
      : fresh.sort((a, b) => b.score - a.score);

    // What the final report is built from.
    run.normalized += normalizedCount;
    run.passed += passed.length;
    run.uncertain += uncertain.length;
    run.calls += adjudication.calls;
    run.cached += adjudication.cached;
    run.repeats += repeats.length;
    run.merged += merged;
    for (const j of passed) run.usedSources.add(j.source);
    for (const j of toReport) if (!run.reported.has(j.fingerprint)) { run.reported.set(j.fingerprint, j); }
    // A batch that only waited has no mode of its own (it was judged by no one), so it
    // must not turn a run that WAS judged into "mixed": the waiting count says the rest.
    if (adjudication.mode !== 'waiting') {
      run.adjudication.mode = adjudication.mode === run.adjudication.mode || run.adjudication.mode === 'rules'
        ? adjudication.mode : 'mixed';
    }
    for (const pv of adjudication.providers || []) if (!run.adjudication.providers.includes(pv)) run.adjudication.providers.push(pv);
    run.adjudication.reason = run.adjudication.reason
      || adjudication.warnings.find((w) => /unavailable|No LLM provider|disabled/.test(w)) || null;

    log.info(`  ${fresh.length} new, ${repeats.length} seen before, ${merged} duplicates merged`);
    // Say it out loud. A posting whose identity moved is one that would have
    // come back as unseen, and if the user had already decided on it that is a
    // silent regression — the kind that only surfaces when a job already
    // applied to turns up in the queue again.
    for (const d of drifted || []) {
      log.dim(`    ${d.twin ? 'same role via an aggregator' : 'identity moved'}: ${d.from} -> ${d.to} (${d.status}) — ${d.title}`);
    }

    if (!dryRun) {
      const { archive, removed } = rejects.prune(rejectArchive);
      rejects.save(archive);
      savedRejects = archive;

      const toReview = rejects.unreviewed(archive, answeredBy(store.load())).length;
      log.dim(`  ${rejects.size(archive)} rejections archived${removed ? `, ${removed} pruned` : ''}`
        + ` · ${toReview} awaiting review`);
      log.dim(`  Review them at the bottom of the report, or: npm run why -- <id|url|title>`);

      // The point of judging per source: this batch is on disk, and therefore on the
      // live page, the tray count and the badge, before the next source is fetched.
      store.markShown(state, toReport);
      store.save(state);
    }
    sw.lap('save');
    // The line that answers "when did it reach the page": the batch is on disk, and so on the
    // live page, the tray count and the badge, as of now.
    log.dim(`  judged and saved in ${fmtMs(sw.total())}: ${sw.text()} — on the page ${since()} into the scan`);
  };

  const judge = async (raw, label) => settle(await prepare(raw, label));

  /* ======== how often each gate fired, and whether that moved ========
     A gate fails quietly: a vocabulary edit that stops it matching, or a source that starts
     sending a field differently, looks like nothing but a number that moved. This prints the
     biggest gates per source every run and says so when one moved by 3+ points since that
     source's last recorded run (gatestats.js). A dry run and a replay compare but do not
     record: one writes nothing, and the other is for trying a gate change against the last
     real run, which is exactly the comparison it should show. */
  const reportGates = () => {
    if (!Object.values(run.gates.sources).some((x) => x.postings)) return;
    const state = gatestats.load();
    log.info('  gates, per source (certain drops; "asked" = sent to the model)');
    for (const line of gatestats.describe(run.gates).slice(0, 12)) log.dim('    ' + line);
    const moved = gatestats.shifts(state, run.gates);
    for (const m of moved.slice(0, 6)) log.warn('  gate shift · ' + gatestats.shiftText(m));
    for (const m of moved.slice(0, 3)) warnings.push('Gate shift: ' + gatestats.shiftText(m));
    if (!dryRun && !replay) { gatestats.record(state, run.gates); gatestats.save(state); }
  };

  /** One line saying where the scan's time went. The lanes overlap, so the parts exceed the whole. */
  const reportTimings = () => {
    log.info(`  scan took ${since()} (the lanes overlap, so the parts add up to more):`);
    log.dim(`    fetching ${fmtMs(spent.fetch)} · replay copy ${fmtMs(spent.snapshot)} · reading adverts and rules ${fmtMs(spent.prepare)}`
      + ` · fetch side waiting for the judge lane ${fmtMs(spent.handoff)} · judging and saving ${fmtMs(spent.settle)}`
      + ` · report pages ${fmtMs(spent.report)} · end-of-scan housekeeping ${fmtMs(spent.finish)}`);
  };

  /* ======== the report, buildable at any point ========
     It used to be written once, at the end of the run, so a page opened as a FILE
     showed nothing new until the slowest source had finished. It is a function now:
     called after every source that brought something new, and once more at the
     end, which is the only call that also settles the archive. Roughly 8 seconds
     for a 10MB page, which is why a source that found nothing does not trigger it.
     `quiet` keeps the per-source calls from repeating the retired-roles log. */
  const writeReport = (state, { quiet = false } = {}) => {
    const usedSources = run.usedSources;
    const toReport = [...run.reported.values()].sort((a, b) => b.score - a.score);
    const now = new Date();

    // Carry forward roles already shown but not yet acted on, so a quiet day still
    // produces a useful page instead of wiping the backlog.
    const reportedIds = new Set(toReport.map((j) => j.fingerprint));
    // Carry-forward used to replay the archive verbatim, so a job stayed on the
    // list forever on the strength of the verdict it got the day it was found.
    // That is why a role demanding verhandlungssichere Deutschkenntnisse kept
    // appearing after the rules learned to reject it: nothing ever re-asked.
    // Each carried job is now re-judged against the current rules, on the fullest
    // description we have — including one fetched after it was first archived.
    const { kept: openKept, retired } = rejudge(
      Object.values(state.jobs).filter((j) => {
        const e = state.seen[j.fingerprint];
        // The same definition the live page and the badge use, so what the report
        // carries and what the app counts cannot drift apart.
        return !!e && !reportedIds.has(j.fingerprint) && queueStore.carries(e);
      }),
      state,
    );

    const openJobs = openKept
      // firstSeen rides along so a carried card can say how long it has been
      // sitting there — without it, merging into the main queue would hide the
      // one fact that distinguishes these from today's finds.
      .map((j) => ({
        ...j, ...score(j, profile), band: 'main',
        firstSeen: state.seen[j.fingerprint]?.firstSeen || null,
        status: state.seen[j.fingerprint]?.status || null,
      }))
      .sort(pickedFirst(state));

    if (retired.length && !quiet) {
      log.info(`  ${retired.length} carried role${retired.length === 1 ? '' : 's'} retired — the rules now reject ${retired.length === 1 ? 'it' : 'them'}`);
      for (const r of retired.slice(0, verbose ? retired.length : 5)) {
        log.dim(`    ${r.job.title.slice(0, 46).padEnd(48)} ${r.reason}`);
      }
    }

    const html = buildReport({
      jobs: toReport,
      openJobs,
      // How many are waiting, not the rows: the rows are 9.6MB and live on
      // rejections.html. A rejection you never got round to reviewing should not
      // vanish because a day passed, so it is still counted every time.
      rejectedCount: rejectionCounts(savedRejects, state).awaiting,
      reviewedCount: rejectionCounts(savedRejects, state).reviewed,
      parked: parkedStore.list(parkedStore.load()),
      profile,
      attributions: attributions(usedSources),
      meta: {
        date: isoDay(now),
        time: now.toTimeString().slice(0, 5),
        totalFetched: run.fetched,
        alreadySeen: run.repeats,
        merged: run.merged,
        sourceLines,
        warnings,
        adjudication: {
          uncertain: run.uncertain,
          waiting: run.waiting,
          overflow: run.overflow,
          mode: run.adjudication.mode,
          calls: run.calls,
          cached: run.cached,
          reason: run.adjudication.reason,
          providers: run.adjudication.providers,
        },
      },
    });

    mkdirSync(p('reports'), { recursive: true });
    const dated = p('reports', `${isoDay(now)}.html`);
    const latest = p('reports', 'latest.html');
    writeFileSync(dated, html, 'utf8');
    writeFileSync(latest, html, 'utf8');
    // The list itself is a page of its own, written once per run: it changes only
    // when the archive does, and the server renders it live anyway.
    if (!quiet) writeRejectionsPage({ profile });

    return { toReport, dated, retired };
  };

  /* ======== the postings that were waiting for the AI ========
     Asked first, before anything is fetched: they are the oldest work, and a quota that
     has just reset is best spent on them. Does nothing unless the limit has reset (or
     `--judge-queue` was asked for by hand, which tries regardless: a request refused
     again costs one call). */
  const drainWaiting = async () => {
    if (replay || dryRun || !awaiting.size(waiting)) return;
    const now = new Date();

    // Nothing waits for ever, and nothing waits for a model that is not there. Both
    // take the rules' answer — openly, in the log, and only now.
    let stale;
    if (noModel()) {
      stale = awaiting.entries(waiting);
      awaiting.resolve(waiting, stale.map((e) => e.item.job.fingerprint));
    } else {
      stale = awaiting.expire(waiting, { now });
    }
    if (noModel() && stale.length) {
      warnings.push(`${stale.length} waiting posting(s) took their rules verdict: no AI provider is configured`);
      log.warn(`  ${stale.length} posting(s) were waiting for the AI but none is configured — decided by the rules`);
    } else if (stale.length) {
      warnings.push(`${stale.length} posting(s) waited over ${awaiting.MAX_AGE_DAYS} days for the AI and took their rules verdict`);
      log.warn(`  ${stale.length} posting(s) waited over ${awaiting.MAX_AGE_DAYS} days for the AI — decided by the rules`);
    }

    if (!judgeQueue && !stale.length && !awaiting.isDue(waiting, now)) {
      log.dim(`  ${awaiting.describe(waiting, now).text}`);
      return;
    }
    if (judgeQueue) awaiting.clearHold(waiting);   // asked for by hand: try now (not saved unless it holds again)

    const entries = awaiting.entries(waiting);
    const items = [...stale, ...entries].map((e) => e.item);
    if (!items.length) return;

    log.head('Waiting for the AI');
    log.info(`  ${items.length} posting${items.length === 1 ? '' : 's'} held back by a rate limit are asked about now`);
    run.drained += items.length;
    await settle({
      label: 'Waiting for the AI',
      normalizedCount: 0,
      passed: [],
      uncertain: items,
      drops: [],
      giveUp: new Set(stale.map((e) => e.item.job.fingerprint)),
    });
    if (persistWaiting) awaiting.save(waiting);
    if (!dryRun && run.reported.size) {
      writeReport(store.load(), { quiet: true });
      log.dim('  report updated');
    }
  };
  await drainWaiting();

  /* ======== sources that were fetched but never judged ========
     A scan cut off between a source's fetch and its save left the postings in the
     snapshot and a marker saying so (batches.js). They are judged from the snapshot
     now — no request, no quota — before anything new is fetched. */
  const resumeOwed = async () => {
    if (replay || dryRun || !batches.size(owedState)) return;
    const snap = fetched.load();
    for (const o of batches.list(owedState)) {
      // Asked for by hand, so try even a batch that gave up: the cause may be fixed.
      if (judgeQueue && batches.stuck(o)) { owedState.owed[o.key].attempts = 0; o.attempts = 0; }
      if (batches.stuck(o)) {
        const msg = `${o.label}: fetched ${o.fetchedAt.slice(0, 16).replace('T', ' ')} but judging failed ${o.attempts} times — left alone; \`npm run judge\` tries again`;
        warnings.push(msg);
        log.warn(`  ${msg}`);
        continue;
      }

      const raw = batches.sliceOf(snap, o.key);
      if (!raw) {
        // The snapshot no longer holds it (replaced, damaged, or the source was
        // switched off). Nothing to judge, so let the source fetch again.
        batches.settled(owedState, o.key);
        batches.save(owedState);
        delete scheduleState.sources?.[o.key];
        schedule.save(scheduleState);
        const msg = `${o.label}: fetched but not judged, and the stored fetch is gone — it will be fetched again`;
        warnings.push(msg);
        log.warn(`  ${msg}`);
        continue;
      }

      log.head(`Resuming ${o.label}`);
      log.info(`  ${raw.length} posting${raw.length === 1 ? '' : 's'} fetched ${o.fetchedAt.slice(0, 16).replace('T', ' ')} were never judged — no new request needed`);
      // Counted BEFORE the attempt: a scan killed inside it is a failed attempt too,
      // and a batch that kills every scan must stop being retried.
      batches.tried(owedState, o.key);
      batches.save(owedState);
      const known = run.reported.size;
      try {
        await judge(raw, `${o.label} (resumed)`);
      } catch (e) {
        log.err(`  ${o.label}: judging failed — ${e.message}`);
        warnings.push(`${o.label}: resumed judging failed — ${e.message}`);
        continue;
      }
      batches.settled(owedState, o.key);
      batches.save(owedState);
      run.drained += raw.length;
      if (run.reported.size > known) {
        writeReport(store.load(), { quiet: true });
        log.dim('  report updated');
      }
    }
  };
  await resumeOwed();

  /* ---- the judge lane ----
     One worker, in order, with room for one batch to wait: the saves stay atomic and
     ordered (batch N is on disk before N+1 is reconciled against it) while the model's
     waiting hides inside the network's. */
  let laneError = null;
  /**
   * A source's own bookmark (the mailbox's UID), moved only once what it returned is saved. A
   * failure here must not undo a batch that is already on disk: the worst case is that the
   * same mail is read again next scan, and duplicates merge.
   */
  const commitSource = async (commit) => {
    if (!commit) return;
    try { await commit(); } catch (e) { log.warn(`  could not record the source's bookmark: ${e.message}`); }
  };

  const judgeLane = lane(async ({ key, prepared, owed, commit }) => {
    const known = run.reported.size;
    const tSettle = Date.now();
    await settle(prepared);
    spent.settle += Date.now() - tSettle;
    // A source that brought something new refreshes the page file now, not at the
    // end of the run. A dry run writes nothing.
    if (!dryRun && run.reported.size > known) {
      const tRep = Date.now();
      writeReport(store.load(), { quiet: true });
      spent.report += Date.now() - tRep;
      log.dim(`  report page rewritten in ${fmtMs(Date.now() - tRep)}`);
    }
    // The very last step: only now is the batch no longer owed.
    if (owed) { batches.settled(owedState, key); batches.save(owedState); }
    if (!dryRun) await commitSource(commit);
    commitSchedule(key);
  }, { capacity: 1 });

  try {
  /** Slow sources start first, so their time overlaps with everything else (lower priority starts earlier; stable). */
  const launchOrder = (keys) => keys.slice().sort((a, b) => (sourcesCfg[a].priority ?? 50) - (sourcesCfg[b].priority ?? 50));

  // Decided one by one and without the network — which sources are due, configured, within
  // budget — so the log reads in a fixed order and a skipped source still rests its interval.
  const runnable = [];
  for (const key of launchOrder(replay ? [] : toRun)) {
    const mod = SOURCES[key];
    const cfg = sourcesCfg[key];

    if (dueOnly && !schedule.isDue(scheduleState, key, cfg, loopNow)) {
      const at = schedule.wakesAt(scheduleState, key, cfg);
      log.dim(`  ${cfg.label}: asleep until ${at.toTimeString().slice(0, 5)}`);
      continue;
    }
    // Noted BEFORE the checks below, so a source skipped for a missing key or a
    // spent quota still rests its full interval instead of being woken every half
    // hour to be skipped again — but only WRITTEN DOWN when the run completes, by
    // commitSchedule(). Written here, a run cut off mid-way left its sources
    // asleep for hours over results that were never saved.
    attempts[key] = { cfg, failed: false };

    if (mod.requiresKey?.some((k) => !process.env[k])) {
      const msg = `${cfg.label}: skipped — set ${mod.requiresKey.join(' / ')} in .env`;
      warnings.push(msg);
      log.warn(msg);
      continue;
    }

    // Both board-driven sources read their list from companies.json, but from
    // different keys: ats.boards is discovered by probing, workday.boards is
    // hand-entered from career-site URLs (tenants cannot be probed for).
    const boards = key === 'ats' ? companies.boards
      : key === 'workday' ? companies.workday
        : key === 'getro' ? companies.getro
          : key === 'personio' ? companies.personio
            : key === 'teamtailor' ? companies.teamtailor
              : key === 'beesite' ? companies.beesite
                : undefined;

    if (key === 'ats' && (!boards || !boards.length)) {
      const msg = 'Company boards: none configured yet — run `npm run discover` to find them';
      warnings.push(msg);
      log.warn(msg);
      continue;
    }
    if (key === 'workday' && (!boards || !boards.length)) {
      const msg = 'Workday boards: none configured — add career-site URLs under `workday` in config/companies.json';
      warnings.push(msg);
      log.warn(msg);
      continue;
    }
    if (key === 'teamtailor' && (!boards || !boards.length)) {
      const msg = 'Teamtailor boards: none configured — add tenants under `teamtailor` in config/companies.json';
      warnings.push(msg);
      log.warn(msg);
      continue;
    }
    if (key === 'beesite' && (!boards || !boards.length)) {
      const msg = 'Beesite boards: none configured — add tenants under `beesite` in config/companies.json';
      warnings.push(msg);
      log.warn(msg);
      continue;
    }
    if (key === 'personio' && (!boards || !boards.length)) {
      const msg = 'Personio boards: none configured — add tenants under `personio` in config/companies.json';
      warnings.push(msg);
      log.warn(msg);
      continue;
    }
    if (key === 'getro' && (!boards || !boards.length)) {
      const msg = 'VC portfolio boards: none configured — add board URLs under `getro` in config/companies.json';
      warnings.push(msg);
      log.warn(msg);
      continue;
    }

    // A metered source spends a budget that has to last a month. Checked
    // BEFORE the request, and a dry run never spends it at all — four runs in
    // one afternoon, three of them --dry-run, took JSearch from comfortable to
    // 95% used with ten days of the cycle left, and nothing noticed because
    // nothing was counting.
    const budget = quota.budgetFor(quotaState, key, cfg.quota, { dryRun });
    if (!budget.allowed) {
      const msg = `${cfg.label}: skipped — ${budget.reason}`;
      warnings.push(msg);
      log.warn(`  ${msg}`);
      continue;
    }
    if (budget.note) log.dim(`  ${cfg.label}: ${budget.note}`);

    runnable.push({ key, mod, cfg, boards, budget });
  }

  /* ======== fetch the sources, several at once, and process each as it lands ========
     The loop used to fetch one source, process it, then fetch the next. A scan measured at
     14m37s spent 10m12s of it fetching, and the sources are on different hosts: the recruiting
     agency alone took 6m27s while everything behind it waited, and mail (about 12s of work)
     reached the page 4m56s into the scan because four slow sources were ahead of it.

     Now up to `sourcesAtOnce` fetches run together (default 6; `--serial` for one at a time,
     which is what to use when developing a single adapter). Slow sources are STARTED first, so
     their time overlaps with everything else (`priority` in sources.json: lower starts
     earlier), and each source is processed the moment its fetch lands — in completion order, so
     a source that finishes in a second is on the page long before one that takes six minutes.

     Only the FETCH overlaps. Everything after it (the snapshot, the owed marker, the schedule,
     reading the adverts, handing the batch to the judge lane) happens for ONE source at a time,
     exactly as before, so nothing shared is written from two places and the judge lane's order
     and atomicity are untouched. Politeness is untouched too: the per-host gap is a queue keyed
     by host across the whole run, not by source. */
  const fetchAtOnce = has('--serial') ? 1 : Math.max(1, Number(sourcesCfg.http?.sourcesAtOnce) || 6);

  /** One source's results, once they have landed. Runs for one source at a time. */
  const land = async ({ source: { key, mod, cfg, budget }, result, ms }) => {
    // A source that returned nothing but errors is either broken or unreachable, and
    // the two must not be treated alike. Asked only now, and only for an empty
    // result: one that returned jobs plainly had a connection.
    //
    // Offline records NOTHING — not the quota, which is a receipt for calls that
    // reached the API (JSearch gets one run a day, and a scan started before Wi-Fi
    // was back used it up over requests that never left the machine), and not the
    // schedule, which would put the source on a retry meant for a server that
    // answered badly. The source stays due and is tried when a connection returns.
    //
    // Once one source has found the connection down, the others that were already in flight
    // are taken to have failed for the same reason: probing again for each would only wait
    // out a second and third timeout to say the same thing.
    const nothingBack = Boolean(result.errors?.length) && !result.jobs.length;
    if (nothingBack && (offlineSeen || !(await connectivity.isOnline()))) {
      offlineSeen = true;
      attempts[key].offline = true;
      console.log(`  ${cfg.label} … no connection`);
      warnings.push(`${cfg.label}: not fetched — no internet connection`);
      return;
    }

    // Written even on a dry run, because the call already left the machine. A
    // quota record is the receipt for a side effect, not the "memory" that
    // --dry-run exists to protect.
    if (cfg.quota) {
      quota.record(quotaState, key, cfg.quota, result.calls ?? budget.calls ?? 0);
      quota.save(quotaState);
    }

    if (nothingBack) attempts[key].failed = true;

    spent.fetch += ms;
    const n = result.jobs.length;
    // One line, printed when the source LANDS: with several fetches in flight a label printed
    // at the start and a result at the end would interleave into nonsense.
    console.log(`  ${cfg.label} … ${n} job${n === 1 ? '' : 's'} (${ms}ms)`);
    sourceLines.push(`${cfg.label}: ${n} fetched`);

    for (const e of result.errors || []) {
      const msg = `${cfg.label}: ${e}`;
      warnings.push(msg);
      if (verbose || mod.failSoft) log.warn(`    ${e}`);
    }
    // A source may separate what it has to say. WARNINGS are actionable and always shown (an
    // alert from a sender nothing can read); NOTES are information. Neither is a failed fetch,
    // which is what an entry in `errors` with no jobs is taken to be.
    for (const w of result.warnings || []) {
      warnings.push(`${cfg.label}: ${w}`);
      log.warn(`    ${w}`);
    }
    if (result.summary) log.dim(`    ${result.summary}`);
    if (verbose) for (const note of result.notes || []) log.dim(`    ${note}`);
    run.fetched += result.jobs.length;

    // The replay snapshot is each source's latest slice, so it is written as each
    // source lands, BEFORE that source is judged — a crash in a gate still leaves a
    // usable snapshot. A source that came back with errors and nothing else gets no
    // range, so the snapshot keeps the slice it already had rather than replacing it
    // with a gap.
    let owed = false;
    // A source that returns only what is NEW (the mailbox, once it has a bookmark) says so
    // with `merge`. Its jobs are folded into the stored slice, and a scan that found nothing
    // new leaves the slice alone: replacing it would leave `--replay` judging only the latest
    // batch of mails, or none at all.
    const delta = Boolean(result.merge);
    const tSnap = Date.now();
    if (!dryRun && !nothingBack && !(delta && !result.jobs.length)) {
      const slice = delta ? fetched.mergeSlice(key, result.jobs, result.merge) : result.jobs;
      fetched.save(slice, {
        sources: sourceLines, warnings, carry: enabled,
        ranges: { [key]: [0, slice.length] },
      });
      log.dim(`  stored the fetch for --replay (${fetched.sizeMb().toFixed(1)} MB)`);
      if (result.jobs.length) {
        // The postings are on disk and owed a judging. Marked AFTER the snapshot is
        // written: a crash between the two leaves a snapshot with no marker, and the
        // source (not yet committed) is simply fetched again.
        batches.owe(owedState, key, { label: cfg.label, count: result.jobs.length });
        batches.save(owedState);
        owed = true;
      }
    }
    // What the source returned is safe, so it may sleep NOW rather than after it has
    // been judged: the judge lane can be minutes behind, and a scan cut off in that
    // gap resumes from the snapshot instead of fetching the same source again.
    spent.snapshot += Date.now() - tSnap;
    if (owed) commitSchedule(key);

    if (result.jobs.length) {
      // The fetch side stops here: reading the adverts and the rules gates. The
      // model and memory are the judge lane's, so the NEXT source is fetched while
      // this one waits on its rate limit.
      const tPrep = Date.now();
      const prepared = await prepare(result.jobs, cfg.label);
      spent.prepare += Date.now() - tPrep;
      // Time spent here is the fetch side WAITING for the judge lane: the lane holds one batch,
      // so this is the cost of a slow model or a slow save, paid by the next source's fetch.
      const tHand = Date.now();
      await judgeLane.push({ key, prepared, owed, commit: result.commit });
      spent.handoff += Date.now() - tHand;
    } else {
      // Nothing to judge: whatever the source wants remembered (a mailbox bookmark, when
      // mail arrived that held no jobs) is final now. A dry run remembers nothing.
      if (!dryRun && !nothingBack) await commitSource(result.commit);
      commitSchedule(key);
    }
  };

  /** Start one source's fetch. Never throws: a source that fails comes back as errors and no jobs. */
  const fetchSource = async (source) => {
    const t0 = Date.now();
    const { mod, cfg, boards, budget } = source;
    let result;
    try {
      result = await mod.fetchJobs({
        queries,
        profile,
        boards,
        categories: cfg.categories,
        concurrency: sourcesCfg.http.concurrency,
        country: cfg.country,
        maxPages: cfg.maxPages,
        maxQueries: budget.calls ?? cfg.maxQueries,
        host: cfg.host,
        path: cfg.path,
        titleFilter: (t) => looksRelevant(t, profile),
        locationFilter: (l) => looksReachable(l),
        countries: REACHABLE_COUNTRIES,
        // A dry run promises to write nothing; a source that keeps a cache of its own must know.
        persist: !dryRun,
      });
    } catch (e) {
      result = { jobs: [], errors: [e.message] };
    }
    return { source, result, ms: Date.now() - t0 };
  };

  if (runnable.length > 1 && fetchAtOnce > 1) {
    log.dim(`  fetching up to ${Math.min(fetchAtOnce, runnable.length)} of ${runnable.length} sources at once`);
  }
  await runPool(runnable, {
    limit: fetchAtOnce,
    start: fetchSource,
    land: (_source, landed) => land(landed),
    // Once one source has found the connection down, the sources still waiting for a slot are not
    // started: each would only wait out its own timeout to say the same thing.
    shouldSkip: () => offlineSeen,
    onSkip: (next) => {
      attempts[next.key].offline = true;
      log.dim(`  ${next.cfg.label}: not tried — no connection`);
    },
  });
  } finally {
    // Whatever stopped the loop, let the lane finish what it was handed — a batch
    // already prepared is worth saving — and surface its failure after the loop.
    try { await judgeLane.close(); } catch (e) { laneError = e; }
  }
  if (laneError) throw laneError;

  if (replay) {
    run.fetched += snapshot.jobs.length;
    log.head(`Replaying the last fetch — ${fetched.describe(snapshot)}`);
    for (const line of snapshot.sources || []) sourceLines.push(line);
    // The snapshot's own warnings are carried forward rather than dropped. A
    // source skipped for a spent quota contributed nothing to it, and a replay
    // that quietly reported zero from that source would read as a fetch failure
    // rather than a budget.
    for (const w of snapshot.warnings || []) warnings.push(w);

    const age = fetched.ageHours(snapshot);
    if (age !== null && age > 24) {
      log.warn(`  the stored fetch is ${Math.round(age / 24)} day(s) old — run without --replay for fresh postings`);
    }
    log.dim('  no network: sources, quotas and the advert cache are all untouched');
    await judge(snapshot.jobs, 'The last fetch');
  }

  if (!run.fetched && !run.drained) {
    if (judgeQueue) {
      log.dim('  nothing was waiting for the AI');
      return;
    }
    const tried = Object.values(attempts);
    if (tried.length && tried.every((a) => a.offline)) {
      log.warn('  no internet connection — nothing was fetched. Every source stays due and is tried when a connection is back.');
      commitSchedule();
      return;
    }
    // An empty inbox is the ordinary result of a half-hourly check, not an outage.
    if (dueOnly) {
      log.dim('  the sources that were due returned no postings');
      commitSchedule();
      return;
    }
    log.err('No jobs fetched from any source. Check connectivity, or run with --verbose.');
    commitSchedule();
    return;
  }

  if (dryRun) {
    reportGates();
    reportTimings();
    log.warn('--dry-run: nothing written to memory or disk');
    preview([...run.reported.values()].sort((a, b) => b.score - a.score));
    return;
  }

  /* ---- report ---- */
  reportGates();
  if (!dryRun && !replay && titledrops.save(titleMemo)) log.dim('  remembered which postings the title settles');
  const state = store.load();
  const tFinalReport = Date.now();
  const { toReport, dated } = writeReport(state);
  spent.report += Date.now() - tFinalReport;

  store.markShown(state, toReport);
  const tFinish = Date.now();
  // Leave nothing un-judged in the archive. The pass above interleaves gating
  // with enrichment and adjudication for the postings fetched this run; this
  // makes sure every OTHER archived job also carries a current verdict, so the
  // report never has to decide anything.
  persistVerdicts(state);
  store.save(state);
  commitSchedule();
  spent.finish += Date.now() - tFinish;
  reportTimings();

  log.ok(`Report written: ${dated}`);
  preview(toReport);
  if (toReport.length) log.dim('\nOpen it with:  npm run serve');
}

function preview(jobs) {
  if (!jobs.length) {
    log.info('\n  Nothing new — everything returned has been shown before.');
    return;
  }
  log.head(`Top ${Math.min(10, jobs.length)}:`);
  for (const j of jobs.slice(0, 10)) {
    const where = j.workMode === 'remote'
      ? `Remote${j.remoteScope ? `/${j.remoteScope}` : ''}`
      : `${j.city || j.location}${j.distanceKm != null ? ` ${j.distanceKm}km` : ''}`;
    const flag = j.band === 'stretch' ? ' [DE-stretch]' : j.country === 'CH' ? ' [CH]' : '';
    console.log(`  ${String(j.score).padStart(3)}  ${j.title.slice(0, 52).padEnd(52)} ${j.company.slice(0, 22).padEnd(22)} ${where}${flag}`);
  }
}

/**
 * When a job never reaches the model (over the call cap) and the rules had no
 * single reason either, attribute it to whatever the rules were unsure about —
 * otherwise a sixth of every run lands in a meaningless "Other" bucket.
 */
function kindToCategory(uncertainties = []) {
  const map = {
    german: 'language', location: 'location', 'remote-scope': 'location',
    'work-mode': 'location', programming: 'programming', aws: 'aws',
    title: 'role', fit: 'score',
  };
  for (const u of uncertainties) if (map[u.kind]) return map[u.kind];
  return null;
}

/**
 * Cheap location pre-check, for sources that list a location before we pay for
 * the full record. Global employers return Hyderabad and Madrid alongside
 * nearby offices, and fetching those only to have the location gate drop them wastes a
 * request each.
 *
 * Deliberately generous: it rejects only what resolves to a country that is
 * definitely not commutable. Anything unresolved, remote, or nearby survives to
 * be judged properly — the same bias as everywhere else, since a wrong keep
 * costs one request and a wrong drop costs an opportunity.
 */
/**
 * Countries close enough to be worth fetching, as ISO codes and as the names
 * Workday's `locationCountry` facet uses.
 *
 * One list, two consumers: the client-side check below and the server-side
 * facet in the Workday adapter. Kept together because a board filtered to
 * countries the local check then rejects would burn the request for nothing.
 */
const REACHABLE = [
  { code: 'DE', name: 'Germany' },
  { code: 'CH', name: 'Switzerland' },
  { code: 'FR', name: 'France' },
];
const REACHABLE_CODES = REACHABLE.map((c) => c.code);
const REACHABLE_COUNTRIES = REACHABLE.map((c) => c.name);

function looksReachable(locationText = '') {
  const t = slug(locationText);
  if (!t) return true;
  if (/remote|home office|anywhere|flexible/.test(t)) return true;

  const geo = resolveLocation(locationText, profile.location);
  if (geo.distanceKm != null) return geo.distanceKm <= profile.location.radiusKm;
  // Resolved to a country but not a town: keep only if that country is near.
  if (geo.country) return REACHABLE_CODES.includes(geo.country);
  return true;  // unknown — let the real gate decide
}

/**
 * The words that make a title worth a detail fetch: the profile's field
 * vocabulary plus every word of its target titles that is not a bare role noun
 * ("engineer" alone would let everything through).
 */
const GENERIC_TITLE_WORDS = new Set(['engineer', 'developer', 'architect', 'manager', 'lead', 'senior', 'specialist', 'consultant']);
const relevantKeywords = (profile) => [...new Set([
  ...(profile.relevance?.domainTerms || []),
  ...(profile.relevance?.nearMissTerms || []),
  ...[...profile.targetTitles.strong, ...profile.targetTitles.good]
    .flatMap((t) => slug(t).split(' ')).filter((w) => w.length > 1 && !GENERIC_TITLE_WORDS.has(w)),
].map(slug).filter(Boolean))];

/**
 * Cheap pre-check used to limit expensive detail fetches.
 *
 * Whole words, with a plural tolerated so "Cloud Platforms Engineer" still
 * matches. Substring matching pulled in "Hyperautomation Fullstack Developer"
 * on `automation` — the same trap that makes hasPhrase() whole-word only.
 */
function looksRelevant(title, profile) {
  const t = slug(title);
  return relevantKeywords(profile).some((k) =>
    new RegExp(`(^|[^a-z0-9])${k.replace(/ /g, '[^a-z0-9]+')}s?([^a-z0-9]|$)`).test(t));
}

/** What `npm run keys` searches for: the user's own first query. */
const probeQuery = (profile) => (profile.searchQueries || profile.targetTitles.strong)[0] || 'engineer';

/* ---------------------------------------------------------------- discover */

async function discover() {
  // Workday is a different problem and needs a different command shape. Its
  // tenants CANNOT be probed for: *.myworkdayjobs.com is a wildcard, so an
  // invented tenant answers 422 rather than failing, and a probe loop would
  // happily "discover" companies that do not exist. The URL has to come from
  // the real career site, so this verifies one rather than guessing many.
  if (has('--add') || has('--workday')) return addBoard();

  log.head('Discovering company ATS boards');
  log.dim('Probing candidate slugs — slugs are tested, never guessed.\n');

  const ignored = ignoredBoards();
  if (ignored.length) {
    log.dim(`  ${ignored.length} board(s) on the ignore list — see config/companies.json:`);
    for (const x of ignored) log.dim(`    ${x.ats}/${x.slug} — ${firstSentence(x.reason)}`);
    console.log('');
  }

  const groups = Object.entries(companies.candidates).filter(([k]) => !k.startsWith('_'));
  const tasks = [];
  for (const [region, slugs] of groups) {
    for (const s of slugs) {
      for (const ats of Object.keys(ATS)) tasks.push({ region, slug: s, ats });
    }
  }

  log.step(`${tasks.length} probes across ${Object.keys(ATS).length} ATS platforms…`);

  let done = 0;
  const found = [];
  await pool(tasks, 8, async (t) => {
    const r = await probe(t.ats, t.slug);
    done++;
    if (done % 50 === 0) process.stdout.write(`  ${done}/${tasks.length}\r`);
    if (r.ok && r.count > 0 && !isIgnored(t.ats, t.slug)) {
      found.push({ ats: t.ats, slug: t.slug, name: t.slug, region: t.region, jobs: r.count, verified: new Date().toISOString() });
    }
  });

  console.log('');
  if (!found.length) {
    log.warn('No boards found. The candidate slugs in config/companies.json may need adjusting.');
    return;
  }

  found.sort((a, b) => b.jobs - a.jobs);
  log.ok(`Found ${found.length} live board(s):\n`);
  for (const b of found) {
    console.log(`  ${String(b.jobs).padStart(4)} jobs  ${b.ats.padEnd(16)} ${b.slug.padEnd(20)} ${b.region}`);
  }

  companies.boards = found;
  writeJson(p('config', 'companies.json'), companies);
  log.ok(`\nSaved to config/companies.json — they are now polled by \`npm run search\`.`);
  log.dim(`  Workday employers are added separately: npm run discover -- --workday <career-site URL>`);
}

/**
 * `npm run discover -- --add <careers URL> [Name]` — add one company from
 * whatever URL you happen to have.
 *
 * The platform is worked out from the URL, or from the page itself when it is
 * the company's own careers domain. You should not have to know whether an
 * employer runs Greenhouse or Workday before you can add it — that is the
 * tool's job, and it is the difference between "paste a link" and "identify the
 * ATS, find the slug, edit JSON, re-run 385 probes".
 */
/**
 * Boards deliberately not polled, and why.
 *
 * A board you have looked at and said no to is a DECISION, and a decision that
 * leaves no trace gets made again. Deleting the entry from `boards` was the
 * obvious move and the wrong one: the next `discover` probes the same slug,
 * finds postings, and puts it straight back — with nothing anywhere saying it
 * had already been considered and refused.
 *
 * So the verdict is written down next to the thing it is about. Both the full
 * probe and `--add` read it, because `--add` is the path that would undo it.
 */
const ignoredBoards = () => (companies.ignored || []).filter((x) => x && x.ats && x.slug);

const isIgnored = (ats, slug) => ignoredBoards().find((x) =>
  x.ats.toLowerCase() === String(ats || '').toLowerCase()
  && x.slug.toLowerCase() === String(slug || '').toLowerCase());

/** Enough of a recorded reason to be useful in a one-line log. */
const firstSentence = (s) => {
  const t = String(s || '').trim();
  const cut = t.indexOf('. ');
  return cut === -1 ? t : t.slice(0, cut + 1);
};

async function addBoard() {
  const url = positional.find((a) => a.startsWith('http'));
  if (!url) {
    log.err('Usage: npm run discover -- --add <careers URL> [Company Name]');
    log.dim(`  Recognises: ${detect.SUPPORTED.join(', ')}`);
    log.dim('\n  Paste the URL you see when browsing a company\'s jobs. Either the board');
    log.dim('  itself (jobs.lever.co/acme) or the company\'s own careers page — if it');
    log.dim('  embeds a known board, that will be found.');
    return;
  }

  log.step(`Identifying ${url}…`);
  let hit = detect.fromUrl(url);

  // Checked here as well as in the full probe, because this is the path that
  // would undo the decision. Pasting the same link a month later is exactly how
  // a board you already ruled out comes back, and the reason it was ruled out
  // is not something you will remember — so it is recorded and read back.
  const veto = hit && isIgnored(hit.ats, hit.slug || hit.board?.tenant);
  if (veto) {
    log.err(`${veto.ats}/${veto.slug} is on the ignore list — not added.`);
    log.dim(`  ${veto.reason}`);
    log.dim(`  Decided ${veto.decidedAt}. Remove it from "ignored" in config/companies.json to override.`);
    return;
  }

  if (!hit) {
    // Not a board URL. It may be the company's own careers page with a board
    // embedded, which is the common case for employers with their own domain.
    log.dim('  Not a board URL directly — checking the page for an embedded board…');
    const page = await detect.fromPage(url);
    if (page.error) {
      log.err(`Could not identify a job board — ${page.error}`);
      log.dim('  Career sites are usually JavaScript apps with no job data in the HTML,');
      log.dim('  so if the board is loaded dynamically it will not be visible here.');
      log.dim('  Click through to an actual job posting and paste THAT URL instead.');
      return;
    }
    hit = page;
    log.dim(`  found ${hit.ats} via ${hit.via}`);
  }

  const name = positional.find((a) => !a.startsWith('http'))
    || hit.slug || hit.board?.tenant;

  if (hit.ats === 'workday') {
    const b = hit.board;
    log.step(`Verifying Workday ${b.tenant}/${b.pod}/${b.site}…`);
    const r = await workday.probe(b);
    if (!r.ok) {
      log.err(`No board there — ${r.error}`);
      // A wildcard domain means a wrong name answers rather than failing to
      // resolve, so each status needs translating into what to actually fix.
      if (r.status === 422) log.dim('  422: the tenant answered but the site name is wrong. Re-copy the URL from a job page.');
      if (r.status === 404) log.dim('  404: wrong tenant, or wrong pod (try wd1 / wd3 / wd5).');
      if (r.status === 401) log.dim('  401: the board is private — internal postings only.');
      return;
    }
    companies.workday = (companies.workday || []).filter((x) => x.tenant !== b.tenant);
    companies.workday.push({ ...b, name, url, jobs: r.count, verified: new Date().toISOString() });
    writeJson(p('config', 'companies.json'), companies);
    log.ok(`${name}: ${r.count} postings on Workday — saved.`);
  } else {
    log.step(`Verifying ${hit.ats}/${hit.slug}…`);
    const r = await probe(hit.ats, hit.slug);
    if (!r.ok || !r.count) {
      log.err(`No board there — ${r.error || 'returned no postings'}`);
      log.dim('  The slug may be wrong, or the board may genuinely be empty right now.');
      return;
    }
    companies.boards = (companies.boards || [])
      .filter((x) => !(x.ats === hit.ats && x.slug === hit.slug));
    companies.boards.push({
      ats: hit.ats, slug: hit.slug, name, region: 'added-manually',
      jobs: r.count, verified: new Date().toISOString(),
    });
    writeJson(p('config', 'companies.json'), companies);
    log.ok(`${name}: ${r.count} postings on ${hit.ats} — saved.`);
  }

  log.dim('  Polled from your next `npm run search`.');
  // A slug added here would otherwise be wiped by the next full discover run,
  // which overwrites companies.boards from the candidate list alone.
  if (hit.ats !== 'workday') {
    log.dim(`  Add "${hit.slug}" to candidates in config/companies.json so a full`);
    log.dim('  `npm run discover` does not drop it again.');
  }
}

/* ------------------------------------------------------------------- apply */

/** Find a job by id prefix, url or title — across kept AND rejected postings. */
function findJob(query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return null;
  const pool = [...Object.values(store.load().jobs), ...Object.values(rejects.load())];
  return pool.find((j) => j.fingerprint?.startsWith(q))
    || pool.find((j) => String(j.applyUrl || '').toLowerCase().split(/[?#]/)[0] === q.split(/[?#]/)[0])
    || pool.find((j) => `${j.title} ${j.company}`.toLowerCase().includes(q));
}

/**
 * `npm run apply -- <id>` — tailored resume and cover letter for one posting.
 * `npm run apply -- <id> --diff`      what was changed, from the audit trail
 * `npm run apply -- <id> --recheck`   re-read the advert first, and stop if it now fails a gate
 * `npm run apply -- --learn`            what you changed after generation
 * `npm run apply -- --outcome <f> <o>`  record what happened
 */
async function applyCmd() {
  const masterFile = p('config', 'master.json');
  if (!existsSync(masterFile)) {
    log.err('config/master.json not found — the generator has no facts to work from.');
    log.dim('  It holds your achievements, voice samples and the technology whitelist.');
    return;
  }
  const master = readJson(masterFile);

  if (has('--learn')) return showLearned();
  if (has('--outcome')) {
    const i = argv.indexOf('--outcome');
    const r = applyMod.setOutcome(argv[i + 1], argv[i + 2]);
    return r.ok
      ? log.ok(`${r.meta.company}: ${r.meta.outcome}`)
      : log.err(`${r.error}. Outcomes: ${applyMod.OUTCOMES.join(', ')}`);
  }
  if (has('--list') || !positional.length) return listApps();

  const job = findJob(positional.join(' '));
  if (!job) {
    log.err(`No posting matching "${positional.join(' ')}".`);
    log.dim('  Try the 8-character id from the report, or part of the title.');
    return;
  }

  log.head(`${job.title} · ${job.company}`);
  // Read-only: the audit trail already holds the edits, so this needs no
  // network and no model call.
  if (has('--diff')) return void await applyMod.showDiff(job, { master });

  await applyMod.apply(job, {
    master, profile, verbose: has('--verbose'), refresh: has('--refresh'),
    recheckAd: has('--recheck'),
  });
}

function listApps() {
  const apps = applyMod.listApplications();
  if (!apps.length) {
    log.head('No applications generated yet');
    log.dim('  npm run apply -- <job id>     — the id shown on each report card');
    return;
  }
  log.head(`${apps.length} application(s)`);
  for (const a of apps) {
    const flag = a.blocked ? '!' : a.outcome && a.outcome !== 'applied' ? '*' : ' ';
    console.log(`  ${flag} ${(a.company || '?').slice(0, 20).padEnd(22)}${(a.outcome || 'applied').padEnd(11)}${String(a.at || '').slice(0, 10)}`);
    if (a.salaryAsked) log.dim(`      asked ${a.salaryAsked}`);
    if (a.storyline) log.dim(`      ${a.storyline}`);
  }
  log.dim(`\n  Record what happened:  npm run apply -- --outcome <folder> interview`);
}

async function showLearned() {
  const pairs = await applyMod.learn();
  if (!pairs.length) {
    log.head('Nothing changed since generation');
    log.dim('  Edit a CoverLetter.docx and re-run this to see what you corrected.');
    return;
  }
  log.head(`${pairs.length} paragraph(s) you rewrote`);
  log.dim('  These are the feedback. Recurring corrections become style rules.\n');
  for (const x of pairs) {
    console.log(`  ${x.folder}`);
    log.dim(`    generated: ${x.generated.slice(0, 150)}`);
    console.log(`    you sent : ${x.yours.slice(0, 150)}\n`);
  }
}

/* --------------------------------------------------------------- companies */

/** Every posting the tool has on file, kept and rejected alike. */
function allArchived() {
  const state = store.load();
  const rej = rejects.load();
  return [...Object.values(state.jobs), ...Object.values(rej)];
}

function evaluateWatchlist() {
  return watchlist.evaluate(watchlist.load(), {
    boards: companies.boards || [],
    workday: companies.workday || [],
    careersites: careersiteIds,
    beesite: companies.beesite || [],
    archive: allArchived(),
  });
}

/** Entry point for `npm run companies`, with or without --alert. */
async function companiesCmd() {
  return has('--alert') ? markAlert() : showCompanies();
}

/**
 * `npm run companies` — who you are actually covering.
 *
 * Configuring a board is not the same as receiving jobs from it: three local
 * employers looked covered while serving one posting each. This shows the
 * evidence — board size and postings ever archived — rather than the intent.
 */
async function showCompanies() {
  const rows = evaluateWatchlist();
  const sum = watchlist.summarise(rows);

  log.head(`Company watchlist — ${sum.covered} of ${sum.total} actually covered`);

  let region = null;
  for (const c of rows) {
    const status = watchlist.STATUS[c.status];
    if (c.status !== region) {
      console.log('');
      log.dim(`  ${status.label.toUpperCase()}`);
      region = c.status;
    }
    const evidence = [
      c.boardJobs != null ? `board ${c.boardJobs}` : null,
      c.postingsSeen ? `${c.postingsSeen} seen` : null,
      c.platform || null,
    ].filter(Boolean).join(' · ');
    console.log(`    ${status.ok ? '✓' : '·'} ${c.name.padEnd(24)} ${(c.region || '').padEnd(20)} ${evidence}`);
  }

  console.log('');
  const todo = rows.filter((c) => !watchlist.STATUS[c.status].ok);
  if (todo.length) {
    log.warn(`${todo.length} companies are not reaching you.`);
    log.dim('  Set up an email alert on their careers page, then mark it:');
    log.dim(`    npm run companies -- --alert ${todo[0].id}`);
    log.dim('  Or, if you find their board URL:');
    log.dim('    npm run discover -- --add <url>');
  }
}

/** `npm run companies -- --alert <id>` — record that you created an alert. */
async function markAlert() {
  const i = argv.indexOf('--alert');
  const id = argv[i + 1];
  const off = has('--off');

  const wl = watchlist.load();
  if (!id || id.startsWith('--')) {
    log.err('Usage: npm run companies -- --alert <id> [--off]');
    log.dim(`  ids: ${(wl.companies || []).map((c) => c.id).join(', ')}`);
    return;
  }

  const r = watchlist.setAlert(wl, id, !off);
  if (!r.ok) return log.err(r.error);
  watchlist.save(wl);
  log.ok(`${r.company.name}: email alert ${off ? 'cleared' : 'recorded'}`);
  if (!off) log.dim('  Alert emails are parsed by the mailalerts source — make sure they land in your IMAP_FOLDER.');
}

/* ---------------------------------------------------------------- reviewed */

/**
 * `npm run reviewed -- <gate|all>` — dismiss a gate's rejections for good.
 *
 * The terminal twin of the report's "Mark all reviewed" button, and what that
 * button copies to your clipboard when the report is opened from disk rather
 * than served.
 *
 * Nothing is deleted. Each entry keeps its fingerprint and gains a review
 * timestamp, which is precisely what lets the next run tell a posting you have
 * already dismissed from one it has never shown you.
 */
async function reviewed() {
  const archive = rejects.load();
  const undo = positional[0] === 'undo';
  const which = (undo ? positional[1] : positional[0]) || '';

  const pendingCounts = rejects.pendingByCategory(archive);
  const known = new Set([...Object.keys(REJECT_CATEGORIES), 'all']);

  if (!which) {
    const outstanding = rejects.unreviewed(archive, answeredBy(store.load())).length;
    log.head(`${outstanding} rejection(s) awaiting review`);
    if (!outstanding) {
      log.dim('  You are caught up. New ones appear after the next `npm run search`.');
    }
    for (const [cat, n] of Object.entries(pendingCounts).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${String(n).padStart(6)}  ${(REJECT_CATEGORIES[cat] || cat).padEnd(24)} npm run reviewed -- ${cat}`);
    }
    const done = rejects.size(archive) - outstanding;
    if (done) log.dim(`\n  ${done} already reviewed and hidden. Bring a gate back: npm run reviewed -- undo <gate>`);
    return;
  }

  if (!known.has(which)) {
    log.err(`Unknown gate "${which}". Use one of: ${[...known].join(', ')}`);
    return;
  }

  if (undo) {
    const { archive: next, cleared } = rejects.unmarkReviewed(archive, which);
    rejects.save(next);
    log.ok(`${cleared} rejection(s) restored to the review list`);
    log.dim('  Note: reviewing strips the description excerpt, so restored entries are slimmer.');
    return;
  }

  const { archive: next, marked } = rejects.markReviewed(archive, which);
  rejects.save(next);
  const left = rejects.unreviewed(next).length;
  log.ok(`${marked} rejection(s) marked reviewed — ${left} left across all gates`);
  log.dim('  They keep their ids, so the next run shows only what is new here.');
  log.dim(`  Undo: npm run reviewed -- undo ${which}`);
}

/* ----------------------------------------------------------------- explain */

/**
 * `npm run why -- <id|url|title>` — the whole reasoning behind one decision.
 *
 * The drop histogram tells you a rule fired; this tells you whether it should
 * have. It replays every gate rather than only the one that stopped the
 * posting, so you can see what else would have caught it — a rule that is the
 * sole thing rejecting hundreds of jobs deserves more scrutiny than one that
 * merely got there first.
 */
async function why() {
  const query = positional.join(' ').trim();
  if (!query) {
    log.err('Usage: npm run why -- <fingerprint|url|title or company>');
    log.dim('  e.g. npm run why -- 1a2b3c4d');
    log.dim('       npm run why -- "Cloud Engineer"');
    log.dim('       npm run why -- https://boards.greenhouse.io/acme/jobs/12345');
    return;
  }

  const archive = rejects.load();
  const state = store.load();

  let hits = rejects.find(archive, query);

  // It may not have been rejected at all — "why didn't I see this?" is often
  // answered by "you did, three weeks ago, and marked it rejected yourself".
  const shown = Object.values(state.jobs).filter((j) =>
    j.fingerprint.startsWith(query.toLowerCase())
    || `${j.title} ${j.company}`.toLowerCase().includes(query.toLowerCase()));

  if (!hits.length && !shown.length) {
    log.err(`Nothing matching "${query}" in the archive.`);
    log.dim(`  ${rejects.size(archive)} rejections and ${Object.keys(state.jobs).length} kept jobs are on file.`);
    log.dim('  Rejections are only archived from runs after this feature was added,');
    log.dim('  and are pruned after 60 days. Run `npm run search` to populate it.');
    return;
  }

  if (hits.length + shown.length > 1 && !/^[0-9a-f]{6,}$/.test(query)) {
    log.head(`${hits.length + shown.length} matches — narrow it down or use an id`);
    for (const e of shown) console.log(`  ${e.fingerprint.slice(0, 8)}  [shown]    ${e.title} · ${e.company}`);
    for (const e of hits) console.log(`  ${e.fingerprint.slice(0, 8)}  [rejected] ${e.title} · ${e.company}`);
    return;
  }

  if (shown.length) return explainKept(shown[0], state);
  explainRejected(hits[0]);
}

function explainKept(job, state) {
  const seen = state.seen[job.fingerprint] || {};
  log.head(`${job.title} · ${job.company}`);
  log.ok(`  This one PASSED — status "${seen.status}", first seen ${(seen.firstSeen || '').slice(0, 10)}`);
  console.log(`  ${job.applyUrl}`);
  gateTable(job);
}

function explainRejected(e) {
  log.head(`${e.title} · ${e.company}`);
  console.log(`  ${e.location || 'location unspecified'}`
    + `${e.distanceKm != null ? ` · ${e.distanceKm}km` : ''}`
    + ` · ${e.workMode}${e.remoteScope ? ` (${e.remoteScope})` : ''}`);
  console.log(`  ${e.sourceLabel} · posted ${(e.postedAt || '').slice(0, 10) || 'unknown'} · id ${e.fingerprint.slice(0, 8)}`);
  console.log(`  ${e.applyUrl}`);

  const by = e.decidedBy === 'rules' ? 'the rules'
    : e.decidedBy === 'rules-fallback' ? 'the rules (AI unavailable)'
      : `the AI adjudicator (${e.decidedBy})`;
  console.log('');
  log.err(`REJECTED by ${by}`);
  const now = rejects.describeRejection(e, profile);
  console.log(`  ${now}`);
  // The archive keeps what was said at the time; the line above is how the
  // current rules put it. Show both only when they actually differ.
  if (e.reason && e.reason !== now && !e.aiReason) log.dim(`  (recorded then as: ${e.reason})`);
  console.log(`  category: ${REJECT_CATEGORIES[e.category] || e.category}`
    + ` · seen on ${e.runs} run${e.runs === 1 ? '' : 's'} · last ${(e.lastRejected || '').slice(0, 10)}`);

  if (e.previously?.length) {
    log.dim('\n  Previously rejected for a different reason — a rule changed under it:');
    for (const prev of e.previously) log.dim(`    ${(prev.at || '').slice(0, 10)}  ${prev.reason}`);
  }

  // The AI's own working, when it was the one that decided.
  const verdict = readJson(p('data', 'verdicts.json'), {})?.verdicts?.[e.fingerprint];
  if (verdict?.resolved?.length) {
    log.head('What the adjudicator was asked, and answered');
    for (const r of verdict.resolved) {
      console.log(`  ${r.kind}: ${r.answer}`);
    }
    log.dim(`  (${verdict.provider}/${verdict.model}, confidence ${verdict.confidence})`);
  }

  gateTable(e);

  const queue = pending.load()[e.fingerprint];
  if (queue) {
    console.log('');
    log.warn(`Queued for re-adjudication: ${queue.attempts} attempt(s) since ${(queue.firstDeferred || '').slice(0, 10)} — ${queue.reason}`);
  }

  if (e.excerpt) {
    log.head('Posting excerpt');
    console.log(e.excerpt.split('\n').map((l) => `  ${l}`).join('\n'));
    if (e.excerptTruncated) log.dim('  … truncated — open the URL above for the rest');
  } else if (e.slimmed) {
    log.dim(`\n  Reviewed on ${(e.reviewedAt || '').slice(0, 10)}, so the excerpt was dropped to`);
    log.dim('  keep the archive small. The gates above still replay exactly.');
  }
}

/** Every gate's verdict, with the one that actually stopped it marked. */
/**
 * What each phase is for, in the order the pipeline runs them.
 *
 * Worth printing: "why was this dropped before we read the advert" and "why was
 * it dropped after" are different questions, and the answer used to be
 * invisible because everything ran in one pass.
 */
const PHASE_LABEL = {
  title: 'the title alone',
  liveness: 'is it still there',
  rules: 'the full advert',
};

function gateTable(job) {
  const { checks, stoppedAt, uncertainties, verdict } = explain(job, profile, {
    includeGerman: has('--include-german'),
  });

  // "not reached" used to appear for every gate after the decisive one, because
  // the pipeline short-circuited and only the replay ran them all. It no longer
  // short-circuits — every gate runs on every posting and every failure is
  // recorded — so that label would now be untrue in both places.
  // Grouped by PHASE, which is the order the pipeline runs them in. The CHECKS
  // array is ordered differently on purpose — array position decides which
  // reason owns the verdict, and `closed` has to sit first there so a shut
  // posting archives as closed rather than as "639km away".
  log.head('Every gate, in the order they run');
  for (const phase of PHASES) {
    const inPhase = checks.filter((c) => c.phase === phase);
    if (!inPhase.length) continue;
    log.dim(`  — ${PHASE_LABEL[phase] || phase} —`);
    for (const c of inPhase) {
      const mark = c.id === stoppedAt ? '✗ DECIDED HERE'
        : !c.keep ? (c.certain ? '✗ also drops' : '~ also flags')
          : '✓ pass';
      console.log(`  ${c.label.padEnd(24)} ${mark}`);
      if (c.reason) console.log(`  ${' '.repeat(24)}   ${c.reason}`);
    }
  }

  if (uncertainties.length) {
    log.head('What the rules could not settle');
    for (const u of uncertainties) {
      console.log(`  [${u.kind}] ${u.question}`);
      if (u.evidence) log.dim(`         evidence: ${String(u.evidence).slice(0, 160)}`);
    }
  }

  const sig = [
    job.germanRequired && (() => {
      const g = germanGap(job.germanRequired, job.germanEvidence, profile.languages.germanLevel);
      if (!g) return 'German: none required';
      // g.text already names the level and the gap; g.label only earns a place
      // when it says something the level does not.
      const gloss = g.cefr ? ` (${g.label})` : '';
      return `German: ${g.text}${gloss}`
        + (job.germanEvidence ? `\n${' '.repeat(10)}from: "${String(job.germanEvidence).slice(0, 70)}"` : '');
    })(),
    job.programmingRequired && `Programming: ${job.programmingRequired}${job.programmingLanguage ? ` (${job.programmingLanguage})` : ''}${job.programmingEvidence ? ` — "${String(job.programmingEvidence).slice(0, 70)}"` : ''}`,
  ].filter(Boolean);
  if (sig.length) {
    log.head('Signals detected at normalize time');
    for (const s of sig) console.log(`  ${s}`);
  }

  if (job.scoreBreakdown?.length) {
    log.head(`Score ${job.score}/100 (threshold ${profile.filters.minScore})`);
    for (const b of job.scoreBreakdown) {
      console.log(`  ${String(b.points >= 0 ? `+${b.points}` : b.points).padStart(4)}  ${b.label}`);
    }
  }

  log.dim(`\n  Replayed against the CURRENT rules — verdict now: ${verdict.decision}`
    + `${verdict.reason ? ` (${verdict.reason})` : ''}`);
  log.dim('  Rejections are not in seen.json, so editing a rule and re-running');
  log.dim('  `npm run search` is enough to bring a job back — nothing to un-hide.');
}

/* ------------------------------------------------------------- report/misc */

/**
 * Re-judge archived jobs against the CURRENT rules, on the fullest text we have.
 *
 * Replaying the archive verbatim meant a job kept its verdict from the day it
 * was found, so a role demanding verhandlungssichere Deutschkenntnisse went on
 * appearing long after the rules learned to reject it — nothing ever re-asked.
 *
 * ONE DEFINITION, used by both `search` and `report`. They disagreed for a
 * while: search re-judged and retired, report only re-scored, so the same job
 * was gone or present depending on which command last wrote the file. Which
 * command built the page must not change what the page says.
 */
/** Fingerprints the user has already ruled on themselves. */

const decidedBy = (state) => new Set(
  Object.entries(state.seen || {})
    .filter(([, e]) => ['applied', 'rejected', 'hidden'].includes(e.status))
    .map(([fp]) => fp),
);

/**
 * The user's own picks first, then score.
 *
 * A posting pulled out of the rejections is there because the user read it and
 * disagreed with a gate. It usually scores badly — that is why a gate caught it
 * — so ranking it on score alone buries the one job on the page the user has
 * already said they want.
 */
const pickedFirst = (state) => (a, b) => {
  const pick = (j) => (state.seen[j.fingerprint]?.status === 'interested'
    || j.verdict?.source === 'user' ? 1 : 0);
  return (pick(b) - pick(a)) || (b.score - a.score);
};

function rejudge(jobs, state) {
  // Read here rather than passed in: both callers derive it from the same flag,
  // and threading it through invited the two commands to drift apart again.
  const includeGerman = has('--include-german');
  const enrichCache = enrichLoad();
  const germanCache = germanChecksLoad();
  const retired = [];

  const verdicts = new Map();
  const refreshed = new Map();   // the re-normalized job, so the archive stops lying

  const kept = jobs
    .map((j) => {
      const hit = enrichCache[j.fingerprint];
      const live = livenessOf(hit);
      const better = hit?.text && hit.text.length > (j.descriptionText || '').length;

      // The early return used to be `if (!full || full.length <= …) return j`,
      // which meant a posting whose URL now answers 410 could NEVER be retired:
      // a gone entry has no text at all, so it left here untouched and the
      // `closed` flag below was never reached. Being gone is a reason to
      // re-normalize even when there is nothing new to read.
      if (!better && live.state !== 'closed' && live.state !== 'gone') return j;
      const full = better ? hit.text : (j.descriptionText || '');
      // normalize() RECOMPUTES the fingerprint, and fuller text can change the
      // location or work mode that feeds it. Keeping the archived one is not a
      // detail: every lookup here is by fingerprint, so a changed one silently
      // missed its own seen.json entry, and writing a verdict back under it
      // invented a record with no title and no id.
      // `closed` rides along from the enrich cache, and covers being GONE as
      // well as being shut: LinkedIn says on the card when a posting stops
      // accepting applications, and Adzuna and Arbeitsagentur both answer 410
      // for a withdrawn one. No other question matters once either is true.
      const shut = live.state === 'closed' || live.state === 'gone';
      const re = { ...normalize({ ...j, descriptionText: full, descriptionHtml: '', closed: shut, closedEvidence: shut ? live.evidence : null }, profile), fingerprint: j.fingerprint };
      refreshed.set(j.fingerprint, re);
      return re;
    })
    .filter((j) => {
      // A job you explicitly marked Interested stays, whatever the rules now
      // think — that was your call, and it outranks a gate.
      //
      // `verdict.source === 'user'` counts too, and it is what both promote()
      // and addManual() say in their docstrings protects a job. Only the status
      // was checked here, so the promise held by accident: addManual() sets
      // `interested` itself, and promote() survived only because serve.js
      // happens to pair it with a setStatus call. That is the caller's habit,
      // not a guarantee — a promoted job whose status stayed `new` would have
      // been retired by the next run, which is precisely the thing promoting it
      // was meant to prevent.
      const held = state.seen[j.fingerprint]?.status === 'interested'
        || j.verdict?.source === 'user';
      let v = classify(j, profile, { includeGerman });
      // What the model already said about its German (src/germancheck.js): a cached
      // "required" retires the posting here too, or the next run would restore it.
      const gd = v.decision !== 'drop' ? germanDrop(j, profile, germanCache) : null;
      if (gd) v = { ...v, decision: 'drop', reason: gd.reason, category: gd.category };
      verdicts.set(j.fingerprint, {
        decision: held && v.decision === 'drop' ? 'keep' : v.decision,
        reason: v.reason || null,
        category: v.category || null,
        band: v.band || 'main',
        heldByYou: held && v.decision === 'drop',
        at: new Date().toISOString(),
      });
      if (held) return true;
      if (v.decision !== 'drop') return true;
      retired.push({ job: j, reason: v.reason, category: v.category });
      return false;
    });

  return { kept, retired, verdicts, refreshed };
}

/**
 * Write the current verdict onto every archived job.
 *
 * The one place a decision is made durable. `search` calls it after its own
 * pass so the archive is never left un-judged; `report` then only reads what is stored. Deciding in two places is what
 * let the page say different things depending on which command last wrote it.
 */
function persistVerdicts(state) {
  const jobs = Object.values(state.jobs);
  const before = new Map(jobs.map((j) => [j.fingerprint, j.verdict?.decision || null]));
  const { retired, verdicts, refreshed } = rejudge(jobs, state);

  let changed = 0;
  for (const [fp, v] of verdicts) {
    if (before.get(fp) !== v.decision) changed++;
    // The DERIVED signals are stored too, not only the verdict. rejudge()
    // re-normalizes on the fullest text to decide, then used to throw that away
    // — so the archive kept the German level worked out from a truncated copy
    // while the verdict came from the whole thing. 25 of 42 records disagreed
    // with themselves that way, and the report draws its tags from the record.
    state.jobs[fp] = { ...state.jobs[fp], ...(refreshed.get(fp) || {}), verdict: v };
  }

  return {
    retired,
    changed,
    kept: [...verdicts.values()].filter((v) => v.decision !== 'drop').length,
    total: verdicts.size,
  };
}

async function reportOnly() {
  const state = store.load();
  // Retired statuses stay out unless asked for, matching what `search` does —
  // a job you have applied to or rejected should not keep reappearing.
  const RETIRED = new Set(['applied', 'rejected', 'hidden']);
  const includeAll = has('--all');
  const live = Object.values(state.jobs)
    .filter((j) => includeAll || !RETIRED.has(state.seen[j.fingerprint]?.status));

  // READS the verdict, never computes one. Recomputing here is what let this
  // command and `search` disagree about the same posting. --all shows
  // everything, including what the rules now reject.
  const unjudged = live.filter((j) => !j.verdict);
  const kept = includeAll ? live : live.filter((j) => j.verdict?.decision !== 'drop');
  const retired = includeAll ? [] : live.filter((j) => j.verdict?.decision === 'drop');

  const all = kept
    .map((j) => ({
      ...j, ...score(j, profile), band: 'main',
      status: state.seen[j.fingerprint]?.status,
      firstSeen: state.seen[j.fingerprint]?.firstSeen || null,
    }))
    .sort(pickedFirst(state));

  const now = new Date();
  // The periodic "did the filter eat anything good?" pass. Reviewed rejections
  // stay hidden unless asked for, which is the whole point of clearing a gate.
  const archive = rejects.load();
  const rej = rejectionCounts(archive, store.load());

  // Same new-vs-carried split the search uses, so a rebuild is laid out like the
  // report it replaces rather than being a flat list with a different shape.
  // `new` means fetched but never yet reported; anything already shown to you is
  // carried. After a normal search everything is `shown`, so a rebuild is one
  // merged queue — which is exactly what it is.
  const isNew = (j) => (j.status || 'new') === 'new';
  const html = buildReport({
    jobs: all.filter(isNew),
    openJobs: all.filter((j) => !isNew(j)),
    rejectedCount: rej.awaiting,
    reviewedCount: rej.reviewed,
    parked: parkedStore.list(parkedStore.load()),
    profile,
    attributions: attributions(new Set(all.map((j) => j.source))),
    meta: {
      date: isoDay(now), time: now.toTimeString().slice(0, 5),
      totalFetched: all.length, alreadySeen: 0, merged: 0,
      sourceLines: ['Rebuilt from the local archive — no network calls'], warnings: [],
    },
  });
  mkdirSync(p('reports'), { recursive: true });
  writeFileSync(p('reports', 'latest.html'), html, 'utf8');
  writeRejectionsPage({ profile, all: has('--all-rejected') });
  const carried = all.filter((j) => !isNew(j)).length;
  log.ok(`Rebuilt ${all.length} archived jobs into reports/latest.html`);
  if (retired.length) {
    log.dim(`  ${retired.length} dropped — the rules reject ${retired.length === 1 ? 'it' : 'them'}`);
    for (const r of retired.slice(0, 5)) {
      log.dim(`    ${r.title.slice(0, 46).padEnd(48)} ${r.verdict.reason || r.verdict.decision}`);
    }
  }
  if (unjudged.length) {
    // Shown rather than hidden: a job nobody has judged is not a job that
    // failed, and silently dropping it would be the quiet kind of wrong.
    log.warn(`  ${unjudged.length} posting${unjudged.length === 1 ? ' has' : 's have'} no verdict yet — shown anyway. Run: npm run replay`);
  }
  if (carried) log.dim(`  ${carried} shown in an earlier run — untick "One queue" to separate them`);
  if (rej.awaiting) log.dim(`  plus ${rej.awaiting} rejections awaiting review, on their own page: reports/rejections.html`);
}

async function mark() {
  const [idPrefix, status] = positional;
  if (!idPrefix || !status) {
    log.err('Usage: npm run mark -- <id> <status> [reason | salary asked]');
    log.dim(`Statuses: ${store.STATUSES.join(', ')}`);
    log.dim('The third word is the reject reason for `rejected`, and what you asked for on `applied`:');
    log.dim('  npm run mark -- 3cbda65e applied "70.000 EUR"');
    return;
  }
  const state = store.load();
  const fp = store.resolveFingerprint(state, idPrefix);
  if (!fp) return log.err(`No job matching id "${idPrefix}"`);
  store.setStatus(state, fp, status, positional[2] || null);
  store.save(state);
  const e = state.seen[fp];
  log.ok(`${e.title} @ ${e.company} → ${status}`);
  if (status === 'applied' && positional[2]) log.dim(`  asked for ${positional[2]}`);
  noteApplied(state, fp, status, positional[2] || null);
}

/**
 * Keep the advert when a job is marked applied.
 *
 * The standard CV is often enough, and when nothing is tailored there was
 * previously no record at all — the job left the queue and appeared in no list.
 * The folder is worth having for the posting alone: the employer will edit or
 * withdraw it, and this is the only copy of what was actually applied to.
 */
function noteApplied(state, fp, status, salaryAsked = null) {
  if (status !== 'applied') return;
  const job = state.jobs?.[fp];
  if (!job) return;
  try {
    const r = applyMod.recordApplied(job, { salaryAsked });
    if (!r.existed) log.dim(`  kept the posting: ${r.dir}`);
  } catch (err) {
    log.warn(`  could not record the application — ${err.message}`);
  }
}

/**
 * Verify each configured key with one live call. Faster feedback than running a
 * full search and reading the warnings, and it says exactly what is wrong —
 * "not set" and "set but rejected" are very different problems.
 */
async function checkKeys() {
  log.head('Checking API keys in .env');
  const { httpJson } = await import('./util.js');

  /* --- Adzuna --- */
  const id = process.env.ADZUNA_APP_ID;
  const key = process.env.ADZUNA_APP_KEY;
  process.stdout.write('  Adzuna DE       … ');
  if (!id || !key) {
    console.log('not set');
    log.dim('      Add ADZUNA_APP_ID and ADZUNA_APP_KEY to .env — https://developer.adzuna.com/');
  } else {
    const params = new URLSearchParams({
      app_id: id, app_key: key, results_per_page: '1', what: probeQuery(profile), where: profile.location.city,
    });
    const r = await httpJson(`https://api.adzuna.com/v1/api/jobs/de/search/1?${params}`);
    if (r.ok) {
      log.ok(`working — ${r.data?.count ?? '?'} "${probeQuery(profile)}" jobs near ${profile.location.city} right now`);
    } else if (r.status === 401 || r.status === 403) {
      log.err('rejected — check the app_id / app_key pair is copied correctly');
    } else {
      log.err(`HTTP ${r.status}: ${(r.text || r.error || '').slice(0, 120)}`);
    }
  }

  /* --- JSearch --- */
  process.stdout.write('  JSearch         … ');
  if (sourcesCfg.jsearch?.enabled === false) {
    console.log('disabled in config/sources.json');
  } else if (!process.env.RAPIDAPI_KEY) {
    console.log('not set (optional)');
  } else {
    const jsHost = sourcesCfg.jsearch?.host || 'jsearch.p.rapidapi.com';
    const jsPath = sourcesCfg.jsearch?.path || '/search';
    const jsCountry = sourcesCfg.jsearch?.country || 'de';
    // This diagnostic spends a real JSearch request, and JSearch is ~200 a
    // MONTH. It went unrecorded, so every `npm run keys` drifted quota.json
    // further from the account's actual usage — which is the one thing
    // quota.js exists to prevent. The ledger is the receipt for a side effect,
    // and the side effect is identical whichever command caused it.
    const keysQuota = quota.load();
    const r = await httpJson(`https://${jsHost}${jsPath}?query=${encodeURIComponent(probeQuery(profile))}&country=${jsCountry}&num_pages=1`, {
      headers: { 'X-RapidAPI-Key': process.env.RAPIDAPI_KEY, 'X-RapidAPI-Host': jsHost },
    });
    if (sourcesCfg.jsearch?.quota) {
      quota.record(keysQuota, 'jsearch', sourcesCfg.jsearch.quota, 1);
      quota.save(keysQuota);
    }
    if (r.ok) {
      const rows = Array.isArray(r.data?.data) ? r.data.data : (r.data?.data?.jobs || []);
      log.ok(`working — ${rows.length} German results via ${jsPath}`);
    } else if (r.status === 404) {
      // Distinguish the two very different causes of a RapidAPI 404: a wrong
      // host (gateway has no such API) vs a path the API does not expose.
      if (/endpoint .* does not exist/i.test(r.text || '')) {
        log.err(`404 — "${jsPath}" is not an endpoint on this API`);
        log.dim('      Your key and host are fine. Open the RapidAPI Endpoints sidebar,');
        log.dim('      find the SEARCH endpoint\'s name, and set it as "path" under "jsearch".');
      } else {
        log.err(`404 — host "${jsHost}" is not the API your key is subscribed to`);
        log.dim('      Copy X-RapidAPI-Host from your code snippet into "host" under "jsearch".');
      }
    } else if (r.status === 403) {
      log.err("403 — key is valid but not subscribed. Subscribe on the API's Pricing tab.");
    } else if (r.status === 401) {
      log.err('401 — key rejected. Re-copy X-RapidAPI-Key from the snippet.');
    } else if (r.status === 429) {
      log.warn('429 — monthly quota spent. Lower jsearch.maxQueries, or wait for reset.');
    } else {
      log.err(`HTTP ${r.status}: ${(r.text || r.error || '').slice(0, 120)}`);
    }
  }

  /* --- Job-alert mailbox --- */
  process.stdout.write('  Alert emails    … ');
  if (!process.env.IMAP_HOST) {
    console.log('not set — the only route to LinkedIn / StepStone / XING');
    log.dim('      Set IMAP_* in .env, then create daily job alerts on those sites.');
  } else {
    const { probeMailbox } = await import('./sources/mailalerts.js');
    const m = await probeMailbox();
    if (m.ok) {
      log.ok(`working — folder "${m.folder}", ${m.recent} message(s) in the last ${m.sinceDays} days (${m.total} total)`);
      if (!m.recent) log.dim('      No recent mail — have the alerts arrived, and are they in this folder?');
    } else {
      log.err(m.error);
      if (m.folders) log.dim(`      Folders on this account: ${m.folders.join(', ')}`);
    }
  }

  /* --- Arbeitsagentur: no key of yours, but worth confirming the endpoint --- */
  // The probe used to call /pc/v4/jobs and report a 403 as "blocked from this
  // network", which was wrong for months: v4 is retired and answers 403 the way
  // a rejected key does. It uses the same URL and radius as the source now, so
  // the two cannot disagree about whether it works.
  if (sourcesCfg.arbeitsagentur?.enabled !== false) {
    process.stdout.write('  Arbeitsagentur  … ');
    const r = await httpJson(
      'https://rest.arbeitsagentur.de/jobboerse/jobsuche-service/pc/v6/jobs'
      + `?was=${encodeURIComponent(probeQuery(profile))}&wo=${encodeURIComponent(profile.location.city)}`
      + `&umkreis=${profile.location.radiusKm}&angebotsart=1&arbeitszeit=vz&size=1`,
      { headers: { 'X-API-Key': 'jobboerse-jobsuche', Accept: 'application/json' }, retries: 0 },
    );
    if (r.ok) log.ok(`working — ${r.data?.maxErgebnisse ?? '?'} local hits (published key, none of yours)`);
    else log.warn(`HTTP ${r.status} — the key is a published constant, so check whether /pc/v6/jobs has been retired`);
  }

  console.log('');
  /* --- AI providers --- */
  const { resolveChain, PROVIDERS } = await import('./providers/index.js');
  const { chain, unknown, disabled } = resolveChain(profile.llm?.providers);
  for (const u of unknown) log.warn(`  Unknown provider "${u}" in LLM_PROVIDERS`);

  console.log('');
  log.head('AI adjudication providers');
  log.dim(`  chain: ${chain.length ? chain.map((c) => c.label).join(' → ') : '(none configured)'}`);

  const SCHEMA = {
    type: 'object',
    properties: { ok: { type: 'string', enum: ['yes'] } },
    required: ['ok'],
    additionalProperties: false,
  };

  for (const prov of Object.values(PROVIDERS)) {
    const inChain = chain.some((c) => c.id === prov.id);

    // The switch is absolute — it applies whether or not the provider is in
    // the chain, so checking `disabled` alone would miss a provider that is
    // configured but absent from LLM_PROVIDERS.
    if (prov.enabled && !prov.enabled()) {
      console.log(`  ${prov.label.padEnd(15)} … off (${prov.id.toUpperCase()}_ENABLED=false)`);
      continue;
    }

    // Only report providers you actually use. Listing every unconfigured one
    // is noise that makes the real problems harder to spot.
    if (!inChain && !prov.configured()) continue;

    process.stdout.write(`  ${prov.label.padEnd(15)} … `);

    const r = await prov.complete({
      system: 'You reply only in JSON.',
      user: 'Reply with {"ok":"yes"}.',
      schema: SCHEMA,
    });

    if (r.ok) {
      log.ok(`working — ${prov.describe()}${inChain ? '' : ' (configured but not in chain)'}`);
    } else {
      log.err(r.error);
      if (prov.id === 'gemini' && /invalid API key|not set/.test(r.error)) {
        log.dim('      Free key (no card needed): https://aistudio.google.com/apikey');
      }
    }
  }


  // The one thing that costs money, where you will see it when checking the keys.
  const billed = billedUsage();
  if (billed.calls) log.dim(`  billed key (overflow): ${describeUsage(billed)}; an estimate`);
  if (judgeSpentUntil()) log.dim('  free judging quota is spent — judging is on the billed key until it resets');
  log.dim('  .env lives at: ' + p('.env'));
}

/**
 * `npm run daily` — fetch, then open the report with working buttons.
 *
 * The two halves of the routine: `search` is unattended and takes minutes,
 * `serve` is where the actual reviewing happens. Chaining them as npm scripts
 * would work but sends flags to the wrong half — `npm run daily -- --verbose`
 * appends to the LAST command in the chain — so this is a real command and
 * every search flag behaves normally.
 */
async function daily() {
  await search();

  if (has('--dry-run')) {
    log.dim('\n--dry-run: not starting the server.');
    return;
  }
  console.log('');
  await serveReport();
}

async function serveReport() {
  const i = argv.indexOf('--port');
  const port = i > -1 ? Number(argv[i + 1]) : 8787;
  await serve({ port, open: !has('--no-open') });
}

/**
 * `npm run help` — every command, grouped by when you reach for it.
 *
 * Kept in step with COMMANDS by a test rather than by discipline: five commands
 * were registered, documented in the README and absent here, so the one place
 * you look when you have forgotten the name was the one place that did not say.
 */
async function help() {
  console.log(`
jobsieve — job search pipeline

Daily:
  npm run daily                  search, then open the report with working buttons
  npm run search                 fetch all sources, report only NEW jobs
  npm run serve                  open the report with working buttons
  npm run tray                   background app: scans on a schedule, open-job count in the tray
  npm run tray:shortcut          put a jobsieve shortcut on the desktop (no terminal needed)

  node src/index.js search --due-only   fetch only the sources whose own sleep is over
  npm run search -- --all       re-show everything that passes the filters
  npm run search -- --dry-run    fetch and filter, write nothing
  npm run search -- --verbose    show per-source errors and drop reasons
  npm run search -- --no-enrich  skip the per-posting fetches (much faster)
  npm run search -- --include-german   include roles needing German C1+

Applying:
  npm run apply -- <id>          tailored CV and cover letter for one posting, as PDF
  npm run apply -- <id> --diff   what was changed, without regenerating
  npm run apply -- <id> --recheck  re-read the advert before generating
  npm run apply -- --list        what has been generated, and what came of it
  npm run apply -- --learn       what you changed after generation
  npm run apply -- --outcome <folder> interview   record what happened

Coverage:
  npm run companies              which employers are tracked, stubbed or missing
  npm run companies -- --alert <id>   record that you created an email alert
  npm run discover               probe candidate ATS boards and save the live ones
  npm run discover -- --add <url>     add one company from any careers URL

Memory and tuning:
  npm run report                 rebuild the HTML from the local archive (no network)
  npm run mark -- <id> applied   set status: ${store.STATUSES.join(', ')}
  npm run why -- <id|url|title>  why a posting was rejected — every gate, in order
  npm run reviewed               what is left to review, per gate
  npm run reviewed -- language   clear a gate once you have looked through it
  npm run reviewed -- undo language   put it back

Setup:
  npm run keys                   check every API key and AI provider with one live call
  npm test                       the regression suite

Tuning the filter:
  Every rejection is archived to data/rejected.json and listed at the bottom of
  the report, grouped by the gate that stopped it. Work through a gate, hit
  "Mark all reviewed", and it stays out of future reports — the ids are kept, so
  the next run shows only what is new. When something should have passed, run
  \`npm run why\` on it to see which gate stopped it, fix that rule, and re-run
  \`npm run search\` — rejections are not remembered as "seen", so a job comes
  straight back the moment a rule stops excluding it.

Config: config/profile.json (you), config/master.json (your CV in detail),
        config/sources.json (where), config/companies.json (boards)
Keys:   copy .env.example to .env
`);
}

/**
 * Dispatch LAST, and it has to stay last.
 *
 * This used to sit beside the COMMANDS table near the top, with several hundred
 * lines of declarations below it. `function` declarations hoist, so that
 * worked — until a command reached for a `const` declared further down. Every
 * source then failed with "Cannot access 'REACHABLE_COUNTRIES' before
 * initialization" and a whole run fetched nothing, because the command had
 * already started while that line was still in the temporal dead zone.
 *
 * Running it here means every declaration in the file is initialised first,
 * whatever gets added later. A test asserts nothing is declared below it.
 */
// Quiet, read-only commands stay out of the shared log the app's Log tab shows.
if (!['help', 'why', 'companies', 'keys'].includes(command)) applog.tee(({ search: 'scan', daily: 'scan', report: 'scan', discover: 'scan', apply: 'tailor', serve: 'app' })[command] || 'action');
(COMMANDS[command] || help)().catch((e) => {
  log.err(e.stack || e.message);
  process.exit(1);
});
