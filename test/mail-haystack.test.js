/**
 * haystack.cv alerts: real jobs, no parser, so 2 mails in 30 days were read by nobody.
 *
 * Five cards an email with the employer named, and every link a haystack.cv/go redirect, so the
 * identity has to come from the link's own `j=` uuid — the query string changes per email and
 * normaliseSourceId() strips it, which would collapse every card to one id.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { __testables } from '../src/sources/mailalerts.js';

const { extractJobs, pickParser } = __testables;

// Shaped from a real digest; the tokens are made up.
const TEXT = `Including Instaffo GmbH. Apply before others do.

5 NEW JOBS MATCHING YOUR SEARCH

🔥 23 hours agoTechnology
DevOps Cloud-Applikation (m/w/d) #60344

🏢 Instaffo GmbH

📍 Berlin, Germany 🇩🇪

Apply Now →
https://haystack.cv/go?j=8af07052-aaaa&s=searches-email&sub=x1&u=https%3A%2F%2Fclick.appcast.io%2Ft%2Fabc&t=DevOps%20Cloud-Applikation%20(m%2Fw%2Fd)%20%2360344&c=Instaffo%20GmbH

Technology
Digital Data Platform Engineer (m/w/d)

🏢 Dortmunder Energie- und Wasserversorgung GmbH DEW21

📍 Dortmund, Germany 🇩🇪

Apply Now →
https://haystack.cv/go?j=b5ea7552-bbbb&s=searches-email&sub=x1&u=https%3A%2F%2Fwww.jobg8.com%2FTraffic.aspx%3Fabc&t=Digital%20Data%20Platform%20Engineer%20(m%2Fw%2Fd)&c=Dortmunder%20Energie-%20und%20Wasserversorgung%20GmbH%20DEW21

Browse All Jobs https://haystack.cv/jobs?src=searches-email
`;

test('a haystack.cv sender has a parser', () => {
  assert.equal(pickParser('alerts@alerts.haystack.cv')?.id, 'haystack');
});

test('each card gives title, employer and city, without the board reference number', () => {
  const jobs = extractJobs(pickParser('alerts@alerts.haystack.cv'), { text: TEXT, subject: 's', date: '2026-10-07' });
  assert.equal(jobs.length, 2);
  assert.equal(jobs[0].title, 'DevOps Cloud-Applikation (m/w/d)');
  assert.equal(jobs[0].company, 'Instaffo GmbH');
  assert.equal(jobs[0].location, 'Berlin');
  assert.equal(jobs[1].company, 'Dortmunder Energie- und Wasserversorgung GmbH DEW21');
  assert.equal(jobs[1].location, 'Dortmund');
});

test('the id is the board\'s job uuid, so the same job in two emails is one posting', () => {
  const [a] = extractJobs(pickParser('alerts@alerts.haystack.cv'), { text: TEXT, subject: 's', date: 'd' });
  const [b] = extractJobs(pickParser('alerts@alerts.haystack.cv'), {
    text: TEXT.replace('sub=x1', 'sub=y2'), subject: 's', date: 'd',
  });
  assert.equal(a.sourceId, 'haystack:8af07052-aaaa');
  assert.equal(a.sourceId, b.sourceId);
});
