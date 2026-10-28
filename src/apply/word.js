import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFileSync, mkdirSync, existsSync, unlinkSync, renameSync, copyFileSync, rmSync } from 'node:fs';
import { dirname, resolve, join, basename } from 'node:path';
import { p } from '../util.js';

const run = promisify(execFile);

/**
 * Word automation, over PowerShell COM.
 *
 * Why Word rather than generating a document from scratch: the templates are
 * the user's real CV and letter, formatted the way they want them, and the
 * PDF path is the one they already trust. Rebuilding either would mean
 * reproducing a three-page layout by hand and getting it subtly wrong.
 *
 * Two things learned the hard way, both load-bearing:
 *
 *   1. Replace paragraph TEXT, never the paragraph. Setting `.Text` on a range
 *      that excludes the paragraph mark preserves font, size, indent, spacing
 *      AND list formatting — verified identical before and after. Deleting and
 *      re-inserting paragraphs loses the bullets.
 *
 *   2. Word COM cannot open files on the Google Drive letter (I:). Even
 *      Copy-Item fails there. Templates must be copied to a local path first,
 *      which is why `templates/` exists.
 */

/**
 * Windows PowerShell 5.1 decodes a -File script as the system ANSI codepage
 * unless it carries a UTF-8 BOM, and writes stdout in that codepage too. Both
 * directions mangled German: "Krueger GmbH" with an umlaut went in and came back
 * as mojibake, corrupting every letter written to a German employer. The BOM
 * fixes input; setting the console encoding fixes output.
 */
const BOM = '\uFEFF';

const PS_PRELUDE = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
$word = New-Object -ComObject Word.Application
$word.Visible = $false
$word.DisplayAlerts = 0
try {
`;

/**
 * The body runs inside try/finally so Word is quit whatever happens.
 *
 * It did not, and `$ErrorActionPreference = 'Stop'` meant any failure threw
 * straight past `$word.Quit()` — leaving an invisible WINWORD.EXE holding an
 * open document, for ever. Two of them were found alive after 16 and 32
 * minutes. They are invisible (`Visible = $false`) so nothing suggests closing
 * them, and each one keeps a lock on the .docx it was editing.
 */
const PS_CLEANUP = `
} finally {
  if ($doc) { try { $doc.Close($false) } catch { } }
  if ($word) {
    try { $word.Quit() } catch { }
    try { [System.Runtime.InteropServices.Marshal]::ReleaseComObject($word) | Out-Null } catch { }
  }
}
`;

/**
 * How long one Word operation may take before it is treated as hung.
 *
 * Editing a CV is seconds of work. Thirty minutes is not slow, it is stuck —
 * and without a limit it stays stuck silently while the terminal shows nothing.
 */
const TIMEOUT_MS = 120000;

/**
 * Word opens a document in READING VIEW, and reading view refuses every edit.
 *
 * Both tailoring runs on 2026-09-22 failed with "You are not allowed to edit
 * this selection because it is protected", which reads like the template had
 * been locked. It had not: ProtectionType was -1, the .docx package contained
 * no documentProtection, no writeProtection, no permStart and no content
 * controls, and the file carried no Mark of the Web.
 *
 * The message was a red herring, and one diagnostic changed it. Calling
 * Selection.TypeText instead of setting Range.Text says what is actually wrong:
 *
 *     This method or property is not available because this command is not
 *     available for reading.
 *
 * ActiveWindow.View.Type came back as 7 — wdReadingView. Setting it to 3
 * (wdPrintView) makes the identical edit succeed.
 *
 * Two things about this are worth keeping. A document created in memory with
 * Documents.Add() edits fine, so "Word can edit" was never the question — only
 * documents OPENED from a path arrive in reading view. And Options.
 * AllowReadingMode was already False, so the usual switch does not prevent it;
 * the view has to be set on the window after opening.
 *
 * Wrapped in try/catch because a document with no window would otherwise turn a
 * working run into a new failure, and print view is a preference here, not a
 * requirement — if the view is already right, nothing needs to happen.
 */
const LEAVE_READING_VIEW = `try { $doc.ActiveWindow.View.Type = 3 } catch { }`;

async function powershell(script) {
  const file = p('data', 'tmp', `word-${process.pid}-${Date.now()}.ps1`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, BOM + PS_PRELUDE + script + PS_CLEANUP, 'utf8');
  try {
    const { stdout } = await run('powershell', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file,
    ], { maxBuffer: 32 * 1024 * 1024, timeout: TIMEOUT_MS, killSignal: 'SIGKILL' });
    // Deleted only on success. A failed script is the evidence — reading one
    // is how a curly apostrophe in "Acme Shop’s" was found to be closing a
    // PowerShell string early. Keeping every script instead left 186 files.
    try { unlinkSync(file); } catch { /* the run worked; tidying is optional */ }
    return stdout;
  } catch (e) {
    // PowerShell reports a parse error as a LOCATION first — "At <file>:14
    // char:215" — and the sentence explaining it comes underneath. Taking the
    // first line therefore printed a line number and hid the reason, which cost
    // a real diagnosis: a curly apostrophe in "Acme Shop’s" had closed the
    // string early and the message saying so was two lines further down.
    //
    // The file is kept when a script fails, so there is something to read.
    // A timeout is not a script error and reads nothing like one, so it is
    // named before the parse-error handling below gets hold of it.
    if (e.killed || e.signal === 'SIGKILL' || /timed?\s*out/i.test(String(e.message))) {
      throw new Error(
        `Word did not respond within ${TIMEOUT_MS / 1000}s — the script is at ${file}.\n`
        + '  Almost always a synced folder: Word opens a file inside OneDrive or Google Drive,\n'
        + '  engages AutoSave and co-authoring, and waits on the sync engine for a dialog it\n'
        + '  has nowhere to show. Check output.applicationsDir in master.json.\n'
        + '  Any leftover invisible Word: Get-Process WINWORD | Stop-Process -Force',
      );
    }

    const raw = String(e.stderr || e.message);
    const lines = raw.split('\n').map((l) => l.trim()).filter(Boolean);
    const reason = lines.find((l) => !/^At /.test(l) && !/^\+/.test(l) && !/^~+$/.test(l));
    const where = lines.find((l) => /^At /.test(l));
    const msg = [reason, where].filter(Boolean).join(' — ') || lines[0] || e.message;
    throw new Error(`Word automation failed: ${msg}`);
  }
}

/**
 * Read a .docx as an ordered list of paragraphs.
 *
 * Read through a local COPY, for the same reason writeAndExport builds through
 * one. Most callers pass a template, which is local anyway — but learn() reads
 * the cover letter the user edited, and that lives in applicationsDir, which is
 * often inside a synced folder such as OneDrive. Opening it there is the same
 * hang, read-only or not.
 */
export async function readParagraphs(docxPath) {
  if (!existsSync(docxPath)) throw new Error(`template not found: ${docxPath}`);

  const scratch = scratchDir();
  const local = join(scratch, basename(docxPath));
  try {
    copyFileSync(docxPath, local);
    return await readLocal(local);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

async function readLocal(docxPath) {
  const out = await powershell(`
$doc = $word.Documents.Open(${qPath(docxPath)}, $false, $true)
$rows = @()
$i = 0
foreach ($p in $doc.Paragraphs) {
  $i++
  $t = ($p.Range.Text -replace "[\\r\\a]", "")
  $rows += [pscustomobject]@{ index = $i; text = $t; style = $p.Style.NameLocal; list = $p.Range.ListFormat.ListType }
}
$doc.Close($false)
$rows | ConvertTo-Json -Depth 3 -Compress
`);
  const json = out.trim();
  if (!json) return [];
  const rows = JSON.parse(json);
  return (Array.isArray(rows) ? rows : [rows]).map((r) => ({ ...r, text: String(r.text ?? '') }));
}

/**
 * Apply text replacements by paragraph index and export.
 *
 * `edits` is [{ index, text }]. Indexes come from readParagraphs, so they refer
 * to the same document — anything not listed is left untouched, which is the
 * point: only the lines being tailored are rewritten.
 */
export async function writeAndExport({ template, docx, pdf, edits }) {
  mkdirSync(dirname(docx), { recursive: true });

  // Applied high index to low so an edit cannot shift the indexes of later ones.
  const ordered = [...edits].sort((a, b) => b.index - a.index);
  const script = ordered.map(({ index, text }) => `
$r = $doc.Paragraphs.Item(${index}).Range
$r.MoveEnd(1, -1) | Out-Null
$r.Text = ${q(text)}
`).join('');

  // BUILT LOCALLY, then moved. Word must never open a file inside a synced
  // folder — see the note on scratchFor().
  const scratch = scratchDir();
  const tmpDocx = join(scratch, basename(docx));
  const tmpPdf = join(scratch, basename(pdf));

  try {
    await powershell(`
Copy-Item -LiteralPath ${qPath(template)} -Destination ${qPath(tmpDocx)} -Force
$doc = $word.Documents.Open(${qPath(tmpDocx)})
${LEAVE_READING_VIEW}
${script}
$doc.SaveAs2(${qPath(tmpDocx)})
$doc.ExportAsFixedFormat(${qPath(tmpPdf)}, 17)
Write-Output "pages=$($doc.ComputeStatistics(2))"
$doc.Close($false)
`);

    // Only once Word has quit and released its lock.
    place(tmpDocx, docx);
    place(tmpPdf, pdf);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }

  return { docx, pdf };
}

/**
 * Word must never open a file inside a synced folder.
 *
 * `output.applicationsDir` is commonly inside a synced folder such as OneDrive
 * (a "Documents\Job Applications" folder), and the generator was copying the template there, opening it with Word,
 * editing and saving in place. Word recognises a synced path and turns on
 * AutoSave and co-authoring — then blocks waiting for the sync engine, or for a
 * dialog it has nowhere to show because `Visible = $false`. It hangs. Two
 * invisible WINWORD processes were found alive after 16 and 32 minutes, each
 * still holding its document open, while Explorer struggled alongside them.
 *
 * CLAUDE.md already records the same lesson for Google Drive, where it is worse:
 * Word cannot open the file at all and even Copy-Item fails. OneDrive is more
 * permissive, which is precisely why this went unnoticed — it usually works,
 * until the sync engine is busy.
 *
 * So every Word operation happens on a local scratch copy, and the finished
 * files are moved into place afterwards. Sync then sees one completed file
 * appear rather than a document being written to live.
 */
const scratchDir = () => {
  const dir = p('data', 'tmp', `word-${process.pid}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
};

/**
 * Move a finished file to its destination, across volumes if need be.
 *
 * `rename` is atomic and instant on the same volume but throws EXDEV across
 * one; a synced folder may also refuse the rename while its engine is holding
 * the target. Copy-then-delete is the fallback, and the copy is what sync sees.
 */
function place(from, to) {
  if (!existsSync(from)) return false;
  mkdirSync(dirname(to), { recursive: true });
  try {
    renameSync(from, to);
  } catch {
    copyFileSync(from, to);
    try { unlinkSync(from); } catch { /* the copy landed; the leftover is swept below */ }
  }
  return true;
}

/**
 * Single-quoted PowerShell literal. Doubling the quote is the only escape
 * PowerShell honours inside '...', and it means nothing in the text — a stray
 * $ or backtick in a job title — can be interpreted.
 *
 * CURLY quotes must be doubled too. PowerShell accepts U+2018 and U+2019 as
 * string delimiters, so a generated letter reading "Acme Shop’s engineering
 * initiatives" closed the string early and failed the whole run with a parse
 * error. Verified against the real shell: a bare curly apostrophe errors, a
 * doubled one does not, and a full Word round trip returns the character
 * unchanged.
 */
const q = (s) => `'${String(s).replace(/['‘’‚‛]/g, (c) => c + c)}'`;

/**
 * PowerShell runs with its own working directory (system32 when spawned this
 * way), so a relative path handed to Word resolves somewhere unintended and
 * fails with a misleading "we couldn't find your file". Every path crossing
 * this boundary is made absolute here rather than at each call site.
 */
const qPath = (s) => q(resolve(String(s)));

export const __testables = { q, qPath };
