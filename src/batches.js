import { existsSync } from 'node:fs';
import { p, readJson, writeJson } from './util.js';

/**
 * Which sources have been fetched but not yet judged and saved.
 *
 * A scan has two halves that no longer run in step: a source is FETCHED (a request
 * that costs quota and cannot be repeated for free) and later JUDGED and SAVED.
 * Between the two the postings exist only in memory, and a scan cut off there —
 * the app quit, the laptop shut — used to throw them away and, because the source
 * had not been committed, fetch them all again.
 *
 * So the fetch is made durable first. The postings go into the replay snapshot
 * (`fetched.json`, which already holds each source's latest slice), and this file
 * records that the slice is OWED a judging. The source is then allowed to sleep:
 * what it returned is safe. The marker is cleared only after the batch has been
 * saved to memory, as the very last step, and a scan that starts with markers
 * outstanding judges those slices before it fetches anything.
 *
 * The marker is per SOURCE because the snapshot is: a newer fetch of the same
 * source replaces both its slice and its marker, and the batch it supersedes is
 * not judged separately.
 *
 * This is separate from `awaiting.js`, which is about individual postings the
 * MODEL has not answered. A batch can be owed with nothing waiting for the model
 * (the scan died before judging) and the model can leave postings waiting from a
 * batch that is fully saved. Different questions, two files.
 */
const FILE = () => p('data', 'batches.json');

/** After this many failed resumes a batch is left alone and reported, not retried for ever. */
export const MAX_ATTEMPTS = 3;

export const empty = () => ({ version: 1, owed: {} });

export function load() {
  if (!existsSync(FILE())) return empty();
  const d = readJson(FILE(), null);
  return d && typeof d === 'object' && d.owed ? { ...empty(), ...d } : empty();
}

export const save = (state) => writeJson(FILE(), { ...state, savedAt: new Date().toISOString() });

/** A source's slice is on disk and owed a judging. Replaces any marker it already had. */
export function owe(state, key, { label, count, now = new Date() }) {
  state.owed[key] = { label, count, fetchedAt: now.toISOString(), attempts: 0 };
  return state;
}

/** The batch is judged and saved. */
export function settled(state, key) {
  delete state.owed[key];
  return state;
}

/** One resume was tried (and not yet known to have worked). */
export function tried(state, key) {
  if (state.owed[key]) state.owed[key].attempts = (state.owed[key].attempts || 0) + 1;
  return state;
}

export const stuck = (entry) => (entry?.attempts || 0) >= MAX_ATTEMPTS;

/** Oldest fetch first: the one that has waited longest is judged first. */
export function list(state) {
  return Object.entries(state.owed)
    .map(([key, e]) => ({ key, ...e }))
    .sort((a, b) => new Date(a.fetchedAt) - new Date(b.fetchedAt));
}

export const size = (state) => Object.keys(state.owed).length;

/** The postings of one source, from the snapshot. Null when the slice is gone. */
export function sliceOf(snapshot, key) {
  const range = snapshot?.ranges?.[key];
  if (!range || !Array.isArray(snapshot.jobs)) return null;
  return snapshot.jobs.slice(range[0], range[1]);
}
