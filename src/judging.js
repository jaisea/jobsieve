import * as awaiting from './awaiting.js';
import * as batches from './batches.js';
import * as keystate from './keystate.js';

/**
 * What is waiting to be judged, in one answer.
 *
 * Two different things can be waiting, and a person only cares that "something is
 * not judged yet":
 *
 *   - postings the MODEL has not answered (awaiting.js) — held by a rate limit and
 *     due again when it resets;
 *   - sources that were fetched but never judged (batches.js) — a scan was cut off
 *     between the two.
 *
 * The tray, the page and the app's scheduler all ask this, so they describe the same
 * wait in the same words and agree on when it is worth starting a judging run. It
 * reads two small files and nothing else, so it works under `npm run serve` too.
 */
export function status(now = new Date()) {
  const queue = awaiting.load();
  const d = awaiting.describe(queue, now);
  const owed = batches.list(batches.load()).map((o) => ({
    label: o.label, count: o.count, fetchedAt: o.fetchedAt, stuck: batches.stuck(o),
  }));

  const lines = [];
  if (d.waiting) lines.push(d.text);
  for (const o of owed) {
    lines.push(o.stuck
      ? `${o.label}: ${o.count} fetched postings could not be judged after repeated tries — run "Judge them now"`
      : `${o.label}: ${o.count} fetched posting${o.count === 1 ? '' : 's'} not judged yet — will be judged on the next run`);
  }

  // Money is being spent: the free project's quota is gone and judging has moved to the billed
  // one. The only thing here that costs anything, so it is said wherever waiting is said, for
  // as long as it is true — not left to a log line from a run nobody watched.
  const spent = keystate.judgeSpentUntil(keystate.load(), now);
  const billed = keystate.billedUsage(keystate.load(), now);
  if (spent) {
    lines.push(`Free daily quota spent — judging on the billed key (${keystate.describeUsage(billed)}; an estimate)`);
  }

  // Worth starting a run for right now: the model's wait is over, or a fetched batch can
  // be judged (a stuck one is not retried by itself).
  const due = awaiting.isDue(queue, now) || owed.some((o) => !o.stuck);
  return {
    waiting: d.waiting,
    scope: d.scope,
    resumeAt: d.resumeAt,
    owed,
    text: lines.join('\n'),
    due,
    billed: { ...billed, active: Boolean(spent) },
    any: d.waiting > 0 || owed.length > 0 || Boolean(spent),
  };
}
