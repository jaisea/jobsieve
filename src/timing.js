/**
 * Where a scan's time goes.
 *
 * A scan takes minutes, and "it is slow" is not something that can be fixed: which minutes
 * matter depends on whether a result is waiting behind them. So every batch says how long each
 * of its steps took and when it reached the page, and the scan ends with the totals.
 */

/** 380ms, 8.2s, 2m05s. */
export function fmtMs(ms) {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60000);
  return `${m}m${String(Math.round((ms % 60000) / 1000)).padStart(2, '0')}s`;
}

/** Lap times between named points. Laps under 50ms are left out of the text: they are noise. */
export function stopwatch(now = () => Date.now()) {
  let last = now();
  const laps = [];
  return {
    lap(name) {
      const t = now();
      laps.push([name, t - last]);
      last = t;
    },
    get laps() { return laps; },
    total: () => laps.reduce((a, [, ms]) => a + ms, 0),
    text: () => laps.filter(([, ms]) => ms >= 50).map(([name, ms]) => `${name} ${fmtMs(ms)}`).join(' · '),
  };
}
