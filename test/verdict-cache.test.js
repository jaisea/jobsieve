/**
 * When a cached verdict stops being valid.
 *
 * A verdict is the model's answer to a question that STATES the candidate's
 * German level, radius, title and stack. Those facts were only ever
 * invalidated by hand-bumping CACHE_VERSION, which is a change to the prompt —
 * so raising germanLevel after an exam re-opened every rules-based drop, while
 * every posting the MODEL had dropped stayed dropped, on reasoning that no
 * longer applied. The two layers disagreed about the same profile change.
 *
 * The cache is keyed on those facts now. These tests pin down both directions:
 * a profile edit that reaches the prompt must clear it, and one that does not
 * must leave 172 hard-won verdicts alone.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { p, readJson, sha1 } from '../src/util.js';

const SRC = readFileSync(p('src', 'adjudicate.js'), 'utf8');
const profile = readJson(p('config', 'examples', 'devops.profile.json'));

/** The module keeps loadCache private, so mirror the hash the same way it does. */
const coreStack = (pr) => {
  const s = pr?.skills;
  if (!s) return [];
  const core = Array.isArray(s.core) ? s.core : [
    ...(s.tools?.core || []), ...(s.practices?.core || []), ...(s.adjacent?.core || []),
  ];
  return [...core].sort();
};

const fingerprint = (pr) => sha1(JSON.stringify([
  pr.languages?.germanLevel, pr.languages?.stretchB2,
  pr.location?.city, pr.location?.radiusKm,
  pr.currentTitle, pr.yearsExperience, pr.noticePeriodMonths,
  coreStack(pr),
  (pr.targetTitles?.strong || []), (pr.targetTitles?.good || []),
]));

const changed = (edit) => {
  const p2 = structuredClone(profile);
  edit(p2);
  return fingerprint(p2) !== fingerprint(profile);
};

test('every fact the prompt states about the candidate is in the cache key', () => {
  // Each of these is written into the prompt, so a verdict given under the old
  // value answered a different question than the one now being asked.
  assert.ok(changed((x) => { x.languages.germanLevel = 'B2'; }), 'German level');
  assert.ok(changed((x) => { x.location.radiusKm = 200; }), 'radius');
  assert.ok(changed((x) => { x.location.city = 'Hamburg'; }), 'home city');
  assert.ok(changed((x) => { x.currentTitle = 'Principal Engineer'; }), 'current title');
  assert.ok(changed((x) => { x.yearsExperience += 1; }), 'years of experience');
  assert.ok(changed((x) => { x.noticePeriodMonths = 6; }), 'notice period');
  assert.ok(changed((x) => { x.skills.tools.core.push('Nomad'); }), 'core stack');
  assert.ok(changed((x) => { x.targetTitles.strong.push('head of platform'); }), 'target titles');
});

test('a profile edit the prompt never sees keeps the verdicts', () => {
  // The opposite failure is worse in practice: throwing away 172 verdicts costs
  // a full re-adjudication of the archive, several hundred model calls.
  assert.ok(!changed((x) => { x.llm = { ...x.llm, maxCallsPerRun: 99 }; }), 'call cap');
  assert.ok(!changed((x) => { x.targetTitles.exclude.push('werkstudent'); }), 'exclude list — a rules gate, never asked about');
  assert.ok(!changed((x) => { x.scoring = { ...x.scoring, freshnessDays: 14 }; }), 'score weights');
});

test('an existing cache with no stamp survives the upgrade', () => {
  // The file on disk predates this change and carries no profileHash. Treating
  // "absent" as "different" would discard every verdict on the first run after
  // deploying it — the exact cost this is meant to avoid.
  assert.match(SRC, /if \(profileHash && c\.profileHash && c\.profileHash !== profileHash\)/,
    'both stamps must be present before a mismatch counts');
});

test('the stamp is written on load, not only on save', () => {
  // A run where every verdict is a cache hit returns before saveCache() is
  // reached. If the stamp only landed on save, a settled cache would never be
  // stamped and the invalidation would never arm.
  const load = SRC.indexOf('const cache = loadCache(profile)');
  const early = SRC.indexOf('if (!todo.length)');
  const stamp = SRC.indexOf('saveCache(cache)', load);
  assert.ok(load > 0 && early > load, 'expected the early return below the load');
  assert.ok(stamp > load && stamp < early, 'the stamp must be written before the early return');
});

/* ------------------------------- and what a refresh must never re-open */

test('a job the user has ruled on is never sent back to the model', () => {
  // A rejection is deliberately kept OUT of seen.json so the posting is
  // re-fetched and re-judged every run — that is what lets a rule edit take
  // effect. But once the USER has answered, the model's answer is discarded by the
  // report anyway, so asking cost 82 calls a run for nothing. More to the
  // point: refreshing verdicts must not put a job the user closed back in
  // front of them. The filter runs before toJudge is sliced, so the call cap spends its
  // budget on postings the user has not seen.
  const IDX = readFileSync(p('src', 'index.js'), 'utf8');

  const filter = IDX.indexOf('const askable = uncertain.filter');
  const handed = IDX.indexOf('const toJudge = askable;');
  const call = IDX.indexOf('adjudication = await adjudicate(toJudge, profile');
  assert.ok(filter > 0, 'decided jobs must be filtered out of adjudication');
  assert.ok(handed > filter, 'and what is handed to the adjudicator is the filtered set');
  assert.ok(call > handed, 'which is what the call cap then applies to (maxCalls, inside the adjudicator)');
  assert.match(IDX.slice(filter - 700, filter + 200), /decidedBy\(store\.load\(\)\)/,
    'using the same set the review list and the report already use');
  assert.match(IDX.slice(call, call + 400), /maxCalls: room,/,
    'the cap counts calls on the askable set, never on the raw uncertain set');
});

test('the statuses that count as "the user has decided" are the three closed ones', () => {
  // `interested` and `shown` are NOT decided — those still want a verdict.
  const IDX = readFileSync(p('src', 'index.js'), 'utf8');
  const decl = IDX.match(/const decidedBy = \(state\) =>[\s\S]*?\n\);/)[0];
  // Match the quoted list, not the source text — `new Set(` contains "new".
  const statuses = [...decl.matchAll(/'([a-z]+)'/g)].map((m) => m[1]).sort();
  assert.deepEqual(statuses, ['applied', 'hidden', 'rejected'],
    'interested and shown must still be adjudicated — the user has not closed those');
});

test('reshuffling the config without changing the facts keeps the verdicts', () => {
  // The core stack is nested by kind and then by tier, so flattening it gives an
  // order that depends on how the config happens to be arranged. The prompt text
  // is part of the cache key, so a purely cosmetic move — a term shifted from
  // tools.core to practices.core, or a list re-ordered — would silently re-open
  // every settled verdict. It is sorted for exactly that reason.
  assert.ok(!changed((x) => { x.skills.tools.core.reverse(); }), 'reordering a list');
  assert.ok(!changed((x) => {
    const moved = x.skills.tools.core.pop();
    x.skills.practices.core.push(moved);
  }), 'moving a term between kinds without changing which are core');

  // But genuinely changing what is core must still invalidate.
  assert.ok(changed((x) => { x.skills.tools.core.pop(); }), 'dropping one');
  assert.ok(changed((x) => { x.skills.practices.secondary.push('nomad'); }) === false,
    'and a non-core tier must not, since the prompt never states it');
});

test('a cached answer is not reused for a question it was never asked', () => {
  // The cache is keyed on the FINGERPRINT alone, so a posting judged once is
  // never judged again — including when a new escalation starts asking
  // something the model was never shown. That failure is silent: the question
  // is written, the measurement says N postings will escalate, and the ones
  // already holding a verdict quietly skip it.
  //
  // Found when the work-mode escalation was added: 5 of the 28 postings it was
  // built for held a verdict given before the question existed. Bumping
  // CACHE_VERSION would have re-asked all 341 to correct 5.
  assert.match(SRC, /asked: \[\.\.\.new Set\(item\.uncertainties\.map\(\(u\) => u\.kind\)\)\]\.sort\(\)/,
    'every new verdict records which questions it answers');
  assert.match(SRC, /answersCover\(hit, item\.uncertainties\)/,
    'and a hit is only reused when it covers what is being asked now');

  // Pulled out of the source so the rule itself is exercised, not just its
  // presence. The module keeps it private, same as loadCache above.
  const body = SRC.slice(SRC.indexOf('function answersCover'));
  const answersCover = new Function(`${body.slice(0, body.indexOf('\n}') + 2)}\nreturn answersCover;`)();

  const asked = (...kinds) => kinds.map((kind) => ({ kind }));

  assert.equal(answersCover({ asked: ['german'] }, asked('german')), true);
  assert.equal(answersCover({ asked: ['german', 'work-mode'] }, asked('german')), true,
    'a broader answer still covers a narrower question');
  assert.equal(answersCover({ asked: ['german'] }, asked('german', 'work-mode')), false,
    'a new dimension re-asks');

  // An entry written before this existed is accepted as before. The
  // alternative is a mass re-ask of every verdict on file, which is the cost
  // CACHE_VERSION carries and the reason this is not that.
  assert.equal(answersCover({ decision: 'drop' }, asked('work-mode')), true);
});

test('a teaser whose advert did not arrive is parked, never sent to the model (911267cd)', () => {
  // Adzuna's 500 characters are cut before the requirements. The model answered
  // "the truncated description does not mention language requirements" and that
  // answer stood while the advert asked for "Sehr gute Deutsch- und gute
  // Englischkenntnisse". Judgement waits for the full advert; nothing is stamped
  // on the posting or its verdict.
  const INDEX = readFileSync(p('src', 'index.js'), 'utf8');
  assert.ok(INDEX.includes("teaser && (l.state === 'unknown' || (l.state === 'unreadable' && TEASER_SOURCES.includes(job.source)))"),
    'a teaser parks on a failed page, and on an unreadable one when the source only ever gives teasers');
  assert.ok(INDEX.includes("TEASER_SOURCES = ['adzuna']"));
});
