/**
 * The report and the log inside the app, and only external links in the browser.
 *
 * The window loads the local report server. Everything that is not that address
 * is a job posting, a company page or a source — it belongs in the browser where
 * the logins are — and anything that is not a web address at all is refused,
 * because the report is built from text that job boards wrote.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';

import { p } from '../src/util.js';
import { classify } from '../src/electron/links.js';
import { tail, compose, NO_REPORT_PAGE } from '../src/logview.js';
import { badgePng } from '../src/electron/badge.js';

const PORT = 8787;

/* ------------------------------------------------------------ which links load where */

test('only the local report server loads inside the app', () => {
  assert.equal(classify(`http://127.0.0.1:${PORT}/`, PORT), 'internal');
  assert.equal(classify(`http://127.0.0.1:${PORT}/logs`, PORT), 'internal');
  assert.equal(classify(`http://127.0.0.1:${PORT}/?x=1#top`, PORT), 'internal');
});

test('every posting and company link goes to the browser', () => {
  assert.equal(classify('https://www.linkedin.com/jobs/view/123', PORT), 'external');
  assert.equal(classify('http://example.com/apply', PORT), 'external');
  assert.equal(classify('https://boards.greenhouse.io/x/jobs/1', PORT), 'external');
});

test('a look-alike address is external, not internal', () => {
  // Each of these would pass a sloppy "starts with" or "contains" test.
  // Not even a valid URL, so it is refused outright — safer than handing it to the browser.
  assert.equal(classify(`http://127.0.0.1:${PORT}.evil.test/`, PORT), 'blocked');
  assert.equal(classify(`http://127.0.0.1:${PORT + 1}/`, PORT), 'external', 'another port is another program');
  assert.equal(classify(`http://localhost:${PORT}/`, PORT), 'external', 'only the exact address is trusted');
  assert.equal(classify(`https://127.0.0.1:${PORT}/`, PORT), 'external');
  assert.equal(classify(`http://user@evil.test:${PORT}/`, PORT), 'external');
});

test('anything that is not a web address is refused', () => {
  for (const url of ['file:///etc/hosts', 'javascript:void(0)', 'data:text/plain,hello',
    'custom-app://anything', 'mailto:a@b.c', 'not a url', '']) {
    assert.equal(classify(url, PORT), 'blocked', url);
  }
});

/* ------------------------------------------------------------ the window itself */

const main = readFileSync(p('src', 'electron', 'main.js'), 'utf8');

test('windows are locked down: no node, isolated, sandboxed, no permissions', () => {
  assert.match(main, /contextIsolation: true, nodeIntegration: false, sandbox: true/);
  assert.match(main, /setPermissionRequestHandler\(\(_wc, _perm, done\) => done\(false\)\)/);
  assert.doesNotMatch(main, /nodeIntegration: true|contextIsolation: false|webSecurity: false/);
});

test('the window routes its links through the guard', () => {
  assert.match(main, /guard\(w\);/, 'the report window');
  assert.doesNotMatch(main, /logWin/, 'there is no second window: the log is a tab of this one');
  const guard = main.slice(main.indexOf('function guard(w)'), main.indexOf('const appIcon'));
  assert.match(guard, /setWindowOpenHandler/, 'target="_blank" links');
  assert.match(guard, /will-navigate/, 'and ordinary clicks');
  assert.match(guard, /if \(kind === 'external'\) shell\.openExternal\(url\)/);
  assert.match(guard, /return \{ action: 'deny' \}/, 'a new window is never opened');
  assert.equal((guard.match(/shell\.openExternal/g) || []).length, 2, 'and only the browser is ever launched');
});

test('closing the window hides it to the tray, and only Quit ends the app', () => {
  assert.match(main, /w\.on\('close', \(ev\) => \{\s*if \(quitting\) return;\s*ev\.preventDefault\(\);\s*w\.hide\(\);/);
  assert.match(main, /app\.on\('before-quit', \(\) => \{ quitting = true; \}\)/);
  // One Quit, shared by the tray menu and the page's Settings button.
  assert.match(main, /quit: \(\) => \{ quitting = true; app\.quit\(\); \}/);
  assert.match(main, /label: 'Quit', click: controls\.quit/);
});

test('the tray and the shortcut open the window, never the browser', () => {
  assert.match(main, /tray\.on\('click', showWindow\)/);
  assert.match(main, /app\.on\('second-instance', \(\) => showWindow\(\)\)/);
  assert.match(main, /n\.on\('click', showWindow\)/, 'a toast opens the app');
  // The one use of the browser is the link guard.
  assert.equal((main.match(/shell\.openExternal/g) || []).length, 2);
  assert.doesNotMatch(main, /shell\.openPath/, 'the log is a page in the app, not a file in Notepad');
});

test('Windows start hides the window; a launch by hand shows it', () => {
  assert.match(main, /const LOGIN_ARGS = \[MAIN, '--hidden'\]/);
  assert.match(main, /if \(!flags\.has\('--hidden'\)\) await showWindow\(\)/);
  // The state of the checkbox is read with the SAME args it was set with, or it never shows as ticked.
  assert.equal((main.match(/args: LOGIN_ARGS/g) || []).length, 2);
});

test('the count rides on the taskbar button too, and clears at zero', () => {
  assert.match(main, /win\.setOverlayIcon\(\s*tone === 'idle' \? null :/);
  assert.match(main, /win\.setTitle\(`Job Hunt — /);
});

test('the taskbar badge is a red circle, like a messaging app\'s unread count', () => {
  assert.match(main, /badgePng\(label, \{ tone: 'alert', shape: 'circle' \}\)/);
});

/** Decode a badge to rows of [r, g, b, a]. */
function pixels(png) {
  const size = png.readUInt32BE(16);
  const raw = inflateSync(png.subarray(41, 41 + png.readUInt32BE(33)));
  const at = (x, y) => { const o = y * (size * 4 + 1) + 1 + x * 4; return [raw[o], raw[o + 1], raw[o + 2], raw[o + 3]]; };
  return { size, at };
}

test('a circle badge is round: the corners are clear and the middle of each edge is not', () => {
  const { size, at } = pixels(badgePng('7', { tone: 'alert', shape: 'circle' }));
  for (const [x, y] of [[0, 0], [size - 1, 0], [0, size - 1], [size - 1, size - 1]]) {
    assert.equal(at(x, y)[3], 0, `corner ${x},${y} is transparent`);
  }
  assert.equal(at(size / 2, 0)[3], 255, 'the top edge reaches the top');
  assert.equal(at(0, size / 2)[3], 255, 'and the left edge the left');
  // A rounded square, by contrast, is filled further into the corner.
  assert.equal(pixels(badgePng('7', { tone: 'alert' })).at(3, 3)[3], 255);
  assert.equal(at(3, 3)[3], 0, 'the same point is outside the circle');
});

test('both digits of a two-digit badge stay inside the circle', () => {
  // At the square badge's size the outer corners of "88" would poke out of the
  // round edge; drawn smaller, every white pixel must be on the badge.
  const { size, at } = pixels(badgePng('88', { tone: 'alert', shape: 'circle' }));
  let white = 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = at(x, y);
      if (r === 255 && g === 255 && b === 255) {
        white++;
        assert.equal(a, 255, `white pixel ${x},${y} is on the badge`);
      }
    }
  }
  assert.ok(white > 20, 'and the digits are drawn');
});

test('the taskbar badge is red and differs from the tray icon', () => {
  const { at } = pixels(badgePng('3', { tone: 'alert', shape: 'circle' }));
  assert.deepEqual(at(3, 16).slice(0, 3), [229, 57, 53]);
  assert.notEqual(badgePng('3', { tone: 'alert', shape: 'circle' }).toString('hex'), badgePng('3', { tone: 'open' }).toString('hex'));
});

test('a scan never reloads the page under you; it asks the page to sync itself', () => {
  // The page matches its cards to the data without reloading, so a half-chosen
  // reason or a typed filter survives. That made the old "press F5" hint wrong.
  const fn = main.slice(main.indexOf('function refreshWindow()'), main.indexOf('function buildAppMenu'));
  assert.match(fn, /executeJavaScript\('window\.__refresh && window\.__refresh\(\)'\)/);
  assert.doesNotMatch(fn, /reload\(|reloadReport/, 'and it does not reload');
  // Code only: the comment above refreshWindow explains the removed hint, and should.
  const code = main.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(code, /press F5|stale/, 'no hint about reloading remains');
  assert.match(main, /ensureServer\(\)\.then\(refreshWindow\)/);
});

/* ------------------------------------------------------------ the log page */

test('tail keeps the last n lines and ignores a trailing newline', () => {
  assert.equal(tail('a\nb\nc\nd\n', 2), 'c\nd');
  assert.equal(tail('a\r\nb\r\n', 5), 'a\nb');
  assert.equal(tail('', 3), '');
});

test('a running scan shows its output after the file, and an idle one does not', () => {
  assert.equal(compose('old line', { running: false }), 'old line');
  const live = compose('old line', { running: true, mode: 'due' }, ['Reading adverts', 'Adzuna … 12 jobs']);
  assert.equal(live, 'old line\nReading adverts\nAdzuna … 12 jobs');
  assert.equal(compose('x', { running: true, mode: 'search' }, []), 'x');
  assert.match(compose('', { running: false }), /nothing logged yet/);
});

test('the placeholder reloads itself until there is a report', () => {
  assert.match(NO_REPORT_PAGE, /http-equiv="refresh" content="10"/);
});

test('the server serves the log, and a placeholder instead of refusing without a report', () => {
  const serve = readFileSync(p('src', 'serve.js'), 'utf8');
  assert.doesNotMatch(serve, /url\.pathname === '\/logs'/, 'the standalone log page is gone: the Log tab replaced it');
  assert.match(serve, /url\.pathname === '\/api\/log'/);
  assert.match(serve, /existsSync\(reportPath\) \? readFileSync\(reportPath\) : logview\.NO_REPORT_PAGE/);
  assert.doesNotMatch(serve, /No report yet[^\n]*\n\s*return;/, 'it no longer exits when the report is missing');
});

/* ------------------------------------------------------------ the icon */

test('the window icon spells JH and scales with its size', () => {
  const white = (size) => {
    const png = badgePng('JH', { tone: 'open', size });
    assert.equal(png.readUInt32BE(16), size);
    const pixels = inflateSync(png.subarray(41, 41 + png.readUInt32BE(33)));
    assert.equal(pixels.length, size * (size * 4 + 1));
    let n = 0;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const o = y * (size * 4 + 1) + 1 + x * 4;
        if (pixels[o] === 255 && pixels[o + 1] === 255 && pixels[o + 2] === 255) n++;
      }
    }
    return n;
  };
  assert.ok(white(32) > 0 && white(128) > 0, 'letters are drawn at both sizes');
  assert.ok(white(128) > white(32) * 10, 'and a bigger icon draws bigger letters, not the same ones in a corner');
  assert.notEqual(badgePng('JH').toString('hex'), badgePng('42').toString('hex'));
});
