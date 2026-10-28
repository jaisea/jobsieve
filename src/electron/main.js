import { app, BrowserWindow, Tray, Menu, Notification, nativeImage, session, shell, powerMonitor } from 'electron';
import { createConnection } from 'node:net';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { p, loadEnv } from '../util.js';
import * as applog from '../applog.js';
import * as runner from '../runner.js';
import { serve } from '../serve.js';
import * as daemon from '../daemon.js';
import * as judging from '../judging.js';
import * as lock from '../lock.js';
import * as connectivity from '../connectivity.js';
import { badgePng, labelFor } from './badge.js';
import { classify } from './links.js';

/**
 * The app: a window that shows the report and the log, a tray icon and a taskbar
 * button that both carry the number of open jobs, and a timer that wakes every
 * half hour. Everything it decides lives in ../daemon.js and ../schedule.js; the
 * searching itself is the same `search` command you would type, run as a child
 * process by ../runner.js.
 *
 * The window loads the local report server. Only that address loads in it — every
 * other link (a posting, a company page) opens in your browser, where your logins
 * are. Closing the window hides it to the tray so scanning carries on; Quit in
 * the tray menu is what ends the app.
 *
 * Launch it with `npm run tray`, or with the shortcut `npm run tray:shortcut` makes.
 *   --hidden    start in the tray without showing the window (what start-with-Windows uses)
 *   --no-scan   show the window and serve the report, but never start a search
 *   --port N    serve the report on port N instead of the configured one
 *   --smoke     do the setup, print one line of what it found, and quit
 */
const MAIN = fileURLToPath(import.meta.url);
const REPORT = p('reports', 'latest.html');
const REFRESH_MS = 15000;
const FIRST_TICK_MS = 10000;
const RESUME_TICK_MS = 30000;
const BUSY_RETRY_MS = 60000;
// While waiting for a connection: often enough that a scan starts within seconds of
// Wi-Fi coming back, rarely enough that one probe every 20 seconds costs nothing.
const OFFLINE_RETRY_MS = 20000;

applog.tee('app');
const flags = new Set(process.argv.slice(1));
// `--port 8798` runs a second copy beside the real one without touching its port.
const portArg = Number(process.argv[process.argv.indexOf('--port') + 1]);
const cfg = {
  ...daemon.settings(),
  ...(process.argv.includes('--port') && Number.isInteger(portArg) && portArg > 0 && portArg < 65536 ? { port: portArg } : {}),
};
const tickMs = cfg.tickMinutes * 60000;
const LOGIN_ARGS = [MAIN, '--hidden'];

let prefs = daemon.loadPrefs();
let tray = null;
let win = null;
let quitting = false;
let timer = null;
let nextTickAt = null;
let lastScan = null;
let before = new Set();
let runLines = [];
// New jobs already announced during the current scan, and when: see daemon.progressNotice.
let announced = 0;
let lastNoticeAt = null;
let lastFresh = 0;
let offline = false;
let iconKey = '';
let overlayKey = '';
let menuKey = '';
let serverUp = false;

const hhmm = (d) => d.toTimeString().slice(0, 5);

// Goes to the shared log (see applog.js): the console has no window here, so tee() is what
// puts it in the file the Log tab reads — the same one terminal commands append to.
function note(text, tag = 'app') {
  applog.withTag(tag, () => console.log(text));
}

// A tray app has no console, and Electron's default for an uncaught error in the
// main process is a modal dialog. Write it down instead and keep running.
process.on('uncaughtException', (e) => note(`uncaught: ${e.stack || e}`));
process.on('unhandledRejection', (e) => note(`unhandled rejection: ${e?.stack || e}`));

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // Opening the shortcut again brings the running app forward instead of starting a second.
  app.on('second-instance', () => showWindow());
  app.on('before-quit', () => { quitting = true; });
  app.on('window-all-closed', () => {});
  app.whenReady().then(start);
}

function portOpen(port) {
  return new Promise((resolve) => {
    const s = createConnection({ port, host: '127.0.0.1' });
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('error', () => resolve(false));
  });
}

/**
 * The window and the log page are served by the same server `npm run serve`
 * starts, so the report's buttons work. If that is already running — port taken —
 * it is reused rather than fought over: serve() exits the whole process on
 * EADDRINUSE.
 */
async function ensureServer() {
  if (serverUp) return;
  if (await portOpen(cfg.port)) { serverUp = true; return; }
  // `refresh` as the change hook: marking a job in the window moves the badge now,
  // not at the next fifteen-second poll.
  await serve({ port: cfg.port, open: false, onChange: () => refresh(), controls });
  serverUp = true;
}

function toast(body) {
  if (!cfg.notifications || !Notification.isSupported()) return;
  const n = new Notification({ title: 'jobsieve', body });
  n.on('click', showWindow);
  n.show();
}

/* ------------------------------------------------------------ the windows */

const WEB_PREFERENCES = { contextIsolation: true, nodeIntegration: false, sandbox: true };

/**
 * Only this app's own address may load in a window. A link to anywhere else goes
 * to the browser, and anything that is not a web address is refused outright —
 * the report is built from text that job boards wrote.
 */
function guard(w) {
  w.webContents.setWindowOpenHandler(({ url }) => {
    const kind = classify(url, cfg.port);
    if (kind === 'external') shell.openExternal(url);
    else if (kind === 'internal') w.loadURL(url);
    return { action: 'deny' };
  });
  w.webContents.on('will-navigate', (ev, url) => {
    const kind = classify(url, cfg.port);
    if (kind === 'internal') return;
    ev.preventDefault();
    if (kind === 'external') shell.openExternal(url);
  });
}

const appIcon = () => nativeImage.createFromBuffer(badgePng('JH', { tone: 'open', size: 128 }));

function createWindow() {
  const w = new BrowserWindow({
    width: 1280,
    height: 860,
    title: 'jobsieve',
    icon: appIcon(),
    autoHideMenuBar: true,
    webPreferences: WEB_PREFERENCES,
  });
  guard(w);
  // Our title carries the count; the page's own would replace it.
  w.on('page-title-updated', (ev) => ev.preventDefault());
  // Closing hides to the tray, because the app's job is to keep scanning.
  w.on('close', (ev) => {
    if (quitting) return;
    ev.preventDefault();
    w.hide();
  });
  w.loadURL(`http://127.0.0.1:${cfg.port}/`);
  overlayKey = '';
  return w;
}

async function showWindow() {
  await ensureServer().catch((e) => note(`server: ${e.message}`));
  // Rebuilding from the archive costs no network, and there is nothing on disk to overwrite.
  if (!existsSync(REPORT) && !runner.status().running) startScan('report', ' (no report yet)');
  if (!win || win.isDestroyed()) win = createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  refresh();
}

/**
 * The log is a tab of the window, not a window of its own: it opens the main window
 * (creating it if it is hidden or closed) and switches it to the Log tab.
 */
async function showLogs() {
  await showWindow();
  const toLog = () => win.webContents.executeJavaScript("location.hash = '#log'").catch(() => {});
  // A window that has only just been created is still loading the page that owns the tab.
  if (win.webContents.isLoading()) win.webContents.once('did-finish-load', toLog);
  else toLog();
}

function reloadReport() {
  if (!win || win.isDestroyed()) return;
  win.webContents.reload();
  refresh();
}

/**
 * After a scan: ask the page to match itself to the data now rather than at its
 * next look. It adds the new cards without reloading, so a half-chosen reason or a
 * typed filter survives — which is why there is no longer any hint to press F5.
 */
function refreshWindow() {
  if (!win || win.isDestroyed()) return;
  win.webContents.executeJavaScript('window.__refresh && window.__refresh()').catch(() => {});
}

function buildAppMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: 'jobsieve',
      submenu: [
        { label: 'Reload', accelerator: 'F5', click: reloadReport },
        { label: 'Reload', accelerator: 'CmdOrCtrl+R', visible: false, click: reloadReport },
        { label: 'Log', accelerator: 'CmdOrCtrl+L', click: showLogs },
        { type: 'separator' },
        { label: 'Quit', click: () => app.quit() },
      ],
    },
    { label: 'View', submenu: [{ role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'resetZoom' }] },
  ]));
}

/* ------------------------------------------------------------------ scans */

function startScan(mode, why = '') {
  // A search typed into a terminal is invisible to the runner, which only knows
  // about its own child. The lock file is what both can see.
  if (mode !== 'report' && lock.holder()) {
    note(`${mode}: not started — a search is already running elsewhere`, 'scan');
    return { ok: false, error: 'a search is already running elsewhere' };
  }
  const snapshot = daemon.seenKeys();
  const r = runner.start(mode, { confirmed: true });
  if (!r.ok) {
    note(`${mode}: not started — ${r.error}`, 'scan');
    return r;
  }
  before = snapshot;
  runLines = [];
  announced = 0;
  lastNoticeAt = null;
  lastFresh = 0;
  note(`${mode} started${why}`, 'scan');
  refresh();
  return r;
}

/** Returns how long to wait before looking again. */
async function tick() {
  if (prefs.paused) {
    offline = false;
    refresh();
    return tickMs;
  }
  // Busy is not the same as "nothing to do": looking again in a minute rather
  // than half an hour is what stops one overlapping run costing a whole interval.
  if (runner.status().running || lock.holder()) {
    refresh();
    return BUSY_RETRY_MS;
  }
  // Two kinds of work: a source whose sleep is over, and postings the model could not
  // answer (or a source fetched and never judged) once its limit has reset.
  const { due, judge, judgeAt } = daemon.plan();
  if (!due.length && !judge) {
    offline = false;
    refresh();
    // The model's wait may end before the next tick; use the quota when it does.
    return daemon.idleDelayMs(tickMs, judgeAt);
  }

  // Something is due, so ask whether a scan could succeed before starting one. With no
  // connection it would only fail — and failing is not free: it puts every source on a
  // retry and charges the metered ones a run. So wait for the connection instead of for
  // a timer: look again in seconds, and scan the moment it is back. This is what makes
  // the first check after waking from sleep, before Wi-Fi has reconnected, harmless.
  const what = due.length ? `${due.length} source(s) due` : 'postings waiting for the AI';
  if (!(await connectivity.isOnline())) {
    if (!offline) note(`${what}, but there is no internet connection — waiting for one`, 'scan');
    offline = true;
    refresh();
    return OFFLINE_RETRY_MS;
  }
  if (offline) note('the connection is back');
  offline = false;

  // A due scan judges the waiting postings first anyway; the judging-only run is for when
  // nothing is due to fetch but the model is available again.
  if (due.length) {
    note(`${due.length} source(s) due: ${due.join(', ')}`, 'scan');
    startScan('due');
  } else {
    note('the AI is available again — judging the postings that were waiting', 'scan');
    startScan('judge');
  }
  refresh();
  return tickMs;
}

/**
 * "Scan now" is a request, not a fetch in flight, so it can be refused politely. It
 * answers `{ ok }` or `{ ok: false, error }` so the tray menu and the page can each
 * say so their own way — a toast in one place, a line of text in the other.
 */
async function scanNow() {
  if (!(await connectivity.isOnline())) {
    note('scan every source: no internet connection', 'scan');
    return { ok: false, error: 'No internet connection — try again when you are online.' };
  }
  const r = startScan('search', ' (from the menu)');
  return r.ok ? { ok: true } : { ok: false, error: r.error };
}

/**
 * "Judge them now": ask the model about the postings it could not answer, ignoring the
 * wait. If it is still limited the run simply holds them again, at the cost of one call.
 */
async function judgeNow() {
  if (!judging.status().any) return { ok: false, error: 'Nothing is waiting to be judged.' };
  if (!(await connectivity.isOnline())) {
    note('judge waiting postings: no internet connection', 'scan');
    return { ok: false, error: 'No internet connection — try again when you are online.' };
  }
  const r = startScan('judge', ' (from the menu)');
  return r.ok ? { ok: true } : { ok: false, error: r.error };
}

function planTick(delayMs) {
  nextTickAt = new Date(Date.now() + delayMs);
  timer = setTimeout(async () => {
    let next = tickMs;
    try { next = await tick(); } finally { planTick(next); }
  }, delayMs);
}

/**
 * While a scan runs, say so as soon as it has found something. Each source's results are saved
 * and on the page the moment its batch is judged, so waiting for the scan to end made a job that
 * had been on the page for ten minutes arrive as a notification after them.
 */
function announceProgress() {
  if (!runner.status().running) return;
  let fresh;
  try { fresh = daemon.freshSince(before); } catch { return; }

  // The window and the badge follow the data at once, not at their next poll.
  if (fresh > lastFresh) {
    lastFresh = fresh;
    refresh();
    refreshWindow();
  }

  const n = daemon.progressNotice({ fresh, notified: announced, lastAt: lastNoticeAt, now: Date.now() });
  if (!n) return;
  announced = n.notified;
  lastNoticeAt = Date.now();
  toast(`${n.text} · ${daemon.describeOpen(daemon.openCounts())}`);
}

function onDone(result) {
  const fresh = daemon.freshSince(before);
  // Rebuilding the page from the archive is not a scan; only its failure matters.
  if (result.mode !== 'report' || !result.ok) lastScan = { at: new Date(), ok: result.ok, fresh, mode: result.mode };
  const kept = result.ok ? runLines.slice(-12) : runLines;
  note(`${result.mode} ${result.ok ? 'finished' : 'FAILED'} — ${fresh} new\n${kept.join('\n')}`, 'scan');
  refresh();
  ensureServer().then(refreshWindow).catch((e) => note(`server: ${e.message}`));

  if (!result.ok) return toast('A scan failed — the tray icon is red. Open the log from the tray menu to see why.');
  // What was already announced while the scan ran is not announced again: only what is left.
  const rest = daemon.finalNotice({ fresh, notified: announced });
  if (rest) toast(`${rest.text} · ${daemon.describeOpen(daemon.openCounts())}`);
}

/* ------------------------------------------------------------ tray + badge */

function describeScan() {
  if (runner.status().running) {
    return runner.status().mode === 'judge' ? 'Judging the waiting postings…' : `Scanning… (${runner.status().mode})`;
  }
  if (offline) return 'Offline — waiting for a connection';
  if (!lastScan) return 'No scan since the app started';
  const what = lastScan.ok ? `${lastScan.fresh} new` : 'FAILED';
  return `Last scan ${hhmm(lastScan.at)} — ${what}`;
}

function describeNext() {
  if (prefs.paused) return 'Scanning is paused';
  if (offline) return 'Will fetch as soon as a connection is back';
  if (!nextTickAt) return 'Not scheduled';
  const at = daemon.nextFetchAt(nextTickAt, daemon.plan().wakes, cfg.tickMinutes);
  return `Next fetch about ${hhmm(at)}`;
}

/** What is waiting for the AI, one line per kind, or an empty list. */
const describeJudging = () => judging.status().text.split('\n').filter(Boolean);

function loginState() {
  return app.getLoginItemSettings({ path: process.execPath, args: LOGIN_ARGS }).openAtLogin;
}

/**
 * Everything the tray menu can do, as one object — handed to the page's server so the
 * window offers the same controls, and used by the menu itself. There is one
 * implementation of each, so the two cannot drift: a button on the page and a menu
 * item that both say "pause" are the same function.
 */
const controls = {
  status: () => ({
    scanning: runner.status().running,
    mode: runner.status().mode || null,
    scanText: describeScan(),
    nextText: describeNext(),
    paused: prefs.paused,
    offline,
    startWithWindows: loginState(),
  }),
  scanNow,
  judgeNow,
  setPaused: (paused) => {
    prefs = { ...prefs, paused: Boolean(paused) };
    daemon.savePrefs(prefs);
    refresh();
  },
  setStartWithWindows: (enabled) => {
    app.setLoginItemSettings({ openAtLogin: Boolean(enabled), path: process.execPath, args: LOGIN_ARGS });
  },
  quit: () => { quitting = true; app.quit(); },
};

function buildMenu(counts) {
  const running = runner.status().running;
  return Menu.buildFromTemplate([
    { label: daemon.describeOpen(counts), enabled: false },
    { label: 'Open jobsieve', click: showWindow },
    { label: 'Log', click: showLogs },
    { type: 'separator' },
    { label: describeScan(), enabled: false },
    { label: describeNext(), enabled: false },
    // Only when something is waiting for the AI: why, and when it carries on.
    ...describeJudging().map((label) => ({ label: `⏳ ${label}`, enabled: false })),
    ...(judging.status().any ? [{
      label: 'Judge the waiting postings now',
      enabled: !running,
      click: async () => {
        const r = await controls.judgeNow();
        if (!r.ok) toast(r.error);
      },
    }] : []),
    {
      label: 'Scan every source now',
      enabled: !running,
      click: async () => {
        const r = await controls.scanNow();
        if (!r.ok) toast(r.error);
      },
    },
    { label: 'Pause scanning', type: 'checkbox', checked: prefs.paused, click: (item) => controls.setPaused(item.checked) },
    { type: 'separator' },
    { label: 'Start with Windows', type: 'checkbox', checked: loginState(), click: (item) => controls.setStartWithWindows(item.checked) },
    { label: 'Quit', click: controls.quit },
  ]);
}

function refresh() {
  if (!tray) return;
  let counts;
  let broken = false;
  try {
    counts = daemon.openCounts();
  } catch (e) {
    // An unreadable seen.json must not read as "nothing open".
    note(`could not read the open count: ${e.message}`);
    counts = { waiting: 0, interested: 0 };
    broken = true;
  }

  // Every open job — waiting and interested — is the number everywhere it appears.
  const open = daemon.openTotal(counts);
  const failed = broken || (lastScan && !lastScan.ok);
  const tone = failed ? 'error' : open > 0 ? 'open' : 'idle';
  const label = labelFor(open, tone);
  const summary = [daemon.describeOpen(counts), describeScan(), ...describeJudging()].join('\n');

  if (`${tone}:${label}` !== iconKey) {
    iconKey = `${tone}:${label}`;
    tray.setImage(nativeImage.createFromBuffer(badgePng(label, { tone }), { scaleFactor: 2 }));
  }
  tray.setToolTip(`jobsieve — ${summary}`);

  if (win && !win.isDestroyed()) {
    win.setTitle(`jobsieve — ${daemon.describeOpen(counts)}`);
    // The same number on the taskbar button, as a red circle like a messaging app's
    // unread count. Nothing open means no badge at all.
    const key = `${tone}:${label}`;
    if (process.platform === 'win32' && key !== overlayKey) {
      overlayKey = key;
      win.setOverlayIcon(
        tone === 'idle' ? null : nativeImage.createFromBuffer(badgePng(label, { tone: 'alert', shape: 'circle' }), { scaleFactor: 2 }),
        daemon.describeOpen(counts),
      );
    }
  }

  // Replacing the menu while it is open can dismiss it, so only rebuild when
  // something the menu shows has changed.
  const key = JSON.stringify([counts, describeScan(), describeNext(), describeJudging(), prefs.paused, runner.status().running]);
  if (key !== menuKey) {
    menuKey = key;
    tray.setContextMenu(buildMenu(counts));
  }
}

async function start() {
  loadEnv();
  app.setAppUserModelId('com.jobsieve.tray');
  // Nothing the report loads may ask for a permission; it has no use for any.
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, done) => done(false));

  tray = new Tray(nativeImage.createFromBuffer(badgePng('0', { tone: 'idle' }), { scaleFactor: 2 }));
  tray.on('click', showWindow);
  refresh();
  setInterval(() => { refresh(); announceProgress(); }, REFRESH_MS);
  await ensureServer().catch((e) => note(`server: ${e.message}`));

  if (flags.has('--smoke')) {
    note(`smoke: ${JSON.stringify({ counts: daemon.openCounts(), serverUp, due: daemon.plan().due.length })}`);
    return app.quit();
  }

  buildAppMenu();
  // Started by Windows at login it stays in the tray; started by you it opens.
  if (!flags.has('--hidden')) await showWindow();
  if (flags.has('--no-scan')) return note('started with --no-scan: the window and report only');

  runner.bus.on('line', (e) => runLines.push(e.line));
  runner.bus.on('done', onDone);
  powerMonitor.on('resume', () => {
    clearTimeout(timer);
    planTick(RESUME_TICK_MS);
  });
  planTick(FIRST_TICK_MS);
  note(`started: checking every ${cfg.tickMinutes} min, report on port ${cfg.port}`);
}
