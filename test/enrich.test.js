/**
 * Fetching the real description.
 *
 * Aggregators return a teaser — Adzuna cuts at exactly 500 characters — so the
 * German, programming and AWS checks were reading text they had never seen.
 * The ad pages publish a schema.org JobPosting in ld+json, which is the
 * publisher's own description rather than whatever a tag-strip scrapes off the
 * page furniture.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { p } from '../src/util.js';

import { extractDescription, enrich } from '../src/enrich.js';

const page = (blocks) => `<html><head>${blocks}</head><body>
  <nav>Top-Arbeitgeber Amazon Deutsche Bahn Rewe</nav>
  <footer>Ähnliche Jobs · Berlin Hamburg München</footer></body></html>`;

const ld = (obj) => `<script type="application/ld+json">${JSON.stringify(obj)}</script>`;

test('the description comes from the JobPosting, not the page furniture', () => {
  // A naive tag-strip returned "Top-Arbeitgeber Amazon Deutsche Bahn" and found
  // "Deutsche" in it — page chrome masquerading as a German requirement.
  const html = page(ld({
    '@type': 'JobPosting',
    title: 'DevOps Engineer',
    description: '<p>Wir suchen. <b>Verhandlungssichere</b> Deutschkenntnisse.</p>',
  }));

  const r = extractDescription(html);
  assert.match(r.text, /Verhandlungssichere Deutschkenntnisse/);
  assert.doesNotMatch(r.text, /Top-Arbeitgeber|Ähnliche Jobs/);
  assert.doesNotMatch(r.text, /<p>|<b>/, 'html is stripped');
});

test('all three ld+json shapes are handled', () => {
  const desc = 'Full description text here.';
  const shapes = {
    bare: ld({ '@type': 'JobPosting', description: desc }),
    array: ld([{ '@type': 'BreadcrumbList' }, { '@type': 'JobPosting', description: desc }]),
    graph: ld({ '@graph': [{ '@type': 'Organization' }, { '@type': 'JobPosting', description: desc }] }),
  };
  for (const [name, block] of Object.entries(shapes)) {
    assert.equal(extractDescription(page(block))?.text, desc, name);
  }
});

test('a page without a JobPosting yields nothing rather than junk', () => {
  // LinkedIn alert links and some employer pages have no structured data.
  // Returning the page text would poison every check with navigation chrome.
  assert.equal(extractDescription(page(ld({ '@type': 'BreadcrumbList' }))), null);
  assert.equal(extractDescription(page('')), null);
  assert.equal(extractDescription(page('<script type="application/ld+json">{not json</script>')), null);
});

test('a shorter fetched description never replaces a longer one', async () => {
  // Some pages carry a summary thinner than what the aggregator supplied.
  // Overwriting would make the checks worse, which is the opposite of the point.
  const jobs = [
    { fingerprint: 'a', applyUrl: 'https://x/a', descriptionText: 'x'.repeat(3000) },
    { fingerprint: 'b', applyUrl: 'https://x/b', descriptionText: 'y'.repeat(100) },
  ];
  const cache = {
    a: { text: 'short summary' },
    b: { text: 'z'.repeat(4000) },
  };

  const r = await enrich(jobs, { cache });
  assert.equal(r.descriptions.a, undefined, 'the longer original is kept');
  assert.equal(r.descriptions.b.length, 4000, 'the fuller text wins');
  assert.equal(r.improved, 1);
});

test('cached entries are never re-fetched, failures included', async () => {
  // A page that blocks us must not be retried on every run for weeks.
  const jobs = [
    { fingerprint: 'ok', applyUrl: 'https://x/1', descriptionText: '' },
    { fingerprint: 'bad', applyUrl: 'https://x/2', descriptionText: '' },
  ];
  const cache = { ok: { text: 'full text' }, bad: { error: 'HTTP 403' } };

  const r = await enrich(jobs, { cache });
  assert.equal(r.fetched, 0);
  assert.equal(r.cached, 2, 'no network call for either');
  assert.equal(r.descriptions.ok, 'full text');
  assert.equal(r.descriptions.bad, undefined);
});

test('a LinkedIn URL is read through the guest job card', () => {
  // LinkedIn publishes no ld+json, so every posting arriving from a job-alert
  // email had an empty description — 43 of 97 archived jobs. With no text the
  // language check cannot see a requirement, and one such advert read
  // "Du kommunizierst klar auf Deutsch" on the page while the tool showed it as
  // a match. Recovering the descriptions changed the German verdict on 16.
  const src = readFileSync(p('src', 'enrich.js'), 'utf8');
  assert.match(src, /jobs-guest\/jobs\/api\/jobPosting/, 'the guest card is the readable form');
  assert.match(src, /linkedInJobId/, 'and the id comes out of the tracking URL');

  // The rewrite must not touch anything else.
  const idOf = (u) => String(u || '').match(/\/jobs\/view\/(\d+)/)?.[1] || null;
  assert.equal(idOf('https://www.linkedin.com/comm/jobs/view/4451297755/?trackingId=abc'), '4451297755');
  assert.equal(idOf('https://www.linkedin.com/jobs/view/1234'), '1234');
  assert.equal(idOf('https://www.adzuna.de/details/5845114839'), null);
  assert.equal(idOf('https://boards.greenhouse.io/acme/jobs/999'), null);
});

test('LinkedIn is fetched at the same polite rate as every other host', () => {
  // It is a judgement call, not a free pass: LinkedIn's terms discourage
  // automated access. It runs only for postings the user was already emailed, and
  // through the same one-request-per-host gap as everything else.
  const src = readFileSync(p('src', 'enrich.js'), 'utf8');
  const fn = src.slice(src.indexOf('async function fetchOne'), src.indexOf('async function fetchOne') + 700);
  assert.match(fn, /await politeWait\(url\)/, 'the rate limiter must see the URL actually fetched');
});

test('a LinkedIn posting that has closed is recognised', () => {
  // The guest card says so twice: in prose and in a class name. The class is
  // the one to read — "No longer accepting applications" is translated, the
  // class is not. ed8b4cdf was in the queue at a score of 52 and had already
  // closed; it was rejected by hand as "other", because there was no better
  // reason to give.
  const src = readFileSync(p('src', 'enrich.js'), 'utf8');
  assert.match(src, /closed-job__flavor--closed/, 'the class marker must be read');
  assert.match(src, /no longer accepting applications/i, 'with the prose as a fallback');

  const looksClosed = (html) => /closed-job__flavor--closed|no longer accepting applications/i.test(String(html));
  assert.equal(looksClosed('<div class="closed-job closed-job__flavor--closed">'), true);
  assert.equal(looksClosed('<p>No longer accepting applications</p>'), true);
  assert.equal(looksClosed('<div class="jobs-apply-button">Apply</div>'), false);
});

/**
 * eFinancialCareers publishes no ld+json, and it is the source that suffered
 * most from that.
 *
 * Five Swiss postings reached the report unread and four were rejected by hand
 * in one sitting: onsite roles in Zurich at 87km and Geneva at 237km, two of
 * them plainly requiring German. Both complaints had ONE cause — the advert was
 * never read:
 *
 *   - the location gate SOFTENS for an unread onsite posting in a commutable
 *     country, because "onsite" is then an assumption from a resolved city
 *     rather than something the text said. Switzerland qualifies, so 87km and
 *     237km escalated instead of dropping.
 *   - German graded `unknown`, because there was nothing to grade.
 *
 * The advert was in the HTML the whole time: these are Angular pages, but the
 * server still renders the posting into a job-description container. Reading it
 * turns all four into certain drops — one of them on German B2, which is the
 * gate the reader exists to feed.
 *
 * 56 postings on file are cached as "no JobPosting structured data" from this
 * host, and all of them become readable.
 */
test('the eFinancialCareers advert is read from its own container', async () => {
  const { __testables } = await import('../src/enrich.js');
  const extract = __testables.extractEfc;
  assert.ok(extract, 'extractEfc must be exported for this to be testable');

  const advert = 'Senior DevOps Engineer Position bei unserem Kunden aus der Branche Bankwesen '
    + 'in Zuerich zu besetzen. Ihre Aufgaben: Entwickeln und Implementieren von '
    + 'Automatisierungsloesungen fuer Microsoft Entra ID und zugehoerige Dienste mittels '
    + 'Terraform, APIs und Skripting. Sehr gute Deutschkenntnisse erforderlich.';

  // Nested divs, as the real pages have — stopping at the first </div> returns
  // the opening sentence and nothing else.
  const page = '<main><div class="job-description component-bordered-container-section">'
    + '<div class="inner"><p>' + advert + '</p></div>'
    + '</div></main><footer>site navigation junk</footer>';

  const got = extract(page);
  assert.ok(got, 'the container must be found');
  assert.match(got.text, /Bankwesen/);
  assert.match(got.text, /Deutschkenntnisse erforderlich/, 'the whole advert, not the first sentence');
  assert.ok(!got.text.includes('site navigation junk'), 'and nothing past the container');
});

test('a container with only chrome in it is not an advert', () => {
  // The same floor the LinkedIn reader uses. A page that renders the wrapper
  // and nothing else must come back as "no text" so the posting is retried,
  // not judged on two words.
  return import('../src/enrich.js').then(({ __testables }) => {
    const page = '<div class="job-description"><span>Apply now</span></div>';
    assert.equal(__testables.extractEfc(page), null);
  });
});

test('the reader is wired in, and only for that host', () => {
  const src = readFileSync(p('src', 'enrich.js'), 'utf8');
  assert.match(src, /\|\| \(isEfc\(url\) \? extractEfc\(html\) : null\)/,
    'it must be tried after ld+json and the LinkedIn card, not instead of them');
  assert.match(src, /efinancialcareers/, 'and gated on the host');

  // Host-anchored, or "efinancialcareers" appearing anywhere in a URL would
  // route another site's pages through this reader.
  const m = src.match(/const isEfc = \(url\) => (\/.*?\/i)\.test/);
  assert.ok(m, 'isEfc must be a host test');
  const re = new Function('return ' + m[1])();
  assert.ok(re.test('www.efinancialcareers.de'));
  assert.ok(re.test('efinancialcareers.com'));
  assert.ok(!re.test('efinancialcareers.evil.test'), 'a lookalike host must not match');
});

/**
 * The advert step's cost is set by ONE host, and saying which is the useful
 * half.
 *
 * Requests are serial per host and overlap across hosts, so the wall clock is
 * not the total divided by the concurrency — it is the busiest host alone. That
 * was measured when the per-host queue went in: 864 fetches took 9.4 minutes,
 * and LinkedIn's 225 of them at a 2,500ms gap WERE those 9.4 minutes.
 *
 * Reporting the host matters because it is the only actionable part. Adding
 * concurrency cannot move the number — which is the mistake the old global
 * CONCURRENCY = 1 made from the other side.
 */
test('the estimate is set by the slowest host, not the busiest', async () => {
  const { fetchEstimate } = await import('../src/enrich.js');
  const many = (n, url) => Array.from({ length: n }, (_, i) => ({ applyUrl: url.replace('ID', i) }));

  const w = fetchEstimate([
    ...many(100, 'https://www.linkedin.com/comm/jobs/view/ID'),
    ...many(400, 'https://www.arbeitsagentur.de/jobsuche/jobdetail/ID'),
  ]);

  // 100 × 2500ms = 250s beats 400 × 400ms = 160s.
  assert.equal(w.host, 'www.linkedin.com');
  assert.equal(w.n, 100);
  assert.equal(w.gap, 2500);
  assert.equal(w.ms, 250000);
});

test('a LinkedIn tracking URL is counted against the guest card, where it is fetched', async () => {
  // The alert-email URL is linkedin.com/comm/..., but the request goes to the
  // guest-card endpoint. Counting the tracking host would still say LinkedIn
  // here, but only by luck — the estimate must follow the URL actually fetched,
  // as fetchOne does.
  const { fetchEstimate } = await import('../src/enrich.js');
  const w = fetchEstimate([{ applyUrl: 'https://www.linkedin.com/comm/jobs/view/4463393536/?trackingId=x' }]);
  assert.equal(w.host, 'www.linkedin.com');
  assert.equal(w.gap, 2500, 'and it must get the LinkedIn gap, not the default');
});

test('nothing to fetch estimates nothing', async () => {
  const { fetchEstimate } = await import('../src/enrich.js');
  assert.equal(fetchEstimate([]), null);
  assert.equal(fetchEstimate([{ applyUrl: '' }]), null, 'a posting with no URL is not a request');
});

test('the estimate reads as time, not as milliseconds', async () => {
  const { describeEta } = await import('../src/enrich.js');
  assert.equal(describeEta(30000), '~30s');
  assert.equal(describeEta(89000), '~89s');
  assert.equal(describeEta(95000), '~2 min');
  assert.equal(describeEta(600000), '~10 min');
});

test('it is printed before the fetching starts, and only when fetching', async () => {
  const src = readFileSync(p('src', 'enrich.js'), 'utf8');
  const line = src.indexOf('const w = fetchEstimate(need);');
  const pool = src.indexOf('await pool(need, CONCURRENCY');
  assert.ok(line > 0 && pool > line, 'an estimate after the work is a report, not an estimate');
  assert.match(src, /if \(need\.length && !offline\)/,
    'a replay fetches nothing and must not claim it will take time');
});

test('markup HTML-escaped inside the ld+json string is stripped, not left as literal tags', () => {
  // Markant's job pages write "&lt;p&gt;Unser Team…&lt;/p&gt;" into the JSON
  // string. One stripHtml() pass decodes the entities and so REVEALS the tags;
  // 52 of them were left in a 3,100-character advert before the second pass.
  const block = JSON.stringify({
    '@type': 'JobPosting', title: 'SRE',
    description: '&lt;p&gt;Unser Team betreibt &lt;strong&gt;Kubernetes&lt;/strong&gt;.&lt;/p&gt;&lt;ul&gt;&lt;li&gt;Terraform&lt;/li&gt;&lt;/ul&gt;',
  });
  const html = `<script type="application/ld+json">${block}</script>`;
  const text = extractDescription(html).text;
  assert.doesNotMatch(text, /<\/?[a-z]/i);
  assert.match(text, /Kubernetes/);
  assert.match(text, /Terraform/);
});

test('a description that merely contains a less-than sign is not mangled by the second pass', () => {
  const block = JSON.stringify({ '@type': 'JobPosting', title: 'x', description: 'Latency must stay < 200ms and error rate < 1%.' });
  const text = extractDescription(`<script type="application/ld+json">${block}</script>`).text;
  assert.match(text, /< 200ms/);
});

/* ------------------------------------------------ a host that refuses the run */

import { createServer } from 'node:http';
import { __testables as enrichInternals } from '../src/enrich.js';

async function withServer(handler, fn) {
  const hits = [];
  const srv = createServer((req, res) => { hits.push(req.url); handler(req, res); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try { return await fn(`http://127.0.0.1:${srv.address().port}`, hits); }
  finally { srv.close(); }
}
const jobsFor = (base, n) => Array.from({ length: n }, (_, i) =>
  ({ fingerprint: `fp-refuse-${i}`, applyUrl: `${base}/job/${i}`, title: `T${i}` }));

test('a host that answers a bot CHALLENGE is asked once, not once per posting', async () => {
  // Three Vercel boards did this; every queued posting slept out a 60s backoff,
  // asked again, was refused again and re-armed it. A run stalled for twelve
  // minutes with the CPU idle.
  enrichInternals.refused.clear(); enrichInternals.throttled.clear();
  await withServer((req, res) => { res.writeHead(429, { 'x-vercel-mitigated': 'challenge' }); res.end('challenge'); },
    async (base, hits) => {
      const cache = {};
      const t0 = Date.now();
      await enrich(jobsFor(base, 4), { cache });
      assert.equal(hits.length, 1, `the server was asked ${hits.length} times`);
      assert.ok(Date.now() - t0 < 8000, 'no 60-second backoff per posting');
      for (let i = 0; i < 4; i++) assert.match(cache[`fp-refuse-${i}`].error, /429/, 'every one is a transient failure, retried next run');
    });
  enrichInternals.refused.clear(); enrichInternals.throttled.clear();
});

test('a 429 with no Retry-After also leaves the host alone for the run', async () => {
  enrichInternals.refused.clear(); enrichInternals.throttled.clear();
  await withServer((req, res) => { res.writeHead(429); res.end(); }, async (base, hits) => {
    await enrich(jobsFor(base, 3), { cache: {} });
    assert.equal(hits.length, 1);
  });
  enrichInternals.refused.clear(); enrichInternals.throttled.clear();
});

test('a 429 that SAYS when to come back is waited out, not given up on', async () => {
  // LinkedIn's case: Retry-After is a promise that asking later works.
  enrichInternals.refused.clear(); enrichInternals.throttled.clear();
  await withServer((req, res) => { res.writeHead(429, { 'retry-after': '1' }); res.end(); }, async (base) => {
    await enrich(jobsFor(base, 1), { cache: {} });
    assert.ok(!enrichInternals.refused.has(new URL(base).host), 'a Retry-After host is throttled, not refused');
    assert.ok(enrichInternals.throttled.has(new URL(base).host));
  });
  enrichInternals.refused.clear(); enrichInternals.throttled.clear();
});
