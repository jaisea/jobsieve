/**
 * What the tray menu can do, on the page as well.
 *
 * Scan now, pause, start with Windows and quit used to exist only in the tray menu. The
 * page asks the app to do them through a small API that exists only when the app is the
 * thing serving — under `npm run serve` there is no scanner or login item to control —
 * and every write is checked to have come from the page itself, because any website
 * open in the browser can POST to a local port.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { readFileSync } from 'node:fs';

import { p } from '../src/util.js';
import { serve } from '../src/serve.js';
import { REJECT_CATEGORIES, PICKER_GROUPS } from '../src/filter.js';

const main = readFileSync(p('src', 'electron', 'main.js'), 'utf8');

/** The same string the <script> tag gets, with its interpolations resolved. */
function emittedScript() {
  const src = readFileSync(p('src', 'report.js'), 'utf8');
  const open = 'const JS = `';
  const from = src.indexOf(open);
  const to = src.indexOf('\n`;', from);
  return new Function('REJECT_CATEGORIES', 'PICKER_GROUPS', 'return `' + src.slice(from + open.length, to + 1) + '`;')(
    REJECT_CATEGORIES, PICKER_GROUPS);
}

const freePort = () => new Promise((resolve) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

/** Run a real server on a spare port, with the given app controls (or none). */
async function withServer(controls, fn) {
  const port = await freePort();
  const server = await serve({ port, open: false, controls });
  if (!server.listening) await new Promise((r) => server.once('listening', r));
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
  }
}

/** Stand-in controls that record what they were asked to do. */
function stubControls(over = {}) {
  const calls = [];
  return {
    calls,
    status: () => ({ scanning: false, mode: null, scanText: 'Last scan 12:00 — 3 new', nextText: 'Next fetch about 12:30', paused: false, offline: false, startWithWindows: false }),
    scanNow: async () => { calls.push('scan'); return { ok: true }; },
    setPaused: (v) => calls.push(['pause', v]),
    setStartWithWindows: (v) => calls.push(['login', v]),
    quit: () => calls.push('quit'),
    ...over,
  };
}

const post = (base, path, body, headers = {}) => fetch(base + path, {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body ?? {}),
});

/* ------------------------------------------------------------ the API */

test('without the app there are no controls, and the page is told so', async () => {
  await withServer(null, async (base) => {
    assert.deepEqual(await (await fetch(`${base}/api/app`)).json(), { available: false });
    const r = await post(base, '/api/app/scan');
    assert.equal(r.status, 404, 'a plain `npm run serve` has no scanner to start');
  });
});

test('with the app, the status is what the tray shows', async () => {
  const c = stubControls();
  await withServer(c, async (base) => {
    const s = await (await fetch(`${base}/api/app`)).json();
    assert.equal(s.available, true);
    assert.equal(s.scanText, 'Last scan 12:00 — 3 new');
    assert.equal(s.nextText, 'Next fetch about 12:30');
    assert.equal(s.paused, false);
  });
});

test('scan now starts a scan, and a refusal comes back as a reason, not a failure of the page', async () => {
  const ok = stubControls();
  await withServer(ok, async (base) => {
    const r = await post(base, '/api/app/scan');
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.ok, true);
    assert.equal(body.scanText, 'Last scan 12:00 — 3 new', 'the reply carries the new status, so the page repaints at once');
    assert.deepEqual(ok.calls, ['scan']);
  });

  const offline = stubControls({ scanNow: async () => ({ ok: false, error: 'No internet connection — try again when you are online.' }) });
  await withServer(offline, async (base) => {
    const r = await post(base, '/api/app/scan');
    assert.equal(r.status, 409, 'a refusal is not a server error');
    const body = await r.json();
    assert.equal(body.ok, false);
    assert.match(body.error, /No internet connection/);
  });
});

test('pause and start-with-Windows pass the new value through, as a boolean', async () => {
  const c = stubControls();
  await withServer(c, async (base) => {
    assert.equal((await post(base, '/api/app/pause', { paused: true })).status, 200);
    assert.equal((await post(base, '/api/app/pause', { paused: false })).status, 200);
    assert.equal((await post(base, '/api/app/login', { enabled: true })).status, 200);
    assert.deepEqual(c.calls, [['pause', true], ['pause', false], ['login', true]]);
  });
});

test('quit answers first and quits a moment later, so the reply is not lost with the process', async () => {
  const c = stubControls();
  await withServer(c, async (base) => {
    const r = await post(base, '/api/app/quit');
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { ok: true });
    assert.deepEqual(c.calls, [], 'it has not quit yet when the answer arrives');
    await new Promise((res) => setTimeout(res, 450));
    assert.deepEqual(c.calls, ['quit']);
  });
});

test('an unknown control is refused', async () => {
  await withServer(stubControls(), async (base) => {
    assert.equal((await post(base, '/api/app/self-destruct')).status, 404);
  });
});

/* ------------------------------------------------------------ another website cannot drive it */

test('a write from another website is refused before it reaches any control', async () => {
  const c = stubControls();
  await withServer(c, async (base) => {
    for (const origin of ['https://evil.example', 'http://evil.example:80', 'null']) {
      for (const path of ['/api/app/quit', '/api/app/scan', '/api/app/pause']) {
        const r = await post(base, path, { paused: true }, { Origin: origin });
        assert.equal(r.status, 403, `${origin} -> ${path}`);
      }
    }
    assert.deepEqual(c.calls, [], 'not one control was reached');
  });
});

test('the page itself, and a script with no Origin, may write', async () => {
  const c = stubControls();
  await withServer(c, async (base) => {
    assert.equal((await post(base, '/api/app/pause', { paused: true }, { Origin: base })).status, 200, 'the page');
    assert.equal((await post(base, '/api/app/pause', { paused: false })).status, 200, 'curl');
    assert.deepEqual(c.calls, [['pause', true], ['pause', false]]);
  });
});

test('the same guard covers the older endpoints too', async () => {
  await withServer(null, async (base) => {
    const r = await post(base, '/api/mark', { id: 'abc', status: 'applied' }, { Origin: 'https://evil.example' });
    assert.equal(r.status, 403, 'a website could otherwise mark jobs applied');
  });
});

test('the log is served for the Log tab: text plus whether a scan is running', async () => {
  await withServer(null, async (base) => {
    const d = await (await fetch(`${base}/api/log`)).json();
    assert.equal(typeof d.text, 'string');
    assert.equal(typeof d.running, 'boolean');
    assert.ok('mode' in d);
  });
});

/* ------------------------------------------------------------ the app shell */

test('the tray menu and the page use one set of controls', () => {
  const block = main.slice(main.indexOf('const controls = {'), main.indexOf('function buildMenu'));
  for (const member of ['status:', 'scanNow,', 'setPaused:', 'setStartWithWindows:', 'quit:']) {
    assert.ok(block.includes(member), `controls has ${member}`);
  }
  const menu = main.slice(main.indexOf('function buildMenu'), main.indexOf('function refresh()'));
  assert.match(menu, /controls\.scanNow\(\)/);
  assert.match(menu, /controls\.setPaused\(item\.checked\)/);
  assert.match(menu, /controls\.setStartWithWindows\(item\.checked\)/);
  assert.match(menu, /click: controls\.quit/);
  assert.match(main, /serve\(\{ port: cfg\.port, open: false, onChange: \(\) => refresh\(\), controls \}\)/);
});

test('scan now answers with a result instead of toasting, so each caller can say it its own way', () => {
  const fn = main.slice(main.indexOf('async function scanNow()'), main.indexOf('function planTick'));
  assert.match(fn, /return \{ ok: false, error: 'No internet connection/);
  assert.match(fn, /return r\.ok \? \{ ok: true \} : \{ ok: false, error: r\.error \};/);
  assert.doesNotMatch(fn, /toast\(/);
  assert.match(main, /const r = await controls\.scanNow\(\);\s*if \(!r\.ok\) toast\(r\.error\);/, 'the tray toasts a refusal');
});

test('the log opens as a tab of the main window, not a window of its own', () => {
  const fn = main.slice(main.indexOf('async function showLogs()'), main.indexOf('function reloadReport'));
  assert.match(fn, /await showWindow\(\);/);
  assert.match(fn, /location\.hash = '#log'/);
  assert.match(fn, /did-finish-load/, 'a window only just created is still loading the page that owns the tab');
  assert.doesNotMatch(fn, /new BrowserWindow/);
});

/* ------------------------------------------------------------ the page */

/** Stand-in elements, recording what the page does to them. */
const el = () => ({ hidden: false, disabled: false, checked: false, textContent: '' });

function paintAppWith(state) {
  const js = emittedScript();
  const src = `var appState;\n${js.slice(js.indexOf('var paintApp = function'), js.indexOf('var loadApp = function'))}\nreturn paintApp;`;
  const els = { appbar: el(), setbox: el(), scanBtn: el(), pauseBtn: el(), loginBox: el(), scan: el(), next: el() };
  const document = { getElementById: (id) => ({ 'app-scan': els.scan, 'app-next': els.next })[id] };
  const paint = new Function('appbar', 'setbox', 'scanBtn', 'pauseBtn', 'loginBox', 'document', src)(
    els.appbar, els.setbox, els.scanBtn, els.pauseBtn, els.loginBox, document);
  paint(state);
  return els;
}

test('the controls stay hidden when the page is not being served by the app', () => {
  const els = paintAppWith({ available: false });
  assert.equal(els.appbar.hidden, true);
  assert.equal(els.setbox.hidden, true);
});

test('the control bar shows the app\'s own words, and each button reflects the state', () => {
  const els = paintAppWith({ available: true, scanning: false, paused: false, scanText: 'Last scan 12:00 — 3 new', nextText: 'Next fetch about 12:30', startWithWindows: true });
  assert.equal(els.appbar.hidden, false);
  assert.equal(els.setbox.hidden, false);
  assert.equal(els.scan.textContent, 'Last scan 12:00 — 3 new');
  assert.equal(els.next.textContent, 'Next fetch about 12:30');
  assert.equal(els.scanBtn.disabled, false);
  assert.equal(els.pauseBtn.textContent, 'Pause scanning');
  assert.equal(els.loginBox.checked, true);
});

test('while a scan runs the button is disabled, and a paused app offers to resume', () => {
  assert.equal(paintAppWith({ available: true, scanning: true, scanText: 'Scanning… (due)', nextText: '' }).scanBtn.disabled, true);
  assert.equal(paintAppWith({ available: true, paused: true, scanText: '', nextText: 'Scanning is paused' }).pauseBtn.textContent, 'Resume scanning');
});

test('quitting asks first, and the page polls the status and the log only when it matters', () => {
  const js = emittedScript();
  assert.match(js, /if \(!window\.confirm\('Quit Job Hunt\?/);
  assert.match(js, /setInterval\(function\(\)\{ if \(!document\.hidden\) loadApp\(\); \}, 5000\);/);
  assert.match(js, /setInterval\(function\(\)\{ if \(!document\.hidden && document\.body\.dataset\.tab === 'log'\) loadLog\(\); \}, 2000\);/);
  assert.match(js, /if \(d\.text === lastLog\) return;/, 'an unchanged log is not rewritten, which would scroll the page');
  assert.match(js, /logtext\.innerHTML = logHtml\(d\.text\);/, 'markup only through the grouping function, which escapes first');
  assert.doesNotMatch(js, /logtext\.innerHTML = d\.text/);
});

test('the log groups runs of lines by what they are about, and files old or unknown tags sensibly', () => {
  const js = emittedScript();
  const start = js.indexOf('var ansiHtml = ');
  const end = js.indexOf("\n    document.querySelectorAll('#logbar", start);
  const logHtml = new Function(js.slice(start, end) + '; return logHtml;')();
  const html = logHtml([
    '2026-10-01T10:00:00.000Z [app] started',
    '2026-10-01T10:01:00.000Z [scan] due started',
    '2026-10-01T10:01:01.000Z [scan] <b>Adzuna</b>',
    'a continuation with no stamp',
    '2026-10-01T10:02:00.000Z [search] typed in a terminal before tags existed',
    '2026-10-01T10:03:00.000Z [tailor] writing',
    '2026-10-01T10:04:00.000Z [action] marked',
  ].join('\n'));
  const heads = [...html.matchAll(/class="lg lg-(\w+)"/g)].map((m) => m[1]);
  assert.deepEqual(heads, ['app', 'scan', 'tailor', 'action'],
    'a legacy [search] line joins the scan block, and the unstamped line stays with the block before it');
  assert.match(html, /&lt;b&gt;Adzuna&lt;\/b&gt;/, 'text is escaped');
  assert.match(html, /a continuation with no stamp/);
});

test('the log turns colour codes into spans, and still escapes what a job board wrote', () => {
  const js = emittedScript();
  const start = js.indexOf('var ansiHtml = ');
  const end = js.indexOf('\n    };\n', start) + 7;
  const ansiHtml = new Function(js.slice(start, end) + '; return ansiHtml;')();
  const ESC = String.fromCharCode(27);
  assert.equal(ansiHtml(ESC + '[31m' + ESC + '[1mcut' + ESC + '[0m kept'), '<span class="a31 a1">cut</span> kept');
  assert.equal(ansiHtml('<img src=x onerror=alert(1)> & ' + ESC + '[32madded' + ESC + '[0m'),
    '&lt;img src=x onerror=alert(1)&gt; &amp; <span class="a32">added</span>');
  assert.equal(ansiHtml(ESC + '[32munclosed'), '<span class="a32">unclosed</span>');
});

test('every reply to a control repaints from the status it carries', () => {
  const js = emittedScript();
  assert.match(js, /var applyReply = function\(res\)\{ paintApp\(Object\.assign\(\{ available: true \}, res\)\); \};/);
  assert.match(js, /post\('\/api\/app\/pause', \{ paused: !appState\.paused \}\)\s*\.then\(applyReply\)/);
});
