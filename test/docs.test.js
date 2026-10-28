/**
 * The README documents which job titles are searched for and kept. Lists drift
 * from prose the moment someone edits one and not the other, and a title list
 * that silently disagrees with the docs is worse than undocumented — you would
 * tune the wrong thing. So the docs are checked against the actual config.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';

import { readJson, p } from '../src/util.js';
import * as filterModule from '../src/filter.js';
import * as applyMod from '../src/apply/index.js';

const README = readFileSync(p('README.md'), 'utf8');
const CLAUDE = readFileSync(p('CLAUDE.md'), 'utf8');
const sources = readJson(p('config', 'sources.json'));
const profile = readJson(p('config', 'examples', 'devops.profile.json'));
// The tool is role-agnostic and ships two example profiles: the default template
// (full-stack web) and the DevOps one the test suite runs against. The README
// documents both, so both are checked against it.
const EXAMPLES = {
  'profile.example.json (full-stack)': readJson(p('config', 'profile.example.json')),
  'examples/devops.profile.json': profile,
};
const pkg = readJson(p('package.json'));

test('CLAUDE.md is one document, not a document with a copy of itself in the middle', () => {
  // A string replacement whose new text contained a dollar sign and a backtick — which
  // JavaScript expands to "everything before the match" — pasted a copy of the opening
  // 424 lines into the middle of a sentence. Nothing noticed, and later edits reached
  // only the first copy, so the two drifted apart: the stale one still read as current.
  const once = (re, what) => assert.equal((CLAUDE.match(re) || []).length, 1, `${what} appears exactly once`);
  once(/^# CLAUDE\.md/mg, 'the title');
  once(/^## Commands/mg, 'the Commands section');
  once(/^## Architecture/mg, 'the Architecture section');
  once(/^### Config/mg, 'the Config section');
  once(/^## Conventions/mg, 'the Conventions section');
  once(/^## Verification/mg, 'the Verification section');
  // The seam itself: a title glued to the end of a sentence.
  assert.doesNotMatch(CLAUDE, /\S# CLAUDE\.md/, 'no second title joined to the end of a line');
  // And the sentence that was broken reads whole again. Any whitespace between the
  // words: the text is re-wrapped freely, and the point is that it is one sentence.
  assert.match(CLAUDE, /anchored to a real\s+TLD: `\[a-z\.\]\+\$` let `efinancialcareers\.evil\.test`/);
});

test('the public docs carry no personal detail', () => {
  // The repository is public and the tool is configured, not written, for one
  // person: home city, name, contact details and permits belong in profile.json.
  // The docs began life as a private diary and are the likeliest place for one
  // to survive a scrub.
  const docs = {
    'README.md': README,
    'CLAUDE.md': CLAUDE,
    'docs/requirements.html': readFileSync(p('docs', 'requirements.html'), 'utf8'),
  };
  const leaks = [/\bJaise\b/i, /@gmail/i, /\+49/, /linkedin\.com\/in/i, /realworld one/i,
    /Freiburg/i, /Breisgau/i, /Ausweis/i, /OneDrive/i, /C:\\Users/i];
  for (const [name, text] of Object.entries(docs)) {
    for (const leak of leaks) {
      assert.ok(!leak.test(text), `${name} must not contain ${leak}`);
    }
  }
});

test('every search term sent to the APIs is documented', () => {
  // The terms moved from sources.json into the profile (searchQueries): what a
  // user searches for is their field, not the tool's. Every term either example
  // ships must be visible in the README, because each one costs API quota.
  for (const [name, prof] of Object.entries(EXAMPLES)) {
    assert.ok(Array.isArray(prof.searchQueries) && prof.searchQueries.length > 0,
      `${name} must ship searchQueries`);
    for (const q of prof.searchQueries) {
      assert.ok(README.includes(q), `${name} searchQueries entry "${q}" is missing from the README`);
    }
  }
  // And nothing still documents the old home of the list as the primary one.
  assert.ok(!('queries' in sources) || README.includes('searchQueries'),
    'a queries list in sources.json is only a fallback; the README must name searchQueries');
});

test('every excluded title term is documented', () => {
  // This is the list most likely to grow — each addition is a rule that silently
  // discards postings, so it has to stay visible.
  for (const [name, prof] of Object.entries(EXAMPLES)) {
    for (const term of prof.targetTitles.exclude) {
      assert.ok(README.includes(term), `${name} exclude term "${term}" is missing from the README`);
    }
  }
});

test('every reduced-weight target title is documented', () => {
  for (const [name, prof] of Object.entries(EXAMPLES)) {
    for (const term of prof.targetTitles.good) {
      assert.ok(README.includes(term), `${name} targetTitles.good entry "${term}" is missing from the README`);
    }
  }
});

test('the strong list is documented, and the DevOps one by shape', () => {
  // The README describes the DevOps list as four roles x engineer/architect,
  // plus sre, rather than listing nine strings. Assert the shape that claim
  // depends on. The full-stack list has no such shape, so it is listed verbatim.
  const strong = profile.targetTitles.strong;
  for (const role of ['devops', 'cloud', 'platform', 'site reliability']) {
    assert.ok(strong.includes(`${role} engineer`), `${role} engineer missing`);
    assert.ok(strong.includes(`${role} architect`), `${role} architect missing`);
  }
  assert.ok(strong.includes('sre'));
  assert.equal(strong.length, 9, 'a new DevOps strong title needs a README update');

  const fullStack = EXAMPLES['profile.example.json (full-stack)'].targetTitles.strong;
  for (const t of fullStack) {
    assert.ok(README.includes(t), `full-stack strong title "${t}" is missing from the README`);
  }
});

test('the relevance vocabularies in the example profiles match the README', () => {
  // The vocabulary used to be constants in filter.js, which made the tool a
  // DevOps tool. It is profile.relevance now; the README documents each
  // example's lists, and a list that drifts from them would have you tune the
  // wrong thing.
  for (const [name, prof] of Object.entries(EXAMPLES)) {
    const r = prof.relevance;
    assert.ok(r, `${name} must ship a relevance block`);
    for (const key of ['domainTerms', 'offTrack', 'nearMissTerms']) {
      assert.ok(Array.isArray(r[key]) && r[key].length > 0, `${name} relevance.${key} must be a non-empty list`);
      for (const term of r[key]) {
        assert.ok(README.includes(term), `${name} relevance.${key} term "${term}" is missing from the README`);
      }
    }
    for (const re of r.nearMissPatterns || []) {
      assert.doesNotThrow(() => new RegExp(re), `${name} nearMissPattern ${re} must compile`);
    }
  }
  // And the constants are really gone: two homes for one list is how they drift.
  const src = readFileSync(p('src', 'filter.js'), 'utf8');
  for (const name of ['DOMAIN_TERMS', 'OFF_TRACK', 'INFRA_TERMS', 'EXTRA_NEAR_MISS']) {
    assert.ok(!new RegExp(`const ${name} =`).test(src), `${name} is back in filter.js; it belongs in the profile`);
  }
});

test('the terms deliberately kept OUT of near-miss detection stay out', () => {
  // 'operations' and 'systems' pulled in "People Operations Specialist" and
  // "Casual Rugby Systems Operator". The README says they are excluded for that
  // reason; re-adding them to an example would teach every copy of it the noise.
  for (const [name, prof] of Object.entries(EXAMPLES)) {
    const terms = prof.relevance.nearMissTerms;
    assert.ok(!terms.includes('operations'), `${name}: see _nearMissComment`);
    assert.ok(!terms.includes('systems'), `${name}: see _nearMissComment`);
  }
  assert.match(README, /Keep generic words such as `operations` and `systems` out of\s+`nearMissTerms`/);
});

/* --------------------------------------------------- commands, files, paths */

/**
 * These next four exist because the same class of gap was found by hand three
 * times in one day: `npm run daily` shipped undocumented, the README claimed a
 * stale test count, and two config files the UI writes were missing from the
 * table — one of which was also not gitignored. Checking by reading does not
 * scale; checking mechanically does.
 */

test('every npm script is documented, and every documented one exists', () => {
  const scripts = Object.keys(pkg.scripts).filter((s) => s !== 'test');
  for (const s of scripts) {
    assert.ok(README.includes(`npm run ${s}`), `"npm run ${s}" exists but is not in the README`);
  }
  const mentioned = [...new Set([...README.matchAll(/npm run ([a-z-]+)/g)].map((m) => m[1]))];
  for (const m of mentioned) {
    assert.ok(m === 'test' || scripts.includes(m), `the README documents "npm run ${m}", which no longer exists`);
  }
});

test('the README test count matches reality', () => {
  // Self-referential on purpose: adding a test forces the number to be updated,
  // which is the only way a count in prose stays true.
  const files = readdirSync(p('test')).filter((f) => f.endsWith('.test.js'));
  const actual = files.reduce((n, f) =>
    n + (readFileSync(p('test', f), 'utf8').match(/^test\(/gm) || []).length, 0);

  const claimed = Number(README.match(/Regression suite — (\d+) tests/)?.[1]);
  assert.equal(claimed, actual, `README says ${claimed} tests; there are ${actual}`);
});

test('every file the tool writes is listed in the README', () => {
  // A file nobody documents is a file nobody remembers to gitignore — which is
  // exactly how config/style-notes.json nearly reached a public repo carrying
  // the text of real cover letters.
  const written = [
    'data/seen.json', 'data/jobs.json', 'data/rejected.json', 'data/descriptions.json',
    'data/verdicts.json', 'data/pending.json', 'data/parked.json', 'data/awaiting.json', 'data/batches.json', 'data/gate-stats.json', 'data/mail-state.json', 'data/agency-details.json', 'data/title-drops.json',
    'config/sources.json', 'config/watchlist.json', 'config/style-notes.json',
  ];
  for (const f of written) {
    assert.ok(README.includes(f), `${f} is written at runtime but is not in the README's table`);
  }
});

test('every source path either exists or is created at runtime', () => {
  const both = `${README}\n${CLAUDE}`;
  const paths = [...new Set([...both.matchAll(/(?:src|test)\/[\w/-]+\.js/g)].map((m) => m[0]))];
  assert.ok(paths.length > 5, 'expected the docs to reference real modules');

  for (const f of paths) {
    assert.ok(existsSync(p(f)), `the docs reference ${f}, which does not exist`);
  }
});

test('every registered command appears in the help text', () => {
  // Five commands — apply, daily, companies, keys, serve — were registered in
  // COMMANDS and documented in the README while being absent from `npm run
  // help`, which is the one place you look when you have forgotten a name.
  // Registering a command and describing it are two edits; this makes the
  // second one non-optional.
  const src = readFileSync(p('src', 'index.js'), 'utf8');

  const decl = src.match(/const COMMANDS = \{([^}]*)\}/);
  assert.ok(decl, 'COMMANDS not found in index.js');
  const names = decl[1].split(',').map((e) => e.split(':')[0].trim()).filter(Boolean);
  assert.ok(names.length > 10, `only ${names.length} commands parsed — the regex has drifted`);

  const helpText = src.slice(src.indexOf('async function help()'));
  for (const name of names) {
    if (name === 'help') continue; // you are already reading it
    assert.ok(helpText.includes(`npm run ${name}`), `"${name}" is registered but missing from the help text`);
  }
});

test('the help text does not advertise a command that does not exist', () => {
  // The other direction. A renamed command leaves help promising something
  // that now fails with "unknown command".
  const src = readFileSync(p('src', 'index.js'), 'utf8');
  const scripts = Object.keys(JSON.parse(readFileSync(p('package.json'), 'utf8')).scripts);
  const helpText = src.slice(src.indexOf('async function help()'));

  for (const m of helpText.matchAll(/npm run ([a-z-]+)/g)) {
    assert.ok(scripts.includes(m[1]), `help mentions "npm run ${m[1]}", which is not in package.json`);
  }
});

test('every apply flag the docs promise is actually handled', () => {
  // `--diff` reads the audit trail rather than regenerating, so it is easy to
  // document and forget to wire up — the failure would be silent, since an
  // unrecognised flag just falls through to a normal run and spends a model
  // call.
  const src = readFileSync(p('src', 'index.js'), 'utf8');
  const block = src.slice(src.indexOf('`npm run apply -- <id>`'), src.indexOf('async function applyCmd'));
  const flags = [...new Set([...block.matchAll(/--[a-z-]+/g)].map((m) => m[0]))];
  assert.ok(flags.length >= 3, `only ${flags.length} apply flags found in the docs`);

  for (const f of flags) {
    assert.ok(src.includes(`has('${f}')`), `apply documents ${f} but never checks for it`);
  }
});

test('the requirements document is present and free of personal detail', () => {
  // It lives in a PUBLIC repository, and the README promises that name, email,
  // citizenship and residence status appear only in profile.json. An earlier
  // draft stated the candidate's language level and residence directly; those
  // are configuration, and the document describes them as such.
  const doc = readFileSync(p('docs', 'requirements.html'), 'utf8');
  assert.ok(doc.length > 5000, 'the document should be substantial');
  assert.match(doc, /<title>/, 'and carry a title');

  const body = doc.replace(/<style[\s\S]*?<\/style>/g, '').replace(/<link[^>]*>/g, '');
  for (const leak of [/\bJaise\b/i, /@gmail/i, /\+49/, /linkedin\.com\/in/i, /realworld one/i,
    /Freiburg/i, /Breisgau/i, /Ausweis/i]) {
    assert.ok(!leak.test(body), `the requirements document must not contain ${leak}`);
  }

  assert.match(readFileSync(p('README.md'), 'utf8'), /docs\/requirements\.html/,
    'and the README must point at it, or nobody will find it');
});

test('the report labels every category the gates can produce', () => {
  // report.js kept a hand-written copy of the reject categories and had already
  // drifted: `closed` was added to the gates and never here, so those
  // rejections would have shown under a raw key at the foot of the page. The
  // ORDER is still report.js's own — it is a property of reviewing, not of
  // gating — but the wording now comes from one place.
  const rep = readFileSync(p('src', 'report.js'), 'utf8');
  assert.match(rep, /import \{ REJECT_CATEGORIES, PICKER_GROUPS \} from '\.\/filter\.js'/,
    'the labels must come from the gates');
  assert.ok(!/const REJECT_LABELS = \{\s*\n\s*language:/.test(rep),
    'and must not be re-typed here');

  const order = JSON.parse(rep.match(/const REVIEW_ORDER = (\[[^\]]*\])/)[1].replace(/'/g, '"'));
  const { REJECT_CATEGORIES } = filterModule;

  // `advert` can never be assigned by a gate, so it has no review group to
  // order. The review list answers "should this gate have caught it"; there is
  // no gate that reads an advert and decides it is not to your taste, which is
  // the entire reason the category exists. It is now reached through the
  // "I am not impressed" group rather than a button of its own, and 9
  // rejections on file still carry the bare key.
  const pickerOnly = new Set(['advert']);

  for (const k of Object.keys(REJECT_CATEGORIES)) {
    if (pickerOnly.has(k)) continue;
    assert.ok(order.includes(k), `"${k}" is a gate category with no place in the review order`);
  }

  // The other half: a picker-only category must still be labelled and must
  // still be REACHABLE, or the option silently disappears from the page. It is
  // reachable through the group that claims it now, not by being its own
  // button.
  const { PICKER_GROUPS } = filterModule;
  for (const k of pickerOnly) {
    assert.ok(REJECT_CATEGORIES[k], `"${k}" must still carry a label`);
    assert.ok(PICKER_GROUPS.some((g) => g.key === k || g.gates.includes(k)),
      `"${k}" must still be reachable from the picker, by itself or through a group`);
  }

  // `age` and `score` are gate categories with NO button, deliberately. A
  // posting too old or too low-scoring was already dropped by the gate, so one
  // reaching your review is one the gate did not catch that way — and neither
  // has ever been picked.
  for (const k of ['age', 'score']) {
    assert.ok(REJECT_CATEGORIES[k], `"${k}" is still a gate category`);
    assert.ok(!PICKER_GROUPS.some((g) => g.key === k || g.gates.includes(k)),
      `"${k}" must not be offered as a button`);
  }
});

test('the requirements document\'s summary numbers match the config', () => {
  // The same shape as the README test count above, and for the same reason: the
  // README's number went stale twice in one day and was caught only because a
  // test read it. These three sit at the top of the document, where they are
  // most likely to be believed and least likely to be re-checked.
  const doc = readFileSync(p('docs', 'requirements.html'), 'utf8');
  const glance = doc.slice(doc.indexOf('<dl class="glance">'), doc.indexOf('</dl>', doc.indexOf('<dl class="glance">')));
  const stated = (label) => Number(glance.match(new RegExp(`<dt>${label}</dt><dd>([0-9]+)`))?.[1]);

  const enabled = Object.values(sources).filter((v) => v && typeof v === 'object' && 'enabled' in v);
  assert.equal(stated('Sources'), enabled.length,
    `the document says ${stated('Sources')} sources; sources.json defines ${enabled.length}`);

  assert.equal(stated('Filter gates'), filterModule.CHECKS.length,
    `the document says ${stated('Filter gates')} gates; CHECKS has ${filterModule.CHECKS.length}`);

  assert.equal(stated('Search radius'), profile.location.radiusKm,
    'the document and profile.example.json disagree about the radius');
});

/**
 * The prose count, not just the "at a glance" one.
 *
 * The glance box said 10 and was tested. The paragraph two sections down still
 * said "Eight checks" and listed eight rows, missing the employment-type and
 * stack gates added since — so the document contradicted itself, and the half
 * that was wrong was the half anybody actually reads.
 */
test('the gate table in the requirements lists every gate', () => {
  const doc = readFileSync(p('docs', 'requirements.html'), 'utf8');
  const { CHECKS } = filterModule;

  const words = { 6: 'Six', 7: 'Seven', 8: 'Eight', 9: 'Nine', 10: 'Ten', 11: 'Eleven', 12: 'Twelve' };
  assert.ok(doc.includes(`${words[CHECKS.length]} checks run in order`),
    `the prose must say ${words[CHECKS.length]}, for ${CHECKS.length} gates`);

  const table = doc.slice(doc.indexOf('<th>Rejects when</th>'), doc.indexOf('</tbody>', doc.indexOf('<th>Rejects when</th>')));
  const rows = (table.match(/<tr>/g) || []).length;
  assert.equal(rows, CHECKS.length, `the table has ${rows} rows for ${CHECKS.length} gates`);
});

/**
 * A default named in three places was three different numbers.
 */
test('the documented LLM call cap is the one the template ships', () => {
  const readme = readFileSync(p('README.md'), 'utf8');
  const example = readJson(p('config', 'examples', 'devops.profile.json'));
  const shipped = example.llm?.maxCallsPerRun;

  assert.ok(shipped !== undefined, 'the template must state a cap at all');
  assert.ok(readme.includes(`**${shipped}** in the shipped template`),
    `the prose must name ${shipped}, the value in profile.example.json`);
  assert.ok(readme.includes(`| \`llm.maxCallsPerRun\` | \`${shipped}\` |`),
    `the settings table must name ${shipped} too`);
});

test('the README does not still advertise a provider chain', () => {
  // Two provider files and a paid SDK were removed; the heading above the
  // paragraph explaining that survived.
  const readme = readFileSync(p('README.md'), 'utf8');
  assert.ok(!readme.includes('pick one, or chain several'),
    'the multi-provider heading outlived the multi-provider code');
});

/**
 * The requirements document, beyond the three integers.
 *
 * Three numbers in the "at a glance" box were tested and stayed correct for
 * five releases while the prose around them went stale: it described a picker
 * that had been deliberately changed, and claimed three dependencies where
 * there are two. A test that guards three integers is why nobody noticed.
 *
 * So: wherever the document states a FACT that exists in the code, assert the
 * code still says it. Not the prose — the facts inside it.
 */
const WORDS = { 1: 'one', 2: 'two', 3: 'three', 4: 'four', 5: 'five', 6: 'six', 7: 'seven', 8: 'eight', 9: 'nine', 10: 'ten', 30: 'thirty' };

test('the requirements document states no fact the code contradicts', () => {
  const doc = readFileSync(p('docs', 'requirements.html'), 'utf8');
  const prose = doc.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
  const lower = prose.toLowerCase();

  // Runtime dependencies. Said "Three" while package.json had two, for five
  // releases — the drift that prompted this test.
  const deps = Object.keys(JSON.parse(readFileSync(p('package.json'), 'utf8')).dependencies || {}).length;
  assert.ok(lower.includes(`dependencies ${WORDS[deps]},`),
    `the document must say there are ${deps} dependencies`);

  // How many choices the "not for me" picker offers. The document described
  // one button per check long after that was changed on purpose.
  const { PICKER_GROUPS, REJECT_CATEGORIES } = filterModule;
  // Plain substring rather than a built regex: `\b` inside a template literal
  // is a BACKSPACE, and building these patterns by interpolation is how this
  // very test first failed against a document that said exactly the right
  // thing. There is nothing here a word boundary would buy.
  assert.ok(lower.includes(`${WORDS[PICKER_GROUPS.length]} choices`),
    `the document must say the picker offers ${PICKER_GROUPS.length} choices`);
  assert.ok(PICKER_GROUPS.length < Object.keys(REJECT_CATEGORIES).length,
    'and the whole point is that there are fewer choices than checks');

  // The archive window, which is a decision rather than a detail.
  const days = Number(readFileSync(p('src', 'report.js'), 'utf8').match(/var ARCHIVE_DAYS = (\d+);/)?.[1]);
  assert.ok(days, 'report.js must still name the archive window');
  assert.ok(lower.includes(`${WORDS[days]} days`),
    `the document must state the ${days}-day window`);

  // A claim the document makes outright, so the code has to keep it true.
  assert.match(prose, /There is no "rejected" status/);
  assert.ok(!applyMod.OUTCOMES.includes('rejected'),
    'the document says there is no rejected status — so there must not be one');
});

test('every requirement carries an id, and no id is used twice', () => {
  // Ids are cited in commit messages and in review. A duplicate makes one of
  // those citations point at the wrong requirement, silently.
  const doc = readFileSync(p('docs', 'requirements.html'), 'utf8');
  const ids = [...doc.matchAll(/<span class="rid">([^<]+)<\/span>/g)].map((m) => m[1]);
  assert.ok(ids.length > 50, 'the document should still be a list of requirements');

  const seen = new Set();
  for (const id of ids) {
    assert.ok(!seen.has(id), `requirement id "${id}" is used more than once`);
    seen.add(id);
  }
});
