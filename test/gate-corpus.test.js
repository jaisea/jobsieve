/**
 * Gates 2-5 (title-exclude, employment-type, age, relevance) against real titles.
 *
 * Every title below was measured against 10,027 stored postings. Vocabulary is where these
 * gates break silently — a list that stops matching looks like a quieter report — so the
 * expectations are written as titles, not as function calls. Each group says why it exists.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

import { p, readJson } from '../src/util.js';
import { CHECKS, classify, employmentKinds, expandGerman, ageLimit } from '../src/filter.js';
import { normalize } from '../src/normalize.js';

const profile = readJson(p('config', 'examples', 'devops.profile.json'));
const gate = (id) => CHECKS.find((c) => c.id === id);
const fresh = () => new Date().toISOString();
const job = (title, extra = {}) => ({ title, source: 'adzuna', postedAt: fresh(), employmentType: '', ...extra });

/** keep | soft | DROP for one gate. */
const verdict = (id, j, pr = profile) => {
  const v = gate(id).run(j, pr);
  return v.keep ? 'keep' : v.certain ? 'DROP' : 'soft';
};

/* ---------------------------------------------------------------- relevance */

test('a German role written as one word is the role it names', () => {
  // "system administrator" and "cloud architect" are in the domain list; German spells them
  // "Systemadministrator" and "Cloud Architekt". A Linux sysadmin role in the home city was a
  // certain drop as "not a target role".
  for (const t of [
    'Senior Cloud Architekt (m/w/d)',
    'Systemadministrator Linux (m/w/d) | in München',
    'IT-Systemadministrator (m/w/d)',
    'Systemadministrator für Windows Server / IT System Engineer. (m/w/d)',
  ]) assert.equal(verdict('relevance', job(t)), 'keep', t);
});

test('German infrastructure titles that are not certain are ASKED ABOUT, not dropped', () => {
  for (const t of [
    'IT System- / Netzwerkadministrator (m/w/d)',
    'IT-Administrator (m/w/d)',
    'Plattform- und Infrastrukturarchitekt/-in',
    'Lead Solution Architekt - Infrastruktur (m/w/d)',
    'Senior Network Engineer',
    'Data Center Engineer',
  ]) assert.equal(verdict('relevance', job(t)), 'soft', t);
});

test('the noun forms and abbreviations the list had never seen', () => {
  for (const t of ['Cloud Engineering', 'Engineering Manager - Python and K8s', 'Senior System Engineer', 'Platform Engineering Lead'])
    assert.equal(verdict('relevance', job(t)), 'keep', t);
});

test('another specialisation BESIDE infrastructure wording is a question, not a verdict', () => {
  // The off-track list was tested first, so one stray word won: 16 titles per fetch.
  for (const t of [
    'Site Reliability Engineer in Hardware Infrastructure',
    'Senior Frontend Platform Engineer',
    'Fullstack-Entwickler (m/w/d) mit DevOps- und OPS-Fokus',
    'Senior Mobile Platform Engineer',
  ]) assert.equal(verdict('relevance', job(t)), 'soft', t);
});

test('another specialisation ALONE is still a certain drop, and so are German false friends', () => {
  for (const t of [
    'Frontend Engineer', 'Senior Android Developer', 'Data Scientist (m/w/d)',
    // "Infrastruktur" is German for infrastructure, and a railway timetable role is not one.
    'Kapazitätsmanager Fahrplan & Infrastruktur (m/w/d)',
    'Produktmanager (w/m/d) Public Cloud',
  ]) assert.equal(verdict('relevance', job(t)), 'DROP', t);
});

test('the expansion maps role heads and nothing else', () => {
  assert.equal(expandGerman('Senior Cloud Architekt (m/w/d)'), 'senior cloud architect (m/w/d)');
  assert.equal(expandGerman('Systemadministrator'), 'system administrator');
  assert.equal(expandGerman('IT-Systemingenieur'), 'it-system engineer');
  assert.match(expandGerman('Infrastrukturarchitekt'), /infrastruktur architect/, 'the head is mapped, the infrastructure word is not');
  assert.equal(expandGerman('Senior System Administrator'), 'senior system administrator', 'English is left alone');
});

test('a soft title reaches the model as a question about the title', () => {
  const raw = (t) => normalize({
    source: 'adzuna', title: t, company: 'Acme GmbH', location: 'München', applyUrl: 'https://x.test/1',
    postedAt: fresh(), descriptionText: 'We run Kubernetes, Terraform, Azure and GitOps in production. '.repeat(15),
  }, profile);
  for (const t of ['IT-Administrator (m/w/d)', 'Senior Frontend Platform Engineer', 'Cloud Solution Engineer/Cloud Architect/Cloud Consultant (m/w/d)']) {
    const v = classify(raw(t), profile);
    assert.equal(v.decision, 'uncertain', `${t}: ${v.reason}`);
    assert.ok(v.uncertainties.some((u) => u.kind === 'title'), `${t} must carry a title question`);
  }
});

/* ------------------------------------------------------------ title-exclude */

test('seniority and employment terms stay certain, even beside an infrastructure word', () => {
  for (const t of ['Junior DevOps Engineer', 'Werkstudent:in - Cloud & DevOps Engineer (Azure)', 'Trainee Platform Engineer', 'Account Executive, Cloud Infrastructure'])
    assert.equal(verdict('title-exclude', job(t)), 'DROP', t);
});

test('a German compound hides a banned word from whole-word matching', () => {
  assert.equal(verdict('title-exclude', job('Pflichtpraktikum im Cloud Engineering')), 'DROP');
  assert.equal(verdict('title-exclude', job('Abschlussarbeit Kubernetes Operator')), 'DROP');
});

test('a FUNCTION term beside infrastructure wording is a question', () => {
  for (const t of [
    'Cloud Solution Engineer/Cloud Architect/Cloud Consultant (m/w/d)',
    'DevOps Support Engineer (m/w/d)',
    'Technical Product Manager, Kubernetes Services',
  ]) assert.equal(verdict('title-exclude', job(t)), 'soft', t);
});

test('...and the same term with no infrastructure wording is still a certain drop', () => {
  for (const t of ['Senior Product Manager', 'Sales Manager DACH', 'Technical Recruiter', 'Senior Sales Engineer - Enterprise AI Infrastructure'])
    assert.equal(verdict('title-exclude', job(t)), 'DROP', t);
});

test('both lists can be overridden in profile.json', () => {
  const strict = { ...profile, targetTitles: { ...profile.targetTitles, excludeUnlessDomain: [] } };
  assert.equal(verdict('title-exclude', job('DevOps Support Engineer (m/w/d)'), strict), 'DROP', 'no soft terms: everything is certain');
  const none = { ...profile, targetTitles: { ...profile.targetTitles, excludeCompounds: [] } };
  assert.equal(verdict('title-exclude', job('Pflichtpraktikum im Cloud Engineering'), none), 'keep');
});

/* ------------------------------------------------------------ employment-type */

test('employment kinds: the spellings that came back as nothing', () => {
  const k = employmentKinds;
  assert.deepEqual(k('Contractor'), ['contract']);
  assert.deepEqual(k('Freelancer'), ['contract']);
  assert.deepEqual(k('Interim'), ['contract']);
  assert.deepEqual(k('Trainee'), ['internship']);
  assert.deepEqual(k('Praktikant'), ['internship']);
  assert.deepEqual(k('Aushilfe'), ['part-time']);
  assert.deepEqual(k('Arbeitnehmerüberlassung'), ['temporary']);
});

test('"permanent contract" is not a contract role, and "full or part time" is not part-time', () => {
  assert.deepEqual(employmentKinds('Permanent contract'), []);
  assert.deepEqual(employmentKinds('Vollzeit, unbefristet'), []);
  assert.deepEqual(employmentKinds('Experienced, Permanent, Full or part time'), []);
  assert.deepEqual(employmentKinds('Contract'), ['contract']);
});

test('the title speaks for a posting that states no type — and only for part-time', () => {
  assert.deepEqual(employmentKinds('', 'IT-Systemadministrator (m/w/d) in Teilzeit'), ['part-time']);
  assert.deepEqual(employmentKinds('', 'Systemadministrator Vollzeit oder Teilzeit'), [], 'both offered');
  assert.deepEqual(employmentKinds('Vollzeit', 'Systemadministrator Teilzeit'), [], 'a stated type is trusted over a title');
  assert.deepEqual(employmentKinds('', 'Contract Platform Engineer'), [], 'a title does not state the other kinds');
  const strict = { ...profile, filters: { ...profile.filters, excludeEmploymentTypes: ['part-time', 'contract'] } };
  assert.equal(verdict('employment-type', job('DevOps Engineer (m/w/d) Teilzeit'), strict), 'DROP');
  assert.equal(verdict('employment-type', job('DevOps Engineer', { employmentType: 'Contractor' }), strict), 'DROP');
  assert.equal(verdict('employment-type', job('DevOps Engineer', { employmentType: 'Permanent contract' }), strict), 'keep');
});

/* ------------------------------------------------------------------- age */

test('a posting on the employer\'s own board is still open however old it is', () => {
  const ago = (d) => new Date(Date.now() - d * 86400000).toISOString();
  const j = (source, d) => job('Platform Engineer', { source, postedAt: ago(d) });
  assert.equal(verdict('age', j('adzuna', 60)), 'DROP', 'an aggregator keeps listings after the employer removed them');
  assert.equal(verdict('age', j('arbeitsagentur', 60)), 'DROP');
  assert.equal(verdict('age', j('ats', 60)), 'keep');
  assert.equal(verdict('age', j('workday', 150)), 'keep');
  assert.equal(verdict('age', j('ats', 200)), 'DROP', 'but not for ever');
  assert.equal(verdict('age', job('Platform Engineer', { source: 'adzuna', postedAt: undefined })), 'keep', 'no date, no verdict');
});

test('the longer limit can never be shorter than the ordinary one, and is configurable', () => {
  assert.equal(ageLimit({ source: 'ats' }, { filters: { maxAgeDays: 300 } }), 300);
  assert.equal(ageLimit({ source: 'adzuna' }, { filters: { maxAgeDays: 45 } }), 45);
  assert.equal(ageLimit({ source: 'adzuna' }, { filters: { maxAgeDays: 45, authoritativeSources: ['adzuna'], maxAgeDaysAuthoritative: 90 } }), 90);
  assert.equal(ageLimit({ source: 'ats' }, { filters: { maxAgeDays: 45, authoritativeSources: [] } }), 45, 'an empty list switches it off');
});

/* ----------------------------------------------- the postings you actually applied to */

test('nothing you applied to or marked interested would be stopped by gates 2-5', { skip: !existsSync(p('data', 'seen.json')) || !existsSync(p('data', 'jobs.json')) }, () => {
  // Private data, so it runs only where it exists. Age is measured the way it mattered —
  // how old the posting was when you FIRST SAW it — because today's age is meaningless for a
  // job applied to months ago. (This cannot validate the age limit itself: postings older
  // than it were never shown to you, so none could have been applied to.)
  const seen = readJson(p('data', 'seen.json'), {});
  const archive = readJson(p('data', 'jobs.json'), {});
  const mine = Object.entries(seen).filter(([, e]) => ['applied', 'interested'].includes(e.status));
  const hurt = [];
  for (const [fp, e] of mine) {
    const rec = archive[fp];
    if (!rec) continue;
    const j = { ...rec };
    if (e.firstSeen && rec.postedAt) {
      const ageThen = (new Date(e.firstSeen) - new Date(rec.postedAt)) / 86400000;
      j.postedAt = new Date(Date.now() - ageThen * 86400000).toISOString();
    }
    for (const id of ['title-exclude', 'employment-type', 'age', 'relevance']) {
      const v = verdict(id, j);
      if (v === 'DROP') hurt.push(`${id}: ${rec.title}`);
    }
  }
  assert.deepEqual(hurt, [], 'a certain drop on something you applied to');
});
