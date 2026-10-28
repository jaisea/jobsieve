/**
 * Non-ASCII text through the Word layer.
 *
 * A real incident: a cover letter to "Krüger GmbH" was written as "KrǬger GmbH",
 * and every German character in the letter with it. Windows PowerShell 5.1
 * decodes a -File script as the system ANSI codepage unless it carries a UTF-8
 * BOM, and emits stdout in that codepage too — so the corruption ran in both
 * directions, and reading a document back could even produce invalid JSON.
 *
 * This matters more here than the character count suggests: the target market is
 * German, so umlauts appear in company names, street names and half the job
 * titles. A silent encoding bug corrupts nearly every letter sent to a German
 * employer, and does it in the document rather than in the terminal, where it is
 * only found by someone reading the PDF.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { p } from '../src/util.js';
import { __testables as WORD_TESTABLES } from '../src/apply/word.js';

const WORD = readFileSync(p('src', 'apply', 'word.js'), 'utf8');

test('the PowerShell script is written with a UTF-8 BOM', () => {
  // Without it, powershell.exe reads the file as the ANSI codepage and every
  // non-ASCII character in the document text is mangled on the way in.
  // Asserted as plain substrings: a regex for the escape needs backslashes,
  // which do not survive every editing path reliably.
  assert.ok(WORD.includes('uFEFF'), 'a BOM constant must exist');
  assert.ok(WORD.includes('BOM + PS_PRELUDE'), 'and must prefix the script actually written');
});
test('PowerShell stdout is forced to UTF-8', () => {
  // The read direction: without this, reading a document containing umlauts
  // returns mojibake, and can break JSON.parse outright.
  assert.match(WORD, /\[Console\]::OutputEncoding = \[System\.Text\.Encoding\]::UTF8/);
  assert.match(WORD, /\$OutputEncoding = \[System\.Text\.Encoding\]::UTF8/);
});

test('curly quotes are escaped, because PowerShell treats them as delimiters', () => {
  // A generated letter said "Bäckerei Shop’s engineering initiatives" with a
  // curly apostrophe. PowerShell accepts U+2018 and U+2019 as string
  // delimiters, so it closed the string early and the whole run failed with a
  // parse error. Tested against the real shell: a bare curly quote errors, a
  // doubled one does not.
  const { q } = WORD_TESTABLES;
  const curlyRight = String.fromCharCode(0x2019);
  const curlyLeft = String.fromCharCode(0x2018);
  const straight = String.fromCharCode(39);

  assert.equal(q(`Shop${curlyRight}s`), `'Shop${curlyRight}${curlyRight}s'`);
  assert.equal(q(`a ${curlyLeft}quoted${curlyRight} phrase`), `'a ${curlyLeft}${curlyLeft}quoted${curlyRight}${curlyRight} phrase'`);
  assert.equal(q(`don${straight}t`), `'don${straight}${straight}t'`);
});

test('a failed script reports the reason, not just the line number', () => {
  // PowerShell prints the LOCATION first and the explanation underneath, so
  // taking the first line printed "At <file>:14 char:215" and hid the sentence
  // that said a string was unterminated.
  const src = readFileSync(p('src', 'apply', 'word.js'), 'utf8');
  assert.match(src, /lines\.find\(\(l\) => !\/\^At \/\.test\(l\)/, 'the location line must be skipped when looking for the reason');
  assert.match(src, /\[reason, where\]/, 'and both should be reported, reason first');
});

/**
 * A document opened by Word arrives in READING VIEW, which refuses every edit.
 *
 * Two tailoring runs failed with "You are not allowed to edit this selection
 * because it is protected" — which reads like the template had been locked. It
 * had not. ProtectionType was -1, the .docx package contained no
 * documentProtection, no writeProtection, no permStart and no content controls,
 * and the file carried no Mark of the Web. A document Word CREATED in the same
 * folder failed identically, which ruled the template out entirely.
 *
 * One diagnostic changed the message. Selection.TypeText, instead of setting
 * Range.Text, says what is actually wrong:
 *
 *     This method or property is not available because this command is not
 *     available for reading.
 *
 * ActiveWindow.View.Type was 7 — wdReadingView. Setting it to 3 (wdPrintView)
 * makes the identical edit succeed, verified end to end on both failed runs.
 *
 * Options.AllowReadingMode was already False, so the usual switch does not
 * prevent this; the view has to be set on the window after opening.
 */
test('the edit script leaves reading view before it edits anything', () => {
  const src = readFileSync(p('src', 'apply', 'word.js'), 'utf8');

  assert.match(src, /ActiveWindow\.View\.Type = 3/,
    'wdPrintView, or every Range.Text assignment fails as "protected"');

  // Order matters: after the open, before the generated edits.
  const open = src.indexOf('$doc = $word.Documents.Open(${qPath(tmpDocx)})');
  const leave = src.indexOf('${LEAVE_READING_VIEW}');
  const edits = src.indexOf('${script}');
  assert.ok(open > 0 && leave > open && edits > leave,
    'the view must be set after opening and before the edits');

  assert.match(src, /try \{ \$doc\.ActiveWindow\.View\.Type = 3 \} catch \{ \}/,
    'guarded — a document with no window must not turn a working run into a new failure');
});

test('the misleading error is written down, not just the fix', () => {
  // "protected" sent the first diagnosis at document protection, template
  // locking and Mark of the Web, none of which were involved. Without the note
  // the next reader repeats all three.
  const src = readFileSync(p('src', 'apply', 'word.js'), 'utf8');
  assert.match(src, /available for reading/);
  assert.match(src, /wdReadingView|READING VIEW/);
});
