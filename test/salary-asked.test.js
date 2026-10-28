/**
 * The salary you asked for, recorded at the moment you know it.
 *
 * It goes into the employer's application form and then exists nowhere else —
 * not in the advert, not in the CV, not in the letter. Months later, when one
 * of them comes back with an offer, the number you named is the one fact that
 * cannot be reconstructed from anything this tool has kept.
 *
 * Two properties do the work and both are easy to lose in a refactor: it is
 * FREE TEXT, and it is OPTIONAL.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { p } from '../src/util.js';
import { setStatus } from '../src/store.js';

const state = () => ({ seen: { a: { fingerprint: 'a', status: 'shown' } }, jobs: {} });

test('a bare third argument means the salary on applied and the reason on rejected', () => {
  // The CLI takes one trailing word, and which field it fills is decided by the
  // status because only one of them applies to each. Keeping the string form
  // matters: `npm run mark -- 3cbda65e applied 85000` is what actually gets
  // typed.
  const s1 = state();
  setStatus(s1, 'a', 'applied', '85000');
  assert.equal(s1.seen.a.salaryAsked, '85000');
  assert.equal(s1.seen.a.rejectedReason, undefined);

  const s2 = state();
  setStatus(s2, 'a', 'rejected', 'language');
  assert.equal(s2.seen.a.rejectedReason, 'language');
  assert.equal(s2.seen.a.salaryAsked, undefined);
});

test('and the object form carries both, for the report button', () => {
  const s = state();
  setStatus(s, 'a', 'applied', { salaryAsked: '90-100k' });
  assert.equal(s.seen.a.salaryAsked, '90-100k');
});

test('it is free text, because the real answers are not numbers', () => {
  // "85.000 € p.a. + Bonus", "90–100k", "declined to state" and "whatever the
  // band is" are all things that get typed into that box, and parsing them into
  // an integer would throw away the half that matters.
  for (const answer of ['85.000 € p.a. + Bonus', '90–100k', 'declined to state', 'their band']) {
    const s = state();
    setStatus(s, 'a', 'applied', answer);
    assert.equal(s.seen.a.salaryAsked, answer, `${answer} must survive verbatim`);
  }

  const trimmed = state();
  setStatus(trimmed, 'a', 'applied', '  85000  ');
  assert.equal(trimmed.seen.a.salaryAsked, '85000', 'only the surrounding space goes');
});

test('it never blocks the marking, because it is optional', () => {
  // A form that refuses to mark a job applied until a figure is supplied would
  // just stop jobs being marked, and the queue is what this tool is for.
  const s = state();
  assert.equal(setStatus(s, 'a', 'applied'), true);
  assert.equal(s.seen.a.status, 'applied');
  assert.equal(s.seen.a.salaryAsked, undefined);

  const empty = state();
  setStatus(empty, 'a', 'applied', { salaryAsked: null });
  assert.equal(empty.seen.a.status, 'applied');
  assert.equal(empty.seen.a.salaryAsked, undefined);
});

test('it survives a later status change, unlike the reject reason', () => {
  // The reason describes the CURRENT verdict, so a stale one misleads and is
  // cleared. What you asked for happened; it stays true whatever the job
  // becomes afterwards — and a rejection after an interview is exactly the
  // moment the figure is worth having.
  const s = state();
  setStatus(s, 'a', 'applied', '85000');
  setStatus(s, 'a', 'rejected', 'salary');
  assert.equal(s.seen.a.salaryAsked, '85000', 'the figure is history, not a verdict');
  assert.equal(s.seen.a.rejectedReason, 'salary');
});

test('the report asks for it with a text box, not a list of options', () => {
  const rep = readFileSync(p('src', 'report.js'), 'utf8');
  assert.match(rep, /function askSalary/, 'marking applied must ask');
  assert.match(rep, /class="salary-in" type="text"/, 'and ask with an input, not buttons');
  assert.match(rep, /status === 'applied' && !btn\.dataset\.salary/,
    'gated the same way the reject reason is');
  assert.match(rep, /data-skip="1"/, 'with a way past it, since the figure is optional');
});

test('both marking paths hand the figure to the application folder', () => {
  // seen.json is not enough on its own: the folder holds job.md, which is the
  // thing actually read before an interview.
  const idx = readFileSync(p('src', 'index.js'), 'utf8');
  const srv = readFileSync(p('src', 'serve.js'), 'utf8');
  assert.match(idx, /recordApplied\(job, \{ salaryAsked \}\)/, 'the CLI path');
  assert.match(srv, /recordApplied\(state\.jobs\[fp\], \{ salaryAsked: salary \|\| null \}\)/, 'the report button');

  const apply = readFileSync(p('src', 'apply', 'index.js'), 'utf8');
  assert.match(apply, /salaryAsked = null/, 'recordApplied must accept it');
  assert.match(apply, /You asked for \$\{salaryAsked\}/, 'and job.md must state it');
});

test('marking a job applied a second time fills the figure in rather than dropping it', () => {
  // recordApplied returns early when the folder exists, which is right — it must
  // not overwrite a real generation. But the common way to end up here is
  // marking applied, then coming back with the number, and silently discarding
  // it is the one thing this feature must not do.
  const apply = readFileSync(p('src', 'apply', 'index.js'), 'utf8');
  const from = apply.indexOf('export function recordApplied');
  const fn = apply.slice(from, apply.indexOf('\n}', from));
  assert.match(fn, /if \(salaryAsked && !already\.salaryAsked\)/,
    'an existing folder gets the figure filled in');
  assert.ok(fn.indexOf('!already.salaryAsked') > 0,
    'but never overwritten — the first answer was given closer to the form');
});
