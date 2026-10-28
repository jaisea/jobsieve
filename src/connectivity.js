/**
 * Is there an internet connection — which is not the same as "did this fetch fail".
 *
 * A fetch that fails with no connection and one that fails with a connection are
 * different events, and treating them alike was costly. A scan started right after
 * sleep or login, before Wi-Fi was back, recorded every source as attempted: each
 * went onto a 30-minute retry, and the two metered sources had a run charged to
 * their quota for requests that never left the machine. JSearch gets one run a day,
 * so one early scan could cost the whole day.
 *
 * So "offline" is asked separately, and when it is true nothing is recorded at all:
 * the sources stay due and the app waits for a connection instead of a timer.
 *
 * It asks a web server rather than the network adapter. An adapter reports "connected"
 * to a router with no uplink, a VPN that has not come up, a hotel page that wants a
 * login — all of which fail every fetch. Any HTTP response at all, even a redirect,
 * proves a server was reached.
 */

/**
 * Two independent endpoints, so one being down does not read as "offline". The first
 * is the address Windows itself uses to decide whether you are online.
 */
export const PROBES = [
  'https://www.msftconnecttest.com/connecttest.txt',
  'https://cloudflare.com/cdn-cgi/trace',
];

/**
 * Overridable for testing — pointing it at a dead address makes the app believe it
 * is offline without touching the real connection. Read when called, never at load.
 */
const probeList = (probes) => {
  if (probes) return probes;
  const env = process.env.JOBHUNT_CONNECTIVITY_PROBES;
  return env ? env.split(',').map((s) => s.trim()).filter(Boolean) : PROBES;
};

/** True if ANY probe gets any HTTP response within the timeout. */
export async function isOnline({ timeoutMs = 4000, probes, fetchImpl = fetch } = {}) {
  const tries = probeList(probes).map(async (url) => {
    // `manual` so a captive portal's redirect counts as a response instead of being followed.
    const res = await fetchImpl(url, { redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
    await res.body?.cancel?.();
    return true;
  });
  try {
    await Promise.any(tries);
    return true;
  } catch {
    return false;
  }
}
