/**
 * Company coverage.
 *
 * The panel exists because configuration was being mistaken for coverage: three
 * local employers had boards recorded and looked tracked, while each served
 * exactly ONE posting. Status is therefore derived from evidence — board size
 * and postings actually archived — and these pin that derivation.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { evaluate, summarise, setAlert, STATUS, __testables } from '../src/watchlist.js';

const wl = (companies) => ({ companies });
const statusOf = (rows, id) => rows.find((r) => r.id === id).status;

test('a board serving real volume counts as tracked', () => {
  const rows = evaluate(wl([{ id: 'roche', name: 'Roche', board: { kind: 'workday', tenant: 'roche' } }]), {
    workday: [{ tenant: 'roche', jobs: 1196 }],
  });
  assert.equal(statusOf(rows, 'roche'), 'api');
});

test('a board serving one posting is a stub, not coverage', () => {
  // The measured case: Haufe, ZEISS and Lonza all recorded boards and all
  // served exactly 1. Calling that "tracked" is how the gap stayed invisible.
  const rows = evaluate(wl([{ id: 'haufe', name: 'Haufe Group', board: { ats: 'smartrecruiters', slug: 'haufegroup' } }]), {
    boards: [{ ats: 'smartrecruiters', slug: 'haufegroup', jobs: 1 }],
  });
  assert.equal(statusOf(rows, 'haufe'), 'stub');
  assert.equal(STATUS.stub.ok, false, 'a stub must not count towards coverage');
});

test('a configured board with no job count is broken, not tracked', () => {
  const rows = evaluate(wl([{ id: 'x', name: 'X', board: { ats: 'lever', slug: 'x' } }]), {
    boards: [{ ats: 'lever', slug: 'x' }],
  });
  assert.equal(statusOf(rows, 'x'), 'broken');
});

test('an unsupported platform asks for an alert; recording one satisfies it', () => {
  const before = evaluate(wl([{ id: 'sick', name: 'SICK', platform: 'SuccessFactors', supported: false }]), {});
  assert.equal(statusOf(before, 'sick'), 'blocked');

  const list = wl([{ id: 'sick', name: 'SICK', platform: 'SuccessFactors', supported: false }]);
  setAlert(list, 'sick', true);
  assert.equal(statusOf(evaluate(list, {}), 'sick'), 'alert');
});

test('a company nothing is known about is not silently "fine"', () => {
  const rows = evaluate(wl([{ id: 'testo', name: 'Testo' }]), {});
  assert.equal(statusOf(rows, 'testo'), 'unknown');
  assert.equal(STATUS.unknown.ok, false);
});

test('postings are counted despite name variation', () => {
  const { matches } = __testables;
  const entry = { name: 'Roche', aliases: ['F. Hoffmann-La Roche'] };
  assert.ok(matches('F. Hoffmann-La Roche AG', entry));
  assert.ok(matches('Roche Diagnostics GmbH', entry));
  assert.ok(!matches('Rocket Internet', entry), 'must not match on a shared prefix');
});

test('the summary counts only genuine coverage', () => {
  const rows = evaluate(wl([
    { id: 'a', name: 'A', board: { ats: 'lever', slug: 'a' } },
    { id: 'b', name: 'B', board: { ats: 'lever', slug: 'b' } },
    { id: 'c', name: 'C', platform: 'SuccessFactors', supported: false, alert: true },
    { id: 'd', name: 'D', platform: 'SuccessFactors', supported: false },
  ]), { boards: [{ ats: 'lever', slug: 'a', jobs: 400 }, { ats: 'lever', slug: 'b', jobs: 1 }] });

  const s = summarise(rows);
  assert.equal(s.total, 4);
  assert.equal(s.covered, 2, 'the stub and the un-alerted company do not count');
});

test('gaps sort above working coverage', () => {
  // You should see what is missing without scrolling past what is fine.
  const rows = evaluate(wl([
    { id: 'good', name: 'Good', board: { ats: 'lever', slug: 'g' } },
    { id: 'gap', name: 'Gap', platform: 'SuccessFactors', supported: false },
  ]), { boards: [{ ats: 'lever', slug: 'g', jobs: 300 }] });

  assert.ok(STATUS[rows[0].status].rank < STATUS[rows[1].status].rank);
});

test('setAlert refuses an id it does not know', () => {
  const list = wl([{ id: 'a', name: 'A' }]);
  assert.equal(setAlert(list, 'nope', true).ok, false);
});

test('a sitemap deployment counts as covered only while careersites.js actually reads it', () => {
  const entry = { id: 'sick', name: 'SICK', board: { kind: 'careersite', site: 'sick' } };
  assert.equal(evaluate(wl([entry]), { careersites: ['sick'] })[0].status, 'api');
  // Removed from SITES, the entry must fall back to "not investigated" rather
  // than keep claiming coverage nothing provides.
  assert.equal(evaluate(wl([entry]), { careersites: [] })[0].status, 'unknown');
});

test('a Beesite employer counts as covered only while its board is configured and enabled', () => {
  const entry = { id: 'markant', name: 'Markant', board: { kind: 'beesite', slug: 'markant' } };
  assert.equal(evaluate(wl([entry]), { beesite: [{ slug: 'markant' }] })[0].status, 'api');
  assert.equal(evaluate(wl([entry]), { beesite: [{ slug: 'markant', enabled: false }] })[0].status, 'unknown');
  assert.equal(evaluate(wl([entry]), {})[0].status, 'unknown');
});
