/**
 * ONE LOG for the terminal and the app.
 *
 * The app showed `data/daemon.log`, which only the app wrote, so a `search` typed in a
 * terminal left no trace in the Log tab and an action taken in the window left none
 * anywhere. Both now append to the same file, and the Log tab reads it.
 *
 *   - A command keeps printing to the console AND appends here (`tee`), line by line as
 *     it happens, so the tab can follow a terminal scan live.
 *   - What the app does itself — a mark, a scan it starts, a setting — goes through the
 *     same `console.log`, which the app has no console for, so it lands in the file only.
 *
 * Colour codes are kept in the file: the CV diff the tailor prints is unreadable without
 * them, and the Log tab turns them back into colour. A plain-text viewer shows them as noise.
 *
 * The scan the APP starts runs as a child process whose output the app already captures
 * and shows live (`runner.scrollback`); the runner sets JOBHUNT_NO_LOGFILE for it so the
 * same lines are not written twice.
 */
import { appendFileSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { AsyncLocalStorage } from 'node:async_hooks';
import { p } from './util.js';

/**
 * What a line is ABOUT, so the Log tab can group them: `scan` (fetching and judging),
 * `app` (starting, state, the connection), `tailor` (generating documents) and `action`
 * (something you did on the page or at the prompt). A tag follows the work rather than
 * the process — a mark and a tailor both run inside the app's server — so it is carried
 * with the request (`withTag`) instead of being guessed from the text.
 */
const scope = new AsyncLocalStorage();
export const withTag = (tag, fn) => scope.run(tag, fn);

export const MAX_LOG_BYTES = 512 * 1024;
const stripAnsi = (s) => s.replace(/\u001B\[[0-9;]*m/g, '');

export const logFile = () => process.env.JOBHUNT_LOG_FILE || p('data', 'daemon.log');

/** Append `text` — one timestamped line per non-empty line of it. Never throws. */
export function append(text, tag = '') {
  const stamp = new Date().toISOString();
  const lines = String(text).split(/\r?\n/).map((l) => l.trimEnd()).filter(Boolean);
  if (!lines.length) return;
  const t = scope.getStore() || tag;
  const out = lines.map((l) => `${stamp} ${t ? `[${t}] ` : ''}${l}\n`).join('');
  try {
    const file = logFile();
    if (existsSync(file) && statSync(file).size > MAX_LOG_BYTES) {
      writeFileSync(file, readFileSync(file, 'utf8').slice(-MAX_LOG_BYTES / 2));
    }
    appendFileSync(file, out);
  } catch {
    // A log that cannot be written must not stop a scan.
  }
}

/**
 * Make console output also reach the log. Idempotent, and off when JOBHUNT_NO_LOGFILE is set.
 * The console still prints; only the file is added.
 */
let teed = false;
export function tee(tag) {
  if (teed || process.env.JOBHUNT_NO_LOGFILE) return false;
  teed = true;
  for (const method of ['log', 'warn', 'error']) {
    const original = console[method].bind(console);
    console[method] = (...args) => {
      original(...args);
      append(args.map((a) => (typeof a === 'string' ? a : String(a?.stack || a))).join(' '), tag);
    };
  }
  return true;
}
