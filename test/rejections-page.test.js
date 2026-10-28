/**
 * The rejection list lives on a page of its own.
 *
 * It was the Discarded section of the report: 9.6 MB of a 10.06 MB page, 96% of
 * it, for a list looked at now and then. Everything else the report holds is
 * 0.44 MB. With the list out, the report is cheap enough to rewrite after every
 * source, and it stops carrying eleven thousand rows while you look at the queue.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { readFileSync } from 'node:fs';

import { p } from '../src/util.js';
import { buildReport, buildRejectionsPage } from '../src/report.js';
import { answeredBy } from '../src/rejections-page.js';
import { serve } from '../src/serve.js';

const profile = JSON.parse(readFileSync(p('config', 'examples', 'devops.profile.json'), 'utf8'));
const meta = { date: '2026-10-01', time: '12:00', totalFetched: 0, alreadySeen: 0, merged: 0, sourceLines: [], warnings: [] };

const rejection = (n, over = {}) => ({
  fingerprint: `${String(n).padStart(2, '0')}abcdef${'0'.repeat(8)}`,
  title: `Rejected role ${n}`, company: `Company ${n}`, applyUrl: `https://x.test/${n}`,
  category: 'role', reason: 'not a target role', ...over,
});
const many = Array.from({ length: 60 }, (_, i) => rejection(i));

test('the report holds a count and a link, not the rows', () => {
  const html = buildReport({ jobs: [], profile, meta, rejectedCount: 11224, reviewedCount: 3 });
  assert.match(html, /<strong>11224<\/strong> rejected, awaiting review/);
  assert.match(html, /href="rejections\.html"/);
  assert.doesNotMatch(html, /class="rej-row"/, 'no rows in the report');
  assert.doesNotMatch(html, /Mark all \d+ reviewed/);
});

test('rows passed to buildReport are counted, never rendered', () => {
  // Callers that still hand over the array (older code, tests) must not bring the
  // 9.6 MB back.
  const html = buildReport({ jobs: [], profile, meta, rejected: many });
  assert.match(html, /<strong>60<\/strong> rejected/);
  assert.doesNotMatch(html, /Rejected role 3/);
});

test('a report with nothing awaiting says so, and offers the reviewed ones', () => {
  const none = buildReport({ jobs: [], profile, meta, rejectedCount: 0, reviewedCount: 0 });
  assert.match(none, /Nothing has been discarded yet/);
  const caughtUp = buildReport({ jobs: [], profile, meta, rejectedCount: 0, reviewedCount: 5 });
  assert.match(caughtUp, /5 rejections\s+already checked/);
  assert.match(caughtUp, /rejections\.html\?all/);
});

test('the report is small once the list is out', () => {
  const html = buildReport({ jobs: [], profile, meta, rejected: many });
  assert.ok(html.length < 400 * 1024, `${(html.length / 1024).toFixed(0)} KB`);
});

test('the rejection page holds every row, grouped, with the buttons that worked in the report', () => {
  const html = buildRejectionsPage({ rejected: many, reviewedCount: 2, profile });
  assert.equal((html.match(/class="rej-row"/g) || []).length, 60);
  assert.match(html, /class="rej-clear"/, 'Mark all reviewed');
  assert.match(html, /data-status="interested"/, 'Want it');
  assert.match(html, /<style>/);
  assert.match(html, /<script>/, 'the same script, so the buttons do something');
  assert.match(html, /2 already reviewed and hidden/);
});

test('the page links back to the report, from disk and from the server', () => {
  const html = buildRejectionsPage({ rejected: many, profile });
  assert.match(html, /id="rej-back" href="latest\.html"/, 'beside the file on disk');
  assert.match(html, /protocol\.indexOf\('http'\) === 0\) document\.getElementById\('rej-back'\)\.setAttribute\('href', '\/'\)/,
    'and to / when served');
});

test('user text in a rejection is escaped on the page', () => {
  // Titles and companies come from job boards.
  const html = buildRejectionsPage({ rejected: [rejection(1, { title: '<img src=x onerror=alert(1)>', company: '"><script>x</script>' })], profile });
  assert.doesNotMatch(html, /<img src=x onerror/);
  assert.doesNotMatch(html, /"><script>x<\/script>/);
});

test('answeredBy is the four statuses, the wider set on purpose', () => {
  // Wider than decidedBy: an `interested` posting has been answered for, so the
  // list must stop asking whether the filter erred. Read from the module that
  // now owns it.
  const src = readFileSync(p('src', 'rejections-page.js'), 'utf8');
  const decl = src.match(/export const answeredBy = \(state\) =>[\s\S]*?\n\);/)[0];
  const statuses = [...decl.matchAll(/'([a-z]+)'/g)].map((m) => m[1]).sort();
  assert.deepEqual(statuses, ['applied', 'hidden', 'interested', 'rejected']);

  const seen = { a: { status: 'interested' }, b: { status: 'shown' }, c: { status: 'rejected' } };
  assert.deepEqual([...answeredBy({ seen })].sort(), ['a', 'c']);
});

test('the run writes the page once, at the end, not after every source', () => {
  const index = readFileSync(p('src', 'index.js'), 'utf8');
  assert.match(index, /if \(!quiet\) writeRejectionsPage\(\{ profile \}\);/);
  // The per-source report write is quiet, so it skips it.
  assert.match(index, /writeReport\(store\.load\(\), \{ quiet: true \}\)/);
});

const freePort = () => new Promise((resolve) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});


test('the server renders the list live, uncached, from the archive', () => {
  // Rendering it reads the real archive (eleven thousand rows, about 8 seconds),
  // so this checks the route rather than fetching it: what "Mark all reviewed"
  // just did must show on reload, which is the point of rendering per request.
  const serveSrc = readFileSync(p('src', 'serve.js'), 'utf8');
  const route = serveSrc.slice(serveSrc.indexOf("url.pathname === '/rejections'"));
  assert.match(route.slice(0, 500), /url\.pathname === '\/rejections\.html'/);
  assert.match(route.slice(0, 500), /'Cache-Control': 'no-store'/);
  assert.match(route.slice(0, 500), /rejectionsHtml\(\{ all: url\.searchParams\.has\('all'\) \}\)/);
});

test('the report is also served at /latest.html, so the relative link back works', async () => {
  const port = await freePort();
  const server = await serve({ port, open: false });
  if (!server.listening) await new Promise((r) => server.once('listening', r));
  try {
    const r = await fetch(`http://127.0.0.1:${port}/latest.html`);
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /text\/html/);
    await r.text();
  } finally {
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
  }
});

test('nothing in the CLI still refers to the rows it no longer loads', () => {
  // `report` read `rejectedAll.length` in its summary line after the rows were
  // moved out, and threw — after writing both files, so the output looked fine
  // until the last line. No test runs `report` (it rewrites your real report).
  assert.doesNotMatch(readFileSync(p('src', 'index.js'), 'utf8'), /rejectedAll/);
});

/* ----------------------------------------------- the page's own script */

/** The string the page's <script> actually receives: the template literal, spent once. */
function emitted(name) {
  const src = readFileSync(p('src', 'report.js'), 'utf8');
  const open = `const ${name} = \``;
  const from = src.indexOf(open);
  const to = src.indexOf('\n`;', from);
  return new Function('REJECT_CATEGORIES', 'PICKER_GROUPS', 'return `' + src.slice(from + open.length, to + 1) + '`;')({}, []);
}

test('the rejection page script parses, and is not the report script', () => {
  // The report script assumes the report (a filter bar, a queue, a tab router);
  // on this page one IIFE threw on a null and the queue sync logged a failure for
  // a list it has no business fetching.
  const js = emitted('REJ_JS');
  assert.doesNotThrow(() => new Function(js), 'a parse error here kills both buttons');
  assert.match(js, /\.rej-clear/);
  assert.match(js, /\/api\/review/);
  assert.match(js, /\/api\/mark/);
  assert.doesNotMatch(js, /syncQueue|__refresh|getElementById/, 'nothing that needs the report around it');
  assert.ok(js.includes(String.fromCharCode(92) + 'u2713'), 'the tick is an escape in the emitted script, not a raw character');
});

test('the report script no longer carries the clear-a-gate handler for rows it does not have', () => {
  const js = emitted('JS');
  assert.doesNotMatch(js, /\.rej-clear/);
  assert.doesNotMatch(js, /\/api\/review/);
  assert.doesNotThrow(() => new Function(js));
});

test('the rejection page loads that script and not the report one', () => {
  const html = buildRejectionsPage({ rejected: many, profile });
  assert.match(html, /clearing a reviewed gate/);
  assert.doesNotMatch(html, /syncQueue/);
  assert.doesNotMatch(html, /sections ----/);
});
