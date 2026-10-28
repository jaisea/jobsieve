import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

/**
 * RUNNING A COMMAND FROM THE WEB APP.
 *
 * The server could not start anything. It read a pre-built page off disk and
 * served it, so every action that actually costs something — fetching the
 * sources, re-judging them, rebuilding the page — was a terminal command, and
 * the page you were looking at showed whatever had been true when that command
 * last ran.
 *
 * **A CHILD PROCESS, not an in-process call, and that is the whole design.**
 * Teeing the logger and calling `search()` directly was the first plan and it
 * is worse in three ways that matter here:
 *
 *   - `search()` reads `process.argv` through `has()`. Calling it in-process
 *     means either refactoring a four-hundred-line function or mutating argv
 *     underneath a running server.
 *   - A run that throws would take the server down with it, losing the very
 *     output that says what went wrong.
 *   - Every flag already works. `--dry-run`, `--replay`, `--no-enrich` and
 *     `--verbose` come free, because they are the same command line a person
 *     would type.
 *
 * The cost is that progress arrives as TEXT rather than as structured events.
 * That is acceptable: the pipeline already prints a heading for each phase and
 * a computed ETA for the three long steps, which is exactly what a progress
 * view needs to show.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, 'index.js');

/**
 * What the UI may start, and the exact argv for each.
 *
 * An ALLOWLIST keyed by name, never a command string assembled from the
 * request. The server binds to localhost, which makes a crafted body hard to
 * reach rather than harmless — and "hard to reach" is not the standard for
 * handing a string to a process spawner.
 *
 * `spends` drives the confirmation step: a real search costs API quota against
 * monthly free tiers, and a button that silently spends a month's JSearch
 * allowance is the same mistake `--dry-run` was made to prevent.
 */
export const RUNS = {
  search: {
    argv: ['search'],
    label: 'Search all sources',
    spends: true,
    note: 'Fetches every enabled source and spends API quota. Around ten minutes.',
  },
  due: {
    argv: ['search', '--due-only'],
    label: 'Search the sources that are due',
    spends: true,
    note: 'Fetches only the sources whose own sleep is over. What the background app runs.',
  },
  judge: {
    argv: ['search', '--judge-queue'],
    label: 'Judge the postings waiting for the AI',
    spends: true,
    note: 'Fetches nothing. Asks the model about the postings a rate limit held back, and judges any source that was fetched but never judged.',
  },
  dry: {
    argv: ['search', '--dry-run'],
    label: 'Search without saving',
    spends: true,
    note: 'Fetches and judges but writes nothing. Metered sources are skipped, so it still costs the free daily ones.',
  },
  replay: {
    argv: ['search', '--replay'],
    label: 'Judge the last fetch again',
    spends: false,
    note: 'No network at all. The right button after changing a rule.',
  },
  report: {
    argv: ['report'],
    label: 'Rebuild the report',
    spends: false,
    note: 'Re-scores what is already on disk. No network.',
  },
};

/** How much output to keep, so a page opened mid-run can catch up. */
const SCROLLBACK = 600;

/** Colour codes, for tests; the lines keep them so the Log tab can colour the CV diff. */
const stripAnsi = (s) => s.replace(/\u001B\[[0-9;]*m/g, '');

/**
 * One run at a time, for the whole process.
 *
 * Two searches at once would interleave writes to seen.json and jobs.json and
 * race each other's quota ledger. The lock lives at module scope rather than
 * per-request for exactly that reason — it is a property of the data on disk,
 * not of one browser tab.
 */
let current = null;

export const bus = new EventEmitter();
// A page per tab, a tab per window, and nothing here is hot — but the default
// ceiling of 10 would start printing warnings at the eleventh listener.
bus.setMaxListeners(0);

export const status = () => (current
  ? {
    running: true,
    mode: current.mode,
    startedAt: current.startedAt,
    lines: current.lines.length,
  }
  : { running: false });

/** The output so far, so a page that arrives late is not staring at nothing. */
export const scrollback = () => (current ? current.lines.slice() : []);

/** The last run's outcome, kept after it finishes so a reload can still see it. */
let last = null;

/**
 * Start one. Returns `{ ok }` or `{ ok: false, error }` — never throws, and
 * never queues: a refusal you can read beats a second run you did not expect.
 */
export function start(mode, { confirmed = false } = {}) {
  const spec = RUNS[mode];
  if (!spec) return { ok: false, error: `unknown run "${mode}"` };
  if (current) return { ok: false, error: `a ${current.mode} run is already going`, running: true };
  if (spec.spends && !confirmed) {
    return { ok: false, error: 'this run spends API quota', needsConfirmation: true, note: spec.note };
  }

  const child = spawn(process.execPath, [CLI, ...spec.argv], {
    cwd: join(HERE, '..'),
    // Inside Electron, process.execPath is electron.exe, which would open a second
    // tray app instead of running the CLI. This makes it behave as plain Node.
    // The app captures this output itself, so the child must not also write it to the shared log.
    env: { ...process.env, JOBHUNT_NO_LOGFILE: '1', ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}) },
    // No shell. The argv comes from the allowlist above, and a shell would put
    // a parser between this list and the process for no benefit at all.
    shell: false,
  });

  const run = { mode, startedAt: new Date().toISOString(), lines: [], child };
  current = run;

  const push = (chunk, stream) => {
    for (const raw of String(chunk).split(/\r?\n/)) {
      const line = raw.trimEnd();
      if (!line) continue;
      const entry = { at: Date.now(), stream, line };
      run.lines.push(entry);
      if (run.lines.length > SCROLLBACK) run.lines.shift();
      bus.emit('line', entry);
    }
  };

  child.stdout.on('data', (c) => push(c, 'out'));
  child.stderr.on('data', (c) => push(c, 'err'));

  const finish = (result) => {
    if (current !== run) return;
    current = null;
    last = { mode, startedAt: run.startedAt, endedAt: new Date().toISOString(), ...result };
    bus.emit('done', last);
  };

  child.on('error', (e) => finish({ ok: false, error: e.message }));
  child.on('close', (code) => finish({ ok: code === 0, code }));

  return { ok: true, mode, startedAt: run.startedAt, spends: spec.spends };
}

/**
 * Stop the run in progress.
 *
 * SIGTERM rather than SIGKILL: the pipeline writes seen.json and jobs.json at
 * the end of a run, and killing it outright mid-write is the one way to
 * corrupt the memory that stops a job being shown twice. On Windows there is
 * no real SIGTERM, so this is a hard stop there whatever we ask for — which is
 * a reason to stop a run rarely, not a reason to offer no button.
 */
export function stop() {
  if (!current) return { ok: false, error: 'nothing is running' };
  current.child.kill('SIGTERM');
  return { ok: true, mode: current.mode };
}

export const __testables = { stripAnsi, SCROLLBACK, CLI };
