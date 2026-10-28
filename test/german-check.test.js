/**
 * German, read once more for what is about to be shown.
 *
 * The rules grade German from patterns and the model sees only what they could not
 * settle, so a posting every gate passed reached the page with nobody having read its
 * German lines. The check is one-directional (it can only turn a keep into a drop),
 * needs a quote that is really in the advert, and treats "a plus" as no demand.
 * Cached per posting + advert text + the user's German level; never a verdict when refused.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'jobhunt-german-'));
process.env.JOBHUNT_DATA_DIR = dir;
const { checkGerman, cachedDrop, isCheckable, quoteIsReal, stampOf, CHECK_VERSION } = await import('../src/germancheck.js');

const ADVERT = `${'Wir bauen Plattformen. '.repeat(40)}\n• Du sprichst fließend Deutsch und Englisch\n${'Mehr Text hier. '.repeat(20)}`;
const profile = { languages: { germanLevel: 'A2' }, llm: { providers: 'nonesuch' } };
const job = (over = {}) => ({ fingerprint: 'f1', title: 'DevOps Engineer', company: 'X', descriptionText: ADVERT, ...over });
const writeCache = (checks) => writeFileSync(join(dir, 'german-checks.json'), JSON.stringify({ version: CHECK_VERSION, checks }));

test('a quote must really be in the advert, or it is not a requirement', () => {
  assert.equal(quoteIsReal('Du sprichst fließend Deutsch und Englisch', ADVERT), true);
  assert.equal(quoteIsReal('• Du sprichst  fließend   Deutsch und Englisch', ADVERT), true, 'bullets and spacing do not matter');
  assert.equal(quoteIsReal('Fluent German is mandatory', ADVERT), false, 'an invented line is a hallucinated requirement');
  assert.equal(quoteIsReal('German', ADVERT), false, 'a bare word proves nothing');
});

test('only a read advert nobody has answered for is worth a call', () => {
  assert.equal(isCheckable(job()), true);
  assert.equal(isCheckable(job({ descriptionText: 'too short' })), false, 'an unread posting is parked, not judged');
  assert.equal(isCheckable(job({ verdict: { source: 'user' } })), false, 'the user\'s own pick outranks the model');
  assert.equal(isCheckable(job(), { decided: new Set(['f1']) }), false, 'already applied or turned down');
});

test('a cached "required" drops the posting and says why', () => {
  writeCache({ f1: { h: stampOf(job(), profile), german: 'required', quote: 'Du sprichst fließend Deutsch und Englisch' } });
  const d = cachedDrop(job(), profile);
  assert.equal(d.category, 'language');
  assert.match(d.reason, /German required/);
});

test('"a plus" is not a demand, and an answer goes stale with the advert or the level', () => {
  writeCache({ f1: { h: stampOf(job(), profile), german: 'nice_to_have', quote: '' } });
  assert.equal(cachedDrop(job(), profile), null);

  writeCache({ f1: { h: stampOf(job(), profile), german: 'required', quote: 'x' } });
  assert.equal(cachedDrop(job({ descriptionText: ADVERT + ' edited' }), profile), null, 'a changed advert asks again');
  assert.equal(cachedDrop(job(), { ...profile, languages: { germanLevel: 'B2' } }), null, 'a raised level asks again');
});

test('a dry run or replay answers from the cache and sends nothing', async () => {
  writeCache({ f1: { h: stampOf(job(), profile), german: 'required', quote: 'Du sprichst fließend Deutsch und Englisch' } });
  const before = readFileSync(join(dir, 'german-checks.json'), 'utf8');
  const r = await checkGerman([job(), job({ fingerprint: 'f2' })], profile, { cacheOnly: true });
  assert.deepEqual([...r.dropped.keys()], ['f1']);
  assert.equal(r.calls, 0);
  assert.equal(r.unchecked, 1, 'the unasked one is left unchecked, not guessed');
  assert.equal(readFileSync(join(dir, 'german-checks.json'), 'utf8'), before, 'nothing written');
});

test('with no model configured nothing is dropped and nothing throws', async () => {
  writeCache({});
  const r = await checkGerman([job()], profile, {});
  assert.equal(r.dropped.size, 0);
  assert.equal(r.unchecked, 1);
});

test('the scan checks before memory is written, and a rejudge honours the answer', () => {
  const src = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
  assert.ok(src.indexOf('await checkGerman(') < src.indexOf('store.reconcile(state, passed)'), 'a posting must be checked before it is filed as new');
  assert.match(src, /germanDrop\(j, profile, germanCache\)/, 'rejudge must not restore a posting the model said demands German');
});
