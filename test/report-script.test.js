/**
 * The report's client script, checked as the BROWSER receives it.
 *
 * `JS` in report.js is a template literal, so every backslash in it is consumed
 * once on the way out: `✓` in the source reaches the page as a tab-less
 * `u2713`, and the file doubles them for that reason. The trap is that nothing
 * catches a mistake here — `node --check src/report.js` reads the literal as a
 * string and passes, the test suite never opens a browser, and the page then
 * fails at parse time with the whole script dead: no marking, no filtering, no
 * applications panel. A regex written `/^https?:\/\//` reached the page as
 * `/^https?://` and did exactly that.
 *
 * So the literal is resolved here and the result parsed for real.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { p, readJson } from '../src/util.js';
import { REJECT_CATEGORIES, PICKER_GROUPS } from '../src/filter.js';
import { buildReport } from '../src/report.js';

const profile = readJson(p('config', 'examples', 'devops.profile.json'));

/** The same string the <script> tag gets, with its interpolations resolved. */
function emittedScript() {
  const src = readFileSync(p('src', 'report.js'), 'utf8');
  const open = 'const JS = `';
  const from = src.indexOf(open);
  assert.ok(from >= 0, 'report.js must still define the client script as `JS`');
  const to = src.indexOf('\n`;', from);
  const body = src.slice(from + open.length, to + 1);
  return new Function('REJECT_CATEGORIES', 'PICKER_GROUPS', 'return `' + body + '`;')(
    REJECT_CATEGORIES, PICKER_GROUPS);
}

test('the client script parses as the browser receives it, not as the source reads', () => {
  const js = emittedScript();
  const tmp = join(tmpdir(), `jobhunt-report-${process.pid}.js`);
  writeFileSync(tmp, js, 'utf8');
  try {
    execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' });
  } catch (err) {
    assert.fail(`the emitted report script does not parse:\n${err.stderr?.toString() || err.message}`);
  } finally {
    rmSync(tmp, { force: true });
  }
});

test('only Interested keeps a card in the queue', () => {
  // Faded cards piled up between reports: the queue you are meant to work through
  // kept showing work already done. Applied, rejected and hidden all close a job,
  // so the card goes; each has a place on the page that still shows it.
  const js = emittedScript();
  assert.match(js, /var LEAVES = \{ applied: 1, rejected: 1, hidden: 1 \};/);
  assert.doesNotMatch(js, /LEAVES\s*=\s*\{[^}]*interested/, 'interested is the one that stays');
  assert.match(js, /if \(LEAVES\[status\]\) \{\s*card\.classList\.add\('leaving'\);/);
  assert.match(js, /card\.classList\.add\('gone'\);\s*if \(window\.__recount\) window\.__recount\(\);/,
    'and the counts are recomputed once it has');

  // paint() also runs on load against /api/statuses, which is what drops cards
  // already decided from a page written before you decided them.
  assert.match(js, /if \(s && s !== 'new' && s !== 'shown'\) paint\(box, s\);/);
});

test('a card that leaves has somewhere to go, and that place updates at once', () => {
  // Removing a card is only acceptable if the page still says what you did. An
  // applied job goes to the Applications panel and a rejected one to the Turned
  // down list — and both lists were filled once, at page load, so without a
  // refresh the job would vanish and reappear only after a reload.
  const js = emittedScript();
  assert.match(js, /var refreshAll = function\(\)\{ loadApps\(\); loadRej\(\); syncQueue\(\); loadApp\(\); loadJudging\(\); \};/,
    'every list the page shows — and the app\'s status — is brought up to date together');
  assert.match(js, /window\.__refresh = function\(\)\{ refreshAll\(\); \};/);
  assert.match(js, /paint\(box, status\);\s*if \(window\.__refresh\) window\.__refresh\(status\);/,
    'refreshed only after the server has accepted the mark');
  assert.match(js, /fetch\('\/api\/turned-down'\)/);
});

test('the page keeps itself true: it matches its cards to what the server says is open', () => {
  // The report is written when a scan finishes, so by itself it is a photograph.
  // A job restored afterwards, a scan that found one, a mark made from the CLI —
  // none of them appeared until the next report. The page now asks the server what
  // is open and makes its cards match, without reloading.
  const js = emittedScript();
  assert.match(js, /fetch\('\/api\/queue\?have=' \+ encodeURIComponent\(held\.join\(','\)\)\)/);
  assert.match(js, /if \(!open\[m\.dataset\.id\]\) m\.closest\('\.job'\)\.classList\.add\('gone'\);/, 'retires what has closed');
  assert.match(js, /insertAdjacentHTML\('beforeend', j\.html\)/, 'adds what it is missing');
  assert.match(js, /if \(window\.__relayout\) window\.__relayout\(\);/, 'and re-sorts and recounts afterwards');
  assert.doesNotMatch(js, /location\.reload|window\.location *=/, 'it never reloads, so a half-chosen reason survives');
});

test('the sync finds cards, not the rejection list\'s row for the same job', () => {
  // Found by running it: the "awaiting review" list at the foot of the page has a
  // .marks[data-id] for the very job being restored. An unscoped lookup matched
  // that row, closest('.job') was null, and the whole sync threw — and a
  // swallowed error left a page that looked fine and was wrong.
  const js = emittedScript();
  assert.match(js, /document\.querySelector\('\.job \.marks\[data-id="' \+ j\.id \+ '"\]'\)/);
  assert.doesNotMatch(js, /querySelector\('\.marks\[data-id=/, 'no unscoped lookup by id anywhere');
  assert.match(js, /console\.error\('queue sync failed:', e\)/, 'and a failure is reported, not swallowed');
});

test('the page re-syncs on load, on every mark, when you look at it, and on a timer', () => {
  const js = emittedScript();
  assert.match(js, /\n    syncQueue\(\);\n/, 'on load');
  assert.match(js, /document\.addEventListener\('visibilitychange', function\(\)\{ if \(!document\.hidden\) refreshAll\(\); \}\)/);
  assert.match(js, /window\.addEventListener\('focus', refreshAll\)/);
  assert.match(js, /setInterval\(function\(\)\{ if \(!document\.hidden\) refreshAll\(\); \}, 20000\)/);
  assert.match(js, /if \(syncing\) return;/, 'and never two at once');
});

test('only the cards the page lacks are fetched, and a gone card is not "held"', () => {
  // Rendering fifty cards every twenty seconds to say "nothing new" would be
  // waste. But a card that is `gone` must not count as held: if the server wants
  // it back, the old node still shows the buttons as they were when it was turned
  // down, so a fresh one is fetched and replaces it.
  const js = emittedScript();
  assert.match(js, /querySelectorAll\('\.job:not\(\.gone\) \.marks'\)\.forEach\(function\(m\)\{ held\.push\(m\.dataset\.id\); \}\)/);
  assert.match(js, /if \(old\) old\.closest\('\.job'\)\.remove\(\);/);
});

test('a band the page was written without is created in order', () => {
  const js = emittedScript();
  assert.match(js, /var ensureBand = function\(b\)/);
  assert.match(js, /Number\(s\.dataset\.band\) > b\.index/, 'before the first later band');
  assert.match(js, /main\.insertBefore\(sec, anchor \|\| null\)/);
});

test('the filter script asks for the cards each time rather than remembering a list', () => {
  // A list taken at load would never see a card that arrives afterwards, and the
  // counter and the filter would quietly ignore it.
  const js = emittedScript();
  assert.match(js, /function allJobs\(\)\{ return \[\]\.slice\.call\(document\.querySelectorAll\('\.job'\)\); \}/);
  assert.doesNotMatch(js, /var jobs=\[\]\.slice\.call/);
  assert.match(js, /window\.__relayout=function\(\)\{/);
});

test('the toolbar and counter exist even over an empty queue', () => {
  // A job restored onto an empty page needs somewhere to be counted and filtered.
  const src = readFileSync(p('src', 'report.js'), 'utf8');
  assert.doesNotMatch(src, /\$\{total \? `<div class="toolbar">/);
  const html = buildReport({ jobs: [], profile, meta: { date: '2026-10-01', time: '12:00', totalFetched: 0, alreadySeen: 0, merged: 0, sourceLines: [], warnings: [] } });
  assert.match(html, /<div class="toolbar">/);
  assert.match(html, /id="shown"/);
  assert.match(html, /class="empty"/, 'and the empty message is still there to be hidden');
});

test('the Turned down list can put a job back', () => {
  const js = emittedScript();
  assert.match(js, /closest\('\.restore'\)/);
  // Interested, not merely open again: "I changed my mind" is a pick, and a pick is
  // never retired by a gate or aged out of the queue. Restored as `shown`, a job
  // could quietly vanish again at the next scan.
  assert.match(js, /status: 'interested' \}\)/);
  assert.doesNotMatch(js, /id: b\.dataset\.id, status: 'shown'/);
  // The card comes back through the same sync as everything else, so it is true
  // whether or not this page still held the old one.
  assert.match(js, /if \(!res\.ok\) \{ b\.textContent = 'failed'; b\.disabled = false; return; \}\s*refreshAll\(\);/);

  // The restore button must not carry the `mark` class, whose handler looks for a
  // .marks ancestor that a list row does not have.
  assert.match(js, /'<button class="restore" data-id="'/);
  assert.doesNotMatch(js, /class="mark restore"/);
});

test('a gone card counts for nothing, and an emptied section goes with it', () => {
  const js = emittedScript();
  assert.match(js, /if\(j\.classList\.contains\('gone'\)\) return;/, 'not in "n of m shown"');
  assert.match(js, /\.job:not\(\.hidden\):not\(\.gone\)/, 'not a reason to keep a section on screen');
  assert.match(js, /count\.textContent=b\.querySelectorAll\('\.job:not\(\.gone\)'\)\.length/, "and the section's number follows");
  assert.match(js, /window\.__recount=apply;/);

  const css = readFileSync(p('src', 'report.js'), 'utf8');
  assert.match(css, /\.job\.gone\{display:none\}/);
});

test('the applications panel escapes the fields it did not write', () => {
  // It is the one list built in the browser rather than through escapeHtml() on
  // the way out, and none of its fields are ours: the company name comes from a
  // job board, the storyline from a language model, and the salary from a text
  // box.
  const js = emittedScript();
  assert.match(js, /function esc\(v\)/, 'the panel needs an escaper');

  for (const field of ['a.company || a.folder', 'a.title', 'a.storyline', 'a.salaryAsked', 'a.folder']) {
    assert.ok(js.includes(`esc(${field})`), `${field} must go through esc()`);
  }
});

test('an application link is only followed when it is http', () => {
  // applyUrl is whatever the source said it was, and `javascript:` is a valid
  // string. The guard is a regex inside the template literal, which is exactly
  // where a doubled backslash gets lost.
  const js = emittedScript();
  const guard = /var href = (\/[^\n]*?\/i)\.test/.exec(js);
  assert.ok(guard, 'the http guard must survive into the emitted script');

  const re = new Function('return ' + guard[1])();
  assert.ok(re.test('https://example.com/jobs/1'));
  assert.ok(re.test('HTTP://example.com'));
  assert.ok(!re.test('javascript:alert(1)'), 'and must not accept javascript:');
  assert.ok(!re.test('data:text/html,x'));
  assert.ok(!re.test('/relative/path'));
});

/**
 * There must be ONE esc(), and it must escape quotes.
 *
 * There were two. The five-character `function esc(v)` near the top, and a
 * three-character `var esc = function(s)` further down that escaped only & < >.
 * The second sat inside `if (live) {` — a BLOCK, not a function — so `var`
 * hoisted it to the enclosing function scope and it replaced the strong one the
 * moment that line ran. paintApps() runs later, inside a .then(), so it always
 * got the weak one.
 *
 * The applications panel is the one list built in the browser rather than
 * through escapeHtml() on the way out, and it puts applyUrl into an href.
 * applyUrl comes from scraped pages and from the "add a job you found
 * elsewhere" form, where nothing validates the URL — so a single " closes the
 * attribute and injects markup into the page.
 *
 * The existing tests only asserted that esc() was CALLED. Checking what it does
 * is the part that would have caught this.
 */
test('there is exactly one esc(), and it escapes quotes', () => {
  const js = emittedScript();
  const withoutComments = js.replace(/\/\*[\s\S]*?\*\//g, '');
  const defs = withoutComments.match(/function esc\s*\(|var esc\s*=/g) || [];
  assert.equal(defs.length, 1,
    'a second esc() in the same function scope silently replaces the first');

  const body = js.match(/function esc\(v\)\{[\s\S]*?\n  \}/);
  assert.ok(body, 'the strong esc must be the one that survives');
  const esc = new Function('return ' + body[0].replace(/^function esc/, 'function'))();

  assert.equal(esc('a"b'), 'a&quot;b', 'a double quote must not survive into an href');
  assert.equal(esc("a'b"), 'a&#39;b');
  assert.equal(esc('<script>'), '&lt;script&gt;');
  assert.equal(esc('a&b'), 'a&amp;b');
  assert.equal(esc(null), '', 'and null must not print as "null"');
});

test('a URL with a quote cannot break out of the applications href', () => {
  // The concrete attack path, end to end: what the manual-add form accepts,
  // through the escaper the panel actually uses.
  const js = emittedScript();
  const esc = new Function('return ' + js.match(/function esc\(v\)\{[\s\S]*?\n  \}/)[0]
    .replace(/^function esc/, 'function'))();

  const hostile = 'https://x.test/j"><img src=x onerror=alert(1)>';
  const href = '<a href="' + esc(hostile) + '">';
  assert.ok(!href.includes('<img'), 'the injected tag must not survive');
  assert.ok(href.includes('&quot;'), 'the quote is neutralised');
});

test('the salary box opens with your usual figure, from config', () => {
  // The number you ask for is a personal fact, so it lives in profile.json and
  // reaches the client through a settings object rather than being written into
  // the source of a public repository. `JS` is a module-level template literal
  // evaluated at import, so it cannot read the profile any other way.
  const html = buildReport({
    jobs: [], profile: { ...profile, salary: { askingDefault: 85000 } },
    meta: { date: '2026-09-24' },
  });

  assert.match(html, /window\.__SETTINGS__ = \{"salaryDefault":"85000"\};/,
    'the configured figure reaches the page as a string');

  const js = emittedScript();
  assert.match(js, /window\.__SETTINGS__ && window\.__SETTINGS__\.salaryDefault/,
    'and the box reads it');
  assert.match(js, /input\.select\(\);/,
    'selected, not just filled — typing has to replace it or the default costs you on every other posting');

  // Set as a property, so a figure like `90.000 " EUR` cannot break out of an
  // HTML attribute. Nothing in this project formats free text into markup by
  // hand when the DOM will take it.
  assert.ok(!/salary-in[^>]*value=/.test(js), 'never as a value attribute');
});

test('no configured figure means the empty box it always was', () => {
  // A default is a convenience. It must not invent an answer for a profile that
  // never asked for one, and it must not throw on the way.
  const bare = { ...profile };
  delete bare.salary;
  assert.match(buildReport({ jobs: [], profile: bare, meta: { date: '2026-09-24' } }),
    /window\.__SETTINGS__ = \{"salaryDefault":""\};/);

  assert.match(buildReport({
    jobs: [], profile: { ...profile, salary: {} }, meta: { date: '2026-09-24' },
  }), /window\.__SETTINGS__ = \{"salaryDefault":""\};/);
});

test('a settings value cannot close the script tag it lives in', () => {
  // Anything interpolated into a <script> body has this hole. The value comes
  // from a config file rather than the web, so this is belt and braces — but it
  // is one line, and the failure mode is the rest of the object rendering on
  // the page as text with the script dead behind it.
  const html = buildReport({
    jobs: [], profile: { ...profile, salary: { askingDefault: '90000</script><b>x' } },
    meta: { date: '2026-09-24' },
  });
  assert.ok(!html.includes('90000</script>'), 'the closing tag must not survive verbatim');
  assert.match(html, /\u003c\/script>/);
});

test('the figure itself is never written into the source', () => {
  // Same rule as the home city and the employer names: a personal fact in a
  // user-facing string is a bug even when it is true. The placeholder used to
  // read a real asking figure.
  // Comments are exempt by the same convention personal-facts-in-config.test.js
  // uses: the evidence for a rule belongs next to it, and a comment reaches
  // nobody's screen.
  const src = readFileSync(p('src', 'report.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|\s)\/\/[^\n]*/g, ' ');
  assert.ok(!/\b\d{2,3}[.,]\d{3}\b/.test(src), 'no salary-shaped figure in report.js outside comments');
});

/**
 * The Applications panel, in three groups.
 *
 * A list of 61 in date order answers no question. "Progressing" is the
 * one that matters; "Archived" folds away 30 days of silence, which in this
 * market is an answer — and waiting for a rejection email that will never
 * arrive is exactly what left 60 of 61 applications with no outcome at all.
 */
test('applications are grouped, and age alone archives them', () => {
  const js = emittedScript();

  assert.match(js, /var ARCHIVE_DAYS = 30;/, 'thirty days, named once');
  // Two pages are fed from the one list: In progress gets the ones you are still
  // in, Applied gets the rest with the old ones folded under Archived.
  assert.ok(js.includes("fold(archbox, archsum, archlist, 'Archived', archived)"), 'the Archived section must exist');
  assert.match(js, /appsum\.textContent = 'Applied — '/, 'the Applied page is headed by its count');
  assert.match(js, /proglist\.innerHTML = progressing\.length/, 'and In progress is filled from the progressing group');
  assert.match(js, /progcount\.textContent = progressing\.length \|\| '';/, 'with its number on the tab');

  // Run the real grouping rule rather than asserting it is written down. The
  // three properties that matter are all about what does NOT archive.
  const rule = new Function('apps', 'now', `
    var ARCHIVE_DAYS = 30;
    var cutoff = now - ARCHIVE_DAYS * 86400000;
    var progressing = [], applied = [], archived = [];
    apps.forEach(function(a){
      if (a.outcome === 'interview' || a.outcome === 'offer') { progressing.push(a); return; }
      var at = Date.parse(a.at || '');
      if (at && at < cutoff) { archived.push(a); return; }
      applied.push(a);
    });
    return { progressing: progressing.map(function(a){return a.folder}), applied: applied.map(function(a){return a.folder}), archived: archived.map(function(a){return a.folder}) };
  `);

  const now = Date.parse('2026-09-24T00:00:00Z');
  const day = (n) => new Date(now - n * 86400000).toISOString();

  const out = rule([
    { folder: 'fresh', at: day(2) },
    { folder: 'old', at: day(45) },
    { folder: 'old-but-interviewing', at: day(45), outcome: 'interview' },
    { folder: 'old-but-offered', at: day(200), outcome: 'offer' },
    { folder: 'old-and-rejected', at: day(45), outcome: 'rejected' },
    { folder: 'undated', at: '' },
  ], now);

  assert.deepEqual(out.progressing, ['old-but-interviewing', 'old-but-offered'],
    'something you are still in beats the calendar, however old');
  assert.ok(out.archived.includes('old'));
  assert.ok(out.archived.includes('old-and-rejected'),
    'a closed application is history — it belongs in the fold, not the live list');
  assert.ok(out.applied.includes('fresh'));
  assert.ok(out.applied.includes('undated'),
    'an application with no date must not be archived on a NaN comparison');
});

test('"Sources this run" is gone from the page', () => {
  // Removed on request: per-run diagnostics that never changed a decision, and
  // the terminal prints the same lines while the run is happening. The data is
  // still carried on `meta` — nothing was collected for this panel alone — so
  // this asserts the RENDER is gone rather than the field.
  const src = readFileSync(p('src', 'report.js'), 'utf8');
  assert.ok(!src.includes('<summary>Sources this run</summary>'),
    'the sources section must not render');

  const html = buildReport({
    jobs: [], profile, meta: { date: '2026-09-24', sourceLines: ['Adzuna: 42 fetched'] },
  });
  assert.ok(!html.includes('Sources this run'));
  assert.ok(!html.includes('Adzuna: 42 fetched'),
    'and passing sourceLines must not put them on the page by another route');
});
