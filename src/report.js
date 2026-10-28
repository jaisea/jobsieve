import { escapeHtml, daysSince, parseDate } from './util.js';
import { germanGap, MIN_DESCRIPTION_CHARS } from './language.js';
import { REJECT_CATEGORIES, PICKER_GROUPS } from './filter.js';

/**
 * Self-contained HTML — inline CSS/JS, zero external requests, so it opens from
 * disk, works offline, and survives being emailed to yourself.
 */
export function buildReport({ jobs, profile, meta, attributions = [], openJobs = [], rejected = [], rejectedCount = null, reviewedCount = 0, parked = [] }) {
  // The rejection ROWS are not in this page — they were 9.6MB of its 10.06 and live
  // on rejections.html. Only how many are waiting is needed here.
  const awaiting = rejectedCount ?? rejected.length;
  // One queue by default: today's finds and the still-open backlog are banded
  // together, because they are the same decision — "should I apply to this?".
  // Splitting them by discovery date buries a strong role from last week under
  // a weak one from this morning. The carried cards keep a `carried` marker so
  // the toolbar checkbox can pull them back out into their own section, and so
  // they stay visually distinguishable while merged.
  /* `meta.sourceLines` is deliberately NOT rendered.
   *
   * A per-run "Sources this run" list used to sit under the banner. Removed on
   * request: it is diagnostics, it never changed a decision, and the terminal
   * prints the same lines while the run is happening. The field stays on `meta`
   * and in the run snapshot because index.js and the replay both use it —
   * nothing was collected for this panel alone — so there is nothing to strip
   * upstream, and an explanation in an HTML comment would have shipped the
   * removed heading to every page. */

  const carried = openJobs.map((j) => ({ ...j, carried: true }));
  const bands = groupIntoBands([...jobs, ...carried], profile);
  const cards = [];

  bands.forEach((band, i) => {
    if (!band.jobs.length) return;
    const nCarried = band.jobs.filter((j) => j.carried).length;
    cards.push(`<section class="band" data-band="${i}">
      <h2>${escapeHtml(band.title)} <span class="count">${band.jobs.length}</span></h2>
      ${band.note ? `<p class="band-note">${band.note}</p>` : ''}
      ${nCarried ? `<p class="band-note carried-note">${nCarried} of these ${nCarried === 1 ? 'was' : 'were'} carried over from an earlier run.</p>` : ''}
      <div class="cards" data-band="${i}">${band.jobs.map((j) => card(j, i, profile)).join('')}</div>
    </section>`);
  });

  // The home for carried cards when the merge checkbox is off. Rendered empty —
  // JS moves the existing nodes in rather than duplicating them, so the page
  // does not carry two copies of every backlog card.
  if (carried.length) {
    cards.push(`<section class="band still-open" hidden>
      <h2>Still open from earlier runs <span class="count">${carried.length}</span></h2>
      <p class="band-note">Seen before and not yet marked applied or rejected. Mark one with
        <code>npm run mark -- &lt;id&gt; applied</code> to retire it from this list.</p>
      <div class="cards" data-band="carried"></div>
    </section>`);
  }

  const total = jobs.length + carried.length;
  const empty = total === 0
    ? `<div class="empty">
         <h2>No new jobs this run.</h2>
         <p>Everything the sources returned has been shown before — that is the memory working.</p>
         <p class="dim">Try <code>npm run search -- --all</code> to re-show everything already seen,
         or <code>--include-german</code> to reveal roles requiring German C1+.</p>
       </div>`
    : '';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Job search — ${escapeHtml(meta.date)}</title>
<style>${CSS}</style>
</head>
<body data-tab="open">
<div class="shell">

<!-- Sections, down the left. Open and In progress carry a count because they are the
     two lists with something for you to do; the rest are places you go and look.
     The counts are kept true by the script (apply() and paintApps()). -->
<nav class="side" aria-label="Sections">
  <div class="side-title">jobsieve</div>
  <a class="tab" href="#open" data-tab="open">Open <span class="tab-count" id="count-open">${total || ''}</span></a>
  <a class="tab" href="#progress" data-tab="progress">In progress <span class="tab-count" id="count-progress"></span></a>
  <a class="tab" href="#applied" data-tab="applied">Applied / Rejected</a>
  <a class="tab" href="#discarded" data-tab="discarded">Discarded</a>
  <a class="tab" href="#log" data-tab="log">Log</a>
  <a class="tab" href="#settings" data-tab="settings">Settings</a>
</nav>

<div class="content">

<section class="page" id="page-open">
<header>
  <div class="head-main">
    <h1>Job search</h1>
    <div class="meta">
      <span><strong>${jobs.length}</strong> new</span>
      <span class="sep">·</span>
      <span>${escapeHtml(meta.date)} ${escapeHtml(meta.time)}</span>
      <span class="sep">·</span>
      <span>${meta.totalFetched} fetched, ${meta.alreadySeen} already seen, ${meta.merged} duplicates merged</span>
    </div>
  </div>
  <div class="profile-line">
    ${escapeHtml(profile.location.city)} · ${profile.location.radiusKm}km radius ·
    German <strong>${escapeHtml(profile.languages.germanLevel)}</strong>
    (target ${escapeHtml(profile.languages.germanTarget)})
    <span class="hint" title="Raise germanLevel in config/profile.json after your exam — B2 roles then move out of the Stretch band automatically.">?</span>
  </div>
  ${adjudicationBanner(meta.adjudication)}
</header>

<!-- What the tray menu can do, here as well: when it last scanned and when it next will,
     scan now, pause, and the way to the log. Hidden until the page learns it is being
     served BY the app — under npm run serve there is no scanner to control. -->
<div class="appbar" id="appbar" hidden>
  <div class="appbar-status">
    <span id="app-scan"></span><span class="sep">·</span><span id="app-next"></span>
    <span id="app-msg" class="dim small"></span>
  </div>
  <div class="appbar-btns">
    <button class="app-btn" id="app-scan-btn">Scan every source now</button>
    <button class="app-btn" id="app-pause-btn">Pause scanning</button>
    <a class="app-btn" href="#log">Log</a>
  </div>
</div>

<!-- Postings waiting for the AI: held by its rate limit, or fetched and not yet judged.
     Read from two small files by /api/judging, so it shows under npm run serve as well as in
     the app; hidden until the page learns there is something waiting. -->
<div class="judgebar" id="judgebar" hidden>
  <div class="judgebar-text" id="judge-text"></div>
  <button class="app-btn" id="judge-btn" hidden>Judge them now</button>
</div>

<!-- Where a job found elsewhere goes in. It lands in the queue below as interested,
     and the page fetches its card straight away. Hidden until the page is served: from
     disk there is no server to receive it. -->
<details class="source-toggles addjob" id="manbox" hidden>
  <summary>＋ Add a job you found elsewhere</summary>
  <div class="manform">
    <label>Job URL<input id="m-url" type="url" placeholder="https://…" /></label>
    <label>Title <span class="req">required</span><input id="m-title" type="text" placeholder="Senior Software Engineer (m/w/d)" /></label>
    <label>Company <span class="req">required</span><input id="m-company" type="text" placeholder="Example GmbH" /></label>
    <!-- The placeholder reads the profile like every other personal fact on
         this page. Typing the home city in here is the exact bug
         test/personal-facts-in-config.test.js exists to catch, and it caught
         this one. -->
    <label>Location<input id="m-location" type="text" placeholder="${escapeHtml(profile.location.city)}" /></label>
    <label>Description<textarea id="m-desc" rows="8" placeholder="Paste the advert here. The tailoring reads this — without it the cover letter has nothing to work from."></textarea></label>
    <div class="manrow"><button id="m-add" class="btn">Add it</button><span id="m-say" class="dim small"></span></div>
  </div>
  <p class="dim small">Goes straight into the queue as <strong>interested</strong> — the gates never
  see it, because you already decided. Paste the advert text too: <code>npm run apply</code> reads
  it, and a cover letter written from a title alone is worth nothing.</p>
</details>

<!-- Always present, even over an empty queue: the page fills itself from the server
     (see syncQueue in the script), and a job restored onto an empty page needs its
     filter and counter to exist. -->
<div class="toolbar">
  <input id="q" type="search" placeholder="Filter by title, company, skill…" autocomplete="off">
  <select id="mode">
    <option value="">All work modes</option>
    <option value="remote">Remote</option>
    <option value="hybrid">Hybrid</option>
    <option value="onsite">Onsite</option>
  </select>
  <select id="sort">
    <option value="score">Sort: best match</option>
    <option value="date">Sort: newest</option>
    <option value="distance">Sort: nearest</option>
  </select>
  ${carried.length ? `<label class="toggle" title="On: today's finds and the ${carried.length} still-open roles are ranked together in one queue. Off: the carried ones move to their own section at the bottom.">
    <input type="checkbox" id="merge" checked>
    <span>One queue <span class="dim">(${carried.length} carried over)</span></span>
  </label>` : ''}
  <button id="open3" type="button" class="open3"
    title="Open the first 3 jobs waiting for your review in your browser. Jobs you marked Interested are skipped.">Open next 3</button>
  <span id="shown" class="shown"></span>
</div>

<main>${empty}${cards.join('')}</main>

${parkedSection(parked)}
</section>

<section class="page" id="page-progress">
  <div class="page-head">
    <h2>In progress</h2>
    <p class="dim small">Applications you have marked <strong>interview</strong> or <strong>offer</strong>.
    Set an outcome from the dropdown on an application under <em>Applied / Rejected</em>. When it ends,
    choose <strong>not hired</strong> or <strong>declined</strong>: it goes back to <em>Applied / Rejected</em>
    with that outcome shown.</p>
  </div>
  <div class="panel"><div id="proglist" class="applist"></div></div>
</section>

<!-- Populated from /api/applications and /api/turned-down when served. -->
<section class="page" id="page-applied">
  <div class="page-head"><h2>Applied / Rejected</h2></div>

  <div class="panel" id="appfind" hidden>
    <input type="search" id="appq" placeholder="Find a job — company, title, outcome, reason…" autocomplete="off" style="width:100%;box-sizing:border-box">
    <p class="dim small" id="appqsay"></p>
  </div>

  <details class="panel fold" id="appbox" open hidden>
    <summary class="sec" id="appsum">Applied</summary>
    <div id="applist" class="applist"></div>
    <p class="dim small">Outcome is the only signal that reflects what employers actually did.
    Written to disk immediately.</p>
  </details>

  <details class="panel fold" id="archbox" hidden>
    <summary class="sec" id="archsum">Archived</summary>
    <p class="dim small">Applied more than 30 days ago with no reply. Folded away on age alone — nothing is
    deleted, and setting an outcome still moves it out.</p>
    <div id="archlist" class="applist"></div>
  </details>

  <details class="panel fold" id="rejdocbox" hidden>
    <summary class="sec" id="rejdocsum">Rejected — documents kept</summary>
    <p class="dim small">Documents were written for these, then the job was turned down. They are not counted
    as applied. <strong>Restore</strong> puts one back on your list.</p>
    <div id="rejdoclist" class="applist"></div>
  </details>

  <details class="panel fold" id="rejbox" hidden>
    <summary class="sec" id="rejsum">Turned down</summary>
    <div id="rejlist" class="applist"></div>
    <p class="dim small">What you marked <strong>Not for me</strong> in the last 30 days. A turned-down job leaves the
    queue at once; <strong>Restore</strong> puts it back.</p>
  </details>

  <details class="panel fold" id="fbbox" hidden>
    <summary class="sec" id="fbsum">What you rewrote</summary>
    <p class="dim small">Your edits are the feedback. Mark a correction as <strong>style</strong> and it
    counts toward a rule; a rule only takes effect after <strong>three</strong> occurrences, because
    three edits are a pattern and one is a preference.</p>
    <div id="fblist"></div>
  </details>
</section>

<section class="page" id="page-settings">
  <div class="page-head"><h2>Settings</h2></div>

  <!-- The app's own options. Hidden unless the page is served by the app: starting
       with Windows and quitting mean nothing to a plain npm run serve. -->
  <section class="panel" id="setbox" hidden>
    <h3>The app</h3>
    <label class="setrow"><input type="checkbox" id="set-login">
      <span>Start with Windows <span class="dim small">— opens in the tray at login, without the window</span></span></label>
    <div class="setrow"><button class="app-btn" id="set-quit">Quit jobsieve</button>
      <span class="dim small">Stops scanning. Closing the window only hides it to the tray.</span></div>
  </section>

  <!-- Populated from /api/sources when served. A static file cannot write to
       config/sources.json, so opened from disk this stays hidden rather than
       offering switches that would silently do nothing. -->
  <section class="panel" id="srcbox" hidden>
    <h3>Switch sources on and off</h3>
    <div id="srclist" class="srclist"></div>
    <p class="dim small">Saved to <code>config/sources.json</code> immediately. Takes effect on your
    next scan.</p>
  </section>

  <!-- Coverage, not configuration. Populated from /api/companies when served,
       because the status depends on live board sizes and the archive. -->
  <section class="panel" id="cobox" hidden>
    <h3 id="cosum">Companies — who is actually being tracked</h3>
    <div id="colist"></div>
    <p class="dim small">Status is worked out from evidence, not intent: a configured board that
    serves one posting is a <strong>stub</strong>, not coverage. Tick a company once you have set
    up an email alert on its careers page — those arrive through the job-alert source.</p>
  </section>

  ${meta.warnings?.length ? `<section class="panel"><details class="warnings" open><summary>${meta.warnings.length} warning(s) from the last scan</summary><ul>${meta.warnings.map((w) => `<li>${escapeHtml(w)}</li>`).join('')}</ul></details></section>` : ''}
</section>

<section class="page" id="page-discarded">
  <div class="page-head">
    <h2>Discarded</h2>
    <p class="dim small">What the filters threw away, for a periodic look at whether they are wrong. This is the
    filters' list — a job you turn down yourself is under <em>Applied / Rejected</em>.</p>
  </div>
  ${discardedSummary(awaiting, reviewedCount)}
</section>

<!-- Filled from /api/log while this page is the one showing. -->
<section class="page" id="page-log">
  <div class="log-top">
  <div class="page-head">
    <h2>Log</h2>
    <p class="dim small">Scans, app events, tailoring and what you did here — grouped, newest at the bottom. <span id="log-status"></span></p>
  </div>
  <div class="logbar" id="logbar">
    <button type="button" data-tag="scan" class="lg-scan">Scan</button>
    <button type="button" data-tag="app" class="lg-app">App</button>
    <button type="button" data-tag="tailor" class="lg-tailor">Tailoring</button>
    <button type="button" data-tag="action" class="lg-action">Actions</button>
  </div>
  </div>
  <div class="panel"><div id="logtext" class="logtext">The log is shown when the report is opened from the app (or npm run serve).</div></div>
</section>

<footer>
  <p>Generated by <code>jobsieve</code> · ${escapeHtml(meta.date)}</p>
  ${attributions.map((a) => `<p><a href="${escapeHtml(a.url)}" target="_blank" rel="noopener">${escapeHtml(a.text)}</a></p>`).join('')}
  <p class="dim">Mark a job: <code>npm run mark -- &lt;id&gt; applied</code> · statuses: interested, applied, rejected, hidden</p>
</footer>

</div>
</div>

<script>${settingsScript(profile)}</script>
<script>${JS}</script>
</body>
</html>`;
}

/**
 * The handful of profile values the CLIENT script needs.
 *
 * `JS` is a module-level template literal, evaluated once when this file is
 * imported, so it cannot read the profile the way the server-rendered HTML
 * above can. Everything it needs comes through here instead — one small object,
 * written before the script that reads it.
 *
 * This is the same rule the rest of the file follows: a personal fact lives in
 * config/profile.json, never in source. The salary you ask for is exactly that,
 * and hardcoding it here would put a real figure into a public repository.
 *
 * `<` is escaped because a value ending in `</script` would otherwise close
 * this tag early and put the rest of the object on the page as text.
 */
function settingsScript(profile = {}) {
  const settings = {
    // Prefilled into the "Asked for?" box, selected so typing replaces it.
    // Absent or empty means an empty box, which is what it always was.
    salaryDefault: profile.salary?.askingDefault == null ? '' : String(profile.salary.askingDefault),
  };
  return `window.__SETTINGS__ = ${JSON.stringify(settings).replace(/</g, '\\u003c')};`;
}

/**
 * Reject categories in REVIEW order, not pipeline order.
 *
 * The four judgement calls come first — those are the gates where a wrong
 * rejection costs you a real job. The bulk categories go last: "not a target
 * role" and "too old" are thousands of rows of obvious noise, and putting them
 * on top buries the handful that are worth a second look.
 *
 * The ORDER lives here because it is a property of reviewing, not of gating.
 * The WORDING comes from filter.js, because a second copy of it drifts: this
 * list was written by hand and never gained `closed` when the gate did, so
 * those rejections would have shown under a raw key at the foot of the page.
 * A category added to the gates and not named below still appears — last,
 * which is the safe direction to be wrong in.
 */
const REVIEW_ORDER = ['language', 'location', 'programming', 'aws', 'stack', 'closed', 'employment', 'score', 'role', 'age', 'other'];

const REJECT_LABELS = Object.fromEntries(
  [...new Set([...REVIEW_ORDER, ...Object.keys(REJECT_CATEGORIES)])]
    .filter((k) => REJECT_CATEGORIES[k])
    .map((k) => [k, REJECT_CATEGORIES[k]]),
);

/** Groups big enough to be noise stay shut until asked for. */
const AUTO_OPEN_UNDER = 60;

/**
 * Everything the filter threw away this run, as a plain scan list.
 *
 * Collapsed by default and placed below the results, because the whole value of
 * the tool is not showing you these. But a filter you cannot audit is a filter
 * you cannot trust — one pass down this list is how you catch a rule that is
 * quietly eating good jobs. The reason is shown alongside so a wrong rejection
 * points straight at the rule responsible.
 */
/**
 * Postings held back because the advert never arrived.
 *
 * Last on the page on purpose: these have not been judged, so they are not
 * recommendations and not rejections. They sit below the rejections because
 * they are the shortest list and the one needing a human, not a rule.
 *
 * They are shown at all because a silent hold is indistinguishable from a job
 * that never existed. `attempts` is on each row: throttled once is normal,
 * stuck for four runs is a posting that will never be readable.
 */
function parkedSection(parked = []) {
  if (!parked.length) return '';
  const rows = parked.map((j) => `
    <li>
      <a href="${escapeHtml(j.applyUrl)}" target="_blank" rel="noopener">${escapeHtml(j.title)}</a>
      <span class="muted">${escapeHtml(j.company || '')}${j.location ? ' · ' + escapeHtml(j.location) : ''}</span>
      <span class="chip">${escapeHtml(j.reason || 'no text')}${j.attempts > 1 ? ` · ${j.attempts} tries` : ''}</span>
      <details class="parked-act" data-id="${escapeHtml(String(j.fingerprint || '').slice(0, 8))}" hidden>
        <summary>Add the advert or turn it down</summary>
        <textarea rows="6" placeholder="Paste the advert text here, then Add as job" style="width:100%;box-sizing:border-box"></textarea>
        <button type="button" class="parked-add">Add as job</button>
        <select class="parked-why"></select>
        <button type="button" class="parked-reject">Not for me</button>
        <span class="dim small parked-say"></span>
      </details>
    </li>`).join('');

  return `
  <section class="parked">
    <details>
      <summary><strong>${parked.length}</strong> posting${parked.length === 1 ? '' : 's'} waiting for the advert text</summary>
      <p class="muted">Not judged — the description could not be fetched, so nothing was read.
         They are retried on the next run. Open one yourself if it looks worth it.</p>
      <ul class="parked-list">${rows}</ul>
    </details>
  </section>`;
}

/**
 * What the Discarded tab holds now: how many are waiting, and where the list is.
 * `rejections.html` sits beside this file when it is opened from disk, and the
 * server answers `/rejections.html` live.
 */
function discardedSummary(awaiting, reviewedCount = 0) {
  if (!awaiting) {
    return reviewedCount
      ? `<p class="dim panel">Nothing new to review — ${reviewedCount} rejection${reviewedCount === 1 ? '' : 's'}
        already checked. New ones appear here after the next search.
        <a href="rejections.html?all">Show them anyway</a>.</p>`
      : '<p class="dim panel">Nothing has been discarded yet.</p>';
  }
  const note = reviewedCount ? ` · ${reviewedCount} already reviewed and hidden` : '';
  return `<div class="panel discard-link">
    <p><strong>${awaiting}</strong> rejected, awaiting review${note}.</p>
    <p><a class="btn" href="rejections.html">Open the rejection list</a>
    <span class="dim small">It is a page of its own — it was most of this one.</span></p>
  </div>`;
}

/**
 * The rejection list on its own page: the same styles and a script of its own, so
 * "Want it" and "Mark all reviewed" behave as they did inside the report (REJ_JS).
 */
export function buildRejectionsPage({ rejected = [], reviewedCount = 0, profile }) {
  const body = rejectedSection(rejected, reviewedCount)
    || '<p class="dim panel">Nothing has been discarded yet.</p>';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Discarded — ${escapeHtml(profile?.name || 'job search')}</title>
<style>${CSS}</style>
</head>
<body class="rej-page" data-tab="discarded">
<header class="rej-head">
  <a class="rej-back" id="rej-back" href="latest.html">&larr; Back to the report</a>
  <h1>Discarded</h1>
  <p class="dim small">What the filters threw away, for a periodic look at whether they are wrong. This is the
  filters' list — a job you turn down yourself is under <em>Applied / Rejected</em> in the report.</p>
</header>
${body}
<script>${REJ_JS}</script>
<script>(function(){ if (location.protocol.indexOf('http') === 0) document.getElementById('rej-back').setAttribute('href', '/'); })();</script>
</body>
</html>`;
}

function rejectedSection(rejected, reviewedCount = 0) {
  if (!rejected?.length) {
    // Say so explicitly — an absent section reads like the feature is broken,
    // when in fact it means you are caught up.
    return reviewedCount
      ? `<details class="rejects"><summary>Nothing new to review —
        ${reviewedCount} rejection${reviewedCount === 1 ? '' : 's'} already checked</summary>
        <p class="dim small">Every rejection so far has been reviewed. New ones appear here after
        the next <code>npm run search</code>. To bring a gate back:
        <code>npm run reviewed -- undo &lt;gate&gt;</code>.</p></details>`
      : '';
  }

  const groups = new Map();
  for (const r of rejected) {
    const k = r.category || 'other';
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }

  /**
   * The OTHER gates this posting failed.
   *
   * The row already says which gate owns the verdict. This says whether that
   * gate was the only thing wrong — "dropped on location, also failed German"
   * is a very different signal from "dropped on location" when the question you
   * are asking is whether a rule is pulling its weight or merely got there
   * first. 8,703 of the archive carry more than one reason, up to six.
   *
   * Entries recorded before the gates started reporting every reason have none,
   * and render nothing rather than claiming they failed only one gate.
   */
  const alsoFailed = (r) => {
    const rest = (r.reasons || []).filter((x) => x.category !== r.category);
    if (!rest.length) return '';
    const labels = [...new Set(rest.map((x) => REJECT_LABELS[x.category] || x.category))];
    const detail = rest.map((x) => x.reason).join(' \u00b7 ');
    return `<span class="rej-also" title="${escapeHtml(detail)}">also: ${escapeHtml(labels.join(', '))}</span>`;
  };

  const order = Object.keys(REJECT_LABELS).filter((k) => groups.has(k));
  for (const k of groups.keys()) if (!order.includes(k)) order.push(k);

  const body = order.map((k) => {
    const list = groups.get(k);
    const rows = list
      .sort((a, b) => (a.company || '').localeCompare(b.company || ''))
      .map((r) => `<div class="rej-row">
      <code class="rej-id" title="npm run apply -- ${r.fingerprint.slice(0, 8)}">${r.fingerprint.slice(0, 8)}</code>
      <a href="${escapeHtml(r.applyUrl || '#')}" target="_blank" rel="noopener">${escapeHtml(r.title || 'untitled')}</a>
      <span class="rej-co">${escapeHtml(r.company || '')}</span>
      <span class="rej-why${/^AI: /.test(r.reason || '') ? ' rej-ai' : ''}" title="${escapeHtml(r.reason || '')}">${escapeHtml(r.reason || '')}</span>
      ${alsoFailed(r)}
      <span class="marks rej-marks" data-id="${r.fingerprint.slice(0, 8)}">
        <button class="mark" data-status="interested"
          title="Pull this one out of the rejections. It moves to the top of the report and the rules stop dropping it.">Want it</button>
      </span>
    </div>`).join('');

    return `<details class="rej-group" data-cat="${escapeHtml(k)}"${list.length < AUTO_OPEN_UNDER ? ' open' : ''}>
      <summary>${escapeHtml(REJECT_LABELS[k] || k)} <span class="rej-n">${list.length}</span></summary>
      <div class="rej-actions">
        <button class="rej-clear" data-cat="${escapeHtml(k)}" data-n="${list.length}">Mark all ${list.length} reviewed</button>
        <span class="dim small">clears this gate from future reports — the ids are remembered, so
        the next run shows only what is new here</span>
      </div>
      ${rows}
    </details>`;
  }).join('');

  const reviewedNote = reviewedCount
    ? ` · ${reviewedCount} already reviewed and hidden`
    : '';

  return `<details class="rejects">
  <summary>${rejected.length} rejected, awaiting review${reviewedNote}</summary>
  <p class="dim small">Grouped by what stopped them, judgement calls first. Amber reasons came from
  the AI adjudicator, the rest from the rules. Spot one that should have passed and run
  <code>npm run why -- &lt;id&gt;</code> to see every gate it went through, then fix that rule —
  or press <strong>Want it</strong> to pull the posting out of the rejections — it moves to the
  top of the report, the rules stop dropping it, and &ldquo;Mark all reviewed&rdquo; leaves it alone.
  The id is the grey code on each row.
  Rejections are not remembered as &ldquo;seen&rdquo;, so the job comes back on the next search.</p>
  ${body}
</details>`;
}

/**
 * States plainly which layer produced this run's verdicts. A silent downgrade
 * to rules would look identical to a normal run, so it is always announced.
 */
function adjudicationBanner(a) {
  if (!a || !a.uncertain) return '';

  if (a.mode === 'rules-fallback') {
    return `<div class="banner warn-banner">
      <strong>Rules-only run.</strong> ${a.uncertain} ambiguous posting${a.uncertain === 1 ? '' : 's'}
      could not be adjudicated${a.reason ? ` — ${escapeHtml(a.reason)}` : ''}, so the rules verdict was used.
      Those cards are marked <span class="badge fallback">rules fallback</span> and are less reliable than the rest.
    </div>`;
  }

  const bits = [`<strong>${a.calls}</strong> adjudicated`];
  if (a.cached) bits.push(`<strong>${a.cached}</strong> from cache`);
  // Held by the model's rate limit: not decided, and not on this page until they are.
  if (a.waiting) bits.push(`<strong>${a.waiting}</strong> waiting for the AI (see the bar above)`);
  // Money was spent on these. Said in the report as well as the log, because this page is what gets read.
  if (a.overflow) bits.push(`<strong>${a.overflow}</strong> judged on the billed key (free daily quota spent)`);
  if (a.mode === 'mixed') bits.push('some fell back to rules');

  return `<div class="banner ai-banner">
    ${a.uncertain} posting${a.uncertain === 1 ? '' : 's'} the rules could not settle · ${bits.join(' · ')}.
    Those cards are marked <span class="badge ai">AI-judged</span> with the reasoning shown.
  </div>`;
}

/**
 * The queue as the page's own client script wants it: cards rendered by the same
 * template the report uses, banded by the same rule, so a card the page fetches
 * later is indistinguishable from one it was generated with.
 *
 * `have` is the set of cards the page already holds. Only the others are rendered,
 * because the page asks every twenty seconds and the answer is almost always
 * "nothing new" — rendering fifty cards to say so would be waste. `ids` is every
 * open job regardless, which is what lets the page spot one that has closed.
 */
export function renderQueue(jobs, profile, have = new Set()) {
  const bands = groupIntoBands(jobs, profile);
  const out = {
    bands: bands.map((b, i) => ({ index: i, title: b.title })),
    ids: jobs.map((j) => j.fingerprint.slice(0, 8)),
    jobs: [],
  };
  bands.forEach((band, i) => {
    for (const j of band.jobs) {
      const id = j.fingerprint.slice(0, 8);
      if (!have.has(id)) out.jobs.push({ id, band: i, html: card(j, i, profile) });
    }
  });
  return out;
}

function groupIntoBands(jobs, profile) {
  const { strong, good } = profile.scoring.bands;
  const main = jobs.filter((j) => j.band !== 'stretch');
  const stretch = jobs.filter((j) => j.band === 'stretch');

  return [
    { title: 'Strong match', jobs: main.filter((j) => j.score >= strong) },
    { title: 'Good match', jobs: main.filter((j) => j.score >= good && j.score < strong) },
    { title: 'Worth a look', jobs: main.filter((j) => j.score < good) },
    {
      title: `Stretch — German above ${profile.languages.germanLevel}`,
      jobs: stretch,
      note: `These want stronger German than ${escapeHtml(profile.languages.germanLevel)}. Kept because you are working toward ${escapeHtml(profile.languages.germanTarget)} and, with a ${profile.noticePeriodMonths}-month notice period, a realistic start date is 4–6 months out.`,
    },
  ];
}

function card(job, bandIndex = 0, profile = {}) {
  // Takes the whole profile rather than fields plucked out of it. The narrow
  // version meant the Swiss badge could not reach workRights, so its text was
  // hardcoded — including the home city, which every other label had already
  // stopped hardcoding. The 'A2' default was the same leak in miniature.
  const germanLevel = profile.languages?.germanLevel || 'A2';
  const id = job.fingerprint.slice(0, 8);
  const age = daysSince(parseDate(job.postedAt));
  const posted = age === null ? 'date unknown'
    : age < 1 ? 'today'
    : age < 2 ? 'yesterday'
    : `${Math.round(age)} days ago`;

  const modeBadge = job.workMode === 'remote'
    ? `<span class="badge remote">Remote${job.remoteScope ? ` · ${escapeHtml(job.remoteScope)}` : ''}</span>`
    : job.workMode === 'hybrid'
      ? `<span class="badge hybrid">Hybrid${job.distanceKm != null ? ` · ${job.distanceKm}km` : ''}</span>`
      : job.workMode === 'onsite'
        ? `<span class="badge onsite">Onsite${job.distanceKm != null ? ` · ${job.distanceKm}km` : ''}</span>`
        : `<span class="badge unknown">Mode unclear</span>`;

  // Which layer decided this job's fate, and why. Never leave the reader
  // guessing whether a verdict came from rules or from the model.
  const aiBadge = job.verdictSource === 'llm' || job.verdictSource === 'llm-cached'
    ? `<span class="badge ai" title="The rules layer could not settle this posting, so it was adjudicated by Claude.${job.verdictConfidence ? ` Confidence: ${escapeHtml(job.verdictConfidence)}.` : ''}">AI-judged${job.verdictSource === 'llm-cached' ? ' · cached' : ''}</span>`
    : job.verdictSource === 'rules-fallback'
      ? `<span class="badge fallback" title="AI adjudication was unavailable, so the rules verdict was used. This posting is less certain than the others.">rules fallback</span>`
      : '';

  const aiReason = job.verdictReason && job.verdictSource !== 'rules'
    ? `<p class="ai-reason">${escapeHtml(job.verdictReason)}</p>`
    : '';

  // Merged into one queue, this is the only thing separating a carried role
  // from a fresh one — so it has to be on the card, not just in a section title.
  const seenAge = job.carried ? daysSince(parseDate(job.firstSeen)) : null;
  const carriedBadge = job.carried
    ? `<span class="badge carried" title="Shown in an earlier run and not yet marked applied or rejected.${job.status === 'interested' ? ' You marked this Interested.' : ''}">${
      job.status === 'interested' ? 'Interested' : 'Seen before'
    }${seenAge != null && seenAge >= 1 ? ` · ${Math.round(seenAge)}d` : ''}</span>`
    : '';

  // Same wording as the drop reason, from the same helper — a card saying
  // "German C1+ required" beside a rejection saying "German B2 needed" would
  // make the filter look arbitrary.
  const gap = germanGap(job.germanRequired, job.germanEvidence, germanLevel);
  const germanChip = gap
    ? `<span class="chip warn" title="${escapeHtml(`${gap.label}${job.germanEvidence ? ` — "${job.germanEvidence}"` : ''}`)}">${escapeHtml(gap.short)}</span>`
    : '';

  const progChip = job.programmingRequired === 'niceToHave' && profile.avoid?.penaltyNiceToHaveProgramming
    ? `<span class="chip warn" title="${escapeHtml(job.programmingEvidence || '')}">Coding mentioned${job.programmingLanguage ? `: ${escapeHtml(job.programmingLanguage)}` : ''}</span>`
    : '';

  const skills = (job.matchedSkills || []).slice(0, 12)
    .map((s) => `<span class="chip">${escapeHtml(s)}</span>`).join('');

  const breakdown = (job.scoreBreakdown || [])
    .map((b) => `<li><span>${escapeHtml(b.label)}</span><b class="${b.points < 0 ? 'neg' : ''}">${b.points > 0 ? '+' : ''}${b.points}</b></li>`)
    .join('');

  // Say when the checks ran on a fragment. Adzuna caps descriptions at 500
  // characters and alert emails carry none, so most cards are judged on a
  // teaser — presenting those verdicts with full confidence is what let a role
  // needing good German through, and made another look like it demanded German
  // when the real posting never mentions it.
  //
  // Decided from the text we hold, not from a stored flag: jobs.json does not keep
  // `descriptionComplete`, so the chip this used to depend on never appeared on a card
  // read from disk. The threshold is the one the checks themselves use.
  const unread = job.descriptionComplete === false || (job.descriptionText || '').length < MIN_DESCRIPTION_CHARS;
  const partial = unread
    ? `<span class="chip partial" title="This source supplies only a fragment of the posting${job.descriptionText ? ` (${job.descriptionText.length} characters)` : ' — no description at all'}. The language, programming and AWS checks could only read that fragment, so open the posting and read it yourself before deciding.">Advert not fully available — read it yourself</span>`
    : '';

  const desc = job.descriptionText
    ? `<details class="desc"><summary>Description${unread ? ' (fragment)' : ''}</summary><pre>${escapeHtml(job.descriptionText.slice(0, 12000))}${job.descriptionText.length > 12000 ? '\n\n… truncated — open the posting for the rest.' : ''}</pre></details>`
    : '<p class="dim small">No description supplied by this source — open the posting.</p>';

  const search = escapeHtml(
    `${job.title} ${job.company} ${job.location} ${(job.matchedSkills || []).join(' ')}`.toLowerCase()
  );

  return `<article class="job${job.carried ? ' is-carried' : ''}${unread ? ' is-partial' : ''}" data-score="${job.score}" data-mode="${escapeHtml(job.workMode)}"
    data-date="${escapeHtml(job.postedAt || '')}" data-distance="${job.distanceKm ?? 99999}"
    data-band="${bandIndex}"${job.carried ? ' data-carried="1"' : ''}
    data-search="${search}">
  <div class="job-head">
    <div>
      <h3><a href="${escapeHtml(job.applyUrl)}" target="_blank" rel="noopener">${escapeHtml(job.title)}</a></h3>
      <div class="company">${escapeHtml(job.company)} <span class="sep">·</span> ${escapeHtml(job.location)}</div>
    </div>
    <div class="score" title="Match score">${job.score}</div>
  </div>

  <div class="badges">
    ${modeBadge}${carriedBadge}${aiBadge}
    <span class="badge src">${escapeHtml(job.sourceLabel)}</span>
    <span class="badge date">${escapeHtml(posted)}</span>
    ${job.salary ? `<span class="badge pay">${escapeHtml(job.salary)}</span>` : ''}
    ${job.employmentType ? `<span class="badge type">${escapeHtml(job.employmentType)}</span>` : ''}
  </div>

  ${aiReason}

  ${partial || germanChip || progChip || skills ? `<div class="chips">${partial}${germanChip}${progChip}${skills}</div>` : ''}

  <div class="actions">
    <a class="apply" href="${escapeHtml(job.applyUrl)}" target="_blank" rel="noopener">Apply →</a>
    <span class="marks" data-id="${id}">
      <button class="mark" data-status="applied"    title="Mark as applied — retires it from future reports">Applied</button>
      <button class="mark" data-status="interested" title="Keep it in the carry-forward list">Interested</button>
      <button class="mark" data-status="rejected"   title="Not for you — retires it from future reports">Not for me</button>
    </span>
    <!-- Hidden unless served: generating needs two model calls and Word, which
         a page opened from disk cannot do. -->
    <button class="tailor" data-id="${id}" hidden
      title="Generate a tailored CV and cover letter for this posting. Two model calls, 20-30 seconds.">Tailor application</button>
    <!-- Filled by the page once it knows this job has documents: Open Docs and Regenerate. -->
    <span class="card-docs" data-id="${id}"></span>
    <code class="id" title="Use with: npm run mark -- ${id} applied">${id}</code>
    <details class="why"><summary>Why this score</summary><ul class="breakdown">${breakdown}</ul></details>
  </div>

  ${desc}
</article>`;
}

const CSS = `
:root{
  --bg:#f7f7f5; --panel:#fff; --ink:#1b1b19; --dim:#6b6b66; --line:#e2e2dd;
  --accent:#0f766e; --accent-ink:#fff; --warn:#a16207; --warn-bg:#fef3c7;
  --chip:#eef2f1; --shadow:0 1px 2px rgba(0,0,0,.05),0 4px 12px rgba(0,0,0,.04);
  --ai:#6d28d9; --ai-bg:#f1ecfd;
}
@media (prefers-color-scheme:dark){
  :root{
    --bg:#14151a; --panel:#1c1e24; --ink:#e8e8e4; --dim:#9a9a94; --line:#2c2f37;
    --accent:#2dd4bf; --accent-ink:#0b1211; --warn:#fbbf24; --warn-bg:#3a2f10;
    --chip:#262a31; --shadow:0 1px 2px rgba(0,0,0,.3),0 4px 14px rgba(0,0,0,.25);
    --ai:#c4b5fd; --ai-bg:#2a2140;
  }
}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);
  font:15px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;}
header{padding:28px 24px 18px;border-bottom:1px solid var(--line);background:var(--panel)}
.head-main{display:flex;align-items:baseline;gap:16px;flex-wrap:wrap}
h1{margin:0;font-size:22px;letter-spacing:-.01em}
.meta{color:var(--dim);font-size:13px}
.meta strong{color:var(--accent);font-size:15px}
.sep{opacity:.45;margin:0 2px}
.profile-line{margin-top:8px;color:var(--dim);font-size:13px}
.hint{display:inline-block;width:15px;height:15px;line-height:15px;text-align:center;
  border-radius:50%;background:var(--chip);cursor:help;font-size:11px}
.banner{margin-top:12px;padding:9px 13px;border-radius:8px;font-size:13px;line-height:1.6}
.banner .badge{vertical-align:baseline}
.ai-banner{background:var(--ai-bg);color:var(--ink);border-left:3px solid var(--ai)}
.warn-banner{background:var(--warn-bg);color:var(--ink);border-left:3px solid var(--warn)}
details.sources,details.warnings{margin-top:10px;font-size:13px;color:var(--dim)}
details.warnings summary{color:var(--warn);cursor:pointer}
details.sources summary{cursor:pointer}
details.source-toggles{margin-top:10px;font-size:13px;color:var(--dim)}
details.source-toggles > summary{cursor:pointer}
details.source-toggles > summary:hover{color:var(--ink)}
/* ---- sections down the left ---- */
.shell{display:grid;grid-template-columns:216px minmax(0,1fr);min-height:100vh}
.side{position:sticky;top:0;align-self:start;height:100vh;overflow:auto;padding:18px 12px;
  background:var(--panel);border-right:1px solid var(--line);display:flex;flex-direction:column;gap:3px}
.side-title{font-weight:700;font-size:16px;letter-spacing:-.01em;padding:2px 12px 14px}
.tab{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:9px 12px;
  border-radius:9px;color:var(--ink);text-decoration:none;font-size:14px}
.tab:hover{background:var(--chip)}
.tab.active{background:var(--accent);color:var(--accent-ink);font-weight:600}
.tab-count{min-width:22px;padding:0 7px;border-radius:11px;background:var(--chip);color:var(--ink);
  font-size:12px;font-weight:600;line-height:20px;text-align:center}
.tab.active .tab-count{background:rgba(0,0,0,.18);color:inherit}
.tab-count:empty{display:none}
.content{min-width:0}
.page{display:none}
body[data-tab="open"] #page-open,body[data-tab="progress"] #page-progress,
body[data-tab="applied"] #page-applied,body[data-tab="discarded"] #page-discarded,
body[data-tab="log"] #page-log,body[data-tab="settings"] #page-settings{display:block}
.appbar{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;
  padding:10px 24px;border-bottom:1px solid var(--line);background:var(--panel);font-size:13px;color:var(--dim)}
.appbar[hidden]{display:none}
.judgebar{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;
  padding:9px 24px;border-bottom:1px solid var(--line);background:var(--panel);font-size:13px;
  border-left:4px solid #d9a400}
.judgebar[hidden]{display:none}
.judgebar-text div+div{margin-top:2px}
.judgebar-text .jb-head{font-weight:600}
.appbar-btns{display:flex;gap:8px}
a.app-btn{text-decoration:none;display:inline-block}
.setrow{display:flex;align-items:center;gap:10px;margin:10px 0;font-size:14px}
.setrow input{accent-color:var(--accent);width:15px;height:15px;margin:0}
.logtext .a1{font-weight:700}.logtext .a2{opacity:.6}.logtext .a31{color:#e5484d}.logtext .a32{color:#30a46c}.logtext .a33{color:#d9a400}.logtext .a34{color:#3e8ef7}
.logtext{margin:0;white-space:pre-wrap;word-break:break-word;font:12px/1.55 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:14px}
/* The heading and the filters stay put while the log scrolls under them. */
.log-top{position:sticky;top:0;z-index:5;background:var(--bg,var(--panel))}
.logbar{display:flex;gap:6px;padding:0 24px 10px}
.logbar button{font:inherit;font-size:12px;border:1px solid var(--line);background:var(--panel);color:inherit;border-radius:999px;padding:2px 12px;cursor:pointer;border-left:4px solid var(--c)}
.logbar button.off{opacity:.45;text-decoration:line-through}
.lg-scan{--c:#3e8ef7}.lg-app{--c:#8b949e}.lg-tailor{--c:#a371f7}.lg-action{--c:#30a46c}
.logtext .lg{border-left:3px solid var(--c);padding:2px 0 2px 10px;margin:0 0 10px}
.logtext .lgh{font:600 11px/1.6 system-ui,sans-serif;text-transform:uppercase;letter-spacing:.05em;color:var(--c);margin-bottom:2px}
.logtext .lt{opacity:.5;font-weight:400}
#logtext[data-hide~="scan"] .lg-scan,#logtext[data-hide~="app"] .lg-app,#logtext[data-hide~="tailor"] .lg-tailor,#logtext[data-hide~="action"] .lg-action{display:none}
.page-head{padding:26px 24px 6px}
.page-head h2{margin:0 0 4px;font-size:20px;letter-spacing:-.01em}
.panel{padding:8px 24px 14px;max-width:1080px}
.panel h3{margin:14px 0 2px;font-size:15px}
.panel > summary.sec{margin:14px 0 2px;font-size:15px;font-weight:600;cursor:pointer;color:var(--ink)}
.panel > summary.sec:hover{color:var(--accent)}
.panel.fold[open] > summary.sec{margin-bottom:6px}
details.addjob{margin:0;padding:10px 24px;border-bottom:1px solid var(--line);background:var(--panel)}
details.addjob > summary{font-size:14px;color:var(--accent);font-weight:600}
@media (max-width:760px){
  .shell{grid-template-columns:1fr}
  .side{position:static;height:auto;flex-direction:row;flex-wrap:wrap;border-right:0;border-bottom:1px solid var(--line)}
  .side-title{width:100%;padding-bottom:4px}
}
.manform{display:flex;flex-direction:column;gap:10px;margin:12px 0 8px;max-width:760px}
.manform label{display:flex;flex-direction:column;gap:4px;font-size:13px;color:var(--dim)}
.manform input,.manform textarea{padding:8px 10px;border:1px solid var(--line);border-radius:8px;
  background:var(--panel);color:var(--ink);font:inherit;font-size:14px;width:100%;box-sizing:border-box}
.manform textarea{resize:vertical;min-height:110px;line-height:1.45}
.manform input:focus,.manform textarea:focus{outline:2px solid var(--accent);outline-offset:-1px;border-color:var(--accent)}
.manform .req{color:var(--accent);font-size:11px;text-transform:uppercase;letter-spacing:.04em}
.manrow{display:flex;align-items:center;gap:12px}
.srclist{display:flex;flex-wrap:wrap;gap:8px;margin:12px 0 8px}
.src{display:inline-flex;align-items:center;gap:7px;padding:7px 11px;border:1px solid var(--line);
  border-radius:8px;background:var(--panel);cursor:pointer;user-select:none;transition:border-color .15s}
.src:hover{border-color:var(--accent)}
.src input{accent-color:var(--accent);width:15px;height:15px;margin:0;cursor:pointer}
.src-name{color:var(--ink)}
.src.saved{border-color:var(--accent)}
/* A source with no key cannot run, so the switch is dead by design — dimmed and
   labelled with the variable to set, rather than tickable to no effect. */
.src.unusable{opacity:.55;cursor:not-allowed}
.src.unusable input{cursor:not-allowed}
.src-warn{color:var(--warn);font-size:11.5px}
.co-group{margin:14px 0}
.co-group h4{font-size:11.5px;text-transform:uppercase;letter-spacing:.06em;color:var(--dim);
  margin:0 0 7px;font-weight:600}
.co{display:flex;align-items:baseline;gap:9px;padding:5px 0;font-size:13px;
  border-bottom:1px solid var(--line);cursor:pointer}
.co input{accent-color:var(--accent);width:14px;height:14px;margin:0;cursor:pointer;flex:0 0 auto}
.co input:disabled{cursor:not-allowed;opacity:.4}
.co-name{color:var(--ink);min-width:170px}
.co-facts{color:var(--dim);font-size:12px;margin-left:auto;text-align:right}
/* A green edge only where coverage is real — the point of the panel is that a
   configured board and a working one are not the same thing. */
.co-ok .co-name{border-left:2px solid var(--accent);padding-left:8px;margin-left:-10px}
.co-note{color:var(--dim);cursor:help;border:1px solid var(--line);border-radius:50%;
  width:15px;height:15px;display:inline-flex;align-items:center;justify-content:center;font-size:10px}

/* Tailored applications */
.tailor{font:inherit;font-size:12px;padding:5px 10px;border:1px solid var(--line);border-radius:7px;
  background:var(--panel);color:var(--dim);cursor:pointer;white-space:nowrap}
.tailor:hover{border-color:var(--accent);color:var(--accent)}
.tailor:disabled{opacity:.6;cursor:progress}
.tailor.done{border-color:var(--accent);color:var(--accent)}
.applist{margin:12px 0}
.app{padding:9px 0;border-bottom:1px solid var(--line)}
.app-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.app-co{color:var(--ink);font-weight:600;font-size:13px;min-width:150px}
.app-outcome{font:inherit;font-size:12px;padding:3px 7px;border:1px solid var(--line);
  border-radius:6px;background:var(--panel);color:var(--ink);margin-left:auto}
/* The storyline is how you tell at a glance what angle each letter took. */
.app-story{color:var(--dim);font-size:12px;font-style:italic;margin-top:3px}
/* What you asked for. Its whole value is being comparable across the list. */
.chip.pay{font-variant-numeric:tabular-nums}

/* Corrections, shown as generated-vs-sent pairs */
.fb{padding:11px 0;border-bottom:1px solid var(--line);font-size:13px}
.fb-gen{color:var(--dim);text-decoration:line-through;margin:5px 0}
.fb-you{color:var(--ink);margin-bottom:7px}
.fb-acts{display:flex;gap:6px}
.fb-done{opacity:.4}
.fb-done .fb-acts{display:none}
details ul{margin:8px 0 0;padding-left:20px}

.toolbar{position:sticky;top:0;z-index:5;display:flex;gap:10px;flex-wrap:wrap;align-items:center;
  padding:12px 24px;background:var(--panel);border-bottom:1px solid var(--line);box-shadow:var(--shadow)}
.toolbar input,.toolbar select{padding:7px 11px;border:1px solid var(--line);border-radius:8px;
  background:var(--bg);color:var(--ink);font:inherit;font-size:14px}
.toolbar input{flex:1;min-width:200px}
.toolbar .open3{padding:7px 12px;border:1px solid var(--line);border-radius:8px;background:var(--bg);
  color:var(--ink);font:inherit;font-size:14px;cursor:pointer}
.toolbar .open3:hover{border-color:var(--accent);color:var(--accent)}
.shown{color:var(--dim);font-size:13px;margin-left:auto}

main{padding:22px 24px 60px;max-width:1080px;margin:0 auto}
.band{margin-bottom:34px}
.band h2{font-size:15px;text-transform:uppercase;letter-spacing:.06em;color:var(--dim);
  margin:0 0 4px;display:flex;align-items:center;gap:9px}
.band .count{background:var(--chip);color:var(--ink);border-radius:20px;padding:1px 9px;font-size:12px;letter-spacing:0}
.band-note{margin:0 0 14px;color:var(--dim);font-size:13px;max-width:70ch}
.cards{display:flex;flex-direction:column;gap:12px}

.job{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:16px 18px;box-shadow:var(--shadow)}
.job-head{display:flex;justify-content:space-between;gap:16px;align-items:flex-start}
.job h3{margin:0 0 3px;font-size:17px;line-height:1.3}
.job h3 a{color:var(--ink);text-decoration:none}
.job h3 a:hover{color:var(--accent);text-decoration:underline}
.company{color:var(--dim);font-size:14px}
.score{flex:none;width:44px;height:44px;border-radius:10px;background:var(--chip);
  display:grid;place-items:center;font-weight:600;font-size:16px}

.badges{display:flex;flex-wrap:wrap;gap:6px;margin-top:11px}
.badge{font-size:12px;padding:2px 9px;border-radius:20px;background:var(--chip);color:var(--dim);white-space:nowrap}
.badge.remote{background:var(--accent);color:var(--accent-ink)}
.badge.hybrid,.badge.onsite{background:var(--accent);color:var(--accent-ink);opacity:.8}
.badge.unknown{opacity:.7}
.badge.ai{background:var(--ai-bg);color:var(--ai);cursor:help;font-weight:500}
.badge.fallback{background:var(--warn-bg);color:var(--warn);cursor:help}
.ai-reason{margin:10px 0 0;padding:8px 11px;border-left:3px solid var(--ai);
  background:var(--ai-bg);border-radius:0 6px 6px 0;font-size:13px;color:var(--ink);line-height:1.5}

.chips{display:flex;flex-wrap:wrap;gap:5px;margin-top:10px}
.chip{font-size:12px;padding:2px 8px;border-radius:6px;background:var(--chip);color:var(--dim)}
.chip.warn{background:var(--warn-bg);color:var(--warn);cursor:help}
/* Distinct from .warn: this is not a fact about the job, it is a caveat about
   how much of the job we were able to read. */
.chip.partial{background:transparent;border:1px dashed var(--warn);color:var(--warn);font-style:italic;cursor:help}
/* A card judged on a fragment looks different, so it is never mistaken for one that was read in full. */
.job.is-partial{border-left:4px solid var(--warn)}
.job.is-partial h3 a{color:var(--warn);font-style:italic}

.actions{display:flex;align-items:center;gap:14px;margin-top:14px;flex-wrap:wrap}
.apply{background:var(--accent);color:var(--accent-ink);text-decoration:none;font-weight:600;
  font-size:14px;padding:8px 16px;border-radius:8px}
.apply:hover{filter:brightness(1.08)}
.id{font-size:12px;color:var(--dim);background:var(--chip);padding:3px 7px;border-radius:5px;cursor:help}
.why summary,.desc summary{cursor:pointer;color:var(--dim);font-size:13px}
.breakdown{list-style:none;margin:8px 0 0;padding:0;font-size:13px;max-width:460px}
.breakdown li{display:flex;justify-content:space-between;gap:12px;padding:2px 0;border-bottom:1px dotted var(--line)}
.breakdown b{color:var(--accent)}
.breakdown b.neg{color:var(--warn)}
.desc{margin-top:12px;border-top:1px solid var(--line);padding-top:10px}
.desc pre{white-space:pre-wrap;font:13px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;
  color:var(--dim);max-height:420px;overflow:auto;margin:10px 0 0;
  background:var(--bg);padding:12px;border-radius:8px}

.empty{text-align:center;padding:70px 20px;color:var(--dim)}
.empty h2{color:var(--ink);font-size:19px;margin:0 0 8px}
.dim{color:var(--dim)}.small{font-size:13px}
code{font:12px ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--chip);padding:1px 5px;border-radius:4px}
footer{padding:24px;border-top:1px solid var(--line);color:var(--dim);font-size:13px;text-align:center}
footer a{color:var(--accent)}
footer p{margin:4px 0}
.marks{display:inline-flex;gap:5px}
.mark{font:inherit;font-size:12px;padding:5px 10px;border:1px solid var(--line);
  border-radius:7px;background:var(--panel);color:var(--dim);cursor:pointer}
.mark:hover{border-color:var(--accent);color:var(--accent)}
.why{font-size:11px;padding:3px 8px}
.why-lead{font-size:11px;color:var(--dim);margin-right:2px;align-self:center}
.app-group{margin-top:8px}
.app-group > summary{cursor:pointer;font-weight:600;color:var(--ink)}
.app-group > summary:hover{color:var(--accent)}
.app-group[open] > summary{margin-bottom:4px}
.salary-in{font:inherit;font-size:12px;padding:4px 8px;width:150px;border:1px solid var(--line);
  border-radius:7px;background:var(--bg);color:var(--ink)}
.salary-in:focus{outline:none;border-color:var(--accent)}
.mark.done{background:var(--accent);border-color:var(--accent);color:var(--accent-ink);font-weight:600}
.mark.copied{border-color:var(--warn);color:var(--warn)}
.job.marked{opacity:.5}
.job.marked .apply{filter:grayscale(1)}
.app-acts{display:flex;align-items:center;gap:8px;margin-top:8px}
.app-btn{font:inherit;font-size:12px;padding:4px 11px;border:1px solid var(--line);border-radius:7px;
  background:var(--panel);color:var(--ink);cursor:pointer;white-space:nowrap}
.app-btn:hover{border-color:var(--accent);color:var(--accent)}
.app-btn:disabled{opacity:.55;cursor:progress}
.job.leaving{opacity:0;transform:scale(.98);transition:opacity .2s,transform .2s}
.job.gone{display:none}
.restore{font:inherit;font-size:12px;padding:2px 10px;margin-left:auto;border:1px solid var(--line);
  border-radius:7px;background:var(--bg);color:var(--ink);cursor:pointer}
.restore:hover{border-color:var(--accent);color:var(--accent)}
.restore:disabled{opacity:.5;cursor:progress}
.static-note{font-size:12px;color:var(--dim);margin-left:auto}
.job.hidden{display:none}
.still-open{opacity:.9}
.still-open .job{border-style:dashed}
.toggle{display:inline-flex;align-items:center;gap:7px;font-size:13px;color:var(--ink);
  cursor:pointer;user-select:none;white-space:nowrap}
.toggle input{accent-color:var(--accent);width:15px;height:15px;cursor:pointer;margin:0}
.badge.carried{background:var(--chip);color:var(--dim);border:1px dashed var(--line)}
/* Dashed edge marks a carried card while it sits among today's finds. Without
   it, merging the two queues would erase the distinction entirely. */
.job.is-carried{border-style:dashed}
.carried-note{font-style:italic}

/* Rejections: a scan list, not cards. Deliberately plain so it never competes
   with the results above — it is for spot-checking the filter, not browsing. */
.rej-page .rej-head{max-width:1080px;margin:0 auto;padding:28px 24px 8px}
.rej-page .rej-head h1{font-size:22px;margin:8px 0 6px}
.rej-page .rej-back{color:var(--accent);text-decoration:none;font-size:13px}
.discard-link{max-width:1080px}
.discard-link a.btn{color:var(--accent);font-weight:600;text-decoration:none;margin-right:8px}
.discard-link a.btn:hover{text-decoration:underline}
.rejects{max-width:1080px;margin:0 auto;padding:0 24px 40px}
.rejects > summary{cursor:pointer;color:var(--dim);font-size:13px;padding:14px 0;
  border-top:1px solid var(--line);list-style:none}
.rejects > summary::-webkit-details-marker{display:none}
.rejects > summary::before{content:"▸ ";}
.rejects[open] > summary::before{content:"▾ ";}
.rejects > summary:hover{color:var(--ink)}
.rej-group{margin:0 0 6px}
.rej-group > summary{cursor:pointer;font-size:12px;text-transform:uppercase;letter-spacing:.06em;
  color:var(--dim);font-weight:600;padding:9px 0;list-style:none}
.rej-group > summary::-webkit-details-marker{display:none}
.rej-group > summary::before{content:"+ ";font-weight:400}
.rej-group[open] > summary::before{content:"− ";font-weight:400}
.rej-group > summary:hover{color:var(--ink)}
.rej-n{background:var(--chip);color:var(--dim);border-radius:9px;padding:1px 7px;
  margin-left:6px;font-size:11px;letter-spacing:0}
.rej-row{display:flex;gap:10px;align-items:baseline;padding:4px 0;font-size:13px;
  border-bottom:1px solid var(--line)}
.rej-row a{color:var(--accent);text-decoration:none;flex:0 1 auto}
.rej-row a:hover{text-decoration:underline}
.rej-co{color:var(--ink);opacity:.75;white-space:nowrap}
/* The id was on the job cards but not here, so a rejection you wanted to apply
   to anyway had no handle — you could read the title and nothing else. It is
   the argument to apply, why and mark, so it has to be copyable: user-select,
   and never truncated. */
/* Sits after the reason, which already takes margin-left:auto, so the button
   pins to the right edge without pushing the title around. Kept quiet until
   hovered: it is one click away from changing what the next run reports. */
.rej-marks{flex:0 0 auto;margin-left:8px}
.rej-marks .mark{font-size:11px;padding:1px 7px;opacity:.55}
.rej-row:hover .rej-marks .mark{opacity:1}
/* The gates that ALSO failed. Muted on purpose: the owning reason is the
   headline, this is the footnote saying whether it stood alone. */
.rej-also{font-size:11px;color:var(--dim);opacity:.75;white-space:nowrap}
.rej-marks .mark.done{opacity:1;font-weight:600}
.rej-id{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;
  color:var(--dim);background:var(--chip);border:1px solid var(--line);border-radius:4px;
  padding:1px 5px;flex:0 0 auto;user-select:all;cursor:text}
.rej-why{color:var(--dim);margin-left:auto;text-align:right;font-size:12px;
  flex:0 1 46%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rej-ai{color:var(--warn)}
.rej-actions{display:flex;gap:10px;align-items:baseline;flex-wrap:wrap;padding:2px 0 10px}
.rej-clear{font:inherit;font-size:12px;padding:5px 11px;border:1px solid var(--line);
  border-radius:7px;background:var(--panel);color:var(--dim);cursor:pointer;white-space:nowrap}
.rej-clear:hover{border-color:var(--accent);color:var(--accent)}
.rej-clear.copied{border-color:var(--warn);color:var(--warn)}
.rej-group.cleared{opacity:.4}
.rej-group.cleared > summary{text-decoration:line-through}
@media(max-width:700px){.rej-row{flex-wrap:wrap}.rej-why{margin-left:0;text-align:left;flex-basis:100%}}
`;

const JS = `
/* ---- sections ----
   The address is the state: #open, #progress, #applied, #sources, #discarded. So a
   reload, the app restarting its window, or a link all land on the same page, and
   the back button walks through the sections you visited. Nothing is fetched here —
   the pages are all in the document and only one is shown. */
(function(){
  var TABS = ['open','progress','applied','discarded','log','settings'];
  function show(){
    var t = (location.hash || '').replace('#','');
    if (t === 'sources') t = 'settings';   // what the page used to be called, for an old bookmark
    if (TABS.indexOf(t) < 0) t = 'open';
    document.body.dataset.tab = t;
    document.querySelectorAll('.tab').forEach(function(a){
      var on = a.dataset.tab === t;
      a.classList.toggle('active', on);
      if (on) a.setAttribute('aria-current','page'); else a.removeAttribute('aria-current');
    });
    window.scrollTo(0, 0);
  }
  window.addEventListener('hashchange', show);
  show();
})();

(function(){
  var q=document.getElementById('q'), mode=document.getElementById('mode'),
      sort=document.getElementById('sort'), shown=document.getElementById('shown'),
      merge=document.getElementById('merge'),
      carryBox=document.querySelector('.still-open');
  if(!q) return;

  /* Asked each time rather than remembered: cards arrive after the page loads
     (a job you restore, a scan that finds one) and a list taken at load would
     never see them. */
  function allJobs(){ return [].slice.call(document.querySelectorAll('.job')); }

  /* A card you have turned down is 'gone', not deleted from the page: it stays in
     the DOM so nothing holds a stale reference, but it counts for nothing here —
     not in "n of m shown", not in a section's number, and not as a reason to keep
     an emptied section on screen. */
  function apply(){
    var term=q.value.trim().toLowerCase(), m=mode.value, n=0, total=0;
    allJobs().forEach(function(j){
      if(j.classList.contains('gone')) return;
      total++;
      var ok=(!term||j.dataset.search.indexOf(term)>-1)&&(!m||j.dataset.mode===m);
      j.classList.toggle('hidden',!ok);
      if(ok)n++;
    });
    shown.textContent=n+' of '+total+' shown';
    document.querySelectorAll('.band').forEach(function(b){
      var any=b.querySelectorAll('.job:not(.hidden):not(.gone)').length;
      var count=b.querySelector('.count');
      if(count) count.textContent=b.querySelectorAll('.job:not(.gone)').length;
      b.style.display=any?'':'none';
    });
    // "No new jobs" is only true while there are none; a card restored onto an
    // empty page must not sit under it.
    var emptyBox=document.querySelector('.empty');
    if(emptyBox) emptyBox.hidden=total>0;
    // The number beside Open is every open card, not the ones the filter lets
    // through: a filter narrows what you see, it does not close jobs. Nothing open
    // means no number rather than a 0.
    var openCount=document.getElementById('count-open');
    if(openCount) openCount.textContent=total||'';
  }
  window.__recount=apply;

  /* "Open next 3": the first three cards still waiting for a decision, in the order
     the page shows them. Interested is skipped -- you have already looked at those.
     Gone cards are closed and hidden ones are filtered out, so neither counts. Each
     goes through window.open, which the app hands to the system browser (guard() in
     electron/main.js); a plain browser opens tabs and may ask to allow pop-ups. */
  var open3=document.getElementById('open3');
  if(open3) open3.addEventListener('click',function(){
    var urls=[];
    allJobs().forEach(function(j){
      if(urls.length>=3) return;
      if(j.classList.contains('gone')||j.classList.contains('hidden')) return;
      if(j.querySelector('.mark.done[data-status="interested"]')) return;
      var a=j.querySelector('.job-head a');
      var href=a?a.getAttribute('href'):'';
      if(/^https?:[/][/]/i.test(href)) urls.push(href);
    });
    if(!urls.length){ shown.textContent='Nothing waiting for review'; return; }
    urls.forEach(function(u){ window.open(u,'_blank','noopener'); });
  });

  function reorder(){
    var key=sort.value;
    document.querySelectorAll('.cards').forEach(function(c){
      [].slice.call(c.children).sort(function(a,b){
        if(key==='score') return b.dataset.score-a.dataset.score;
        if(key==='distance') return a.dataset.distance-b.dataset.distance;
        return (b.dataset.date||'').localeCompare(a.dataset.date||'');
      }).forEach(function(el){c.appendChild(el)});
    });
  }

  /* One queue vs. two. The carried cards are MOVED between their score band and
     the still-open section — never duplicated, or the page would hold two of
     every backlog card and marking one would leave the other stale. */
  function applyMerge(){
    if(!merge||!carryBox) return;
    var one=merge.checked, dest=carryBox.querySelector('.cards');
    document.querySelectorAll('.job[data-carried]').forEach(function(j){
      var home=document.querySelector('.cards[data-band="'+j.dataset.band+'"]');
      var target=one?home:dest;
      if(target&&j.parentNode!==target) target.appendChild(j);
    });
    carryBox.hidden=one;
    document.querySelectorAll('.carried-note').forEach(function(p){p.hidden=!one});
    try{localStorage.setItem('jobsieve.merge',one?'1':'0')}catch(e){}
    reorder(); apply();
  }

  if(merge){
    // Remembered across reports, so the choice is made once rather than after
    // every search.
    try{ if(localStorage.getItem('jobsieve.merge')==='0') merge.checked=false; }catch(e){}
    merge.addEventListener('change',applyMerge);
  }

  q.addEventListener('input',apply);
  mode.addEventListener('change',apply);
  sort.addEventListener('change',reorder);

  /* For cards added from outside this script — see syncQueue below. They arrive
     already in their band; this puts them in order, honours the one-queue toggle
     and recounts. */
  window.__relayout=function(){
    if(merge&&carryBox) applyMerge(); else { reorder(); apply(); }
  };

  applyMerge();
  apply();
})();

/* ---- marking ----
   Served over http (npm run serve): buttons write straight to data/seen.json.
   Opened from disk (file://): there is no server to talk to, so the button
   copies the exact CLI command instead of failing silently. */
(function(){
  // Six buttons, not the eleven gates. A group stands for one or more gate
  // categories and is stored under its own key, so the reason you give can
  // still be compared with the reason the tool gave -- see PICKER_GROUPS.
  var REASONS = ${JSON.stringify(PICKER_GROUPS.map((g) => [g.key, g.label]))};

  var live = location.protocol === 'http:' || location.protocol === 'https:';

  /* The applications panel is built here rather than server-side, so it is the
     one list that does not go through escapeHtml() on the way out. Its fields
     are not ours: the company name comes from a job board, the storyline from a
     language model, and the salary from a text box. */
  function esc(v){
    return String(v == null ? '' : v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /* ---- tailored applications ----
     The button lives on the card because that is where the decision happens:
     you are reading a posting when you decide to apply. Generating blocks for
     20-30 seconds, which is acceptable for one user on one machine and far
     simpler than a job queue. */
  if (live) {
    document.querySelectorAll('.tailor').forEach(function(b){ b.hidden = false; });

    /* Postings waiting for their advert: paste the text to add one like a job you typed
       in, or turn it down. Served-only, like the add-a-job form: from disk the POST
       goes nowhere. The row is replaced by a line saying what happened. */
    var whyOpts = REASONS.map(function(r){ return '<option value="' + esc(r[0]) + '">' + esc(r[1]) + '</option>'; }).join('');
    [].slice.call(document.querySelectorAll('.parked-act')).forEach(function(d){
      d.hidden = false;
      d.querySelector('.parked-why').innerHTML = whyOpts;
    });
    document.addEventListener('click', function(ev){
      var add = ev.target.closest('.parked-add'), rej = ev.target.closest('.parked-reject');
      if (!add && !rej) return;
      var box = (add || rej).closest('.parked-act'), say = box.querySelector('.parked-say');
      var body = { id: box.dataset.id, action: add ? 'add' : 'reject',
        description: box.querySelector('textarea').value, reason: box.querySelector('.parked-why').value };
      say.textContent = 'working\\u2026';
      fetch('/api/parked', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
        .then(function(r){ return r.json(); })
        .then(function(res){
          if (res.error) { say.textContent = res.error; return; }
          box.closest('li').remove();
          syncParked();
          if (window.__refresh) window.__refresh();
        })
        .catch(function(){ say.textContent = 'failed'; });
    });

    /* The report was written when the last scan finished, so its list still holds postings
       you have since dealt with — they came back on every reload. Ask the server which are
       still parked, drop the rest, and keep the count in the heading true. */
    var syncParked = function(){
      var section = document.querySelector('section.parked');
      if (!section) return;
      fetch('/api/parked').then(function(r){ return r.json(); }).then(function(ids){
        [].slice.call(section.querySelectorAll('.parked-act')).forEach(function(d){
          if (ids.indexOf(d.dataset.id) < 0) d.closest('li').remove();
        });
        var n = section.querySelectorAll('li').length;
        if (!n) { section.hidden = true; return; }
        section.hidden = false;
        section.querySelector('summary strong').textContent = n;
      }).catch(function(){});
    };
    syncParked();
    window.addEventListener('focus', syncParked);

    var appbox = document.getElementById('appbox'),
        applist = document.getElementById('applist'),
        appsum = document.getElementById('appsum'),
        archbox = document.getElementById('archbox'),
        archlist = document.getElementById('archlist'),
        archsum = document.getElementById('archsum'),
        rejdocbox = document.getElementById('rejdocbox'),
        rejdoclist = document.getElementById('rejdoclist'),
        rejdocsum = document.getElementById('rejdocsum'),
        proglist = document.getElementById('proglist'),
        progcount = document.getElementById('count-progress');

    /* The button that opens an application's folder, wherever it appears. */
    var openDocs = function(a){
      return '<button class="app-btn app-open" data-folder="' + esc(a.folder) + '"'
        + ' title="Open the folder with the CV, the cover letter and your notes.">Open Docs</button>';
    };

    /* On an OPEN job's card, once it has documents: Open Docs and Regenerate.
       Regenerate lives only here — while the job is still undecided, a different CV
       and letter is a sensible thing to ask for; after you have applied, they are what
       went out. The server finds the posting from the folder's own fingerprint, so the
       button needs only the folder. */
    var cardDocs = function(a){
      return openDocs(a)
        + '<button class="app-btn app-regen" data-folder="' + esc(a.folder) + '" data-company="' + esc(a.company || '') + '"'
        + ' title="Write a different CV and cover letter for this job. The current ones are kept.">Regenerate</button>'
        + '<span class="app-say dim small"></span>';
    };

    // Applications with documents, by the id the cards carry (the first 8 of the fingerprint).
    var docsFor = {};

    /* Show each open card's buttons from what is known about its documents: a job that
       has them gets Open Docs and Regenerate in place of "Tailor application" (which
       would only answer "already written"); one that does not keeps Tailor. Cards come
       and go — the page syncs them in — so this runs after every list and every sync. */
    var decorateCards = function(){
      [].slice.call(document.querySelectorAll('.job')).forEach(function(card){
        var marks = card.querySelector('.marks');
        var host = card.querySelector('.card-docs');
        var tailor = card.querySelector('.tailor');
        if (!marks || !host) return;
        var a = docsFor[marks.dataset.id];
        if (a) {
          if (host.dataset.folder !== a.folder) {
            host.dataset.folder = a.folder;
            host.className = 'card-docs app-acts';
            host.innerHTML = cardDocs(a);
          }
          if (tailor) tailor.hidden = true;
        } else {
          if (host.dataset.folder) { host.removeAttribute('data-folder'); host.className = 'card-docs'; host.innerHTML = ''; }
          if (tailor) tailor.hidden = false;
        }
      });
    };

    /* The description, fetched the first time a row's details is opened and kept. */
    var jdCache = {};
    var fillJd = function(det){
      var pre = det.querySelector('pre'), job = det.dataset.job;
      // An application is read from its folder; a job you turned down has none, so it is read by id.
      var folder = job ? 'job:' + job : det.dataset.folder;
      if (jdCache[folder] != null) { pre.textContent = jdCache[folder]; return; }
      pre.textContent = 'Loading\\u2026';
      fetch(job ? '/api/job-jd?id=' + encodeURIComponent(job) : '/api/application-jd?folder=' + encodeURIComponent(folder))
        .then(function(r){ return r.json(); })
        .then(function(d){
          // textContent, never innerHTML: an advert is text a job board wrote.
          var text = d.error ? 'Could not load the description: ' + d.error
            : d.text ? d.text + '\\n\\n\\u2014 ' + d.source
            : 'No advert text was kept for this application' + (d.applyUrl ? ' \\u2014 open the posting from the company name above.' : '.');
          jdCache[folder] = text;
          pre.textContent = text;
        })
        .catch(function(){ pre.textContent = 'Could not load the description.'; });
    };
    // The toggle event does not bubble, so it is caught on the way down.
    document.addEventListener('toggle', function(ev){
      var det = ev.target;
      if (det && det.classList && det.classList.contains('app-jd') && det.open) fillJd(det);
    }, true);

    /* A short message beside an application's buttons, which survives the list
       being repainted underneath it. */
    var notice = {};
    var appNote = function(folder, text){
      notice[folder] = text;
      [].slice.call(document.querySelectorAll('.app-acts')).forEach(function(box){
        var b = box.querySelector('.app-open');
        if (b && b.dataset.folder === folder) box.querySelector('.app-say').textContent = text;
      });
    };

    var lastAppsSig = '';
    var paintApps = function(d){
      // The page asks every twenty seconds, and repainting an unchanged list would
      // close every description you had open and wipe a regeneration's progress.
      var sig = JSON.stringify(d.applications);
      if (sig === lastAppsSig) return;
      lastAppsSig = sig;
      var wasOpen = [].slice.call(document.querySelectorAll('details.app-jd[open]')).map(function(x){ return x.dataset.folder; });

      // Never hidden: each page says what is missing in words, and the Applied page
      // would otherwise be blank until the first application.
      appbox.hidden = false;

      /* Three groups, because a list of 61 in date order answers no question.
         PROGRESSING is the one that matters: somebody wrote back and wants to
         meet you. Named for the STATE rather than for the outcomes that produce
         it, so adding a third one later does not mean rewriting the heading --
         and it is the word the grouping test below already uses, so the heading
         and the code that fills it cannot describe different things.
         ARCHIVED is age, not an outcome -- 30 days of silence is an answer in
         this market, and waiting for a rejection email that will never arrive is
         what left 60 of 61 with no outcome at all. It is a fold, not a delete:
         the folder, the CV and the letter are all untouched, and setting an
         outcome on an archived row still works and still moves it. */
      var ARCHIVE_DAYS = 30;
      // The stored value is a key; the menu and the row say what it means. An interview or
      // offer that ended is not progressing any more, so the rule below sends it back to
      // Applied, and age folds it away from there like any other application.
      var OUTCOME_LABEL = { unsuccessful: 'not hired \u2014 they said no', declined: 'declined \u2014 I said no' };
      var OUTCOME_CHIP = { unsuccessful: 'not hired', declined: 'offer declined' };
      var cutoff = Date.now() - ARCHIVE_DAYS * 86400000;
      var progressing = [], applied = [], archived = [], turnedDown = [];
      d.applications.forEach(function(a){
        // A folder exists for every job that was TAILORED, not only those applied to. One
        // you then turned down — usually on reaching the real application: new demands, a
        // paywall — is not an application and must not be counted as one. It stays, with
        // its documents and advert, so you can see why.
        if (a.status === 'rejected' || a.status === 'hidden') { turnedDown.push(a); return; }
        // A job still on the Open page — tailored, not yet decided — is not an application
        // either. Its documents are offered on its card there; it joins this list when you
        // mark it applied.
        if (a.status === 'new' || a.status === 'shown' || a.status === 'interested') return;
        // Something you are still in beats the calendar. An interview booked
        // for a job applied to six weeks ago is not archive material.
        if (a.outcome === 'interview' || a.outcome === 'offer') { progressing.push(a); return; }
        var at = Date.parse(a.at || '');
        if (at && at < cutoff) { archived.push(a); return; }
        applied.push(a);
      });

      function row(a){
        var opts = d.outcomes.map(function(o){
          return '<option value="' + esc(o) + '"' + (a.outcome === o ? ' selected' : '') + '>' + esc(OUTCOME_LABEL[o] || o) + '</option>';
        }).join('');
        // An untailored application has no storyline, so without the chip it
        // renders as a bare company name and reads like something went wrong.
        var co = esc(a.company || a.folder);
        // Only http(s) becomes a link — an applyUrl is whatever the source said
        // it was, and javascript: is a valid string.
        // Doubled because JS is a template literal — see \\u2713 below.
        var href = /^https?:\\/\\//i.test(a.applyUrl || '') ? a.applyUrl : '';
        var head = href
          ? '<a class="app-co" href="' + esc(href) + '" target="_blank" rel="noopener">' + co + '</a>'
          : '<span class="app-co">' + co + '</span>';
        return '<div class="app">'
          + '<div class="app-head">' + head
          + '<span class="dim small">' + String(a.at || '').slice(0, 10) + '</span>'
          + (a.tailored === false ? '<span class="chip" title="Applied with the standard CV — nothing was tailored.">standard CV</span>' : '')
          + (a.salaryAsked ? '<span class="chip pay" title="What you asked for in their application form.">asked ' + esc(a.salaryAsked) + '</span>' : '')
          + (a.blocked ? '<span class="chip warn">' + esc(a.blocked) + ' unverified</span>' : '')
          + (OUTCOME_CHIP[a.outcome] ? '<span class="chip" title="How this application ended.">' + esc(OUTCOME_CHIP[a.outcome]) + '</span>' : '')
          // A job turned down has no outcome to set — it was not applied to — and shows why instead.
          + (a.status === 'rejected'
            ? (a.rejectedReason ? '<span class="chip" title="Why you turned it down.">' + esc(reasonText(a.rejectedReason)) + '</span>' : '')
            : '<select class="app-outcome" data-folder="' + esc(a.folder) + '">'
              + '<option value="">outcome…</option>' + opts + '</select>')
          // A job you turned down can be taken back from here as well as from Turned down.
          // The shared click handler marks it Interested and repaints every list.
          + ((a.status === 'rejected' || a.status === 'hidden') && a.fingerprint
            ? '<button class="restore" data-id="' + esc(String(a.fingerprint).slice(0, 8)) + '">Restore</button>' : '')
          + '</div>'
          + (a.title ? '<div class="app-title dim small">' + esc(a.title) + '</div>' : '')
          + (a.storyline ? '<div class="app-story">' + esc(a.storyline) + '</div>' : '')
          + actions(a)
          // The advert, read again: the single most useful thing to have to hand once
          // you have applied. Fetched when opened rather than sent with every row, so
          // the list the page re-checks every twenty seconds stays small.
          + '<details class="desc app-jd" data-folder="' + esc(a.folder) + '">'
          + '<summary>Job description</summary><pre></pre></details>'
          + '</div>';
      }

      /* Open Docs belongs to an application that has DOCUMENTS. One sent with the
         standard CV has none, and a button that opens an empty folder would be worse
         than no button. There is no Regenerate here: once a job is applied to, its
         documents are what went out, and rewriting them is only worth offering while
         the job is still open — see cardDocs(), on the Open page. */
      function actions(a){
        if (a.tailored === false) return '';
        return '<div class="app-acts">' + openDocs(a) + '<span class="app-say dim small"></span></div>';
      }

      /* Two pages are fed from this one list. The ones you are still in — interview
         or offer — go to In progress; everything else is Applied, with the old ones
         folded under Archived. Setting an outcome repaints both, so an application
         moves between the pages as you mark it. */
      appsum.textContent = 'Applied — ' + applied.length;
      progcount.textContent = progressing.length || '';

      proglist.innerHTML = progressing.length
        ? progressing.map(row).join('')
        : '<p class="dim small">Nothing in progress. An application you mark <strong>interview</strong> or <strong>offer</strong> appears here.</p>';

      applist.innerHTML = applied.length
        ? applied.map(row).join('')
        : '<p class="dim small">Nothing applied to yet.</p>';

      // Each group is a section of its own, at the same level as Applied, and is hidden
      // while it has nothing in it.
      var fold = function(box, sum, list, title, rows){
        box.hidden = !rows.length;
        sum.textContent = title + ' \\u2014 ' + rows.length;
        list.innerHTML = rows.map(row).join('');
      };
      fold(archbox, archsum, archlist, 'Archived', archived);
      fold(rejdocbox, rejdocsum, rejdoclist, 'Rejected \\u2014 documents kept', turnedDown);

      // Put back what the repaint took: descriptions you had open, and any message.
      [].slice.call(document.querySelectorAll('details.app-jd')).forEach(function(det){
        if (wasOpen.indexOf(det.dataset.folder) >= 0) { det.open = true; fillJd(det); }
      });
      Object.keys(notice).forEach(function(folder){ appNote(folder, notice[folder]); });

      // And tell the open jobs which of them now have documents.
      docsFor = {};
      d.applications.forEach(function(a){
        if (a.tailored !== false && a.fingerprint) docsFor[a.fingerprint.slice(0, 8)] = a;
      });
      decorateCards();
      applyFind();
    };

    var loadApps = function(){
      fetch('/api/applications').then(function(r){ return r.json(); }).then(paintApps).catch(function(){});
    };

    /* ---- Open and Regenerate, for an application that has documents ---- */
    var post = function(url, body){
      return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
        .then(function(r){ return r.json(); });
    };

    document.addEventListener('click', function(ev){
      var open = ev.target.closest('.app-open');
      if (open) {
        post('/api/application-open', { folder: open.dataset.folder })
          .then(function(res){ appNote(open.dataset.folder, res.ok ? 'opened' : (res.error || 'could not open it')); })
          .catch(function(){ appNote(open.dataset.folder, 'could not open it'); });
        return;
      }

      var regen = ev.target.closest('.app-regen');
      if (!regen) return;
      var folder = regen.dataset.folder;
      // Asked first, because it replaces the documents in the folder. They are kept
      // under .generation/previous — but the letter you edited by hand is not where
      // you left it afterwards, and that deserves a deliberate yes.
      if (!window.confirm('Regenerate the CV and cover letter for ' + (regen.dataset.company || 'this job') + '?'
        + '\\n\\nThe new ones replace the documents in the folder. The current ones are kept in'
        + '\\n.generation\\\\previous, but any edits you made are not carried into the new draft.')) return;

      regen.disabled = true;
      appNote(folder, 'writing\\u2026 (about 30 seconds)');
      post('/api/apply', { folder: folder, refresh: true })
        .then(function(res){
          if (res.error) { appNote(folder, res.error.slice(0, 160)); return; }
          appNote(folder, res.blocked ? 'draft only \\u2014 ' + res.blocked + ' unverified' : 'regenerated \\u2713');
          // The notes file is rewritten, so the saved posting may have changed too.
          delete jdCache[folder];
          lastAppsSig = '';
          loadApps();
        })
        .catch(function(){ appNote(folder, 'failed'); })
        .finally(function(){ regen.disabled = false; });
    });

    /* The list of what you turned down. It exists because a card leaves the queue
       the moment you mark it: without somewhere that still says what you did, a
       misclick is gone with no trace on the page. Restore is the undo. */
    var rejbox = document.getElementById('rejbox'),
        rejlist = document.getElementById('rejlist'),
        rejsum = document.getElementById('rejsum');

    var reasonText = function(key){
      for (var i = 0; i < REASONS.length; i++) if (REASONS[i][0] === key) return REASONS[i][1];
      return key;
    };

    var paintRej = function(rows){
      if (!rows.length) { rejbox.hidden = true; return; }
      rejbox.hidden = false;
      rejsum.textContent = 'Turned down — ' + rows.length + ' in the last 30 days';
      rejlist.innerHTML = rows.map(function(r){
        // Only http(s) becomes a link, as in the applications list.
        var href = /^https?:\\/\\//i.test(r.applyUrl || '') ? r.applyUrl : '';
        var co = href
          ? '<a class="app-co" href="' + esc(href) + '" target="_blank" rel="noopener">' + esc(r.company) + '</a>'
          : '<span class="app-co">' + esc(r.company) + '</span>';
        return '<div class="app"><div class="app-head">'
          + co
          + '<span class="dim small">' + esc(String(r.at || '').slice(0, 10)) + '</span>'
          + (r.reason ? '<span class="chip">' + esc(reasonText(r.reason)) + '</span>' : '')
          + '<button class="restore" data-id="' + esc(r.id) + '">Restore</button></div>'
          + '<div class="app-title dim small">' + esc(r.title) + '</div>'
          + '<details class="desc app-jd" data-job="' + esc(r.id) + '"><summary>Job description</summary><pre></pre></details>'
          + '</div>';
      }).join('');
      applyFind();
    };

    /* A box to find one job among the lists on this page. It hides rows rather than
       rebuilding them, so a description you have open and a half-chosen outcome
       survive, and it is applied again after every repaint (paintApps, paintRej),
       because those replace the rows underneath it. While a query is typed, the
       sections that hold a match are opened and the ones that hold none are hidden. */
    var appq = document.getElementById('appq'),
        appfind = document.getElementById('appfind'),
        appqsay = document.getElementById('appqsay');
    appfind.hidden = false;
    var applyFind = function(){
      var q = appq.value.trim().toLowerCase();
      var words = q ? q.split(/\\s+/) : [];
      var total = 0, shown = 0;
      ['appbox', 'archbox', 'rejdocbox', 'rejbox'].forEach(function(id){
        var box = document.getElementById(id);
        var rows = [].slice.call(box.querySelectorAll('.app'));
        var hits = 0;
        rows.forEach(function(r){
          var head = r.querySelector('.app-head'), title = r.querySelector('.app-title'), story = r.querySelector('.app-story');
          // Read the select's chosen option, not all of its options, or every row matches "offer".
          var sel = r.querySelector('select.app-outcome');
          var hay = ((head ? head.textContent.replace(sel ? sel.textContent : '', '') : '') + ' '
            + (title ? title.textContent : '') + ' ' + (story ? story.textContent : '') + ' '
            + (sel && sel.value ? sel.value : '')).toLowerCase();
          var ok = words.every(function(w){ return hay.indexOf(w) >= 0; });
          r.hidden = !ok;
          total++; if (ok) { shown++; hits++; }
        });
        if (q && rows.length) { box.dataset.findHidden = hits ? '' : '1'; box.style.display = hits ? '' : 'none'; if (hits) box.open = true; }
        else { box.style.display = ''; delete box.dataset.findHidden; }
      });
      appqsay.textContent = q ? shown + ' of ' + total + ' match' : '';
    };
    appq.addEventListener('input', applyFind);

    var loadRej = function(){
      fetch('/api/turned-down').then(function(r){ return r.json(); }).then(paintRej).catch(function(){});
    };

    /* ---- the queue, kept true ----
       This page is written when a scan finishes, so by itself it is a photograph:
       a job restored afterwards, a scan that found something, a mark made from the
       command line — none of them appear. So the page asks the server what is open
       and makes its cards match: it adds the ones it is missing, retires the ones
       that have closed, and re-draws one that came back. It never reloads, so a
       half-chosen reason or a typed filter survives.

       It only sends the cards it already holds, so the answer is nearly always
       "nothing to add". A card that is 'gone' is not held — if the server wants it
       back, a fresh one is fetched, because the old one still shows the buttons
       as they were when you turned it down. */
    var syncing = false;

    var ensureBand = function(b){
      var host = document.querySelector('.cards[data-band="' + b.index + '"]');
      if (host) return host;
      var sec = document.createElement('section');
      sec.className = 'band';
      sec.dataset.band = b.index;
      sec.innerHTML = '<h2>' + esc(b.title) + ' <span class="count">0</span></h2>'
        + '<div class="cards" data-band="' + b.index + '"></div>';
      var later = [].slice.call(document.querySelectorAll('main .band[data-band]')).filter(function(s){
        return Number(s.dataset.band) > b.index;
      })[0];
      var main = document.querySelector('main');
      var anchor = later || main.querySelector('.band.still-open');
      main.insertBefore(sec, anchor || null);
      return sec.querySelector('.cards');
    };

    var syncQueue = function(){
      if (syncing) return;
      syncing = true;
      var held = [];
      document.querySelectorAll('.job:not(.gone) .marks').forEach(function(m){ held.push(m.dataset.id); });
      fetch('/api/queue?have=' + encodeURIComponent(held.join(',')))
        .then(function(r){ return r.json(); })
        .then(function(q){
          var open = {};
          q.ids.forEach(function(id){ open[id] = 1; });

          // Closed since the page was written — here, in another window, or from the CLI.
          document.querySelectorAll('.job:not(.gone) .marks').forEach(function(m){
            if (!open[m.dataset.id]) m.closest('.job').classList.add('gone');
          });

          // Open, but not on this page (or on it only as a stale 'gone' card).
          // Scoped to cards: the rejection list at the foot of the page carries the
          // same .marks[data-id] for the same job, and matching that row instead
          // of the card is a crash, not a near miss.
          q.jobs.forEach(function(j){
            var old = document.querySelector('.job .marks[data-id="' + j.id + '"]');
            if (old) old.closest('.job').remove();
            ensureBand(q.bands[j.band]).insertAdjacentHTML('beforeend', j.html);
          });

          if (window.__relayout) window.__relayout();
          document.querySelectorAll('.tailor').forEach(function(b){ b.hidden = false; });
          // Last, because it hides the Tailor button on a card that already has documents.
          decorateCards();
        })
        // Said out loud rather than swallowed: a sync that fails quietly leaves a
        // page that looks fine and is wrong, which is the thing this exists to end.
        .catch(function(e){ if (window.console) console.error('queue sync failed:', e); })
        .finally(function(){ syncing = false; });
    };

    loadApps();
    loadRej();
    syncQueue();

    // Every list the page shows, brought up to date. Used after a mark and whenever
    // you look at the window again.
    /* ---- the app's own controls, on the page ----
       What the tray menu can do — scan now, pause, start with Windows, quit — offered
       here too. The page asks the app whether it IS the app: under npm run serve there
       is no scanner or login item to control, and a button that does nothing is worse
       than none, so the controls stay hidden until the answer is yes. The status text
       comes from the app itself (the same words as the tray), so the two cannot differ. */
    var appState = { available: false, paused: false };
    var appbar = document.getElementById('appbar'),
        setbox = document.getElementById('setbox'),
        scanBtn = document.getElementById('app-scan-btn'),
        pauseBtn = document.getElementById('app-pause-btn'),
        loginBox = document.getElementById('set-login'),
        quitBtn = document.getElementById('set-quit'),
        appMsg = document.getElementById('app-msg');

    var appSay = function(text){
      appMsg.textContent = text ? ' ' + text : '';
      if (text) setTimeout(function(){ if (appMsg.textContent === ' ' + text) appMsg.textContent = ''; }, 8000);
    };

    var paintApp = function(s){
      appState = s;
      appbar.hidden = setbox.hidden = !s.available;
      if (!s.available) return;
      document.getElementById('app-scan').textContent = s.scanText;
      document.getElementById('app-next').textContent = s.nextText;
      scanBtn.disabled = Boolean(s.scanning);
      pauseBtn.textContent = s.paused ? 'Resume scanning' : 'Pause scanning';
      loginBox.checked = Boolean(s.startWithWindows);
    };

    var loadApp = function(){
      fetch('/api/app').then(function(r){ return r.json(); }).then(paintApp).catch(function(){});
    };

    /* ---- postings waiting to be judged ----
       The model has a rate limit, and postings it could not answer are HELD, not decided by
       the rules: they are in no list below, so without this they would simply be missing.
       Says how many, why, and when it carries on. The button needs the app (it starts a
       run), so it shows only when the page is served by it. */
    var judgebar = document.getElementById('judgebar'),
        judgeText = document.getElementById('judge-text'),
        judgeBtn = document.getElementById('judge-btn');
    var paintJudging = function(s){
      var lines = (s && s.text ? s.text : '').split('\\n').filter(Boolean);
      judgebar.hidden = !lines.length;
      if (!lines.length) return;
      while (judgeText.firstChild) judgeText.removeChild(judgeText.firstChild);
      lines.forEach(function(line, i){
        var d = document.createElement('div');
        if (i === 0) d.className = 'jb-head';
        d.textContent = (i === 0 ? '\\u23f3 ' : '') + line;
        judgeText.appendChild(d);
      });
      judgeBtn.hidden = !appState.available;
    };
    var loadJudging = function(){
      fetch('/api/judging').then(function(r){ return r.json(); }).then(paintJudging).catch(function(){});
    };
    judgeBtn.addEventListener('click', function(){
      judgeBtn.disabled = true;
      appSay('starting\\u2026');
      post('/api/app/judge', {})
        .then(function(res){ appSay(res.ok ? 'judging started' : res.error); applyReply(res); })
        .catch(function(){ appSay('could not start judging'); })
        .then(function(){ judgeBtn.disabled = false; loadJudging(); });
    });

    // A reply to a control carries the new status, so the page repaints without a second request.
    var applyReply = function(res){ paintApp(Object.assign({ available: true }, res)); };

    scanBtn.addEventListener('click', function(){
      scanBtn.disabled = true;
      appSay('starting\\u2026');
      post('/api/app/scan', {})
        .then(function(res){ appSay(res.ok ? 'scan started' : res.error); applyReply(res); })
        .catch(function(){ appSay('could not start a scan'); scanBtn.disabled = false; });
    });

    pauseBtn.addEventListener('click', function(){
      post('/api/app/pause', { paused: !appState.paused })
        .then(applyReply)
        .catch(function(){ appSay('could not change that'); });
    });

    loginBox.addEventListener('change', function(){
      post('/api/app/login', { enabled: loginBox.checked })
        .then(applyReply)
        .catch(function(){ loginBox.checked = !loginBox.checked; });
    });

    quitBtn.addEventListener('click', function(){
      if (!window.confirm('Quit jobsieve?\\n\\nScanning stops until you start it again. Closing the window only hides it to the tray.')) return;
      post('/api/app/quit', {}).then(function(){ quitBtn.textContent = 'Quitting\\u2026'; quitBtn.disabled = true; });
    });

    /* ---- the log, as a tab ----
       Polled only while the Log tab is the one showing, and only repainted when the text
       changed: setting the same text again would scroll the page under you. */
    var logtext = document.getElementById('logtext'),
        logstatus = document.getElementById('log-status'),
        lastLog = null;

    /* Terminal colour to spans, so the tailor's CV diff reads here as it does in a terminal.
       The text is escaped FIRST: a log line can carry text a job board wrote. */
    var ansiHtml = function(text){
      var escText = function(s){ return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); };
      var parts = String(text).split(/\\u001b\\[([0-9;]*)m/), out = '', on = [];
      for (var i = 0; i < parts.length; i++) {
        if (i % 2 === 0) {
          // A span only around text that exists, so back-to-back codes leave no empty ones.
          if (parts[i]) out += on.length ? '<span class="' + on.join(' ') + '">' + escText(parts[i]) + '</span>' : escText(parts[i]);
          continue;
        }
        parts[i].split(';').forEach(function(c){
          if (c === '' || c === '0') on = [];
          else if (/^(1|2|3[0-7])$/.test(c)) on.push('a' + c);
        });
      }
      return out;
    };

    /* The log in groups. Each line says what it is about ([scan] [app] [tailor] [action]) and
       when, in UTC; a run of lines about the same thing becomes one block with a heading,
       and the times are shown in YOUR clock. Lines from before the tags existed carry the
       command name instead, and are mapped; anything unrecognised is filed under App. */
    var LOG_LABEL = { scan: 'Scan', app: 'App', tailor: 'Tailoring', action: 'Actions' };
    var LOG_LEGACY = { search: 'scan', daily: 'scan', report: 'scan', discover: 'scan', apply: 'tailor', mark: 'action', reviewed: 'action' };
    var two = function(n){ return (n < 10 ? '0' : '') + n; };
    var logHtml = function(text){
      var re = /^(\\d{4}-\\d\\d-\\d\\dT[\\d:.]+Z) (?:\\[([a-z]+)\\] )?(.*)$/;
      var blocks = [], cur = null;
      String(text).split('\\n').forEach(function(line){
        var m = re.exec(line), tag, at = null, body = line;
        if (m) { at = new Date(m[1]); tag = m[2] ? (LOG_LABEL[m[2]] ? m[2] : (LOG_LEGACY[m[2]] || 'app')) : 'app'; body = m[3]; }
        else tag = cur ? cur.tag : 'app';
        if (!cur || cur.tag !== tag) { cur = { tag: tag, at: at, lines: [] }; blocks.push(cur); }
        cur.lines.push((at ? '<span class="lt">' + two(at.getHours()) + ':' + two(at.getMinutes()) + ':' + two(at.getSeconds()) + '</span> ' : '') + ansiHtml(body));
      });
      return blocks.map(function(b){
        var when = b.at ? (b.at.toDateString() === new Date().toDateString() ? '' : two(b.at.getDate()) + '/' + two(b.at.getMonth() + 1) + ' ') + two(b.at.getHours()) + ':' + two(b.at.getMinutes()) : '';
        return '<div class="lg lg-' + b.tag + '"><div class="lgh">' + LOG_LABEL[b.tag] + (when ? ' <span class="lt">' + when + '</span>' : '') + '</div>' + b.lines.join('\\n') + '</div>';
      }).join('');
    };
    document.querySelectorAll('#logbar button').forEach(function(btn){
      btn.addEventListener('click', function(){
        var hide = (document.getElementById('logtext').getAttribute('data-hide') || '').split(' ').filter(Boolean), t = btn.dataset.tag, i = hide.indexOf(t);
        if (i < 0) hide.push(t); else hide.splice(i, 1);
        document.getElementById('logtext').setAttribute('data-hide', hide.join(' '));
        btn.classList.toggle('off', i < 0);
      });
    });

    var loadLog = function(){
      fetch('/api/log')
        .then(function(r){ return r.json(); })
        .then(function(d){
          logstatus.textContent = d.running ? '\\u00b7 scanning: ' + d.mode : '\\u00b7 idle';
          if (d.text === lastLog) return;
          // Follow the end if you were already at it (or have only just arrived).
          var atEnd = lastLog === null || window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 80;
          lastLog = d.text;
          logtext.innerHTML = logHtml(d.text);
          if (atEnd) window.scrollTo(0, document.documentElement.scrollHeight);
        })
        .catch(function(){ logstatus.textContent = '\\u00b7 cannot reach the app'; });
    };

    window.addEventListener('hashchange', function(){
      if (document.body.dataset.tab === 'log') { lastLog = null; loadLog(); }
    });
    setInterval(function(){ if (!document.hidden && document.body.dataset.tab === 'log') loadLog(); }, 2000);
    // The scanner's state changes under you (a scan starts, finishes, goes offline).
    setInterval(function(){ if (!document.hidden) loadApp(); }, 5000);
    // The wait lifts, or a run finishes, without anyone touching the page.
    setInterval(function(){ if (!document.hidden) loadJudging(); }, 15000);

    var refreshAll = function(){ loadApps(); loadRej(); syncQueue(); loadApp(); loadJudging(); };

    // First look. (Defined above the earlier loads' position, so they are made here.)
    loadApp();
    loadJudging();
    if (document.body.dataset.tab === 'log') loadLog();

    window.__refresh = function(){ refreshAll(); };
    document.addEventListener('visibilitychange', function(){ if (!document.hidden) refreshAll(); });
    window.addEventListener('focus', refreshAll);
    setInterval(function(){ if (!document.hidden) refreshAll(); }, 20000);

    /* Restore means "I changed my mind", which is Interested rather than merely
       open: a pick is never retired by a gate or aged out of the queue, so a job
       you pulled back cannot quietly vanish again at the next scan. */
    document.addEventListener('click', function(ev){
      var b = ev.target.closest('.restore');
      if (!b) return;
      b.disabled = true;
      fetch('/api/mark', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: b.dataset.id, status: 'interested' }) })
        .then(function(r){ return r.json(); })
        .then(function(res){
          if (!res.ok) { b.textContent = 'failed'; b.disabled = false; return; }
          refreshAll();
        })
        .catch(function(){ b.textContent = 'failed'; b.disabled = false; });
    });

    document.addEventListener('click', function(ev){
      var btn = ev.target.closest('.tailor');
      if (!btn) return;
      var old = btn.textContent;
      btn.disabled = true;
      btn.textContent = 'writing… (~30s)';
      fetch('/api/apply', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: btn.dataset.id }) })
        .then(function(r){ return r.json(); })
        .then(function(res){
          if (res.error) { btn.textContent = res.error.slice(0, 60); return; }
          btn.textContent = res.cached ? 'already written' : (res.blocked ? 'draft only — ' + res.blocked + ' unverified' : 'written ✓');
          btn.classList.add('done');
          fetch('/api/applications').then(function(r){ return r.json(); }).then(paintApps);
        })
        .catch(function(e){ btn.textContent = 'failed'; })
        .finally(function(){ setTimeout(function(){ btn.disabled = false; }, 500); });
    });

    document.addEventListener('change', function(ev){
      var sel = ev.target.closest('.app-outcome');
      if (!sel || !sel.value) return;
      fetch('/api/applications', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ folder: sel.dataset.folder, outcome: sel.value }) })
        .then(function(r){ return r.json(); })
        .then(function(res){ if (res.applications) paintApps({ applications: res.applications, outcomes: [].slice.call(sel.options).slice(1).map(function(o){ return o.value; }) }); })
        .catch(function(){});
    });

    /* ---- what you rewrote ---- */
    var fbbox = document.getElementById('fbbox'), fblist = document.getElementById('fblist'),
        fbsum = document.getElementById('fbsum');

    var paintFeedback = function(d){
      if (!d.pairs || !d.pairs.length) { fbbox.hidden = true; return; }
      fbbox.hidden = false;
      var active = (d.notes && d.notes.rules || []).filter(function(r){ return r.active; }).length;
      fbsum.textContent = 'What you rewrote — ' + d.pairs.length + ' paragraph(s)'
        + (active ? ', ' + active + ' rule(s) active' : '');

      fblist.innerHTML = d.pairs.map(function(x, i){
        return '<div class="fb" data-i="' + i + '">'
          + '<div class="dim small">' + x.folder + '</div>'
          + '<div class="fb-gen">' + esc(x.generated) + '</div>'
          + '<div class="fb-you">' + esc(x.yours) + '</div>'
          + '<div class="fb-acts">'
          + '<button class="mark" data-fb="style">style rule</button>'
          + '<button class="mark" data-fb="oneoff">one-off</button>'
          + '<button class="mark" data-fb="ignore">ignore</button>'
          + '</div></div>';
      }).join('');
      window.__fbPairs = d.pairs;
    };
    /* There was a second esc() here — \`var escText = function(s)\`, escaping only
       & < > and NOT quotes. It sat inside \`if (live) {\`, which is a BLOCK, so
       var hoisted it to the enclosing function scope and it overwrote the
       five-character esc() defined above the moment this line ran.
       paintApps() runs later, inside a .then(), so it always got the weak one.

       That mattered: the applications panel builds href attributes from
       applyUrl, which comes from scraped pages and from the "add a job you
       found elsewhere" form, where nothing validates the URL. A single " in it
       closes the attribute and injects markup into the page.

       Deleted rather than repaired. One definition, five characters. */

    fetch('/api/feedback').then(function(r){ return r.json(); }).then(paintFeedback).catch(function(){});

    document.addEventListener('click', function(ev){
      var b = ev.target.closest('[data-fb]');
      if (!b) return;
      var row = b.closest('.fb'), pair = (window.__fbPairs || [])[+row.dataset.i];
      if (!pair) return;
      b.disabled = true;
      fetch('/api/feedback', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ generated: pair.generated, yours: pair.yours, classification: b.dataset.fb }) })
        .then(function(r){ return r.json(); })
        .then(function(){ row.classList.add('fb-done'); })
        .catch(function(){ b.disabled = false; });
    });
  }

  /* ---- company watchlist ----
     Grouped by status so the gaps are the thing you see first. The alert
     checkbox is the only editable part; everything else is derived. */
  if (live) {
    var cobox = document.getElementById('cobox'),
        colist = document.getElementById('colist'),
        cosum = document.getElementById('cosum');

    var paintCompanies = function(d){
      cobox.hidden = false;
      cosum.textContent = 'Companies — ' + d.summary.covered + ' of ' + d.summary.total + ' actually tracked';

      var groups = {};
      d.companies.forEach(function(c){ (groups[c.status] = groups[c.status] || []).push(c); });

      colist.innerHTML = Object.keys(groups).map(function(status){
        var rows = groups[status].map(function(c){
          var facts = [
            c.boardJobs != null ? c.boardJobs + ' on board' : null,
            c.postingsSeen ? c.postingsSeen + ' seen' : null,
            c.platform || null
          ].filter(Boolean).join(' · ');
          // Only companies without a working board are worth an alert; ticking
          // one that already has an API would just add duplicate email noise.
          var canAlert = c.status !== 'api';
          return '<label class="co' + (d.statuses[status].ok ? ' co-ok' : '') + '">'
            + '<input type="checkbox" data-co="' + c.id + '"' + (c.alert ? ' checked' : '')
            + (canAlert ? '' : ' disabled') + ' title="'
            + (canAlert ? 'Tick once you have created an email alert on their careers page'
                        : 'Already covered by an API — an alert would only duplicate it') + '">'
            + '<span class="co-name">' + c.name + '</span>'
            + '<span class="co-facts">' + facts + '</span>'
            + (c.note ? '<span class="co-note" title="' + c.note.replace(/"/g, '&quot;') + '">?</span>' : '')
            + '</label>';
        }).join('');
        return '<div class="co-group"><h4>' + d.statuses[status].label
          + ' <span class="rej-n">' + groups[status].length + '</span></h4>' + rows + '</div>';
      }).join('');
    };

    if (cobox && colist) {
      fetch('/api/companies').then(function(r){ return r.json(); }).then(paintCompanies).catch(function(){});
    }

    document.addEventListener('change', function(ev){
      var cb = ev.target.closest('input[data-co]');
      if (!cb) return;
      var want = cb.checked;
      cb.disabled = true;
      fetch('/api/companies', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: cb.dataset.co, alert: want })
      })
        .then(function(r){ return r.json(); })
        .then(function(res){
          // Repaint rather than just ticking: recording an alert MOVES the
          // company between status groups, and leaving it in the old one would
          // misrepresent coverage.
          if (res.ok) paintCompanies(res.companies);
          else cb.checked = !want;
        })
        .catch(function(){ cb.checked = !want; })
        .finally(function(){ cb.disabled = false; });
    });
  }

  /* ---- add a job you found elsewhere ----
     Served only. From disk the panel stays hidden rather than offering a form
     that silently discards what you typed. */
  if (live) {
    var manbox = document.getElementById('manbox');
    var addBtn = document.getElementById('m-add');
    if (manbox && addBtn) {
      manbox.hidden = false;
      var say = document.getElementById('m-say');
      var val = function(id){ var el = document.getElementById(id); return el ? el.value.trim() : ''; };

      addBtn.addEventListener('click', function(){
        var body = {
          url: val('m-url'), title: val('m-title'), company: val('m-company'),
          location: val('m-location'), description: val('m-desc')
        };
        if (!body.title || !body.company) {
          say.textContent = 'A title and a company are needed \\u2014 the id is built from them.';
          return;
        }
        addBtn.disabled = true;
        say.textContent = 'Adding\\u2026';
        fetch('/api/manual', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        })
          .then(function(r){ return r.json(); })
          .then(function(d){
            if (d.error) { say.textContent = d.error; return; }
            // The id is the useful part of the answer: it is what the apply
            // command takes, and tailoring is usually what you want next.
            say.innerHTML = (d.existed ? 'Already knew that one \\u2014 ' : 'Added \\u2014 ')
              + '<code>npm run apply -- ' + d.id + '</code>'
              + (d.descriptionChars ? '' : ' \\u00b7 no advert text, so tailoring has nothing to read');
            ['m-url','m-title','m-company','m-location','m-desc'].forEach(function(id){
              var el = document.getElementById(id); if (el) el.value = '';
            });
            // It is open and interested, so it belongs in the queue above: fetch its
            // card now rather than leaving you to reload to see that it worked.
            if (window.__refresh) window.__refresh();
          })
          .catch(function(e){ say.textContent = 'Failed: ' + e.message; })
          .finally(function(){ addBtn.disabled = false; });
      });
    }
  }

  /* ---- source switches ----
     Only meaningful when served: writing config/sources.json needs the server.
     From disk the panel stays hidden rather than showing dead controls. */
  if (live) {
    var box = document.getElementById('srcbox'), list = document.getElementById('srclist');
    if (box && list) {
      fetch('/api/sources')
        .then(function(r){ return r.json(); })
        .then(function(rows){
          box.hidden = false;
          list.innerHTML = rows.map(function(s){
            // A source whose key is missing cannot run, so say which key rather
            // than letting the box be ticked to no effect. Names only, no values.
            var why = s.usable ? '' :
              '<span class="src-warn">needs ' + s.missingKeys.join(', ') + ' in .env</span>';
            return '<label class="src' + (s.usable ? '' : ' unusable') + '">'
              + '<input type="checkbox" data-src="' + s.id + '"'
              + (s.enabled ? ' checked' : '') + (s.usable ? '' : ' disabled') + '>'
              + '<span class="src-name">' + s.label + '</span>' + why
              + '</label>';
          }).join('');
        })
        .catch(function(){});
    }

    document.addEventListener('change', function(ev){
      var cb = ev.target.closest('input[data-src]');
      if (!cb) return;
      var want = cb.checked;
      cb.disabled = true;
      fetch('/api/sources', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: cb.dataset.src, enabled: want })
      })
        .then(function(r){ return r.json(); })
        .then(function(res){
          // Trust the server's answer over the click — if the write failed the
          // box must go back, or the page would lie about what is configured.
          if (!res.ok) { cb.checked = !want; return; }
          cb.closest('.src').classList.add('saved');
          setTimeout(function(){ cb.closest('.src').classList.remove('saved'); }, 900);
        })
        .catch(function(){ cb.checked = !want; })
        .finally(function(){ cb.disabled = false; });
    });
  }

  if (live) {
    fetch('/api/statuses')
      .then(function(r){ return r.json(); })
      .then(function(map){
        document.querySelectorAll('.marks').forEach(function(box){
          var s = map[box.dataset.id];
          if (s && s !== 'new' && s !== 'shown') paint(box, s);
        });
      })
      .catch(function(){});
  } else {
    var bar = document.querySelector('.toolbar');
    if (bar) {
      var n = document.createElement('span');
      n.className = 'static-note';
      n.textContent = 'Opened from disk — buttons copy a command. Run "npm run serve" to save directly.';
      bar.appendChild(n);
    }
  }

  /* Only Interested keeps a card in the queue. Applied, Not for me and hide all
     close the job, and each has a place that still shows it — the Applications
     panel, the Turned down list — so the card leaves instead of lingering greyed
     out. It is the same on load: a page written before you decided drops the
     cards you have since dealt with, so an older report does not show work you
     already did. */
  var LEAVES = { applied: 1, rejected: 1, hidden: 1 };

  function paint(box, status){
    box.querySelectorAll('.mark').forEach(function(b){
      b.classList.toggle('done', b.dataset.status === status);
    });
    var card = box.closest('.job');
    if (!card) return;
    if (LEAVES[status]) {
      card.classList.add('leaving');
      setTimeout(function(){
        card.classList.add('gone');
        if (window.__recount) window.__recount();
      }, 220);
      return;
    }
    card.classList.toggle('marked', status !== 'interested');
  }

  function askReason(box, id){
    var back = box.innerHTML;
    box.innerHTML = '<span class="why-lead">Why?</span>'
      + REASONS.map(function(pair){
          return '<button class="mark why" data-status="rejected" data-reason="' + pair[0] + '">' + pair[1] + '</button>';
        }).join('')
      + '<button class="mark why" data-cancel="1">cancel</button>';
    box.dataset.back = 'y';
    box._back = back;
  }

  /* What you asked for, at the moment you know it.

     Free text, not a picker: "95000", "90-100k" and "declined to state" are all
     real answers and none of them is on a list of options. Skip is a first-class
     button rather than a cancel, because the figure is optional and a form that
     blocks marking a job applied would just stop jobs being marked.

     The box opens with your usual figure already in it, from
     profile.salary.askingDefault, SELECTED rather than just filled: typing
     replaces it, so the default costs nothing on the postings where you asked
     for something else. It is set as a property rather than a value attribute
     so the text never has to be escaped into HTML.

     With nothing configured the box is empty, exactly as it was. A default that
     silently became the recorded answer would be worse than no default — the
     figure only matters because it is the one thing nothing else remembers. */
  function askSalary(box, id){
    var back = box.innerHTML;
    box.innerHTML = '<span class="why-lead">Asked for?</span>'
      + '<input class="salary-in" type="text" autocomplete="off" spellcheck="false" placeholder="what you asked for">'
      + '<button class="mark why" data-status="applied" data-salary="1">save</button>'
      + '<button class="mark why" data-status="applied" data-salary="1" data-skip="1">skip</button>'
      + '<button class="mark why" data-cancel="1">cancel</button>';
    box.dataset.back = 'y';
    box._back = back;
    var input = box.querySelector('.salary-in');
    input.value = (window.__SETTINGS__ && window.__SETTINGS__.salaryDefault) || '';
    input.focus();
    input.select();
    input.addEventListener('keydown', function(ev){
      if (ev.key === 'Enter') { ev.preventDefault(); box.querySelector('[data-salary]').click(); }
      if (ev.key === 'Escape') { box.innerHTML = box._back; }
    });
  }

  document.addEventListener('click', function(ev){
    var cancel = ev.target.closest('[data-cancel]');
    if (cancel) { var b = cancel.closest('.marks'); b.innerHTML = b._back; return; }
    var btn = ev.target.closest('.mark');
    if (!btn) return;
    var box = btn.closest('.marks');
    var id = box.dataset.id, status = btn.dataset.status;

    if (!live) {
      var cmd = 'npm run mark -- ' + id + ' ' + status + (status === 'applied' ? ' "<salary asked>"' : '');
      navigator.clipboard && navigator.clipboard.writeText(cmd);
      var old = btn.textContent;
      btn.textContent = 'copied';
      btn.classList.add('copied');
      setTimeout(function(){ btn.textContent = old; btn.classList.remove('copied'); }, 1400);
      return;
    }

    // "Not for me" asks WHY first. The answer is what makes it possible to
    // ask later whether the gates are wrong, instead of guessing from the
    // postings — which was wrong: of 34 rejections, 19 never mentioned the
    // reason they were assumed to have been rejected for.
    if (status === 'rejected' && !btn.dataset.reason) { askReason(box, id); return; }

    // And "Applied" asks what you put in the salary box. That figure goes into
    // the employer's form and then exists nowhere else — not in the advert, not
    // in the CV, not in the letter — and it is the number the offer gets
    // compared against months later.
    if (status === 'applied' && !btn.dataset.salary) { askSalary(box, id); return; }

    var salaryInput = box.querySelector('.salary-in');
    var salary = salaryInput && !btn.dataset.skip ? salaryInput.value.trim() : '';

    btn.disabled = true;
    fetch('/api/mark', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: id, status: status, reason: btn.dataset.reason || null, salary: salary || null })
    })
      .then(function(r){ return r.json(); })
      .then(function(res){
        if (res.ok) {
          paint(box, status);
          if (window.__refresh) window.__refresh(status);
        } else { btn.textContent = 'failed'; }
      })
      .catch(function(){ btn.textContent = 'failed'; })
      .finally(function(){ btn.disabled = false; });
  });
})();
`;

/**
 * The rejection page's own script — two buttons, and nothing else.
 *
 * It first ran the report's whole script, which assumes the report: a filter bar, a
 * queue, a tab router. On this page those elements do not exist, so one IIFE threw
 * on a null and the queue sync logged a failure for a list it has no business
 * fetching. Both buttons here are the only things on the page that do anything, and
 * the "Mark all reviewed" handler lives ONLY here now — the rows it acts on are not
 * in the report any more.
 */
const REJ_JS = `
(function(){
  var live = location.protocol === 'http:' || location.protocol === 'https:';

  /* ---- clearing a reviewed gate ----
     Same live/static split as marking. The group is struck through rather than
     removed, so you can see what you just did and undo it if you mis-clicked;
     it is gone for real on the next report. */
  document.addEventListener('click', function(ev){
    var btn = ev.target.closest('.rej-clear');
    if (!btn) return;
    var cat = btn.dataset.cat, group = btn.closest('.rej-group');

    if (!live) {
      var cmd = 'npm run reviewed -- ' + cat;
      navigator.clipboard && navigator.clipboard.writeText(cmd);
      var old = btn.textContent;
      btn.textContent = 'copied: ' + cmd;
      btn.classList.add('copied');
      setTimeout(function(){ btn.textContent = old; btn.classList.remove('copied'); }, 2200);
      return;
    }

    var undo = group.classList.contains('cleared');
    btn.disabled = true;
    fetch('/api/review', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ category: cat, undo: undo })
    })
      .then(function(r){ return r.json(); })
      .then(function(res){
        if (!res.ok) { btn.textContent = 'failed'; return; }
        group.classList.toggle('cleared', !undo);
        group.open = undo;
        btn.textContent = undo
          ? 'Mark all ' + btn.dataset.n + ' reviewed'
          : 'Reviewed \\u2713 — click to undo';
      })
      .catch(function(){ btn.textContent = 'failed'; })
      .finally(function(){ btn.disabled = false; });
  });

  /* ---- Want it ----
     Pulls one posting out of the rejections: it moves to the top of the report and
     the rules stop dropping it. The same endpoint the report's own marks use. */
  document.addEventListener('click', function(ev){
    var btn = ev.target.closest('.rej-marks .mark');
    if (!btn) return;
    var id = btn.closest('.marks').dataset.id, status = btn.dataset.status;

    if (!live) {
      var cmd = 'npm run mark -- ' + id + ' ' + status;
      navigator.clipboard && navigator.clipboard.writeText(cmd);
      var old = btn.textContent;
      btn.textContent = 'copied';
      btn.classList.add('copied');
      setTimeout(function(){ btn.textContent = old; btn.classList.remove('copied'); }, 1400);
      return;
    }

    btn.disabled = true;
    fetch('/api/mark', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: id, status: status })
    })
      .then(function(r){ return r.json(); })
      .then(function(res){
        if (res.ok) { btn.classList.add('done'); btn.textContent = 'In your queue \\u2713'; }
        else { btn.textContent = 'failed'; btn.disabled = false; }
      })
      .catch(function(){ btn.textContent = 'failed'; btn.disabled = false; });
  });
})();
`;

