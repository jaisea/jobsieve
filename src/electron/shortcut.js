import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ROOT } from '../util.js';

/**
 * `npm run tray:shortcut` — a "Job Hunt" shortcut on the Desktop and in the Start
 * menu, so the app starts with a double-click and no terminal.
 *
 * The target is electron.exe itself, which is a windowed program and so opens no
 * console. Paths travel in environment variables rather than being spliced into
 * the script, so a folder with a space or an umlaut in it cannot break the quoting.
 *
 *   --dir <folder>   write the shortcut there instead (for trying it out)
 */
const exe = join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const main = join(ROOT, 'src', 'electron', 'main.js');

if (!existsSync(exe)) {
  console.error('Electron is not installed yet — run `npm install` first.');
  process.exit(1);
}

const at = process.argv.indexOf('--dir');
const only = at > 0 && process.argv[at + 1] ? resolve(process.argv[at + 1]) : '';

const script = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$targets = if ($env:JH_ONLY) { @($env:JH_ONLY) } else { @([Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('Programs')) }
$shell = New-Object -ComObject WScript.Shell
foreach ($dir in $targets) {
  $lnk = Join-Path $dir 'Job Hunt.lnk'
  $s = $shell.CreateShortcut($lnk)
  $s.TargetPath = $env:JH_EXE
  $s.Arguments = '"' + $env:JH_MAIN + '"'
  $s.WorkingDirectory = $env:JH_ROOT
  $s.IconLocation = $env:JH_EXE + ',0'
  $s.Description = 'Job Hunt - scans in the background, open-job count in the tray'
  $s.Save()
  Write-Output $lnk
}`;

const out = execFileSync(
  'powershell.exe',
  ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
  { encoding: 'utf8', env: { ...process.env, JH_EXE: exe, JH_MAIN: main, JH_ROOT: ROOT, JH_ONLY: only } },
);

console.log('Created:');
for (const line of out.split(/\r?\n/).filter(Boolean)) console.log(`  ${line}`);
console.log('\nPin the icon: the Windows 11 tray hides new icons — drag it out of the ^ overflow to keep the count visible.');
