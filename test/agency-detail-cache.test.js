/**
 * The recruiting agency's detail pages are read once a week, not every scan.
 *
 * This source took 6m27s of a 14m37s scan to return 178 postings: the site answers in about two
 * seconds, the per-host gap is on top, and every scan re-read up to 120 detail pages whose text
 * had not changed. The page is the advert, so it is kept as long as every other advert (7 days).
 */
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DIR = mkdtempSync(join(tmpdir(), 'jobhunt-agency-'));
process.env.JOBHUNT_DATA_DIR = DIR;
after(() => rmSync(DIR, { recursive: true, force: true }));

const { fetchJobs, __testables } = await import('../src/sources/agencies.js');
const { DETAIL_MAX_AGE_DAYS } = __testables;
const FILE = join(DIR, 'agency-details.json');

const card = (id, title) => `<a href="https://www.apriori.de/job-finden/job/${id}/" class="item"><span class="item-content"><h3>${title}</h3><p>IT <span class="dot">·</span> Permanent</p></span></a>`;
const detail = (loc, text) => `<script type="application/ld+json">${JSON.stringify({
  '@type': 'JobPosting', description: `<p>${text}</p>`, datePosted: '2026-10-01',
  jobLocation: { address: { addressLocality: loc, addressRegion: 'BW' } },
})}</script>`;

/** A fake site: a listing of `ids`, a detail page per id, and a count of what was asked for. */
function site(ids, { broken = [] } = {}) {
  const asked = { list: 0, detail: [] };
  const get = async (url) => {
    if (url.includes('/job-finden/job/')) {
      const id = url.match(/job\/(\d+)/)[1];
      asked.detail.push(id);
      if (broken.includes(id)) return { ok: false, status: 503 };
      return { ok: true, text: detail('München', `Kubernetes advert ${id}`) };
    }
    asked.list++;
    return { ok: true, text: ids.map((id) => card(id, `DevOps Engineer ${id}`)).join('') };
  };
  return { get, asked };
}

const run = (s, extra = {}) => fetchJobs({ queries: ['devops'], get: s.get, ...extra });

beforeEach(() => rmSync(FILE, { force: true }));

test('the first scan reads every detail page, the next reads none', async () => {
  const first = site(['1', '2', '3']);
  const a = await run(first);
  assert.deepEqual(first.asked.detail.sort(), ['1', '2', '3']);
  assert.equal(a.jobs.length, 3);
  assert.equal(a.jobs[0].location, 'München, BW');
  assert.match(a.jobs[0].descriptionText, /Kubernetes advert/);

  const second = site(['1', '2', '3']);
  const b = await run(second);
  assert.deepEqual(second.asked.detail, [], 'not one detail page was requested');
  assert.ok(second.asked.list > 0, 'but the LISTING is still read: that is how a new posting is found');
  assert.deepEqual(b.jobs.map((j) => j.descriptionText), a.jobs.map((j) => j.descriptionText), 'and the postings are identical');
  assert.deepEqual(b.jobs.map((j) => j.location), ['München, BW', 'München, BW', 'München, BW']);
  assert.ok(b.notes.some((n) => /3 detail pages from the cache, 0 fetched/.test(n)));
});

test('only the NEW posting costs a request', async () => {
  await run(site(['1', '2']));
  const s = site(['1', '2', '3']);
  const r = await run(s);
  assert.deepEqual(s.asked.detail, ['3']);
  assert.equal(r.jobs.length, 3);
});

test('an advert is a living document: after a week it is read again', async () => {
  await run(site(['1']));
  const stored = JSON.parse(readFileSync(FILE, 'utf8'));
  stored.entries['apriori:1'].at = new Date(Date.now() - (DETAIL_MAX_AGE_DAYS + 1) * 86400000).toISOString();
  writeFileSync(FILE, JSON.stringify(stored));

  const s = site(['1']);
  await run(s);
  assert.deepEqual(s.asked.detail, ['1']);
});

test('a page that could not be read is NOT remembered: it is asked for again next scan', async () => {
  const bad = site(['1', '2'], { broken: ['2'] });
  const r = await run(bad);
  assert.ok(r.errors.some((e) => /detail apriori:2: HTTP 503/.test(e)));
  const again = site(['1', '2']);
  await run(again);
  assert.deepEqual(again.asked.detail, ['2'], 'only the one that failed');
});

test('the ceiling counts REQUESTS, so cached postings never use up the allowance of one that needs fetching', async () => {
  // Seed the cache with 3 postings, then list 3 cached + 2 new. A ceiling of postings (not
  // requests) would have starved the new ones.
  await run(site(['1', '2', '3']));
  const s = site(['1', '2', '3', '4', '5']);
  const r = await run(s);
  assert.deepEqual(s.asked.detail.sort(), ['4', '5']);
  assert.equal(r.jobs.length, 5);
  assert.ok(!r.errors.some((e) => /ceiling/.test(e)));
});

test('a dry run writes nothing', async () => {
  await run(site(['1']), { persist: false });
  assert.equal(existsSync(FILE), false);
});

test('entries older than the limit are pruned, so the file does not grow for ever', async () => {
  await run(site(['1', '2']));
  const stored = JSON.parse(readFileSync(FILE, 'utf8'));
  stored.entries['apriori:gone'] = { at: new Date(Date.now() - 30 * 86400000).toISOString(), location: '', descriptionText: 'x', postedAt: null };
  writeFileSync(FILE, JSON.stringify(stored));
  await run(site(['1', '2', '3']));    // writes (a new posting), which prunes
  const after = JSON.parse(readFileSync(FILE, 'utf8'));
  assert.deepEqual(Object.keys(after.entries).sort(), ['apriori:1', 'apriori:2', 'apriori:3']);
});

test('the cache keeps the text, not the markup', async () => {
  await run(site(['1']));
  const e = JSON.parse(readFileSync(FILE, 'utf8')).entries['apriori:1'];
  assert.equal(e.descriptionHtml, '');
  assert.match(e.descriptionText, /Kubernetes advert 1/);
});
