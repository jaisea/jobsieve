/**
 * How profile.skills is matched against an advert.
 *
 * This file used to specify the `stack` gate ("does the advert name your
 * tools?"). The gate was removed on 2026-10-20 at the user's request, together with
 * the programming gate: both were dropping postings the user wanted to see. What is
 * left is the matcher the scorer uses, which is shared, cached and whole-word.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

import { p, slug, hasSkill } from '../src/util.js';
import { normalize } from '../src/normalize.js';
import { score } from '../src/score.js';
import { gate, CHECKS, REJECT_CATEGORIES } from '../src/filter.js';

const profile = JSON.parse(readFileSync(p('config', 'examples', 'devops.profile.json'), 'utf8'));
const filler = ' The team is small and the work is varied, with plenty of ownership. '.repeat(12);
const advert = (body) => normalize({
  source: 's', sourceId: '1', title: 'Senior DevOps Engineer', company: 'X',
  location: 'München, Germany', applyUrl: 'https://example.invalid/1',
  descriptionText: body + filler,
}, profile);

test('neither the stack gate nor the programming gate exists any more', () => {
  for (const id of ['stack', 'programming']) {
    assert.ok(!CHECKS.some((c) => c.id === id), `${id} was removed and must not come back unasked`);
    // The categories stay, so reasons already on file in seen.json still read.
    assert.ok(REJECT_CATEGORIES[id], `${id} must still label old rejections`);
  }
});

test('an advert naming none of the user\'s tools is no longer dropped for it', () => {
  const j = advert('We build medical device platforms on proprietary embedded tooling.');
  assert.ok(!gate(j, profile).reasons.some((r) => r.category === 'stack'));
});

test('a mandatory programming language is no longer dropped for it', () => {
  const j = advert('We run Azure and Kubernetes. 5+ years of experience in Python is required.');
  assert.equal(j.programmingRequired, 'required', 'still detected — the score and the card chip read it');
  assert.ok(!gate(j, profile).reasons.some((r) => r.category === 'programming'));
});

test('the dead config keys are gone from the template', () => {
  // Config nothing reads makes editing it feel effective.
  assert.equal(profile.filters?.stack, undefined);
  assert.equal(profile.avoid?.mandatoryProgramming, undefined);
});

/* ------------------------------------------------------------- the matcher */

test('git never matches as a substring of a longer tool', () => {
  // `git` sits inside github, gitlab, gitops and gitleaks, which between them
  // appear in almost every infrastructure advert ever written.
  for (const s of ['We use GitHub Actions', 'A GitOps workflow', 'Gitleaks scanning', 'GitLab CI']) {
    assert.ok(!hasSkill(s, 'git'), `${s} must not count as a bare git`);
  }
  assert.ok(hasSkill('Experience with Git and branching', 'git'), 'the bare word still counts');
  assert.ok(!hasSkill('We host on Gitea', 'git'));
});

test('a trailing plural still counts', () => {
  assert.ok(hasSkill('orchestrating containers at scale', 'container'));
  assert.ok(hasSkill('a container platform', 'container'));
});

test('multi-word terms match across punctuation', () => {
  for (const s of ['Azure DevOps pipelines', 'Azure-DevOps pipelines']) {
    assert.ok(hasSkill(s, 'azure devops'), s);
  }
});

test('no two skills collapse to the same thing', () => {
  // A config lint. `slug()` flattens punctuation, so "ci/cd", "ci cd" and
  // "ci-cd" are one concept spelled three ways — and all three matched the same
  // mention. The gate deduped; the scorer did not, so a posting whose only
  // skill was CI/CD scored 10 points as "3 core skills" instead of 3.2 as one.
  //
  // Both files, because profile.json is the one that runs and
  // profile.example.json is the one anyone else starts from.
  for (const file of ['profile.json', 'profile.example.json', 'examples/devops.profile.json']) {
    if (file === 'profile.json' && !existsSync(p('config', file))) continue; // a fresh clone has none
    let cfg;
    try { cfg = JSON.parse(readFileSync(p('config', file), 'utf8')); }
    catch (e) { assert.fail(`config/${file} is not valid JSON: ${e.message}`); }

    const seen = new Map();
    for (const kind of ['tools', 'practices', 'adjacent']) {
      for (const t of ['core', 'secondary', 'nice']) {
        for (const term of cfg.skills?.[kind]?.[t] || []) {
          const k = slug(term);
          if (!seen.has(k)) seen.set(k, []);
          seen.get(k).push(`${kind}.${t}:${term}`);
        }
      }
    }
    const dupes = [...seen].filter(([, where]) => where.length > 1)
      .map(([k, where]) => `${k} <- ${where.join(' | ')}`);
    assert.deepEqual(dupes, [], `config/${file} counts these more than once:\n  ${dupes.join('\n  ')}`);
  }
});

test('the scorer counts a concept once however it is spelled', () => {
  const spelled = JSON.parse(JSON.stringify(profile));
  spelled.skills.practices.core = ['ci/cd', 'ci cd', 'ci-cd'];
  spelled.skills.tools.core = [];
  spelled.skills.tools.secondary = [];
  spelled.skills.tools.nice = [];

  const j = advert('We run a modern CI/CD pipeline.');
  const s = score(j, spelled);
  assert.equal(s.matchedSkills.length, 1, `counted ${s.matchedSkills.length} times: ${s.matchedSkills}`);
});

test('one entry covers every way an advert punctuates a term', () => {
  // The config used to need a row per spelling — "ci/cd" AND "cicd", "argo cd"
  // AND "argocd" — because the matcher required a separator where the term had
  // a space. That meant an advert using two spellings counted twice, and the
  // scorer counted the redundant rows as separate skills.
  //
  // hasSkill() makes the separator optional, so the SPACED form is the general
  // one: it covers the joined spelling, while a joined term has no space to
  // relax and cannot cover the spaced one. Keep the spaced form.
  for (const text of ['a modern CI/CD pipeline', 'strong CI-CD experience',
    'we do CI CD daily', 'CICD ownership', 'our ci_cd tooling']) {
    assert.ok(hasSkill(text, 'ci/cd'), text);
  }
  for (const text of ['we use ArgoCD', 'we use Argo CD', 'argo-cd manifests']) {
    assert.ok(hasSkill(text, 'argo cd'), text);
  }
  assert.ok(hasSkill('secrets live in KeyVault', 'key vault'));

  // The ends stay whole-word, which is what stops this collapsing into
  // substring matching.
  assert.ok(!hasSkill('GitHub Actions', 'git'));
  assert.ok(!hasSkill('Gitleaks scanning', 'git'));
  assert.ok(!hasSkill('google cloud', 'go'));
  assert.ok(!hasSkill('a flawless record', 'aws'));

});

test('the scorer uses the shared matcher, not a private copy', () => {
  // There were separate copies of the same regex and they had drifted: one
  // tolerated a trailing plural, the scorer did not, so "containers" matched
  // for one and not the other.
  const src = readFileSync(p('src', 'score.js'), 'utf8');
  assert.match(src, /hasSkill\(/, 'the scorer must use the shared matcher');
  assert.ok(!/new RegExp\(`\(\^\|\\s\)/.test(src), 'no private copy left in the scorer');
});

/**
 * hasSkill() caches, and caching must not change a single answer.
 *
 * It is called 87 times per posting — once per term in profile.skills, then
 * again by the scorer — and each call used to slug the WHOLE advert (six string
 * passes and a Unicode normalize over ~6,000 characters) and compile a fresh
 * RegExp for a term that had not changed since the file was read.
 *
 * Neither depends on the loop, so both were pure repetition. Measured over 500
 * real postings: 30.97ms each before, 14.02ms after — normalizing a 7,000
 * posting run drops from about 152 seconds to 98.
 *
 * The risk of a cache is a stale answer, so these check the two ways that could
 * happen: a term reused against different text, and text reused against
 * different terms.
 */
test('the same term against different adverts answers independently', () => {
  // The text cache holds one entry. If it were not invalidated on a new string,
  // every posting after the first would inherit the first one's answer.
  assert.equal(hasSkill('we run kubernetes and terraform', 'kubernetes'), true);
  assert.equal(hasSkill('a role about javascript only', 'kubernetes'), false);
  assert.equal(hasSkill('we run kubernetes again', 'kubernetes'), true);
});

test('the same advert against different terms answers independently', () => {
  // The term cache is keyed on the slugged term. A shared RegExp with a /g flag
  // would match every other call; this is why the pattern carries no flag.
  const advert = 'Kubernetes, Terraform and Azure. No AWS here.';
  assert.equal(hasSkill(advert, 'kubernetes'), true);
  assert.equal(hasSkill(advert, 'terraform'), true);
  assert.equal(hasSkill(advert, 'kubernetes'), true, 'a repeat must not flip');
  assert.equal(hasSkill(advert, 'gcp'), false);
  assert.equal(hasSkill(advert, 'terraform'), true);
});

test('the separator-optional matching still holds through the cache', () => {
  // The property the cache must not quietly break: one config entry covers
  // every spelling an advert uses.
  for (const spelling of ['CI/CD', 'CI-CD', 'CI CD', 'CICD']) {
    assert.equal(hasSkill(`We practise ${spelling} daily.`, 'ci cd'), true, spelling);
  }
  // Whole-word: 'git' must not match INSIDE github/gitlab/gitops, which between
  // them appear in nearly every infrastructure advert ever written.
  assert.equal(hasSkill('we use github, gitlab and gitops', 'git'), false,
    'git must not match inside a longer word');
  assert.equal(hasSkill('we use git for version control', 'git'), true,
    'but the word itself still counts');
});
