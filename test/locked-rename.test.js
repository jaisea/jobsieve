/**
 * A file another program is reading must not fail a scan.
 *
 * On Windows, replacing a file that something else has open is refused with EPERM. A scan died
 * on it after minutes of work, because a copy of the data folder was reading rejected.json at
 * that moment. The holder lets go within a moment, so the rename is retried.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { retryLocked, writeJson } from '../src/util.js';

const locked = (code) => Object.assign(new Error(`${code}: operation not permitted`), { code });

test('a rename refused because the file is in use is tried again, and succeeds when the holder lets go', () => {
  let calls = 0;
  const waits = [];
  const out = retryLocked(() => { if (++calls < 4) throw locked('EPERM'); return 'renamed'; }, { wait: (ms) => waits.push(ms) });
  assert.equal(out, 'renamed');
  assert.equal(calls, 4);
  assert.deepEqual(waits, [25, 50, 100], 'a short, growing wait');
});

test('EBUSY and EACCES are the same condition', () => {
  for (const code of ['EBUSY', 'EACCES']) {
    let calls = 0;
    assert.equal(retryLocked(() => { if (++calls < 2) throw locked(code); return 'ok'; }, { wait: () => {} }), 'ok', code);
  }
});

test('a file held for good still fails — after about three seconds, with the original error', () => {
  let calls = 0;
  let waited = 0;
  assert.throws(
    () => retryLocked(() => { calls++; throw locked('EPERM'); }, { wait: (ms) => { waited += ms; } }),
    /EPERM/,
  );
  assert.equal(calls, 8);
  assert.ok(waited > 2500 && waited < 4000, `about 3s of patience, got ${waited}ms`);
});

test('any other error is a real error and surfaces at once', () => {
  let calls = 0;
  assert.throws(() => retryLocked(() => { calls++; throw Object.assign(new Error('no such file'), { code: 'ENOENT' }); }, { wait: () => { throw new Error('must not wait'); } }), /no such file/);
  assert.equal(calls, 1);
});

test('writeJson goes through it, and still leaves no temp file behind', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jobhunt-write-'));
  try {
    const file = join(dir, 'x.json');
    writeJson(file, { a: 1 });
    writeJson(file, { a: 2 });
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { a: 2 });
    assert.deepEqual(readdirSync(dir), ['x.json'], 'the temp file was renamed away');
    assert.ok(existsSync(file));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const src = readFileSync(join(import.meta.dirname, '..', 'src', 'util.js'), 'utf8');
  assert.match(src, /retryLocked\(\(\) => renameSync\(tmp, path\)\);/);
});
