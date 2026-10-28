import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { execFile, spawn } from 'node:child_process';
import { p, log, readJson, writeJson, loadEnv } from './util.js';
import * as store from './store.js';
import * as rejects from './rejects.js';
import * as watchlist from './watchlist.js';
import { rejectionsHtml } from './rejections-page.js';
import { SITE_IDS as careersiteIds } from './sources/careersites.js';
import * as applyMod from './apply/index.js';
import { normalize } from './normalize.js';
import * as runner from './runner.js';
import * as logview from './logview.js';
import * as applog from './applog.js';
import * as queueStore from './queue.js';
import * as judging from './judging.js';
import * as parkedStore from './parked.js';
import { score } from './score.js';
import { renderQueue } from './report.js';

/**
 * A tiny local server so the report's buttons actually do something.
 *
 * The report is a static file by design — it opens from disk, works offline,
 * and survives being emailed to yourself. But a static file cannot write to
 * data/seen.json, so marking a job meant switching to the terminal and typing
 * a fingerprint. This closes that loop without giving up the static report:
 * the same HTML is served over http, and its buttons POST back here.
 *
 * Bound to 127.0.0.1 only. It is a personal tool holding your job search, so
 * it should not be reachable from the network.
 */
const HOST = '127.0.0.1';
const CONFIG = p('config', 'sources.json');

/**
 * The source list as the page needs it: on/off, plus whether a source *can* be
 * turned on at all. A checkbox that silently does nothing because the API key
 * is missing is worse than one that explains itself, so missing credentials are
 * reported rather than hidden — by NAME only, never by value.
 */
/**
 * sources.json also holds `queries`, `http` and comment keys. Without this
 * test, POSTing id="http" stamped `enabled: true` onto the HTTP settings block
 * and persisted it — a write endpoint must recognise its own targets, not
 * assume any key it is handed is one.
 */
const isSource = (id, v) =>
  !id.startsWith('_') && v && typeof v === 'object' && !Array.isArray(v) && 'enabled' in v;

/**
 * The watchlist with status worked out fresh on each request, so the panel
 * reflects the boards and archive as they are now rather than as they were when
 * the report was written.
 */
function listCompanies() {
  const companies = readJson(p('config', 'companies.json'));
  const state = store.load();
  const rejected = rejects.load();
  const archive = [...Object.values(state.jobs), ...Object.values(rejected)];

  const rows = watchlist.evaluate(watchlist.load(), {
    boards: companies.boards || [],
    workday: companies.workday || [],
    careersites: careersiteIds,
    beesite: companies.beesite || [],
    archive,
  });
  return { companies: rows, summary: watchlist.summarise(rows), statuses: watchlist.STATUS };
}

/**
 * The applications, each with the status of the job behind it.
 *
 * A folder exists for every job that was TAILORED, not only for those applied to: the
 * documents are written first, and a job is sometimes turned down on reaching the real
 * application — new demands, a paywall. Twelve of 67 folders were exactly that. Without
 * the status the page counted them as applications; with it, it can keep their
 * documents without calling them applied. Read from seen.json alone, which is small;
 * jobs.json is megabytes and holds nothing this needs.
 */
export function withStatus(applications, seen) {
  return applications.map((a) => {
    const e = a.fingerprint ? seen[a.fingerprint] : null;
    if (!e) return a;
    return { ...a, status: e.status, ...(e.rejectedReason ? { rejectedReason: e.rejectedReason } : {}) };
  });
}

export const listWithStatus = () => withStatus(applyMod.listApplications(), readJson(p('data', 'seen.json'), {}));

function listSources() {
  const cfg = readJson(CONFIG);
  return Object.entries(cfg)
    .filter(([id, v]) => isSource(id, v))
    .map(([id, v]) => {
      const missing = (v.requiresKey || []).filter((k) => !process.env[k]);
      return {
        id,
        label: v.label || id,
        enabled: Boolean(v.enabled),
        requiresKey: v.requiresKey || [],
        missingKeys: missing,
        usable: missing.length === 0,
        note: v._disabledComment || v._comment || null,
      };
    });
}

/**
 * Is the saved page older than the code that builds it?
 *
 * The page is a file written at the end of a scan, so its toolbar, styles and script
 * are frozen at that moment. Edit report.js and the server went on sending the old
 * bytes until the next scan or `npm run report`: a new button simply did not appear,
 * while every existing one kept working because its code was already in the file.
 * A missing source or a missing page is never "stale" -- there is nothing to compare.
 */
export function reportIsStale(reportPath, sourcePath) {
  try {
    return statSync(sourcePath).mtimeMs > statSync(reportPath).mtimeMs;
  } catch {
    return false;
  }
}

/**
 * Rebuild the page through the `report` command, as a child process.
 *
 * Not an import of the build: that lives inside index.js, which dispatches a command on
 * load, and `report` is already the one definition of how a page is rebuilt from the
 * archive -- a second copy here would be free to disagree with it. Inside Electron
 * process.execPath is electron.exe, so it is told to behave as plain Node (the same
 * rule as runner.js). Fails soft: on any error the old page is served and the reason logged.
 */
function rebuildReport() {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [p('src', 'index.js'), 'report'], {
      cwd: p('.'),
      env: { ...process.env, JOBHUNT_NO_LOGFILE: '1', ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}) },
      shell: false,
      stdio: 'ignore',
    });
    child.on('error', (e) => { log.warn(`Could not rebuild the report page: ${e.message}`); resolve(false); });
    child.on('close', (code) => {
      if (code !== 0) log.warn(`Rebuilding the report page exited with code ${code}; serving the old one.`);
      resolve(code === 0);
    });
  });
}

/**
 * `onChange` is called after anything that changes what is open — a mark — so a
 * caller that shows a count (the app's badge) can update at once instead of on its
 * next poll.
 */
export async function serve({ port = 8787, open = true, onChange = null, controls = null } = {}) {
  // The source panel reports which API keys are missing, which means this
  // process needs to have read .env even when started on its own.
  loadEnv();
  const reportPath = p('reports', 'latest.html');
  // Started anyway. The app window loads this server, and the log page is how you
  // find out why there is no report; refusing to start left you with neither.
  if (!existsSync(reportPath)) {
    log.warn('No report yet — run `npm run search` first. Serving a placeholder until there is one.');
  }

  let rebuilding = null; // the in-flight page rebuild, shared by concurrent requests

  // Tag whatever a request logs by what it is: tailoring, or something you did on the page.
  const tagFor = (req) => {
    const path = String(req.url || '').split('?')[0];
    if (path === '/api/apply') return 'tailor';
    if (path.startsWith('/api/app/')) return 'app';
    return req.method === 'POST' ? 'action' : 'app';
  };
  const server = createServer((req, res) => applog.withTag(tagFor(req), () => handle(req, res)));
  async function handle(req, res) {
    const url = new URL(req.url, `http://${HOST}:${port}`);

    // A write must come from this page. Binding to 127.0.0.1 keeps other machines out,
    // but not other WEBSITES: any page open in your browser can POST to a local port,
    // and a "simple" request needs no permission to do it. Browsers name the page a
    // POST came from in `Origin`; refuse one that is not this server. With the app's
    // controls here that matters — a website could otherwise quit it or start a scan.
    if (req.method === 'POST' && !sameOrigin(req.headers.origin, port)) {
      return json(res, 403, { error: 'this page may only be changed from itself' });
    }

    // --- mark a job ---
    if (req.method === 'POST' && url.pathname === '/api/mark') {
      let body = '';
      for await (const chunk of req) body += chunk;
      try {
        const { id, status, reason, salary } = JSON.parse(body || '{}');
        const state = store.load();
        let fp = store.resolveFingerprint(state, id);

        // Not in the live set? It may be a rejection the user wants anyway. The
        // review list is the only place those ids appear, and until now the
        // button there had nothing to talk to — resolveFingerprint only reads
        // seen.json, and a rejection is deliberately kept out of it.
        if (!fp) {
          const archive = rejects.load();
          const hit = Object.values(archive).find((e) => e.fingerprint === id || e.fingerprint.startsWith(id));
          if (hit) {
            store.promote(state, hit);
            fp = hit.fingerprint;
            log.dim(`  promoted ${hit.fingerprint.slice(0, 8)} out of the rejections — ${hit.title}`);
          }
        }

        if (!fp) return json(res, 404, { error: `no job matching "${id}"` });

        store.setStatus(state, fp, status, { reason: reason || null, salaryAsked: salary || null });
        store.save(state);

        // Same as the CLI: applying without tailoring still deserves a record,
        // because the advert is the part that disappears.
        if (status === 'applied' && state.jobs?.[fp]) {
          try {
            const r = applyMod.recordApplied(state.jobs[fp], { salaryAsked: salary || null });
            if (!r.existed) log.dim(`  kept the posting: ${r.dir}`);
          } catch (err) {
            log.warn(`  could not record the application — ${err.message}`);
          }
        }

        const e = state.seen[fp];
        log.ok(`${e.title} @ ${e.company} → ${status}${reason ? ` (${reason})` : ''}${salary ? ` (asked ${salary})` : ''}`);
        try { onChange?.(); } catch { /* a listener must not fail the mark that already succeeded */ }
        return json(res, 200, { ok: true, status, title: e.title });
      } catch (e) {
        return json(res, 400, { error: e.message });
      }
    }

    // --- clear a gate's rejections after reviewing them ---
    if (req.method === 'POST' && url.pathname === '/api/review') {
      let body = '';
      for await (const chunk of req) body += chunk;
      try {
        const { category, undo } = JSON.parse(body || '{}');
        if (!category) return json(res, 400, { error: 'category required' });

        const archive = rejects.load();
        const r = undo
          ? rejects.unmarkReviewed(archive, category)
          : rejects.markReviewed(archive, category);
        rejects.save(r.archive);

        const n = r.marked ?? r.cleared;
        const left = rejects.unreviewed(r.archive).length;
        log.ok(`${category}: ${n} rejection(s) ${undo ? 'restored' : 'marked reviewed'} · ${left} left to review`);
        return json(res, 200, { ok: true, marked: n, remaining: left });
      } catch (e) {
        return json(res, 400, { error: e.message });
      }
    }

    // --- which sources are on, and why some cannot be ---
    if (req.method === 'GET' && url.pathname === '/api/sources') {
      return json(res, 200, listSources());
    }

    // --- flip a source on or off ---
    if (req.method === 'POST' && url.pathname === '/api/sources') {
      let body = '';
      for await (const chunk of req) body += chunk;
      try {
        const { id, enabled } = JSON.parse(body || '{}');
        const cfg = readJson(CONFIG);
        if (!isSource(id, cfg[id])) return json(res, 404, { error: `unknown source "${id}"` });

        cfg[id].enabled = Boolean(enabled);
        writeJson(CONFIG, cfg);

        log.ok(`${cfg[id].label || id} → ${cfg[id].enabled ? 'enabled' : 'disabled'}`);
        return json(res, 200, { ok: true, id, enabled: cfg[id].enabled, sources: listSources() });
      } catch (e) {
        return json(res, 400, { error: e.message });
      }
    }

    // --- generate a tailored application for one posting ---
    // Slow by nature: two model calls plus Word, so 20-30 seconds. Blocking is
    // acceptable here — one user, one machine — and a job queue would be more
    // machinery than the problem deserves.
    if (req.method === 'POST' && url.pathname === '/api/apply') {
      let body = '';
      for await (const chunk of req) body += chunk;
      try {
        const { id, folder, refresh } = JSON.parse(body || '{}');
        const masterFile = p('config', 'master.json');
        if (!existsSync(masterFile)) return json(res, 400, { error: 'config/master.json not found — the generator has no facts to work from' });

        const pool = [...Object.values(store.load().jobs), ...Object.values(rejects.load())];
        let job;
        let target = null;
        if (folder) {
          // Regenerating an application that exists. The job is found by the
          // fingerprint the folder itself recorded — never by an id the page
          // sent — and the documents are written back INTO that folder, so the
          // application keeps one row, its date, its outcome and its salary.
          const app = applyMod.resolveApplication(folder);
          if (!app.ok) return json(res, 404, { error: app.error });
          if (!app.meta.fingerprint) return json(res, 400, { error: `${app.name} predates fingerprints, so its posting cannot be found to regenerate from` });
          job = pool.find((j) => j.fingerprint === app.meta.fingerprint);
          if (!job) return json(res, 404, { error: `the posting for ${app.name} is no longer in the archive` });
          target = app.name;
        } else {
          job = pool.find((j) => j.fingerprint?.startsWith(String(id).toLowerCase()));
          if (!job) return json(res, 404, { error: `no posting matching "${id}"` });
        }

        log.step(`${refresh ? 'Regenerating' : 'Tailoring'} an application for ${job.company}…`);
        // Without the profile the advert re-check silently does nothing, so the
        // button would generate against a stale ad while the CLI would not.
        const r = await applyMod.apply(job, {
          master: readJson(masterFile),
          profile: readJson(process.env.JOBHUNT_PROFILE || p('config', 'profile.json'), null),
          refresh: Boolean(refresh),
          folder: target,
        });
        return json(res, 200, {
          ok: true, folder: r.dir.split(/[\\/]/).pop(), blocked: r.blocked || 0,
          storyline: r.storyline, cached: Boolean(r.cached), regenerated: Boolean(refresh && target),
        });
      } catch (e) {
        log.err(`apply failed — ${e.message}`);
        return json(res, 500, { error: e.message });
      }
    }

    // --- the advert behind an application, so you can read it again ---
    // Read-only. The copy saved WITH the application comes first: it is what you
    // responded to, and the employer may since have edited or withdrawn the ad.
    if (req.method === 'GET' && url.pathname === '/api/application-jd') {
      const app = applyMod.resolveApplication(url.searchParams.get('folder'));
      if (!app.ok) return json(res, 404, { error: app.error });
      let text = applyMod.savedPosting(app.name);
      let source = 'saved with the application';
      if (!text) {
        text = store.load().jobs[app.meta.fingerprint]?.descriptionText || '';
        source = 'the posting as last read';
      }
      return json(res, 200, { text, source: text ? source : null, applyUrl: app.meta.applyUrl || null });
    }

    // The advert of any job on file, by the short id the page already holds. Read-only. The Turned
    // down list has no application folder to ask, and a job you dismissed is exactly one you may
    // want to read again.
    if (req.method === 'GET' && url.pathname === '/api/job-jd') {
      const state = store.load();
      let fp = null;
      try { fp = store.resolveFingerprint(state, String(url.searchParams.get('id') || '').slice(0, 16)); } catch { /* ambiguous */ }
      const job = fp && state.jobs[fp];
      if (!job) return json(res, 404, { error: 'that job is no longer on file' });
      return json(res, 200, {
        text: job.descriptionText || '',
        source: job.descriptionText ? 'the posting as last read' : null,
        applyUrl: job.applyUrl || null,
      });
    }

    // --- open an application's folder: the CV, the letter and the notes ---
    // The folder is looked up by name among the applications, never taken as a
    // path, and explorer is handed it as an argument — no shell.
    if (req.method === 'POST' && url.pathname === '/api/application-open') {
      let body = '';
      for await (const chunk of req) body += chunk;
      try {
        const app = applyMod.resolveApplication(JSON.parse(body || '{}').folder);
        if (!app.ok) return json(res, 404, { error: app.error });
        if (!existsSync(app.dir)) return json(res, 404, { error: `${app.name} is not on disk` });
        // explorer.exe reports exit code 1 even when it worked, so the result is ignored.
        execFile('explorer.exe', [app.dir], () => {});
        return json(res, 200, { ok: true });
      } catch (e) {
        return json(res, 400, { error: e.message });
      }
    }

    // --- what has been generated, and what came of it ---
    if (req.method === 'GET' && url.pathname === '/api/applications') {
      return json(res, 200, { applications: listWithStatus(), outcomes: applyMod.OUTCOMES });
    }

    if (req.method === 'POST' && url.pathname === '/api/applications') {
      let body = '';
      for await (const chunk of req) body += chunk;
      try {
        const { folder, outcome } = JSON.parse(body || '{}');
        const r = applyMod.setOutcome(folder, outcome);
        if (!r.ok) return json(res, 404, r);
        log.ok(`${r.meta.company}: ${outcome}`);
        return json(res, 200, { ok: true, applications: listWithStatus() });
      } catch (e) {
        return json(res, 400, { error: e.message });
      }
    }

    // --- what you changed after generation: the feedback ---
    if (req.method === 'GET' && url.pathname === '/api/feedback') {
      try {
        return json(res, 200, { pairs: await applyMod.learn(), notes: readJson(p('config', 'style-notes.json'), { rules: [], seen: [] }) });
      } catch (e) {
        return json(res, 500, { error: e.message });
      }
    }

    /**
     * Classify one correction. A rule needs THREE occurrences before it is
     * applied — three edits are not a style, and turning every correction into
     * an instruction produces a prompt full of contradictory micro-rules.
     */
    if (req.method === 'POST' && url.pathname === '/api/feedback') {
      let body = '';
      for await (const chunk of req) body += chunk;
      try {
        const { generated, yours, classification } = JSON.parse(body || '{}');
        const file = p('config', 'style-notes.json');
        const notes = readJson(file, { rules: [], seen: [] });

        notes.seen.push({ generated, yours, classification, at: new Date().toISOString() });
        if (classification === 'style') {
          const key = String(yours).slice(0, 60).toLowerCase();
          const hit = notes.rules.find((r) => r.key === key);
          if (hit) hit.count++;
          else notes.rules.push({ key, count: 1, generated, yours, active: false });
          for (const r of notes.rules) r.active = r.count >= 3;
        }
        writeJson(file, notes);
        return json(res, 200, { ok: true, active: notes.rules.filter((r) => r.active).length });
      } catch (e) {
        return json(res, 400, { error: e.message });
      }
    }

    // --- the company watchlist, with status derived from evidence ---
    if (req.method === 'GET' && url.pathname === '/api/companies') {
      return json(res, 200, listCompanies());
    }

    // --- record that you set up an email alert for a company ---
    if (req.method === 'POST' && url.pathname === '/api/companies') {
      let body = '';
      for await (const chunk of req) body += chunk;
      try {
        const { id, alert } = JSON.parse(body || '{}');
        const wl = watchlist.load();
        const r = watchlist.setAlert(wl, id, alert);
        if (!r.ok) return json(res, 404, { error: r.error });
        watchlist.save(wl);
        log.ok(`${r.company.name}: email alert ${alert ? 'recorded' : 'cleared'}`);
        return json(res, 200, { ok: true, companies: listCompanies() });
      } catch (e) {
        return json(res, 400, { error: e.message });
      }
    }

    // --- current statuses, so the page can show what you already did ---
    if (req.method === 'GET' && url.pathname === '/api/statuses') {
      const state = store.load();
      const out = {};
      for (const [fp, e] of Object.entries(state.seen)) out[fp.slice(0, 8)] = e.status;
      return json(res, 200, out);
    }

    // --- what is open right now, as cards, for the page to match itself against ---
    // Worked out from the live data on every call, so the page can be made true
    // without a new report. `have` lists the cards the page already holds; only the
    // others are rendered.
    if (req.method === 'GET' && url.pathname === '/api/queue') {
      try {
        const have = new Set((url.searchParams.get('have') || '').split(',').filter(Boolean));
        const profile = readJson(process.env.JOBHUNT_PROFILE || p('config', 'profile.json'), null) ?? readJson(p('config', 'profile.example.json'));
        const state = store.load();
        const open = queueStore.openJobs(state).map((j) => {
          const e = state.seen[j.fingerprint];
          return {
            ...j,
            ...score(j, profile),
            band: j.verdict?.band === 'stretch' ? 'stretch' : 'main',
            status: e.status,
            firstSeen: e.firstSeen || null,
            carried: e.status !== 'new',
          };
        });
        return json(res, 200, renderQueue(open, profile, have));
      } catch (e) {
        return json(res, 500, { error: e.message });
      }
    }

    // --- what you turned down lately, so the page can still say so ---
    if (req.method === 'GET' && url.pathname === '/api/turned-down') {
      return json(res, 200, store.turnedDown(store.load()));
    }

    // --- a job you found somewhere this tool does not reach ---
    if (req.method === 'POST' && url.pathname === '/api/manual') {
      let body = '';
      for await (const chunk of req) body += chunk;
      try {
        const f = JSON.parse(body || '{}');
        const title = String(f.title || '').trim();
        const company = String(f.company || '').trim();
        if (!title || !company) {
          return json(res, 400, { error: 'a title and a company are required — the fingerprint is built from them' });
        }

        const profile = readJson(process.env.JOBHUNT_PROFILE || p('config', 'profile.json'), null);
        if (!profile) return json(res, 500, { error: 'config/profile.json is missing' });

        const applyUrl = String(f.url || '').trim();
        // Normalized through the same function every source goes through, so a
        // pasted job is geocoded, work-mode detected and fingerprinted exactly
        // like a fetched one. Anything else and the same posting arriving from
        // a real source tomorrow would be filed as a second job.
        const job = normalize({
          source: 'manual',
          sourceLabel: 'Added by you',
          // The URL is the natural id. Without one the fingerprint still
          // identifies it, and reconcile simply has no second opinion to offer.
          sourceId: applyUrl || `hand:${title}:${company}`,
          title,
          company,
          location: String(f.location || '').trim(),
          descriptionText: String(f.description || '').trim(),
          descriptionHtml: '',
          applyUrl,
          postedAt: null,
        }, profile);

        const state = store.load();
        const r = store.addManual(state, job);
        store.save(state);

        log.ok(`added by hand: ${job.title} — ${job.company} (${r.fingerprint.slice(0, 8)})`);
        return json(res, 200, {
          ok: true,
          id: r.fingerprint.slice(0, 8),
          existed: r.existed,
          title: job.title,
          company: job.company,
          // The STORED length, not what was just posted: a re-add with an
          // empty box keeps the advert, and reporting 0 there would tell you
          // tailoring has nothing to read when it does.
          descriptionChars: (r.job.descriptionText || '').length,
        });
      } catch (e) {
        return json(res, 400, { error: e.message });
      }
    }

    // The ids still parked. The report bakes its list in when it is written, so a page
    // opened later would show postings already dealt with; the page asks this instead.
    if (req.method === 'GET' && url.pathname === '/api/parked') {
      return json(res, 200, Object.keys(parkedStore.load()).map((k) => k.slice(0, 8)));
    }

    // --- postings parked because their advert never arrived: act on them by hand ---
    if (req.method === 'POST' && url.pathname === '/api/parked') {
      let body = '';
      for await (const chunk of req) body += chunk;
      try {
        const { id, action, description, reason } = JSON.parse(body || '{}');
        if (action !== 'add' && action !== 'reject') return json(res, 400, { error: 'action must be add or reject' });
        const file = parkedStore.load();
        const hits = Object.keys(file).filter((k) => id && k.startsWith(String(id)));
        if (hits.length !== 1) return json(res, hits.length ? 400 : 404, { error: hits.length ? `ambiguous id "${id}"` : `no parked posting matching "${id}"` });
        const entry = file[hits[0]];

        const text = String(description || '').trim();
        // Adding is the point of pasting the advert; without it the job would be a
        // title with nothing to read, which is how it got parked in the first place.
        if (action === 'add' && !text) return json(res, 400, { error: 'paste the advert text to add it' });

        const profile = readJson(process.env.JOBHUNT_PROFILE || p('config', 'profile.json'), null);
        if (!profile) return json(res, 500, { error: 'config/profile.json is missing' });

        // Same route as a job added by hand: normalized like every fetched posting, so
        // the advert is read (language, stack, distance) and the job merges with the
        // same role arriving from a source later.
        const job = normalize({
          source: entry.source || 'manual',
          sourceLabel: entry.sourceLabel || 'Added by you',
          sourceId: entry.applyUrl || `hand:${entry.title}:${entry.company}`,
          title: entry.title,
          company: entry.company,
          location: entry.location || '',
          descriptionText: text,
          descriptionHtml: '',
          applyUrl: entry.applyUrl || '',
          postedAt: null,
        }, profile);

        const state = store.load();
        const r = store.addManual(state, job);
        if (action === 'reject') {
          store.setStatus(state, r.fingerprint, 'rejected', { reason: reason || null });
          // It was parked, not typed in: do not label a rejection "added by hand".
          if (!r.existed) delete state.seen[r.fingerprint].addedByHand;
        }
        store.save(state);

        // Out of the parked list under BOTH identities: the pasted advert can move the
        // fingerprint (work mode is derived from the text), and a leftover entry would
        // come back as waiting for text it already has.
        parkedStore.release(file, [entry.fingerprint, r.fingerprint]);
        parkedStore.save(file);

        log.ok(`parked posting ${action === 'add' ? 'added' : 'turned down'}: ${job.title} — ${job.company} (${r.fingerprint.slice(0, 8)})`);
        try { onChange?.(); } catch { /* a listener must not fail the action that already succeeded */ }
        return json(res, 200, { ok: true, action, id: r.fingerprint.slice(0, 8), title: job.title, company: job.company });
      } catch (e) {
        return json(res, 400, { error: e.message });
      }
    }

    // --- what is waiting to be judged: read from two files, so it works under `npm run serve` too ---
    if (url.pathname === '/api/judging' && req.method === 'GET') {
      return json(res, 200, judging.status());
    }

    // --- the app itself: what the tray menu can do, offered to the page ---
    // Only present when the app is the thing serving. Under `npm run serve` there is no
    // tray, no scanner and no login item to control, so the page is told so and hides
    // the controls rather than showing buttons that do nothing.
    if (url.pathname === '/api/app' && req.method === 'GET') {
      return json(res, 200, controls ? { available: true, ...controls.status() } : { available: false });
    }

    if (url.pathname.startsWith('/api/app/') && req.method === 'POST') {
      if (!controls) return json(res, 404, { error: 'the app controls are only available in the app' });
      let body = '';
      for await (const chunk of req) body += chunk;
      try {
        const b = JSON.parse(body || '{}');
        if (url.pathname === '/api/app/scan') {
          const r = await controls.scanNow();
          return json(res, r.ok ? 200 : 409, { ...r, ...controls.status() });
        }
        if (url.pathname === '/api/app/judge') {
          const r = await controls.judgeNow();
          return json(res, r.ok ? 200 : 409, { ...r, ...controls.status() });
        }
        if (url.pathname === '/api/app/pause') {
          controls.setPaused(b.paused);
          return json(res, 200, { ok: true, ...controls.status() });
        }
        if (url.pathname === '/api/app/login') {
          controls.setStartWithWindows(b.enabled);
          return json(res, 200, { ok: true, ...controls.status() });
        }
        if (url.pathname === '/api/app/quit') {
          // Answered first: the process ends a moment later, and a reply that never
          // arrives would read as a failure.
          json(res, 200, { ok: true });
          setTimeout(() => controls.quit(), 200);
          return;
        }
        return json(res, 404, { error: 'no such control' });
      } catch (e) {
        return json(res, 400, { error: e.message });
      }
    }

    // --- the log, with the output of a scan that is running right now ---
    if (req.method === 'GET' && url.pathname === '/api/log') {
      const st = runner.status();
      const live = st.running ? runner.scrollback().map((e) => `${new Date(e.at).toISOString()} [scan] ${e.line}`) : [];
      return json(res, 200, {
        text: logview.compose(logview.readLog(300), st, live),
        running: st.running,
        mode: st.mode || null,
      });
    }

    // --- the report itself, re-read each time so a fresh search shows up ---
    // The rejection list, rendered from the archive on each request: it is a page
    // of its own (it was 9.6MB of the report's 10), and "Mark all reviewed" should
    // show on reload rather than at the next search. `?all` includes the reviewed.
    if (req.method === 'GET' && (url.pathname === '/rejections' || url.pathname === '/rejections.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(rejectionsHtml({ all: url.searchParams.has('all') }));
    }

    // `/latest.html` is the report too, so the same relative link works from the
    // file on disk and from here.
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html' || url.pathname === '/latest.html')) {
      // One rebuild at a time: a reload during the ~8 seconds it takes waits for the
      // same build instead of starting a second one over the same file.
      if (reportIsStale(reportPath, p('src', 'report.js'))) {
        rebuilding ||= (log.dim('Report page is older than src/report.js -- rebuilding it.'), rebuildReport())
          .finally(() => { rebuilding = null; });
        await rebuilding;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(existsSync(reportPath) ? readFileSync(reportPath) : logview.NO_REPORT_PAGE);
    }

    json(res, 404, { error: 'not found' });
  }

  server.listen(port, HOST, () => {
    const addr = `http://${HOST}:${port}`;
    log.head('jobsieve server');
    log.ok(`Report with working buttons: ${addr}`);
    log.dim('  Applied / Interested / Not for me now save straight to data/seen.json.');
    log.dim('  Ctrl+C to stop.\n');
    if (open) execFile('cmd', ['/c', 'start', '', addr], () => {});
  });

  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
      log.err(`Port ${port} is already in use — try: npm run serve -- --port 8788`);
    } else {
      log.err(e.message);
    }
    process.exit(1);
  });

  // Handed back so a caller that wants to stop it (a test) can; the CLI and the app
  // simply keep it running.
  return server;
}

/**
 * Is a POST's `Origin` this server? No header at all is allowed — a script or `curl`
 * sends none, and the threat is a web page, which always does. 127.0.0.1 and localhost
 * are both this machine, so either may be what you typed.
 */
export function sameOrigin(origin, port) {
  if (origin === undefined || origin === '') return true;
  return origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`;
}

const json = (res, code, obj) => {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
};
