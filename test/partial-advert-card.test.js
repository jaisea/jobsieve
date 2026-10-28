/**
 * A job judged on a fragment must look different.
 *
 * Indeed alert mail, Adzuna's 500-character teaser and the odd failed fetch leave a
 * posting whose advert was never read in full, so the language, programming and AWS
 * checks saw a fragment. The card said so only through a chip that depended on a flag
 * jobs.json does not keep — so on a card read from disk it never appeared. The card
 * now decides from the text it holds, and changes its look (not only a chip), so the
 * judgement of an unread posting is visibly the reader's own.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderQueue } from '../src/report.js';
import { MIN_DESCRIPTION_CHARS } from '../src/language.js';

import { readFileSync as read } from 'node:fs';
import { p, readJson } from '../src/util.js';
const profile = readJson(p('config', 'examples', 'devops.profile.json'));
const job = (text, over = {}) => ({
  fingerprint: 'abcd1234abcd1234', title: 'Cloud Engineer', company: 'X', location: 'Berlin', workMode: 'onsite',
  score: 50, source: 'mailalerts', applyUrl: 'https://example.invalid/1', descriptionText: text, matchedSkills: [],
  scoreBreakdown: [], ...over,
});
const html = (j) => renderQueue([{ ...j, band: 'main' }], profile).jobs[0].html;

test('a short advert marks the card, with no stored flag to rely on', () => {
  const h = html(job('x'.repeat(146)));
  assert.match(h, /class="job is-partial"/);
  assert.match(h, /Advert not fully available/);
  assert.match(h, /Description \(fragment\)/);
});

test('no advert at all is marked too', () => {
  assert.match(html(job('')), /is-partial/);
});

test('a read advert is not marked', () => {
  const h = html(job('y'.repeat(MIN_DESCRIPTION_CHARS)));
  assert.doesNotMatch(h, /is-partial/);
  assert.doesNotMatch(h, /Advert not fully available/);
});

test('the highlight is a different colour and font, not a chip alone', async () => {
  const { readFileSync } = await import('node:fs');
  const css = readFileSync(new URL('../src/report.js', import.meta.url), 'utf8');
  assert.match(css, /\.job\.is-partial h3 a\{color:var\(--warn\);font-style:italic\}/);
  assert.match(css, /\.job\.is-partial\{border-left:4px solid var\(--warn\)\}/);
});
