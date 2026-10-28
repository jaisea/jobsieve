/**
 * The job-alert mailbox is read once per message, not 48 times a day.
 *
 * It used to ask for "the last 7 days" every 30 minutes and re-download, re-parse and
 * re-judge the same few hundred mails each time: 73% of everything that reached phase 2.1.
 * The bookmark is a UID (see mailstate.js). These run the real reader against a fake mailbox
 * that behaves like IMAP where it matters — including the quirk that "UID n:*" always returns
 * the last message even when it is below n.
 */
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DIR = mkdtempSync(join(tmpdir(), 'jobhunt-mail-'));
process.env.JOBHUNT_DATA_DIR = DIR;
process.env.IMAP_HOST = 'imap.test';
process.env.IMAP_USER = 'me@test';
process.env.IMAP_PASSWORD = 'x';
process.env.IMAP_FOLDER = 'jobsearch';
process.env.IMAP_SINCE_DAYS = '7';
after(() => rmSync(DIR, { recursive: true, force: true }));

const { fetchJobs } = await import('../src/sources/mailalerts.js');
const mailstate = await import('../src/mailstate.js');
const fetched = await import('../src/fetched.js');

/* ------------------------------------------------------------ a fake mailbox */

const linkedin = (jobId, title, date) => ({
  date: new Date(date),
  source: [
    'From: LinkedIn Job Alerts <jobalerts-noreply@linkedin.com>',
    'To: me@test',
    'Subject: Job alert',
    `Date: ${new Date(date).toUTCString()}`,
    'MIME-Version: 1.0',
    'Content-Type: text/html; charset=utf-8',
    '',
    `<table><tr><td><a href="https://www.linkedin.com/comm/jobs/view/${jobId}?trk=eml">${title}</a>`,
    '<p>Acme GmbH · München</p></td></tr></table>',
  ].join('\r\n'),
});

const stranger = (date) => ({
  date: new Date(date),
  source: ['From: news@nobody.example', 'Subject: hello', `Date: ${new Date(date).toUTCString()}`, 'Content-Type: text/plain', '', 'hi'].join('\r\n'),
});

/** An IMAP folder that keeps count of how it was used. */
function mailbox({ uidValidity = 1n, messages = [] } = {}) {
  const calls = { search: [], fetched: [] };
  const box = {
    uidValidity,
    messages,
    add(m) { const uid = Math.max(0, ...messages.map((x) => x.uid)) + 1; messages.push({ uid, ...m }); return uid; },
  };
  const client = {
    get mailbox() { return { uidValidity: box.uidValidity, uidNext: Math.max(0, ...messages.map((m) => m.uid)) + 1 }; },
    async connect() {},
    async logout() {},
    async getMailboxLock() { return { release() {} }; },
    async search(query) {
      calls.search.push(query);
      if (query.uid) {
        const n = Number(String(query.uid).split(':')[0]);
        const hit = messages.map((m) => m.uid).filter((u) => u >= n);
        // The IMAP rule for a range ending in *: the last message is ALWAYS included.
        return hit.length ? hit : [Math.max(...messages.map((m) => m.uid))];
      }
      return messages.filter((m) => m.date >= query.since).map((m) => m.uid);
    },
    async *fetch(range) {
      calls.fetched.push([...range.uid]);
      for (const m of messages) if (range.uid.includes(m.uid)) yield { uid: m.uid, source: m.source };
    },
  };
  return { box, client, calls };
}

const daysAgo = (d) => Date.now() - d * 86400000;
const read = (mb, rules = 'rules-1') => fetchJobs({ imap: () => mb.client, rules });
const bookmark = () => mailstate.load().mailboxes[mailstate.keyFor({ host: 'imap.test', user: 'me@test', folder: 'jobsearch' })];

beforeEach(() => { rmSync(join(DIR, 'mail-state.json'), { force: true }); rmSync(join(DIR, 'fetched.json'), { force: true }); });

/* ---------------------------------------------------------------- the bookmark */

test('the first read is the whole window, as it always was, and the bookmark sits at the top of the folder', async () => {
  const mb = mailbox({ messages: [
    { uid: 10, ...linkedin('1001', 'Senior DevOps Engineer', daysAgo(30)) },   // older than the window
    { uid: 11, ...linkedin('1002', 'Platform Engineer', daysAgo(2)) },
    { uid: 12, ...linkedin('1003', 'Cloud Engineer', daysAgo(1)) },
  ] });
  const r = await read(mb);
  assert.deepEqual(r.jobs.map((j) => j.title).sort(), ['Cloud Engineer', 'Platform Engineer']);
  assert.equal(r.merge, undefined, 'a full read REPLACES the stored slice');
  assert.match(r.summary, /read the last 7 days .* first read of this folder/);

  assert.equal(bookmark(), undefined, 'nothing is remembered until the batch is saved');
  r.commit();
  assert.equal(bookmark().lastUid, 12, 'the 30-day-old mail is below it: skipped on purpose, as before');
});

test('after that only NEW mail is downloaded', async () => {
  const mb = mailbox({ messages: [{ uid: 5, ...linkedin('2001', 'Platform Engineer', daysAgo(1)) }] });
  (await read(mb)).commit();

  mb.box.add(linkedin('2002', 'Site Reliability Engineer', daysAgo(0)));
  mb.calls.fetched.length = 0;
  const r = await read(mb);
  assert.deepEqual(mb.calls.fetched, [[6]], 'one message crossed the wire, not the window');
  assert.deepEqual(r.jobs.map((j) => j.title), ['Site Reliability Engineer']);
  assert.deepEqual(r.merge, { days: 7 }, 'a delta, to be folded into the replay slice');
  assert.match(r.summary, /1 new message above UID 5/);
  r.commit();
  assert.equal(bookmark().lastUid, 6);
});

test('no new mail: nothing downloaded, no jobs, and — above all — no ERRORS', async () => {
  // The loop reads "errors and no jobs" as "nothing came back": it probes the connection and
  // marks the source failed. Zero new mail is now the normal case, so it must be quiet.
  const mb = mailbox({ messages: [{ uid: 5, ...linkedin('3001', 'Platform Engineer', daysAgo(1)) }] });
  (await read(mb)).commit();
  mb.calls.fetched.length = 0;

  const r = await read(mb);
  assert.deepEqual(mb.calls.fetched, [], 'the search returned only the last message (the IMAP quirk) and it was ignored');
  assert.deepEqual(r.jobs, []);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.warnings, []);
  assert.equal(r.commit, undefined, 'and there is nothing to remember');
  assert.match(r.summary, /nothing new above UID 5/);
});

test('"UID n:*" returns the last message even when it is below n — and it is not read again', async () => {
  const mb = mailbox({ messages: [{ uid: 9, ...linkedin('3101', 'Platform Engineer', daysAgo(1)) }] });
  (await read(mb)).commit();
  mb.calls.search.length = 0;
  const r = await read(mb);
  assert.deepEqual(mb.calls.search, [{ uid: '10:*' }]);
  assert.deepEqual(r.jobs, []);
});

test('a scan that dies before the batch is saved reads the same mail again — nothing is lost', async () => {
  const mb = mailbox({ messages: [{ uid: 5, ...linkedin('4001', 'Platform Engineer', daysAgo(1)) }] });
  (await read(mb)).commit();
  mb.box.add(linkedin('4002', 'Cloud Architect', daysAgo(0)));

  const first = await read(mb);
  assert.equal(first.jobs.length, 1);
  // ...the scan dies here: commit() is never called...
  const again = await read(mb);
  assert.deepEqual(again.jobs.map((j) => j.title), ['Cloud Architect'], 'the bookmark did not move');
});

test('a mail labelled into the folder by hand, days after it arrived, is still picked up', async () => {
  // It keeps its OLD date but gets a NEW, higher UID in this folder. A date search would
  // never see it; the bookmark does.
  const mb = mailbox({ messages: [{ uid: 5, ...linkedin('5001', 'Platform Engineer', daysAgo(1)) }] });
  (await read(mb)).commit();
  mb.box.add(linkedin('5002', 'DevOps Engineer', daysAgo(20)));
  const r = await read(mb);
  assert.deepEqual(r.jobs.map((j) => j.title), ['DevOps Engineer']);
});

/* --------------------------------------------- what sends it back to the whole window */

test('the server renumbering the folder (UIDVALIDITY) means every stored UID is meaningless', async () => {
  const mb = mailbox({ uidValidity: 1n, messages: [{ uid: 5, ...linkedin('6001', 'Platform Engineer', daysAgo(1)) }] });
  (await read(mb)).commit();
  mb.box.uidValidity = 2n;
  const r = await read(mb);
  assert.match(r.summary, /UIDVALIDITY changed/);
  assert.equal(r.jobs.length, 1);
  assert.equal(r.merge, undefined);
});

test('a BigInt UIDVALIDITY is compared as text, or every scan would re-read everything', async () => {
  const mb = mailbox({ uidValidity: 123456789012n, messages: [{ uid: 5, ...linkedin('6101', 'Platform Engineer', daysAgo(1)) }] });
  (await read(mb)).commit();
  const r = await read(mb);
  assert.match(r.summary, /nothing new/);
});

test('a change to the parser, the rules or the profile re-reads the window, so old mail is judged by the new rules', async () => {
  const mb = mailbox({ messages: [{ uid: 5, ...linkedin('7001', 'Platform Engineer', daysAgo(1)) }] });
  (await read(mb, 'rules-1')).commit();

  const same = await read(mb, 'rules-1');
  assert.match(same.summary, /nothing new/);

  const changed = await read(mb, 'rules-2');
  assert.match(changed.summary, /parser, the rules or the profile changed/);
  assert.equal(changed.jobs.length, 1, 'the already-read mail is read again');
  changed.commit();
  assert.match((await read(mb, 'rules-2')).summary, /nothing new/, 'once, not for ever');
});

test('two folders keep two bookmarks', async () => {
  const a = mailbox({ messages: [{ uid: 5, ...linkedin('8001', 'Platform Engineer', daysAgo(1)) }] });
  (await read(a)).commit();
  process.env.IMAP_FOLDER = 'other';
  try {
    const r = await read(a);
    assert.match(r.summary, /first read of this folder/);
  } finally { process.env.IMAP_FOLDER = 'jobsearch'; }
});

/* ------------------------------------------------------ messages, not failures */

test('mail from a sender nobody can read is a WARNING, never an error', async () => {
  const mb = mailbox({ messages: [{ uid: 5, ...stranger(daysAgo(1)) }] });
  const r = await read(mb);
  assert.deepEqual(r.errors, [], 'an unread sender is not a failed fetch');
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /1 email\(s\) from nobody\.example were not read — no parser for that sender/);
});

test('the per-parser counts are notes, so a mail with no jobs in it is not a failure either', async () => {
  const mb = mailbox({ messages: [{ uid: 5, ...linkedin('9001', 'Platform Engineer', daysAgo(1)) }] });
  const r = await read(mb);
  assert.deepEqual(r.errors, []);
  assert.ok(r.notes.some((n) => /1 job\(s\) extracted/.test(n)));
});

/* ----------------------------------------------------------- the replay slice */

test('new mail is MERGED into the stored slice: the replay still sees the whole window', () => {
  const job = (id, days) => ({ source: 'mailalerts', sourceId: id, applyUrl: `https://x.test/${id}`, title: id, postedAt: new Date(daysAgo(days)).toISOString() });
  fetched.save([job('a', 5), job('b', 3), job('old', 20)], { ranges: { mailalerts: [0, 3] }, carry: [] });

  const merged = fetched.mergeSlice('mailalerts', [job('c', 0)], { days: 7 });
  assert.deepEqual(merged.map((j) => j.title), ['a', 'b', 'c'], 'the 20-day-old one left the window, the new one joined');
});

test('the same alert read twice (a scan that died before its bookmark moved) is one row, not two', () => {
  const job = (id, days) => ({ source: 'mailalerts', sourceId: id, applyUrl: `https://x.test/${id}`, title: id, postedAt: new Date(daysAgo(days)).toISOString() });
  const same = job('a', 1);
  fetched.save([same], { ranges: { mailalerts: [0, 1] }, carry: [] });
  assert.equal(fetched.mergeSlice('mailalerts', [{ ...same }], { days: 7 }).length, 1);
});

test('the same job in two different alerts is two rows, as it always was', () => {
  const j = (days) => ({ source: 'mailalerts', sourceId: 'job1', applyUrl: 'https://x.test/1', title: 'a', postedAt: new Date(daysAgo(days)).toISOString() });
  fetched.save([j(2)], { ranges: { mailalerts: [0, 1] }, carry: [] });
  assert.equal(fetched.mergeSlice('mailalerts', [j(0)], { days: 7 }).length, 2);
});

test('with no stored slice yet the merge is simply the new mail', () => {
  const add = [{ source: 'mailalerts', sourceId: 'z', applyUrl: 'https://x.test/z', title: 'z', postedAt: new Date().toISOString() }];
  assert.deepEqual(fetched.mergeSlice('mailalerts', add, { days: 7 }), add);
});

/* ------------------------------------------------------------ rules version */

test('the rules version changes when a source file or the profile does, and only then', () => {
  const src = join(DIR, 'fake-src');
  mkdirSync(join(src, 'sub'), { recursive: true });
  writeFileSync(join(src, 'filter.js'), 'export const a = 1;');
  writeFileSync(join(src, 'sub', 'x.js'), 'export const b = 2;');
  const profile = join(DIR, 'profile.json');
  writeFileSync(profile, '{"a":1}');
  const v = () => mailstate.rulesVersion({ srcDir: src, profileFile: profile });

  const base = v();
  assert.equal(v(), base, 'stable when nothing changed');
  writeFileSync(join(src, 'sub', 'x.js'), 'export const b = 3;');
  assert.notEqual(v(), base, 'a nested source file is covered — no hand-kept list to forget');
  const second = v();
  writeFileSync(profile, '{"a":2}');
  assert.notEqual(v(), second, 'and so is the profile');
  writeFileSync(join(src, 'README.md'), 'not code');
  assert.equal(v(), mailstate.rulesVersion({ srcDir: src, profileFile: profile }), 'a non-code file is not');
});

test('decide(): first read, renumbered folder, new rules, bad bookmark — all read the window; otherwise only what is new', () => {
  const entry = { uidValidity: '7', lastUid: 40, rulesVersion: 'r' };
  assert.equal(mailstate.decide(undefined, { uidValidity: '7', rules: 'r' }).mode, 'full');
  assert.equal(mailstate.decide(entry, { uidValidity: '8', rules: 'r' }).mode, 'full');
  assert.equal(mailstate.decide(entry, { uidValidity: '7', rules: 'q' }).mode, 'full');
  assert.equal(mailstate.decide({ ...entry, lastUid: 0 }, { uidValidity: '7', rules: 'r' }).mode, 'full');
  assert.deepEqual(mailstate.decide(entry, { uidValidity: 7n, rules: 'r' }), { mode: 'delta', after: 40 });
});

/* --------------------------------------------------------------- the loop */

test('the loop commits the bookmark only after the batch is saved, never on a dry run', () => {
  const index = readFileSync(join(import.meta.dirname, '..', 'src', 'index.js'), 'utf8');
  assert.match(index, /await judgeLane\.push\(\{ key, prepared, owed, commit: result\.commit \}\);/);
  assert.match(index, /if \(owed\) \{ batches\.settled\(owedState, key\); batches\.save\(owedState\); \}\s*\n\s*if \(!dryRun\) await commitSource\(commit\);/,
    'after the owed marker is cleared, which is after the save');
  assert.match(index, /if \(!dryRun && !nothingBack\) await commitSource\(result\.commit\);/, 'mail with no jobs in it commits straight away');
  assert.match(index, /!\(delta && !result\.jobs\.length\)/, 'and a scan with nothing new leaves the stored slice alone');
  assert.match(index, /fetched\.mergeSlice\(key, result\.jobs, result\.merge\)/);
});

test('the bookmark file is gitignored along with the rest of data/', () => {
  assert.ok(existsSync(join(import.meta.dirname, '..', '.gitignore')));
  assert.match(readFileSync(join(import.meta.dirname, '..', '.gitignore'), 'utf8'), /^data\/$/m);
});
