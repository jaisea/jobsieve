/**
 * Application generation: locating what may be edited, and refusing to state
 * anything the user cannot back up.
 *
 * The fact-check is the reason this feature is safe to use. Everywhere else in
 * this project a wrong verdict costs a minute of reading; here it goes to an
 * employer under the user's name and has to be defended in an interview. So the tests
 * below are mostly about what the generator is NOT allowed to say.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { p } from '../src/util.js';
import { setStatus } from '../src/store.js';
import { PICKER_GROUPS, REJECT_CATEGORIES } from '../src/filter.js';

import * as applyMod from '../src/apply/index.js';
import { locateResume, locateLetter, employersFrom } from '../src/apply/locate.js';
import { verify, verifyLetter, auditMaster, verifySummaryTitle } from '../src/apply/verify.js';
import { renderEdit } from '../src/apply/diff.js';

const para = (index, text) => ({ index, text });

/** Which employers may be tailored now comes from master.json, not from code. */
const TAILORABLE = employersFrom({ tailoring: { employers: ['Acme Cloud'] } });

const RESUME = [
  para(1, 'A Candidate'), para(2, 'München | mail@example.com'),
  para(3, 'PROFESSIONAL SUMMARY'),
  para(4, 'DevOps leader with 12 years.'), para(5, 'Specialised in Azure.'),
  para(6, 'CORE SKILLS'), para(7, 'Cloud: Azure, AWS'),
  para(8, 'WORK EXPERIENCE'),
  para(9, 'Acme Cloud - München, Germany  Provider of cloud software'),
  para(10, 'Staff DevOps Engineer | Oct 2020 - Present'),
  para(11, 'Led a 5-member DevOps team.'), para(12, 'Key Achievements:'), para(13, 'Established IaC.'),
  para(14, 'Older Employer Ltd - Berlin, Germany  IT services and consulting company'),
  para(15, 'Systems Analyst | May 2012 - Sep 2014'),
  para(16, 'Led a 5-member team releasing code.'),
  para(17, 'CERTIFICATIONS'), para(18, 'Azure DevOps Engineer Expert'),
];

const MASTER = {
  facts: {
    technologies: ['Azure', 'Kubernetes', 'Terraform', 'Ansible', 'Prometheus'],
    certifications: [{ name: 'Docker Certified Associate' }],
  },
  signature: { evidence: [{ employer: 'Acme Cloud' }] },
  voice: { banned: { phrases: ['passionate about', 'spearhead'] }, measured: { range: [165, 379] } },
  motivations: { avoid: null },
  achievements: [{ text: 'process improvements worth €150K annual savings' }],
  positioning: { years: 12, teamsLed: [{ size: 5 }, { size: 9 }] },
};

/* ------------------------------------------------------------------ locate */

test('the summary is found by its heading, not its position', () => {
  const r = locateResume(RESUME, TAILORABLE);
  assert.deepEqual(r.summary.map((s) => s.index), [4, 5]);
});

test('only the employers in scope are editable', () => {
  // The older employer is on the CV and deliberately NOT tailorable: master.json
  // records such roles as steady-state work, and dressing one up as
  // build-from-nothing would be a fabrication the model never gets to make.
  const r = locateResume(RESUME, TAILORABLE);
  assert.deepEqual(r.employers.map((e) => e.name), ['Acme Cloud']);
  assert.ok(!TAILORABLE.includes('Older Employer Ltd'), 'steady-state roles stay out of scope');
});

test('role lines and the achievements label are never editable', () => {
  const r = locateResume(RESUME, TAILORABLE);
  const idx = r.employers[0].bullets.map((b) => b.index);
  assert.ok(!idx.includes(10), 'the "Title | dates" line is factual');
  assert.ok(!idx.includes(12), '"Key Achievements:" is a label, not a claim');
  assert.deepEqual(idx, [11, 13]);
});

test('a missing heading fails loudly rather than editing the wrong lines', () => {
  assert.throws(() => locateResume([para(1, 'Name'), para(2, 'Some text')], TAILORABLE), /PROFESSIONAL SUMMARY/);
});

test('the letter body excludes the greeting and the sign-off', () => {
  const l = locateLetter([
    para(1, 'Dear Hiring Manager,'), para(2, 'Opening paragraph that is long enough to count as body text.'),
    para(3, 'Second paragraph also long enough to be treated as real body content here.'),
    para(4, 'Best,'), para(5, 'A Candidate'),
  ]);
  assert.equal(l.greeting.text, 'Dear Hiring Manager,');
  assert.deepEqual(l.body.map((b) => b.index), [2, 3]);
  assert.deepEqual(l.signoff.map((s) => s.text), ['Best,', 'A Candidate']);
});

/* ------------------------------------------------------------------ verify */

test('a technology the user has never used is flagged, but does not stop the PDF', () => {
  // It WARNS. Over a day of real use this check refused Vault, GitHub Actions,
  // Argo CD, JFrog Artifactory, Cloud, Code, German, the home city, APIs and more —
  // every one the user's own, not one an invention. A warning still triggers the repair
  // call, and survives into a line the user is told to read before sending. The number
  // check still blocks, because that one has never been wrong.
  const r = verify({ generated: 'Built platforms with Terraform and Pulumi.', source: 'Built platforms with Terraform.', master: MASTER });
  const found = r.issues.find((i) => i.kind === 'technology');
  assert.equal(found.token, 'Pulumi');
  assert.equal(found.severity, 'warn', 'technology warns');
  assert.equal(r.blocks, 0, 'and does not block');
});

test('a technology already in the source text is allowed', () => {
  // Rewording a bullet may repeat anything the original said, even if it is not
  // on the whitelist — otherwise every reworded line trips the check.
  const r = verify({ generated: 'Administered Auth0 and Nginx.', source: 'Administered Auth0 (SSO) and Nginx.', master: MASTER });
  assert.equal(r.ok, true);
});

test('an invented number is blocked', () => {
  const r = verify({ generated: 'Led a 14-member team.', source: 'Led a 5-member team.', master: MASTER });
  assert.equal(r.ok, false);
  assert.match(r.issues.find((i) => i.kind === 'number').detail, /14/);
});

test('a number the user has actually claimed passes', () => {
  const r = verify({ generated: 'Delivered €150K annual savings across 12 years.', source: '', master: MASTER });
  assert.equal(r.ok, true, JSON.stringify(r.issues));
});

test('years are dates, not claims', () => {
  const r = verify({ generated: 'From 2015 to 2018 I led the migration.', source: '', master: MASTER });
  assert.equal(r.ok, true);
});

test('phrases absent from the user\'s own writing are warned about, not blocked', () => {
  // Style is a judgement call — flag it, let the user decide. Only fabrication blocks.
  const r = verify({ generated: 'I am passionate about Azure.', source: '', master: MASTER });
  assert.equal(r.ok, true, 'style must not block a PDF');
  assert.equal(r.warnings, 1);
  assert.equal(r.issues[0].kind, 'style');
});

test('claiming enthusiasm the user ruled out is blocked', () => {
  const m = { ...MASTER, motivations: { avoid: 'people management' } };
  const r = verify({ generated: 'I am looking for a people management role.', source: '', master: m });
  assert.equal(r.ok, false);
  assert.equal(r.issues[0].kind, 'motivation');
});

test('letter length is checked against the user\'s real letters', () => {
  const short = verifyLetter(['Too short.'], MASTER);
  assert.equal(short.issues[0].kind, 'length');

  const ok = verifyLetter([Array(250).fill('word').join(' ')], MASTER);
  assert.equal(ok.issues.length, 0);
});

test('a technology written under another name is not an invention', () => {
  // The letter that prompted this said "AWS, Azure, and Google Cloud". The
  // whitelist holds GCP, so the check blocked "Google" and "Cloud" as two
  // invented technologies and refused to write the PDF. A synonym is not a
  // fabrication.
  const master = { facts: { technologies: ['AWS', 'Azure', 'GCP', 'Kubernetes'] } };
  const r = verify({
    generated: 'I design cloud-native platforms across AWS, Azure, and Google Cloud.',
    source: '', master,
  });
  assert.equal(r.blocks, 0, r.issues.map((i) => i.token).join(', '));
});

test('an alias is only allowed when the user actually has the technology', () => {
  // The loosening must not become a hole: someone who has never touched GCP
  // still cannot claim Google Cloud.
  const master = { facts: { technologies: ['AWS', 'Kubernetes'] } };
  const r = verify({ generated: 'I ran production on Google Cloud.', source: '', master });
  assert.ok(r.warnings > 0, 'Google Cloud must still be flagged without GCP in the whitelist');
});

test('"Infrastructure as Code" is English, not a product name', () => {
  const master = { facts: { technologies: ['Terraform', 'Ansible'] } };
  const r = verify({
    generated: 'I implemented Terraform and Ansible for Infrastructure as Code.',
    source: '', master,
  });
  assert.equal(r.blocks, 0, r.issues.map((i) => i.token).join(', '));
});

test('a line with no recorded original renders as wholly new rather than throwing', () => {
  // Applications generated before the audit trail recorded originals fall back
  // to the template, and that lookup can miss — a line since removed from the
  // CV. Showing the diff a week later must not crash on it.
  const out = renderEdit({ index: 4, before: '', after: 'Specialized in multi-cloud platform engineering.' });
  const plain = out.replace(/\u001b\[[0-9;]*m/g, '');
  assert.match(plain, /¶4/);
  assert.match(plain, /\+ Specialized in multi-cloud platform engineering\./);
});

test('a folder is named for one job, not one day', () => {
  // recordApplied checked whether TODAY'S folder existed. A job applied to on
  // Monday and marked again on Tuesday produced a second folder, and the same
  // employer appeared twice in the applications list. Matching must be on the
  // fingerprint, which does not move.
  const src = readFileSync(p('src', 'apply', 'index.js'), 'utf8');
  // To the closing brace, not a fixed character count — the window was 900 and
  // the function outgrew it when it learned to record the salary, so the test
  // failed on the length of the code rather than on anything it does.
  const from = src.indexOf('export function recordApplied');
  const fn = src.slice(from, src.indexOf('\n}', from));
  assert.match(fn, /listApplications\(\)\.find\(\(x\) => x\.fingerprint === job\.fingerprint\)/,
    'recordApplied must look for an existing folder by fingerprint');
  assert.ok(fn.indexOf('x.fingerprint === job.fingerprint') < fn.indexOf('mkdirSync'),
    'and must do so before creating anything');
});

test('marking a job applied keeps the advert even when nothing was tailored', () => {
  // The standard CV is often enough. When it is, nothing in the apply pipeline
  // runs, so the posting was never captured — and the advert is the part that
  // disappears when the employer edits or withdraws it.
  const idx = readFileSync(p('src', 'index.js'), 'utf8');
  const srv = readFileSync(p('src', 'serve.js'), 'utf8');
  assert.match(idx, /recordApplied/, 'the CLI mark path must record it');
  assert.match(srv, /recordApplied/, 'and so must the report button');
});

test('a rejection reason is kept, and cleared if the status changes', () => {
  // Recorded so the gates can be audited against real decisions. Reconstructing
  // it from the postings does not work: of 34 rejections, 19 never mentioned
  // the reason they were assumed to carry.
  // Asserted through the function rather than through its source, so renaming a
  // parameter cannot fail a test about behaviour — which is what happened when
  // `reason` became `detail` to make room for the salary.
  const state = () => ({ seen: { a: { fingerprint: 'a', status: 'shown' } }, jobs: {} });

  const s1 = state();
  setStatus(s1, 'a', 'rejected', 'language');
  assert.equal(s1.seen.a.rejectedReason, 'language', 'recorded for a rejection');

  setStatus(s1, 'a', 'interested');
  assert.equal(s1.seen.a.rejectedReason, undefined, 'and cleared when the status changes');

  const s2 = state();
  setStatus(s2, 'a', 'applied', '85000');
  assert.equal(s2.seen.a.rejectedReason, undefined, 'never recorded for anything but a rejection');
});

test('the reasons offered are a grouping OVER the gates, never a second list', () => {
  // The picker used to BE the gate list, eleven buttons deep, so that your
  // reason and the tool's reason stayed comparable. That still has to hold for
  // what is STORED -- it does not have to hold for what is on a button, and
  // asking you to choose between "Programming required", "AWS-centric" and
  // "Does not name your tools" is asking you to do the gates' filing.
  //
  // So PICKER_GROUPS is the one definition, each group naming the gate
  // categories it stands for, and it is imported rather than re-typed.
  const rep = readFileSync(p('src', 'report.js'), 'utf8');
  assert.match(rep, /import \{ REJECT_CATEGORIES, PICKER_GROUPS \} from '\.\/filter\.js'/,
    'the picker must take its options from filter.js, not a hand-written list');
  assert.match(rep, /var REASONS = \$\{JSON\.stringify\(PICKER_GROUPS\.map/,
    'and inject them into the page');

  // Every gate a group claims has to be a real one, or a rejection would be
  // compared against a category nothing can ever assign.
  for (const g of PICKER_GROUPS) {
    for (const gate of g.gates) {
      assert.ok(REJECT_CATEGORIES[gate], `${g.key} claims gate "${gate}", which does not exist`);
    }
  }

  // And no gate may be claimed twice, or a stored reason would stand for two
  // different things depending on which group you read first.
  const claimed = PICKER_GROUPS.flatMap((g) => g.gates);
  assert.equal(claimed.length, new Set(claimed).size, 'a gate belongs to at most one group');
});

test('a negative list in master.json never grants permission', () => {
  // master.json holds two kinds of fact — what the user HAS, and what the user
  // explicitly has NOT — and the check walks the whole document. That conflated them
  // twice: `familiar` let "Microsoft Copilot" through, and writing
  // `notUsed: ['Keycloak']` made Keycloak claimable the moment it was recorded.
  // A denylist that grants permission is worse than no denylist.
  const master = {
    facts: { technologies: ['Azure', 'Kubernetes'], familiar: ['GitHub Copilot', 'Claude'] },
    identity: { notUsed: ['Keycloak', 'Okta'] },
    voice: { banned: { phrases: ['robust'] } },
    motivations: { avoid: ['people management'] },
  };

  for (const claim of ['We used GitHub Copilot at work.', 'I ran Keycloak in production.', 'I configured Okta.']) {
    const r = verify({ generated: claim, source: '', master });
    assert.ok(r.warnings > 0, `"${claim}" must be flagged — it names something recorded as NOT the user's`);
  }

  // and the positive list still works
  const clean = verify({ generated: 'I ran Kubernetes on Azure.', source: '', master });
  assert.equal(clean.blocks + clean.warnings, 0);
});

test('master.json contradicting itself is reported, not resolved silently', () => {
  // "Auth0" was recorded under identity.notUsed while already sitting in
  // facts.technologies — where it had been all along. Whichever way the check
  // resolved that, the file was lying about the user in one direction.
  const clashes = auditMaster({
    facts: { technologies: ['Auth0', 'Azure'] },
    identity: { notUsed: ['Auth0', 'Keycloak'] },
  });
  assert.equal(clashes.length, 1);
  assert.equal(clashes[0].term, 'auth0');
  assert.match(clashes[0].detail, /contradicts itself/);

  // and a file that says one thing consistently is quiet
  assert.deepEqual(auditMaster({
    facts: { technologies: ['Azure'] },
    identity: { notUsed: ['Keycloak'] },
  }), []);
});

test('a made-up number still stops the PDF', () => {
  // The two checks have opposite records, which is why only one of them blocks.
  // The number check has never once produced a false positive: it compares a
  // figure against every number in master.json, and a language model will not
  // do that reliably.
  const master = { facts: { technologies: ['Azure'] }, positioning: { headline: '12 years' } };
  const r = verify({ generated: 'I cut costs by 47 percent across 92 clusters.', source: '', master });
  assert.equal(r.blocks, 2, 'both invented figures block');
  assert.ok(r.issues.every((i) => i.kind === 'number'));
});

test('the model sees the whole CV, but never the contact line', () => {
  // It used to see only the 31 editable paragraphs of 98 — rewriting a document
  // it could not read. It now gets the rest as background. The contact line is
  // the exception: name, email, phone and LinkedIn are stripped from master.json
  // before sending, deliberately, and the CV would put them straight back.
  const src = readFileSync(p('src', 'apply', 'tailor.js'), 'utf8');
  const fn = src.slice(src.indexOf('function background('), src.indexOf('function userPrompt('));
  assert.match(fn, /@\|/, 'an email address must be filtered out');
  assert.match(fn, /linkedin/i, 'and the LinkedIn URL');
  assert.match(src, /READ ONLY, do not return edits/, 'the background must be marked read-only');
});

/* ------------------------------------------------- the summary job title */

/**
 * The one prompt-only rule that got a code backstop.
 *
 * Three rules were enforced by instruction alone: the edit cap, the letter's
 * language, and the summary job title. The user reads every diff and every letter, so
 * the first two stay as instructions. The title is different — it is a FIXED
 * STRING, so it can be checked the way an invented number is, and that check
 * has never produced a false positive.
 *
 * The failure it exists for is real. A run turned "Cloud / Platform
 * Engineering lead with 12 years building and running cloud
 * platforms" into "Infrastructure platform engineering leader with 12 years
 * administering enterprise Linux environments, virtualization, storage" — a
 * demotion on the most-read line of the document. The prompt forbade it in
 * three sentences; the model did it anyway.
 */
const SUMMARY = 'Cloud / Platform Engineering lead with 12 years building and running cloud platforms';
const titleCheck = (after, master = { positioning: { headline: SUMMARY } }) =>
  verifySummaryTitle({ before: SUMMARY, after, master });

test('re-titling the user to match the advert blocks the PDF', () => {
  const r = titleCheck('Infrastructure platform engineering leader with 12 years administering enterprise Linux environments');
  assert.equal(r.ok, false);
  assert.equal(r.issues[0].severity, 'block', 'a demotion is not a warning');
  assert.equal(r.issues[0].kind, 'title');
  assert.match(r.issues[0].detail, /Infrastructure platform engineering leader/);
});

test('tailoring what follows the title is allowed — that is the point', () => {
  // Blocking this would make the summary uneditable, which is worse than the
  // bug: the summary is the line most worth tailoring.
  const r = titleCheck('Cloud / Platform Engineering lead with 12 years building Kubernetes platforms for regulated industries');
  assert.equal(r.ok, true);
  assert.deepEqual(r.issues, []);
});

test('capitalisation and slash spacing are not changes worth blocking a PDF for', () => {
  // The technology check was demoted to a warning for producing exactly this
  // kind of false positive. This one blocks, so it must not be brittle.
  assert.equal(titleCheck('Cloud/Platform Engineering lead with 12 years designing platforms').ok, true);
  assert.equal(titleCheck('CLOUD / PLATFORM ENGINEERING LEAD with 12 years designing platforms').ok, true);
});

test('reordering the words is still a different title', () => {
  const r = titleCheck('Platform / Cloud Engineering lead with 12 years designing platforms');
  assert.equal(r.ok, false, '"Platform / Cloud" is not what the CV says');
});

test('dropping the elaboration entirely is caught, not waved through', () => {
  // The rewrite has no " with ", so there is no title to compare — the check
  // has to fall back to "does it still open with the old title" rather than
  // giving up, which is how a one-line rewrite would have slipped past.
  assert.equal(titleCheck('Senior DevOps Engineer').ok, false);
  assert.equal(titleCheck('Cloud / Platform Engineering lead').ok, true);
});

test('a line with no title structure is not checked at all', () => {
  // Requiring a rewrite to reproduce a whole line verbatim would forbid editing
  // it. Bullets go through this path too, and they have no title.
  const r = verifySummaryTitle({
    before: 'Led platform teams across three continents.',
    after: 'Led platform and reliability teams across three continents.',
    master: {},
  });
  assert.equal(r.ok, true);
  assert.equal(r.title, null);
});

test('the check falls back to master when the CV line has drifted', () => {
  const r = verifySummaryTitle({
    before: '',
    after: 'Infrastructure leader with 12 years of experience',
    master: { positioning: { headline: SUMMARY } },
  });
  assert.equal(r.ok, false, 'master.positioning.headline still states the title');
});

test('both the first draft and the repair are checked', () => {
  // The repair is told only about the issues it was asked to fix, so it is a
  // second chance to get the title wrong — and it is accepted whenever the
  // issue count falls, which a reintroduced demotion would not prevent.
  const src = readFileSync(p('src', 'apply', 'index.js'), 'utf8');
  const calls = (src.match(/verifySummaryTitle\(/g) || []).length;
  assert.equal(calls, 2, 'expected one check on the draft and one on the repair');
});

/**
 * setOutcome() takes both its arguments straight from an HTTP body.
 *
 * Neither was checked. The server binds to 127.0.0.1, which makes this hard to
 * reach rather than safe to ignore: `../../` in a folder name walked out of the
 * applications directory, and any string at all was written into meta.json as
 * an outcome, where the report then renders it.
 */
test('an application folder is a single name, never a path', () => {
  for (const folder of ['../../etc/passwd', 'a/b', '..', '', 'x/../y']) {
    const r = applyMod.setOutcome(folder, 'applied');
    assert.equal(r.ok, false, `"${folder}" must be refused`);
    assert.match(r.error, /single name/);
  }
});

test('an outcome must be one the tool defines', () => {
  const r = applyMod.setOutcome('some-folder', 'pwned');
  assert.equal(r.ok, false);
  assert.match(r.error, /unknown outcome/);
  // And the list in the message is the real one, so it cannot drift.
  for (const o of applyMod.OUTCOMES) assert.ok(r.error.includes(o), `${o} missing from the guidance`);
});
