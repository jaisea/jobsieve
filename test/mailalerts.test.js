/**
 * Job-alert email parsing.
 *
 * These emails are the only route to LinkedIn, StepStone and XING, so the
 * extraction has to survive their marketing HTML: tracking-wrapped links,
 * "View job" buttons with no title, image anchors, and footer/unsubscribe
 * links that must never be mistaken for jobs.
 *
 * The fixtures below mirror the real structures — tracking query strings,
 * nested tables, entity-encoded ampersands — rather than idealised markup.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { readFileSync } from 'node:fs';

import { p } from '../src/util.js';
import { __testables } from '../src/sources/mailalerts.js';

const { extractJobs, pickParser } = __testables;

const parse = (from, html, text = '') => {
  const parser = pickParser(from);
  assert.ok(parser, `no parser matched sender ${from}`);
  return extractJobs(parser, { html, text, subject: 'Job alert', date: '2026-08-14T00:00:00Z' });
};

/* ------------------------------------------------------------------ senders */

test('senders route to the right parser', () => {
  assert.equal(pickParser('jobalerts-noreply@linkedin.com').id, 'linkedin');
  assert.equal(pickParser('noreply@stepstone.de').id, 'stepstone');
  assert.equal(pickParser('jobs@xing.com').id, 'xing');
  assert.equal(pickParser('alert@indeed.com').id, 'indeed');
  assert.equal(pickParser('newsletter@example.com'), undefined);
});

/* ----------------------------------------------------------------- LinkedIn */

test('LinkedIn alert: titles and permalinks are extracted', () => {
  const html = `
    <table><tr><td>
      <a href="https://www.linkedin.com/comm/jobs/view/4051234567?trk=eml-jobs_alert&amp;lipi=abc">
        Senior DevOps Engineer (m/w/d)
      </a>
      <p>DIS AG · München, Baden-Württemberg</p>
      <a href="https://www.linkedin.com/comm/jobs/view/4059876543?trk=eml">Platform Engineer</a>
      <a href="https://www.linkedin.com/comm/jobs/view/4051234567?trk=other">View job</a>
      <a href="https://www.linkedin.com/psettings/email">Unsubscribe</a>
    </td></tr></table>`;

  const jobs = parse('jobalerts-noreply@linkedin.com', html);
  assert.equal(jobs.length, 2, 'two real jobs, ignoring the button and unsubscribe link');
  assert.equal(jobs[0].title, 'Senior DevOps Engineer (m/w/d)');
  assert.match(jobs[0].applyUrl, /jobs\/view\/4051234567/);
  assert.equal(jobs[1].title, 'Platform Engineer');
});

test('the same job linked twice appears once', () => {
  // Alert emails link the same posting from the title and a "View" button.
  const html = `
    <a href="https://www.linkedin.com/comm/jobs/view/999?trk=a">Cloud Engineer</a>
    <a href="https://www.linkedin.com/comm/jobs/view/999?trk=b">Cloud Engineer</a>`;
  assert.equal(parse('jobalerts-noreply@linkedin.com', html).length, 1);
});

test('unsubscribe and settings links are never treated as jobs', () => {
  const html = `
    <a href="https://www.linkedin.com/psettings/email-preferences">Manage alerts</a>
    <a href="https://www.linkedin.com/help">Help Center</a>`;
  assert.equal(parse('jobalerts-noreply@linkedin.com', html).length, 0);
});

/* ---------------------------------------------------------------- StepStone */

test('StepStone alert: job links are extracted', () => {
  const html = `
    <a href="https://www.stepstone.de/stellenangebote--Cloud-Engineer-München-Acme-GmbH--9876543-inline.html?rltr=1">
      Cloud Engineer (m/w/d)
    </a>
    <a href="https://www.stepstone.de/abmelden">Newsletter abbestellen</a>`;

  const jobs = parse('noreply@stepstone.de', html);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].title, 'Cloud Engineer (m/w/d)');
  assert.equal(jobs[0].sourceLabel, 'StepStone alert');
});

/* --------------------------------------------------------------------- XING */

test('XING alert: job links are extracted', () => {
  const html = `<a href="https://www.xing.com/jobs/muenchen-devops-engineer-123456?ijt=abc">
    DevOps Engineer</a>`;
  const jobs = parse('jobs@xing.com', html);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].sourceLabel, 'XING alert');
});

/* ------------------------------------------------------- company + location */

test('company and location are read from the plain-text part when present', () => {
  const html = `<a href="https://www.linkedin.com/comm/jobs/view/777">Site Reliability Engineer</a>`;
  const text = 'Site Reliability Engineer\nJedox\nMünchen, Germany\n';
  const [job] = parse('jobalerts-noreply@linkedin.com', html, text);
  assert.equal(job.company, 'Jedox');
  assert.equal(job.location, 'München, Germany');
});

test('a missing company or location is left empty, never guessed', () => {
  // The pipeline treats an unresolved location as *uncertain* and escalates it.
  // A wrong guess here would turn into a wrong certain-drop downstream.
  const html = `<a href="https://www.linkedin.com/comm/jobs/view/888">Kubernetes Engineer</a>`;
  const [job] = parse('jobalerts-noreply@linkedin.com', html);
  assert.equal(job.location, '');
});

/* ------------------------------------------------------------------- shapes */

test('extracted jobs carry the fields the pipeline requires', () => {
  const html = `<a href="https://www.linkedin.com/comm/jobs/view/555">Cloud Architect</a>`;
  const [job] = parse('jobalerts-noreply@linkedin.com', html);
  for (const f of ['source', 'sourceId', 'title', 'company', 'applyUrl']) {
    assert.ok(job[f], `missing required field: ${f}`);
  }
  assert.equal(job.source, 'mailalerts');
});

test('tracking parameters are stripped from the dedupe key but kept in the link', () => {
  const html = `<a href="https://www.linkedin.com/comm/jobs/view/321?trk=eml&amp;x=1">Linux Engineer</a>`;
  const [job] = parse('jobalerts-noreply@linkedin.com', html);
  assert.ok(!job.sourceId.includes('?'), 'sourceId must be stable across emails');
  assert.ok(job.applyUrl.includes('trk='), 'the clickable link keeps its parameters');
});

/* ------------------------------------------- senders nobody wrote a parser for */

/**
 * More job sites get added to the alerts over time. Four senders are understood —
 * LinkedIn, StepStone, XING, Indeed — and everything else used to be dropped
 * with a bare `continue` and no message at all.
 *
 * That is the one thing this project says a source must never do. The user would
 * have set up an alert on a fifth site, pointed it at the same folder, and watched a
 * run that looked completely normal while reading none of it.
 */

test('an email from a sender with no parser is counted, not dropped in silence', () => {
  const src = readFileSync(p('src', 'sources', 'mailalerts.js'), 'utf8');

  assert.ok(!/if \(!parser\) continue;/.test(src),
    'the silent skip must be gone');
  assert.match(src, /unknown\.set\(domain/, 'unknown senders are counted by domain');
  assert.match(src, /were not read — no parser for that sender/,
    'and reported in the run summary');
});

test('the warning names the domain and what to do about it', () => {
  // A bare count reads as noise. The domain is what tells the user whether it was an
  // alert set up on purpose, and the file name is where the fix goes.
  const src = readFileSync(p('src', 'sources', 'mailalerts.js'), 'utf8');
  const line = src.slice(src.indexOf('were not read'), src.indexOf('were not read') + 220);
  assert.match(line, /src\/sources\/mailalerts\.js/);
});

test('a sender that does have a parser is not reported as unknown', () => {
  // The counter must sit behind the parser lookup, or every LinkedIn alert
  // would be listed as unreadable.
  for (const from of ['jobalerts-noreply@linkedin.com', 'noreply@stepstone.de',
    'jobs@mail.xing.com', 'alert@indeed.com']) {
    assert.ok(pickParser(from), from);
  }
  for (const from of ['alerts@glassdoor.com', 'noreply@monster.de', 'jobs@honeypot.io', '']) {
    assert.ok(!pickParser(from), `${from} has no parser — it must be reported`);
  }
});

/* ------------------------------------------- an employer's own alert (jobs2web) */

/**
 * The first sender the "could not read" warning caught, one run after it was
 * added. jobs2web is the SuccessFactors career-site mailer, so one parser covers
 * every employer using it rather than one per company — Endress+Hauser is the
 * first, and it is an employer already on the watchlist.
 *
 * It needs more than a link pattern. A job board puts the title in the anchor
 * and the company on the line below; an employer's own alert puts the title AND
 * the location in the anchor, and the company only in the subject line.
 */
const J2W_HTML = `<html><body>
  <p>Here is your weekly update of available jobs at Endress+Hauser Group.</p>
  <a href="http://careers.endress.com/Germany/job/München-SAP-BTP-Engineer-Solution-Delivery-%28fmd%29-79100/136925">
    SAP BTP Engineer - Solution Delivery (f/m/d) - München, DE, 79100</a>
  <a href="https://career5.successfactors.eu/careers?site=&company=endress">Manage your Job Alerts</a>
  <a href="https://www.linkedin.com/company/endress-hauser-group">Follow us</a>
</body></html>`;

test('an employer alert routes to the jobs2web parser', () => {
  const p = pickParser('endress-jobnotification@noreply12.jobs2web.com');
  assert.equal(p?.id, 'jobs2web');
});

test('the job link is extracted and the careers-portal links are not', () => {
  const jobs = extractJobs(pickParser('x@noreply12.jobs2web.com'),
    { html: J2W_HTML, text: '', subject: 'Career Opportunities at Endress+Hauser Group', date: null });

  assert.equal(jobs.length, 1, 'the "Manage your Job Alerts" and social links must not count');
  assert.match(jobs[0].applyUrl, /careers\.endress\.com/);
});

test('the location is split off the title, and the company read from the subject', () => {
  const [job] = extractJobs(pickParser('x@noreply12.jobs2web.com'),
    { html: J2W_HTML, text: '', subject: 'Career Opportunities at Endress+Hauser Group', date: null });

  assert.equal(job.title, 'SAP BTP Engineer - Solution Delivery (f/m/d)');
  assert.equal(job.location, 'München, DE', 'and the postcode is dropped');
  assert.equal(job.company, 'Endress+Hauser Group');
});

test('a hyphen inside the title is not mistaken for a location', () => {
  // The split anchors on the country code for exactly this reason. Matching the
  // first " - " instead of the last turned "SAP BTP Engineer - Solution
  // Delivery (f/m/d) - München, DE" into a job called "SAP BTP Engineer" in a
  // place called "Solution Delivery (f/m/d) - München, DE".
  const p = pickParser('x@noreply12.jobs2web.com');
  const j = { title: 'Senior SRE - Multi-Cloud - Munich, DE, 80331' };
  p.refine(j, { subject: 'Career Opportunities at Some GmbH' });
  assert.equal(j.title, 'Senior SRE - Multi-Cloud');
  assert.equal(j.location, 'Munich, DE');
});

test('a title with no location is left alone', () => {
  const p = pickParser('x@noreply12.jobs2web.com');
  const j = { title: 'DevOps Engineer (m/w/d)' };
  p.refine(j, { subject: 'Career Opportunities at Testo SE' });
  assert.equal(j.title, 'DevOps Engineer (m/w/d)', 'never invent a split');
  assert.ok(!j.location);
});

/* ------------------------------------------ senders we looked at and cannot use */

test('a sender known to be unusable is skipped with a reason, not warned about', () => {
  // A warning that fires every run about mail which will never hold a job is a
  // warning one learns to ignore — and then the next genuinely new sender
  // scrolls past unnoticed.
  const src = readFileSync(p('src', 'sources', 'mailalerts.js'), 'utf8');
  assert.match(src, /const IGNORED = \[/);
  assert.match(src, /instaffo/i);
  assert.match(src, /skipped — \${why}/, 'and the reason is printed, not just the count');
});

test('Instaffo is on the ignore list rather than parsed badly', () => {
  // Every link goes through trk.instaffo.com/ls/click?upn=<opaque>, so there is
  // no permalink to read. A parser here would file tracking redirects as jobs.
  assert.ok(!pickParser('notifications@app.instaffo.com'));
});

/* ------------------------------------- alerts read from the plain-text part */

/**
 * Two senders the "could not read" warning caught, and neither fits the anchor
 * walk that the four job boards use.
 *
 * **Arbeitsagentur** matters most. Its REST API returned HTTP 403 at the
 * time, so the source skipped on every run — and CLAUDE.md called it the best
 * regional coverage in Germany. The email alert delivers the
 * same postings. Its HTML *does* carry permalinks, but the anchor text is
 * numbered by position in that day's email — "1. Sales Manager", "2.
 * IT-Workplace" — and the fingerprint is built from the title, so the same
 * posting at a different position tomorrow would be filed as a new job. That is
 * the identity drift the store fix exists to prevent, arriving from a new
 * direction.
 *
 * **eFinancialCareers** routes every HTML link through post.spmailtechnolo.com,
 * so the anchors are tracking redirects. Its text part carries the real URLs and
 * more besides — company, location, work mode.
 */

const AA_TEXT = [
  'Guten Tag,',
  '',
  'zu Ihrer gespeicherten Stellensuche "cloud in 79106 München" liegen 4 neue vor',
  '',
  'Sales Manager PLM Software (w/m/d)',
  'Bechtle AG',
  'Vöhringen, Württemberg (70 km)',
  'Vollzeit',
  '',
  'https://www.arbeitsagentur.de/jobsuche/jobdetail/15086-44410574-831-S',
  '',
  'IT-Workplace & Security Administrator (m/w/d)',
  'Schöck Bauteile GmbH',
  'Baden-Baden (84 km)',
  'Vollzeit',
  'Unbefristet',
  '',
  '50.000 € – 65.000 €/Jahr',
  '',
  'https://www.arbeitsagentur.de/jobsuche/jobdetail/10001-1003627521-S',
].join('\n');

const AA_HTML = `<html><body>
  <a href="https://www.arbeitsagentur.de/jobsuche/jobdetail/15086-44410574-831-S">1. Sales Manager PLM Software (w/m/d)</a>
  <a href="https://www.arbeitsagentur.de/jobsuche/suche?berufsfeld=IT">Alle Ergebnisse</a>
  <a href="https://rest.arbeitsagentur.de/jobboerse/jobsuche-service/ct/v1/suchauftrag/abbestellen?token=X">Abbestellen</a>
</body></html>`;

test('an Arbeitsagentur alert routes to its own parser', () => {
  assert.equal(pickParser('jobsuche@arbeitsagentur.de')?.id, 'arbeitsagentur');
});

test('the list number is not part of the job title', () => {
  // "1. Sales Manager" and "3. Sales Manager" are the same posting on two days.
  // Reading the HTML anchor would put the position into the fingerprint.
  const jobs = extractJobs(pickParser('jobsuche@arbeitsagentur.de'),
    { html: AA_HTML, text: AA_TEXT, subject: '', date: null });

  assert.equal(jobs[0].title, 'Sales Manager PLM Software (w/m/d)');
  assert.ok(!/^\d/.test(jobs[0].title), 'no leading position number');
});

test('the employer and place come from the text, not the parser label', () => {
  const jobs = extractJobs(pickParser('jobsuche@arbeitsagentur.de'),
    { html: AA_HTML, text: AA_TEXT, subject: '', date: null });

  assert.equal(jobs[0].company, 'Bechtle AG');
  assert.equal(jobs[0].location, 'Vöhringen, Württemberg', 'and the distance suffix is stripped');
  assert.equal(jobs[1].company, 'Schöck Bauteile GmbH');
  assert.equal(jobs[1].location, 'Baden-Baden');
});

test('the saved-search and unsubscribe links are not jobs', () => {
  const jobs = extractJobs(pickParser('jobsuche@arbeitsagentur.de'),
    { html: AA_HTML, text: AA_TEXT, subject: '', date: null });
  assert.equal(jobs.length, 2);
  for (const j of jobs) assert.match(j.applyUrl, /\/jobsuche\/jobdetail\//);
});

/* --------------------------------------------------------- eFinancialCareers */

const EFC_TEXT = [
  'eFinancialCareers',
  '',
  'Empfohlen basierend auf Ihren Aktivitäten',
  '',
  'DevOps Engineer m/w/d',
  'PACE Mobility GmbH',
  'Karlsruhe, Germany',
  'Hybrid',
  'Competitive',
  '',
  'Jetzt bewerben: https://www.efinancialcareers.de/jobs-Deutschland-Karlsruhe-DevOps.id247?stlt=AAA',
  '',
  'Senior DevOps Engineer - Kubernetes@BareMetal (m/w/d) | Mittwald CM Service GmbH & Co. KG',
  'Espelkamp, Germany',
  '',
  'Home-Office',
  'Festanstellung',
  'Competitive',
  '',
  'Jetzt bewerben: https://www.efinancialcareers.de/jobs-Deutschland-Espelkamp-Senior.id999?stlt=BBB',
].join('\n');

const efc = () => extractJobs(pickParser('emails@efinancialcareers.de'),
  { html: '<a href="https://post.spmailtechnolo.com/f/a/xyz~~/AAA~/zzz">DevOps Engineer m/w/d</a>', text: EFC_TEXT, subject: '', date: null });

test('eFinancialCareers is read from the text, because its HTML has only redirects', () => {
  const jobs = efc();
  assert.equal(jobs.length, 2);
  for (const j of jobs) {
    assert.match(j.applyUrl, /efinancialcareers\.de/);
    assert.ok(!/spmailtechnolo/.test(j.applyUrl), 'never a tracking redirect');
  }
});

test('work mode, employment type and salary are not mistaken for a city', () => {
  // Positional reading filed "Festanstellung", "Home-Office" and "Hybrid" as
  // locations, which the gazetteer cannot resolve and the location gate then
  // has to guess about.
  const jobs = efc();
  assert.equal(jobs[0].location, 'Karlsruhe, Germany');
  assert.equal(jobs[1].location, 'Espelkamp, Germany');
});

test('a company inside the title is split out of it', () => {
  // eFinancialCareers writes "Senior DevOps Engineer (m/w/d) | Mittwald CM
  // Service" when there is no separate company line.
  const [, second] = efc();
  assert.equal(second.title, 'Senior DevOps Engineer - Kubernetes@BareMetal (m/w/d)');
  assert.equal(second.company, 'Mittwald CM Service GmbH & Co. KG');
});

test('the tracking query is dropped from the id, so two emails dedupe', () => {
  // stlt= changes on every send. Without stripping it the same posting is new
  // every day.
  const jobs = efc();
  for (const j of jobs) assert.ok(!/stlt=/.test(j.sourceId), j.sourceId);
});

test('a block with no title is skipped rather than half-read', () => {
  const jobs = extractJobs(pickParser('emails@efinancialcareers.de'),
    { html: '', text: 'Jetzt bewerben: https://www.efinancialcareers.de/jobs-x.id1', subject: '', date: null });
  assert.deepEqual(jobs, []);
});
