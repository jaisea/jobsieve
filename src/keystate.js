import { p, readJson, writeJson } from './util.js';

/**
 * What the tool remembers about the two Gemini projects between runs.
 *
 * Two facts, both about the overflow from the free judging project to the billed one
 * (see `complete()` in providers/gemini.js):
 *
 *   judgeSpentUntil   the free project's daily quota is spent until this moment (the next
 *                     midnight Pacific). Without it every run would open by asking the spent
 *                     project — two refused calls, since a 429 is retried once — before
 *                     switching.
 *   billed[YYYY-MM]   how many calls were answered by the billed project that month. This is
 *                     the only thing the tool does that costs money, so it keeps its own
 *                     count where the page, the tray and `npm run keys` can show it, rather
 *                     than leaving it as a line in a log nobody is reading.
 *
 * The count is of calls that SUCCEEDED on the billed key. A refused request is not charged.
 */
const FILE = () => p('data', 'llm-keys.json');

/**
 * About what one judging call costs on `gemini-flash-lite`, from the figure the profile has
 * always carried ("~$0.0003 a call"). An ESTIMATE, labelled as one wherever it is shown:
 * the real bill is Google's, and prices change.
 */
export const EST_USD_PER_CALL = 0.0003;

export const load = () => readJson(FILE(), {}) || {};
export const save = (state) => writeJson(FILE(), state);

/** UTC, so a month boundary is the same moment for every process. */
export const monthKey = (now = new Date()) => now.toISOString().slice(0, 7);

export function judgeSpentUntil(state = load(), now = new Date()) {
  const at = state.judgeSpentUntil ? new Date(state.judgeSpentUntil) : null;
  return at && at > now ? at : null;
}

export function markJudgeSpent(until) {
  const state = load();
  state.judgeSpentUntil = new Date(until).toISOString();
  save(state);
  return state;
}

/** One call was answered (and charged) by the billed project. */
export function countBilled(n = 1, now = new Date()) {
  const state = load();
  const month = monthKey(now);
  state.billed = { ...(state.billed || {}), [month]: ((state.billed || {})[month] || 0) + n };
  save(state);
  return state.billed[month];
}

export function billedUsage(state = load(), now = new Date()) {
  const month = monthKey(now);
  const calls = (state.billed || {})[month] || 0;
  return { month, calls, usd: calls * EST_USD_PER_CALL };
}

export const describeUsage = ({ calls, usd }) =>
  `${calls} call${calls === 1 ? '' : 's'} this month, about $${usd < 0.01 && calls ? '<0.01' : usd.toFixed(2)}`;
