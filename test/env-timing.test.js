/**
 * Settings from .env must be read when they are USED, not when a module loads.
 *
 * `GEMINI_MAX_CONCURRENCY_JUDGE=4` sat in .env doing nothing for the life of the
 * setting. `maxConcurrency` was a module-level constant:
 *
 *     export const maxConcurrency = Math.max(1, Number(process.env.…) || 1);
 *
 * and `src/index.js` imports the provider chain statically, so every one of
 * those imports resolved before `loadEnv()` ran on line 29. The value was set
 * minutes too late to be seen — every run, silently — while the log went on
 * telling someone who had already configured 4 that they were "capped at 1 by
 * Gemini, the free-tier default; set GEMINI_MAX_CONCURRENCY_JUDGE in .env if you are
 * paying".
 *
 * It is a whole class of bug rather than one mistake: any `process.env` read at
 * module scope in a file index.js imports statically is dead on arrival.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { p } from '../src/util.js';
import * as gemini from '../src/providers/gemini.js';

test('a provider limit is read when asked for, not when imported', () => {
  assert.equal(typeof gemini.maxConcurrency, 'function',
    'a constant here is evaluated before loadEnv() has run');

  const before = process.env.GEMINI_MAX_CONCURRENCY_JUDGE;
  try {
    process.env.GEMINI_MAX_CONCURRENCY_JUDGE = '6';
    assert.equal(gemini.maxConcurrency(), 6, 'set after import — must still be seen');

    delete process.env.GEMINI_MAX_CONCURRENCY_JUDGE;
    assert.equal(gemini.maxConcurrency(), 1, 'and the free-tier default stands when unset');

    process.env.GEMINI_MAX_CONCURRENCY_JUDGE = 'nonsense';
    assert.equal(gemini.maxConcurrency(), 1, 'a bad value must not become 0 or NaN');

    process.env.GEMINI_MAX_CONCURRENCY_JUDGE = '0';
    assert.equal(gemini.maxConcurrency(), 1, 'nor must zero, which would stall the run');
  } finally {
    if (before === undefined) delete process.env.GEMINI_MAX_CONCURRENCY_JUDGE;
    else process.env.GEMINI_MAX_CONCURRENCY_JUDGE = before;
  }
});

test('the adjudicator calls it rather than reading it', () => {
  const src = readFileSync(p('src', 'adjudicate.js'), 'utf8');
  assert.match(src, /typeof c\.maxConcurrency === 'function'/,
    'reading the property would get the function object and coerce to NaN');
});

test('nothing else in a statically imported module reads .env at load time', () => {
  // The general form of the same bug. `loadEnv()` is called on line 29 of
  // index.js; every static import above it has already run.
  const dir = p('src', 'providers');
  const offenders = [];

  for (const name of readdirSync(dir).filter((n) => n.endsWith('.js'))) {
    const src = readFileSync(join(dir, name), 'utf8');
    for (const line of src.split('\n')) {
      // Column zero is the test for module scope. The same declaration INSIDE a
      // function is fine — it runs when the function is called, which is after
      // loadEnv(). That distinction is the entire bug: `const x = process.env.Y`
      // reads at import time at the left margin and at call time anywhere else.
      if (/^(export\s+)?const\s+\w+\s*=/.test(line) && line.includes('process.env')
          && !line.includes('=>') && !line.includes('function')) {
        offenders.push(`${name}: ${line.trim().slice(0, 90)}`);
      }
    }
  }

  assert.deepEqual(offenders, [],
    `these are evaluated before loadEnv() and will always see an empty value:\n  ${offenders.join('\n  ')}`);
});
