/**
 * The log, for the page's Log tab.
 *
 * A tray app has no terminal, so what a scan did used to be a file you opened in
 * Notepad. This serves the same file — plus the live output of a scan that is
 * running right now, which is the part nothing else shows — as a page that
 * refreshes itself. It lives beside the report rather than in the Electron shell
 * so `npm run serve` gets it too.
 */
import { existsSync, readFileSync } from 'node:fs';
import { logFile } from './applog.js';

const FILE = logFile;

/** The last `n` lines of `text`. */
export function tail(text, n) {
  const lines = String(text).split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines.slice(-n).join('\n');
}

export function readLog(n = 300) {
  return existsSync(FILE()) ? tail(readFileSync(FILE(), 'utf8'), n) : '';
}

/**
 * What the page shows: the file, then — only while a scan is running — its output so far,
 * already stamped and tagged `scan` by the caller so it groups with the rest. The file
 * is appended when a run FINISHES, so without the second part a scan that takes ten
 * minutes would show nothing for ten minutes.
 */
export function compose(fileText, { running = false } = {}, liveLines = []) {
  const parts = [fileText || '(nothing logged yet)'];
  if (running && liveLines.length) parts.push(liveLines.join('\n'));
  return parts.join('\n');
}

/** Served at / while there is no report yet, and reloads itself until there is. */
export const NO_REPORT_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>jobsieve</title>
<meta http-equiv="refresh" content="10">
<style>
:root{--bg:#fff;--ink:#1c1f24;--dim:#6b7280}
@media (prefers-color-scheme:dark){:root{--bg:#14161a;--ink:#e6e8eb;--dim:#9aa1ab}}
body{margin:0;height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--ink);font:15px/1.6 system-ui,sans-serif;text-align:center}
small{color:var(--dim)}
</style></head>
<body><div><h2>No report yet</h2>
<p>The first scan is building one — this page refreshes by itself.</p>
<small>If nothing happens, look at the log (Ctrl+L).</small></div></body></html>`;
