/**
 * A server that omits its intermediate certificate (jobs.markant.com). Node,
 * unlike a browser or curl, does not repair that, so its DevOps and SRE adverts
 * were parked on every run. The fix supplies the missing intermediate for ONE
 * host and must never weaken verification.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { X509Certificate } from 'node:crypto';

import { p } from '../src/util.js';
import { INTERMEDIATES, needsFix, hostOf } from '../src/tlsfix.js';

const SRC = readFileSync(p('src', 'tlsfix.js'), 'utf8');
const ENRICH = readFileSync(p('src', 'enrich.js'), 'utf8');

test('only the listed host gets the intermediate, nothing else', () => {
  assert.ok(needsFix('https://jobs.markant.com/index.php?ac=jobad&id=737'));
  assert.ok(!needsFix('https://markant.com/'));
  assert.ok(!needsFix('https://evil.example/jobs.markant.com'));
  assert.ok(!needsFix('https://jobs.markant.com.evil.example/'));
  assert.ok(!needsFix('not a url'));
  assert.equal(hostOf('https://jobs.markant.com/x'), 'jobs.markant.com');
});

test('verification is never switched off', () => {
  // The intermediate is supplied; the chain is still checked to a built-in root.
  // Executable lines only — the comment explains what is NOT done.
  const code = SRC.split('\n').filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join('\n');
  assert.doesNotMatch(code, /rejectUnauthorized/);
  assert.doesNotMatch(code, /NODE_TLS_REJECT_UNAUTHORIZED/);
  assert.match(code, /tls\.rootCertificates/, 'the built-in roots stay in the trust set');
});

test('every bundled intermediate is a real, unexpired CA certificate', () => {
  for (const [host, file] of Object.entries(INTERMEDIATES)) {
    const path = p('certs', file);
    assert.ok(existsSync(path), `${host}: ${file} is missing`);
    const cert = new X509Certificate(readFileSync(path));
    assert.ok(cert.ca, `${host}: ${file} is not a CA certificate`);
    // A certificate that has expired fails exactly as the missing one did —
    // silently, as parked postings — so say it here instead.
    assert.ok(new Date(cert.validTo) > new Date(), `${host}: ${file} expired ${cert.validTo}; replace it`);
  }
});

test('the advert fetch uses it, and other hosts keep the ordinary fetch', () => {
  assert.match(ENRICH, /needsFix\(url\) \? fetchWithIntermediate : fetch/);
});
