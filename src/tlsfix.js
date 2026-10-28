import https from 'node:https';
import tls from 'node:tls';
import { readFileSync } from 'node:fs';
import { p } from './util.js';

/**
 * A server that sends its leaf certificate and NOT the intermediate above it.
 *
 * Browsers and curl repair this by following the certificate's "CA Issuers"
 * (AIA) link; Node does not, so `fetch()` fails with UNABLE_TO_VERIFY_LEAF_SIGNATURE
 * on a site that opens fine in a browser. `jobs.markant.com` is the case that
 * forced this: its six DevOps / SRE / Cloud Platform postings — the best finds
 * in the Beesite listing — were parked as "advert did not arrive" on every run.
 *
 * WHAT THIS IS NOT. Verification is never switched off. The missing intermediate
 * is supplied, the chain is still checked up to Node's own built-in roots, and
 * it is supplied for ONE HOST — an intermediate trusted globally would be a
 * standing decision about every site. Checked 2026-10-01: with the file below,
 * `jobs.markant.com` verifies (`authorized: true`) to the built-in root
 * "T-TeleSec GlobalRoot Class 2".
 *
 * WHY NOT NODE_EXTRA_CA_CERTS. It is read once at process start, so it would have
 * to be set by every launcher — the tray app, `npm run daily`, a bare
 * `node src/index.js` — and the one that forgets fails silently with a parked
 * posting. A per-host table next to the fetch cannot be forgotten.
 *
 * The intermediate is a PUBLIC certificate (from the leaf's own AIA URL,
 * http://crt.serverid.telesec.de/…) and EXPIRES 2027-08-02. When it does, the
 * symptom is the same parked postings; replace the file with the new one.
 */
export const INTERMEDIATES = {
  'jobs.markant.com': 'telekom-security-serverid-ov-class2-ca.pem',
};

const MAX_REDIRECTS = 4;

export const hostOf = (url) => { try { return new URL(url).hostname; } catch { return null; } };

/** Does this host need the missing intermediate supplied? */
export const needsFix = (url) => Object.hasOwn(INTERMEDIATES, hostOf(url) || '');

const caFor = (host) => [
  ...tls.rootCertificates,
  readFileSync(p('certs', INTERMEDIATES[host]), 'utf8'),
];

/**
 * `fetch()`-shaped GET for a host in INTERMEDIATES: resolves to a real Response
 * (`status`, `ok`, `headers`, `text()`), so the caller does not care which path
 * it took. `url` is set to where the redirects ended, which fetch also reports.
 */
export function fetchWithIntermediate(url, { headers = {}, signal } = {}, hops = 0) {
  const host = hostOf(url);
  if (!Object.hasOwn(INTERMEDIATES, host || '')) return fetch(url, { headers, signal });

  return new Promise((resolve, reject) => {
    const req = https.get(url, { ca: caFor(host), headers, signal }, (res) => {
      const status = res.statusCode || 0;
      const location = res.headers.location;

      if (status >= 300 && status < 400 && location && hops < MAX_REDIRECTS) {
        res.resume();
        const next = new URL(location, url).toString();
        // fetchWithIntermediate falls back to plain fetch for any other host.
        resolve(fetchWithIntermediate(next, { headers, signal }, hops + 1));
        return;
      }

      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('error', reject);
      res.on('end', () => {
        const h = new Headers();
        for (const [k, v] of Object.entries(res.headers)) if (v != null) h.set(k, Array.isArray(v) ? v.join(', ') : v);
        // A null-body status cannot carry a body in a Response.
        const body = [204, 205, 304].includes(status) ? null : Buffer.concat(chunks);
        const out = new Response(body, { status, headers: h });
        Object.defineProperty(out, 'url', { value: url });
        resolve(out);
      });
    });
    req.on('error', reject);
  });
}
