/**
 * Find the editable regions of the resume and cover letter.
 *
 * Anchored on the document's own structure — ALL-CAPS section headings and
 * "Title | dates" role lines — rather than on paragraph numbers or placeholder
 * tokens inserted into the template. Two reasons:
 *
 *   1. The template is the user's real CV. Requiring `{{SUMMARY}}` markers in it
 *      would mean maintaining a second copy that drifts from the one the user edits.
 *   2. Paragraph indexes shift the moment a line is added. Anchors survive that.
 *
 * Only regions the user asked to have tailored are returned: the summary, and
 * the bullets of the employers named in master.json. Work history, dates,
 * certifications and education are never in scope.
 */

/** A heading like "PROFESSIONAL SUMMARY" — all caps, no sentence punctuation. */
const isSectionHeading = (t) => /^[A-Z][A-Z /&]{5,40}$/.test(t.trim());

/** A role line: "Staff DevOps Engineer | Oct 2020 - Present". */
const isRoleLine = (t) => /\|\s*[A-Z][a-z]{2}\s+\d{4}\s*[-–]/.test(t);

/** "Key Achievements:" separates duties from wins; both are bullets, both editable. */
const isAchievementsLabel = (t) => /^key achievements\s*:?\s*$/i.test(t.trim());

/**
 * Employers whose bullets may be tailored.
 *
 * Comes from `tailoring.employers` in master.json — it is a fact about one
 * person's career, not about the tool, and hardcoding it here put real employer
 * names into a public repository.
 *
 * Deliberately a list rather than "the most recent N". Some roles are
 * steady-state work that must not be presented as build-from-nothing; naming
 * the ones that may be tailored means the generator never gets the chance.
 */
export const employersFrom = (master) => master?.tailoring?.employers || [];

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * Map the resume.
 *
 * Returns { summary: [para], employers: [{ name, roleLine, bullets: [para] }] }
 * where each para is { index, text } straight from readParagraphs.
 */
export function locateResume(paragraphs, tailorable = []) {
  const rows = paragraphs.map((p) => ({ ...p, clean: String(p.text || '').trim() }));

  /* ---- summary: everything between its heading and the next heading ---- */
  const sumStart = rows.findIndex((r) => /^PROFESSIONAL SUMMARY/i.test(r.clean));
  if (sumStart === -1) throw new Error('resume: no "PROFESSIONAL SUMMARY" heading found');

  const summary = [];
  for (let i = sumStart + 1; i < rows.length; i++) {
    if (isSectionHeading(rows[i].clean)) break;
    if (rows[i].clean) summary.push({ index: rows[i].index, text: rows[i].clean });
  }

  /* ---- employers: role line, then bullets until the next employer ---- */
  const workStart = rows.findIndex((r) => /^WORK EXPERIENCE/i.test(r.clean));
  const workEnd = rows.findIndex((r, i) => i > workStart && /^CERTIFICATIONS/i.test(r.clean));
  if (workStart === -1) throw new Error('resume: no "WORK EXPERIENCE" heading found');

  const employers = [];
  let current = null;

  for (let i = workStart + 1; i < (workEnd === -1 ? rows.length : workEnd); i++) {
    const r = rows[i];
    if (!r.clean) continue;

    // A company line names one of the tailorable employers. The company and its
    // one-line description run together in this template, so match on prefix.
    const match = tailorable.find((e) => norm(r.clean).startsWith(norm(e)));
    if (match) { current = { name: match, roleLine: null, bullets: [] }; employers.push(current); continue; }

    // A company line for an employer NOT in scope closes the current one.
    if (!isRoleLine(r.clean) && !isAchievementsLabel(r.clean) && /[-–]\s*\w+,\s*\w+/.test(r.clean) && r.clean.length > 60) {
      current = null; continue;
    }

    if (!current) continue;
    if (isRoleLine(r.clean)) { current.roleLine = r.clean; continue; }
    if (isAchievementsLabel(r.clean)) continue;      // a label, not a claim — never rewritten
    current.bullets.push({ index: r.index, text: r.clean });
  }

  return { summary, employers: employers.filter((e) => e.bullets.length) };
}

/**
 * Map the cover letter.
 *
 * The greeting and sign-off are fixed; the body is regenerated. Identified by
 * position rather than content: paragraph 1 greets, the last two are "Best," and
 * the name. Everything between is body.
 */
export function locateLetter(paragraphs) {
  const rows = paragraphs
    .map((p) => ({ index: p.index, text: String(p.text || '').trim() }))
    .filter((r) => r.text);

  if (rows.length < 4) throw new Error('cover letter: too few paragraphs to identify a body');

  const greetingAt = /^(dear|hello|hi)\b/i.test(rows[0].text) ? 0 : -1;

  // Walk back over the sign-off block: the name, then "Best," / "Regards," etc.
  let end = rows.length - 1;
  while (end > 0 && (rows[end].text.split(/\s+/).length <= 4 || /^(best|regards|kind regards|sincerely|thanks)/i.test(rows[end].text))) end--;

  const body = rows.slice(greetingAt + 1, end + 1);
  if (!body.length) throw new Error('cover letter: could not identify the body paragraphs');

  return {
    greeting: greetingAt === -1 ? null : rows[0],
    body,
    signoff: rows.slice(end + 1),
  };
}

export const __testables = { isSectionHeading, isRoleLine, isAchievementsLabel, norm };
