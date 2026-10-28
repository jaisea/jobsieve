import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { p, ROOT, readJson, writeJson } from './util.js';

/**
 * What the tool remembers about the job-alert mailbox between scans.
 *
 * The mail source used to ask for "everything from the last 7 days" every 30 minutes, which
 * is 48 downloads, parses and rule evaluations a day of the same few hundred messages: 73% of
 * everything that reached phase 2.1. A mail does not change after it arrives, so it only
 * needs reading once.
 *
 * The bookmark is a UID, not a time. A UID is the number the server stamps on a message when
 * it arrives in a folder: it only goes up and is never reused (while UIDVALIDITY stays the
 * same), so "everything above UID n" is exact. A "last run" time is not: IMAP SINCE has day
 * granularity in the server's time zone, a mail can arrive late, and a mail you label into
 * the folder by hand days after it arrived gets a new, higher UID but keeps its old date.
 *
 * Three things send the source back to reading the whole window, and each is a thing that
 * would otherwise leave old mail judged under old assumptions:
 *   - no bookmark yet (first run, or the file was deleted);
 *   - UIDVALIDITY changed: the server renumbered the folder, so every stored UID is
 *     meaningless;
 *   - the RULES VERSION changed: a hash of every source file and the profile. A parser fix
 *     reaches mail already read, and a gate edit is applied to it, exactly as it was when
 *     every scan re-read the window. It errs toward re-reading: any edit under src/ costs one
 *     window read, which is what every scan used to cost.
 *
 * Nothing here ever writes to the mailbox. Marking mail as read was rejected: it writes to
 * your account, and a mail you open yourself first would be skipped without a trace.
 */
const FILE = () => p('data', 'mail-state.json');

export const emptyState = () => ({ version: 1, mailboxes: {} });

export function load() {
  if (!existsSync(FILE())) return emptyState();
  const s = readJson(FILE(), null);
  return s && typeof s === 'object' && s.mailboxes ? { ...emptyState(), ...s } : emptyState();
}

export const save = (state) => writeJson(FILE(), { ...state, savedAt: new Date().toISOString() });

/** One bookmark per account and folder: pointing IMAP_FOLDER elsewhere must not reuse another folder's UIDs. */
export const keyFor = ({ host, user, folder }) => `${host}|${user}|${folder}`.toLowerCase();

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const f = join(dir, e.name);
    if (e.isDirectory()) walk(f, out);
    else if (e.name.endsWith('.js')) out.push(f);
  }
  return out;
}

let memo = null;

/**
 * A fingerprint of everything that decides how a mail posting is read and judged.
 *
 * All of src/ rather than a list of the gate files, because a hand-kept list is the thing
 * that drifts: a new module gets added and nobody adds it here. Hashing too much costs an
 * extra window read; hashing too little leaves mail judged by rules that no longer exist.
 * `config/sources.json` is deliberately not included — the UI rewrites it whenever a source
 * is toggled, and that does not change how mail is judged.
 */
export function rulesVersion({ srcDir = join(ROOT, 'src'), profileFile = null } = {}) {
  const cacheable = srcDir === join(ROOT, 'src') && profileFile === null;
  if (cacheable && memo) return memo;

  const h = createHash('sha1');
  for (const f of walk(srcDir)) {
    h.update(f.slice(srcDir.length));
    h.update(readFileSync(f));
  }
  const profile = profileFile
    || [process.env.JOBHUNT_PROFILE || p('config', 'profile.json'), p('config', 'profile.example.json')].find((f) => existsSync(f));
  if (profile && existsSync(profile)) h.update(readFileSync(profile));

  const v = h.digest('hex').slice(0, 16);
  if (cacheable) memo = v;
  return v;
}

/**
 * Read only what is new, or read the whole window — and say why.
 *
 * `uidValidity` is compared as a string: imapflow hands it back as a BigInt, and the file
 * stores it as text, so `1n !== '1'` would otherwise re-read everything on every scan.
 */
export function decide(entry, { uidValidity, rules }) {
  if (!entry) return { mode: 'full', why: 'first read of this folder' };
  if (String(entry.uidValidity) !== String(uidValidity)) {
    return { mode: 'full', why: 'the server renumbered the folder (UIDVALIDITY changed)' };
  }
  if (entry.rulesVersion !== rules) {
    return { mode: 'full', why: 'the parser, the rules or the profile changed since these mails were read' };
  }
  if (!Number.isInteger(entry.lastUid) || entry.lastUid < 1) return { mode: 'full', why: 'no bookmark recorded' };
  return { mode: 'delta', after: entry.lastUid };
}

export function remember(state, key, { uidValidity, lastUid, rules, now = new Date() }) {
  state.mailboxes = {
    ...state.mailboxes,
    [key]: { uidValidity: String(uidValidity), lastUid, rulesVersion: rules, updatedAt: now.toISOString() },
  };
  return state;
}
