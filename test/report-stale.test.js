import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reportIsStale } from '../src/serve.js';

function files() {
  const dir = mkdtempSync(join(tmpdir(), 'stale-'));
  const page = join(dir, 'latest.html');
  const src = join(dir, 'report.js');
  writeFileSync(page, '<html></html>');
  writeFileSync(src, '// code');
  return { page, src };
}
const at = (f, secs) => utimesSync(f, secs, secs);

test('a page older than the code that builds it is stale, so a new button appears without a scan', () => {
  const { page, src } = files();
  at(page, 1000); at(src, 2000);
  assert.equal(reportIsStale(page, src), true);
});

test('a page newer than its code is left alone -- rebuilding costs seconds on a big page', () => {
  const { page, src } = files();
  at(src, 1000); at(page, 2000);
  assert.equal(reportIsStale(page, src), false);
});

test('a missing page or source is not stale: there is nothing to compare, and the placeholder handles no page', () => {
  const { page, src } = files();
  assert.equal(reportIsStale(page + '.nope', src), false);
  assert.equal(reportIsStale(page, src + '.nope'), false);
});
