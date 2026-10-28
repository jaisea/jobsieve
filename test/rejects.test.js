/**
 * The rejection archive and the `explain` replay.
 *
 * These two exist to make the filter auditable, so the properties that matter
 * are: a rejection is recorded with enough context to judge it later, the
 * archive stays bounded, and the explanation cannot drift from the rules that
 * actually ran.
 */
import { test } from 'node:test';
import { readJson, p } from '../src/util.js';
import assert from 'node:assert/strict';

import {
  record, prune, size, find, LIMITS,
  markReviewed, unmarkReviewed, unreviewed, pendingByCategory, describeRejection,
} from '../src/rejects.js';
import { explain, gate, classify, CHECKS } from '../src/filter.js';

const profile = {
  location: { city: 'München', country: 'DE', radiusKm: 70 },
  languages: { germanLevel: 'A2', germanTarget: 'B1', stretchB2: false },
  targetTitles: {
    strong: ['devops engineer', 'cloud engineer', 'platform engineer'],
    good: ['infrastructure engineer'],
    exclude: ['junior', 'intern', 'sales'],
  },
  relevance: readJson(p('config', 'examples', 'devops.profile.json')).relevance,
  filters: { excludeRemoteScopes: ['US-only'], minScore: 25, maxAgeDays: 45 },
};

const job = (over = {}) => ({
  fingerprint: 'abc123def456',
  title: 'Platform Engineer',
  company: 'Acme GmbH',
  location: 'München',
  city: 'München',
  country: 'DE',
  distanceKm: 0,
  geoResolved: true,
  workMode: 'hybrid',
  postedAt: new Date().toISOString(),
  source: 'adzuna',
  applyUrl: 'https://example.com/jobs/1',
  descriptionText: 'We run Kubernetes on Azure.',
  germanRequired: 'none',
  programmingRequired: 'no',
  ...over,
});

/* ------------------------------------------------------------------ archive */

test('a rejection keeps the evidence needed to judge it later', () => {
  const a = record({}, job(), { reason: 'excluded title term: sales', category: 'role' });
  const e = a.abc123def456;

  assert.equal(e.title, 'Platform Engineer');
  assert.equal(e.applyUrl, 'https://example.com/jobs/1');
  assert.equal(e.reason, 'excluded title term: sales');
  assert.equal(e.decidedBy, 'rules');
  // Without the derived signals, `why` would have to re-derive them from a
  // truncated excerpt and could contradict the decision it is explaining.
  assert.equal(e.germanRequired, 'none');
  assert.equal(e.runs, 1);
});

test('the description is excerpted, not archived whole', () => {
  const long = 'x'.repeat(50_000);
  const e = record({}, job({ descriptionText: long }), { reason: 'r', category: 'role' }).abc123def456;
  assert.ok(e.excerpt.length < 2000, 'full text here would grow the file without bound');
  assert.equal(e.excerptTruncated, true);
});

test('re-rejecting counts runs instead of duplicating', () => {
  let a = record({}, job(), { reason: 'r', category: 'role' });
  const first = a.abc123def456.firstRejected;
  a = record(a, job(), { reason: 'r', category: 'role' });

  assert.equal(size(a), 1);
  assert.equal(a.abc123def456.runs, 2);
  assert.equal(a.abc123def456.firstRejected, first);
});

test('a changed verdict keeps the old one — that is the rule edit landing', () => {
  let a = record({}, job(), { reason: 'title is not a target role', category: 'role' });
  a = record(a, job(), { reason: 'AWS-centric role', category: 'aws', decidedBy: 'gemini' });

  const e = a.abc123def456;
  assert.equal(e.category, 'aws');
  assert.equal(e.previously.length, 1);
  assert.equal(e.previously[0].reason, 'title is not a target role');
});

test('the archive stays bounded by age and by count', () => {
  const old = { lastRejected: '2020-01-01T00:00:00Z', firstRejected: '2020-01-01T00:00:00Z' };
  const now = new Date().toISOString();
  const a = { stale: old, keep: { lastRejected: now, firstRejected: now } };

  const byAge = prune(a, { maxAgeDays: 60 });
  assert.equal(byAge.removed, 1);
  assert.deepEqual(Object.keys(byAge.archive), ['keep']);

  const many = {};
  for (let i = 0; i < 30; i++) {
    many[`f${i}`] = { lastRejected: new Date(Date.now() - i * 1000).toISOString() };
  }
  const byCount = prune(many, { maxEntries: 10 });
  assert.equal(size(byCount.archive), 10);
  assert.equal(byCount.removed, 20);
  assert.ok(byCount.archive.f0, 'the most recent rejection survives the cull');
});

test('lookup works by id prefix, url and free text', () => {
  const a = record({}, job(), { reason: 'r', category: 'role' });

  assert.equal(find(a, 'abc123').length, 1, 'id prefix');
  assert.equal(find(a, 'https://example.com/jobs/1?utm_source=x').length, 1, 'url, tracking stripped');
  assert.equal(find(a, 'acme').length, 1, 'company, case-insensitive');
  assert.equal(find(a, 'platform eng').length, 1, 'partial title');
  assert.equal(find(a, 'nothing here').length, 0);
});

/* ------------------------------------------------------------------ reviews */

const withCats = () => {
  let a = {};
  a = record(a, job({ fingerprint: 'l1', title: 'A' }), { reason: 'German required', category: 'language' });
  a = record(a, job({ fingerprint: 'l2', title: 'B' }), { reason: 'German required', category: 'language' });
  a = record(a, job({ fingerprint: 'r1', title: 'C' }), { reason: 'not a target role', category: 'role' });
  return a;
};

test('clearing a gate hides only that gate', () => {
  const { archive, marked } = markReviewed(withCats(), 'language');

  assert.equal(marked, 2);
  assert.deepEqual(unreviewed(archive).map((e) => e.fingerprint), ['r1']);
  assert.deepEqual(pendingByCategory(archive), { role: 1 });
});

test('the fingerprint survives review — that is what makes "new" meaningful', () => {
  // The requirement in one line: reviewed jobs are remembered, not deleted, so
  // the next run can tell an already-checked posting from one it has not shown.
  const { archive } = markReviewed(withCats(), 'language');

  assert.equal(size(archive), 3, 'nothing is deleted');
  assert.ok(archive.l1.reviewedAt, 'the review is stamped');
  assert.equal(unreviewed(archive).length, 1);
});

test('a reviewed job stays hidden when the next run re-rejects it', () => {
  let { archive } = markReviewed(withCats(), 'language');
  const at = archive.l1.reviewedAt;

  archive = record(archive, job({ fingerprint: 'l1', title: 'A' }),
    { reason: 'German required', category: 'language' });

  assert.equal(archive.l1.reviewedAt, at, 'the review is not reset by re-recording');
  assert.equal(archive.l1.runs, 2, 'but it is still counted as seen again');
  assert.equal(unreviewed(archive).length, 1, 'only the unreviewed role job is listed');
});

test('reviewing strips the excerpt, and re-recording does not put it back', () => {
  // Excerpts are ~half the archive by weight and serve no purpose once you have
  // dismissed the job. Without this, review slimming would be undone every run.
  let a = record({}, job({ descriptionText: 'x'.repeat(5000) }), { reason: 'r', category: 'role' });
  assert.ok(a.abc123def456.excerpt.length > 0);

  a = markReviewed(a, 'role').archive;
  assert.equal(a.abc123def456.excerpt, undefined);
  assert.equal(a.abc123def456.slimmed, true);
  // Evidence strings must survive: the German gate reads germanEvidence to tell
  // a quoted requirement from an inferred one, so losing it would make `why`
  // replay a verdict that never actually ran.
  assert.equal(a.abc123def456.germanRequired, 'none');
  assert.ok('germanEvidence' in a.abc123def456);

  a = record(a, job({ descriptionText: 'x'.repeat(5000) }), { reason: 'r', category: 'role' });
  assert.equal(a.abc123def456.excerpt, undefined, 're-recording must not re-inflate it');
});

test('a job that moves to a different gate comes back for review', () => {
  // You reviewed it as "not a target role". If a rule change means the AWS gate
  // now decides it, that is a different question and deserves a fresh look.
  let a = record({}, job(), { reason: 'title is not a target role', category: 'role' });
  a = markReviewed(a, 'role').archive;
  assert.equal(unreviewed(a).length, 0);

  a = record(a, job(), { reason: 'AWS-centric role', category: 'aws' });
  assert.equal(unreviewed(a).length, 1, 'a new gate deciding it is a new judgement');
  assert.equal(a.abc123def456.previously.length, 1, 'and the old verdict is kept');
});

test('reviewing "all" clears every gate', () => {
  const { archive, marked } = markReviewed(withCats(), 'all');
  assert.equal(marked, 3);
  assert.equal(unreviewed(archive).length, 0);
});

test('a review can be undone', () => {
  const { archive } = markReviewed(withCats(), 'language');
  const { archive: back, cleared } = unmarkReviewed(archive, 'language');

  assert.equal(cleared, 2);
  assert.equal(unreviewed(back).length, 3);
});

test('marking twice does not double-count', () => {
  let { archive } = markReviewed(withCats(), 'language');
  const second = markReviewed(archive, 'language');
  assert.equal(second.marked, 0, 'already-reviewed entries are skipped');
});

test('the entry cap evicts backlog, never a review', () => {
  // Evicting a reviewed entry would resurrect a posting you already dismissed —
  // the exact failure the whole feature exists to prevent.
  const archive = {};
  for (let i = 0; i < 20; i++) {
    archive[`old${i}`] = {
      fingerprint: `old${i}`, category: 'role',
      lastRejected: new Date(Date.now() - (100 + i) * 1000).toISOString(),
      reviewedAt: new Date().toISOString(),
    };
    archive[`new${i}`] = {
      fingerprint: `new${i}`, category: 'role',
      lastRejected: new Date(Date.now() - i * 1000).toISOString(),
    };
  }

  const { archive: kept } = prune(archive, { maxEntries: 25 });
  const survivingReviews = Object.values(kept).filter((e) => e.reviewedAt).length;

  assert.equal(survivingReviews, 20, 'every review survives despite being older');
  assert.equal(size(kept), 25);
  assert.ok(kept.new0, 'the newest backlog entry is what fills the remaining room');
});

test('reviews are only evicted when they alone overflow the cap', () => {
  const archive = {};
  for (let i = 0; i < 10; i++) {
    archive[`r${i}`] = {
      fingerprint: `r${i}`, category: 'role',
      lastRejected: new Date(Date.now() - i * 1000).toISOString(),
      reviewedAt: new Date().toISOString(),
    };
  }
  const { archive: kept, removed } = prune(archive, { maxEntries: 4 });
  assert.equal(size(kept), 4);
  assert.equal(removed, 6);
  assert.ok(kept.r0, 'the most recently active review survives');
});

test('the reason is derived from stored signals, not read back', () => {
  // The whole point of separating the two: the fingerprint is permanent, the
  // wording is not. An entry archived under older phrasing must still render
  // the way the current rules put it — with no migration step anywhere.
  const stale = {
    ...job({ germanRequired: 'required', germanEvidence: 'verhandlungssicher' }),
    category: 'language',
    reason: 'German required (have A2)',   // how it was phrased when archived
    aiReason: null,
  };

  assert.equal(describeRejection(stale, profile), 'German C1 required');
  assert.equal(stale.reason, 'German required (have A2)',
    'the decision-time record is left intact as provenance');
});

test('a reason the AI wrote is kept verbatim — nothing can regenerate it', () => {
  const e = {
    ...job(),
    category: 'language',
    reason: "AI: the title requires a 'German Speaker'",
    aiReason: "AI: the title requires a 'German Speaker'",
  };
  assert.equal(describeRejection(e, profile), "AI: the title requires a 'German Speaker'");
});

test('record() separates the model\'s text from a derivable one', () => {
  const rules = record({}, job({ fingerprint: 'r' }), { reason: 'x', category: 'role' }).r;
  const ai = record({}, job({ fingerprint: 'a' }), { reason: 'AI: nope', category: 'role', decidedBy: 'llm' }).a;

  assert.equal(rules.aiReason, null, 'a rules reason can be recomputed, so it is not pinned');
  assert.equal(ai.aiReason, 'AI: nope');
});

test('the derived text always matches the group it is filed under', () => {
  // This job fails on title AND location. Filed under location, it must read as
  // a location rejection — a row saying "excluded title term" inside the
  // Location group would make the grouping look broken.
  const e = {
    ...job({ title: 'Sales Engineer', location: 'Austin', country: 'US', distanceKm: 8000, workMode: 'onsite' }),
    category: 'location',
  };
  assert.match(describeRejection(e, profile), /8000km|not commutable/);
});

/* ------------------------------------------------------------------ explain */

test('explain runs every gate, not just the one that stopped the job', () => {
  // Excluded on title AND not a target AND far away. gate() reports only the
  // first; the whole point of explain() is showing all three.
  const j = job({
    title: 'Sales Engineer',
    location: 'Austin, TX', city: 'Austin', country: 'US', distanceKm: 8000, workMode: 'onsite',
  });

  const g = gate(j, profile);
  assert.equal(g.reason, 'excluded title term: sales');

  const x = explain(j, profile);
  assert.equal(x.checks.length, CHECKS.length);
  assert.equal(x.stoppedAt, 'title-exclude');

  const failed = x.checks.filter((c) => !c.keep).map((c) => c.id);
  assert.deepEqual(failed, ['title-exclude', 'relevance', 'location'],
    'a rule that is the SOLE reason for a drop deserves more scrutiny than one that got there first');
});

test('a certain drop later in the walk beats an earlier soft one', () => {
  // The measured case: a UK-only remote role whose title was a near-miss.
  // Relevance soft-dropped it first, gate() returned there, and the location
  // check — which would have settled it outright — never ran, so it escalated
  // to the model and was kept.
  const j = job({
    title: 'Software Engineer - Platform Productivity',   // near-miss, soft drop
    workMode: 'remote', remoteScope: 'other-only', distanceKm: null,
  });

  const g = gate(j, profile);
  assert.equal(g.keep, false);
  assert.equal(g.certain, true, 'must be settled by the rules, not escalated');
  assert.equal(g.category, 'location');

  assert.equal(classify(j, profile, {}).decision, 'drop');
});

test('a soft drop still stands when nothing later is certain', () => {
  // "Azure Specialist" is a near-miss: a field noun beside a role noun, but
  // not a domain term and not a configured target. Everything after it
  // passes, so the soft drop must survive the walk and escalate.
  const j = job({ title: 'Azure Specialist' });
  const g = gate(j, profile);

  assert.equal(g.keep, false);
  assert.equal(g.certain, false, 'still a question for the model, not a fact');
  assert.equal(classify(j, profile, {}).decision, 'uncertain');
});

test('a job stopped by only ONE gate is the interesting case', () => {
  // The scenario worth catching by hand: a genuinely good role held out by a
  // single rule. If that rule is wrong, nothing else would have saved the job.
  const j = job({ title: 'Azure Specialist' });
  const x = explain(j, profile);

  const failed = x.checks.filter((c) => !c.keep);
  assert.equal(failed.length, 1);
  assert.equal(failed[0].id, 'relevance');
  assert.equal(failed[0].certain, false, 'a soft drop escalates rather than deleting');
});

test('explain and gate cannot disagree — one definition drives both', () => {
  const cases = [
    job(),
    job({ title: 'Junior Cloud Engineer' }),
    job({ title: 'Frontend Engineer' }),
    job({ workMode: 'remote', remoteScope: 'US-only' }),
    job({ germanRequired: 'required', germanEvidence: 'verhandlungssicheres Deutsch' }),
    job({ programmingRequired: 'required', programmingLanguage: 'Python' }),
    job({ title: 'Azure Specialist' }),
    job({ postedAt: '2020-01-01T00:00:00Z' }),
  ];

  for (const j of cases) {
    const g = gate(j, profile);
    const x = explain(j, profile);
    const stopper = x.checks.find((c) => !c.keep);

    if (g.keep) {
      assert.equal(stopper, undefined, `${j.title}: gate kept it, so no check may fail`);
    } else {
      assert.equal(g.reason, stopper.reason, `${j.title}: same reason`);
      assert.equal(g.category, stopper.category, `${j.title}: same category`);
      assert.equal(x.stoppedAt, stopper.id);
    }
  }
});

test('the German check still assigns the band through the check list', () => {
  const stretch = { ...profile, languages: { ...profile.languages, stretchB2: true } };
  const j = job({ germanRequired: 'conversational', germanEvidence: 'gute Deutschkenntnisse' });

  const g = gate(j, stretch);
  assert.equal(g.keep, true);
  assert.equal(g.band, 'stretch', 'an earlier check returning main must not overwrite this');
});

test('the entry cap leaves room for many runs of reviews', () => {
  // A single run rejects ~3,700 postings. The cap has to hold well over one
  // run's worth or reviewed entries would be evicted and start reappearing.
  assert.ok(LIMITS.maxEntries >= 15000, 'several runs of reviews must fit');
  assert.ok(LIMITS.maxAgeDays <= 90, 'but nothing is kept indefinitely');
});

test('a job you have already ruled on is not offered for review again', () => {
  // The review list asks "did the filter get this wrong?". There is no point
  // asking about a job the user has already answered. Twenty-three
  // postings sat in the pile that way, two of them jobs already applied to.
  const archive = {
    a: { fingerprint: 'a', category: 'role', lastRejected: '2026-08-01T00:00:00Z' },
    b: { fingerprint: 'b', category: 'role', lastRejected: '2026-08-02T00:00:00Z' },
    c: { fingerprint: 'c', category: 'role', lastRejected: '2026-08-03T00:00:00Z' },
  };

  assert.equal(unreviewed(archive).length, 3, 'with no decisions, everything is offered');
  assert.equal(unreviewed(archive, new Set(['b'])).length, 2);
  assert.deepEqual(unreviewed(archive, new Set(['a', 'b', 'c'])), []);

  // Already-reviewed entries are still excluded on their own terms.
  archive.a.reviewedAt = '2026-08-04T00:00:00Z';
  assert.equal(unreviewed(archive).length, 2);
});

test('a review survives a category change the posting did not cause', () => {
  // Splitting the gates into phases moved 1,050 postings from `age` to `role`:
  // one both too old AND off-target used to be caught by the age gate first,
  // and phase 1.1 now reads the title before age runs. Nothing about those
  // postings changed — and 794 reviewed rejections came back into the list.
  //
  // The question a review answers is "should this gate have caught it". If that
  // gate still fires, the answer still stands.
  const job = { fingerprint: 'aa', title: 'Sales Manager', company: 'X', location: 'Berlin' };
  const reviewed = () => ({
    aa: {
      fingerprint: 'aa', title: job.title, company: job.company,
      category: 'age', reason: 'older than 45d', reviewedAt: '2026-01-01T00:00:00.000Z', runs: 2,
    },
  });

  // Now filed under `role`, but it is still too old — same posting, same facts.
  const a = reviewed();
  record(a, job, {
    reason: 'title is not a target role', category: 'role',
    reasons: [{ id: 'relevance', category: 'role', reason: 'not a target role', certain: true },
              { id: 'age', category: 'age', reason: 'older than 45d', certain: true }],
  });
  assert.equal(a.aa.reviewedAt, '2026-01-01T00:00:00.000Z', 'the gate you reviewed still fires');

  // Now filed under `role` and it is NOT too old any more — the employer
  // re-listed it, so this genuinely is a different question.
  const b = reviewed();
  record(b, job, {
    reason: 'title is not a target role', category: 'role',
    reasons: [{ id: 'relevance', category: 'role', reason: 'not a target role', certain: true }],
  });
  assert.equal(b.aa.reviewedAt, null, 'the gate you reviewed has stopped firing — ask again');

  // No reason list at all (an entry from before this change): fall back to the
  // old behaviour rather than silently keeping a review that may be stale.
  const c = reviewed();
  record(c, job, { reason: 'title is not a target role', category: 'role' });
  assert.equal(c.aa.reviewedAt, null);
});

/**
 * The archive gets the same second opinion seen.json has had since the
 * identity-drift work — and the key is NOT the URL alone.
 *
 * record() was keyed on the fingerprint, which is derived and therefore
 * improves: an alert email has no description, the posting is keyed on its
 * city, the advert arrives saying remote, and the key becomes `remote`. The
 * same posting then returns as a brand-new UNREVIEWED rejection while the
 * review sits on a fingerprint nothing looks up again. 550 source+applyUrl
 * pairs in the archive are filed under more than one fingerprint.
 */
test('a drifted rejection collapses onto the entry that carries the review', () => {
  const archive = {};
  const posting = (fp, location, url) => job({
    fingerprint: fp, title: 'Site Reliability Engineer', company: 'X GmbH',
    location, applyUrl: url, source: 'adzuna',
  });

  record(archive, posting('AAA', 'Berlin', 'https://x.test/jobs/1?t=first'),
    { reason: 'too far', category: 'location' });
  archive.AAA.reviewedAt = '2026-09-01T00:00:00Z';

  // The advert arrives, the text says remote, the fingerprint moves — and the
  // tracking token in the URL is different, as LinkedIn's always is.
  record(archive, posting('BBB', 'Remote', 'https://x.test/jobs/1?t=second'),
    { reason: 'too far', category: 'location' });

  assert.deepEqual(Object.keys(archive), ['AAA'], 'no ghost entry under the new fingerprint');
  assert.ok(archive.AAA.reviewedAt, 'and the review you already gave it survives');
  assert.deepEqual(archive.AAA.alsoKnownAs, ['BBB'], 'the move is recorded, not absorbed silently');
});

test('two different postings sharing one apply URL are NOT merged', () => {
  // The measured danger, and why the title is in the key. A URL is not a
  // posting id here: stripping the query turns every Indeed job into
  // `jsearch:https://de.indeed.com/viewjob`, and boards like fastly and elastic
  // give every posting the same apply page. Keyed on url alone, 206 of 550
  // groups joined DIFFERENT titles — a wrong merge deletes a rejection, which
  // is worse than the bug, because a missed merge only re-shows one.
  const archive = {};
  const shared = 'https://www.fastly.com/about/jobs/apply';

  record(archive, job({ fingerprint: 'C1', title: 'Senior Cloud Engineer', applyUrl: shared }),
    { reason: 'x', category: 'role' });
  record(archive, job({ fingerprint: 'C2', title: 'Threat Detection Analyst', applyUrl: shared }),
    { reason: 'x', category: 'role' });

  assert.deepEqual(Object.keys(archive).sort(), ['C1', 'C2'],
    'different titles on one apply page stay two rejections');
});

test('a company that was wrong still merges, because company is not in the key', () => {
  // The LinkedIn card bug filed 64 postings under the company "LinkedIn". When
  // the parser was fixed the company became the real employer and the
  // fingerprint moved. Including company in the key would lose exactly these —
  // 12 groups measured.
  const archive = {};
  const url = 'https://www.linkedin.com/comm/jobs/view/4463393536';

  record(archive, job({ fingerprint: 'L1', title: 'Cloud Architect', company: 'LinkedIn', applyUrl: url, source: 'mailalerts' }),
    { reason: 'x', category: 'role' });
  record(archive, job({ fingerprint: 'L2', title: 'Cloud Architect', company: 'SoftServe', applyUrl: url, source: 'mailalerts' }),
    { reason: 'x', category: 'role' });

  assert.deepEqual(Object.keys(archive), ['L1']);
  assert.deepEqual(archive.L1.alsoKnownAs, ['L2']);
});

test('a posting with no applyUrl is left alone', () => {
  // No key, no second opinion — and certainly no merging every url-less
  // rejection into one entry.
  const archive = {};
  record(archive, job({ fingerprint: 'N1', title: 'A', applyUrl: '' }), { reason: 'x', category: 'role' });
  record(archive, job({ fingerprint: 'N2', title: 'B', applyUrl: '' }), { reason: 'x', category: 'role' });
  assert.deepEqual(Object.keys(archive).sort(), ['N1', 'N2']);
});
