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
  // Windows and macOS always have a desktop to draw on, even for a session over SSH.
  if (process.platform === 'win32' || process.platform === 'darwin') return { ok: true, prefix: [] };
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
        /** Any other DevTools command, its answer as it came. */
        send: (method, params) => call(method, params),
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
  // File ends with Exit on Windows and Linux; on macOS it closes the window, and
  // quitting is in the app's own menu, first.
  if (process.platform === 'darwin') {
    assert.ok(file.items.some((i) => /Close Window/.test(i)), `File ends with Close Window: ${file.items}`);
    assert.ok(result.menu[0].items.some((i) => /^Quit /.test(i)), `the app menu offers Quit: ${result.menu[0].items}`);
  } else {
    assert.ok(file.items.some((i) => /E&?xit|close/.test(i)), `File ends with Exit: ${file.items}`);
  }
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

/**
 * A site that hands this person turn after turn, on three lines, as a busy
 * line does: three at once (lines A, B and C), then each over — B's gone from
 * the sync, A's and C's to somebody else first — then the next turns on A and
 * C. Times run from its first sync. Each turn's page names its job.
 */
async function turnsSite(dmvBase) {
  const seen = { syncs: 0, t0: null };
  const turn = (job, queueId, name, over) => ({
    job_id: job, bid_id: job, queue_id: queueId, queue_name: name, queue_slug: name.toLowerCase(), site_slug: 'ca-dmv',
    site_name: 'California DMV', connector: 'dmv.ca.gov.qmatic', phase: 'booking',
    slot: { office_code: 'POWAY', office_name: 'Poway', date: '2026-10-06', time: '10:00', miles: 3.1 },
    open_url: `${dmvBase}/portal/appointments/select-date?branch=POWAY&job=${job}`,
    deadline: null, seconds_left: 280, since: null, rank_at: 1, amount: 200, message: 'Your turn', needs: [],
    missed: { refund_percent: 70, refund: 140, kept: 60 },
    wave: { place: 2, of: 3 }, over: over ? { kind: 'taken', message: '#1 booked it first.' } : null,
  });
  const server = http.createServer((req, res) => {
    const base = `http://127.0.0.1:${server.address().port}`;
    const json = (code, o) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    const url = new URL(req.url, base);
    if (url.pathname === '/api/client/sites') return json(200, { protocol: 'RQP/1', sites: [] });
    if (url.pathname !== '/api/client/sync') return json(404, { error: 'no' });
    seen.syncs += 1;
    if (seen.t0 === null) seen.t0 = Date.now();
    const t = Date.now() - seen.t0;
    const handoffs = t < 3000 ? [turn(83, 10, 'B'), turn(81, 9, 'A'), turn(84, 11, 'C')]
      : t < 7000 ? [turn(81, 9, 'A', true), turn(84, 11, 'C', true)]
        : [turn(82, 9, 'A'), turn(85, 11, 'C')];
    return json(200, { protocol: 'RQP/1', kind: 'client.sync', poll_after_ms: 700, site_url: base,
      user: { id: 1, nickname: 'ada', balance: 2300, escrow: 600 },
      positions: [], handoffs, settled: [], reports: [], reads: [], reader: { mode: 'apps', last: null } });
  });
  const port = await listen(server);
  return { server, seen, port };
}

test('turns\' tabs do not pile up: the next turn on a line takes the last one\'s unused tab, an unused one closes, a used one stays',
  { timeout: 120000 }, async (t) => {
  const electron = electronPath();
  const display = xvfb();
  if (!electron || !fs.existsSync(electron)) return t.skip('electron is not installed (npm install)');
  if (!display.ok) return t.skip('no display: install xvfb or set DISPLAY');

  const dmv = await dmvStub();
  t.after(() => dmv.server.close());
  const site = await turnsSite(dmv.base);
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'regbot-smoke-turns-'));
  seedProfile(userData, { first_name: 'Ada', last_name: 'Lovelace', email: 'ada@example.test', phone: '5555550123' });
  // A spare tab closes 6 s after its turn here, not 15 minutes.
  const run = startApp({ electron, display, port: site.port, userData, exitAfter: 20000,
    extra: ['--remote-debugging-port=0'], extraEnv: { REGBOT_TURN_TAB_MS: '6000' } });
  let page = null;
  let result;
  try {
    // The person clicks in C's page while it is their turn there.
    const devPort = Number(await until(() => fs.readFileSync(path.join(userData, 'DevToolsActivePort'), 'utf8').split('\n')[0], 30000, 'DevTools'));
    page = await pageWhere(devPort, (u) => u.includes('job=84'), 'turn 84\'s page');
    await until(() => page.evaluate("document.readyState === 'complete'"), 15000, 'turn 84\'s page loaded');
    for (const type of ['mousePressed', 'mouseReleased']) {
      await page.send('Input.dispatchMouseEvent', { type, x: 40, y: 40, button: 'left', clickCount: 1 });
    }
    result = await run.result;
  } finally {
    if (page) page.close();
    if (run.child.exitCode === null) run.child.kill();
    site.server.close();
  }

  const turns = result.tabs.filter((x) => x.kind === 'handoff');
  // A's second turn in A's first turn's tab; B's tab closed; C's used tab kept beside C's second turn's.
  assert.deepEqual(turns.map((x) => x.jobId).sort(), [82, 84, 85], JSON.stringify(result.tabs));
  assert.equal(result.tabs.length, 3, JSON.stringify(result.tabs));
  assert.equal(turns.find((x) => x.jobId === 84).touched, true, 'the click made C\'s first page the person\'s');
  assert.equal(turns.find((x) => x.jobId === 82).touched, false);
  assert.match(turns.find((x) => x.jobId === 82).url, /job=82$/, 'the reused tab is on the new turn\'s page');

  const logs = path.join(userData, 'logs');
  const pages = fs.readdirSync(logs).filter((f) => f.startsWith('pages-'))
    .flatMap((f) => fs.readFileSync(path.join(logs, f), 'utf8').trim().split('\n')).map((l) => JSON.parse(l));
  const tabOf = (job) => (pages.find((r) => r.type === 'opened' && r.job === job) || {}).tab;
  const reused = pages.filter((r) => r.type === 'reused');
  assert.deepEqual(reused.map((r) => [r.from, r.job, r.tab]), [[81, 82, tabOf(81)]], JSON.stringify(reused));
  assert.equal(turns.find((x) => x.jobId === 82).id, tabOf(81), 'the same tab, not a new one');
  assert.ok(!pages.some((r) => r.type === 'opened' && r.job === 82), 'no tab was opened for A\'s second turn');
  assert.ok(pages.some((r) => r.type === 'opened' && r.job === 85), 'C\'s second turn has a tab of its own');
  const closing = pages.filter((r) => r.type === 'closing');
  assert.deepEqual(closing.map((r) => [r.job, r.tab]), [[83, tabOf(83)]], JSON.stringify(closing));
  assert.ok(pages.some((r) => r.type === 'closed' && r.tab === tabOf(83)), 'B\'s tab went');
  assert.ok(pages.some((r) => r.type === 'used' && r.job === 84));
  assert.deepEqual(pages.filter((r) => r.type === 'over').map((r) => [r.job, r.how]).sort(),
    [[81, 'taken'], [83, 'gone'], [84, 'taken']]);

  // A turn this computer's robot booked: its page goes once the turn is over,
  // and the DMV's confirmation, in a tab of its own, stays.
  if (!fs.existsSync(path.join(DMQ, 'bin', 'rqp-handler.js'))) return t.diagnostic('no ../dmq checkout: the robot part is skipped');
  const bookingStub = await bookingSite(dmv.base);
  const robotData = fs.mkdtempSync(path.join(os.tmpdir(), 'regbot-smoke-turns-robot-'));
  seedProfile(robotData, { first_name: 'Ada', last_name: 'Lovelace', email: 'ada@example.test', phone: '5555550123' });
  fs.writeFileSync(path.join(robotData, 'regbot.json'), JSON.stringify({ v: 2, robotBooking: true }));
  let booked;
  try {
    booked = await runApp({ electron, display, port: bookingStub.port, userData: robotData, exitAfter: 16000,
      extraEnv: { REGBOT_ROBOT_SIMULATE: '1', REGBOT_ROBOT_OUTCOME: 'BOOKED_SUCCESS', REGBOT_TURN_TAB_MS: '3000' } });
  } finally {
    bookingStub.server.close();
  }
  assert.equal(bookingStub.seen.booked.length, 1);
  assert.deepEqual(booked.tabs.map((x) => x.kind), ['confirmation'], JSON.stringify(booked.tabs));
  assert.match(booked.tabs[0].url, new RegExp(`confirmation\\?ref=${bookingStub.seen.booked[0].confirmation}$`));
  return undefined;
});

/**
 * A site with one live bid on one line, for changing it: the board, a quote
 * for whatever is asked (a wider range or the bid as it is), and the change.
 * It keeps what the app sent to each.
 */
async function bidChangeStub() {
  const seen = { quotes: [], changes: [] };
  const place = { office_mode: 'radius', origin: '95050', origin_label: '95050', radius_miles: 5 };
  const mine = { bid_id: 5, rank: 3, amount: 160, status: 'active', note: '', preferred_date: '2026-10-20',
    preferred_time: '11:30', if_passed: '1d', raises: 0, place };
  const option = (amount, label, rivals, first) => ({ amount, delta: amount - 160, label, afford: true,
    standing: { amount, rank: rivals + 1, field: 4, rivals_ahead: rivals, in_pool: true, scouted: 1, offices: 1, running: true, above: rivals },
    outlook: { turns: 4, fitting: 40, thin: false, first_turn_s: first, likely_s: first, chance: 1, office_name: 'Santa Clara', lead_s: 86400 } });
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const json = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    const read = () => new Promise((resolve) => { let b = ''; req.on('data', (d) => { b += d; }); req.on('end', () => resolve(b ? JSON.parse(b) : {})); });
    if (url.pathname === '/api/client/sites') return json(200, { protocol: 'RQP/1', sites: [] });
    if (url.pathname === '/api/client/sync') {
      return json(200, { protocol: 'RQP/1', poll_after_ms: 1500, user: { id: 1, nickname: 'ada', balance: 840, escrow: 160 },
        positions: [{ bid_id: 5, queue_id: 9, queue_name: 'Driver licence or ID card', site_slug: 'ca-dmv', site_name: 'California DMV', rank: 3, field_size: 4, amount: mine.amount, status: 'active', note: '', preferred_date: mine.preferred_date, preferred_time: mine.preferred_time, if_passed: '1d', window: ['2026-10-01', '2026-12-31'], hours: ['08:00', '17:00'] }],
        handoffs: [], settled: [], reports: [] });
    }
    if (url.pathname === '/api/client/queues/9') {
      return json(200, { protocol: 'RQP/1', kind: 'client.board',
        queue: { id: 9, slug: 'license-id', name: 'Driver licence or ID card', description: '', status: 'open', window: ['2026-10-01', '2026-12-31'],
          hours: ['08:00', '17:00'], weekdays: 'Mon–Fri', timezone: 'America/Los_Angeles', min_bid: 45, slots_per_cycle: 2, cycle_seconds: 80,
          dispatch: 'offers', site_slug: 'ca-dmv', site_name: 'California DMV', accent: '#0b63d6', connector: 'dmv.ca.gov.qmatic', mock: false, next_dispatch_in: 30 },
        bids: [
          { rank: 1, bid_id: 2, nickname: 'bo', amount: 300, status: 'active', bot: false, mine: false, raises: 0, preferred_date: '2026-10-22', preferred_time: '09:00', if_passed: '1d', age: '1h' },
          { rank: 2, bid_id: 3, nickname: 'cy', amount: 200, status: 'active', bot: false, mine: false, raises: 0, preferred_date: '2026-10-22', preferred_time: '09:00', if_passed: '1d', age: '1h' },
          { rank: 3, bid_id: 5, nickname: 'ada', amount: mine.amount, status: 'active', bot: false, mine: true, raises: 0, preferred_date: mine.preferred_date, preferred_time: mine.preferred_time, if_passed: '1d', age: '1h' },
          { rank: 4, bid_id: 4, nickname: 'di', amount: 70, status: 'active', bot: false, mine: false, raises: 0, preferred_date: '2026-10-22', preferred_time: '09:00', if_passed: '1d', age: '2h' }],
        mine, handoff: null, field_size: 4, to_lead: 301, min_raise: 5, default_date: '2026-10-21', fields: [], kept_on_device: [], portal_url: 'http://127.0.0.1:9/' });
    }
    if (url.pathname === '/api/client/bids/5/quote') {
      return read().then((body) => {
        seen.quotes.push(body);
        const wider = body.fields && body.fields.radius_miles;
        const options = wider
          ? [option(45, 'less', 0, 300), option(160, 'current', 0, 300)]
          : [option(71, 'less', 0, 600), option(160, 'current', 0, 600), option(201, 'more', 1, 600)];
        const pick = wider ? 45 : 71;
        json(200, { protocol: 'RQP/1', kind: 'client.quote', bid_id: 5, queue_id: 9, amount: 160, status: 'active', locked: false,
          balance: 840, min_bid: 45, min_raise: 5, lowers_left: 3,
          change: wider ? { words: [`offices within ${wider} miles of 95050`], place: { ...place, radius_miles: wider }, preferred: null, if_passed: null } : null,
          now: options[1], proposed: wider ? options[1] : null, options,
          suggested: { kind: 'refund', amount: pick, delta: pick - 160, reason: wider ? 'wait' : 'standing',
            why: wider ? `With this change, ⧗${pick} should get a booking in about 5 minutes, no later than ⧗160 does now, so ⧗${160 - pick} can come back.`
              : 'Lower it to ⧗71 and get ⧗89 back: you stay first for openings at your offices, and the wait stays the same.' },
          rivals: { ahead: [], behind: [{ nickname: 'di', amount: 70, rank: 4 }] },
          basis: { days: 7, openings: 412, booked_share: 0.9, scout_cap: 12, horizon_days: 28 } });
      });
    }
    if (url.pathname === '/api/client/bids/5/change') {
      return read().then((body) => {
        seen.changes.push(body);
        mine.amount = body.amount || mine.amount;
        if (body.fields) place.radius_miles = body.fields.radius_miles;
        json(200, { ok: true, bid_id: 5, queue_id: 9, amount: mine.amount, delta: mine.amount - 160, rank: 3, balance: 840 + 160 - mine.amount,
          message: `Now offices within ${place.radius_miles} miles of 95050. Lowered to ⧗${mine.amount}: ⧗${160 - mine.amount} is back in your balance. You are at position 3.` });
      });
    }
    res.writeHead(404); res.end();
    return undefined;
  });
  const port = await listen(server);
  return { server, seen, port };
}

test('a bid is changed from its board: priced as it is, priced wider, then saved wider and cheaper',
  { timeout: 120000 }, async (t) => {
  const electron = electronPath();
  const display = xvfb();
  if (!electron || !fs.existsSync(electron)) return t.skip('electron is not installed (npm install)');
  if (!display.ok) return t.skip('no display: install xvfb or set DISPLAY');
  const { server, seen, port } = await bidChangeStub();
  t.after(() => server.close());
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'regbot-smoke-change-'));
  const run = startApp({ electron, display, port, userData, exitAfter: 20000,
    extra: ['--remote-debugging-port=0', '--page=board:9'] });
  let ui = null;
  try {
    const devPort = Number(await until(() => fs.readFileSync(path.join(userData, 'DevToolsActivePort'), 'utf8').split('\n')[0], 30000, 'DevTools'));
    ui = await pageWhere(devPort, (u) => u.endsWith('/ui/index.html'), 'the app page');
    await until(() => ui.evaluate("Boolean(document.getElementById('change-open'))"), 30000, 'the board with a change button');
    await ui.evaluate("document.getElementById('change-open').click()");

    // As it is: the site says what the place needs, and offers it.
    const said = () => ui.evaluate("(document.getElementById('changeQuote') || {}).innerText || ''");
    assert.match(await until(async () => { const s = await said(); return /get ⧗89 back/.test(s) && s; }, 15000, 'the first quote'),
      /First, for less[\s\S]*⧗89 back/);
    assert.deepEqual(seen.quotes[0], {}, 'priced as it is');
    const save = () => ui.evaluate("document.getElementById('change-save').textContent");
    assert.equal(await save(), 'Nothing changed yet');
    assert.equal(await ui.evaluate("document.getElementById('change-save').disabled"), true);

    // Wider: offered only wider ranges, priced again, and the site's pick taken.
    const ranges = await ui.evaluate("[...document.querySelectorAll('#changePanel [data-change=place] option')].map((o) => o.value)");
    assert.deepEqual(ranges, ['', '10', '15', '25', '40', '60', '100', '150', '250']);
    await ui.evaluate(`(() => { const s = document.querySelector('#changePanel [data-change=place]'); s.value = '15'; s.dispatchEvent(new Event('change')); })()`);
    await until(() => seen.quotes.length >= 2, 10000, 'the wider quote');
    assert.deepEqual(seen.quotes[1], { fields: { radius_miles: 15 } });
    assert.match(await until(async () => { const s = await said(); return /⧗115 can come back/.test(s) && s; }, 10000, 'the wider quote shown'),
      /no later than ⧗160 does now/);
    await ui.evaluate("[...document.querySelectorAll('#changeQuote button')].find((b) => /^Use ⧗45/.test(b.textContent)).click()");
    assert.equal(await ui.evaluate("document.querySelector('#changePanel [data-change=amount]').value"), '45');
    assert.equal(await save(), 'Save the change · ⧗115 back');

    await ui.evaluate("document.getElementById('change-save').click()");
    await until(() => seen.changes.length === 1, 10000, 'the change sent');
    assert.deepEqual(seen.changes[0], { fields: { radius_miles: 15 }, amount: 45, expect_amount: 160 });
    assert.match(await until(async () => { const s = await ui.evaluate("document.getElementById('toasts').innerText"); return /back in your balance/.test(s) && s; }, 10000, 'the toast'),
      /Now offices within 15 miles of 95050\. Lowered to ⧗45/);
    assert.equal(await until(() => ui.evaluate("!document.getElementById('changePanel') && document.getElementById('myAmount').textContent"), 10000, 'the board again'), '⧗45');
  } finally {
    if (ui) ui.close();
  }
  const result = await run.result;
  assert.equal(result.server, `http://127.0.0.1:${port}`);
});

/**
 * A regbot site whose bid widened by itself, with a suggestion and a best way
 * to ask for it, and a second line to join, where the form gets three ways to
 * ask (the site's widen.py, advice.py and outlook.py).
 */
async function outlookStub() {
  const seen = { options: [], prefs: [], advice: [] };
  let autoWiden = true;
  const widened = { key: 'w:7', bid_id: 5, queue_id: 8, queue_name: 'REAL ID application', from_if_passed: '5d',
    if_passed: '2w', until: '2026-11-03 11:30', at: '2026-10-25T18:31:00Z', chance: 0.99, chance_until: '2026-11-03 11:30' };
  const advice = { bid_id: 5, queue_id: 8, queue_name: 'REAL ID application', kind: 'reach', key: '5:reach:1mo',
    title: 'What would have worked', action: 'Look 1 month out', change: { if_passed: '1mo' }, if_passed: '1mo',
    text: 'In the last 2 days, 4 openings from Mon Oct 26 to Thu Oct 29 came up at your offices, later than your reach.',
    office_name: 'San Jose', slot_date: '2026-10-26', slot_time: '10:50' };
  const best = { bid_id: 5, queue_id: 8, queue_name: 'REAL ID application', kind: 'config', key: '5:config:v1:2w',
    title: 'Best bet', action: 'Use this', text: 'Within 15 mi of 95050, anything up to Thu Oct 29 at 12:00, then 2 weeks more: about 97%.',
    change: { preferred_date: '2026-10-29', preferred_time: '12:00', if_passed: '2w' }, slot_date: '2026-10-29', slot_time: '12:00' };
  const option = (label, date, time, chance, place) => ({ key: `v0:${date}T${time}:1d`, label, place, preferred_date: date, preferred_time: time,
    if_passed: '1d', until: `${date} ${time}`, chance, likely_by: null, place_text: place ? 'Within 15 mi of 95050' : 'Within 10 mi of 95050' });
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const json = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    const read = () => new Promise((resolve) => { let b = ''; req.on('data', (d) => { b += d; }); req.on('end', () => resolve(b ? JSON.parse(b) : {})); });
    if (url.pathname === '/api/client/sites') return json(200, { protocol: 'RQP/1', sites: [] });
    if (url.pathname === '/api/client/sync') {
      return json(200, { protocol: 'RQP/1', poll_after_ms: 1500, user: { id: 1, nickname: 'ada', balance: 455, escrow: 45 },
        positions: [{ bid_id: 5, queue_id: 8, queue_name: 'REAL ID application', site_slug: 'ca-dmv', site_name: 'California DMV', rank: 1, field_size: 1,
          amount: 45, status: 'active', note: '', preferred_date: '2026-10-20', preferred_time: '11:30', if_passed: '2w', auto_widen: autoWiden,
          widened_at: '2026-10-25T18:31:00Z', window: ['2026-10-01', '2026-12-31'], hours: ['08:00', '17:00'] }],
        handoffs: [], settled: [], reports: [], advice, best, widened: [widened], prefs: { auto_widen: autoWiden } });
    }
    if (url.pathname === '/api/client/queues/9') {
      return json(200, { protocol: 'RQP/1', kind: 'client.board',
        queue: { id: 9, slug: 'license-id', name: 'Driver licence or ID card', description: '', status: 'open', window: ['2026-10-01', '2026-12-31'],
          hours: ['08:00', '17:00'], weekdays: 'Mon–Fri', timezone: 'America/Los_Angeles', min_bid: 45, slots_per_cycle: 2, cycle_seconds: 80,
          dispatch: 'offers', site_slug: 'ca-dmv', site_name: 'California DMV', accent: '#0b63d6', connector: 'dmv.ca.gov.qmatic', mock: false, next_dispatch_in: 30 },
        bids: [], mine: null, handoff: null, field_size: 0, to_lead: 45, min_raise: 5, default_date: '2026-10-27',
        fields: [
          { key: 'office_mode', label: 'Which offices will you accept?', type: 'select', required: true,
            options: [{ label: 'One specific office', value: 'specific' }, { label: 'Any office within range of me', value: 'radius' }] },
          { key: 'origin', label: 'Measure the range from', type: 'text', required: true, when: { key: 'office_mode', equals: 'radius' } },
          { key: 'radius_miles', label: 'Within', type: 'number', required: true, when: { key: 'office_mode', equals: 'radius' } }],
        kept_on_device: [], prefs: { auto_widen: autoWiden }, portal_url: 'http://127.0.0.1:9/' });
    }
    if (url.pathname === '/api/client/queues/9/options') {
      return read().then((body) => {
        seen.options.push(body);
        json(200, { protocol: 'RQP/1', kind: 'client.options', queue_id: 9,
          draft: { chance: 0.04, until: '2026-10-28 17:00', likely_by: null, place_text: 'Within 10 mi of 95050', offices: 3 },
          options: [option('Soonest likely', '2026-10-29', '09:00', 0.83, null), option('Best bet', '2026-10-29', '12:00', 0.87, null),
            option('Surest', '2026-10-30', '09:00', 0.99, { office_mode: 'radius', origin: '95050', radius_miles: 15 })],
          basis: { days: 7, openings: 198, offices: 3, offices_seen: 3, rough: false } });
      });
    }
    if (url.pathname === '/api/client/preferences') {
      return read().then((body) => {
        seen.prefs.push(body);
        autoWiden = Boolean(body.auto_widen);
        json(200, { ok: true, prefs: { auto_widen: autoWiden }, bids_changed: 1,
          message: autoWiden ? 'Your bids widen by themselves once their time passes.' : 'Your bids no longer widen by themselves.' });
      });
    }
    if (url.pathname === '/api/client/bids/5/advice') {
      return read().then((body) => { seen.advice.push(body); json(200, { ok: true, bid_id: 5, queue_id: 8, message: 'Now then within 1 month.' }); });
    }
    res.writeHead(404); res.end();
    return undefined;
  });
  const port = await listen(server);
  return { server, seen, port };
}

test('a bid that widened by itself says so on top, with the suggestion and the best bet under it; the join form offers three ways; Settings switches it',
  { timeout: 120000 }, async (t) => {
  const electron = electronPath();
  const display = xvfb();
  if (!electron || !fs.existsSync(electron)) return t.skip('electron is not installed (npm install)');
  if (!display.ok) return t.skip('no display: install xvfb or set DISPLAY');
  const { server, seen, port } = await outlookStub();
  t.after(() => server.close());
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'regbot-smoke-outlook-'));
  const run = startApp({ electron, display, port, userData, exitAfter: 25000,
    extra: ['--remote-debugging-port=0', '--page=board:9'] });
  let ui = null;
  try {
    const devPort = Number(await until(() => fs.readFileSync(path.join(userData, 'DevToolsActivePort'), 'utf8').split('\n')[0], 30000, 'DevTools'));
    ui = await pageWhere(devPort, (u) => u.endsWith('/ui/index.html'), 'the app page');

    // The bars, in order: what happened, then what to do, then the best way to ask.
    const rows = await until(async () => {
      const got = await ui.evaluate("[...document.querySelectorAll('#banner .banner-row')].map((r) => r.querySelector('.text b').textContent)");
      return got.length === 3 && got;
    }, 30000, 'three bars');
    assert.deepEqual(rows, ['Your bid widened by itself', 'What would have worked', 'Best bet']);
    const top = await ui.evaluate("document.querySelector('#banner .banner-row.widened').innerText");
    assert.match(top, /looks 2 weeks past your time instead of 5 days/);
    assert.match(top, /about 99% chance of an appointment/);
    assert.match(top, /Settings → Bidding/);

    // The join form asks how each way would do, and one fills it in.
    const box = () => ui.evaluate("(document.getElementById('bidOptions') || {}).innerText || ''");
    assert.match(await until(async () => { const s = await box(); return /Surest/.test(s) && s; }, 15000, 'three ways to ask'),
      /under 5%[\s\S]*Soonest likely[\s\S]*about 83%[\s\S]*Best bet[\s\S]*Surest[\s\S]*about 99%/);
    assert.deepEqual(Object.keys(seen.options[0]).sort(), ['amount', 'fields', 'if_passed', 'preferred_date', 'preferred_time']);
    assert.equal(await ui.evaluate("document.getElementById('join-autowiden').checked"), true, 'on, as the person chose');
    await ui.evaluate("document.querySelectorAll('#bidOptions [data-option]')[2].click()");
    const filled = await ui.evaluate("(() => { const f = document.getElementById('bidForm'); return ['office_mode', 'origin', 'radius_miles', 'preferred_date', 'preferred_time', 'if_passed'].map((n) => f.querySelector(`[name=${n}]`).value); })()");
    assert.deepEqual(filled, ['radius', '95050', '15', '2026-10-30', '09:00', '1d']);
    await until(() => seen.options.some((o) => o.preferred_date === '2026-10-30' && o.fields.radius_miles === '15'), 10000, 'the filled form asked about');

    // The suggestion is applied by its key.
    await ui.evaluate("[...document.querySelectorAll('#banner .banner-row')][1].querySelector('[data-act=apply]').click()");
    await until(() => seen.advice.length === 1, 10000, 'the suggestion applied');
    assert.deepEqual(seen.advice[0], { key: '5:reach:1mo' });

    // Settings → Bidding, from the bar, turns it off for every bid.
    await ui.evaluate("document.querySelector('#banner .banner-row.widened [data-act=settings]').click()");
    await until(() => ui.evaluate("Boolean(document.getElementById('s-autowiden'))"), 10000, 'Settings → Bidding');
    assert.equal(await ui.evaluate("document.getElementById('s-autowiden').checked"), true);
    await ui.evaluate("document.getElementById('s-autowiden').click()");
    await until(() => seen.prefs.length === 1, 10000, 'the choice sent');
    assert.deepEqual(seen.prefs[0], { auto_widen: false });

    // Closing the widening bar keeps it closed.
    await ui.evaluate("document.querySelector('#banner .banner-row.widened [data-act=dismiss]').click()");
    await new Promise((r) => setTimeout(r, 2500));
    assert.equal(await ui.evaluate("document.querySelectorAll('#banner .banner-row.widened').length"), 0);
  } finally {
    if (ui) ui.close();
  }
  const result = await run.result;
  assert.equal(result.server, `http://127.0.0.1:${port}`);
});

/**
 * A regbot site that asks for the app's trace: every sync answers how far it has
 * it, and once the app has a turn's worth written down, asks for it — once —
 * and takes the gzipped answer, as lineright-server's traces.py does.
 */
async function tracingSite(bookingBase) {
  const zlib = require('node:zlib');
  const seen = { syncs: [], uploads: [], asked: null };
  const ASK = 'abcdef0123456789';
  let acked = 0;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      const json = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
      if (req.headers.authorization !== 'Bearer smoke-token') return json(401, { error: 'nope' });
      if (url.pathname === '/api/client/sync') {
        const body = JSON.parse(raw.toString() || '{}');
        const said = body.traces || null;
        seen.syncs.push(said);
        const traces = said ? { level: 'full', stream: said.stream, acked } : undefined;
        // Asked for once, when the turn's page has had time to load.
        if (said && !seen.asked && seen.syncs.length >= 4 && said.next > 10) {
          seen.asked = { at: seen.syncs.length, next: said.next };
          traces.ask = { id: ASK, after: acked, max_events: 5000, max_kb: 1024 };
        }
        return json(200, {
          protocol: 'RQP/1', poll_after_ms: 1000, user: { id: 1, nickname: 'ada', balance: 100, escrow: 0 },
          positions: [], settled: [], reports: [], traces,
          handoffs: [{ job_id: 77, bid_id: 5, queue_id: 9, queue_name: 'REAL ID', queue_slug: 'real-id', site_slug: 'ca-dmv',
            site_name: 'California DMV', phase: 'booking', slot: { office_code: 'POWAY', office_name: 'Poway', date: '2026-10-06', time: '10:00' },
            open_url: `${bookingBase}/portal/appointments/review?branch=POWAY&email=ada%40example.test`, deadline: null,
            seconds_left: 280, since: null, rank_at: 1, amount: 200, message: 'Your turn', needs: [] }],
        });
      }
      if (url.pathname === '/api/client/traces') {
        const body = JSON.parse((req.headers['content-encoding'] === 'gzip' ? zlib.gunzipSync(raw) : raw).toString());
        seen.uploads.push({ encoding: req.headers['content-encoding'], bytes: raw.length, text: JSON.stringify(body), body });
        if (body.ask !== ASK) return json(409, { error: 'This site did not ask for that.' });
        acked = body.last;
        return json(200, { ok: true, stream: body.stream, acked, kept: body.events.length, more: body.more });
      }
      if (url.pathname === '/api/client/sites') return json(200, { protocol: 'RQP/1', sites: [] });
      return json(404, { error: 'no such route' });
    });
  });
  const port = await listen(server);
  return { server, seen, port, ASK };
}

test('the site asks for the app\'s trace on a sync, and gets it gzipped, with the person taken out',
  { timeout: 90000 }, async (t) => {
    const electron = electronPath();
    const display = xvfb();
    if (!electron || !fs.existsSync(electron)) return t.skip('electron is not installed (npm install)');
    if (!display.ok) return t.skip('no display: install xvfb or set DISPLAY');

    // A booking page that says the person's name back, as a review page does.
    const booking = http.createServer((req, res) => {
      if (req.url.startsWith('/api/')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ times: ['10:00', '10:20'], for: 'Ada Lovelace' }));
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(`<!doctype html><title>Review — Ada Lovelace</title><h2>Check your details, Ada</h2><form>
        <label for="fn">First Name</label><input id="fn" aria-label="First Name">
        <label for="em">Email Address</label><input id="em" aria-label="Email Address">
        <label for="ph">Phone Number</label><input id="ph" aria-label="Phone Number"></form>
        <script>console.error('could not save ada@example.test (555) 555-0123');
          setTimeout(() => fetch('/api/times?date=2026-10-06&email=ada%40example.test'), 300);</script>`);
    });
    const bookingBase = `http://127.0.0.1:${await listen(booking)}`;
    const site = await tracingSite(bookingBase);
    const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'regbot-smoke-trace-'));
    seedProfile(userData, { first_name: 'Ada', last_name: 'Lovelace', dob: '12/10/1815', dl_number: 'A1234567',
      email: 'ada@example.test', phone: '5555550123' });
    const result = await runApp({ electron, display, port: site.port, userData, exitAfter: 12000 });
    site.server.close();
    booking.close();

    // Every sync said how far the trace goes; nothing went up until it was asked for.
    assert.ok(site.seen.syncs.length >= 5, `syncs: ${site.seen.syncs.length}`);
    assert.ok(site.seen.syncs.every((s) => s && /^[0-9a-f]{16}$/.test(s.stream) && s.on === true), JSON.stringify(site.seen.syncs[0]));
    assert.ok(site.seen.asked, 'the site asked');
    assert.equal(site.seen.uploads.length, 1, 'one ask, one upload');
    const [up] = site.seen.uploads;
    assert.equal(up.encoding, 'gzip');
    assert.equal(up.body.schema, 'regbot.app-trace/1');
    assert.deepEqual([up.body.ask, up.body.after, up.body.first], [site.ASK, 0, 1]);
    assert.ok(up.body.last >= site.seen.asked.next - 1, 'all it had when it was asked, at least');

    // A turn's story is in it: the turn, the page opened for it, the page, what was filled in.
    const kinds = up.body.events.map((e) => e.k);
    for (const kind of ['app.start', 'handoff.arrive', 'handoff.take', 'handoff.page', 'tab.open', 'page.go', 'net', 'page.load', 'page.note']) {
      assert.ok(kinds.includes(kind), `${kind} in ${kinds.join(' ')}`);
    }
    const load = up.body.events.find((e) => e.k === 'page.load' && e.job === 77);
    assert.ok(load, 'the turn\'s page load carries the turn');
    assert.equal(load.title, 'Review — [name]', 'the whole name, taken out as one');
    const asked = up.body.events.find((e) => e.k === 'net' && /\/api\/times/.test(e.url));
    assert.ok(asked, 'the page\'s own request, timed');
    assert.match(asked.url, /\/api\/times\?date=2026-10-06&email=\[redacted\]$/);
    assert.equal(asked.st, 200);
    assert.equal(typeof asked.ms, 'number');
    const said = up.body.events.find((e) => e.k === 'page.console');
    assert.equal(said.text, 'could not save [email] [phone]');
    const opened = up.body.events.find((e) => e.k === 'tab.open');
    assert.match(opened.url, /\/portal\/appointments\/review\?branch=POWAY&email=\[redacted\]$/);
    const autofill = up.body.events.find((e) => e.k === 'page.note' && e.type === 'autofill');
    assert.ok(autofill.fields.length >= 3, JSON.stringify(autofill));

    // And none of the person: not their name, their email, their phone, their licence.
    const around = (at) => `…${up.text.slice(Math.max(0, at - 200), at + 80)}…`;
    for (const leak of ['Ada', 'Lovelace', 'ada@example.test', 'ada%40example.test', '5555550123', '555-0123', 'A1234567',
      '12/10/1815', '12%2F10%2F1815', '1815-12-10', '12101815']) {
      const at = up.text.indexOf(leak);
      assert.ok(at < 0, `${leak} is in the upload: ${around(at)}`);
    }
    // The year of birth on its own. A time in milliseconds, a size or the stream's
    // hex id can have those four digits inside it by chance, and is not one.
    const year = /(?<![0-9a-f])1815(?![0-9a-f])/i.exec(up.text);
    assert.ok(!year, `1815 is in the upload: ${year && around(year.index)}`);

    // What the site said it has is gone from the app; numbering carries on.
    assert.equal(result.traces.sent, up.body.last, JSON.stringify(result.traces));
    assert.equal(result.traces.uploads[0].ok, true);
    assert.equal(result.traces.status.acked, up.body.last);
  });
