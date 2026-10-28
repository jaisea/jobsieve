/**
 * Reading the advert again, and opening or regenerating the documents, for an
 * application you have already sent.
 *
 * The advert is the thing you most need once you have applied — an interview call
 * arrives and you need to know what the role asked for — and the Applied and In
 * progress pages showed none of it. And regenerating is not just a button: done
 * naively it started a second folder, reset the interview you had recorded and
 * dropped the salary figure that exists nowhere else.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, readdirSync, existsSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { p } from '../src/util.js';
import { REJECT_CATEGORIES, PICKER_GROUPS } from '../src/filter.js';
import { resolveApplication, keepPrevious, mergeMeta, postingFromNotes } from '../src/apply/index.js';
import { withStatus, sameOrigin } from '../src/serve.js';

const serve = readFileSync(p('src', 'serve.js'), 'utf8');
const apply = readFileSync(p('src', 'apply', 'index.js'), 'utf8');

/** The same string the <script> tag gets, with its interpolations resolved. */
function emittedScript() {
  const src = readFileSync(p('src', 'report.js'), 'utf8');
  const open = 'const JS = `';
  const from = src.indexOf(open);
  const to = src.indexOf('\n`;', from);
  return new Function('REJECT_CATEGORIES', 'PICKER_GROUPS', 'return `' + src.slice(from + open.length, to + 1) + '`;')(
    REJECT_CATEGORIES, PICKER_GROUPS);
}

/**
 * Pull one named function out of the emitted script by counting braces — either
 * `function name(…){…}` or `var name = function(…){…};` — so a test runs the code that
 * ships rather than a copy of it.
 */
function extractFunction(js, name) {
  const declared = js.indexOf(`function ${name}(`);
  const assigned = js.indexOf(`var ${name} = function`);
  const start = declared >= 0 ? declared : assigned;
  assert.ok(start >= 0, `function ${name} exists in the page script`);
  let depth = 0;
  for (let i = js.indexOf('{', start); i < js.length; i++) {
    if (js[i] === '{') depth++;
    if (js[i] === '}' && --depth === 0) return js.slice(start, js[i + 1] === ';' ? i + 2 : i + 1);
  }
  throw new Error(`unbalanced braces in ${name}`);
}

/** The page's button helpers, compiled with a stand-in for `esc` and for the docs lookup. */
function buttons(docsFor = {}) {
  const js = emittedScript();
  const code = ['openDocs', 'cardDocs', 'actions', 'decorateCards'].map((n) => {
    const src = extractFunction(js, n);
    return src.startsWith('function') ? src : `${src}`;
  }).join('\n');
  return new Function('esc', 'document', 'docsFor', `${code}\nreturn { openDocs, cardDocs, actions, decorateCards };`);
}

const esc = (v) => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/* ------------------------------------------------------------ the advert */

const NOTES = `# Senior DevOps Engineer
**Acme GmbH** · München · applied 2026-09-20

https://jobs.example.com/1

## The angle taken
Cloud migration.

## The posting
We are looking for a DevOps Engineer.

You will run Kubernetes on Azure.
`;

test('the saved advert is the "posting" section of the application notes', () => {
  assert.equal(postingFromNotes(NOTES), 'We are looking for a DevOps Engineer.\n\nYou will run Kubernetes on Azure.');
});

test('a posting that was never captured reads as no text, not as text', () => {
  assert.equal(postingFromNotes('# T\n\n## The posting\n(no description captured)\n'), '');
  assert.equal(postingFromNotes('# T\n\nno such section'), '');
  assert.equal(postingFromNotes(''), '');
  assert.equal(postingFromNotes(undefined), '');
});

test('the advert comes from the copy saved WITH the application, then from the archive', () => {
  // The employer may since have edited or withdrawn the ad; what you responded to is
  // the copy kept on the day.
  const route = serve.slice(serve.indexOf("url.pathname === '/api/application-jd'"), serve.indexOf("url.pathname === '/api/application-open'"));
  assert.match(route, /applyMod\.savedPosting\(app\.name\)/);
  assert.ok(route.indexOf('savedPosting') < route.indexOf('descriptionText'), 'saved copy first');
  assert.match(route, /source = 'saved with the application'/);
  assert.match(route, /source = 'the posting as last read'/);
  assert.doesNotMatch(route, /store\.save|writeJson|writeFileSync|setStatus/, 'reading an advert changes nothing');
});

test('descriptions are fetched when opened, shown as text, and survive a repaint', () => {
  const js = emittedScript();
  assert.match(js, /'\/api\/application-jd\?folder=' \+ encodeURIComponent\(folder\)\)/);
  assert.match(js, /document\.addEventListener\('toggle', function\(ev\)\{[\s\S]*?\}, true\);/, 'toggle does not bubble, so it is caught on the way down');
  assert.match(js, /pre\.textContent = text;/);
  assert.doesNotMatch(js, /pre\.innerHTML/, 'an advert is text a job board wrote: never markup');
  assert.match(js, /if \(jdCache\[folder\] != null\)/, 'kept once fetched');
  // The page re-checks every 20 seconds: an unchanged list must not be repainted, or
  // every open description closes under you.
  assert.match(js, /if \(sig === lastAppsSig\) return;/);
  assert.match(js, /if \(wasOpen\.indexOf\(det\.dataset\.folder\) >= 0\) \{ det\.open = true; fillJd\(det\); \}/);
});

test('every row carries a description, in the same markup as an Open card', () => {
  const js = emittedScript();
  assert.match(js, /'<details class="desc app-jd" data-folder="' \+ esc\(a\.folder\) \+ '">'/);
  const css = readFileSync(p('src', 'report.js'), 'utf8');
  assert.match(css, /^\.desc pre\{white-space:pre-wrap/m, 'the style the Open cards already use');
});

/* ------------------------------------------------------------ the buttons */

test('an applied or in-progress row gets Open Docs and NOTHING else: regenerating is for open jobs', () => {
  // Once a job is applied to, its documents are what went out; rewriting them is only
  // worth offering while the job is still undecided.
  const { actions } = buttons()(esc, null, {});

  assert.equal(actions({ folder: 'x', tailored: false }), '', 'sent with the standard CV: no documents, no button');

  const row = actions({ folder: 'acme-2026-09-20-devops', company: 'Acme', fingerprint: 'abc123', storyline: 's' });
  assert.match(row, /class="app-btn app-open" data-folder="acme-2026-09-20-devops"[^>]*>Open Docs<\/button>/, 'labelled Open Docs');
  assert.doesNotMatch(row, /app-regen|Regenerate/, 'no Regenerate on an application');
  assert.doesNotMatch(row, />Open</, 'and the old label is gone');

  // A very old application with no fingerprint can still be opened.
  assert.match(actions({ folder: 'old-one', company: 'Old', storyline: 's' }), /Open Docs/);
});

test('an OPEN job that has documents gets Open Docs and Regenerate', () => {
  const { cardDocs } = buttons()(esc, null, {});
  const html = cardDocs({ folder: 'acme-2026-09-20-devops', company: 'Acme', fingerprint: 'abc123' });
  assert.match(html, /app-open" data-folder="acme-2026-09-20-devops"[^>]*>Open Docs</);
  assert.match(html, /app-regen" data-folder="acme-2026-09-20-devops" data-company="Acme"[^>]*>Regenerate</);
  assert.match(html, /class="app-say dim small"/, 'with somewhere to say how it went');
});

/** A stand-in for one card on the Open page: just what decorateCards touches. */
function fakeCard(id) {
  const host = { dataset: {}, className: 'card-docs', innerHTML: '', removeAttribute(a) { if (a === 'data-folder') delete this.dataset.folder; } };
  const tailor = { hidden: false };
  const marks = { dataset: { id } };
  const find = { '.marks': marks, '.card-docs': host, '.tailor': tailor };
  return { host, tailor, marks, querySelector: (sel) => find[sel] ?? null };
}

test('the Open page swaps Tailor for Open Docs + Regenerate as soon as a job has documents', () => {
  const docsFor = {};
  const withDocs = fakeCard('abc12345');
  const without = fakeCard('zzz99999');
  const document = { querySelectorAll: () => [withDocs, without] };
  const { decorateCards } = buttons()(esc, document, docsFor);

  decorateCards();
  assert.equal(withDocs.host.innerHTML, '', 'nothing known yet, so every card keeps Tailor');
  assert.equal(withDocs.tailor.hidden, false);

  docsFor.abc12345 = { folder: 'acme-2026-09-20-devops', company: 'Acme', fingerprint: 'abc12345ffff' };
  decorateCards();
  assert.match(withDocs.host.innerHTML, /Open Docs/);
  assert.match(withDocs.host.innerHTML, /Regenerate/);
  assert.equal(withDocs.tailor.hidden, true, '"Tailor application" would only answer "already written"');
  assert.equal(withDocs.host.className, 'card-docs app-acts', 'and it carries the class the message helper looks for');
  assert.equal(without.host.innerHTML, '', 'a job without documents is untouched');
  assert.equal(without.tailor.hidden, false);

  // Running it again must not re-render (it would wipe a "writing…" message).
  withDocs.host.innerHTML += '<!-- marker -->';
  decorateCards();
  assert.match(withDocs.host.innerHTML, /marker/, 'unchanged documents are not redrawn');

  // The documents going away puts Tailor back.
  delete docsFor.abc12345;
  decorateCards();
  assert.equal(withDocs.host.innerHTML, '');
  assert.equal(withDocs.tailor.hidden, false);
  assert.equal(withDocs.host.dataset.folder, undefined);
});

test('only a tailored application with a fingerprint is offered to the open cards', () => {
  const js = emittedScript();
  assert.match(js, /if \(a\.tailored !== false && a\.fingerprint\) docsFor\[a\.fingerprint\.slice\(0, 8\)\] = a;/);
  assert.match(js, /\n      decorateCards\(\);\n      applyFind\(\);\n    \};/, 'after every repaint of the list');
  assert.match(js, /\/\/ Last, because it hides the Tailor button[\s\S]*decorateCards\(\);/, 'and after every sync of the queue');
});

test('the card carries a place for the buttons', () => {
  const src = readFileSync(p('src', 'report.js'), 'utf8');
  assert.match(src, /<span class="card-docs" data-id="\$\{id\}"><\/span>/);
});

test('a hostile folder or company name cannot break out of any button\'s attributes', () => {
  const { actions, cardDocs } = buttons()(esc, null, {});
  const folder = 'a"><img src=x onerror=alert(1)>';
  const app = { folder, company: '"><script>x</script>', fingerprint: 'f' };

  for (const html of [actions(app), cardDocs(app)]) {
    assert.doesNotMatch(html, /<img|<script/, 'no tag got through');
    // The text `onerror=alert(1)` is still in there — as inert characters INSIDE the
    // quoted value. What must hold is that each value is one unbroken quoted string.
    const values = [...html.matchAll(/data-(?:folder|company)="([^"]*)"/g)].map((m) => m[1]);
    assert.ok(values.length >= 1, 'the attributes are there');
    assert.equal(values[0], esc(folder), 'the folder name is the whole escaped value');
    assert.ok(!/["<>]/.test(values.join('')), 'no raw quote or angle bracket inside any value');
  }
});

test('the new buttons do not reuse the Tailor button\'s class, whose handler would fire too', () => {
  const { actions, cardDocs } = buttons()(esc, null, {});
  const app = { folder: 'f', company: 'c', fingerprint: 'x' };
  for (const html of [actions(app), cardDocs(app)]) assert.doesNotMatch(html, /class="[^"]*\btailor\b/);
  assert.match(emittedScript(), /closest\('\.tailor'\)/, 'the Tailor handler is still keyed on its own class');
});

test('Regenerate asks first, names what is kept, and refreshes the list afterwards', () => {
  const js = emittedScript();
  const handler = js.slice(js.indexOf("var regen = ev.target.closest('.app-regen');"), js.indexOf("var regen = ev.target.closest('.app-regen');") + 1800);
  assert.match(handler, /window\.confirm\(/);
  assert.ok(handler.indexOf('window.confirm(') < handler.indexOf("post('/api/apply'"), 'confirmed before anything is sent');
  assert.match(handler, /generation\\\\previous/, 'it says where the current ones are kept');
  assert.match(handler, /post\('\/api\/apply', \{ folder: folder, refresh: true \}\)/);
  assert.match(handler, /regen\.disabled = true;/, 'one at a time per application');
  assert.match(handler, /delete jdCache\[folder\];[\s\S]*lastAppsSig = '';[\s\S]*loadApps\(\);/);
  assert.match(handler, /\.finally\(function\(\)\{ regen\.disabled = false; \}\)/);
});

test('a message beside the buttons survives the list being repainted', () => {
  const js = emittedScript();
  assert.match(js, /var notice = \{\};/);
  assert.match(js, /Object\.keys\(notice\)\.forEach\(function\(folder\)\{ appNote\(folder, notice\[folder\]\); \}\);/);
});

test('the message helper cannot be overwritten by the add-a-job form\'s own variable', () => {
  // Found by clicking Open on the real page: the form further down the same script
  // declares `var say = <the message box>`. A `var` is hoisted to the whole function,
  // so it replaced a helper of the same name and every message threw "say is not a
  // function" — silently, inside a promise. Two names, and a test that keeps them two.
  const js = emittedScript();
  assert.equal(js.match(/var say = /g).length, 1, 'only the form declares `say`');
  assert.match(js, /var say = document\.getElementById\('m-say'\);/);
  assert.equal(js.match(/var appNote = /g).length, 1);
  assert.doesNotMatch(js, /\bsay\(/, 'nothing calls `say` as a function');
});

/* ------------------------------------------------------------ tailored, then turned down */

test('each application is told the status of the job behind it', () => {
  const seen = {
    fpApplied: { status: 'applied' },
    fpRejected: { status: 'rejected', rejectedReason: 'closed' },
    fpOpen: { status: 'shown' },
  };
  const apps = [
    { folder: 'a', fingerprint: 'fpApplied' },
    { folder: 'b', fingerprint: 'fpRejected' },
    { folder: 'c', fingerprint: 'fpOpen' },
    { folder: 'd', fingerprint: 'fpUnknown' },
    { folder: 'e' },
  ];
  const out = withStatus(apps, seen);
  assert.equal(out[0].status, 'applied');
  assert.deepEqual([out[1].status, out[1].rejectedReason], ['rejected', 'closed']);
  assert.equal(out[2].status, 'shown');
  assert.equal('status' in out[3], false, 'a job the archive no longer knows gets no invented status');
  assert.equal('status' in out[4], false, 'nor does one with no fingerprint');
  assert.equal('rejectedReason' in out[0], false, 'a reason only where there is one');
  assert.equal(apps[0].status, undefined, 'the stored applications are not modified');
});

test('both endpoints that return applications return them with their status', () => {
  // The outcome endpoint answers with the whole list, and the page repaints from it: a
  // list without statuses would drop every rejected folder back into "Applied".
  assert.match(serve, /applications: listWithStatus\(\), outcomes: applyMod\.OUTCOMES/);
  assert.match(serve, /ok: true, applications: listWithStatus\(\)/);
  assert.doesNotMatch(serve, /applications: applyMod\.listApplications\(\)/);
});

test('a job tailored and then turned down is kept with its documents, but not counted as applied', () => {
  // Twelve of 67 folders were exactly this: documents written, then the job turned down
  // on reaching the real application (new demands, a paywall). They are not applications.
  const js = emittedScript();
  const from = js.indexOf('var progressing = [], applied = [], archived = [], turnedDown = [];');
  const to = js.indexOf('\n      });', from) + '\n      });'.length;
  assert.ok(from > 0 && to > from, 'the grouping code is in the script');
  const group = new Function('d', 'cutoff', `${js.slice(from, to)}\nreturn { progressing, applied, archived, turnedDown };`);

  const now = Date.parse('2026-10-01T00:00:00Z');
  const day = (n) => new Date(now - n * 86400000).toISOString();
  const out = group({ applications: [
    { folder: 'sent', at: day(2), status: 'applied' },
    { folder: 'sent-long-ago', at: day(60), status: 'applied' },
    { folder: 'interviewing', at: day(2), status: 'applied', outcome: 'interview' },
    { folder: 'abandoned', at: day(5), status: 'rejected', rejectedReason: 'closed' },
    { folder: 'abandoned-after-interview-mark', at: day(5), status: 'rejected', outcome: 'interview' },
    { folder: 'no-status-recorded', at: day(2) },
    { folder: 'tailored-still-open', at: day(1), status: 'shown' },
    { folder: 'tailored-and-liked', at: day(1), status: 'interested' },
    { folder: 'brand-new', at: day(1), status: 'new' },
    { folder: 'hidden-by-cli', at: day(3), status: 'hidden' },
  ] }, now - 30 * 86400000);

  const names = (list) => list.map((a) => a.folder);
  assert.deepEqual(names(out.turnedDown), ['abandoned', 'abandoned-after-interview-mark', 'hidden-by-cli'],
    'turned down wins: you decided against it, whatever an outcome once said');
  // A job still on the Open page is not an application: it has documents, offered on its
  // card there, and joins this list when it is marked applied.
  const everywhere = [...out.progressing, ...out.applied, ...out.archived, ...out.turnedDown].map((a) => a.folder);
  for (const open of ['tailored-still-open', 'tailored-and-liked', 'brand-new']) {
    assert.ok(!everywhere.includes(open), `${open} stays off the Applied page`);
  }
  assert.deepEqual(names(out.applied), ['sent', 'no-status-recorded']);
  assert.deepEqual(names(out.archived), ['sent-long-ago']);
  assert.deepEqual(names(out.progressing), ['interviewing']);
});

test('the Applied count excludes the rejected group, and a rejected row shows why instead of an outcome picker', () => {
  const js = emittedScript();
  assert.match(js, /appsum\.textContent = 'Applied — ' \+ applied\.length;/, 'archived ones have a section of their own');
  assert.match(js, /fold\(rejdocbox, rejdocsum, rejdoclist, 'Rejected \\u2014 documents kept', turnedDown\);/);
  assert.match(js, /\(a\.status === 'rejected'\s*\?\s*\(a\.rejectedReason \? '<span class="chip" title="Why you turned it down\.">'/);
  assert.match(js, /: '<select class="app-outcome"/, 'the picker is only for what was applied to');
});

/* ------------------------------------------------------------ the page may only be changed by itself */

test('a write must come from this page, not from another website', () => {
  // Binding to 127.0.0.1 keeps other machines out but not other websites: a page open
  // in the browser can POST to a local port, and a simple request needs no permission.
  assert.equal(sameOrigin('http://127.0.0.1:8787', 8787), true);
  assert.equal(sameOrigin('http://localhost:8787', 8787), true, 'localhost is this machine too');
  assert.equal(sameOrigin(undefined, 8787), true, 'a script or curl sends no Origin; the threat is a web page, which always does');
  assert.equal(sameOrigin('', 8787), true);

  for (const hostile of ['https://evil.example', 'http://evil.example:8787', 'http://127.0.0.1:9999',
    'http://127.0.0.1:8787.evil.example', 'null', 'https://127.0.0.1:8787', 'http://localhost.evil.example:8787']) {
    assert.equal(sameOrigin(hostile, 8787), false, hostile);
  }
  assert.match(serve, /if \(req\.method === 'POST' && !sameOrigin\(req\.headers\.origin, port\)\) \{\s*return json\(res, 403/);
});

/* ------------------------------------------------------------ the server */

test('the folder a page names is only ever an application, never a path', () => {
  for (const bad of ['..', '../x', 'a/b', 'a\\b', 'C:\\Windows', '', undefined, null, '.']) {
    const r = resolveApplication(bad);
    assert.equal(r.ok, false, `${JSON.stringify(bad)} is refused`);
    assert.match(r.error, /single name/);
  }
  const missing = resolveApplication('no-such-application-2000-01-01-x');
  assert.equal(missing.ok, false);
  assert.match(missing.error, /no application at/);
});

test('Open hands explorer the folder as an argument, with no shell', () => {
  const route = serve.slice(serve.indexOf("url.pathname === '/api/application-open'"), serve.indexOf("url.pathname === '/api/applications'"));
  assert.match(route, /applyMod\.resolveApplication\(JSON\.parse\(body \|\| '\{\}'\)\.folder\)/);
  assert.match(route, /execFile\('explorer\.exe', \[app\.dir\], \(\) => \{\}\)/);
  assert.doesNotMatch(route, /shell: true|exec\(|cmd/, 'a folder name never reaches a command line');
});

test('Regenerate finds the posting by the fingerprint the folder recorded, not by an id the page sent', () => {
  const route = serve.slice(serve.indexOf("url.pathname === '/api/apply'"), serve.indexOf("url.pathname === '/api/application-jd'"));
  assert.match(route, /const \{ id, folder, refresh \} = JSON\.parse/);
  assert.match(route, /job = pool\.find\(\(j\) => j\.fingerprint === app\.meta\.fingerprint\)/, 'exact match on the recorded fingerprint');
  assert.match(route, /refresh: Boolean\(refresh\),\s*folder: target,/, 'and written back into that folder');
  assert.match(route, /predates fingerprints/);
});

/* ------------------------------------------------------------ regenerating safely */

test('regenerating writes into the existing folder instead of starting a second one', () => {
  assert.match(apply, /const dir = join\(ROOT\(master\), folder \|\| folderFor\(job\)\);/);
});

test('the current documents are kept before anything is replaced, and before the model is called', () => {
  const keep = apply.indexOf('const kept = keepPrevious(dir);');
  const generate = apply.indexOf('await generate({ job, master, editable');
  assert.ok(keep > 0 && generate > keep, 'a failed backup stops everything while it costs nothing');
  assert.match(apply, /if \(refresh\) \{\s*const kept = keepPrevious\(dir\);/);
});

test('keepPrevious copies the documents aside and leaves the originals alone', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jobhunt-app-'));
  try {
    for (const f of ['Resume.docx', 'Resume.pdf', 'CoverLetter.docx', 'CoverLetter.pdf', 'job.md']) writeFileSync(join(dir, f), `old ${f}`);
    writeFileSync(join(dir, 'unrelated.txt'), 'not ours');
    const to = keepPrevious(dir, new Date('2026-10-01T12:34:56.789Z'));

    assert.match(to, /\.generation[\\/]previous[\\/]2026-10-01T12-34-56-789Z$/, 'a folder per regeneration, named by the time');
    assert.deepEqual(readdirSync(to).sort(), ['CoverLetter.docx', 'CoverLetter.pdf', 'Resume.docx', 'Resume.pdf', 'job.md']);
    assert.equal(readFileSync(join(to, 'CoverLetter.docx'), 'utf8'), 'old CoverLetter.docx');
    assert.equal(readFileSync(join(dir, 'Resume.pdf'), 'utf8'), 'old Resume.pdf', 'the originals stay until they are replaced');
    assert.ok(!existsSync(join(to, 'unrelated.txt')), 'nothing else is copied');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('with nothing to keep it does nothing, and a failed copy stops the regeneration', () => {
  const empty = mkdtempSync(join(tmpdir(), 'jobhunt-app-'));
  const blocked = mkdtempSync(join(tmpdir(), 'jobhunt-app-'));
  try {
    assert.equal(keepPrevious(empty), null);
    assert.ok(!existsSync(join(empty, '.generation')), 'and creates nothing');

    // A FILE where the folder must go, standing in for a document locked by Word.
    writeFileSync(join(blocked, 'Resume.docx'), 'old');
    writeFileSync(join(blocked, '.generation'), 'a file, not a folder');
    assert.throws(() => keepPrevious(blocked), /could not keep the current documents[\s\S]*nothing was changed/);
    assert.equal(readFileSync(join(blocked, 'Resume.docx'), 'utf8'), 'old', 'the original is untouched');
  } finally {
    rmSync(empty, { recursive: true, force: true });
    rmSync(blocked, { recursive: true, force: true });
  }
});

test('regenerating keeps the date, the outcome and — above all — the salary you asked for', () => {
  const prior = {
    at: '2026-09-20T09:00:00.000Z', outcome: 'interview', outcomeAt: '2026-09-25T10:00:00.000Z',
    salaryAsked: '85.000 EUR + Bonus', tailored: false, company: 'Acme',
  };
  const fresh = { at: '2026-10-01T12:00:00.000Z', company: 'Acme', storyline: 'new angle', outcome: null, blocked: 0 };
  const m = mergeMeta(fresh, prior, '2026-10-01T12:00:05.000Z');

  assert.equal(m.at, prior.at, 'the day you applied is not the day you regenerated');
  assert.equal(m.outcome, 'interview', 'an interview does not reset to nothing');
  assert.equal(m.outcomeAt, prior.outcomeAt);
  assert.equal(m.salaryAsked, '85.000 EUR + Bonus', 'the one fact nothing else remembers');
  assert.equal(m.storyline, 'new angle', 'the new draft is what changes');
  assert.equal(m.regeneratedAt, '2026-10-01T12:00:05.000Z');
  assert.equal('tailored' in m, false, 'it now has documents, so it is no longer "standard CV"');
});

test('a first generation is unchanged by all this', () => {
  const fresh = { at: 'now', outcome: null };
  assert.deepEqual(mergeMeta(fresh, null), fresh);
  assert.deepEqual(mergeMeta(fresh, undefined), fresh);
  assert.equal(mergeMeta(fresh, { at: 'earlier' }).salaryAsked, undefined, 'no figure invented where none was given');
});

test('the metadata is merged on write, from whatever the folder already holds', () => {
  assert.match(apply, /writeJson\(join\(gen, 'meta\.json'\), mergeMeta\(\{/);
  assert.match(apply, /\}, readJson\(join\(gen, 'meta\.json'\), null\)\)\);/);
});
