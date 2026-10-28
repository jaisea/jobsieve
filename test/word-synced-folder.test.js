/**
 * Word must never open a file inside a synced folder.
 *
 * `output.applicationsDir` can be a folder synced by OneDrive or a similar
 * client, and the generator copied the template there, opened it with Word, edited and
 * saved in place. Word recognises a synced path and turns on AutoSave and
 * co-authoring — then blocks waiting for the sync engine, or for a dialog it has
 * nowhere to show because `Visible = $false`.
 *
 * Two invisible WINWORD processes were found alive after 16 and 32 minutes, each
 * still holding its document open, while Explorer struggled alongside them. The
 * same operation through a local scratch copy takes 7.6 seconds.
 *
 * CLAUDE.md already recorded the identical lesson for Google Drive, where it is
 * worse: Word cannot open the file at all and even Copy-Item fails. OneDrive is
 * more permissive, which is exactly why this went unnoticed — it usually works,
 * until the sync engine is busy.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { p } from '../src/util.js';

const SRC = readFileSync(p('src', 'apply', 'word.js'), 'utf8');

test('the document Word opens is always a local scratch copy', () => {
  const fn = SRC.slice(SRC.indexOf('export async function writeAndExport'),
    SRC.indexOf('const scratchDir ='));

  assert.match(fn, /const scratch = scratchDir\(\)/, 'a scratch directory is made');
  assert.match(fn, /const tmpDocx = join\(scratch, basename\(docx\)\)/);
  assert.match(fn, /const tmpPdf = join\(scratch, basename\(pdf\)\)/);

  // Every Word verb must name the scratch path, never the destination.
  for (const verb of ['Documents.Open', 'SaveAs2', 'ExportAsFixedFormat', 'Copy-Item']) {
    const line = fn.split('\n').find((l) => l.includes(verb));
    assert.ok(line, `${verb} should still be in writeAndExport`);
    assert.ok(/tmpDocx|tmpPdf|template/.test(line),
      `${verb} must act on the scratch copy, not the destination: ${line.trim()}`);
  }

  assert.match(fn, /place\(tmpDocx, docx\)/, 'and the finished file is moved into place');
  assert.match(fn, /place\(tmpPdf, pdf\)/);
});

test('reading a .docx goes through a local copy too', () => {
  // learn() reads the cover letter the user edited, and that lives in
  // applicationsDir — inside the synced folder. Opening it there is the same hang,
  // read-only or not.
  const fn = SRC.slice(SRC.indexOf('export async function readParagraphs'),
    SRC.indexOf('async function readLocal'));
  assert.match(fn, /copyFileSync\(docxPath, local\)/);
  assert.match(fn, /readLocal\(local\)/);
});

test('the scratch directory is always cleaned up', () => {
  // Including when Word fails. Otherwise a failed generation leaves a copy of
  // the CV behind on every attempt.
  for (const fnName of ['writeAndExport', 'readParagraphs']) {
    const fn = SRC.slice(SRC.indexOf(`export async function ${fnName}`));
    const body = fn.slice(0, fn.indexOf('\n}\n') + 3);
    assert.match(body, /finally \{[\s\S]*rmSync\(scratch, \{ recursive: true, force: true \}\)/,
      `${fnName} must remove its scratch directory in a finally`);
  }
});

test('Word is quit even when the script throws', () => {
  // `$ErrorActionPreference = 'Stop'` meant any failure threw straight past
  // `$word.Quit()`, leaving an invisible WINWORD holding an open document for
  // ever. They are invisible, so nothing suggests closing them, and each keeps a
  // lock on the .docx it was editing.
  assert.match(SRC, /\$word\.DisplayAlerts = 0\ntry \{/, 'the body runs inside try');
  assert.match(SRC, /\} finally \{[\s\S]*\$word\.Quit\(\)/, 'and Word is quit in finally');
  assert.match(SRC, /if \(\$doc\) \{ try \{ \$doc\.Close\(\$false\) \} catch \{ \} \}/,
    'the document is closed first, so the file lock goes');
});

test('a hang fails in minutes, not in half an hour', () => {
  assert.match(SRC, /const TIMEOUT_MS = \d+;/);
  assert.match(SRC, /timeout: TIMEOUT_MS/, 'the timeout must reach execFile');
  assert.match(SRC, /killSignal: 'SIGKILL'/);
});

test('and the timeout says what to look at', () => {
  // A timeout reads nothing like a PowerShell parse error, and the parse-error
  // handler below it would have mangled the message into a line number.
  const handler = SRC.slice(SRC.indexOf('if (e.killed'), SRC.indexOf('const raw = String'));
  assert.match(handler, /did not respond within/);
  assert.match(handler, /synced folder/i, 'names the usual cause');
  assert.match(handler, /applicationsDir/, 'and the setting to check');
  assert.match(handler, /Get-Process WINWORD/, 'and how to clear a leftover');
});

test('a move across volumes falls back to copy-then-delete', () => {
  // `rename` is atomic on one volume and throws EXDEV across another, and a
  // synced folder may refuse it outright while its engine holds the target.
  const fn = SRC.slice(SRC.indexOf('function place('), SRC.indexOf('function place(') + 700);
  assert.match(fn, /renameSync\(from, to\)/);
  assert.match(fn, /catch \{[\s\S]*copyFileSync\(from, to\)/);
});
