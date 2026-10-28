/**
 * One search at a time, across processes.
 *
 * runner.js already refuses a second run, but only inside the process that holds
 * it. The tray app is a second process beside `npm run daily` in a terminal, and
 * two searches at once each load seen.json at the start and write it at the end —
 * the later writer silently discards the other's finds and any job you marked
 * applied in between. A lock file in data/ is the one thing both can see.
 *
 * A lock left behind by a crash is not a lock: the pid is checked, so a dead
 * process never blocks anyone. (A pid Windows has since handed to something else
 * does, until that program exits — the message says which file to delete.)
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { p } from './util.js';

// The override exists so a test never holds the real lock while a real search might want it.
const FILE = () => process.env.JOBHUNT_LOCK_FILE || p('data', 'search.lock');

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
};

/** The pid of a live process holding the lock, or null. */
export function holder() {
  if (!existsSync(FILE())) return null;
  try {
    const { pid } = JSON.parse(readFileSync(FILE(), 'utf8'));
    return Number.isInteger(pid) && alive(pid) ? pid : null;
  } catch {
    return null;
  }
}

/** Take the lock. Returns a release function, or null if a live search holds it. */
export function acquire() {
  const file = FILE();
  mkdirSync(dirname(file), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      // `wx` fails if the file exists, so two searches starting together cannot both win.
      writeFileSync(file, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }), { flag: 'wx' });
      return () => {
        try { unlinkSync(file); } catch { /* already gone */ }
      };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      if (holder()) return null;
      try { unlinkSync(file); } catch { /* someone else cleared it first */ }
    }
  }
  return null;
}
