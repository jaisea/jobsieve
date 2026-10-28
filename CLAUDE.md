# CLAUDE.md

Guidance for contributors and for Claude Code (claude.ai/code) working in this repository.
The user-facing documentation is [README.md](README.md); the product requirements are
[docs/requirements.html](docs/requirements.html). This file is about how the code is built and
why — most of the design below exists because a simpler version failed in a measurable way.

jobsieve is a configurable job-search pipeline tuned for the German market (the German-language
gate, Arbeitsagentur, German alert senders and compound titles are real, built-in features). It
is **role-agnostic**: the field the user works in lives in the profile, never in the code. Two
example profiles ship — `config/profile.example.json` (full-stack web, the default template) and
`config/examples/devops.profile.json` (DevOps / SRE / cloud, the one the test suite runs against).

## Commands

```bash
npm test                                   # full suite (node --test, no framework)
node --test test/classify.test.js          # one file
node --test --test-name-pattern="German" test/*.test.js   # one test by name

npm run dry                       # full pipeline, writes nothing — the main dev loop
npm run replay                    # judge the last fetch again — no network, no quota
npm run search                    # a real scan (several minutes, spends API quota)
node src/index.js search --no-enrich       # skip the per-posting advert fetches
node src/index.js search --only=ats,bwi    # just the named sources
npm run judge                     # judge only what is waiting for the model
npm run serve                     # the report with working buttons
npm run tray                      # the background app
npm run why -- "<title|id|url>"   # replay every gate against one posting
npm run companies                 # which employers are actually covered
npm run keys                      # one live call per API key and AI provider
```

Use `npm run dry` while developing; it exercises fetching, gating, scoring and adjudication but
writes nothing. `npm run replay` is cheaper still and is the right loop for a gate change.

> **On PowerShell, `npm run <script> -- --flag` silently loses the flag.** PowerShell consumes the
> bare `--`, npm then reads `--replay` as its own option and drops it — `npm run search -- --replay`
> becomes a full fetch that spends quota, and `-- --dry-run` becomes a run that WRITES. The rule
> is narrow: a POSITIONAL argument survives, quoting and all; only `--` arguments are eaten. Use a dedicated script (`npm run replay`,
> `npm run dry`), call node directly (`node src/index.js search --replay`), or quote the
> separator (`npm run search '--' '--replay'`). Check npm's echoed `> node src/index.js …` line.

Node 22+ only (built-in `fetch`, `node:test`). No build step, no linter, no transpiler.
Two runtime dependencies (`imapflow`, `mailparser`); Electron is a dev dependency.

Environment switches used by tests and trial runs: `JOBHUNT_PROFILE` (another profile file
instead of `config/profile.json`; read by the CLI, the server and the app),
`JOBHUNT_DATA_DIR` / `JOBHUNT_REPORTS_DIR` (move `data/` and `reports/`; see `p()` in
`src/util.js` — set them before the modules that build paths are imported), `JOBHUNT_NO_LOGFILE`,
`JOBHUNT_LOG_FILE`, `JOBHUNT_CONNECTIVITY_PROBES`, and `GEMINI_API_BASE` (a local server that plays
Google in the end-to-end tests, read when asked — never at column zero).

## Architecture

A pipeline, in `src/index.js` → `search()`, in four named phases:

```
sources FETCHED several at once (up to http.sourcesAtOnce), each PROCESSED as it lands, one at a time:
  source → normalize
    → 1.1  the title alone      title-exclude, relevance          no network
    → 1.2  is it still there    fetch the advert; 410/404/closed  one request each
    → 2.1  the full advert      the remaining gates               no model
    → 2.2  what is left         adjudicate (LLM)
    → store.save
the fetch side (up to 2.1) and the judge side (2.2 + save) are two lanes
then, once: archive settlement → report
```

**The order is the point.** The rules used to run before the advert was fetched, so they spent
most of their time judging teasers (Adzuna truncates at 500 characters; alert emails carry none).
Phase 1.1 settles roughly three quarters of everything fetched on the title alone, which is what
makes fetching adverts in 1.2 affordable. `title` gates read only the title, `liveness` needs the
fetch to have happened, `rules` need the text. `test/phases.test.js` asserts a title-phase gate
reaches a verdict on `{title, company, location}` alone, so a content signal cannot creep into 1.1.

### A scan is a series of per-source batches

`judge(raw, label)` is `settle(await prepare(raw, label))` for ONE source's postings, so a
source's results are in `seen.json` — on the live page, the tray count and the badge — soon after
that source returns, instead of after the slowest source. A replay is one batch of the whole
snapshot.

Shared between batches (in `run` and above): the reject archive, the adjudication budget, the
totals for the report. Per batch: the postings, the verdicts, the parked list. Three things were
easy to get wrong and are tested:

- **`maxCallsPerRun` is for the RUN, and counts calls to the MODEL.** `run.asked` accumulates and
  each batch gets what is left. It is applied AFTER the verdict cache — slicing first let cached
  answers use up the allowance. What the breaker leaves is held like a rate limit's leftovers.
- **The schedule is committed per SOURCE** as soon as its fetch is durable (below), and once more
  at the end for sources that produced no batch. A scan cut off after four sources keeps those
  four asleep and leaves the rest due.
- **The replay snapshot is written per source, before it is judged**, carrying the other enabled
  sources' slices over from the previous snapshot.

`persistVerdicts()` runs once at the end. `writeReport()` runs after every source that added to
what is reported (a page opened as a FILE shows only what was written to it) and once at the end;
the per-source calls are `quiet` and write only the files.

### Two lanes: fetching and judging overlap (`prepare` / `settle`, `src/lane.js`)

- **`prepare(raw, label)`** — normalize, title gates, advert fetches, every rules gate. Network
  and CPU. Writes the advert cache and the parked list and nothing else; its rejections are
  collected in `drops` and applied by `settle()`, so a half-prepared batch cannot leak into
  another batch's save.
- **`settle(batch)`** — the model, then memory: `reconcile`, `store.save`, `rejects.save`. The ONLY
  writer of `seen.json` and the reject archive.

`lane()` joins them: ONE worker taking batches strictly in order (batch N is on disk before N+1 is
reconciled against it, so a posting two sources both carry is judged twice and merged once),
BOUNDED at one batch waiting, and a worker that throws stops the lane so the fetch side stops
fetching. The loop's `try/finally` closes the lane and rethrows its failure.

### Owed batches (`src/batches.js`, `data/batches.json`)

A fetch is made durable before it is judged: the postings go into the replay snapshot and the
source is marked *owed*; the source then sleeps. The marker is cleared as the LAST step of
`settle`, after both saves. A scan that starts with markers outstanding judges those slices first
(`resumeOwed()`) — no request, no quota. A snapshot that no longer holds the slice clears the
marker and forgets the source's schedule entry so it is fetched again; a batch that fails three
resumes (`MAX_ATTEMPTS`, counted BEFORE the attempt so a killed scan counts) is left alone and
reported, and `npm run judge` resets the count.

### A rate limit WAITS; it never decides (`src/awaiting.js`, `data/awaiting.json`)

When the model said "slow down" or "enough for today", unanswered postings used to take their
RULES verdict — the verdict of the very rules that were not sure. Now `gemini.complete()` returns
`{ rateLimited: true, scope: 'minute' | 'day' }`; the adjudicator stops asking that provider for
the run and returns `held` postings (no verdict) and a `halt`. `settle()` keeps the whole item in
the queue (the source is asleep and may not return it, so a fingerprint would not be enough) and
files nothing: not reported, not archived, not an open job.

- **When to come back.** A per-minute limit that outlasted its retries: 3 minutes. The daily quota:
  the next midnight `America/Los_Angeles` plus two minutes (`nextQuotaReset`, computed with Intl
  using the offset at the target instant — tested across a clock change).
- **Per PROJECT, not per key.** Two keys in one Google project share a quota and a bill.
- **Drain first.** `drainWaiting()` runs before anything is fetched, oldest first, when the hold
  has run out (or always with `--judge-queue`). While a hold is active, new batches are answered
  from the cache and the rest held without a request (`adjudicate(..., { paused })`).
- **What still falls back to rules:** a bad key, a missing model, a safety refusal, no provider
  (`noModel()`). After `MAX_AGE_DAYS` (14) an item takes its rules verdict, said out loud.
- **Telling a spent DAY from "slow down".** A 429's `error.message` does not say "per day"; the
  `QuotaFailure` entry in `details[]` does (`violations[].quotaId` such as
  `GenerateRequestsPerDayPerProjectPerModel-FreeTier`). `isDailyQuota()` reads the quota id first
  and words only when there is no structure. A per-day violation's `retryDelay` is meaningless,
  so the retry loop never runs for a day. `test/quota-detection.test.js` pins this.
- **Overflow to the billed project is opt-in** (`GEMINI_JUDGE_OVERFLOW_TO_APPLY` +
  `GEMINI_API_KEY_APPLY`): a spent DAILY quota retries on the apply key with the JUDGING model;
  a per-minute limit never switches. `data/llm-keys.json` remembers the free project as spent
  until the reset. If the billed key is broken, `overflowFailed()` reports the original quota
  limit, so postings wait rather than take rules verdicts. Billed calls are counted per month
  with an ESTIMATED price (`src/keystate.js`) and shown on the page, in the tray and by
  `npm run keys` — spending money must never be quiet.
- **Replay and dry run do not write the queue.**
- **Verdicts are cached as they arrive** (every `SAVE_EVERY`), so a scan cut off half way keeps
  answers that cost quota.

`src/judging.js` is the one answer to "what is waiting", read from the two small files so it works
under `npm run serve` too; `/api/judging` feeds the page bar, the tray shows the same lines, and
`daemon.plan()` returns `judge`/`judgeAt` so the app runs a judging-only scan at the reset.

The two end-to-end tests (`test/waiting-queue-e2e.test.js`, `test/owed-batches-e2e.test.js`) run
the real `search --judge-queue` as a child against a throwaway data directory.

### Fetching overlaps; landing does not (`src/pool.js`, `priority` in sources.json)

`runPool()` starts up to `sourcesAtOnce` fetches (default 6) and calls `land()` for each result as
it arrives. Everything shared — the snapshot, the owed marker, the schedule, the quota ledger,
the hand-off to the judge lane — is written from `land()`, one source at a time. `priority`
decides who starts first (lower earlier, default 50; slow sources 10, mail 0), so long fetches
overlap everything else. `--serial` is limit 1. Politeness is unchanged: `politeWait` is a queue
keyed by HOST across the whole run.

Offline handling: the first source to come back empty probes the connection (`src/connectivity.js`
asks two web servers, not the network adapter); if it is down, in-flight sources are taken to have
failed for the same reason and waiting ones are not started. An offline attempt records nothing —
no schedule entry, no quota charge.

Measured on one machine and data set: the serial loop took 14m37s (70% of it fetching); the pool
took 7m38s cold and 4m33s warm. **Overlap hides network time, not CPU time**: one source's
normalize blocks the single thread, which inflates every concurrent source's reported duration.
`src/timing.js` prints the breakdown every scan.

**Unchanged title drops are recognised, not re-analysed (`src/titledrops.js`,
`data/title-drops.json`).** The title gates are a pure function of the title, the code and the
profile, and most of what is fetched dies there — yet each posting was fully normalized first.
The memo keys on source + id (or apply URL without its query) + title + company + location,
stores `[gate, certain]` pairs so per-gate stats stay whole, and is discarded whole when the RULES
VERSION (a hash of `src/` + profile) changes. Entries are re-analysed after 3 days and forgotten
after 7 unlisted. Only CERTAIN title drops are kept. Read in every mode; written only by a real scan.

**Per-gate counts are logged per SOURCE (`src/gatestats.js`)**, never across sources — a
half-hourly scan may read only the inbox, and a shifting mix would move every share. A move of 3+
points since the last recorded run is warned about. A replay compares but does not record.

### The user's field is configuration (`profile.relevance`, `profile.searchQueries`)

The tool used to assume a senior DevOps/SRE/cloud user; nothing in `src/` may assume a field now.

- **Relevance vocabulary is `profile.relevance`**: `domainTerms` (a hit keeps a title that matches
  no target), `offTrack` (a hit is a certain drop — unless a domain term is also present, which
  makes it a soft drop plus a `title` uncertainty), `nearMissTerms` (a field word within two words
  of a built-in role noun escalates), `nearMissPatterns` (regex strings), `roleDescription` (how a
  question to the model names the field). The old constants `DOMAIN_TERMS`, `OFF_TRACK`,
  `INFRA_TERMS` and `EXTRA_NEAR_MISS` are gone — a test asserts they stay gone. `relevanceOf()` in
  `src/filter.js` compiles them once per profile object (a `WeakMap`), and `isTitleNearMiss(title,
  profile)` and `titleConflict(title, profile)` take the profile. **All of it is optional: with no
  vocabulary, relevance rests on `targetTitles` alone.** `ROLE_NOUNS` and the German head-noun
  expansion stay in code — they are language, not field.
- **Search queries are `profile.searchQueries`.** `queries` was removed from `config/sources.json`;
  the order is `profile.searchQueries || sourcesCfg.queries || profile.targetTitles.strong`
  (`src/index.js`), so an old sources file still works.
- **`profile.field`** ("full-stack web development") is told to the model in the candidate line of
  the prompt. The prompt no longer says "infrastructure and platform engineering" or asks for the
  "engineer or architect form" of a title; the core stack it states is the sorted `core` tier of
  `profile.skills`.
- **The scorer reads the profile too.** Title partial credit comes from `relevance.domainTerms`; the
  "Deep … focus" bonus from `skills.tools.core` (two or more named three times each).
- **The programming nice-to-have penalty and the "Coding mentioned" chip are opt-in** via
  `avoid.penaltyNiceToHaveProgramming` (the DevOps example sets -4; the full-stack one does not — a
  developer is not put off by coding). Programming is still DETECTED either way.
- **The tailor prompt's "how to angle it" block is optional**, from `master.angle` in master.json.
- Editing an example profile changes what the docs test expects: `test/docs.test.js` requires the
  README to list both examples' search queries, title lists and relevance vocabularies.

### The gates (`CHECKS` in `src/filter.js`)

Seven named gates: closed, title-exclude, employment-type, age, relevance, location, german.
`gate()` and `explain()` both walk `CHECKS`. **One definition drives both** — `npm run why` would be
worthless if it could disagree with the pipeline, and a test asserts it never does.

**Three-way classification is the central design.** `src/filter.js` returns `keep` / `drop` /
`uncertain`. The rules layer may only decide when it is *certain*; anything resting on a heuristic
escalates to the model rather than being deleted. A wrong keep costs a minute of reading; a wrong
drop costs an opportunity never seen. Preserve this when touching gates.

- **The walk does not short-circuit, and every reason is kept.** The primary verdict is
  `hard[0] || soft[0]` — the first CERTAIN drop in array order, else the first soft one —
  identical to what the old short-circuiting loop returned. Keeping every reason is what lets the
  archive distinguish "this rule is pulling its weight" from "this rule got there first".
- **An uncertainty cannot rescue a certain drop.** `classify()` returns on a certain drop before
  it looks at uncertainties. So an escape hatch must SOFTEN THE GATE, not merely add a question —
  a version that only added the uncertainty measured as zero effect.
- **`CHECKS` array order is NOT the phase order, and must not be made to match.** Phase decides
  when a gate runs; array position decides which reason OWNS the verdict. `closed` sits at index 0
  so a shut posting archives as `closed`. `rejects.js` clears `reviewedAt` when a category
  changes, so reordering would flood thousands of reviewed rejections back into the review list.
- **A review survives a category change it did not cause.** Only a change where the OLD gate has
  stopped firing re-opens an entry. That is why a phase-1.1 drop archives a FULL walk of every gate
  (with `descriptionComplete` stored, so nobody mistakes pre-fetch signals for conclusions).
- **Which command replays a rejection must not change the verdict.** `npm run why` replays against
  the ARCHIVED record, so every signal a gate reads must be stored in the archive.
  `test/replay-agrees.test.js` runs a gate live and through the archive and compares.
- **Gates fail by being fed the wrong input, not by having the wrong rule.** Every false pass so
  far was a correct gate acting on a bad signal. Suspect the detector first; see
  `test/false-passes.test.js`.
- **The `stack` and `programming` gates were removed.** Programming is still DETECTED (the opt-in
  nice-to-have penalty and chip above); both categories stay in `REJECT_CATEGORIES` so old
  reasons still read, and cached model drops filed under `programming` are discarded on load by
  `withoutRetired()` in `src/adjudicate.js`. Do not reinstate them unasked.
- **The AWS-centric gate was removed entirely** — detector, gate, model question, score penalty,
  report chip and `avoid.awsPrimary`. It encoded one user's Azure-vs-AWS preference. `aws` survives
  only as a label in `REJECT_CATEGORIES` and in the "Skill gaps" picker group, so reasons already
  on file still read. Do not reinstate it as a built-in.
- **The reject picker is a grouping over the gates** (`PICKER_GROUPS`), not the gates. Merging the
  gate categories themselves was rejected: it would reset reviews and move primary categories.
  `age` and `score` have no button.

Notes on individual gates:

- **title-exclude** holds two kinds of term. Seniority/employment terms stay certain; function
  terms (sales, product manager, support engineer…) become a question when the title also names
  the domain. Whole-word matching cannot see "Pflichtpraktikum", so a short list of German roots
  is matched inside words. Both lists default in code and are overridable in the profile — absent
  keys must not require editing a personal file.
- **relevance**: reads `profile.relevance` (above). German compounds are split by `expandGerman()`
  only when the HEAD is a role noun (mapping a field word such as "Infrastruktur" passed a railway
  role). Off-track + domain together is a soft drop plus a `title` uncertainty. `isTitleNearMiss`
  needs a near-miss term and a role noun **within two words**; keep generic words such as
  `operations`/`systems` out of `nearMissTerms` (they pulled in "People Operations Specialist"), and
  a test holds both examples to it.
- **age** is a guess that a posting closed: good for an aggregator, poor for the employer's own
  board. `authoritativeSources` get 180 days. Postings older than the gate were never shown, so
  history cannot validate the limit.
- **employment-type**: `employmentKinds()` normalises every source's spelling to concepts.
  "Full or part time" means both are offered, so the test is "part-time AND NOT full-time". The
  title speaks for part-time only when the field is empty.
- **closed / liveness**: `livenessOf(hit)` is the single answer to "is it still there", so
  `search()`, `rejudge()` and `why` cannot disagree:

  | state | trigger | what happens |
  |---|---|---|
  | `open` | 200, description extracted | judged on the text |
  | `closed` | the advert says applications are shut | certain drop, `closed` |
  | `gone` | 410 from anyone; 404 only from an id-keyed endpoint; a Greenhouse `?error=true` redirect | certain drop, `closed` |
  | `unreadable` | fetched, nothing to read (no ld+json, 403) | gated unread, not a drop |
  | `unknown` | transient failure, or never fetched | parked |

  **403 is never `gone`** — a retired API endpoint here answered 403 for months and was misread as
  a network block. About half of closed postings serve a full advert with no marker and are
  undetectable; do not add speculative heuristics (length, apply button, `datePosted` age) to
  chase them — each would cost real postings. Disappearance from a source's listing is a real
  signal only for a CARRIED posting, so it belongs in `rejudge()`.

### Language (`src/language.js`)

Four tiers plus `unknown`. Never claims a CEFR level the posting did not state; a range is graded
at its ceiling; a level must sit next to its language ("Englisch C1, Deutsch B2" stays B2), except
that a level trailing an explicit `and`/`und` list applies to both within a 30-character window.
`detectLanguage()` returns `unknown` for empty text (`chars === 0`, not falsy — "not supplied" is
not "empty"). A German-language advert with no English signal is an inference, so it soft-drops
and escalates. A `required` posting is hidden below C1; `conversational` below B2 unless
`languages.stretchB2` is set.

**An absence must not be stated as a settled fact.** A posting that mentions German at all
(`/\bgerman\b|\bdeutsch(?!land)\w*/i`) escalates when no tier matches, and the model receives
whole lines naming German (`germanLines()`, six at most, capped), not a window that can cut the
level off. `src/germancheck.js` adds a narrow second reading for postings about to be SHOWN; it can
only turn a keep into a drop, only by quoting the advert, and is cached per posting + advert + level.

### Work mode (`detectWorkMode` in `src/normalize.js`)

**The posting outranks the aggregator.** `detectWorkMode` runs first and `raw.workMode` is only a
fallback — and only while there is nothing to read: once the text reaches
`MIN_DESCRIPTION_CHARS`, silence about remote is evidence against it. "Remote" is a technical term
(`TECHNICAL_REMOTE`: Remote Write, remote state), a perk bullet (a bare line is `hybrid`), and a
German hedge ("Homeoffice möglich"). A hybrid CLOUD is not a work mode (`TECHNICAL_HYBRID`). A
strong claim beats a hedge and beats the word hybrid; a percentage claim is read through the
words in between, 90+ only. Flexible working TIME is not flexible working PLACE, and a bare
"Mobiles Arbeiten" is deliberately not a signal (measured: it demoted genuine remotes).

When the rules still cannot settle it, `workModeUngraded` is set — advert read, the subject
discussed, not concluded remote, beyond the radius — and the location gate softens so the lines
go to the model. The word "hybrid" alone does not count: the employer has answered.

### Adjudication (`src/adjudicate.js`)

- **The model must not overturn what the rules settled.** The prompt carries an `# Already
  settled` block (`settledFacts`) listing dimensions not being asked about. Without it the model,
  asked about German, began dropping postings on location.
- **The profile is part of the question.** `profileFingerprint()` hashes exactly the fields that
  reach the prompt (German level, stretch, city, radius, current title, years, notice period, core
  stack, strong and good titles, `field`, `relevance.roleDescription`), so editing the language level or radius invalidates the cache; editing
  `maxCallsPerRun` or score weights does not. The stamp is written when the cache is LOADED (an
  all-hits run never saves); an existing file with no stamp survives (absent is not "different").
- **Changing the prompt means bumping `CACHE_VERSION`** — or capture `systemPrompt(profile)`,
  change it, and diff: a byte-identical prompt keeps the cache. The prompt's core stack is
  SORTED for the same reason.
- **A verdict covers only the questions it was asked.** Each records `asked: [kinds]`; a hit is
  reused only when it covers the current questions. An entry without `asked` is accepted.
- **A job the user has closed is never re-asked.** Applied, rejected and hidden postings are
  filtered out before the call cap is applied. `interested` and `shown` are still judged.

### Identity: fingerprints and `reconcile()`

The fingerprint — `sha1(company|title|locationKey)` after canonicalisation — is the identity
everywhere. Display strings are derived at render time (`rejects.describeRejection`,
`language.germanGap`), never read back from storage, so rewording a message corrects the whole
history with no migration. Only free text the model wrote is stored verbatim.

**But the fingerprint is only as permanent as its inputs.** `locationKey` is `remote` for a remote
role and the city otherwise, and `workMode` improves when an advert is read; a parser fix changes
company or title. So `reconcile()` takes the posting id as a SECOND OPINION: an unknown fingerprint
whose `source:sourceId` is already filed is the same posting moving — the original fingerprint
wins and the new one goes into `alsoKnownAs`, and the move is logged. The `remote` branch cannot be
dropped (aggregators place one remote role in different cities), and the id cannot replace the
hash (a LinkedIn id never equals an Adzuna id).

- **`normaliseSourceId()`** drops the query, fragment and trailing slashes and lowercases; it
  returns empty for a prefix with nothing after it (`"mailalerts:"` would be a shared key).
- **An id is an identity, not an address.** Where a URL differs only in its query string the id is
  built from the vendor's key: `indeed:<jk>`, `greenhouse:slug:id`, `workday:tenant:reqid`,
  `beesite:<slug>:<id>`. A tracking link with no key gets NO id — a wrong id is worse than none,
  because `reconcile()` would read it as a posting moving and transfer its status.
- **The reject archive has the same second opinion**, keyed on source + normalised `applyUrl` +
  title. Not the URL alone: many boards give every posting one apply page, and URL-only merging was
  measured to join hundreds of unrelated rejections. A wrong merge deletes; a missed one only re-shows.
- **Agency postings** (`employerUnknown`) key the fingerprint on the agency's posting id, because
  `company` is the same string on every posting. The flag is stored on the record so `why`
  reproduces the identity.
- **`canonicalTitle()` cuts after a spaced hyphen**, which is right for "- Remote" and can merge
  "Engineering Manager - Data Platform" with "- Python and K8s". A leading work-mode/percentage tag
  (`LEADING_TAG`) is stripped first, and the cut never leaves an empty head. Which suffixes are noise
  and which name a different role is an open, unmeasured question; changing the canonical form moves
  every fingerprint.
- **Aggregator twins** (`src/twins.js`): Himalayas and Jobicy relist employers' postings with their
  own link and a region for a location. Matched only across different sources with an aggregator
  on one side, conservatively.

### Memory

- `data/seen.json` maps fingerprint → status (`new → shown` is automatic; `interested`, `applied`,
  `rejected`, `hidden` are the user's). It suppresses re-reporting.
- **Rejections live in `data/rejected.json`, never in `seen.json`**, so they are re-judged every
  run and a rule edit takes effect. Capped by `LIMITS` in `src/rejects.js`; eviction never removes
  a review.
- **`store.promote()`** copies an archived rejection into `state.jobs` with `verdict.source =
  'user'`, which `rejudge()` will not overturn; **`store.addManual()`** does the same for a job no
  source saw (normalized like any other, so a later real copy collapses onto it; an empty advert
  box never wipes a stored advert).
- **`rejudge()` is the single definition** `search` and `report` both use for carried jobs, so
  which command last wrote the page cannot change what it says.
- **`isOpen()` in `src/queue.js`** is the one definition of an open job (status `new`, `shown` or
  `interested`; verdict not `drop` unless picked; `shown` within 21 days). The tray, badge, title,
  live page and carry-forward all ask it. Restore marks a job `interested`, so it is never aged out.
- `answeredBy()` (review list: "did the filter get this wrong?") is deliberately wider than
  `decidedBy()` (applied/rejected/hidden: "should the model still judge it?").

### Adverts (`src/enrich.js`)

- **An advert is a living document.** `data/descriptions.json` entries expire; a re-read replaces
  the stored text even when shorter (elsewhere only a longer text wins). `apply --recheck` exists
  but is off by default.
- **Parking means "we asked and it did not arrive", not "we never looked".** Only transient
  failures park; `--no-enrich` parks nothing; and a replay or dry run must neither park nor
  RELEASE — the whole parked-file block is inside `if (askedTheNetwork && !dryRun)`.
- **Site-specific readers** exist where the advert is somewhere other than ld+json: the LinkedIn
  guest card (`jobs-guest/jobs/api/jobPosting/{id}`, only for postings already emailed, at a 2.5s
  gap), eFinancialCareers' server-rendered `job-description` container (counted for nesting; the
  host test is anchored to a real TLD: `[a-z.]+$` let `efinancialcareers.evil.test` through before
  a test caught it), microdata on SuccessFactors career sites, and BWI's page body. HTML-escaped
  markup inside ld+json gets a second `stripHtml()` pass only when tags remain.
- **Rate limits and refusals.** `Retry-After` is honoured (capped at 60s); a 429 without one, or a
  JS challenge page, puts the host in `refused` and its postings are retried next run. Concurrency
  is 1 per host; hosts overlap.
- **`src/tlsfix.js`** supplies a missing intermediate certificate for one named host through
  `node:https`. Verification is never switched off (a test greps for `rejectUnauthorized`), and
  `test/tlsfix.test.js` asserts the bundled certificate is a CA and still in date.
- **Every web-scraping source calls `politeWait`** before fetching. A comment claiming politeness
  is not politeness.

### Sources (`src/sources/`)

- **Arbeitsagentur** uses `/pc/v6/jobs` with the agency's published `X-API-Key`. v4 is retired and
  answers 403 like a rejected key — when a source fails the same way for months, re-read the vendor
  documentation before trusting the explanation in the code. `postedAt` is the start of the CURRENT
  listing (`veroeffentlichungszeitraum.von`). It is searched twice: anchored on the city, and
  nationwide with "remote"/"homeoffice" keywords (the API's free text reads the description). The
  remote pass's `workMode: 'remote'` is a hint only while there is no text.
- **Workday** (`src/sources/workday.js`): tenants cannot be probed (wildcard DNS answers 422). The
  country facet KEY is tenant-specific and the IDS are global, so ids accumulate across responses.
  Pre-filters (`looksReachable`) return true for anything they cannot resolve — a slower fetch beats
  a silent loss.
- **Mail alerts** (`src/sources/mailalerts.js`): `PARSERS` is searched with `.find()`, so specific
  entries sit before generic ones. A LinkedIn anchor wraps the whole card; company and location are
  taken only when the `·` separator is actually present (a wrong company gives a false identity),
  the card outranks the plain-text part, and a card title is always a whole LINE (the alert header
  names the search term inside a sentence). Some senders are read from the text part
  (`BLOCK_NOISE`, section headings, prose detected by position, Indeed's company/location split on
  the last spaced hyphen). The noise list is anchored, not a substring filter ("Viewsonic" starts
  with "View"). Pay-to-apply and tracking-only senders go in `IGNORED` with the reason. A parser
  fix does not reach the archive or a replay — the snapshot stores adapter output — only mail
  inside the window.
- **Mailbox bookmark** (`src/mailstate.js`): a UID, not a time; `UID n:*` always returns the last
  message, so keep only UIDs strictly above the bookmark; UIDVALIDITY is compared as a string. Back
  to the whole window on no bookmark, a new UIDVALIDITY, or a new RULES VERSION (hash of all of
  `src/` plus the profile; `sources.json` excluded). A source can return a delta (`result.merge`)
  and a `commit` hook; the bookmark moves after the batch is saved. `errors`, `warnings` and `notes`
  are separate lists, because zero new mail is the normal case.
- **Agencies** (`src/sources/agencies.js`): queried by keyword; the listing card's employment type
  wins over a contradicting ld+json field; detail pages are cached 7 days and the ceiling counts
  REQUESTS; a posting starved by the ceiling is dropped for the run, not parked.
- **Career sites** (`src/sources/careersites.js`): the sitemap, because `/services/` is disallowed;
  the title gate runs on the URL slug; location markup differs per site (`parseLocation()`); the
  description container is a `<span>`; more than half blank adverts means the markup changed and
  the source says so. The employer is FIXED per site where the first path segment is not a company.
- **Beesite** (`src/sources/beesite.js`): the host is configuration, found from the career page's
  own requests, never guessed. `company` is the hiring legal entity.
- **BWI** (`src/sources/bwi.js`): the jobs sitemap is read from the index every run; the ld+json
  description is only an intro, so the body is read; withdrawn postings redirect (read with
  `redirect: 'manual'`); multi-office postings are kept if any office is near enough.
- **Himalayas / Jobicy**: both require a visible credit (`attribution`), and Himalayas forbids
  republishing to LinkedIn, Google Jobs or Jooble. An empty `locationRestrictions` is a worldwide
  role; Himalayas pages with `page=` (`offset=` is silently ignored).
- **`companies.ignored`** records boards looked at and refused; both `discover` paths read it.

### Quotas (`src/quota.js`, `data/quota.json`)

A metered API needs a budget, not good intentions. Rules, in the order they bite: a dry run spends
nothing on a monthly-metered source (`skipOnDryRun`, default true only with `perMonth`);
`maxRunsPerDay`; a monthly allowance is PACED over the days left, passed to the source as
`maxQueries`. The cycle starts on `cycleResetsOnDay`; `assumeUsed` is pinned to the cycle it
describes (an unpinned number would be re-added every month). The ledger is written even on a run
that wrote nothing else — it is a receipt for calls that left the machine — charges what the source
REPORTS it spent, and counts the RUN even when a source reports no spend.

### Replay (`data/fetched.json`, `src/fetched.js`)

**Changing a gate must not cost a fetch.** The snapshot stores adapter output BEFORE `normalize()`,
so a replay re-derives work mode, language tiers and distance — where half the interesting bugs
live. It cannot reach the adapters themselves. `descriptionHtml` is dropped at save. The snapshot
is each source's latest slice (`ranges`, `carryOver()`), so a partial run does not shrink it. The
"no network" claim is tested: the source loop iterates `replay ? [] : enabled`, no advert is
fetched, and the quota code lives inside the source loop. A replay with no snapshot REFUSES rather
than silently fetching.

### Report and server (`src/report.js`, `src/serve.js`, `src/rejections-page.js`)

- Six sections in one document (Open, In progress, Applied / Rejected, Discarded, Log, Settings),
  routed by `#hash`. Panels keep their ids (`appbox`, `rejbox`, `fbbox`, `cobox`, `srcbox`,
  `manbox`) — a test asserts each appears once.
- **The rejection list is a page of its own** (`/rejections`, `reports/rejections.html`); inline it
  was 96% of the report's weight. `buildReport` takes `rejectedCount`.
- **The client script is a template literal**, so every backslash is spent once; a lost escape is
  a parse error that kills the whole script while the page looks fine.
  `test/report-script.test.js` resolves the literal and parses it. The applications panel is built
  in the browser, so it escapes everything it renders. Do not give two `var`s the same name in
  the marking script (a hoisted `var say` once replaced a helper).
- **The page keeps itself true** (`syncQueue`, `GET /api/queue`): it sends the ids it holds and gets
  back every open id plus rendered cards for the missing ones; it never reloads. Scope every
  lookup by id to `.job` — the rejection rows carry the same `data-id`.
- **`sameOrigin()`**: a POST whose `Origin` is not this server is refused; no `Origin` (curl) is
  allowed. Binding to 127.0.0.1 keeps other machines out, not other websites.
- Settings reach the client script through `window.__SETTINGS__`, because `JS` is evaluated at
  import and cannot read the profile.
- `/api/feedback` reads application letters through Word, so loading the page can start Word.

### The background app (`src/electron/`, `src/daemon.js`, `src/schedule.js`)

A tray app wakes every `tickMinutes` (30) and runs `search --due-only` as a child process through
`src/runner.js`. **The Electron shell holds no decisions**: what is due, what the badge says and
when the next fetch can happen are plain functions in `src/daemon.js`, `src/schedule.js` and
`src/queue.js`, none of which may import `electron` (a test asserts it).

- **Each source sleeps its own interval** (`sleepMinutes`, default 360). An attempt is NOTED before
  the key and quota skips, so a skipped source rests; a fetch returning only errors retries in 30
  minutes; the schedule is written only once that source's fetch is durable.
- **Controls are one object** (`controls` in `src/electron/main.js`: `status`, `scanNow`,
  `setPaused`, `setStartWithWindows`, `judgeNow`, `quit`) used by the tray menu and exposed by
  `serve()` at `/api/app`. Under `npm run serve` there is none and the page hides the controls.
- **Links** (`classify()` in `src/electron/links.js`): exactly `http://127.0.0.1:<port>` loads in
  the window, other http(s) goes to the browser, everything else is refused. Windows are sandboxed
  with context isolation and every permission request denied.
- **New jobs are announced while the scan runs** (`daemon.progressNotice`, read from `seen.json`,
  not the log). A scan never reloads the page; it nudges `window.__refresh()`.
- **`data/search.lock`** holds a pid; a dead pid is not a lock; a dry run does not take it.
- **One log** (`src/applog.js`, `data/daemon.log`): `tee(tag)` patches `console.*` so a command
  prints and appends; tags name the WORK (`scan`, `app`, `tailor`, `action`), and `serve.js` runs
  each request under `applog.withTag()`. The app's own child sets `JOBHUNT_NO_LOGFILE` so lines are
  not written twice; tests that spawn the CLI must set it too.
- **The command dispatch is the last statement in `src/index.js`**, and must stay there: a command
  reaching a `const` declared below it is in the temporal dead zone. `test/cli.test.js` runs the
  offline commands for real and asserts nothing is declared below the dispatch.
- **A setting read at module scope is read before `.env` exists.** Any `process.env` read at column
  zero in a module `index.js` imports statically is dead; read it inside a function.
  `test/env-timing.test.js` greps for the shape.
- Not built on purpose: a packaged installer (all state lives in this folder).

### Application generation (`src/apply/`)

A second pipeline, sharing the provider layer:

```
job + master.json + templates → locate → generate (1 call) → verify → review (1 call) → Word → PDF
```

- **Nothing is invented — this matters more here than anywhere.** A wrong CV claim goes out under
  the user's name. Numbers must appear in `master.json` and BLOCK the PDF; technologies only WARN
  (the technology check produced many false positives, the number check none). `ALIASES` in
  `src/apply/verify.js` resolves synonyms only when the canonical name is whitelisted; generic
  nouns are in `NOT_TECH`; what `master.json` records as NOT done never grants permission.
- **The first summary line is the user's identity.** `verifySummaryTitle()` blocks a changed title
  (case- and slash-spacing-insensitive), on the draft AND the repair.
- **Every rewritten line is diffed** (`src/apply/diff.js`) before anything is written;
  `baseline.json` stores `before` with each edit so `--diff` works without regenerating.
- **Regenerating keeps what the application knows**: same folder, `mergeMeta()` over the old
  metadata, `keepPrevious()` copies the replaced files to `.generation/previous/<time>/` BEFORE the
  model is called and throws if it cannot.
- **Word edits text in place, never paragraphs** (`MoveEnd(1,-1)` excludes the paragraph mark so
  list formatting survives). Editable regions are anchored on headings, not placeholders.
- **Word never opens a file inside a cloud-synced folder.** Every Word verb acts on a local scratch
  copy under `data/tmp` and finished files are moved into place; Word on a synced path blocked
  invisibly for half an hour. The script body is `try/finally` so `$word.Quit()` always runs, with
  a two-minute timeout.
- **An orphaned WINWORD on timeout is accepted.** Killing Word processes could close a document the
  user has open with unsaved work.
- **Word opens documents in reading view**, which refuses every edit with a misleading "protected"
  error; the window is switched to print view after opening. When a COM error does not fit the
  evidence, try the operation through `Selection` — it reports a truer error.
- **PowerShell needs a UTF-8 BOM** on the script and `[Console]::OutputEncoding` set, or umlauts
  are mangled both ways (`test/encoding.test.js`). Curly quotes U+2018/U+2019 are string
  delimiters too and are doubled like `'`. A failed script is kept for diagnosis; a successful one
  deleted.
- **Writing may use a better model and a different key** (`GEMINI_MODEL_APPLY`,
  `GEMINI_API_KEY_APPLY`; `purpose: 'apply'` in `gemini.complete()`). A model requested by one
  caller never becomes the run-wide fallback.
- **The model gets the whole CV minus the contact line**, and `review()` gets the source lines too.
- **How to angle the application is the user's, not the code's.** The tailor prompt's "how to angle
  it" block appears only when `master.angle` is set in master.json.
- **Learned style rules need three occurrences.**
- **Marking a job applied keeps the advert, tailored or not.** `recordApplied()` writes the folder
  and `job.md` from both mark paths (CLI and report button), matching an existing application by
  FINGERPRINT rather than folder name, because a folder name carries a date. Such a folder has no
  `.generation/` data, which is the normal case, not an edge one.
- **Outcomes are `applied`, `interview`, `offer`, plus `unsuccessful` and `declined`** (`OUTCOMES`).
  Silence is answered by age: 30 days unpromoted folds into Archived. An interview or offer never
  ages out, so the last two END one ("not hired" / "declined" on the page): the application goes back
  to Applied with an outcome chip and ages from there. The values avoid "rejected" on purpose — a job
  STATUS of `rejected` means the user turned the posting down, and the page groups on both. A folder is not an application — a tailored-then-rejected job is
  listed apart. `readJson(path, null)` returns null for a missing file (absent is not empty).
- **The asked-for salary** is free text, optional, never cleared by a later status change, and
  `recordApplied()` fills it into an existing folder without overwriting one.

### Config

`config/profile.json` is gitignored; `config/profile.example.json` (full-stack web) is the
committed default template and `config/examples/devops.profile.json` the second example. **Tests
read the DevOps example** (directly, or via `JOBHUNT_PROFILE` for the CLI); a test that needs
no field at all should build its own profile rather than lean on either. Every gate and weight is
read from the profile at runtime — prefer config over code. `config/sources.json`, `config/watchlist.json` and
`config/style-notes.json` are written by the report's UI via `src/serve.js`. `config/master.json`
(gitignored) holds career data for the generator.

**Personal facts belong in config, never in code.** If you find yourself writing a name, a city or
an employer into a source file or a user-facing string, it belongs in `profile.json` or
`master.json`. `test/personal-facts-in-config.test.js` greps the source (comments exempt). The
other half of the same bug is config nothing reads: a key that looks like a setting makes editing
it feel effective. Test that every documented field changes something.

### Layers worth reading before changing

| File | Why it is subtle |
|---|---|
| `src/filter.js` | The gates. `CHECKS` order owns verdicts; near-miss adjacency; soft vs certain |
| `src/language.js` | Four German tiers plus `unknown`. Never claims a CEFR level the posting did not state |
| `src/util.js` | `hasPhrase()`/`hasSkill()` are whole-word only — substring matching caused real bugs (`intern` in "International", `git` in "github") |
| `src/normalize.js` | Work-mode detection and the fingerprint inputs |
| `src/adjudicate.js` | Gemini calls, fatal-vs-retryable errors, verdict cache, settled facts |
| `src/store.js` | `reconcile()`, identity drift, `promote()`, `addManual()` |
| `src/sources/workday.js` | Tenants cannot be probed; facet keys per tenant, ids global |

## Conventions

- **ESM, zero build.** Node built-ins first; two runtime dependencies.
- **Comments explain *why*, and cite the evidence.** Most non-obvious code carries the measurement
  or bug that produced it ("this matched 'Senior Bid & Pursuit Manager' on cloud + manager").
  Match that when adding code; do not strip it.
- **Tests are the specification of intent.** Each names the behaviour it protects and why, not the
  function it calls. `test/docs.test.js` fails if the README's title lists, search terms, relevance
  vocabularies (both example profiles), scripts, data files or test count drift from the code, or
  if docs/requirements.html's gate count and table drift from `CHECKS`, or if a command is registered in `COMMANDS` without
  appearing in the help text.
- **Fail soft, and say so.** A dead source, a spent quota or a missing key degrades the run and is
  reported in the terminal and the report banner. A silent downgrade is a bug.
- **Never fabricate a fact about a posting.** When evidence is missing the code says `unknown` and
  escalates. Absent is not empty; a default is not a value.
- **A wrong merge is worse than a missed one.** A missed merge shows a job twice; a wrong one hides
  it. When in doubt, keep identities apart.
- **Measure before building.** Several plausible features (cross-listing SimHash over adverts,
  trimming job-board names off company strings) were measured and not built because the corpus did
  not support them. One-off migration and measurement scripts are not kept in the repo.
- **Edit a document with the editor tool, or with a replacement FUNCTION — never a replacement
  string.** In `String.replace`, `` $` `` in the new text means "everything before the match"; one
  pasted a copy of this file's opening into the middle of a sentence. A test asserts each top-level
  heading appears once. The same applies to `$'` and `$&`.
- **Do not put attack-looking strings on a shell command line.** Windows Defender flagged a heredoc
  that listed URL schemes a link guard must refuse. Write such files with the editor tool and prefer
  harmless examples (`custom-app://`, `file:///etc/hosts`).

## Verification

Run a search twice: the second run must report **0 new jobs**. That is the direct test of the
memory requirement and catches most pipeline regressions. For a gate change, run `npm run replay`
before and after on the same snapshot and compare the counts; for anything touching the report's
client script, load the served page in a real browser — no unit test opens one.
