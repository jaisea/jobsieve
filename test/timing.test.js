/**
 * Where a scan's time goes.
 *
 * "It is slow" cannot be fixed; "the replay copy takes 40 seconds and the next source's fetch
 * waits behind it" can. These pin the formatting, because a timing line that reads wrong is
 * worse than none.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { fmtMs, stopwatch } from '../src/timing.js';

test('durations read the way a person says them', () => {
  assert.equal(fmtMs(380), '380ms');
  assert.equal(fmtMs(8240), '8.2s');
  assert.equal(fmtMs(125000), '2m05s');
  assert.equal(fmtMs(599000), '9m59s');
  assert.equal(fmtMs(60000), '1m00s');
});

test('laps are measured between named points and noise is left out of the text', () => {
  let t = 1000;
  const sw = stopwatch(() => t);
  t += 8200; sw.lap('normalize');
  t += 20; sw.lap('title gates');
  t += 3100; sw.lap('adverts');
  assert.equal(sw.total(), 11320);
  assert.equal(sw.text(), 'normalize 8.2s · adverts 3.1s', 'a 20ms step is not worth a word');
});

test('every batch says when it reached the page, and the scan says where its time went', () => {
  const index = readFileSync(join(import.meta.dirname, '..', 'src', 'index.js'), 'utf8');
  assert.match(index, /on the page \$\{since\(\)\} into the scan/);
  assert.match(index, /spent\.handoff \+= Date\.now\(\) - tHand;/, 'the fetch side waiting for the judge lane is its own number');
  assert.match(index, /fetch side waiting for the judge lane/);
  // Both the real end of a scan and a dry run print it.
  assert.equal((index.match(/reportTimings\(\);/g) || []).length, 2);
});
