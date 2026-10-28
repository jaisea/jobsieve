/**
 * Recognising a job board from whatever URL you happen to have.
 *
 * You should not need to know whether an employer runs Greenhouse or Workday
 * before you can add it — the URL in your address bar is what you have, so the
 * tool works backwards from that.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { fromUrl, SUPPORTED } from '../src/sources/detect.js';
import { __testables } from '../src/sources/workday.js';

const { parseWorkdayUrl } = __testables;

test('each supported platform is recognised from its board URL', () => {
  const cases = [
    ['https://boards.greenhouse.io/datadog', 'greenhouse', 'datadog'],
    ['https://job-boards.greenhouse.io/sumup/jobs/12345', 'greenhouse', 'sumup'],
    ['https://jobs.lever.co/plaid/abc-123', 'lever', 'plaid'],
    ['https://jobs.ashbyhq.com/supabase/some-role', 'ashby', 'supabase'],
    ['https://careers.smartrecruiters.com/HaufeGroup', 'smartrecruiters', 'HaufeGroup'],
    ['https://personio.recruitee.com/o/devops', 'recruitee', 'personio'],
  ];
  for (const [url, ats, slug] of cases) {
    const hit = fromUrl(url);
    assert.ok(hit, `${url} not recognised`);
    assert.equal(hit.ats, ats, url);
    assert.equal(hit.slug, slug, url);
  }
});

test('the Greenhouse embed form is recognised too', () => {
  // Companies embedding a board on their own page use this shape; missing it
  // would send an otherwise-findable company down the fetch-the-page path.
  const hit = fromUrl('https://boards.greenhouse.io/embed/job_board?for=celonis');
  assert.equal(hit.ats, 'greenhouse');
  assert.equal(hit.slug, 'celonis');
});

test('a Workday URL yields tenant, pod and site', () => {
  const hit = fromUrl('https://roche.wd3.myworkdayjobs.com/en-US/roche-ext');
  assert.equal(hit.ats, 'workday');
  assert.deepEqual(hit.board, { tenant: 'roche', pod: 'wd3', site: 'roche-ext' });
});

test('the Workday locale segment is optional and ignored', () => {
  // Both forms occur in the wild depending on how you arrived at the page.
  const withLocale = parseWorkdayUrl('https://novartis.wd3.myworkdayjobs.com/en-US/Novartis_Careers');
  const without = parseWorkdayUrl('https://novartis.wd3.myworkdayjobs.com/Novartis_Careers');
  assert.deepEqual(withLocale, without);
});

test('a deep link to one job still identifies the board', () => {
  // This is the URL you actually have after clicking a posting.
  const hit = fromUrl('https://roche.wd3.myworkdayjobs.com/roche-ext/job/Basel/Principal-Site-Reliability-Engineer_202605-112449-2');
  assert.equal(hit.ats, 'workday');
  assert.equal(hit.board.tenant, 'roche');
  assert.equal(hit.board.site, 'roche-ext');
});

test('a plain company careers page is not guessed at', () => {
  // These have to go through fromPage(); inventing a slug from the domain would
  // produce boards that do not exist.
  for (const url of [
    'https://www.sick.com/de/en/career',
    'https://careers.roche.com/global/en/search-results',
    'https://example.com',
  ]) {
    assert.equal(fromUrl(url), null, url);
  }
});

test('every supported platform has a pattern', () => {
  for (const ats of SUPPORTED) {
    const sample = {
      greenhouse: 'https://boards.greenhouse.io/x',
      lever: 'https://jobs.lever.co/x',
      ashby: 'https://jobs.ashbyhq.com/x',
      smartrecruiters: 'https://careers.smartrecruiters.com/x',
      recruitee: 'https://x.recruitee.com',
      workday: 'https://x.wd3.myworkdayjobs.com/en-US/y',
      bamboohr: 'https://x.bamboohr.com/careers',
      breezy: 'https://x.breezy.hr',
      // Personio is recognised here but is NOT in the ATS table — its feed is
      // XML, so it has its own source module. `discover --add` should still
      // name it rather than shrugging at a Personio careers link.
      personio: 'https://x.jobs.personio.de/',
    }[ats];
    assert.ok(sample, `${ats} is advertised as supported but has no sample`);
    assert.equal(fromUrl(sample)?.ats, ats, `${ats} advertised but not matched`);
  }
});
