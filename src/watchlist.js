import { existsSync } from 'node:fs';
import { p, readJson, writeJson, slug } from './util.js';

/**
 * The company watchlist — who you want to hear from, and whether you actually
 * would.
 *
 * Board configuration alone is not coverage. Three local employers had boards
 * recorded and looked "covered", but each served
 * exactly ONE posting: the board exists as a stub while the real listings live
 * on a platform the tool cannot read. Meanwhile sixteen local employers had
 * never produced a single posting and nothing said so.
 *
 * So status is DERIVED from evidence rather than declared: is a board
 * configured, does it answer, how many postings does it serve, and how many
 * have ever reached the archive. What you maintain by hand is only the list of
 * companies you care about and whether you have set up an email alert.
 */

const FILE = p('config', 'watchlist.json');

/**
 * A board serving this few postings is a placeholder, not a career site. Set
 * from the three measured cases, which all returned exactly 1.
 */
const STUB_THRESHOLD = 2;

export const STATUS = {
  api: { label: 'Tracked via API', rank: 0, ok: true },
  alert: { label: 'Tracked via email alert', rank: 1, ok: true },
  stub: { label: 'Board is a stub — real jobs elsewhere', rank: 2, ok: false },
  broken: { label: 'Board configured but failing', rank: 3, ok: false },
  blocked: { label: 'No public API — needs an email alert', rank: 4, ok: false },
  unknown: { label: 'Not investigated yet', rank: 5, ok: false },
};

export function load() {
  if (!existsSync(FILE)) return { companies: [] };
  return readJson(FILE, { companies: [] });
}

export const save = (wl) => writeJson(FILE, wl);

/** Company names vary between sources ("Roche", "F. Hoffmann-La Roche AG"). */
const matches = (company, entry) => {
  const hay = slug(company);
  if (!hay) return false;
  return [entry.name, ...(entry.aliases || [])]
    .filter(Boolean)
    .some((n) => hay.includes(slug(n)));
};

/**
 * Work out where each company actually stands.
 *
 * `boards` and `workday` come from companies.json, `archive` is every posting
 * the tool has ever recorded (kept and rejected alike — a rejected posting
 * still proves the pipe works).
 */
export function evaluate(wl, { boards = [], workday = [], careersites = [], beesite = [], archive = [] } = {}) {
  return (wl.companies || []).map((c) => {
    const seen = archive.filter((j) => matches(j.company || '', c)).length;

    const board = c.board?.kind === 'workday'
      ? workday.find((b) => b.tenant === c.board.tenant)
      : boards.find((b) => b.ats === c.board?.ats && b.slug === c.board?.slug);

    let status;
    if (c.board?.kind === 'careersite') {
      // A sitemap deployment has no board count to measure; being configured in
      // careersites.js is the evidence.
      status = careersites.includes(c.board.site) ? 'api' : 'unknown';
    } else if (c.board?.kind === 'beesite') {
      status = beesite.some((b) => b.slug === c.board.slug && b.enabled !== false) ? 'api' : 'unknown';
    } else if (board) {
      // `jobs` is the count recorded the last time the board was verified.
      if (board.jobs == null) status = 'broken';
      else if (board.jobs <= STUB_THRESHOLD) status = 'stub';
      else status = 'api';
    } else if (c.alert) {
      status = 'alert';
    } else if (c.platform && !c.supported) {
      status = 'blocked';
    } else {
      status = 'unknown';
    }

    return {
      ...c,
      status,
      statusLabel: STATUS[status].label,
      boardJobs: board?.jobs ?? null,
      postingsSeen: seen,
    };
  }).sort((a, b) =>
    STATUS[a.status].rank - STATUS[b.status].rank
    || (a.region || '').localeCompare(b.region || '')
    || a.name.localeCompare(b.name));
}

/** Counts per status, for the panel heading and the CLI summary. */
export function summarise(evaluated) {
  const by = {};
  for (const c of evaluated) by[c.status] = (by[c.status] || 0) + 1;
  return {
    total: evaluated.length,
    covered: evaluated.filter((c) => STATUS[c.status].ok).length,
    by,
  };
}

/** Flip the "I have set up an email alert" flag. */
export function setAlert(wl, id, alert) {
  const c = (wl.companies || []).find((x) => x.id === id);
  if (!c) return { ok: false, error: `unknown company "${id}"` };
  c.alert = Boolean(alert);
  c.alertSetAt = alert ? new Date().toISOString() : null;
  return { ok: true, company: c };
}

export const __testables = { matches, STUB_THRESHOLD };
