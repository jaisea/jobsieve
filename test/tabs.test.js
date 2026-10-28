/**
 * The page's sections, down the left.
 *
 * Open, In progress, Applied / Rejected, Discarded, Log, Settings. Everything that used to
 * be a collapsed panel in one long header now lives on the page it belongs to, and
 * only Open and In progress carry a count — they are the two lists with something
 * for you to do, and a number on the rest would be noise.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { p, readJson } from '../src/util.js';
import { REJECT_CATEGORIES, PICKER_GROUPS } from '../src/filter.js';
import { buildReport } from '../src/report.js';

const profile = readJson(p('config', 'examples', 'devops.profile.json'));
const meta = { date: '2026-10-01', time: '12:00', totalFetched: 0, alreadySeen: 0, merged: 0, sourceLines: [], warnings: ['Adzuna: skipped'] };
const html = buildReport({ jobs: [], profile, meta, parked: [{ title: 'Parked role', company: 'X', applyUrl: 'https://x.test/p', reason: 'no text' }] });

/** The same string the <script> tag gets, with its interpolations resolved. */
function emittedScript() {
  const src = readFileSync(p('src', 'report.js'), 'utf8');
  const open = 'const JS = `';
  const from = src.indexOf(open);
  const to = src.indexOf('\n`;', from);
  return new Function('REJECT_CATEGORIES', 'PICKER_GROUPS', 'return `' + src.slice(from + open.length, to + 1) + '`;')(
    REJECT_CATEGORIES, PICKER_GROUPS);
}

/** The text of one page, so a test can say what is and is not on it. */
const page = (id) => {
  const from = html.indexOf(`<section class="page" id="page-${id}">`);
  assert.ok(from >= 0, `page-${id} exists`);
  const next = html.indexOf('<section class="page"', from + 10);
  return html.slice(from, next < 0 ? html.indexOf('<footer>') : next);
};

/* ------------------------------------------------------------ the sidebar */

test('the sections are Open, In progress, Applied / Rejected, Discarded, Log, Settings — in that order', () => {
  const nav = html.slice(html.indexOf('<nav class="side"'), html.indexOf('</nav>'));
  const tabs = [...nav.matchAll(/<a class="tab" href="#(\w+)" data-tab="(\w+)">([^<]*)/g)];
  assert.deepEqual(tabs.map((m) => m[1]), ['open', 'progress', 'applied', 'discarded', 'log', 'settings']);
  assert.ok(tabs.every((m) => m[1] === m[2]), 'the address and the tab agree');
  assert.deepEqual(tabs.map((m) => m[3].trim()), ['Open', 'In progress', 'Applied / Rejected', 'Discarded', 'Log', 'Settings']);
});

test('every section has a page, and no page is orphaned', () => {
  const ids = [...html.matchAll(/<section class="page" id="page-(\w+)">/g)].map((m) => m[1]);
  assert.deepEqual(ids, ['open', 'progress', 'applied', 'settings', 'discarded', 'log']);
});

test('only Open and In progress carry a count', () => {
  const counts = [...html.matchAll(/class="tab-count" id="([\w-]+)"/g)].map((m) => m[1]);
  assert.deepEqual(counts, ['count-open', 'count-progress']);
  assert.equal(html.match(/class="tab-count"/g).length, 2, 'and no other tab has one');
});

test('the page opens on Open, and an empty count renders as nothing rather than a zero', () => {
  assert.match(html, /<body data-tab="open">/);
  assert.match(html, /id="count-open"><\/span>/, 'no jobs: the chip is empty (and hidden by CSS)');
  assert.match(html, /\.tab-count:empty\{display:none\}/);
});

/* ------------------------------------------------------------ what is on each page */

test('Open holds the queue, the filter, parked postings and the way to add a job', () => {
  const open = page('open');
  for (const needle of ['<header>', 'id="manbox"', 'id="m-add"', 'class="toolbar"', '<main>', 'class="parked"']) {
    assert.ok(open.includes(needle), `Open has ${needle}`);
  }
  assert.match(open, /＋ Add a job you found elsewhere/, 'the add-a-job option is on the Open page');
  assert.ok(open.indexOf('id="manbox"') < open.indexOf('class="toolbar"'), 'above the queue it feeds');
});

test('In progress has its own list and says what belongs there', () => {
  const progress = page('progress');
  assert.match(progress, /id="proglist"/);
  assert.match(progress, /<strong>interview<\/strong> or <strong>offer<\/strong>/);
});

test('Applied / Rejected holds applications, what you turned down, and what you rewrote', () => {
  const applied = page('applied');
  for (const id of ['appbox', 'applist', 'rejbox', 'rejlist', 'fbbox', 'fblist']) {
    assert.ok(applied.includes(`id="${id}"`), `Applied / Rejected has #${id}`);
  }
});

test('Settings holds the app\'s own options, the source switches, the watchlist and the scan warnings', () => {
  const settings = page('settings');
  for (const id of ['setbox', 'set-login', 'set-quit', 'srcbox', 'srclist', 'cobox', 'colist']) {
    assert.ok(settings.includes(`id="${id}"`), `#${id}`);
  }
  assert.match(settings, /Start with Windows/);
  assert.match(settings, /Quit Job Hunt/);
  assert.match(settings, /1 warning\(s\) from the last scan/);
  assert.match(settings, /Adzuna: skipped/);
  assert.ok(settings.indexOf('id="setbox"') < settings.indexOf('id="srcbox"'), 'the app\'s options come first');
});

test('there is no Sources tab any more: it became Settings', () => {
  assert.doesNotMatch(html, /data-tab="sources"/);
  assert.doesNotMatch(html, /id="page-sources"/);
  assert.doesNotMatch(html, /href="#sources"/);
});

test('the home page carries the tray menu\'s controls, and the way to the log', () => {
  const open = page('open');
  for (const id of ['appbar', 'app-scan', 'app-next', 'app-scan-btn', 'app-pause-btn']) {
    assert.ok(open.includes(`id="${id}"`), `Open has #${id}`);
  }
  assert.match(open, /Scan every source now/);
  assert.match(open, /Pause scanning/);
  assert.match(open, /<a class="app-btn" href="#log">Log<\/a>/, 'and Log is one click away');
  assert.match(open, /<div class="appbar" id="appbar" hidden>/, 'hidden until the page learns the app is serving it');
  assert.ok(open.indexOf('id="appbar"') < open.indexOf('class="toolbar"'), 'above the queue');
});

test('the Log tab has somewhere to show the log', () => {
  const log = page('log');
  assert.match(log, /id="logtext"/);
  assert.match(log, /id="log-status"/);
  assert.match(log, /<h2>Log<\/h2>/);
});

test('Discarded holds what the filters threw away, and says it is not your own rejections', () => {
  const discarded = page('discarded');
  assert.match(discarded, /What the filters threw away/);
  assert.match(discarded, /a job you turn down yourself is under <em>Applied \/ Rejected<\/em>/);
  assert.match(discarded, /Nothing has been discarded yet/, 'and an empty list says so');
});

test('nothing is left in the old header: no collapsed panels pile up under the title', () => {
  const header = html.slice(html.indexOf('<header>'), html.indexOf('</header>'));
  assert.doesNotMatch(header, /<details/);
  assert.doesNotMatch(header, /id="(appbox|rejbox|fbbox|cobox|manbox|srcbox)"/);
});

test('every element the script fills still exists exactly once', () => {
  // The script finds these by id. A page that lost or doubled one would fail
  // silently — a list that never fills.
  for (const id of ['appbox', 'applist', 'appsum', 'proglist', 'count-progress', 'count-open', 'rejbox', 'rejlist',
    'rejsum', 'fbbox', 'fblist', 'fbsum', 'cobox', 'colist', 'cosum', 'manbox', 'srcbox', 'srclist', 'q', 'mode', 'sort', 'shown',
    'appbar', 'app-scan', 'app-next', 'app-msg', 'app-scan-btn', 'app-pause-btn', 'setbox', 'set-login', 'set-quit', 'logtext', 'log-status']) {
    assert.equal(html.match(new RegExp(`id="${id}"`, 'g'))?.length, 1, `#${id} appears once`);
  }
});

/* ------------------------------------------------------------ the behaviour */

/** Run the router with a stub page, so what is tested is the shipped code. */
function route(hash, scrolled = []) {
  const js = emittedScript();
  const start = js.indexOf('(function(){\n  var TABS');
  const end = js.indexOf('})();', start) + 5;
  const tabs = ['open', 'progress', 'applied', 'discarded', 'log', 'settings'].map((t) => {
    const classes = new Set();
    const attrs = {};
    return {
      dataset: { tab: t },
      classes,
      classList: { toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)) },
      setAttribute: (k, v) => { attrs[k] = v; },
      removeAttribute: (k) => { delete attrs[k]; },
      attrs,
    };
  });
  const listeners = {};
  const body = { dataset: {} };
  new Function('document', 'location', 'window', js.slice(start, end))(
    { body, querySelectorAll: () => ({ forEach: (fn) => tabs.forEach(fn) }) },
    { hash },
    { addEventListener: (e, fn) => { listeners[e] = fn; }, scrollTo: (...a) => scrolled.push(a) },
  );
  return { body, tabs, listeners, scrolled };
}

test('the address chooses the section, and an unknown one falls back to Open', () => {
  assert.equal(route('#applied').body.dataset.tab, 'applied');
  assert.equal(route('#discarded').body.dataset.tab, 'discarded');
  assert.equal(route('#log').body.dataset.tab, 'log');
  assert.equal(route('#settings').body.dataset.tab, 'settings');
  assert.equal(route('#sources').body.dataset.tab, 'settings', 'the old address still lands somewhere sensible');
  assert.equal(route('').body.dataset.tab, 'open');
  assert.equal(route('#nonsense').body.dataset.tab, 'open');
  assert.equal(route('#__proto__').body.dataset.tab, 'open', 'a hash is never trusted as a key');
});

test('exactly one tab is marked as the current page', () => {
  const { tabs } = route('#settings');
  const active = tabs.filter((t) => t.classes.has('active')).map((t) => t.dataset.tab);
  assert.deepEqual(active, ['settings']);
  assert.equal(tabs.find((t) => t.dataset.tab === 'settings').attrs['aria-current'], 'page');
  assert.ok(tabs.filter((t) => t.dataset.tab !== 'settings').every((t) => !('aria-current' in t.attrs)));
});

test('changing the address switches sections, and a switch scrolls to the top', () => {
  const scrolled = [];
  const { listeners, body } = route('#open', scrolled);
  assert.equal(typeof listeners.hashchange, 'function', 'it listens for the address changing');
  assert.deepEqual(scrolled[0], [0, 0]);
  assert.equal(body.dataset.tab, 'open');
});

/* ------------------------------------------------------------ the script keeps the counts true */

test('Open counts every open card, not the ones a filter lets through, and shows nothing at zero', () => {
  const js = emittedScript();
  assert.match(js, /var openCount=document\.getElementById\('count-open'\);\s*if\(openCount\) openCount\.textContent=total\|\|'';/);
  // `total` is the non-gone cards: counted before the filter decides what is visible.
  assert.match(js, /if\(j\.classList\.contains\('gone'\)\) return;\s*total\+\+;/);
});

test('an outcome moves an application between In progress and Applied', () => {
  const js = emittedScript();
  assert.match(js, /if \(a\.outcome === 'interview' \|\| a\.outcome === 'offer'\) \{ progressing\.push\(a\); return; \}/);
  // Changing the dropdown repaints from the server's answer, so the move is immediate.
  assert.match(js, /if \(res\.applications\) paintApps\(/);
});

test('adding a job fetches its card straight away', () => {
  const js = emittedScript();
  const added = js.slice(js.indexOf("fetch('/api/manual'"), js.indexOf('/* ---- source switches'));
  assert.match(added, /if \(window\.__refresh\) window\.__refresh\(\);/);
});

test('the layout collapses to a top bar on a narrow window', () => {
  const css = readFileSync(p('src', 'report.js'), 'utf8');
  assert.match(css, /@media \(max-width:760px\)\{\s*\.shell\{grid-template-columns:1fr\}/);
  assert.match(css, /\.side\{position:sticky;top:0;align-self:start;height:100vh/, 'and is pinned on a wide one');
});

test('every section of the Applied / Rejected page folds, and a turned-down job can be read', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../src/report.js', import.meta.url), 'utf8');
  for (const id of ['appbox', 'rejbox', 'fbbox']) {
    assert.match(src, new RegExp(`<details class="panel fold" id="${id}"`), `${id} must be collapsible`);
  }
  assert.match(src, /data-job="' \+ esc\(r\.id\)/, 'a turned-down row has a description to open');
  const serve = readFileSync(new URL('../src/serve.js', import.meta.url), 'utf8');
  assert.match(serve, /url\.pathname === '\/api\/job-jd'/);
});

test('Archived and Rejected-documents-kept are sections of their own, and a rejected row can be restored', () => {
  const src = readFileSync(new URL('../src/report.js', import.meta.url), 'utf8');
  // Same level as Applied: siblings under the page, not folded inside the Applied panel.
  const applied = src.slice(src.indexOf('<details class="panel fold" id="appbox"'), src.indexOf('<details class="panel fold" id="archbox"'));
  assert.doesNotMatch(applied, /archbox|rejdocbox/, 'Applied must not contain the other groups');
  for (const id of ['archbox', 'rejdocbox']) assert.match(src, new RegExp(`<details class="panel fold" id="${id}"`));
  assert.match(src, /'<button class="restore" data-id="' \+ esc\(String\(a\.fingerprint\)\.slice\(0, 8\)\)/, 'a rejected application row offers Restore');
});
