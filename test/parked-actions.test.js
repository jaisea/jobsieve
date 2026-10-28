/**
 * A posting parked for want of its advert can be dealt with by hand: paste the text
 * and it joins the queue like a job you typed in, or turn it down. Either way it
 * leaves the parked list, which would otherwise keep saying it waits for text.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PORT = 8911;

test('pasting an advert adds a parked posting; rejecting turns one down; both leave the list', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'jobhunt-parked-'));
  mkdirSync(join(dir, 'data'));
  const fp = (c) => c.repeat(40);
  const entry = (c, title) => ({ fingerprint: fp(c), title, company: 'Beispiel GmbH', location: 'München',
    applyUrl: `https://jobs.example.com/${c}`, source: 'linkedin', reason: 'HTTP 429', attempts: 2,
    firstParked: new Date().toISOString(), lastParked: new Date().toISOString() });
  writeFileSync(join(dir, 'data', 'parked.json'), JSON.stringify({ version: 1, parked: {
    [fp('a')]: entry('a', 'Senior DevOps Engineer'), [fp('b')]: entry('b', 'Platform Engineer'),
  } }));

  // The server reads config/profile.json, which a fresh clone does not have;
  // JOBHUNT_PROFILE points it at the example instead, so nothing in config/ is touched.

  const child = spawn(process.execPath, ['src/index.js', 'serve', '--port', String(PORT), '--no-open'], {
    cwd: ROOT, stdio: 'ignore',
    env: { ...process.env, JOBHUNT_DATA_DIR: join(dir, 'data'), JOBHUNT_REPORTS_DIR: join(dir, 'reports'), JOBHUNT_NO_LOGFILE: '1', JOBHUNT_PROFILE: join(ROOT, 'config', 'examples', 'devops.profile.json') },
  });
  t.after(() => child.kill());

  const base = `http://127.0.0.1:${PORT}`;
  for (let i = 0; i < 50; i++) {
    try { await fetch(`${base}/api/judging`); break; } catch { await new Promise((r) => setTimeout(r, 200)); }
  }
  const post = (body) => fetch(`${base}/api/parked`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify(body) }).then((r) => r.json());

  assert.match((await post({ id: 'aaaaaaaa', action: 'add' })).error, /paste the advert/, 'adding needs the text');

  const added = await post({ id: 'aaaaaaaa', action: 'add', description: 'Kubernetes, Terraform und Azure. '.repeat(10) });
  assert.equal(added.ok, true, JSON.stringify(added));
  const rejected = await post({ id: 'bbbbbbbb', action: 'reject', reason: 'role' });
  assert.equal(rejected.ok, true);

  const read = (f) => JSON.parse(readFileSync(join(dir, 'data', f), 'utf8'));
  assert.deepEqual(Object.keys(read('parked.json').parked), [], 'both are off the parked list');
  const seen = read('seen.json');
  assert.equal(seen[Object.keys(seen).find((k) => k.startsWith(added.id))].status, 'interested');
  const turned = seen[Object.keys(seen).find((k) => k.startsWith(rejected.id))];
  assert.equal(turned.status, 'rejected');
  assert.equal(turned.rejectedReason, 'role');
  assert.equal(turned.addedByHand, undefined, 'a rejection is not labelled as typed in');
});
