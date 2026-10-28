/**
 * The CLI entry point actually starting.
 *
 * A whole day's run fetched nothing and every source reported "Cannot access
 * 'REACHABLE_COUNTRIES' before initialization". The command dispatch sat near
 * the top of index.js with hundreds of lines of declarations below it: function
 * declarations hoist, so it had always worked, until a command reached for a
 * `const` declared further down and found it still in the temporal dead zone.
 *
 * The unit tests all passed throughout — they import modules, they never start
 * the CLI. That is the gap these close.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

import { p } from '../src/util.js';

const SRC = readFileSync(p('src', 'index.js'), 'utf8');

test('nothing is declared below the command dispatch', () => {
  // The invariant that makes the failure impossible rather than unlikely: run
  // the command last, once every declaration in the file has been initialised.
  const at = SRC.indexOf('(COMMANDS[command] || help)()');
  assert.ok(at > 0, 'the dispatch call was not found');

  const after = SRC.slice(at + 30);
  const declarations = [...after.matchAll(/^(const|let|class)\s+(\w+)/gm)].map((m) => m[2]);
  assert.deepEqual(declarations, [],
    `these are declared after the dispatch and would be in the temporal dead zone: ${declarations.join(', ')}`);
});

test('every command starts without throwing', () => {
  // Cheap smoke test: the offline commands are run for real. Each would have
  // failed on the dead-zone bug the moment it touched a const below the
  // dispatch, which is exactly what no import-based test could see.
  for (const cmd of ['help', 'reviewed', 'companies']) {
    const out = execFileSync('node', [p('src', 'index.js'), cmd], {
      encoding: 'utf8', timeout: 60000, env: { ...process.env, JOBHUNT_NO_LOGFILE: '1', JOBHUNT_PROFILE: p('config', 'examples', 'devops.profile.json') }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    assert.ok(!/before initialization|is not defined|is not a function/.test(out),
      `${cmd} reported an initialisation error:\n${out.slice(0, 300)}`);
  }
});
