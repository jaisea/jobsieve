/**
 * The word diff printed during generation.
 *
 * It exists because the overclaims hide in single words: a run swapped
 * "Azure-based" for "multi-cloud" in a summary line, which reads broader and is
 * less true, and the sentence was otherwise identical. If the diff misreports
 * which words moved it is worse than not printing one — it would give false
 * confidence in a line nobody then re-reads.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { diffWords, renderEdit, __testables } from '../src/apply/diff.js';

const kinds = (a, b) => diffWords(a, b).map((t) => `${t.kind[0]}:${t.word}`).join(' ');

test('an unchanged line reports no changes at all', () => {
  const line = 'Specialized in Azure-based platform engineering.';
  assert.ok(diffWords(line, line).every((t) => t.kind === 'same'));
});

test('a single swapped word is reported as exactly that', () => {
  // The real case. Everything either side must stay 'same', or the reader
  // cannot see at a glance that one word carries the whole change.
  const out = diffWords(
    'Specialized in Azure-based platform engineering, GitOps workflows.',
    'Specialized in multi-cloud platform engineering, GitOps workflows.',
  );
  assert.equal(out.filter((t) => t.kind === 'del').map((t) => t.word).join(), 'Azure-based');
  assert.equal(out.filter((t) => t.kind === 'add').map((t) => t.word).join(), 'multi-cloud');
  assert.equal(out.filter((t) => t.kind === 'same').length, 6);
});

test('the two sides reconstruct the original and the rewrite exactly', () => {
  // The strongest guarantee available: whatever the diff decides, replaying it
  // must give back both inputs. A diff that loses or invents a word would
  // misrepresent a CV line.
  const before = 'DevOps leader with 12 years of experience designing and operating cloud platforms.';
  const after = 'DevOps leader with 12 years designing and operating multi-cloud platforms.';
  const out = diffWords(before, after);
  const side = (kept) => out.filter((t) => kept.includes(t.kind)).map((t) => t.word).join(' ');
  assert.equal(side(['same', 'del']), before);
  assert.equal(side(['same', 'add']), after);
});

test('deletions and insertions at the ends are not dropped', () => {
  assert.equal(kinds('alpha beta', 'beta'), 'd:alpha s:beta');
  assert.equal(kinds('beta', 'alpha beta'), 'a:alpha s:beta');
  assert.equal(kinds('beta', 'beta gamma'), 's:beta a:gamma');
});

test('an empty side is handled rather than throwing', () => {
  assert.equal(kinds('', 'new text'), 'a:new a:text');
  assert.equal(kinds('old text', ''), 'd:old d:text');
  assert.deepEqual(diffWords('', ''), []);
});

test('wrapping measures the word, not the colour codes', () => {
  // Colour codes are invisible but would count toward the margin, wrapping the
  // highlighted lines early — precisely the lines that must stay readable.
  const tokens = ['aaaa', 'bbbb', 'cccc'].map((w) => ({ word: w, colour: `\u001b[31m${w}\u001b[0m` }));
  const lines = __testables.wrap(tokens, 9, '');
  assert.equal(lines.length, 2, 'two 4-letter words plus a space fit in 9 columns; three do not');
});

test('the rendered block shows both sides and the paragraph number', () => {
  const out = renderEdit({ index: 42, before: 'operating cloud platforms', after: 'operating multi-cloud platforms' });
  const plain = out.replace(/\u001b\[[0-9;]*m/g, '');
  assert.match(plain, /¶42/);
  assert.match(plain, /− operating cloud platforms/);
  assert.match(plain, /\+ operating multi-cloud platforms/);
});
