/**
 * Spending a metered API without ever going over.
 *
 * JSearch is ~200 requests a MONTH on the free tier. Four `npm run search`
 * invocations in one afternoon — three of them `--dry-run`, which writes nothing
 * but fetches everything — took it from comfortable to 95% used with ten days of
 * the cycle left. Nothing in the tool noticed, because nothing was counting.
 *
 * Three rules, in the order they bite:
 *
 *   1. A dry run does not touch a metered source at all. Testing must not spend
 *      a budget that exists for real searches. `--dry-run` promises to write
 *      nothing; it never promised to cost nothing, and it should.
 *   2. At most `maxRunsPerDay`. A source with a monthly budget gains nothing
 *      from being asked twice in an hour.
 *   3. A daily allowance PACED against what is left. Remaining budget divided by
 *      days remaining in the cycle, so the month cannot be spent in its first
 *      week. This is what actually keeps a free tier free.
 *
 * The ledger is written even on a dry run when a call did happen, because the
 * call happened. A quota record is not "memory" in the sense `--dry-run`
 * protects — it is the receipt for a side effect that already left the machine.
 */
import { p, readJson, writeJson, isoDay } from './util.js';

const FILE = () => p('data', 'quota.json');

export const load = () => readJson(FILE(), { version: 1, sources: {} });
export const save = (state) => writeJson(FILE(), { ...state, savedAt: new Date().toISOString() });

/**
 * Calls already spent before the tool started counting.
 *
 * Pinned to the cycle it describes — `{ cycle: '2026-08-14', calls: 190 }` —
 * because a bare number would be added again every month, forever, and the
 * source would throttle itself harder each cycle for a debt it had already
 * paid. Once the cycle rolls over the seed stops applying on its own, so there
 * is nothing to remember to delete.
 */
function seeded(quota, cycleStartDay) {
  const a = quota?.assumeUsed;
  if (!a) return 0;
  if (typeof a === 'number') return 0;              // unpinned: ignored on purpose
  return a.cycle === cycleStartDay ? (Number(a.calls) || 0) : 0;
}

/**
 * When did the current billing cycle start?
 *
 * RapidAPI meters from the day you subscribed, not from the first of the month,
 * so `cycleResetsOnDay` is the day-of-month the subscription was taken out.
 * Falls back to calendar months when it is not configured.
 */
export function cycleStart(resetsOnDay, now = new Date()) {
  const day = Number(resetsOnDay);
  const d = new Date(now);
  if (!Number.isFinite(day) || day < 1 || day > 28) {
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
  }
  const thisMonth = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), day));
  if (thisMonth <= d) return thisMonth;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, day));
}

/** Whole days from `now` until the cycle rolls over. At least one. */
export function daysLeftInCycle(resetsOnDay, now = new Date()) {
  const start = cycleStart(resetsOnDay, now);
  const next = new Date(start);
  next.setUTCMonth(next.getUTCMonth() + 1);
  return Math.max(1, Math.ceil((next - now) / 86400000));
}

/**
 * What this source may spend right now.
 *
 * Returns `{ allowed, calls, reason }`. `calls` is how many requests it may
 * make — a source is handed this as its `maxQueries`, so it throttles itself
 * rather than being cut off mid-flight.
 */
export function budgetFor(state, key, quota, { dryRun = false, now = new Date() } = {}) {
  if (!quota) return { allowed: true, calls: null, reason: null };

  // A DAILY allowance is a different animal from a monthly one. Adzuna gives
  // 250 a day and resets overnight, so overspending costs one afternoon; JSearch
  // gives 200 a month, so overspending costs three weeks. Only the second is
  // worth refusing a dry run over — skipping Adzuna while testing would change
  // what the pipeline sees for no real saving.
  const skipDry = quota.skipOnDryRun ?? Boolean(quota.perMonth);
  if (dryRun && skipDry) {
    return { allowed: false, calls: 0, reason: 'metered API, and this is a dry run' };
  }

  const rec = state.sources?.[key] || {};
  const start = cycleStart(quota.cycleResetsOnDay, now).toISOString().slice(0, 10);
  const cycle = rec.cycleStart === start ? rec : { cycleStart: start, used: 0, days: {} };

  const today = isoDay(now);
  const runsToday = cycle.days?.[today]?.runs || 0;
  const maxRuns = quota.maxRunsPerDay ?? 1;
  if (runsToday >= maxRuns) {
    return { allowed: false, calls: 0, reason: `already ran ${runsToday}x today (max ${maxRuns})` };
  }

  // A daily cap needs no pacing — it refills tomorrow. Just do not exceed it.
  const perDay = Number(quota.perDay);
  if (Number.isFinite(perDay)) {
    const spentToday = cycle.days?.[today]?.calls || 0;
    const leftToday = perDay - spentToday;
    if (leftToday <= 0) {
      return { allowed: false, calls: 0, reason: `daily limit reached (${spentToday}/${perDay})` };
    }
    if (!Number.isFinite(Number(quota.perMonth))) {
      return {
        allowed: true,
        calls: quota.maxQueries ?? null,
        reason: null,
        note: spentToday ? `${leftToday} of ${perDay} left today` : null,
      };
    }
  }

  const budget = Number(quota.perMonth);
  if (!Number.isFinite(budget)) return { allowed: true, calls: quota.maxQueries ?? null, reason: null };

  const used = (cycle.used || 0) + seeded(quota, start);
  const left = budget - used;
  if (left <= 0) {
    return { allowed: false, calls: 0, reason: `monthly budget spent (${used}/${budget})` };
  }

  // Pace it. Spending what is left evenly over the days that remain is what
  // stops a month disappearing in an afternoon.
  const days = daysLeftInCycle(quota.cycleResetsOnDay, now);
  const paced = Math.max(1, Math.floor(left / days));
  const calls = Math.min(paced, quota.maxQueries ?? paced, left);

  return {
    allowed: true,
    calls,
    reason: null,
    note: `${left} of ${budget} left, ${days}d to go — ${calls} call${calls === 1 ? '' : 's'} today`,
  };
}

/** Record what a source actually spent. */
export function record(state, key, quota, spent, { now = new Date() } = {}) {
  // The RUN is counted even when the spend is zero or unknown. Not every source
  // reports how many requests it made, and `maxRunsPerDay` has to work for
  // those too — otherwise a source that stays quiet is never throttled, which
  // is the opposite of what a budget is for.
  if (!quota) return state;
  const calls = Number(spent) || 0;
  const start = cycleStart(quota.cycleResetsOnDay, now).toISOString().slice(0, 10);
  const prev = state.sources?.[key];
  const cycle = prev?.cycleStart === start ? prev : { cycleStart: start, used: 0, days: {} };
  const today = isoDay(now);

  cycle.used = (cycle.used || 0) + calls;
  cycle.days = { ...cycle.days };
  cycle.days[today] = {
    runs: (cycle.days[today]?.runs || 0) + 1,
    calls: (cycle.days[today]?.calls || 0) + calls,
  };
  cycle.lastRunAt = now.toISOString();

  // Only the last few days are worth keeping; the cycle total is the number
  // that matters and it is held separately.
  const keep = Object.keys(cycle.days).sort().slice(-14);
  cycle.days = Object.fromEntries(keep.map((d) => [d, cycle.days[d]]));

  state.sources = { ...state.sources, [key]: cycle };
  return state;
}

/** Human-readable state, for `npm run keys` and the report banner. */
export function describe(state, key, quota, now = new Date()) {
  if (!quota?.perMonth) return null;
  const start = cycleStart(quota.cycleResetsOnDay, now).toISOString().slice(0, 10);
  const rec = state.sources?.[key];
  const used = (rec?.cycleStart === start ? rec.used : 0) + seeded(quota, start);
  const days = daysLeftInCycle(quota.cycleResetsOnDay, now);
  return `${used}/${quota.perMonth} used this cycle (began ${start}, ${days}d left)`;
}
