/**
 * Telling you about new jobs while the scan is still running.
 *
 * Each source's results are saved and on the page the moment its batch is judged, but the toast
 * waited for the end of the scan — so a job that had been on the page for ten minutes arrived as
 * a notification after them. The decisions are pure functions; the shell supplies the clock.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { progressNotice, finalNotice, NOTICE_GAP_MS } from '../src/daemon.js';

const main = readFileSync(join(import.meta.dirname, '..', 'src', 'electron', 'main.js'), 'utf8');

test('the first new job is announced as soon as the scan has one', () => {
  assert.deepEqual(progressNotice({ fresh: 3, notified: 0, now: 5000 }), { notified: 3, text: '3 new jobs' });
  assert.equal(progressNotice({ fresh: 1, notified: 0, now: 5000 }).text, '1 new job', 'singular');
});

test('nothing new, nothing said', () => {
  assert.equal(progressNotice({ fresh: 0, notified: 0, now: 0 }), null);
  assert.equal(progressNotice({ fresh: 3, notified: 3, now: 999999 }), null, 'already announced');
});

test('a source lands every few seconds, so at most one toast a minute — and it says how many MORE', () => {
  assert.equal(progressNotice({ fresh: 5, notified: 3, lastAt: 1000, now: 1000 + NOTICE_GAP_MS - 1 }), null, 'too soon');
  assert.deepEqual(progressNotice({ fresh: 5, notified: 3, lastAt: 1000, now: 1000 + NOTICE_GAP_MS }), { notified: 5, text: '2 more new jobs' });
});

test('the end of the scan announces only what is left, so the total is always accounted for', () => {
  assert.deepEqual(finalNotice({ fresh: 4, notified: 3 }), { notified: 4, text: '1 more new job' });
  assert.deepEqual(finalNotice({ fresh: 2, notified: 0 }), { notified: 2, text: '2 new jobs' }, 'a scan that said nothing en route says it all now');
  assert.equal(finalNotice({ fresh: 3, notified: 3 }), null, 'a scan that announced everything adds nothing');
  assert.equal(finalNotice({ fresh: 0, notified: 0 }), null, 'a quiet scan stays quiet');
});

test('a throttled notice is not lost: the next one, or the end of the scan, carries it', () => {
  // 3 announced; 2 more arrive inside the gap and are held; the scan ends.
  assert.equal(progressNotice({ fresh: 5, notified: 3, lastAt: 0, now: 10000 }), null);
  assert.equal(finalNotice({ fresh: 5, notified: 3 }).text, '2 more new jobs');
});

test('the app looks while a scan runs, resets per scan, and announces only what is left at the end', () => {
  assert.match(main, /setInterval\(\(\) => \{ refresh\(\); announceProgress\(\); \}, REFRESH_MS\);/);
  assert.match(main, /function announceProgress\(\) \{\s*\n\s*if \(!runner\.status\(\)\.running\) return;/, 'only while a scan runs');
  assert.match(main, /announced = 0;\s*\n\s*lastNoticeAt = null;\s*\n\s*lastFresh = 0;/, 'a new scan starts from zero');
  assert.match(main, /daemon\.finalNotice\(\{ fresh, notified: announced \}\)/);
  assert.doesNotMatch(main, /if \(fresh > 0\) \{\s*\n\s*toast\(/, 'the old end-of-scan-only toast is gone');
});

test('the window and the badge follow the data at once, not at their next poll', () => {
  assert.match(main, /if \(fresh > lastFresh\) \{\s*\n\s*lastFresh = fresh;\s*\n\s*refresh\(\);\s*\n\s*refreshWindow\(\);/);
});
