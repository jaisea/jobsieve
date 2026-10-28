import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync, copyFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { p, readJson, writeJson, slug, log, isoDay } from '../util.js';
import { readParagraphs, writeAndExport } from './word.js';
import { locateResume, locateLetter, employersFrom } from './locate.js';
import { generate, repair, review } from './tailor.js';
import { verify, verifyLetter, auditMaster, verifySummaryTitle } from './verify.js';
import { renderEdit } from './diff.js';
import { enrich, save as saveDescriptions } from '../enrich.js';
import { normalize } from '../normalize.js';
import { gate } from '../filter.js';

/**
 * Generate a tailored resume and cover letter for one job.
 *
 * Everything is kept: the prompt sent, the raw response, the review verdicts,
 * and a frozen copy of the generated text. The frozen copy is what makes the
 * feedback loop possible — once the user edits the .docx there is otherwise
 * nothing left to diff their corrections against.
 */

/**
 * Where generated applications land.
 *
 * Defaults into the repo, but these are personal documents rather than code —
 * they belong somewhere backed up and somewhere you would naturally look for a
 * CV. Set `output.applicationsDir` in master.json to an absolute path; a synced
 * folder means they survive this working directory being deleted.
 */
export function applicationsRoot(master = null) {
  const configured = master?.output?.applicationsDir
    || readJson(p('config', 'master.json'), {})?.output?.applicationsDir;
  return configured ? String(configured) : p('applications');
}

const ROOT = (master) => applicationsRoot(master);

/**
 * Company first so applications to one employer group together; the date is the
 * day APPLIED, which modified-date loses the moment a file is opened.
 *
 * slug() returns space-separated words — it exists for word matching elsewhere —
 * so the spaces have to be hyphenated here or the folder name contains them.
 */
export const folderFor = (job) => [
  slug(job.company).trim().replace(/\s+/g, '-').slice(0, 24),
  isoDay(),
  slug(job.title).trim().replace(/\s+/g, '-').slice(0, 48),
].join('-').replace(/-+/g, '-').replace(/^-|-$/g, '');

export function listApplications() {
  if (!existsSync(ROOT())) return [];
  return readdirSync(ROOT(), { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('_'))
    .map((d) => {
      const meta = readJson(join(ROOT(), d.name, '.generation', 'meta.json'), null);
      return meta ? { folder: d.name, ...meta } : { folder: d.name };
    })
    .sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
}

/**
 * One application, found by the folder name a page sent.
 *
 * The name arrives from an HTTP body, so it must be a single folder name and one
 * that exists as an application — never a path. (`../../` walked straight out of
 * the applications directory when setOutcome took the name unchecked; this is the
 * same guard, shared by everything that opens, reads or rewrites a folder.)
 */
export function resolveApplication(folder) {
  const name = basename(String(folder || ''));
  if (!name || name === '.' || name === '..' || name !== folder) {
    return { ok: false, error: 'an application folder is a single name, not a path' };
  }
  const dir = join(ROOT(), name);
  const meta = readJson(join(dir, '.generation', 'meta.json'), null);
  if (!meta) return { ok: false, error: `no application at ${name}` };
  return { ok: true, name, dir, meta };
}

/** What a tailored folder holds that a regeneration would replace. */
const REPLACED = ['Resume.docx', 'Resume.pdf', 'CoverLetter.docx', 'CoverLetter.pdf', 'job.md'];

/**
 * Keep what is about to be replaced.
 *
 * Regenerating writes new documents over the old ones in the same folder, and the
 * old ones may be the letter you spent an evening editing — `learn()` reads those
 * edits to see what you correct. So they are copied to `.generation/previous/<time>/`
 * first. If the copy fails (a document open in Word locks it) this throws and
 * nothing is replaced: failing before the model is called costs nothing, failing
 * after it costs the draft and the documents.
 */
export function keepPrevious(dir, now = new Date()) {
  const present = REPLACED.filter((f) => existsSync(join(dir, f)));
  if (!present.length) return null;
  const to = join(dir, '.generation', 'previous', now.toISOString().replace(/[:.]/g, '-'));
  try {
    mkdirSync(to, { recursive: true });
    for (const f of present) copyFileSync(join(dir, f), join(to, f));
  } catch (e) {
    throw new Error(`could not keep the current documents (is one open in Word?) — nothing was changed: ${e.message}`);
  }
  return to;
}

/**
 * Fresh generation fields laid over what the application already knew.
 *
 * Regenerating rewrote meta.json from scratch, which would have reset the date you
 * applied, dropped the outcome (an interview back to nothing) and — the one that
 * matters — dropped `salaryAsked`, the figure typed into the employer's form that
 * exists nowhere else. Those belong to the APPLICATION, not to a draft of it, so
 * they survive. `tailored: false` does not: the application now has documents.
 */
export function mergeMeta(fresh, prior, now = new Date().toISOString()) {
  if (!prior) return fresh;
  const merged = { ...fresh, at: prior.at || fresh.at, outcome: prior.outcome ?? null, regeneratedAt: now };
  if (prior.outcomeAt) merged.outcomeAt = prior.outcomeAt;
  if (prior.salaryAsked) merged.salaryAsked = prior.salaryAsked;
  return merged;
}

/**
 * The advert as it read on the day you applied, out of job.md.
 *
 * "The posting" is the last section of that file and the only copy of what you
 * actually responded to once the employer edits or withdraws it. A placeholder for
 * a posting that was never captured reads as no text, not as text.
 */
export function postingFromNotes(md) {
  const text = String(md || '');
  const at = text.indexOf('## The posting');
  if (at < 0) return '';
  const body = text.slice(at + '## The posting'.length).trim();
  return body === '(no description captured)' ? '' : body;
}

export function savedPosting(folder) {
  const app = resolveApplication(folder);
  if (!app.ok) return '';
  const file = join(app.dir, 'job.md');
  return existsSync(file) ? postingFromNotes(readFileSync(file, 'utf8')) : '';
}

/**
 * Re-read the advert before writing anything for it.
 *
 * Adverts are living documents. One remote posting was captured at
 * 09:03 and the employer added "Deutsch Muttersprache oder mindestens C1
 * Deutsch" to it later the same day — a requirement well beyond the profile's
 * German level, on a job that by then looked like a strong match. Generating a CV
 * and a cover letter is the most expensive thing this tool does with your time, so it
 * is the one place worth spending an HTTP request to check the ad still says
 * what we think it says.
 *
 * Opt-in via --recheck: see the call site for why it is not the default.
 *
 * Returns a status of changed, unchanged, unavailable or skipped — never silence.
 */
async function recheck(job, profile) {
  if (!profile) return { status: 'skipped', why: 'no profile was passed to apply()' };
  if (!job.applyUrl) return { status: 'skipped', why: 'this posting has no advert URL' };

  let r;
  try {
    r = await enrich([job], { force: true });
  } catch (e) {
    return { status: 'unavailable', why: e.message };
  }
  if (r.cache) saveDescriptions(r.cache);

  const text = r.descriptions[job.fingerprint];
  const hit = r.cache?.[job.fingerprint];
  if (!text) return { status: 'unavailable', why: hit?.error || 'no JobPosting data on the page', at: hit?.at };
  if (text === job.descriptionText) return { status: 'unchanged', at: hit?.at };

  const fresh = normalize({ ...job, descriptionText: text, descriptionHtml: '' }, profile);
  return {
    status: 'changed',
    verdict: gate(fresh, profile),
    fresh,
    before: job.descriptionText?.length || 0,
    after: text.length,
  };
}

/**
 * Build both documents.
 *
 * Ordering matters at the end: the .docx files are written even when the
 * fact-check fails, but the PDFs are not. That leaves something to inspect and
 * fix, with nothing PDF-shaped that could be attached to an email by accident.
 */
export async function apply(job, { master, profile = null, verbose = false, refresh = false, recheckAd = false, folder = null } = {}) {
  // `folder` regenerates INTO an existing application. Without it the name is built
  // from today's date, so refreshing on another day started a second folder — and a
  // second row in the list for the same job.
  const dir = join(ROOT(master), folder || folderFor(job));
  const gen = join(dir, '.generation');

  if (!refresh && existsSync(join(gen, 'baseline.json'))) {
    log.info(`  already generated — ${dir}`);
    log.dim('  Use --refresh to generate a different draft.');
    return { dir, cached: true };
  }

  // Off by default. Descriptions expire after MAX_AGE_DAYS and a daily run
  // keeps them hours old, so re-reading on every generation buys little and
  // costs a way to be wrong: the re-gate can block on something unrelated to
  // whatever actually changed. Worth having for a job you care about, not worth
  // spending on every one. When it does run it reports every outcome, including
  // its own failure — silence used to mean both "unchanged" and "could not
  // check", which is the silent downgrade this project treats as a bug.
  const re = recheckAd ? await recheck(job, profile) : { status: 'off' };

  if (re.status === 'unavailable' || re.status === 'skipped') {
    log.warn(`  could not re-read the advert — ${re.why}`);
    log.dim('  Generating from the stored copy, which may be out of date.');
  }
  if (re.status === 'unchanged') log.dim('  advert re-read — unchanged');
  if (re.status === 'changed') {
    log.dim(`  advert re-read — ${re.before} → ${re.after} characters`);
    if (!re.verdict.keep && re.verdict.certain) {
      log.err(`  The advert changed and now fails a gate: ${re.verdict.reason}`);
      log.dim('  Nothing was written. Re-run npm run search to re-file it, or');
      log.dim(`  npm run apply -- ${job.fingerprint.slice(0, 8)} without --recheck to generate anyway.`);
      return { dir, blocked: 1, rechecked: re.verdict };
    }
    if (!re.verdict.keep) log.warn(`  advert changed — now uncertain: ${re.verdict.reason}`);
  }

  // Created only now. Doing it up front left an empty folder behind every time
  // the advert re-check blocked a job, which reads as "an application exists".
  mkdirSync(gen, { recursive: true });

  // Before any model call: if the current documents cannot be kept, stop now.
  if (refresh) {
    const kept = keepPrevious(dir);
    if (kept) log.dim(`  kept the previous documents — ${kept}`);
  }

  // master.json contradicting itself is a data bug, not a generation bug, and
  // it would otherwise be resolved silently in whichever direction the check
  // happened to take.
  for (const c of auditMaster(master)) log.warn(`  master.json: ${c.detail}`);

  /* ---- what may be edited ---- */
  const resumeParas = await readParagraphs(p('templates', 'resume.docx'));
  const letterParas = await readParagraphs(p('templates', 'cover-letter.docx'));
  const editable = locateResume(resumeParas, employersFrom(master));
  const letterSlots = locateLetter(letterParas);

  const editableCount = editable.summary.length + editable.employers.reduce((n, e) => n + e.bullets.length, 0);
  log.step(`Tailoring ${editableCount} editable lines against ${job.company}…`);

  /* ---- generate ---- */
  const g = await generate({ job, master, editable, allParagraphs: resumeParas, verbose });
  let draft = sanitise(g.data);

  // Repair and review are conditional — repair only runs when something was
  // refused, review only when a provider answers. Seeded null so the saved file
  // distinguishes "did not run" from "ran and was not recorded".
  const sent = { generate: g.sent, repair: null, review: null };
  log.dim(`    ${draft.storyline}`);
  log.info(`  ${draft.resumeEdits.length} CV edit(s) proposed · via ${g.provider}/${g.model}`);

  // Show what actually changed, before anything is written. The generator
  // rewrites two or three lines out of a hundred and the overclaims hide in a
  // single swapped word — a run traded "Azure-based" for "multi-cloud", which
  // reads as broader and is less true. Reading it here beats opening the PDF.
  const allEditable = [...editable.summary, ...editable.employers.flatMap((x) => x.bullets)];
  for (const e of draft.resumeEdits) {
    const original = allEditable.find((x) => x.index === e.index);
    if (original) console.log(renderEdit({ index: e.index, before: original.text, after: e.text }));
  }

  /* ---- check ---- */
  const sourceText = [
    ...editable.summary.map((s) => s.text),
    ...editable.employers.flatMap((e) => e.bullets.map((b) => b.text)),
  ].join('\n');

  const checks = [];
  for (const e of draft.resumeEdits) {
    const original = allEditable.find((x) => x.index === e.index);
    if (!original) {
      checks.push({ ok: false, issues: [{ severity: 'block', kind: 'index', token: String(e.index),
        detail: `paragraph ${e.index} is not in the editable set — the model tried to change something out of scope.` }] });
      continue;
    }
    checks.push(verify({ generated: e.text, source: `${original.text}\n${sourceText}`, master, job, kind: `resume:${e.index}` }));

    // The first summary line is the one that states who the user is, so it gets a
    // second, narrower check. Only that line — a bullet may be re-titled
    // freely, and the employers own job titles are protected by locate().
    if (e.index === editable.summary[0]?.index) {
      checks.push(verifySummaryTitle({ before: original.text, after: e.text, master }));
    }
  }

  const letterText = Object.values(draft.letter).join('\n\n');
  checks.push(verify({ generated: letterText, source: `${sourceText}\n${job.descriptionText || ''}`, master, job, kind: 'letter' }));
  const lengthCheck = verifyLetter(Object.values(draft.letter), master);

  let issues = [...checks.flatMap((c) => c.issues), ...lengthCheck.issues];
  let blocked = issues.filter((i) => i.severity === 'block');

  /* ---- one repair attempt, only if something blocked ---- */
  // A blocked document used to be a dead end: .docx written, no PDF, and the
  // only way on was a full --refresh producing an unrelated draft. Naming the
  // refusals back to the model recovers most of them for one extra call.
  // A banned phrase is deterministic, trivially fixable, and kept reappearing —
  // "robust" survived three drafts because a warning changes nothing. It does
  // not block a PDF, but it is worth the same repair call as one that does.
  // Technology sits here rather than in `blocked`: it warns, but it is still
  // worth a repair call, because an unrecognised technology is either an
  // invention worth removing or a real tool missing from master.json — and the
  // model can usually say the same thing with a word it is allowed.
  const repairable = issues.filter((i) => i.severity === 'warn' && ['style', 'technology'].includes(i.kind));
  if (blocked.length || repairable.length) {
    const asking = [...blocked, ...repairable];
    log.warn(`  ${blocked.length} blocking, ${repairable.length} fixable issue(s) — asking for a repair:`);
    for (const b of asking) log.dim(`      ${b.kind}: ${b.token}`);
    try {
      const r = await repair({ job, master, editable, draft, issues: asking, allParagraphs: resumeParas });
      sent.repair = r.sent;
      const fixed = sanitise(r.data);
      const recheck = [];
      for (const e of fixed.resumeEdits) {
        const original = allEditable.find((x) => x.index === e.index);
        recheck.push(verify({ generated: e.text, source: `${original?.text || ''}\n${sourceText}`, master, job, kind: `resume:${e.index}` }));
        // The repair is a second chance to get the title wrong, and it is
        // told only about the issues it was asked to fix. Without this, a
        // repair could quietly reintroduce the demotion and be accepted as
        // an improvement because the issue count fell.
        if (e.index === editable.summary[0]?.index) {
          recheck.push(verifySummaryTitle({ before: original?.text, after: e.text, master }));
        }
      }
      recheck.push(verify({ generated: Object.values(fixed.letter).join('\n\n'), source: `${sourceText}\n${job.descriptionText || ''}`, master, job, kind: 'letter' }));
      const freshIssues = recheck.flatMap((c) => c.issues);
      const stillBlocked = freshIssues.filter((i) => i.severity === 'block');
      const stillStyle = freshIssues.filter((i) => i.severity === 'warn' && ['style', 'technology'].includes(i.kind));

      // Accept only a genuine improvement, counting both kinds.
      if (stillBlocked.length + stillStyle.length < blocked.length + repairable.length) {
        log.ok(`  repair accepted — ${blocked.length + repairable.length} → ${stillBlocked.length + stillStyle.length} issue(s)`);
        draft = fixed;
        issues = [...recheck.flatMap((c) => c.issues), ...verifyLetter(Object.values(fixed.letter), master).issues];
        blocked = stillBlocked;
      } else {
        log.dim('  repair did not improve it — keeping the first draft');
      }
    } catch (e) {
      log.warn(`  repair unavailable — ${e.message}`);
    }
  }

  // Warnings were being collected and never shown. The first run produced a
  // 143-word letter — well under the measured 165-word minimum — and said nothing.
  const warned = issues.filter((i) => i.severity === 'warn');
  for (const w of warned) log.warn(`  ${w.kind}: ${w.detail}`);

  /* ---- adversarial review ---- */
  let rev = null;
  try {
    const r = await review({ job, master, draft, original: sourceText });
    sent.review = r.sent;
    rev = r.data;
    if (rev.findings.length) {
      log.warn(`  review: ${rev.overall} — ${rev.findings.length} finding(s)`);
      for (const f of rev.findings) log.dim(`      [${f.kind}] ${f.where}: ${f.detail}`);
    } else {
      log.ok('  review: pass');
    }
  } catch (e) {
    log.warn(`  review unavailable — ${e.message}`);
  }

  /* ---- audit trail, written before any document ---- */
  // Each edit records the line it replaced, not just the replacement. Without
  // it, showing the diff later means re-reading the template and quietly
  // diffing against whatever it says *now* — so editing the CV would rewrite
  // the history of every application already sent.
  draft.resumeEdits = draft.resumeEdits.map((e) => ({
    before: allEditable.find((x) => x.index === e.index)?.text ?? null, ...e,
  }));
  // What was SENT, not just what came back. The requirements promised this and
  // the folder did not have it: a bad letter could be read, and the model named,
  // but the instructions behind it were gone. A repair or review that never ran
  // stays null rather than being omitted, so the file says which calls happened.
  writeJson(join(gen, 'prompts.json'), {
    at: new Date().toISOString(),
    provider: g.provider, model: g.model,
    ...sent,
  });
  writeJson(join(gen, 'baseline.json'), draft);
  writeJson(join(gen, 'review.json'), rev);
  writeJson(join(gen, 'checks.json'), { issues, blocked: blocked.length });
  writeJson(join(gen, 'meta.json'), mergeMeta({
    at: new Date().toISOString(), company: job.company, title: job.title,
    fingerprint: job.fingerprint, applyUrl: job.applyUrl,
    storyline: draft.storyline, provider: g.provider, model: g.model,
    edits: draft.resumeEdits.length, letterWords: lengthCheck.words,
    reviewOverall: rev?.overall ?? 'unavailable', blocked: blocked.length,
    outcome: null,
  }, readJson(join(gen, 'meta.json'), null)));

  /* ---- documents ---- */
  const resumeOut = { docx: join(dir, 'Resume.docx'), pdf: join(dir, 'Resume.pdf') };
  const letterOut = { docx: join(dir, 'CoverLetter.docx'), pdf: join(dir, 'CoverLetter.pdf') };

  const letterEdits = ['opening', 'experience', 'draw', 'close']
    .map((k, i) => (letterSlots.body[i] ? { index: letterSlots.body[i].index, text: draft.letter[k] } : null))
    .filter(Boolean);

  if (blocked.length) {
    // Draft only. Something is unsupported, and a PDF is the thing that gets sent.
    log.err(`  ${blocked.length} blocking issue(s) — writing .docx drafts, NOT PDFs:`);
    for (const b of blocked) log.dim(`      ${b.kind}: ${b.detail}`);
    await writeAndExport({ template: p('templates', 'resume.docx'), ...resumeOut, pdf: join(gen, 'draft-resume.pdf'), edits: draft.resumeEdits });
    await writeAndExport({ template: p('templates', 'cover-letter.docx'), ...letterOut, pdf: join(gen, 'draft-letter.pdf'), edits: letterEdits });
  } else {
    await writeAndExport({ template: p('templates', 'resume.docx'), ...resumeOut, edits: draft.resumeEdits });
    await writeAndExport({ template: p('templates', 'cover-letter.docx'), ...letterOut, edits: letterEdits });
    log.ok(`  Resume.pdf + CoverLetter.pdf written`);

    // A technology it could not account for no longer stops the PDF, because
    // that check spent a day refusing the user's own tools. But it survived a repair
    // attempt, so it is either an invention or a real tool missing from
    // master.json — and both need a person, not the tool, to decide. Said last and
    // said plainly, because this is the one place something unchecked can now
    // reach a document that goes to an employer.
    const unresolved = issues.filter((i) => i.kind === 'technology');
    if (unresolved.length) {
      log.warn(`  READ THIS: the PDFs name ${unresolved.length} thing(s) not in master.json —`
        + ` ${unresolved.map((i) => i.token).join(', ')}`);
      log.dim('  Either you have used it, and it belongs in master.json, or you have not,');
      log.dim('  and the sentence has to go. Do not send these until you have looked.');
    }
  }

  writeFileSync(join(dir, 'job.md'), jobNotes(job, draft, rev, master), 'utf8');
  log.ok(`  ${dir}`);

  return { dir, blocked: blocked.length, storyline: draft.storyline, review: rev };
}

/**
 * Strip artefacts of the prompt from the model's output.
 *
 * Observed on real runs: the `[SUMMARY]` and `[EMPLOYER]` labels that
 * identify each editable line were copied into the rewritten text, and the
 * letter arrived with its own greeting and sign-off — which the template already
 * supplies, so the document would have
 * carried two of each. The schema now says not to, but a prompt instruction is
 * a request; this is the guarantee.
 */
function sanitise(draft) {
  const dropLabel = (s) => String(s).replace(/^\s*\[[^\]]{1,40}\]\s*/, '').trim();
  const dropGreeting = (s) => String(s).replace(/^\s*(dear\b[^\n,]*,?|hello\b[^\n,]*,?|hi\b[^\n,]*,?)\s*/i, '').trim();
  const dropSignoff = (s) => String(s)
    .replace(/\n+\s*(kind regards|best regards|best|regards|sincerely|thanks|thank you)\s*,?\s*\n[\s\S]*$/i, '')
    .trim();

  return {
    ...draft,
    resumeEdits: (draft.resumeEdits || []).map((e) => ({ ...e, text: dropLabel(e.text) })),
    letter: {
      opening: dropSignoff(dropGreeting(draft.letter.opening)),
      experience: dropSignoff(draft.letter.experience),
      draw: dropSignoff(draft.letter.draw),
      close: dropSignoff(draft.letter.close),
    },
  };
}

/** Your own notes for the interview, next to the posting. */
function jobNotes(job, draft, rev, master, salaryAsked = null) {
  // Written for a tailored application AND for one sent with the standard CV.
  // The section that matters later is the posting: it is the only copy of what
  // was actually responded to, once the employer edits or withdraws the advert.
  const tailoring = draft
    ? `## The angle taken
${draft.storyline}

## CV lines changed
${draft.resumeEdits.map((e) => `- **${e.why}**\n  ${e.text}`).join('\n') || '_none_'}
`
    : `## Sent as-is
The standard CV went out — nothing was tailored for this posting.
`;

  return `# ${job.title}
**${job.company}** · ${job.location} · applied ${isoDay()}

${job.applyUrl}

${tailoring}
## Before the interview
${salaryAsked ? `**You asked for ${salaryAsked}** — the figure you put in their form. Nothing else records it.
` : ''}
**Why you are looking** — not in the letter, but you will be asked:
> ${master.motivations?.whyLeaving || '(not recorded)'}

**What you want next:**
> ${master.motivations?.wantNext || '(not recorded)'}

${rev?.findings?.length ? `## Review flagged\n${rev.findings.map((f) => `- [${f.kind}] ${f.where}: ${f.detail}`).join('\n')}\n` : ''}
## The posting
${(job.descriptionText || '(no description captured)').slice(0, 8000)}
`;
}

/**
 * Keep a record for a job applied to WITHOUT tailoring anything.
 *
 * The standard CV is often enough, and when it is, nothing here used to run —
 * so the posting was never captured and the job vanished from both the queue
 * and the applications list. The documents are the smaller half of what this
 * folder is for; the bigger half is holding the advert as it read on the day,
 * because the employer will edit or withdraw it and there is no other copy.
 *
 * Idempotent: marking a job applied twice must not overwrite a real generation.
 */
export function recordApplied(job, { master = null, salaryAsked = null } = {}) {
  // Match on fingerprint, not on the folder name. folderFor() stamps TODAY's
  // date, so a job applied to on Monday and marked again on Tuesday produced a
  // second folder and appeared twice in the list.
  const already = listApplications().find((x) => x.fingerprint === job.fingerprint);
  if (already) {
    // Marked applied a second time WITH a figure this time. The folder already
    // exists, so nothing else here runs — and dropping the number on the floor
    // is the one thing this feature must not do, because there is no other copy
    // of it. Filled in, never overwritten: the first answer was given closer to
    // the form.
    const dir = join(ROOT(master), already.folder);
    if (salaryAsked && !already.salaryAsked) {
      const metaPath = join(dir, '.generation', 'meta.json');
      const meta = readJson(metaPath, null);
      if (meta) writeJson(metaPath, { ...meta, salaryAsked });
    }
    return { dir, existed: true };
  }

  const dir = join(ROOT(master), folderFor(job));
  const gen = join(dir, '.generation');
  if (existsSync(join(gen, 'meta.json'))) return { dir, existed: true };

  mkdirSync(gen, { recursive: true });
  writeJson(join(gen, 'meta.json'), {
    at: new Date().toISOString(),
    company: job.company,
    title: job.title,
    fingerprint: job.fingerprint,
    applyUrl: job.applyUrl,
    tailored: false,
    outcome: null,
    salaryAsked: salaryAsked || null,
  });
  writeFileSync(join(dir, 'job.md'), jobNotes(job, null, null, master || readJson(p('config', 'master.json'), {}), salaryAsked), 'utf8');
  return { dir, existed: false };
}

/**
 * `npm run apply -- <id> --diff` — what was changed, for an application that
 * already exists.
 *
 * Reads the audit trail only: no network, no model call, no regeneration. The
 * point is to be able to look again a week later, when the question is "what
 * did I actually send them" rather than "generate me something".
 *
 * Applications generated before `before` was recorded fall back to reading the
 * template, which is right only while the template is unchanged — so that case
 * says so rather than presenting a possibly-stale diff as fact.
 */
export async function showDiff(job, { master } = {}) {
  const dir = join(ROOT(master), folderFor(job));
  const baseline = readJson(join(dir, '.generation', 'baseline.json'), null);
  if (!baseline) {
    log.err(`No application generated for ${job.company} yet.`);
    log.dim(`  Run: npm run apply -- ${job.fingerprint.slice(0, 8)}`);
    return { ok: false };
  }

  const meta = readJson(join(dir, '.generation', 'meta.json'), {});
  if (meta.at) log.dim(`  generated ${meta.at.slice(0, 16).replace('T', ' ')} · ${meta.provider || '?'}/${meta.model || '?'}`);
  if (baseline.storyline) log.dim(`  ${baseline.storyline}`);

  const edits = baseline.resumeEdits || [];
  if (!edits.length) {
    log.info('\n  No CV lines were changed — the template went out as it stands.');
    return { ok: true, edits: 0 };
  }

  // Only pay for Word if an old application is missing its recorded originals.
  let fallback = null;
  if (edits.some((e) => !e.before)) {
    log.dim('\n  This application predates recorded originals — diffing against the template as it is now.');
    const paras = await readParagraphs(p('templates', 'resume.docx'));
    const loc = locateResume(paras, employersFrom(master));
    fallback = [...loc.summary, ...loc.employers.flatMap((x) => x.bullets)];
  }

  console.log();
  for (const e of edits) {
    const before = e.before ?? fallback?.find((x) => x.index === e.index)?.text ?? '';
    if (e.why) log.dim(`      ${e.why}`);
    console.log(renderEdit({ index: e.index, before, after: e.text }));
    console.log();
  }

  log.dim(`  ${edits.length} line(s) changed · ${dir}`);
  return { ok: true, edits: edits.length };
}

/**
 * Compare what was sent against what was generated.
 *
 * The user's edits are the feedback — people do not write feedback, but they do
 * fix documents. Nothing is generalised automatically: recurring corrections
 * become style rules only once the user has classified them.
 */
export async function learn() {
  const out = [];
  for (const app of listApplications()) {
    const dir = join(ROOT(), app.folder);
    const baseline = readJson(join(dir, '.generation', 'baseline.json'), null);
    if (!baseline) continue;

    const letterPath = join(dir, 'CoverLetter.docx');
    if (!existsSync(letterPath)) continue;

    const now = await readParagraphs(letterPath);
    const generated = Object.values(baseline.letter).map((s) => String(s).trim());
    const current = now.map((r) => String(r.text || '').trim()).filter(Boolean);

    for (const gen of generated) {
      if (current.some((c) => c === gen)) continue;          // untouched
      const closest = current.find((c) => overlap(c, gen) > 0.3 && c !== gen);
      if (closest) out.push({ folder: app.folder, generated: gen, yours: closest });
    }
  }
  return out;
}

/** Rough word overlap, to pair an edited paragraph with the one it came from. */
function overlap(a, b) {
  const wa = new Set(String(a).toLowerCase().split(/\W+/).filter((w) => w.length > 3));
  const wb = new Set(String(b).toLowerCase().split(/\W+/).filter((w) => w.length > 3));
  if (!wa.size || !wb.size) return 0;
  let n = 0;
  for (const w of wa) if (wb.has(w)) n++;
  return n / Math.max(wa.size, wb.size);
}

export function setOutcome(folder, outcome) {
  // `folder` and `outcome` arrive from an HTTP body, and neither was checked.
  // The server is bound to 127.0.0.1, which makes this hard to reach rather
  // than safe to ignore: `../../` in a folder name walked straight out of the
  // applications directory, and any string at all was written into meta.json as
  // an outcome, where the report then renders it.
  //
  // basename() rather than a traversal regex, because the only legitimate value
  // is one folder name — anything with a path separator in it is already wrong.
  const name = basename(String(folder || ''));
  if (!name || name === '.' || name === '..' || name !== folder) {
    return { ok: false, error: 'an application folder is a single name, not a path' };
  }
  if (!OUTCOMES.includes(outcome)) {
    return { ok: false, error: `unknown outcome "${outcome}" — expected one of ${OUTCOMES.join(', ')}` };
  }

  const file = join(ROOT(), name, '.generation', 'meta.json');
  if (!existsSync(file)) return { ok: false, error: `no application at ${name}` };
  const meta = readJson(file);
  meta.outcome = outcome;
  meta.outcomeAt = new Date().toISOString();
  writeJson(file, meta);
  return { ok: true, meta };
}

/**
 * The only two things worth saying out loud.
 *
 * There were six: applied, no reply, screening, interview, offer, rejected. All
 * six had to be chosen by hand, weeks after the fact, and after 61 applications
 * exactly ONE had ever been set — which is the measurement that matters here.
 *
 * `rejected` and `no reply` are gone because AGE answers both. An application
 * you did not move to interview or offer, thirty days old, is archived by the
 * panel whether the refusal arrived in writing or never came at all, and the
 * distinction changes nothing you would do next. Chasing the written version of
 * it is what left 60 of 61 blank.
 *
 * `screening` is gone for a duller reason: it did not change anything. It never
 * held an application out of the archive and it never moved a row, so it was a
 * label with no consequence attached.
 *
 * `applied` stays as the default every application already has. What is left is
 * the two promotions you would actually bother to record — and the two ways one
 * of them ENDS.
 *
 * `unsuccessful` (they said no) and `declined` (you said no) exist because an
 * interview or an offer never ages out: something you are still in beats the
 * calendar, so without an end state it sat on In progress for ever after the
 * process was over. Setting one returns the application to Applied, with the
 * outcome on the row, where age folds it away like any other. They are NOT an
 * answer to silence — age still answers that, and there is still no "rejected"
 * for an application nobody replied to. The word is avoided on purpose: a job
 * STATUS of `rejected` already means you turned the posting down, and the page
 * groups on both fields.
 */
export const OUTCOMES = ['applied', 'interview', 'offer', 'unsuccessful', 'declined'];
export const __testables = { folderFor, overlap };
