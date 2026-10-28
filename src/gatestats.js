import { existsSync } from 'node:fs';
import { p, readJson, writeJson } from './util.js';

/**
 * How often each gate fires, per source, run after run.
 *
 * A gate fails by being fed the wrong input or by a vocabulary that stopped matching, and
 * both look the same from outside: a number that moved. Nothing watched those numbers. The
 * title gate drops 76.7% of everything fetched, so a vocabulary edit that took it to 80%
 * would throw away 3% of the corpus and leave no trace but a quieter report.
 *
 * The comparison is PER SOURCE, because the mix of sources changes from run to run (a
 * half-hourly scan may read only the inbox) and a shifting mix would move every share
 * without any gate changing. One source's shares against its own last run are comparable.
 *
 * "hard" is a certain drop, "soft" a posting the gate leaned against and sent to the model.
 * A posting failing several gates counts under each: this measures how often a gate FIRES,
 * which is what drift looks like, not which gate owned the verdict.
 */
const FILE = () => p('data', 'gate-stats.json');

/** A share must move by this many points, on at least MIN_POSTINGS each time, to be worth saying. */
export const SHIFT_POINTS = 3;
export const MIN_POSTINGS = 50;

export const emptyTally = () => ({ sources: {} });

/** Count one posting: the gates that failed it (an empty list is a posting that passed them all). */
export function tally(t, source, reasons = []) {
  const s = (t.sources[source || 'unknown'] ||= { postings: 0, gates: {} });
  s.postings++;
  for (const r of reasons) {
    const g = (s.gates[r.id] ||= { hard: 0, soft: 0 });
    if (r.certain) g.hard++; else g.soft++;
  }
  return t;
}

export const load = () => (existsSync(FILE()) ? readJson(FILE(), { version: 1, sources: {} }) || { version: 1, sources: {} } : { version: 1, sources: {} });

export function save(state) {
  writeJson(FILE(), { ...state, version: 1, savedAt: new Date().toISOString() });
}

/** Fold this run's tallies in, keeping each source's PREVIOUS figures so a change can be shown later. */
export function record(state, t, { now = new Date() } = {}) {
  for (const [source, cur] of Object.entries(t.sources)) {
    if (!cur.postings) continue;
    const prev = state.sources?.[source];
    state.sources = {
      ...state.sources,
      [source]: { at: now.toISOString(), postings: cur.postings, gates: cur.gates, previous: prev ? { at: prev.at, postings: prev.postings, gates: prev.gates } : null },
    };
  }
  return state;
}

const share = (n, total) => (total ? (100 * n) / total : 0);

/**
 * Gates whose share of a source moved noticeably since that source's last recorded run.
 * Only a source with enough postings on both sides is compared: a share of 12 postings is noise.
 */
export function shifts(state, t, { points = SHIFT_POINTS, min = MIN_POSTINGS } = {}) {
  const out = [];
  for (const [source, cur] of Object.entries(t.sources)) {
    const prev = state.sources?.[source];
    if (!prev || cur.postings < min || prev.postings < min) continue;
    const ids = new Set([...Object.keys(cur.gates), ...Object.keys(prev.gates)]);
    for (const id of ids) {
      for (const kind of ['hard', 'soft']) {
        const a = share(prev.gates[id]?.[kind] || 0, prev.postings);
        const b = share(cur.gates[id]?.[kind] || 0, cur.postings);
        if (Math.abs(b - a) >= points) out.push({ source, gate: id, kind, from: a, to: b, postings: cur.postings });
      }
    }
  }
  return out.sort((x, y) => Math.abs(y.to - y.from) - Math.abs(x.to - x.from));
}

/** One line per source: its biggest gates, as shares. */
export function describe(t, { top = 3 } = {}) {
  return Object.entries(t.sources)
    .filter(([, s]) => s.postings)
    .sort((a, b) => b[1].postings - a[1].postings)
    .map(([source, s]) => {
      const gates = Object.entries(s.gates)
        .sort((a, b) => b[1].hard - a[1].hard)
        .slice(0, top)
        .map(([id, g]) => `${id} ${share(g.hard, s.postings).toFixed(0)}%${g.soft ? ` (+${share(g.soft, s.postings).toFixed(0)}% asked)` : ''}`);
      return `${source}: ${s.postings} judged · ${gates.join(' · ') || 'no gate fired'}`;
    });
}

export const shiftText = (x) =>
  `${x.source}: "${x.gate}" ${x.kind === 'hard' ? 'drops' : 'asks about'} ${x.to.toFixed(0)}% of its postings, was ${x.from.toFixed(0)}%`;
