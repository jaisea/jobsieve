import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { p } from '../src/util.js';

// The terminal and the app share ONE log: a command prints to the console and also appends
// to the file the Log tab reads. Run in a child, because tee() patches console globally.
const run = (env) => {
  const dir = mkdtempSync(join(tmpdir(), 'jh-log-'));
  const file = join(dir, 'daemon.log');
  const mod = pathToFileURL(p('src', 'applog.js')).href;
  const code = `import(${JSON.stringify(mod)}).then((m) => { m.tee('search'); console.log('\\u001b[32mhello\\u001b[0m'); console.log('a\\n\\nb'); });`;
  const out = execFileSync(process.execPath, ['-e', code], { encoding: 'utf8', env: { ...process.env, JOBHUNT_LOG_FILE: file, ...env } });
  return { out, file };
};

test('a command still prints to the console and also appends tagged, timestamped lines to the log', () => {
  const { out, file } = run({ JOBHUNT_NO_LOGFILE: '' });
  assert.match(out, /hello/);
  const lines = readFileSync(file, 'utf8').trim().split('\n');
  assert.equal(lines.length, 3, 'blank lines are skipped, each other line is its own entry');
  assert.ok(lines[0].endsWith('[search] ' + String.fromCharCode(27) + '[32mhello' + String.fromCharCode(27) + '[0m'), 'colour codes are kept, for the Log tab to render');
});

test('a line is tagged by the work it belongs to, which a request carries with it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jh-log-'));
  const file = join(dir, 'daemon.log');
  const mod = pathToFileURL(p('src', 'applog.js')).href;
  const code = `import(${JSON.stringify(mod)}).then(async (m) => { m.tee('app'); console.log('plain');
    await m.withTag('tailor', async () => { await new Promise((r) => setTimeout(r, 5)); console.log('inside'); });
    console.log('after'); });`;
  execFileSync(process.execPath, ['-e', code], { encoding: 'utf8', env: { ...process.env, JOBHUNT_LOG_FILE: file, JOBHUNT_NO_LOGFILE: '' } });
  const tags = readFileSync(file, 'utf8').trim().split('\n').map((l) => l.match(/\[(\w+)\]/)[1]);
  assert.deepEqual(tags, ['app', 'tailor', 'app']);
});

test('a scan the app starts does not write its output twice', () => {
  const { out, file } = run({ JOBHUNT_NO_LOGFILE: '1' });
  assert.match(out, /hello/);
  assert.equal(existsSync(file), false);
});
