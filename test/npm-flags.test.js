/**
 * The two workflows that must not depend on passing a flag through npm.
 *
 * `npm run search -- --replay` looks like it works and does not. PowerShell
 * consumes the bare `--` as its own end-of-parameters token, so npm receives
 * `npm run search --replay`, treats `--replay` as an npm option of its own and
 * drops it. Nothing warns you. Reproduced on npm 10.8.2, PowerShell 7:
 *
 *     npm run x -- --replay   ->  ARGV: ["search"]           flag gone
 *     npm run x --replay      ->  ARGV: ["search"]           flag gone
 *     npm run x '--' '--replay' -> ARGV: ["search","--replay"]
 *
 * bash passes it correctly, which is why this survived — it was only ever
 * tested from bash, and PowerShell users are affected.
 *
 * The cost is not the same for every flag. A lost `--replay` spends the API
 * quota it exists to protect; a lost `--dry-run` turns "writes nothing" into a
 * run that writes. Both were reported as "it seemed to make external calls".
 *
 * So the two flags whose whole purpose is to make a run cheaper or safer get
 * their own scripts, and nothing has to cross the shell boundary.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { p } from '../src/util.js';

const pkg = JSON.parse(readFileSync(p('package.json'), 'utf8'));

test('the flags that protect a run do not travel through npm', () => {
  assert.equal(pkg.scripts.replay, 'node src/index.js search --replay',
    'a replay must be reachable without passing a flag');
  assert.equal(pkg.scripts.dry, 'node src/index.js search --dry-run --verbose',
    'and so must a dry run — a lost --dry-run WRITES');
});

test('the hazard is documented where the commands are', () => {
  // A reader who copies `npm run search -- --dry-run` out of the docs and gets
  // a real run has been misled by the docs, so the warning belongs beside them.
  for (const file of ['README.md', 'CLAUDE.md']) {
    const doc = readFileSync(p(file), 'utf8');
    assert.match(doc, /PowerShell/, `${file} must warn about the shell`);
    assert.match(doc, /npm run x -- --flag|npm run search -- --replay/,
      `${file} must show the form that fails`);
  }
});

test('every script the docs promise actually exists', () => {
  // The other half: a dedicated script is only a fix if it is written down.
  const readme = readFileSync(p('README.md'), 'utf8');
  for (const name of ['replay', 'dry']) {
    assert.ok(pkg.scripts[name], `package.json is missing ${name}`);
    assert.match(readme, new RegExp(`npm run ${name}\\b`), `README does not document ${name}`);
  }
});

/**
 * And one identity move is one line, however many copies of the posting arrive.
 */
test('a drift is reported once per move, not once per arrival', async () => {
  const store = await import('../src/store.js');
  const state = {
    seen: {
      old: { fingerprint: 'old', status: 'rejected', sources: ['mailalerts'],
        sourceIds: ['mailalerts:https://x.test/jobs/1'], title: 'Senior Platform Engineer',
        company: 'A', firstSeen: 'x', lastSeen: 'x' },
    },
    jobs: { old: { fingerprint: 'old' } },
  };
  // The same posting, four times — two alert emails and two boards, which is
  // exactly what a real run sees.
  const copy = (n) => ({
    fingerprint: 'moved', id: `mailalerts:https://x.test/jobs/1?t=${n}`,
    title: 'Senior Platform Engineer', company: 'A', source: 'mailalerts',
    descriptionText: '', score: 1,
  });
  const res = store.reconcile(state, [copy(1), copy(2), copy(3), copy(4)]);

  assert.equal(res.drifted.length, 1, 'four arrivals, one move');
  assert.equal(res.drifted[0].from, 'moved');
  assert.equal(res.drifted[0].to, 'old');
  assert.equal(state.seen.old.status, 'rejected', 'and the decision is untouched');
});

/**
 * The README quoted a cap the code does not use.
 *
 * It said "capped at 4,000 entries and 60 days" in one paragraph and "the entry
 * cap is 20,000" nineteen lines above, while LIMITS says 20,000. A number in
 * prose is only true until someone changes the constant, so this reads both.
 */
test('the documented archive cap is the one the code enforces', async () => {
  const { LIMITS } = await import('../src/rejects.js');
  const readme = readFileSync(p('README.md'), 'utf8');
  const withCommas = LIMITS.maxEntries.toLocaleString('en-US');

  assert.ok(readme.includes(`capped at **${withCommas} entries and ${LIMITS.maxAgeDays} days**`),
    `README must name the real cap (${withCommas} entries / ${LIMITS.maxAgeDays} days)`);
  assert.ok(!readme.includes('capped at 4,000 entries'), 'the stale figure is gone');
});

test('the documented PowerShell rule is the narrow one', () => {
  // Measured, not assumed, and my first reading was wrong. A positional
  // argument survives the shell intact, quoting included:
  //
  //   npm run x -- "Cloud Engineer"  ->  ARGV: ["why","Cloud Engineer"]
  //   npm run x -- <id> applied      ->  ARGV: ["why","<id>","applied"]
  //   npm run x -- <id> --diff       ->  ARGV: ["why","<id>"]        --diff gone
  //   npm run x -- --period month    ->  ARGV: ["why","month"]       --period gone
  //
  // So `npm run why -- "a title"` and `npm run mark -- <id> applied` are fine,
  // and only a leading `--` is eaten. Saying otherwise sends someone chasing a
  // quoting problem they do not have.
  for (const file of ['README.md', 'CLAUDE.md']) {
    const doc = readFileSync(p(file), 'utf8');
    assert.ok(doc.includes('a POSITIONAL'), `${file} must state that positional args survive`);
    assert.ok(!doc.includes('two arguments, not one'),
      `${file} still claims quoting is lost, which it is not`);
  }
});
