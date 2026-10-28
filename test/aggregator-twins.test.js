/**
 * The employer's posting and an aggregator's copy of it are one job.
 *
 * Himalayas links to its own page (which redirects to the employer behind a
 * Cloudflare challenge) and gives a region for a location, so its copy of "Senior
 * SRE (DevTools)" at Nebius never matched the Greenhouse posting already applied to.
 * Measured over 10,110 stored postings: employers post one template per CITY, so
 * company + title + a similar advert is routine for distinct postings of one source
 * (Elastic, Datadog, HelloFresh). Only a different source with an aggregator on one
 * side is a twin — and a missing advert means no merge, because showing a job twice
 * is cheaper than hiding one.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { reconcile } from '../src/store.js';
import { twinKey, advertSimilarity } from '../src/twins.js';

const ADVERT = Array.from({ length: 80 }, (_, i) => `responsibility${i % 40} keeps platform${i} reliable`).join(' ');
const blank = () => ({ seen: {}, jobs: {} });
const job = (over) => ({
  fingerprint: 'aaaa000000000000', title: 'Senior Site Reliability Engineer (DevTools)', company: 'Nebius',
  location: 'Amsterdam', applyUrl: 'https://careers.nebius.com/?gh_jid=1', descriptionText: ADVERT,
  source: 'ats', id: 'ats:greenhouse:nebius:1', ...over,
});
const himalayas = (over) => job({
  fingerprint: 'bbbb111111111111', location: 'Germany', source: 'himalayas',
  applyUrl: 'https://himalayas.app/companies/nebius/jobs/x', id: 'himalayas:https://himalayas.app/companies/nebius/jobs/x', ...over,
});

test('the aggregator copy of a filed posting is not a new job, and the decision stands', () => {
  const st = blank();
  reconcile(st, [job()]);
  st.seen.aaaa000000000000.status = 'applied';

  const r = reconcile(st, [himalayas()]);

  assert.equal(r.fresh.length, 0);
  assert.equal(st.seen.bbbb111111111111, undefined, 'no second record');
  assert.equal(st.seen.aaaa000000000000.status, 'applied');
  assert.deepEqual(st.seen.aaaa000000000000.alsoKnownAs, ['bbbb111111111111']);
  assert.equal(r.drifted[0].twin, true, 'reported, not absorbed silently');
});

test('the same pair arriving in one run in either order collapses to one', () => {
  const st = blank();
  const r = reconcile(st, [himalayas(), job()]);
  assert.equal(Object.keys(st.seen).length, 1);
  assert.equal(r.fresh.length, 1);
});

test('the employer link replaces the aggregator page it only redirected through', () => {
  const st = blank();
  reconcile(st, [himalayas()]);
  reconcile(st, [job({ descriptionText: ADVERT })]);
  assert.equal(Object.values(st.jobs)[0].applyUrl, 'https://careers.nebius.com/?gh_jid=1');
});

test('two postings of ONE source in different cities stay apart, however alike the advert', () => {
  const st = blank();
  const r = reconcile(st, [
    job({ fingerprint: 'c1', location: 'Dublin', id: 'ats:greenhouse:elastic:1' }),
    job({ fingerprint: 'c2', location: 'Madrid', id: 'ats:greenhouse:elastic:2' }),
  ]);
  assert.equal(Object.keys(st.seen).length, 2);
  assert.equal(r.fresh.length, 2);
});

test('two non-aggregator sources are not merged on this rule', () => {
  const st = blank();
  reconcile(st, [job()]);
  reconcile(st, [job({ fingerprint: 'dddd', source: 'arbeitnow', id: 'arbeitnow:9', location: 'Berlin' })]);
  assert.equal(Object.keys(st.seen).length, 2);
});

test('no advert on either side means no merge', () => {
  const st = blank();
  reconcile(st, [job()]);
  const r = reconcile(st, [himalayas({ descriptionText: '' })]);
  assert.equal(r.fresh.length, 1);
  assert.equal(Object.keys(st.seen).length, 2);
});

test('a different advert under the same title is a different job', () => {
  const st = blank();
  reconcile(st, [job()]);
  const other = Array.from({ length: 80 }, (_, i) => `unrelated${i} wording${i * 3} here${i}`).join(' ');
  reconcile(st, [himalayas({ descriptionText: other })]);
  assert.equal(Object.keys(st.seen).length, 2);
});

test('a different team in the parentheses is a different role', () => {
  assert.notEqual(twinKey({ company: 'Nebius', title: 'Senior SRE (DevTools)' }), twinKey({ company: 'Nebius', title: 'Senior SRE (Agentic Search)' }));
  assert.equal(twinKey({ company: 'Foo GmbH', title: 'DevOps Engineer (m/w/d)' }), twinKey({ company: 'Foo', title: 'DevOps Engineer' }));
});

test('a short advert cannot be judged', () => {
  assert.equal(advertSimilarity('too short', ADVERT), null);
});
