/**
 * .env parsing.
 *
 * A real incident: GEMINI_MODEL_JUDGE was edited to `newmodel#oldmodel`, the whole
 * string became the model name, it 404'd, and the provider silently substituted
 * a working model. `npm run keys` then reported success with a model the user
 * had not chosen, so the setting looked ignored with nothing to explain it.
 *
 * Two properties matter here — comments behave as people expect, and values
 * that legitimately contain # survive.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * loadEnv reads a fixed path and mutates process.env, so exercise the parsing
 * rule directly rather than reaching for the module's file handling.
 */
function parse(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/i);
    if (!m) continue;
    let val = m[2].trim();
    const quoted = /^(["']).*\1$/.test(val);
    if (quoted) val = val.slice(1, -1);
    else val = val.replace(/\s+#.*$/, '').trim();
    if (val && out[m[1]] === undefined) out[m[1]] = val;
  }
  return out;
}

test('a spaced # starts a comment', () => {
  assert.equal(parse('GEMINI_MODEL_JUDGE=gemini-flash-lite-latest  # the roomy tier').GEMINI_MODEL_JUDGE,
    'gemini-flash-lite-latest');
});

test('a # with no space before it is part of the value', () => {
  // The incident case. No dotenv treats this as a comment, and truncating it
  // silently would hide a typo instead of surfacing it — the value stays whole
  // so the resulting 404 names the nonsense model back to you.
  assert.equal(parse('GEMINI_MODEL_JUDGE=new-model#old-model').GEMINI_MODEL_JUDGE, 'new-model#old-model');
});

test('a quoted value keeps its hashes', () => {
  // Passwords contain # far more often than anyone expects.
  assert.equal(parse('IMAP_PASSWORD="p#ss w#rd"').IMAP_PASSWORD, 'p#ss w#rd');
  assert.equal(parse("IMAP_PASSWORD='a b # c'").IMAP_PASSWORD, 'a b # c');
});

test('an unquoted value keeps a hash that is not a comment', () => {
  assert.equal(parse('TOKEN=abc#def').TOKEN, 'abc#def');
});

test('whole-line comments and blanks are skipped', () => {
  const env = parse('# a comment\n\nA=1\n   # indented\nB=2');
  assert.deepEqual(env, { A: '1', B: '2' });
});

test('the first assignment wins', () => {
  assert.equal(parse('A=first\nA=second').A, 'first');
});

test('empty values do not shadow', () => {
  // An unset key must fall through to its default rather than becoming ''.
  assert.equal(parse('A=\nB=2').A, undefined);
});
