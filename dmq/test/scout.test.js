/**
 * Exercises the discovery process boundary: one discovery.request in on stdin,
 * one discovery.result out on stdout. Simulate mode, so no network and no
 * browser — the scout imports Playwright only for a real sweep.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCOUT = path.join(HERE, '..', 'bin', 'rqp-scout.js');

const request = (extra = {}) => ({
  protocol: 'RQP/1',
  kind: 'discovery.request',
  target: { site: 'ca-dmv', connector: 'dmv.ca.gov.qmatic', queue: 'vehicle-registration' },
  offices: ['Poway', 'El Cajon'],
  window: ['2026-10-01', '2026-11-30'],
  hours: ['08:00', '17:00'],
  timezone: 'America/Los_Angeles',
  ...extra,
});

function call(payload, env = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      process.execPath,
      [SCOUT],
      { env: { ...process.env, RQP_MODE: 'simulate', ...env } },
      (error, stdout) => {
        if (error && !stdout) return reject(error);
        try { resolve(JSON.parse(stdout.trim().split('\n').at(-1))); }
        catch (err) { reject(new Error(`${err.message}: ${stdout}`)); }
      },
    );
    child.stdin.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
  });
}

test('a sweep comes back as offers the matcher can place', async () => {
  const result = await call(request());
  assert.equal(result.protocol, 'RQP/1');
  assert.equal(result.kind, 'discovery.result');
  assert.equal(result.status, 'confirmed');
  assert.ok(result.offers.length >= 4);
  for (const offer of result.offers) {
    assert.ok(offer.office_code);
    assert.equal(typeof offer.office_lat, 'number');
    assert.match(offer.slot_date, /^\d{4}-\d{2}-\d{2}$/);
    assert.match(offer.slot_time, /^\d{2}:\d{2}$/);
  }
  assert.deepEqual(result.checked.map((c) => c.office), ['Poway', 'El Cajon']);
});

test('every office named is reported on, found or not', async () => {
  const result = await call(request({ offices: ['Poway', 'Atlantis'] }));
  const byOffice = Object.fromEntries(result.checked.map((c) => [c.office, c.found]));
  assert.ok(byOffice.Poway > 0);
  assert.equal(byOffice.Atlantis, 0);      // unplaceable, so no offers
  assert.ok(!result.offers.some((o) => o.office_name === 'Atlantis'));
});

test('a line that cannot be scouted is rejected, not retried forever', async () => {
  const result = await call(request({ target: { queue: 'drive-test-auto' } }));
  assert.equal(result.status, 'rejected');
  assert.equal(result.offers.length, 0);
  assert.match(result.message, /licence details/i);
});

test('a malformed request produces an envelope, never a crash', async () => {
  const result = await call('{not json');
  assert.equal(result.kind, 'discovery.result');
  assert.equal(result.status, 'rejected');
  assert.equal(result.offers.length, 0);
});

test('a request with no offices comes back empty rather than sweeping everything', async () => {
  const result = await call(request({ offices: [] }));
  assert.equal(result.offers.length, 0);
  assert.match(result.message, /names no offices/i);
});

test('the scout carries nothing it could book with', async () => {
  // It is handed no applicant and no contact details, so there is nothing for a
  // form to be filled in with. That is why discovery needs no second opt-in.
  const result = await call(request());
  const serialised = JSON.stringify(result);
  for (const leak of ['email', 'phone', 'licen', 'dl_number', 'first_name', 'applicant', 'personal_data']) {
    assert.ok(!serialised.toLowerCase().includes(leak), `discovery result mentions ${leak}`);
  }
  assert.equal(result.confirmation, undefined);
  // An offer describes a slot, never a person.
  for (const offer of result.offers) {
    assert.deepEqual(Object.keys(offer).sort(),
      ['office_code', 'office_lat', 'office_lng', 'office_name', 'slot_date', 'slot_time']);
  }
});

test('a scout whose app is gone stops, rather than read on for nobody', async () => {
  // The app starts the scout in a process group of its own, as the desktop app
  // does, and dies without stopping it — a crash, or being killed.
  const launcher = `
    const { spawn } = require('child_process');
    const child = spawn(process.execPath, [${JSON.stringify(SCOUT)}], {
      detached: true, stdio: ['pipe', 'ignore', 'ignore'],
      env: { ...process.env, RQP_MODE: 'simulate', RQP_SIMULATE_DELAY_MS: '30000' },
    });
    child.stdin.end(${JSON.stringify(JSON.stringify(request()))});
    console.log(child.pid);
    // Long enough for the scout to be under way, as it is when an app dies.
    setTimeout(() => process.exit(0), 2000);`;
  const pid = Number(execFileSync(process.execPath, ['-e', launcher], { encoding: 'utf8' }).trim());
  const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const deadline = Date.now() + 8000;
  while (alive() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
  const stillThere = alive();
  if (stillThere) process.kill(pid, 'SIGKILL');
  assert.equal(stillThere, false, 'it should stop within seconds of its app, not run out its 30 s');
});
