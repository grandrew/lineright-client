'use strict';
/**
 * Launches the real app against a stub of the regbot server and a stub of a
 * booking site, and checks the behaviours that matter end to end: a hand-off
 * in the sync reply becomes a tab on the booking page (once), the window is
 * in browser mode with the app's bar grown for the hand-off, the application
 * menu is there, the sites were listed, and the profile kept on this machine
 * was typed into the booking form. Needs the Electron binary and a display
 * (xvfb-run on Linux; Windows always has one); skips itself cleanly without
 * either.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn, spawnSync } = require('node:child_process');

function electronPath() {
  try {
    return require('electron');
  } catch {
    return null;
  }
}

function xvfb() {
  // Windows always has a desktop to draw on, even for a session over SSH.
  if (process.platform === 'win32') return { ok: true, prefix: [] };
  if (process.platform !== 'linux') return { ok: Boolean(process.env.DISPLAY), prefix: [] };
  if (spawnSync('which', ['xvfb-run']).status === 0) return { ok: true, prefix: ['xvfb-run', '-a'] };
  return { ok: Boolean(process.env.DISPLAY), prefix: [] };
}

const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));

/** A booking site: a details form shaped like the DMV's, on its own origin. */
async function dmvStub() {
  const seen = { pages: [] };
  const server = http.createServer((req, res) => {
    seen.pages.push(req.url);
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<!doctype html><title>DMV stub</title><h2>Your details</h2><form id="f">
      <label for="fn">First Name</label><input id="fn" aria-label="First Name" required>
      <label for="ln">Last Name</label><input id="ln" aria-label="Last Name" required>
      <label for="em">Email Address</label><input id="em" aria-label="Email Address" required>
      <label for="ph">Phone Number</label><input id="ph" aria-label="Phone Number" required>
      <label for="note">Anything else</label><input id="note" value="keep me">
      <input type="hidden" name="hold" value="x"></form>`);
  });
  const port = await listen(server);
  return { server, seen, base: `http://127.0.0.1:${port}` };
}

/**
 * The regbot server: one signed-in user, one position, one hand-off — and two
 * sites, the California DMV and a made-up one, as a development server lists
 * them. The app shows the made-up one only in developer mode.
 */
async function regbotStub(dmvBase, { needs = [] } = {}) {
  const seen = { syncs: [], sites: 0 };
  const sites = [
    { slug: 'ca-dmv', name: 'California DMV', category: 'Government', tagline: 'Drive tests and REAL ID.', description: '', image_url: 'x', accent: '#0b63d6', connector: 'dmv.ca.gov.qmatic', mock: false, portal_url: `${dmvBase}/portal/appointments/select-appointment-type?option=RID`, open_queues: 1, live_bids: 7, top_bid: 200, queues: [] },
    { slug: 'helios-arena', name: 'Helios Arena', category: 'Events', tagline: 'Made up.', description: '', image_url: 'x', accent: '#f43f5e', connector: 'helios.arena.boxoffice', mock: true, portal_url: `${dmvBase}/helios`, open_queues: 1, live_bids: 3, top_bid: 90, queues: [] },
  ];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const json = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (url.pathname === '/api/client/sites') {
      seen.sites += 1;
      return json(200, { protocol: 'RQP/1', sites });
    }
    const one = url.pathname.match(/^\/api\/client\/sites\/([a-z-]+)$/);
    if (one) {
      const site = sites.find((s) => s.slug === one[1]);
      if (!site) return json(404, { error: 'No such site.' });
      return json(200, { protocol: 'RQP/1', kind: 'client.site', site, fields: [], kept_on_device: [], places: 0,
        queues: [{ id: 31, slug: 'q', name: 'A line', description: '', status: 'open', window: ['2026-10-01', '2026-12-31'],
          hours: ['09:00', '17:00'], weekdays: 'Mon–Fri', timezone: 'America/Los_Angeles', min_bid: 50,
          slots_per_cycle: 1, cycle_seconds: 90, dispatch: 'cycle', live_bids: 3, top_bid: 90, mine: null }] });
    }
    if (url.pathname === '/api/client/sync') {
      seen.syncs.push({ auth: req.headers.authorization });
      if (req.headers.authorization !== 'Bearer smoke-token') return json(401, { error: 'nope' });
      const base = `http://127.0.0.1:${server.address().port}`;
      return json(200, {
        protocol: 'RQP/1', poll_after_ms: 1500, site_url: base,
        user: { id: 1, nickname: 'ada', balance: 2480, escrow: 200 },
        positions: [{ bid_id: 5, queue_id: 9, queue_name: 'REAL ID', site_slug: 'ca-dmv', site_name: 'California DMV', rank: 1, field_size: 7, amount: 200, status: 'processing', note: '', board_url: `${base}/q/9`, portal_url: dmvBase, has_places: true, window: ['2026-09-01', '2026-12-31'], hours: ['08:00', '17:00'] }],
        handoffs: [{ job_id: 77, bid_id: 5, queue_id: 9, queue_name: 'REAL ID', site_slug: 'ca-dmv', site_name: 'California DMV', phase: 'booking',
          slot: { office_code: 'POWAY', office_name: 'Poway', date: '2026-10-06', time: '10:00', miles: 3.1 },
          open_url: `${dmvBase}/portal/appointments/select-date?branch=POWAY&service=RID`, board_url: `${base}/q/9`,
          deadline: null, seconds_left: 280, since: null, rank_at: 1, amount: 200, message: 'Your turn',
          needs }],
        settled: [], reports: [],
      });
    }
    res.writeHead(404); res.end();
  });
  const port = await listen(server);
  return { server, seen, port };
}

/** A profile file as the app would have saved it on a machine with no keychain. */
function seedProfile(userData, data) {
  fs.writeFileSync(path.join(userData, 'profile.json'), JSON.stringify({
    v: 1, enc: 'plain', autofill: true, data,
  }));
}

/**
 * Run the real app and hand back its SMOKE result: against the stubs when
 * given a port, and otherwise against the server it runs itself.
 */
function startApp({ electron, display, port, userData, exitAfter = 9000, extra = [], practice = false,
  token = 'smoke-token', extraEnv = {} }) {
  // Every run names where it goes: a stub on a port, or the app's own server.
  // Left alone the app would pair with the site config.json names — somebody's
  // real development site — and no test may reach that.
  assert.ok(port || practice, 'a smoke run names its server: a stub port, or practice');
  const args = [...display.prefix, electron, path.join(__dirname, '..'), '--no-sandbox', '--smoke', `--exit-after=${exitAfter}`,
    ...(port ? [`--server=http://127.0.0.1:${port}`] : []), ...(practice ? ['--practice'] : []),
    `--user-data=${userData}`, ...extra];
  const env = { ...process.env, REGBOT_NO_NOTIFY: '1', REGBOT_NO_FLASH: '1', REGBOT_NO_EXTERNAL: '1',
    ELECTRON_DISABLE_SECURITY_WARNINGS: '1', ELECTRON_ENABLE_LOGGING: '0', ...extraEnv };
  delete env.REGBOT_SERVER_URL;
  delete env.REGBOT_SERVER_MODE;
  if (port && token) env.REGBOT_CLIENT_TOKEN = token;
  else delete env.REGBOT_CLIENT_TOKEN;
  const child = spawn(args[0], args.slice(1), { env });
  let out = '';
  let err = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { err += d; });
  const result = new Promise((resolve) => child.on('exit', resolve)).then((code) => {
    const line = out.split('\n').find((l) => l.startsWith('SMOKE '));
    assert.ok(line, `no SMOKE line (exit ${code})\nstdout:\n${out}\nstderr:\n${err.slice(-2000)}`);
    return JSON.parse(line.slice(6));
  });
  return { child, result, stdout: () => out, stderr: () => err };
}

async function runApp(opts) {
  return startApp(opts).result;
}

const DMQ = path.join(__dirname, '..', '..', 'dmq');

/** Ask `fn` until it answers something truthy; its failures meanwhile are only "not yet". */
async function until(fn, ms, what) {
  const deadline = Date.now() + ms;
  let last = null;
  for (;;) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (err) {
      last = err;
    }
    if (Date.now() > deadline) throw new Error(`gave up waiting for ${what}${last ? `: ${last.message}` : ''}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

const getJson = (url) => new Promise((resolve, reject) => {
  http.get(url, (res) => {
    let body = '';
    res.on('data', (d) => { body += d; });
    res.on('end', () => { try { resolve(JSON.parse(body)); } catch (err) { reject(err); } });
  }).on('error', reject);
});

/**
 * Just enough of a WebSocket client to speak the DevTools protocol to one of
 * the app's pages — Node 18 has none built in — and evaluate script there.
 */
function devtools(wsUrl) {
  const url = new URL(wsUrl);
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: url.hostname, port: url.port, path: url.pathname,
      headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64') },
    });
    req.on('error', reject);
    req.on('response', (res) => reject(new Error(`DevTools did not upgrade (${res.statusCode})`)));
    req.on('upgrade', (_res, socket, rest) => {
      const waiting = new Map();
      let id = 0;
      let buf = rest;
      let parts = [];
      const write = (op, payload) => {
        const mask = crypto.randomBytes(4);
        const n = payload.length;
        let head;
        if (n < 126) head = Buffer.from([0x80 | op, 0x80 | n]);
        else if (n < 65536) { head = Buffer.from([0x80 | op, 0x80 | 126, 0, 0]); head.writeUInt16BE(n, 2); }
        else { head = Buffer.alloc(10); head[0] = 0x80 | op; head[1] = 0x80 | 127; head.writeBigUInt64BE(BigInt(n), 2); }
        const body = Buffer.alloc(n);
        for (let i = 0; i < n; i += 1) body[i] = payload[i] ^ mask[i % 4];
        socket.write(Buffer.concat([head, mask, body]));
      };
      const gone = () => {
        for (const done of waiting.values()) done({ error: { message: 'the page went away' } });
        waiting.clear();
      };
      socket.on('close', gone);
      socket.on('error', gone);
      socket.on('data', (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        for (;;) {
          if (buf.length < 2) return;
          let n = buf[1] & 0x7f;
          let at = 2;
          if (n === 126) { if (buf.length < 4) return; n = buf.readUInt16BE(2); at = 4; }
          if (n === 127) { if (buf.length < 10) return; n = Number(buf.readBigUInt64BE(2)); at = 10; }
          if (buf.length < at + n) return;
          const fin = buf[0] & 0x80;
          const op = buf[0] & 0x0f;
          const payload = buf.subarray(at, at + n);
          buf = buf.subarray(at + n);
          if (op === 9) { write(10, payload); continue; }
          if (op === 8) { socket.end(); continue; }
          parts.push(payload);
          if (!fin) continue;
          const msg = JSON.parse(Buffer.concat(parts).toString('utf8'));
          parts = [];
          const done = waiting.get(msg.id);
          if (done) { waiting.delete(msg.id); done(msg); }
        }
      });
      const call = (method, params) => new Promise((done) => {
        id += 1;
        waiting.set(id, done);
        write(1, Buffer.from(JSON.stringify({ id, method, params })));
      });
      resolve({
        async evaluate(expression) {
          const r = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
          if (r.error) throw new Error(r.error.message);
          const thrown = r.result.exceptionDetails;
          if (thrown) throw new Error(thrown.exception ? thrown.exception.description : thrown.text);
          return r.result.result.value;
        },
        close: () => socket.destroy(),
      });
    });
    req.end();
  });
}

/** The first of the app's pages whose address matches, to evaluate script in. */
async function pageWhere(port, match, what) {
  const target = await until(async () => {
    const list = await getJson(`http://127.0.0.1:${port}/json/list`);
    return list.find((t) => t.type === 'page' && match(t.url));
  }, 30000, what);
  return devtools(target.webSocketDebuggerUrl);
}

test('the app opens the booking page when a hand-off arrives, and fills the form from the profile', { timeout: 90000 }, async (t) => {
  const electron = electronPath();
  const display = xvfb();
  if (!electron || !fs.existsSync(electron)) return t.skip('electron is not installed (npm install)');
  if (!display.ok) return t.skip('no display: install xvfb or set DISPLAY');

  const dmv = await dmvStub();
  const { server, seen, port } = await regbotStub(dmv.base);
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'regbot-smoke-'));
  seedProfile(userData, { first_name: 'Ada', last_name: 'Lovelace', dob: '12/10/1815', dl_number: 'A1234567', email: 'ada@example.test', phone: '5555550123' });
  const result = await runApp({ electron, display, port, userData });
  server.close();
  dmv.server.close();
  assert.equal(result.paired, true, 'the token from the environment is used');
  assert.equal(result.synced, true, 'at least one sync completed');
  assert.equal(result.handoffs, 1);
  assert.equal(result.positions, 1);
  assert.equal(seen.syncs[0].auth, 'Bearer smoke-token');
  assert.ok(seen.sites >= 1, 'the sites were asked for (for the menu)');
  // The server lists two; the made-up one is for developer mode only.
  assert.equal(result.sites, 1);
  assert.deepEqual(result.developer, { on: false, forced: null });

  // Browser mode, one tab: the hand-off's page, opened once across many syncs.
  assert.equal(result.mode, 'tab');
  assert.equal(result.tabs.length, 1, `the same hand-off is not opened twice: ${JSON.stringify(result.tabs)}`);
  assert.equal(result.tabs[0].kind, 'handoff');
  assert.equal(result.tabs[0].jobId, 77);
  assert.match(result.tabs[0].url, /\/portal\/appointments\/select-date\?branch=POWAY&service=RID$/);
  assert.ok(result.chromeHeight > 98, `the strip grew for the hand-off bar (${result.chromeHeight})`);

  // The application menu, on every platform.
  const labels = result.menu.map((m) => String(m.label).replace('&', ''));
  for (const want of ['File', 'Sites', 'View', 'Help']) assert.ok(labels.includes(want), `menu ${want} in ${labels}`);
  const file = result.menu.find((m) => /File/.test(m.label));
  assert.ok(file.items.some((i) => /Sign out/.test(i)), `signed in, so File offers Sign out: ${file.items}`);
  assert.ok(file.items.some((i) => /E&?xit|close/.test(i)), `File ends with Exit: ${file.items}`);
  assert.ok(file.items.some((i) => /Import from your browser/.test(i)), `File offers the import: ${file.items}`);
  // A profile with details already in it is not asked to import one, whatever
  // browsers this machine happens to have.
  assert.equal(result.offerImport, false, 'the startup import is not offered over a profile that is filled in');
  assert.ok(!file.items.some((i) => /recommended/.test(i)), `nor pressed in the menu: ${file.items}`);
  const sites = result.menu.find((m) => /Sites/.test(m.label));
  assert.ok(sites.items.includes('California DMV'), `the server's sites are in the menu: ${sites.items}`);
  assert.ok(!sites.items.some((i) => /Helios/.test(i)), `but not the made-up one: ${sites.items}`);
  const view = result.menu.find((m) => /View/.test(m.label));
  assert.ok(view.items.includes('Developer mode'), `View switches developer mode: ${view.items}`);
  assert.ok(!view.items.some((i) => /Developer Tools/i.test(i)), `and has no developer tools without it: ${view.items}`);

  // Whatever this machine has, looking for browsers on it answered without
  // throwing — a build machine with none is as valid an answer as five.
  assert.ok(Array.isArray(result.browsers), `the machine was looked at: ${JSON.stringify(result.browsers)}`);
  for (const browser of result.browsers) {
    assert.equal(typeof browser.name, 'string');
    assert.ok(browser.profiles >= 1, `${browser.name} was listed, so it has a profile`);
  }

  // The profile on this machine was typed into the booking form, and only
  // into fields that were empty and that said what they were.
  assert.equal(result.profile.filled, 6);
  assert.ok(result.autofill, `the form was filled: ${JSON.stringify(result)}`);
  assert.equal(result.autofill.filled, 4, JSON.stringify(result.autofill));
  assert.equal(result.autofill.skipped, 0);
  assert.deepEqual(result.autofill.fields.map((f) => f.key).sort(), ['email', 'first_name', 'last_name', 'phone']);
  assert.ok(result.bookingOrigins.includes(dmv.base), `the DMV stub is a booking origin: ${result.bookingOrigins}`);
  assert.ok(!result.bookingOrigins.includes(`http://127.0.0.1:${port}`), 'the regbot server itself never is');
});

test('test sites are shown only in developer mode, marked as test sites, and View switches it',
  { timeout: 150000 }, async (t) => {
  const electron = electronPath();
  const display = xvfb();
  if (!electron || !fs.existsSync(electron)) return t.skip('electron is not installed (npm install)');
  if (!display.ok) return t.skip('no display: install xvfb or set DISPLAY');
  const dmv = await dmvStub();
  const { server, port } = await regbotStub(dmv.base);
  t.after(() => { server.close(); dmv.server.close(); });

  // Started with it off and asked for the made-up site's page; then switched
  // on and off from the menu, through the main process's own inspector, as a
  // click on View → Developer mode would.
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'regbot-smoke-developer-'));
  seedProfile(userData, { first_name: 'Ada', last_name: 'Lovelace', email: 'ada@example.test', phone: '5555550123' });
  const run = startApp({ electron, display, port, userData, exitAfter: 45000,
    extra: ['--remote-debugging-port=0', '--inspect=0', '--page=site:helios-arena'] });
  const pages = [];
  try {
    const devPort = Number(await until(() => fs.readFileSync(path.join(userData, 'DevToolsActivePort'), 'utf8').split('\n')[0], 30000, 'DevTools'));
    const ui = await pageWhere(devPort, (u) => u.endsWith('/ui/index.html'), 'the app page');
    pages.push(ui);
    const inspector = await until(() => (`${run.stdout()}\n${run.stderr()}`.match(/Debugger listening on (ws:\/\/\S+)/) || [])[1], 30000, 'the main process inspector');
    const main = await devtools(inspector);
    pages.push(main);
    const mainJs = JSON.stringify(path.join(__dirname, '..', 'src', 'main.js'));
    const switchDeveloper = () => main.evaluate(`(() => {
      const { Menu } = process.getBuiltinModule('module').createRequire(${mainJs})('electron');
      const view = Menu.getApplicationMenu().items.find((i) => /View/.test(i.label));
      view.submenu.items.find((i) => /^Developer mode/.test(i.label)).click();
      return true;
    })()`);
    const text = () => ui.evaluate("document.getElementById('page').innerText");
    const cards = () => ui.evaluate("[...document.querySelectorAll('.site-card')].map((c) => [c.dataset.slug, c.classList.contains('site-test'), Boolean(c.querySelector('.test-badge'))])");
    const flagged = () => ui.evaluate("!document.getElementById('devmode').classList.contains('hidden')");
    const listed = (n, what) => until(async () => { const c = await cards(); return c.length === n && c; }, 15000, what);

    // Off: the made-up site's page does not open, and it is not listed.
    let said = '';
    assert.match(await until(async () => { said = await text(); return /developer mode/.test(said) && said; }, 20000, 'the test site turned away')
      .catch((err) => { throw new Error(`${err.message}; the page said: ${said.slice(0, 400)}`); }),
      /test site, made up for demos and tests\. The app shows test sites only in developer mode/);
    await ui.evaluate("window.regbot.call('tabs:home').then(() => document.querySelector('#topnav [data-page=sites]').click())");
    assert.deepEqual(await listed(1, 'the sites'), [['ca-dmv', false, false]]);
    assert.equal(await flagged(), false);

    // On: listed, and marked as a test site wherever it shows.
    await switchDeveloper();
    assert.deepEqual(await listed(2, 'the test site listed'), [['ca-dmv', false, false], ['helios-arena', true, true]]);
    assert.equal(await flagged(), true, 'the top bar says developer mode is on');
    assert.match(await text(), /1 test site is listed too/);
    await ui.evaluate("document.querySelector('.site-card[data-slug=helios-arena]').click()");
    assert.match(await until(async () => { const s = await text(); return /Helios Arena/.test(s) && s; }, 15000, 'its page'),
      /Test site\. Made up for demos and tests: nothing booked here is real/);
    assert.deepEqual((await ui.evaluate("window.regbot.call('settings:get')")).developer, { on: true, forced: null });

    // Off again: the page it was on goes, and so does the site.
    await switchDeveloper();
    assert.deepEqual(await listed(1, 'the test site gone'), [['ca-dmv', false, false]]);
    assert.equal(await flagged(), false);
    // Nor does Settings take another server, or an update feed of the app's own.
    for (const ask of ["{ serverMode: 'remote', serverUrl: 'http://127.0.0.1:9' }", "{ serverMode: 'builtin' }", "{ updateUrl: 'http://127.0.0.1:9/feed' }"]) {
      assert.match((await ui.evaluate(`window.regbot.call('settings:set', ${ask})`)).error || '', /part of developer mode/, ask);
    }
  } finally {
    for (const p of pages) p.close();
  }
  const result = await run.result;
  assert.deepEqual(result.developer, { on: false, forced: null });
  assert.equal(result.server, `http://127.0.0.1:${port}`, 'still where it was told to go');
  assert.equal(result.sites, 1);
  const saved = JSON.parse(fs.readFileSync(path.join(userData, 'regbot.json'), 'utf8'));
  assert.equal(saved.developerMode, undefined, 'turned on and off again, the settings say nothing of it');
  assert.equal(saved.updateUrl, undefined);

  // --developer: on for the run, says so in the menu, and has the developer tools there.
  const forced = await runApp({ electron, display, port, extra: ['--developer'],
    userData: fs.mkdtempSync(path.join(os.tmpdir(), 'regbot-smoke-developer-')) });
  assert.deepEqual(forced.developer, { on: true, forced: 'flag' });
  assert.deepEqual(forced.siteList, [{ slug: 'ca-dmv', mock: false }, { slug: 'helios-arena', mock: true }]);
  const menuOf = (name) => forced.menu.find((m) => new RegExp(name).test(m.label)).items;
  assert.ok(menuOf('Sites').includes('Helios Arena — test site'), `${menuOf('Sites')}`);
  assert.ok(menuOf('View').includes('Developer mode (on for this run)'), `${menuOf('View')}`);
  assert.ok(menuOf('View').some((i) => /Developer Tools/i.test(i)), `${menuOf('View')}`);
});

test('a hand-off for a line the profile is not ready for opens the profile, not the form',
  { timeout: 90000 }, async (t) => {
  // The worst moment to discover a missing licence number is the one where a
  // slot is being held for you and a clock is running. So when the line says
  // what its form will ask for and the profile does not have it, the app takes
  // the person to the profile instead of to a page nothing can fill in.
  const electron = electronPath();
  const display = xvfb();
  if (!electron || !fs.existsSync(electron)) return t.skip('electron is not installed (npm install)');
  if (!display.ok) return t.skip('no display: install xvfb or set DISPLAY');

  const dmv = await dmvStub();
  const { server, port } = await regbotStub(dmv.base, {
    needs: [
      { key: 'first_name', label: 'First name', required: true },
      { key: 'email', label: 'Email for the DMV confirmation', required: true },
      { key: 'phone', label: 'Mobile number', required: true },
      { key: 'member_id', label: 'Fan club member number', required: true },
    ],
  });
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'regbot-smoke-gate-'));
  seedProfile(userData, { first_name: 'Ada', last_name: 'Lovelace' });
  const result = await runApp({ electron, display, port, userData });
  server.close();
  dmv.server.close();

  assert.equal(result.handoffs, 1, 'the hand-off arrived');
  assert.deepEqual(result.tabs, [], 'and no booking page was opened');
  assert.equal(result.mode, 'app', 'so the window stayed in app mode');
  assert.ok(result.screen, 'the app sent the person somewhere');
  assert.equal(result.screen.page, 'profile');
  const need = result.screen.params.gate.need.map((f) => f.key).sort();
  assert.deepEqual(need, ['email', 'phone'],
    'what it asks for is what this line needs and the profile lacks — not the name it has, '
    + 'and not the membership number no profile could hold');
  assert.match(result.screen.params.gate.why, /REAL ID/);
});

test('in practice mode the app runs its own — site, processor and stand-in — and signs itself in',
  { timeout: 150000 }, async (t) => {
  // The installed app is the whole of regbot. Nothing is running before it
  // starts, nobody signs in, and nothing is left running after it quits.
  const electron = electronPath();
  const display = xvfb();
  if (!electron || !fs.existsSync(electron)) return t.skip('electron is not installed (npm install)');
  if (!display.ok) return t.skip('no display: install xvfb or set DISPLAY');
  const { locate } = require('../src/stack');
  const paths = locate({ packaged: false, appPath: path.join(__dirname, '..') });
  // Practice runs the lineright server, which is not part of this app.
  if (!paths.regbot) return t.skip('no lineright-server checkout beside this one (or LINERIGHT_SERVER_DIR)');
  if (spawnSync(paths.python, ['-I', '-c', 'import flask']).status !== 0) {
    return t.skip(`no Python with Flask for the server (${paths.python}): make its regbot/.venv`);
  }

  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'regbot-smoke-builtin-'));
  const result = await runApp({ electron, display, userData, exitAfter: 14000, practice: true });

  assert.equal(result.serverMode, 'builtin');
  assert.ok(result.stack, 'the app says what it started');
  for (const name of ['standin', 'web', 'worker']) {
    assert.equal(result.stack.services[name].state, 'running', `${name}: ${JSON.stringify(result.stack.services[name])}`);
  }
  assert.equal(result.stack.services.admin.state, 'stopped', 'the control room waits to be opened');
  assert.equal(result.server, result.stack.url, 'the app talks to the site it started');
  assert.match(result.server, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.equal(result.stack.dmvBase, `http://127.0.0.1:${result.stack.services.standin.port}`,
    'the robots practise on the stand-in, not dmv.ca.gov');
  assert.equal(result.paired, true, 'signed in with no sign-in');
  assert.ok(result.stack.owner && result.stack.owner.nickname, 'as an account made for this person');
  assert.equal(result.synced, true);
  // Practising is developer mode, so the seeded catalogue is all there: the
  // California DMV, and the made-up sites, each marked as one by the server.
  assert.deepEqual(result.developer, { on: true, forced: 'practice' });
  assert.equal(result.sites, 6, 'the seeded catalogue');
  assert.deepEqual(result.siteList.filter((s) => !s.mock).map((s) => s.slug), ['ca-dmv']);

  const file = result.menu.find((m) => /File/.test(m.label));
  assert.ok(!file.items.some((i) => /Sign (in|out)/.test(i)), `nobody to sign in to: ${file.items}`);
  const view = result.menu.find((m) => /View/.test(m.label));
  assert.ok(view.items.includes('Control room') && !view.items.includes('The LineRight Regbot website'), `${view.items}`);
  assert.ok(view.items.includes('Developer mode (on while practising)'), `${view.items}`);
  const sites = result.menu.find((m) => /Sites/.test(m.label)).items;
  assert.equal(sites.filter((i) => / — test site$/.test(i)).length, 5, `${sites}`);

  // Its data is under the app's own user data, beside its credentials.
  for (const f of ['regbot.db', 'desktop.json', 'regbot.env', 'logs/web.log', 'logs/worker.log']) {
    assert.ok(fs.existsSync(path.join(userData, 'server', f)), f);
  }
  // And everything it started went when it quit.
  for (const [name, s] of Object.entries(result.stack.services)) {
    if (!s.pid) continue;
    assert.throws(() => process.kill(s.pid, 0), (err) => err.code === 'ESRCH', `${name} (pid ${s.pid}) is still running`);
  }
});

test('Settings → Start over deletes what the app keeps, and it carries on as on its first launch',
  { timeout: 180000 }, async (t) => {
  // Driven through the Settings screen itself, over the DevTools protocol:
  // something in every place a reset has to empty, then the two clicks.
  const electron = electronPath();
  const display = xvfb();
  if (!electron || !fs.existsSync(electron)) return t.skip('electron is not installed (npm install)');
  if (!display.ok) return t.skip('no display: install xvfb or set DISPLAY');
  const { locate } = require('../src/stack');
  const paths = locate({ packaged: false, appPath: path.join(__dirname, '..') });
  // Practice runs the lineright server, which is not part of this app.
  if (!paths.regbot) return t.skip('no lineright-server checkout beside this one (or LINERIGHT_SERVER_DIR)');
  if (spawnSync(paths.python, ['-I', '-c', 'import flask']).status !== 0) {
    return t.skip(`no Python with Flask for the server (${paths.python}): make its regbot/.venv`);
  }

  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'regbot-smoke-reset-'));
  const run = startApp({ electron, display, userData, exitAfter: 50000, practice: true, extra: ['--remote-debugging-port=0'] });
  const pages = [];
  try {
    // Chromium writes the port it chose beside the profile (xvfb-run folds stderr into stdout).
    const port = Number(await until(() => fs.readFileSync(path.join(userData, 'DevToolsActivePort'), 'utf8').split('\n')[0], 30000, 'DevTools'));
    const ui = await pageWhere(port, (u) => u.endsWith('/ui/index.html'), 'the app page');
    pages.push(ui);
    const settings = () => ui.evaluate("window.regbot.call('settings:get')");
    const serverUp = async () => { const s = await settings(); return s.stack && s.stack.services.web.state === 'running' && s; };
    const credentials = () => JSON.parse(fs.readFileSync(path.join(userData, 'server', 'desktop.json'), 'utf8'));

    const before = await until(serverUp, 60000, 'the server on this computer');
    const tokenBefore = credentials().token;
    await ui.evaluate("window.regbot.call('profile:set', { data: { first_name: 'Ada', email: 'ada@example.invalid' } })");
    await ui.evaluate("window.regbot.call('settings:set', { clientName: 'reset-me', updateUrl: 'http://127.0.0.1:9/feed' })");
    await ui.evaluate("localStorage.setItem('reset-probe', '1')");
    await ui.evaluate(`window.regbot.call('tabs:open', { url: ${JSON.stringify(before.stack.standin)}, kind: 'portal', title: 'stand-in' })`);
    const site = await pageWhere(port, (u) => u.startsWith(before.stack.standin), 'the stand-in tab');
    pages.push(site);
    // Not the blank page every tab starts on, which no cookie can be set for.
    const loaded = (base) => `location.href.startsWith(${JSON.stringify(base)}) && document.readyState === 'complete'`;
    await until(() => site.evaluate(loaded(before.stack.standin)), 30000, 'the stand-in page');
    await site.evaluate("document.cookie = 'reset_probe=1; max-age=3600; path=/'");
    assert.match(await site.evaluate('document.cookie'), /reset_probe=1/);
    assert.equal((await ui.evaluate("window.regbot.call('profile:get')")).filled, 2);

    // As a person would: Settings, "Reset everything…", then the list of what goes, then yes.
    await ui.evaluate("window.regbot.call('tabs:home')");
    await ui.evaluate("window.beforeReset = true; document.getElementById('gear').click()");
    await until(() => ui.evaluate("Boolean(document.getElementById('s-reset'))"), 15000, 'the Start over panel');
    await ui.evaluate("document.getElementById('s-reset').click()");
    const listed = await until(() => ui.evaluate("(document.getElementById('s-reset-panel') || {}).innerText"), 15000, 'what a reset deletes');
    for (const what of [/credits/, /telemetry/, /profile/, /booking sites/, /settings/]) assert.match(listed, what);
    await ui.evaluate("document.getElementById('s-reset-go').click()");

    // The app reloads its page once it has started over.
    await until(() => ui.evaluate("window.beforeReset === undefined && document.readyState === 'complete'"), 60000, 'the page to start over');
    assert.match(await until(() => ui.evaluate("document.getElementById('toasts').innerText"), 5000, 'the toast'), /reset/i);
    const after = await until(serverUp, 60000, 'the new server on this computer');

    assert.equal(after.serverMode, 'builtin');
    assert.notEqual(after.clientName, 'reset-me', 'the settings are the defaults again');
    assert.notEqual(after.updateUrl, 'http://127.0.0.1:9/feed');
    assert.equal(after.dmvTarget, 'standin');
    assert.notEqual(credentials().token, tokenBefore, 'a new server, not the old one restarted');
    const webLog = fs.readFileSync(path.join(userData, 'server', 'logs', 'web.log'), 'utf8');
    assert.equal(webLog.split('starting web').length - 1, 1, 'its logs begin with this start');
    assert.equal((await ui.evaluate("window.regbot.call('profile:get')")).filled, 0, 'the profile is empty');
    assert.equal(await ui.evaluate("localStorage.getItem('reset-probe')"), null, "the app page's storage is gone");
    for (const [name, s] of Object.entries(before.stack.services)) {
      if (!s.pid) continue;
      assert.throws(() => process.kill(s.pid, 0), (err) => err.code === 'ESRCH', `the old ${name} (pid ${s.pid}) is still running`);
    }

    // The tab closed with everything else; a new one finds no trace of the old cookie.
    await ui.evaluate(`window.regbot.call('tabs:open', { url: ${JSON.stringify(after.stack.standin)}, kind: 'portal' })`);
    const again = await pageWhere(port, (u) => u.startsWith(after.stack.standin), 'the stand-in again');
    pages.push(again);
    await until(() => again.evaluate(loaded(after.stack.standin)), 30000, 'the stand-in page again');
    assert.doesNotMatch(await again.evaluate('document.cookie'), /reset_probe/, "the tabs' cookies are gone");
  } finally {
    for (const p of pages) p.close();
  }

  const result = await run.result;
  assert.equal(result.paired, true, 'signed in to the new server with no sign-in');
  for (const name of ['standin', 'web', 'worker']) {
    assert.equal(result.stack.services[name].state, 'running', `${name}: ${JSON.stringify(result.stack.services[name])}`);
  }
  assert.equal(result.profile.filled, 0);
});


/**
 * A regbot site that pairs anybody who asks, after a couple of polls, and then
 * answers a sync for that device. Enough of the public site for a first run.
 */
async function pairingSite() {
  const seen = { starts: 0, polls: 0, syncs: [] };
  const server = http.createServer((req, res) => {
    const base = `http://127.0.0.1:${server.address().port}`;
    const json = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    const url = new URL(req.url, base);
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      if (url.pathname === '/api/client/pair/start') {
        seen.starts += 1;
        return json(200, { code: 'ABCD-2345', secret: 's3cret', verify_url: `${base}/pair?code=ABCD-2345`,
          expires_at: null, expires_in: 900, poll_ms: 400, site_url: base });
      }
      if (url.pathname === '/api/client/pair/poll') {
        seen.polls += 1;
        if (seen.polls < 3) return json(200, { status: 'pending' });
        return json(200, { status: 'approved', token: 'paired-token', user: { id: 7, nickname: 'newcomer' } });
      }
      if (url.pathname === '/api/client/sites') return json(200, { protocol: 'RQP/1', sites: [] });
      if (url.pathname === '/api/client/sync') {
        seen.syncs.push({ auth: req.headers.authorization, body: body ? JSON.parse(body) : null });
        if (req.headers.authorization !== 'Bearer paired-token') return json(401, { error: 'not paired' });
        return json(200, { protocol: 'RQP/1', kind: 'client.sync', poll_after_ms: 1500, site_url: base,
          user: { id: 7, nickname: 'newcomer', balance: 2500, escrow: 0 },
          positions: [], handoffs: [], settled: [], reports: [], reads: [] });
      }
      if (url.pathname === '/api/client/unpair') return json(200, { ok: true });
      return json(404, { error: 'no' });
    });
  });
  const port = await listen(server);
  return { server, seen, port, base: `http://127.0.0.1:${port}` };
}

test('a first run asks for an account on the LineRight Regbot site, pairs by code, and a reset asks again',
  { timeout: 150000 }, async (t) => {
  const electron = electronPath();
  const display = xvfb();
  if (!electron || !fs.existsSync(electron)) return t.skip('electron is not installed (npm install)');
  if (!display.ok) return t.skip('no display: install xvfb or set DISPLAY');

  const site = await pairingSite();
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'regbot-smoke-firstrun-'));
  const run = startApp({ electron, display, userData, port: site.port, token: null, exitAfter: 45000,
    extra: ['--remote-debugging-port=0'] });
  const pages = [];
  try {
    const port = Number(await until(() => fs.readFileSync(path.join(userData, 'DevToolsActivePort'), 'utf8').split('\n')[0], 30000, 'DevTools'));
    const ui = await pageWhere(port, (u) => u.endsWith('/ui/index.html'), 'the app page');
    pages.push(ui);
    const heading = () => ui.evaluate("(document.querySelector('#page h1') || {}).textContent || ''");

    // On a machine with a browser the import comes first; after it, the account.
    await until(async () => /Import from your browser|Create your LineRight Regbot account/.test(await heading()), 20000, 'the first screen');
    if (/Import/.test(await heading())) await ui.evaluate("document.getElementById('i-skip').click()");
    await until(async () => (await heading()) === 'Create your LineRight Regbot account', 10000, 'the account screen');
    assert.match(await ui.evaluate("document.getElementById('s-start').textContent"), /Create an account or sign in/);
    assert.match(await ui.evaluate("document.querySelector('#page .lead').textContent"), new RegExp(`127\\.0\\.0\\.1:${site.port}`));

    await ui.evaluate("document.getElementById('s-start').click()");
    assert.equal(await until(() => ui.evaluate("(document.getElementById('pair-code') || {}).textContent"), 10000, 'the code'), 'ABCD-2345');
    const pair = await until(async () => { const p = await ui.evaluate("window.regbot.call('pair:state')"); return p.paired && p; }, 20000, 'the approval');
    assert.equal(pair.user.nickname, 'newcomer');
    await until(() => site.seen.syncs.some((s) => s.auth === 'Bearer paired-token'), 15000, 'a sync with the new token');
    const saved = JSON.parse(fs.readFileSync(path.join(userData, 'regbot.json'), 'utf8'));
    assert.equal(saved.token, 'paired-token');
    assert.equal(saved.tokenServer, site.base, 'kept with the server that issued it');
    assert.equal(saved.serverUrl, undefined, 'a server named for the run is not saved');

    // Start over: the token goes, and the app asks for the account again.
    await ui.evaluate("window.regbot.call('tabs:home')");
    await ui.evaluate("window.beforeReset = true; document.getElementById('gear').click()");
    await until(() => ui.evaluate("Boolean(document.getElementById('s-reset'))"), 15000, 'Start over');
    await ui.evaluate("document.getElementById('s-reset').click()");
    const listed = await until(() => ui.evaluate("(document.getElementById('s-reset-panel') || {}).innerText"), 15000, 'the list');
    assert.match(listed, /signs it out there too/);
    await ui.evaluate("document.getElementById('s-reset-go').click()");
    await until(() => ui.evaluate("window.beforeReset === undefined && document.readyState === 'complete'"), 30000, 'the page to start over');
    const after = await until(async () => { const p = await ui.evaluate("window.regbot.call('pair:state')"); return p && !p.paired && p; }, 10000, 'signed out');
    assert.equal(after.paired, false);
    assert.equal(fs.existsSync(path.join(userData, 'regbot.json')), false, 'nothing saved, so no file');
  } finally {
    for (const p of pages) p.close();
    site.server.close();
  }
  const result = await run.result;
  assert.equal(result.paired, false);
  assert.equal(result.serverMode, 'remote');
  assert.equal(site.seen.starts, 1);
});


test('the app looks for openings when the site asks, with its own scout, and answers the site',
  { timeout: 90000 }, async (t) => {
  const electron = electronPath();
  const display = xvfb();
  if (!electron || !fs.existsSync(electron)) return t.skip('electron is not installed (npm install)');
  if (!display.ok) return t.skip('no display: install xvfb or set DISPLAY');
  if (!fs.existsSync(path.join(DMQ, 'bin', 'rqp-scout.js'))) return t.skip('no ../dmq checkout');

  const day = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  const seen = { bodies: [], answers: [] };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      const base = `http://127.0.0.1:${server.address().port}`;
      const json = (code, o) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
      const url = new URL(req.url, base);
      if (url.pathname === '/api/client/sites') return json(200, { protocol: 'RQP/1', sites: [] });
      if (url.pathname === '/api/client/sync') {
        seen.bodies.push(JSON.parse(body || '{}'));
        const reads = seen.answers.length ? [] : [{
          read_id: 5, queue_id: 20, queue_name: 'REAL ID application', site_slug: 'ca-dmv', site_name: 'California DMV',
          robot: 'dmq-rqp/1', base_url: 'http://127.0.0.1:9', captcha_solver_url: null, lease_seconds: 120,
          timeout_s: 120, expires_at: null,
          request: { protocol: 'RQP/1', kind: 'discovery.request',
            target: { site: 'ca-dmv', connector: 'dmv.ca.gov.qmatic', queue: 'real-id', queue_name: 'REAL ID application' },
            offices: ['Poway'], window: [day, day], hours: ['08:00', '17:00'], timezone: 'America/Los_Angeles' },
        }];
        return json(200, { protocol: 'RQP/1', kind: 'client.sync', poll_after_ms: 1000, site_url: base,
          user: { id: 1, nickname: 'scout', balance: 2500, escrow: 0 },
          positions: [], handoffs: [], settled: [], reports: [], reads, reader: { mode: 'apps', last: null } });
      }
      if (url.pathname === '/api/client/reads/5') {
        seen.answers.push(JSON.parse(body));
        return json(200, { ok: true, read_id: 5, status: 'done', recorded: 2, new: 2, dropped: 0,
          offers: [{ offer_id: 1, where: `Poway on ${day} at 09:00`, verdict: 'passed', to: { rank: 1, nickname: 'ada', you: false } }] });
      }
      return json(404, { error: 'no' });
    });
  });
  const port = await listen(server);
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'regbot-smoke-reads-'));
  try {
    const result = await runApp({ electron, display, port, userData, exitAfter: 12000,
      extraEnv: { REGBOT_ROBOT_SIMULATE: '1' } });
    assert.equal(seen.answers.length, 1, 'the site was answered once');
    const answer = seen.answers[0];
    assert.equal(answer.kind, 'discovery.result');
    assert.equal(answer.offers.length, 2);
    assert.ok(answer.offers.every((o) => o.office_name === 'Poway' && o.slot_date === day));
    assert.deepEqual(seen.bodies[0].reader, { enabled: true, robots: ['dmq-rqp/1'], reading: null, busy: false, agreed: true });
    assert.equal(result.robots.last.read_id, 5);
    assert.equal(result.robots.last.offers[0].verdict, 'passed');
    assert.equal(result.robots.reading, null);
    assert.ok(fs.existsSync(path.join(userData, 'robots')), "the robots' own folder");
  } finally {
    server.close();
  }
});

test('a booking page in a tab is written down: its network, what was clicked and typed, the page after each step',
  { timeout: 120000 }, async (t) => {
  const electron = electronPath();
  const display = xvfb();
  if (!electron || !fs.existsSync(electron)) return t.skip('electron is not installed (npm install)');
  if (!display.ok) return t.skip('no display: install xvfb or set DISPLAY');

  const dmv = await dmvStub();
  const site = await bookingSite(dmv.base);
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'regbot-smoke-logs-'));
  seedProfile(userData, { first_name: 'Ada', last_name: 'Lovelace', email: 'ada@example.test', phone: '5555550123' });
  // Not let to book for them: the turn's page opens, for the person to book on.
  const run = startApp({ electron, display, port: site.port, userData, exitAfter: 16000, extra: ['--remote-debugging-port=0'] });
  let page = null;
  try {
    const devPort = Number(await until(() => fs.readFileSync(path.join(userData, 'DevToolsActivePort'), 'utf8').split('\n')[0], 30000, 'DevTools'));
    page = await pageWhere(devPort, (u) => u.startsWith(dmv.base), 'the booking page');
    await until(() => page.evaluate("document.readyState === 'complete' && Boolean(document.getElementById('note'))"), 15000, 'the form');
    await new Promise((r) => setTimeout(r, 1000));
    // A person at the page: an office in a field that is nobody's, their name in one that is theirs, a click.
    await page.evaluate(`(() => {
      const set = (id, v) => { const el = document.getElementById(id); el.value = v; el.dispatchEvent(new Event('change', { bubbles: true })); };
      set('note', 'Poway');
      set('fn', 'Ada');
      document.getElementById('ln').click();
      return true;
    })()`);
    await run.result;
  } finally {
    if (page) page.close();
    if (run.child.exitCode === null) run.child.kill();
    site.server.close();
    dmv.server.close();
  }

  const logs = path.join(userData, 'logs');
  const named = (prefix) => fs.readdirSync(logs).filter((f) => f.startsWith(prefix));
  const lines = (file) => fs.readFileSync(path.join(logs, file), 'utf8').trim().split('\n');
  assert.match(lines(named('app-')[0]).join('\n'), /starting .*logs in .*kept 3 days/);
  const site_ = lines(named('site-')[0]).map((l) => JSON.parse(l));
  assert.ok(site_.some((r) => r.path === '/api/client/sync' && r.reply && r.reply.handoffs), 'the site\'s answers are kept');
  assert.ok(site_.every((r) => !JSON.stringify(r).includes('smoke-token')), 'the device token never is');

  const records = lines(named('pages-')[0]).map((l) => JSON.parse(l));
  const of = (type) => records.filter((r) => r.type === type && r.job === 77);
  assert.equal(of('opened')[0].network, true, 'the network watched from outside the page');
  const doc = of('request').find((r) => r.rtype === 'Document' && r.url.startsWith(dmv.base));
  assert.ok(doc, JSON.stringify(records.slice(0, 5)));
  assert.equal(of('response').find((r) => r.id === doc.id).status, 200);
  const body = of('body').find((r) => r.id === doc.id);
  assert.match(fs.readFileSync(path.join(logs, body.file), 'utf8'), /DMV stub/);
  assert.ok(of('loaded').length >= 1);
  const actions = of('action');
  const changed = (id) => actions.find((a) => a.action === 'change' && a.target && a.target.id === id);
  assert.equal(changed('note').value, 'Poway', 'a field that is nobody\'s keeps its value');
  assert.deepEqual([changed('fn').value, changed('fn').length], [undefined, 3], 'a name is kept as its length');
  assert.ok(actions.some((a) => a.action === 'click' && a.target && a.target.id === 'ln'), JSON.stringify(actions));
  const copies = of('snapshot');
  assert.ok(copies.length >= 1, 'the page copied after the step');
  const last = fs.readFileSync(path.join(logs, copies.at(-1).file), 'utf8');
  assert.match(last, /id="note"[^>]*value="Poway"/);
  assert.match(last, /id="fn"[^>]*value="‹3 chars›"/);
  assert.doesNotMatch(last, /value="Ada"/);
});

/**
 * A regbot site whose one hand-off this app can book itself: the job's stored
 * request, the DMV to book it on, what the form needs. It records the claim and
 * what the app said came of it, and drops the hand-off once it has an answer.
 */
async function bookingSite(dmvBase, { quietAfter = null, openUrl = null } = {}) {
  // quietAfter: another device of the person's holds the hand-off, and goes
  // quiet after that many syncs of this app's. openUrl: where its page is.
  const seen = { syncs: 0, claims: [], booked: [], gone: [], claimedAtSync: null };
  const day = '2026-10-06';
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      const base = `http://127.0.0.1:${server.address().port}`;
      const json = (code, o) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
      const url = new URL(req.url, base);
      if (url.pathname === '/api/client/sites') return json(200, { protocol: 'RQP/1', sites: [] });
      if (url.pathname === '/api/client/handoffs/77/claim') {
        seen.claims.push(77);
        seen.claimedAtSync = seen.syncs;
        return json(200, { ok: true, claimed: true, took_over_from: quietAfter === null ? null : 'other-box' });
      }
      if (url.pathname === '/api/client/handoffs/77/booked') { seen.booked.push(JSON.parse(body)); return json(200, { ok: true }); }
      if (url.pathname === '/api/client/handoffs/77/gone') { seen.gone.push(JSON.parse(body)); return json(200, { ok: true }); }
      if (url.pathname !== '/api/client/sync') return json(404, { error: 'no' });
      seen.syncs += 1;
      const answered = seen.booked.length || seen.gone.length;
      const handoffs = answered ? [] : [{
        job_id: 77, bid_id: 5, queue_id: 9, queue_name: 'REAL ID', queue_slug: 'real-id', site_slug: 'ca-dmv',
        site_name: 'California DMV', connector: 'dmv.ca.gov.qmatic', phase: 'booking',
        slot: { office_code: 'POWAY', office_name: 'Poway', date: day, time: '10:00', miles: 3.1 },
        open_url: openUrl || `${dmvBase}/portal/appointments/select-date?branch=POWAY&service=RID`,
        deadline: null, seconds_left: 280, since: null, rank_at: 1, amount: 200, message: 'Your turn', needs: [],
        missed: { refund_percent: 70, refund: 140, kept: 60 },
        booker: quietAfter === null || seen.claimedAtSync !== null ? null
          : { name: 'other-box', you: false, silent: seen.syncs > quietAfter },
        robot: {
          name: 'dmq-rqp/1', base_url: 'http://127.0.0.1:9', captcha_solver_url: null,
          requires: ['first_name', 'last_name', 'email', 'phone'],
          request: { protocol: 'RQP/1', kind: 'booking.request', job_id: 77,
            idempotency_key: 'rqp1-job-77-20260926101500', issued_at: '2026-09-26T10:15:00Z',
            target: { site: 'ca-dmv', connector: 'dmv.ca.gov.qmatic', queue: 'real-id', queue_name: 'REAL ID' },
            slot: { window: [day, day], hours: ['08:00', '17:00'], timezone: 'America/Los_Angeles',
              allocated: { offer_id: 3, office_code: 'POWAY', office_name: 'Poway', date: day, time: '10:00', miles: 3.1 } },
            applicant: { user_id: 1, nickname: 'ada' },
            personal_data: { office_mode: 'specific', office: 'Poway' },
            priority: { bid: 200, currency: 'TMC' } },
        },
      }];
      return json(200, { protocol: 'RQP/1', kind: 'client.sync', poll_after_ms: 1000, site_url: base,
        user: { id: 1, nickname: 'ada', balance: 2300, escrow: 200 },
        positions: [], handoffs, settled: [], reports: [], reads: [], reader: { mode: 'apps', last: null } });
    });
  });
  const port = await listen(server);
  return { server, seen, port };
}

test("the app's robot books the person's slot once they let it, and the page opens when it cannot",
  { timeout: 180000 }, async (t) => {
  const electron = electronPath();
  const display = xvfb();
  if (!electron || !fs.existsSync(electron)) return t.skip('electron is not installed (npm install)');
  if (!display.ok) return t.skip('no display: install xvfb or set DISPLAY');
  if (!fs.existsSync(path.join(DMQ, 'bin', 'rqp-handler.js'))) return t.skip('no ../dmq checkout');

  const dmv = await dmvStub();
  const book = async (outcome, options, { agreed = true, exitAfter = 10000, delayMs = 0 } = {}) => {
    const site = await bookingSite(dmv.base, options);
    const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'regbot-smoke-book-'));
    seedProfile(userData, { first_name: 'Ada', last_name: 'Lovelace', email: 'ada@example.test', phone: '5555550123' });
    // Settings → Let the app book for me, ticked.
    if (agreed) fs.writeFileSync(path.join(userData, 'regbot.json'), JSON.stringify({ v: 2, robotBooking: true }));
    try {
      const started = Date.now();
      const result = await runApp({ electron, display, port: site.port, userData, exitAfter,
        extraEnv: { REGBOT_ROBOT_SIMULATE: '1', REGBOT_ROBOT_OUTCOME: outcome,
          ...(delayMs ? { REGBOT_ROBOT_DELAY_MS: String(delayMs) } : {}) } });
      return { result, seen: site.seen, userData, port: site.port, ms: Date.now() - started };
    } finally {
      site.server.close();
    }
  };
  try {
    // Not let to book for them: the page opens at once, and nothing is claimed or run.
    const asked = await book('BOOKED_SUCCESS', {}, { agreed: false });
    assert.deepEqual(asked.seen.claims, []);
    assert.deepEqual(asked.seen.booked, []);
    assert.equal(asked.result.robots.lastBooking, null);
    assert.equal(asked.result.tabs.length, 1, JSON.stringify(asked.result.tabs));
    assert.equal(asked.result.tabs[0].kind, 'handoff');
    assert.equal(asked.result.tabs[0].jobId, 77);

    // Booked by hand in that tab: the booking site's confirmation number is said for them.
    const byHand = await book('BOOKED_SUCCESS',
      { openUrl: `${dmv.base}/portal/appointments/confirmation?ref=TS-ABCD1234` }, { agreed: false });
    assert.deepEqual(byHand.seen.claims, []);
    assert.deepEqual(byHand.seen.booked, [{ confirmation: 'TS-ABCD1234' }]);
    assert.equal(byHand.result.tabs.length, 1, 'the page stays open');

    // Booked: claimed, booked with the DMV's own number — and the turn's page
    // opened all the same, saying so, with the DMV's confirmation in a tab beside it.
    const booked = await book('BOOKED_SUCCESS');
    assert.deepEqual(booked.seen.claims, [77], 'claimed before the robot ran');
    assert.equal(booked.seen.booked.length, 1);
    assert.match(booked.seen.booked[0].confirmation, /^SIM-[0-9A-F]{8}$/);
    assert.deepEqual(booked.seen.gone, []);
    assert.equal(booked.result.robots.lastBooking.kind, 'booked');
    assert.equal(booked.result.robots.lastBooking.confirmation, booked.seen.booked[0].confirmation);
    assert.equal(booked.result.robots.booking, null);
    const ref = booked.seen.booked[0].confirmation;
    assert.deepEqual(booked.result.tabs.map((t) => [t.kind, t.jobId]), [['handoff', 77], ['confirmation', null]],
      JSON.stringify(booked.result.tabs));
    assert.equal(booked.result.tabs[1].url, `http://127.0.0.1:9/portal/appointments/confirmation?ref=${ref}`);
    assert.deepEqual(booked.result.cards, [{ jobId: 77, kind: 'booked' }], 'the page says it is booked');
    const replay = JSON.parse(fs.readFileSync(path.join(booked.userData, 'robots', 'rqp-bookings.json'), 'utf8'));
    assert.deepEqual(Object.keys(replay), [`127.0.0.1:${booked.port}/rqp1-job-77-20260926101500`],
      'the replay key names the site it came from');

    // The robot could not finish: the page opens for the person, as a hand-off always has.
    const stopped = await book('FOUND_AND_STOPPED');
    assert.deepEqual(stopped.seen.claims, [77]);
    assert.deepEqual(stopped.seen.booked, []);
    assert.equal(stopped.result.robots.lastBooking.kind, 'page');
    assert.equal(stopped.result.tabs.length, 1, JSON.stringify(stopped.result.tabs));
    assert.deepEqual(stopped.result.cards, [], 'uncovered: the page is theirs to book on');
    assert.equal(stopped.result.tabs[0].kind, 'handoff');
    assert.equal(stopped.result.tabs[0].jobId, 77);

    // Another of the person's devices has it: this one stands back, until that
    // one goes quiet, and then takes it over and books it.
    const quiet = await book('BOOKED_SUCCESS', { quietAfter: 2 });
    assert.deepEqual(quiet.seen.claims, [77]);
    assert.ok(quiet.seen.claimedAtSync > 2, `not claimed while the other device was on it (sync ${quiet.seen.claimedAtSync})`);
    assert.equal(quiet.seen.booked.length, 1);
    assert.deepEqual(quiet.result.tabs.map((t) => t.kind), ['handoff', 'confirmation']);

    // Gone by the time the robot got there: the site hears so, and no page opens.
    const gone = await book('SLOT_GONE');
    assert.equal(gone.seen.gone.length, 1);
    assert.match(gone.seen.gone[0].reason, /no longer listed/);
    assert.deepEqual(gone.seen.booked, []);
    assert.equal(gone.result.robots.lastBooking.kind, 'gone');
    assert.deepEqual(gone.result.tabs.map((t) => t.kind), ['handoff'], 'the page stays, uncovered');
    assert.deepEqual(gone.result.cards, []);

    // Closed while the robot books: the app waits for it, tells the site it is
    // booked, and only then goes. Stopped part way, the robot could book the
    // slot with nobody left to say so, and the turn would run out as missed.
    const closed = await book('BOOKED_SUCCESS', {}, { exitAfter: 4000, delayMs: 9000 });
    assert.equal(closed.result.robots.booking && closed.result.robots.booking.job_id, 77,
      'still booking when it was told to close');
    assert.deepEqual(closed.seen.claims, [77]);
    assert.equal(closed.seen.booked.length, 1, 'the site heard it was booked');
    assert.match(closed.seen.booked[0].confirmation, /^SIM-[0-9A-F]{8}$/);
    assert.ok(closed.ms > 9000, `the app went only once the robot was done (${closed.ms} ms)`);
    // Each robot run is written down in the logs, the booking's with what it was asked and answered.
    const runs = fs.readdirSync(path.join(closed.userData, 'logs', 'robots'));
    assert.equal(runs.length, 1, runs.join(', '));
    const run = JSON.parse(fs.readFileSync(path.join(closed.userData, 'logs', 'robots', runs[0], 'run.json'), 'utf8'));
    assert.equal(run.kind, 'book');
    assert.equal(run.answer.confirmation, closed.seen.booked[0].confirmation);
    const robotsDir = path.join(closed.userData, 'robots');
    assert.deepEqual(fs.readdirSync(robotsDir).filter((f) => f.endsWith('.running')), [], 'no booking left half done');
    const made = JSON.parse(fs.readFileSync(path.join(robotsDir, 'rqp-bookings.json'), 'utf8'));
    assert.equal(Object.values(made)[0].confirmation, closed.seen.booked[0].confirmation);
  } finally {
    dmv.server.close();
  }
});
