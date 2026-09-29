'use strict';
/**
 * regbot desktop — the main process.
 *
 * An application, not a browser: its own screens (sites, boards, the
 * console, a profile kept on this machine) drawn from the bundle, fed by a
 * regbot server's JSON API over one device token. A browser only when a
 * booking site needs one — then the same window shows tabs and an address
 * bar over a sandboxed page, and types the person's details into the form
 * for them.
 *
 * The line itself is kept on the regbot site config.json names, which the app
 * signs in to with a code approved on that site — it never sees a password.
 * Its robots look for openings when the site asks (reader.js) and book the
 * person's own slot when it is theirs (booker.js). Settings → Practice on this
 * computer runs the whole of regbot here instead — the website, the queue
 * processor, the DMV robots and the stand-in they practise on (stack.js) —
 * signed in to as the person with no sign-in at all. See ../README.md.
 */
const os = require('node:os');
const path = require('node:path');
const {
  app, BaseWindow, WebContentsView, ipcMain, Menu, Notification, dialog, safeStorage, session,
  shell: osShell,
} = require('electron');

const { Store, bundled } = require('./store');
const serverChoice = require('./server-choice');
const { SyncClient, SyncLoop, NotPaired, diffHandoffs, describeHandoff, clock } = require('./sync');
const { Shell } = require('./shell');
const { Profile, KEYS } = require('./profile');
const browsers = require('./import');
const reimport = require('./reimport');
const needs = require('./needs');
const { buildFillScript, isBookingPage, originOf } = require('./autofill');
const { webPage, paymentPage, approvalPage } = require('./links');
const { prefillFromUrl } = require('./portal');
const menu = require('./menu');
const updater = require('./updater');
const { Stack, locate, NO_SERVER } = require('./stack');
const reset = require('./reset');
const { RobotRunner, isLoopback } = require('./robots');
const { Reader } = require('./reader');
const { Booker } = require('./booker');
const { Pinger } = require('./pinger');
const { Telemetry } = require('./telemetry');

const CHROME_BASE = 98;          // tab strip + address bar + the line, in browser mode
const SITES_EVERY_MS = 10 * 60 * 1000;
// How often to look whether the weekly re-import is due, for an app left running for days.
const IMPORT_AGAIN_CHECK_MS = 30 * 60 * 1000;
// How often this app's own numbers are sampled and saved, and, when its person
// turned sharing on, how often they are shared with the site at most.
const TELEMETRY_EVERY_MS = 60 * 1000;
const AUTO_SHARE_EVERY_S = 6 * 3600;

function parseArgs(args) {
  const out = {};
  for (const arg of args) {
    const m = arg.match(/^--([^=]+)(?:=(.*))?$/);
    if (m) out[m[1]] = m[2] === undefined ? true : m[2];
  }
  return out;
}
const argv = parseArgs(process.argv.slice(app.isPackaged ? 1 : 2));

// People see LineRight Regbot (productName: the window, the installer, the Start
// menu, the Dock). Inside, the app is still regbot: its data folder and the key
// that protects the saved profile are named after it, and a new name there
// would lose both for everybody who updates.
app.setName('regbot');
if (argv['user-data']) app.setPath('userData', path.resolve(argv['user-data']));
if (argv.smoke || process.env.REGBOT_NO_GPU) app.disableHardwareAcceleration();

function log(...parts) {
  console.log(new Date().toISOString().slice(11, 19), ...parts);
  trace(parts.join(' '));
}

// REGBOT_TRACE=<file>: a synchronous, timestamped trace of what the main
// process is doing, for the smoke test and for a report when the app misbehaves
// on a machine where stdout is not to hand.
function trace(text) {
  if (!process.env.REGBOT_TRACE) return;
  try {
    require('node:fs').appendFileSync(process.env.REGBOT_TRACE, `${Date.now() % 100000} ${text}\n`);
  } catch { /* tracing must never be the problem */ }
}

let win = null;
let chrome = null;
let chromeContents = null;        // chrome.webContents, kept: see send()
let tabs = null;
let store = null;
let client = null;
let loop = null;
let profile = null;
let updates = { enabled: false, check: async () => null, install: () => false };
let lastDoc = null;
let updateState = { phase: 'disabled' };
let pairState = { paired: false, user: null, pending: null, message: '' };
let pairing = null;               // { secret, timer } while a code is out
let sitesCache = [];
let sitesTimer = null;
let importAgainTimer = null;
let lastFill = null;
let offered = null;               // what a browser offered, between showing it and agreeing to it
let hasBrowsers = null;           // whether this machine has a browser to import from; null until looked
let lastNavigate = null;   // where the app last sent the person itself, for --smoke
let serverMode = 'builtin';       // 'builtin': the server this app runs; 'remote': a regbot site
let forcedRun = false;            // --server / --practice decided where this run goes
let stack = null;                 // the built-in server, while that is the one in use
let reregistering = false;        // the built-in site is being restarted to learn the app's token again
let closing = false;              // shutdown() has begun
let resetting = false;            // Settings → Start over is under way
let robots = null;                // the DMV robots this app runs for the regbot site (robots.js)
let reader = null;                // looking for openings when the site asks (reader.js)
let booker = null;                // booking the person's own slot (booker.js)
let pinger = null;                // presence, timing, and hearing of a slot at once (pinger.js)
let connection = null;            // how this app's connection stands, as the site last said
let telemetry = null;             // this app's own numbers, kept here (telemetry.js)
let telemetryTimer = null;
let sharing = false;              // a share is on its way to the site
let shareAccepted = null;         // what the site said, on the last sync, about taking shares
let autoShareAfter = 0;           // no automatic share before this (epoch ms): after a refusal
let asked = null;                 // the lines this person asked for, as the last sync said: id -> answered_at
let generation = 0;               // counts resets: a robot's answer from before one is dropped
const opened = new Set();         // hand-off job ids a tab was opened for
const standingBack = new Set();   // hand-offs another of the person's devices is booking
const bookingOrigins = new Set(); // origins the app itself sent the person to book at

// Through a kept reference, and never while closing: Electron (38, at least on
// Linux) wedges its main thread for good when a view's contents are reached
// through the view, or sent to, after they have been closed — and stopping
// the server this app runs takes long enough for events to arrive meanwhile.
function send(channel, payload) {
  if (closing || !chromeContents || chromeContents.isDestroyed()) return;
  chromeContents.send(channel, payload);
}

/**
 * Open a page in the person's own browser — the pairing page, a payment
 * provider's checkout, a link out. A web page and nothing else: a site's
 * answer that names a file, a share or another program's link is not followed
 * out of this app. REGBOT_NO_EXTERNAL=1 logs it instead, so an automated run
 * never opens a browser on the machine it runs on.
 */
function openExternal(url) {
  if (!webPage(url)) return Promise.reject(new Error('This app opens only web pages in your browser.'));
  if (process.env.REGBOT_NO_EXTERNAL === '1') {
    log(`would open ${url}`);
    return Promise.resolve();
  }
  return osShell.openExternal(url);
}

function normalizeUrl(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) return text;
  if (text.startsWith('/')) return `${client.serverUrl}${text}`;
  return `https://${text}`;
}

function rememberBookingOrigin(url) {
  const origin = originOf(url);
  if (origin && origin !== originOf(client.serverUrl)) bookingOrigins.add(origin);
}

// ------------------------------------------------------ the built-in server
const builtin = () => serverMode === 'builtin';

function osUser() {
  try { return os.userInfo().username; } catch { return ''; }
}

/**
 * The server this app runs: made once, its credentials read (or made) from
 * beside its database, and listened to — the site coming up is what gives
 * the app an address to talk to.
 */
function makeStack() {
  if (stack) return stack;
  stack = new Stack({
    paths: locate({ packaged: app.isPackaged, resourcesPath: process.resourcesPath, appPath: app.getAppPath() }),
    dataDir: path.join(app.getPath('userData'), 'server'),
    node: process.execPath,
    identity: { name: osUser(), platform: process.platform, version: app.getVersion() },
    dmv: store.get('dmvTarget', 'standin'),
    log: (message) => log(`server: ${message}`),
  }).prepare();
  // Registered before anything else listens, so the address is in place
  // before a request that was waiting for it goes out.
  stack.on('ready', (name) => { if (name === 'web') onWebReady(); });
  stack.on('state', (state) => { trace(`stack: ${Object.entries(state.services).map(([k, v]) => `${k}=${v.state}`).join(' ')}`); send('stack:state', state); });
  return stack;
}

function onWebReady() {
  if (!builtin() || !stack || !stack.url) return;
  if (client.serverUrl && client.serverUrl !== stack.url) sitesCache = [];
  client.serverUrl = stack.url;
  client.token = stack.token;
  const user = stack.owner ? { nickname: stack.owner.nickname } : pairState.user;
  setPair({ paired: true, user, pending: null, message: '' });
  if (loop) loop.poke();
  refreshSites('server ready');
}

async function startStack() {
  makeStack();
  try {
    await stack.start();
  } catch (err) {
    log(`the server on this computer did not start: ${err.message}`);
    send('toast', { kind: 'bad', ms: 20000, text: err.message === NO_SERVER ? NO_SERVER
      : `The server on this computer did not start: ${err.message}. Settings → Server has its log.` });
  }
}

/** Whether practice mode has a server to run: a lineright-server checkout (src/stack.js). */
function practiceAvailable() {
  return Boolean(locate({ packaged: app.isPackaged, resourcesPath: process.resourcesPath, appPath: app.getAppPath() }).regbot);
}

/**
 * Wait for the server to be there. Instant for somebody else's (it is there
 * or it is not, and the request says which); for the built-in one, until its
 * site says it is listening — a screen asked for in the first second of a
 * launch should load, not fail.
 */
function serverReady(ms = 90000) {
  if (!builtin() || (stack && stack.url && client.serverUrl)) return Promise.resolve();
  if (!stack) return Promise.reject(new Error('The server on this computer is not running.'));
  if (!stack.paths.regbot) return Promise.reject(new Error(NO_SERVER));
  // This one: a switch of server or a reset puts another in its place meanwhile.
  const s = stack;
  return new Promise((resolve, reject) => {
    const done = (fn, value) => { clearTimeout(timer); s.off('ready', onReady); s.off('state', onState); fn(value); };
    const onReady = (name) => { if (name === 'web') done(resolve); };
    const onState = (state) => {
      if (state.services.web.state === 'failed') done(reject, new Error(`The server on this computer could not start: ${state.services.web.message}`));
    };
    const timer = setTimeout(() => done(reject, new Error(s.status().services.web.message
      || 'The server on this computer is taking a long time to start.')), ms);
    s.on('ready', onReady);
    s.on('state', onState);
  });
}

/**
 * Open one of the built-in server's own pages in a tab: the website signed in
 * as this person, the control room unlocked — or its logs, its configuration
 * file or its data folder in whatever this machine opens them with.
 */
async function openServerPage(what, next) {
  if (!builtin() || !stack) throw new Error('This app is using another LineRight Regbot server; its pages are on that server.');
  const reveal = async (target) => {
    const failed = await osShell.openPath(target);
    if (failed) throw new Error(failed);
  };
  if (what === 'logs') return reveal(stack.logsDir);
  if (what === 'config') return reveal(stack.envFile);
  if (what === 'data') return reveal(stack.dataDir);
  if (what === 'admin') {
    await stack.ensure('admin');
    return { id: tabs.open(stack.adminUrl(next || '/'), { kind: 'page', title: 'Control room' }) };
  }
  await serverReady();
  return { id: tabs.open(stack.signinUrl(next || '/account'), { kind: 'page', title: 'Your account' }) };
}

/** The saved token and the server it was for: signed out, or moving to another. */
function forgetToken() {
  if (store.chosen('token')) store.delete('token');
  if (store.chosen('tokenServer')) store.delete('tokenServer');
}

/** Forget what the screens show: a different server is a different account and different lines. */
function resetSession(message) {
  cancelSignIn();
  lastDoc = null;
  asked = null;
  opened.clear();
  if (booker) booker.forget();
  standingBack.clear();
  sitesCache = [];
  send('sync:doc', null);
  setPair({ paired: false, user: null, pending: null, message });
}

async function useRemote(url) {
  resetSession(`Server changed to ${url}. Sign in again.`);
  serverMode = 'remote';
  store.set('serverMode', 'remote');
  store.set('serverUrl', url);
  forgetToken();
  client.serverUrl = url;
  client.token = null;
  if (stack) {
    const was = stack;
    stack = null;
    was.removeAllListeners();
    await was.stop();
  }
  send('stack:state', null);
  loop.poke();
  refreshSites('server changed');
}

async function useBuiltin() {
  resetSession('');
  serverMode = 'builtin';
  store.set('serverMode', 'builtin');
  client.serverUrl = '';
  makeStack();
  client.token = stack.token;
  setPair({ paired: true, user: stack.owner ? { nickname: stack.owner.nickname } : null, pending: null, message: '' });
  loop.poke();
  startStack();
}

/**
 * The booking sites this app knows an address for, named.
 *
 * What an import is allowed to look at in another browser: the portals the
 * server lists, plus any page the app itself has sent this person to. A
 * cookie for anywhere else is not read, let alone copied.
 */
function bookingSites() {
  const out = new Map();
  // The regbot site itself is not one of them: this app signs in to it with a
  // device token, and a simulated site's portal being hosted there is no
  // reason to go looking through a browser for its cookies.
  const ours = originOf(client.serverUrl);
  for (const site of sitesCache) {
    const origin = originOf(site.portal_url || '');
    if (origin && origin !== ours) out.set(origin, { origin, name: site.name, slug: site.slug });
  }
  for (const origin of bookingOrigins) {
    if (out.has(origin)) continue;
    let host = origin;
    try { host = new URL(origin).hostname; } catch { /* keep the origin as its own name */ }
    out.set(origin, { origin, name: host, slug: '' });
  }
  return [...out.values()];
}

/**
 * Whether to put the import in front of somebody rather than wait to be asked.
 *
 * It is the difference between a profile filled in in five seconds and one
 * typed from memory, and the moment it is missed is the worst one — a slot
 * held, a clock running, a form asking for a licence number. So it is offered
 * at startup while it can still save that, and only while: once the person
 * has imported, or said no, or filled the profile in by hand, the screen stays
 * where it belongs, in the File menu.
 */
function importWorthOffering() {
  return machineHasBrowsers()
    && store.get('suggestImport', true) !== false
    && profile.view().filled === 0;
}

/**
 * Put cookies from another browser into the one the booking pages open in.
 *
 * A whole cookie jar is thousands of them, and each one is a round trip to the
 * network service: a hundred at a time keeps it to seconds without asking the
 * machine to hold thousands of promises at once.
 */
async function putCookies(taking) {
  const jar = session.fromPartition(tabs.partition).cookies;
  const out = { set: 0, refused: 0 };
  for (let at = 0; at < taking.length; at += 100) {
    const batch = taking.slice(at, at + 100);
    await Promise.all(batch.map(({ cookie }) => jar.set(cookie).then(
      () => { out.set += 1; },
      (err) => { out.refused += 1; trace(`import cookie refused: ${cookie.name} ${err.message}`); },
    )));
  }
  return out;
}

/**
 * The weekly re-import: every browser imported from, read again, and what was
 * taken from it last time taken again — the fields the person has not made
 * their own since, and the sign-ins the app's browser does not hold a fresher
 * copy of (reimport.js decides; this reads and writes).
 */
let reimporting = null;
function importAgain() {
  if (reimporting) return reimporting;
  reimporting = (async () => {
    const out = await reimport.run({
      store, profile, policy: appsPolicy(),
      read: (src) => {
        const { browser, profile: from } = browsers.find(src.dir, src.profile);
        return browsers.read(browser, from, { sites: bookingSites(), tmpdir: app.getPath('temp') });
      },
      cookies: async (src, found) => {
        const taking = browsers.chosen(found.cookies, { origins: src.origins, others: src.others });
        if (!taking.length) return { set: 0, refused: 0, fresher: 0 };
        const existing = await session.fromPartition(tabs.partition).cookies.get({});
        const worth = reimport.fresher(taking, existing);
        return { ...(await putCookies(worth)), fresher: taking.length - worth.length };
      },
    });
    if (lastDoc) send('sync:doc', withNeeds(lastDoc));
    log(`re-imported from ${out.done.join(', ') || 'nothing'}: ${out.updated.length} details, `
      + `${out.cookies} sign-in cookies${out.failed.length ? `; ${out.failed.length} browser(s) could not be read` : ''}`);
    return { ...out, profile: profile.view(), again: againView() };
  })().finally(() => { reimporting = null; });
  return reimporting;
}

/**
 * What the site has its apps do (the sync's `apps`: how often to ask for the
 * re-import, set on its admin panel). Kept with the settings, so a start before
 * the first sync goes by what the site last said.
 */
function appsPolicy() {
  return store.get('siteApps', null);
}

function noteAppsPolicy(apps) {
  if (!apps || typeof apps !== 'object' || JSON.stringify(apps) === JSON.stringify(appsPolicy())) return;
  store.set('siteApps', apps);
  // A new schedule may make the re-import due now.
  offerImportAgain();
}

/** The weekly re-import, as the screens show it. */
function againView() {
  return reimport.view(store, Date.now(), appsPolicy());
}

/** Ask the screen to offer the weekly re-import, if its week is up. */
function offerImportAgain() {
  try {
    if (reimport.due(store, Date.now(), appsPolicy())) send('import:due', againView());
  } catch (err) {
    trace(`re-import check: ${err.message}`);
  }
}

/**
 * Is there a browser here at all? A directory scan, no database opened and
 * nothing decrypted, and the answer is kept: the page asks this while the
 * window is still coming up, so it cannot wait for a scan somebody else was
 * going to do.
 */
function machineHasBrowsers() {
  if (hasBrowsers === null) {
    try {
      hasBrowsers = browsers.scan().length > 0;
      trace(`browsers on this machine: ${hasBrowsers}`);
    } catch (err) {
      hasBrowsers = false;
      trace(`looking for browsers failed: ${err.message}`);
    }
  }
  return hasBrowsers;
}

function navigate(page, params = {}) {
  if (tabs) tabs.showApp();
  lastNavigate = { page, params };
  send('app:navigate', { page, params });
}

/**
 * Say, on everything the app shows, which of a line's personal fields the
 * profile already holds.
 *
 * Computed here rather than in the renderer because the profile lives here and
 * never crosses the wire wholesale — the screen gets "held" or "missing" per
 * field, never the values. It is also the only copy of the rule: see needs.js.
 */
function withNeeds(doc) {
  if (!doc || typeof doc !== 'object') return doc;
  const values = profile.values();
  if (Array.isArray(doc.kept_on_device)) doc.needs_status = needs.status(doc.kept_on_device, values);
  if (doc.site && Array.isArray(doc.site.kept_on_device)) {
    doc.site.needs_status = needs.status(doc.site.kept_on_device, values);
  }
  if (Array.isArray(doc.handoffs)) {
    for (const h of doc.handoffs) h.needs_status = needs.status(h.needs || [], values);
  }
  return doc;
}

/**
 * Stop at the profile on the way to a booking page.
 *
 * The page is about to ask for a licence number and an email the app does not
 * have, on a clock. Better to ask now, with the fields named, than to open a
 * form that cannot be filled in — so the profile screen opens carrying what is
 * missing and what to do once it is saved.
 */
function gateToProfile(gap, { why, then = null, back = null }) {
  navigate('profile', { gate: { need: gap, why, then, back } });
  return { gated: true, need: gap };
}

// ------------------------------------------------------------------- menu
function rebuildMenu() {
  const items = menu.template({
    platform: process.platform,
    builtin: builtin(),
    paired: client.paired,
    user: pairState.user || (lastDoc && lastDoc.user) || null,
    sites: sitesCache.map((s) => ({ name: s.name, slug: s.slug })),
    version: app.getVersion(),
    importRecommended: importWorthOffering(),
    importAgain: (() => {
      const from = againView().sources;
      return from.length === 1 ? from[0].label : from.length ? `${from.length} browsers` : '';
    })(),
    actions: {
      signIn: () => { navigate('signin'); startSignIn(); },
      signOut: () => signOut(),
      profile: () => navigate('profile'),
      importBrowser: () => navigate('import'),
      importAgain: () => { if (tabs) tabs.showApp(); send('import:due', { ...againView(), due: true, asked: true }); },
      settings: () => navigate('settings'),
      syncNow: () => loop.poke(),
      found: () => navigate('found'),
      sites: () => navigate('sites'),
      console: () => navigate('console'),
      site: (slug) => navigate('site', { slug }),
      app: () => tabs.showApp(),
      fill: () => fillActive(true),
      help: () => navigate('help'),
      advanced: () => navigate('advanced'),
      requestSite: () => navigate('request'),
      credits: () => navigate('credits'),
      checkUpdates: () => updates.check(),
      about: () => showAbout(),
      quit: () => shutdown(0),
      controlRoom: () => openServerPage('admin').catch((err) => send('toast', { kind: 'bad', text: err.message })),
      serverLogs: () => openServerPage('logs').catch((err) => send('toast', { kind: 'bad', text: err.message })),
    },
  });
  Menu.setApplicationMenu(Menu.buildFromTemplate(items));
}

function showAbout() {
  const lines = [
    `LineRight Regbot ${app.getVersion()}${app.isPackaged ? '' : ' (unpackaged)'}`,
    `Electron ${process.versions.electron} · Chromium ${process.versions.chrome} · ${process.platform}`,
    builtin() ? `Server: this computer${stack && stack.url ? ` (${stack.url})` : ' (starting)'}` : `Server: ${client.serverUrl}`,
    pairState.user ? `Signed in as ${pairState.user.nickname}` : 'Not signed in',
    '',
    'A place in a booking queue, bought and kept. This app shows your lines, tells you when a slot is yours, and opens the booking page so you can take it. It keeps your personal details on this machine and never sees your password.',
  ];
  dialog.showMessageBox({ type: 'info', title: 'About LineRight Regbot', message: lines[0], detail: lines.slice(1).join('\n'), buttons: ['OK'] })
    .catch(() => {});
}

// ---------------------------------------------------------------- sites
async function refreshSites(reason = 'timer') {
  // The built-in server's site asks again itself the moment it is up.
  if (builtin() && !(stack && stack.url)) return;
  try {
    const doc = await client.sites();
    sitesCache = doc.sites || [];
    for (const s of sitesCache) if (s.portal_url) rememberBookingOrigin(s.portal_url);
    rebuildMenu();
    trace(`sites: ${sitesCache.length} (${reason})`);
  } catch (err) {
    trace(`sites failed: ${err.message}`);
  }
}

// ------------------------------------------------------------- signing in
function setPair(next) {
  pairState = { ...pairState, ...next };
  send('pair:state', pairState);
  rebuildMenu();
}

async function startSignIn() {
  // The built-in server knows this app already; there is nobody to ask.
  if (client.paired || builtin()) return pairState;
  cancelSignIn();
  try {
    const opened = await client.pairStart();
    pairing = { secret: opened.secret, timer: null };
    // The page to approve on is the site this app signs in to, whatever else the answer says.
    const { verifyUrl, siteUrl } = approvalPage(
      { verifyUrl: opened.verify_url, siteUrl: opened.site_url, code: opened.code }, client.serverUrl);
    setPair({
      paired: false, user: null, message: '',
      pending: { code: opened.code, verifyUrl, expiresAt: opened.expires_at,
        expiresIn: opened.expires_in, siteUrl },
    });
    log(`sign-in code ${opened.code} — approve it at ${verifyUrl}`);
    if (!argv.smoke) openExternal(verifyUrl).catch(() => {});
    pollPairing(opened.poll_ms || 2500);
  } catch (err) {
    setPair({ pending: null, message: `Could not reach ${client.serverUrl}: ${err.message}` });
  }
  return pairState;
}

function pollPairing(everyMs) {
  if (!pairing) return;
  pairing.timer = setTimeout(async () => {
    if (!pairing) return;
    try {
      const reply = await client.pairPoll(pairing.secret);
      if (reply.status === 'approved' && reply.token) {
        // Kept with the server that issued it, and offered to no other.
        store.set('token', reply.token);
        store.set('tokenServer', client.serverUrl);
        pairing = null;
        setPair({ paired: true, user: reply.user, pending: null, message: '' });
        send('toast', { kind: 'ok', text: `Signed in as ${reply.user.nickname}.` });
        log(`signed in as ${reply.user.nickname}`);
        loop.poke();
        refreshSites('signed in');
        navigate('sites');
        return;
      }
      pollPairing(everyMs);
    } catch (err) {
      // 410: expired, declined or used. Anything else: the server is away; keep asking.
      if (err.status === 410) {
        pairing = null;
        setPair({ pending: null, message: err.message });
        return;
      }
      pollPairing(Math.min(everyMs * 2, 15000));
    }
  }, everyMs);
}

function cancelSignIn() {
  if (pairing && pairing.timer) clearTimeout(pairing.timer);
  pairing = null;
  if (pairState.pending) setPair({ pending: null });
}

async function signOut() {
  if (builtin()) {
    send('toast', { kind: 'warn', text: 'This app is signed in to the server on this computer as you. To use another server, change it in Settings.' });
    return;
  }
  cancelSignIn();
  try { await client.unpair(); } catch { /* the token may already be dead */ }
  forgetToken();
  lastDoc = null;
  asked = null;
  opened.clear();
  if (booker) booker.forget();
  standingBack.clear();
  setPair({ paired: false, user: null, pending: null, message: 'Signed out.' });
  send('sync:doc', null);
  navigate('signin');
}

// --------------------------------------------------------------------- sync
function notify(title, body, handoff) {
  if (process.env.REGBOT_NO_NOTIFY === '1' || !Notification.isSupported()) return;
  try {
    const note = new Notification({ title, body, urgency: 'critical' });
    note.on('click', () => {
      win.show();
      win.focus();
      const tab = tabs.tabFor(handoff.job_id);
      if (tab) tabs.select(tab.id);
    });
    note.show();
  } catch (err) {
    log('notification failed:', err.message);
  }
}

function handleDoc(doc) {
  const { arrived } = diffHandoffs(lastDoc ? lastDoc.handoffs : [], doc.handoffs);
  trace(`doc: ${doc.positions.length} positions, ${doc.handoffs.length} handoffs, ${arrived.length} new`);
  lastDoc = doc;
  for (const p of doc.positions) if (p.portal_url) rememberBookingOrigin(p.portal_url);
  for (const h of doc.handoffs) if (h.open_url) rememberBookingOrigin(h.open_url);
  if (!pairState.paired || !pairState.user || pairState.user.nickname !== doc.user.nickname) {
    setPair({ paired: true, user: doc.user, pending: null, message: '' });
  }
  send('sync:doc', withNeeds(doc));
  noteAppsPolicy(doc.apps);
  if (reader && !builtin()) reader.offer(doc.reads || []);
  if (booker && !builtin()) booker.retryReports();
  noteConnection(doc.latency);
  const current = new Set(doc.handoffs.map((h) => h.job_id));
  for (const id of [...standingBack]) if (!current.has(id)) standingBack.delete(id);
  for (const h of doc.handoffs) {
    // The device of this person's that was booking it has gone quiet — closed,
    // crashed, off the network: this one takes it over rather than let it wait
    // out its deadline.
    if (standingBack.has(h.job_id) && h.phase === 'booking' && h.booker && !h.booker.you
        && h.booker.silent) {
      standingBack.delete(h.job_id);
      takeHandoff(h, `${h.booker.name} stopped answering while booking it`);
    }
  }
  for (const h of arrived) {
    if (h.phase !== 'booking' || opened.has(h.job_id)) continue;
    opened.add(h.job_id);
    if (telemetry) telemetry.handoff();
    takeHandoff(h);
  }
  if (doc.telemetry) shareAccepted = doc.telemetry;
  noteAnswers(doc.requests);
}

/**
 * The person's turn, on this device. On the regbot site this app books the
 * slot itself, from this computer, unless another of their devices already is;
 * the page opens only if it cannot. `note` says why it is this device's now.
 */
function takeHandoff(h, note = '') {
  if (h.over) {
    // Offered to several of us, and it went before this app got to it.
    log(`${describeHandoff(h)}: ${h.over.message}`);
    return;
  }
  const robot = booker && !builtin() ? booker.wants(h) : { ok: false, why: 'practice' };
  if (robot.ok) {
    log(`your turn: ${describeHandoff(h)} — ${note ? `${note}; ` : ''}booking it with this computer's robot`);
    notify(`Your turn — ${h.queue_name}`, `Booking ${describeHandoff(h)} for you now…`, h);
    const mine = generation;
    booker.book(h).then((outcome) => { if (mine === generation) afterBooking(h, outcome); });
    return;
  }
  if (robot.why === 'elsewhere') {
    standingBack.add(h.job_id);
    log(`your turn: ${describeHandoff(h)} — ${robot.device} is booking it`);
    notify(`Your turn — ${h.queue_name}`, `${robot.device} is booking ${describeHandoff(h)}.`, h);
    return;
  }
  offerHandoff(h, note ? `${note}. Book it here.` : '');
}

/**
 * Put a hand-off in front of the person to book themselves: the booking page in
 * a tab, a notification, the window raised. `why` says why the app's robot did
 * not book it, when it tried.
 */
function offerHandoff(h, why = '') {
  const gap = needs.missing(h.needs || [], profile.values());
  if (gap.length) {
    // Their turn is still their turn — notify, raise the window — but send
    // them to the profile rather than to a form nothing can fill in.
    gateToProfile(gap, {
      why: `${h.queue_name} is ready to book and your profile has no ${needs.phrase(gap)}.`,
      then: { action: 'handoff:open', args: { job_id: h.job_id } },
    });
    trace(`handoff gated: profile missing ${gap.map((f) => f.profileKey).join(', ')}`);
  } else {
    const existing = tabs.tabFor(h.job_id);
    if (existing) tabs.select(existing.id);
    else if (h.open_url) tabs.open(h.open_url, { kind: 'handoff', jobId: h.job_id, title: `Your turn — ${h.queue_name}` });
    trace('handoff tab opened');
  }
  log(`your turn: ${describeHandoff(h)} — ${clock(h.seconds_left)} to book`
      + (gap.length ? ` (profile is missing ${needs.phrase(gap)})` : '') + (why ? ` — ${why}` : ''));
  notify(`Your turn — ${h.queue_name}`, why || `${describeHandoff(h)}. Book it within ${clock(h.seconds_left)}.`, h);
  if (why) send('toast', { kind: 'warn', text: why });
  if (!win.isVisible()) win.show();
  if (process.env.REGBOT_NO_FLASH !== '1') win.flashFrame(true);
}

/**
 * Say so when the people running regbot answer a line this person asked for:
 * an answer the last sync did not have. The first sync only learns what is there.
 */
function noteAnswers(requests) {
  if (!Array.isArray(requests)) return;
  const now = new Map(requests.map((r) => [r.id, r.answered_at || '']));
  if (asked) {
    for (const r of requests) {
      if (r.answered_at && asked.get(r.id) !== r.answered_at) {
        const what = `${r.site_name}${r.line_name ? ` — ${r.line_name}` : ''}`;
        log(`LineRight Regbot answered the request for ${what}: ${r.status}`);
        send('toast', { kind: r.status === 'declined' ? 'warn' : 'ok', ms: 15000,
          text: `LineRight Regbot answered your request for ${what}: ${r.status}. Help → Ask for a site or a line shows the answer.` });
      }
    }
  }
  asked = now;
}

/**
 * How this app's connection stands among the apps online (the server's presence.py),
 * told to the person when it changes: a slot is offered to several apps a few
 * seconds apart, and a slow one may lose it — or, too slow, be offered nothing.
 */
function noteConnection(latency) {
  const was = connection;
  connection = latency || null;
  const state = (l) => (l ? (l.dropped ? 'dropped' : l.warn ? 'warn' : 'ok') : 'ok');
  if (state(was) === state(connection)) return;
  if (telemetry) telemetry.connection(state(connection), connection ? connection.ms : null);
  if (state(connection) === 'dropped') {
    log(`this app's connection is too slow to be offered slots: ${connection.ms} ms, ${connection.why}`);
    send('toast', { kind: 'bad', ms: 20000, text: `Your connection to LineRight Regbot is too slow for slots to be offered to this app (${connection.ms} ms — ${connection.why}). They go to the next person in line until it is faster.` });
  } else if (state(connection) === 'warn') {
    log(`this app's connection is slow: ${connection.ms} ms, ${connection.why}`);
    send('toast', { kind: 'warn', ms: 15000, text: `Your connection to LineRight Regbot is slow (${connection.ms} ms — ${connection.why}). A slot is offered to several people a few seconds apart, and a slower app may lose it to a faster one.` });
  } else if (was) {
    log('this app\'s connection is fine again');
    send('toast', { kind: 'ok', text: 'Your connection to LineRight Regbot is fine again.' });
  }
}

/** What the app's robot made of the person's slot (booker.js), told to them. */
function afterBooking(h, outcome) {
  if (closing) return;
  const where = describeHandoff(h);
  if (outcome.kind === 'booked') {
    log(`booked ${where} — DMV confirmation ${outcome.confirmation}`
        + (outcome.unreported ? ` (the site did not record it: ${outcome.unreported})` : ''));
    notify(`Booked — ${h.queue_name}`, `${where}. Confirmation ${outcome.confirmation}.`, h);
    send('toast', outcome.unreported
      ? { kind: 'warn', ms: 20000, text: `Booked ${where} — confirmation ${outcome.confirmation}. The LineRight Regbot site did not record it: ${outcome.unreported}` }
      : { kind: 'ok', text: `Booked ${where} — confirmation ${outcome.confirmation}.` });
  } else if (outcome.kind === 'gone' && outcome.quiet) {
    log(`${where} was gone when the robot got there — ${outcome.device} may have booked it before it stopped answering`);
    send('toast', { kind: 'warn', ms: 20000, text: `${where} was no longer listed. ${outcome.device} was booking it before it stopped answering and may have got it — check your email for a confirmation.` });
  } else if (outcome.kind === 'gone') {
    log(`${where} was gone when the robot got there`);
    send('toast', { kind: 'warn', text: `${where} was gone by the time the app got there. You keep your place in line.` });
  } else if (outcome.kind === 'elsewhere') {
    standingBack.add(h.job_id);
    send('toast', { kind: 'ok', text: `${outcome.device} is booking ${where}.` });
  } else if (outcome.kind === 'late') {
    log(`${where}: ${outcome.why}`);
    send('toast', { kind: 'warn', text: `${where} is no longer held for you: ${outcome.why}` });
  } else {
    // The page, for the person to finish: while the slot is still theirs.
    const now = lastDoc && lastDoc.handoffs.find((x) => x.job_id === h.job_id);
    if (now) {
      offerHandoff(now, outcome.why);
    } else {
      log(`${where}: ${outcome.why} — and it is no longer held for you`);
      send('toast', { kind: 'warn', ms: 15000, text: `The app could not book ${where}, and it is no longer held for you.`
        + (outcome.unconfirmed ? ' The DMV may have booked it anyway: check your email for a confirmation.' : '') });
    }
  }
  if (loop) loop.poke();
}

function wireSync() {
  // Each loop answers only while it is the app's: one a reset replaced may
  // still have a request out, for the account that was just deleted.
  const self = new SyncLoop(client, {
    // On the regbot site this app looks for openings when asked; its own
    // practice server looks for itself.
    body: () => (reader && !builtin() ? { reader: reader.capabilities() } : {}),
    onDoc: (doc) => { if (loop === self) handleDoc(doc); },
    onStatus: (status) => { if (loop === self) send('sync:status', status); },
    onError: (err) => {
      if (loop !== self) return;
      if (err instanceof NotPaired && builtin()) {
        // The built-in site no longer knows the app's token — the device was
        // removed from its website's console. Its start makes sure it does.
        if (stack && !reregistering) {
          reregistering = true;
          log('the server on this computer refused the app; restarting its site to sign the app in again');
          stack.restart('web').catch(() => {}).finally(() => { reregistering = false; });
        }
        return;
      }
      if (err instanceof NotPaired) {
        if (store.get('token')) {
          forgetToken();
          log('this device was unpaired; sign in again from the File menu');
        }
        if (pairState.paired) {
          setPair({ paired: false, user: null, message: 'This device was unpaired. Sign in again.' });
          navigate('signin');
        }
      }
    },
  });
  loop = self;
  loop.start();
  if (pinger) pinger.stop();
  pinger = new Pinger({
    getClient: () => client,
    // A slot released to this person: sync now, not at the loop's next turn.
    onWake: () => { if (loop === self) loop.poke(); },
    onMeasured: (m) => { if (telemetry) telemetry.rtt(m.rtt_ms); },
    log: (message) => log(`pinger: ${message}`),
    // Tests only, and never in an installed app: a connection that answers slowly.
    delayMs: app.isPackaged ? 0 : Number(process.env.REGBOT_PING_DELAY_MS || 0),
  });
  pinger.start();
}

// ----------------------------------------------------------------- autofill
async function fill(tabId, force) {
  const tab = tabs.tabs.get(tabId);
  if (!tab) return null;
  const values = profile.values();
  if (!Object.keys(values).length) {
    if (force) send('toast', { kind: 'warn', text: 'Your profile is empty — fill it in under File → Profile.' });
    return null;
  }
  try {
    const result = await tabs.run(tabId, buildFillScript(values, { force }));
    lastFill = { url: tab.url, at: Date.now(), ...result };
    trace(`autofill: ${result.filled} filled, ${result.skipped} skipped on ${tab.url}`);
    if (result.filled) {
      send('toast', { kind: 'ok', text: `Filled ${result.filled} field${result.filled === 1 ? '' : 's'} from your profile.` });
    } else if (force) {
      send('toast', { kind: 'warn', text: result.skipped ? 'Nothing to add — the form already has your details.' : 'No field on this page matches your profile.' });
    }
    send('autofill:done', lastFill);
    return lastFill;
  } catch (err) {
    trace(`autofill failed: ${err.message}`);
    if (force) send('toast', { kind: 'bad', text: `Could not fill the form: ${err.message}` });
    return null;
  }
}

function fillActive(force) {
  const current = tabs.current();
  if (!current) {
    send('toast', { kind: 'warn', text: 'Open a booking page first.' });
    return null;
  }
  return fill(current.id, force);
}

function wireAutofill() {
  tabs.on('loaded', ({ id, url }) => {
    if (!profile.autofill) return;
    if (!isBookingPage(url, bookingOrigins)) return;
    fill(id, false);
  });
}

// ---------------------------------------------------------------- telemetry
function shareMode() {
  if (builtin()) return 'practice';
  return client.serverUrl === siteUrl() ? 'public' : 'remote';
}

/**
 * Send the site what the Advanced screen showed as "what would be sent" —
 * only when the person pressed Share, or turned sharing on (`auto`).
 */
async function shareTelemetry(auto) {
  if (sharing) throw new Error('A share is already on its way.');
  if (!client.paired) throw new Error('Sign in first: telemetry is shared with the site this app is signed in to.');
  if (shareAccepted && shareAccepted.accepts === false) throw new Error('This LineRight Regbot site is not taking app telemetry at the moment.');
  sharing = true;
  const body = telemetry.payload({ mode: shareMode() });
  try {
    const reply = await client.shareTelemetry(body);
    telemetry.noteShare({ ok: true, id: reply.id, period: body.period, auto,
      message: reply.duplicate ? 'already shared' : `kept for ${reply.kept_days} days` });
    log(`telemetry shared with ${client.serverUrl}${auto ? ' (automatically)' : ''}: upload ${reply.id}`);
    return { ok: true, reply, bytes: Buffer.byteLength(JSON.stringify(body)) };
  } catch (err) {
    const wait = err.retryAfter ? ` Try again in ${Math.ceil(err.retryAfter / 60)} minute(s).` : '';
    telemetry.noteShare({ ok: false, auto, message: `${err.message}${wait}` });
    // Refused or unreachable: the automatic share waits what the site asked, and
    // half an hour at least, rather than knocking every minute.
    autoShareAfter = Date.now() + Math.max(30 * 60, err.retryAfter || 0) * 1000;
    const e = new Error(`${err.message}${wait}`);
    e.status = err.status;
    throw e;
  } finally {
    sharing = false;
  }
}

function wireTelemetry() {
  telemetry = new Telemetry({
    file: path.join(app.getPath('userData'), 'telemetry.json'),
    app: { version: app.getVersion(), platform: process.platform, arch: process.arch,
      electron: process.versions.electron, packaged: app.isPackaged },
  });
  telemetry.event('start');
  const tick = () => {
    try { telemetry.processes(app.getAppMetrics(), process.memoryUsage()); } catch { /* not everywhere */ }
    telemetry.save();
    // Shared automatically only if the person said so, and at most every six hours.
    const last = telemetry.lastShare();
    if (store.get('telemetryAutoShare', false) && client && client.paired && !sharing
        && Date.now() >= autoShareAfter
        && (!last || telemetry.nowS() - last.at > AUTO_SHARE_EVERY_S)
        && !(shareAccepted && shareAccepted.accepts === false)) {
      shareTelemetry(true).catch((err) => log(`telemetry: automatic share refused — ${err.message}`));
    }
  };
  telemetryTimer = setInterval(tick, TELEMETRY_EVERY_MS);
  setTimeout(tick, 5000);
}

// ---------------------------------------------------------------------- ipc
// What of a refusal the screen may act on: a bid the credits do not cover
// (402: how many are missing, where to buy them), or a site that asked to be
// left alone for a while (429).
const DETAIL = ['code', 'need', 'balance', 'short', 'buy_url'];

function handle(name, fn) {
  ipcMain.handle(`regbot:${name}`, async (_event, payload) => {
    try {
      const value = await fn(payload || {});
      return value === undefined ? { ok: true } : value;
    } catch (err) {
      const body = err.body && typeof err.body === 'object' ? err.body : {};
      const detail = {};
      for (const key of DETAIL) if (body[key] !== undefined) detail[key] = body[key];
      return { error: err.message || String(err), status: err.status || 0, detail,
        retryAfter: err.retryAfter || 0 };
    }
  });
}

function settingsView() {
  return {
    serverMode,
    serverUrl: client.serverUrl,
    // The public site this build pairs with (config.json), and which of the
    // three the app is on: that site, practice on this computer, or another.
    siteUrl: siteUrl(),
    serverChoice: builtin() ? 'builtin' : (client.serverUrl === siteUrl() ? 'public' : 'remote'),
    // Practice runs the lineright server, which is not part of this app: only
    // where a checkout of it is on this machine.
    practiceAvailable: practiceAvailable(),
    // A run told where to go (--server, --practice): Settings still saves, but
    // this run stays where it was told.
    forced: forcedRun,
    // What the address field shows for somebody else's server, even while another is in use.
    remoteUrl: store.get('serverUrl', '') === siteUrl() ? '' : store.get('serverUrl', ''),
    dmvTarget: store.get('dmvTarget', 'standin'),
    stack: stack ? stack.status() : null,
    updateUrl: store.get('updateUrl', ''),
    clientName: store.get('clientName', ''),
    paired: client.paired,
    user: pairState.user || (lastDoc && lastDoc.user) || null,
    version: app.getVersion(),
    platform: process.platform,
    electron: process.versions.electron,
    packaged: app.isPackaged,
    updates: updateState,
    profileFile: profile.file,
    // This computer's robots, for the regbot site: whether it looks for
    // openings when asked, and whether it may look (and book) at the real DMV.
    readerEnabled: store.get('readerEnabled', true) !== false,
    realDmvRobots: Boolean(store.get('realDmvRobots', false)),
    realDmvChecks: reader ? reader.mayLookAtRealDmv() : false,
    // Checking lines for everybody, which earns credits on the site.
    checking: reader ? reader.enabled() : false,
    publicSite: !builtin() && !isLoopback(client.serverUrl),
    // The weekly re-import from the browsers imported from (reimport.js).
    importAgain: againView(),
    robots: reader ? { ...reader.state(), ...booker.state(), available: robots.available() } : null,
    telemetry: telemetry ? { autoShare: Boolean(store.get('telemetryAutoShare', false)),
      lastShare: telemetry.lastShare(), accepted: shareAccepted } : null,
  };
}

function wireIpc() {
  // -- the browser half
  handle('tabs:open', ({ url, kind, title }) => {
    const target = normalizeUrl(url);
    if (!target) throw new Error('Nothing to open.');
    if (kind === 'portal') rememberBookingOrigin(target);
    return { id: tabs.open(target, { kind: kind || 'page', title: title || '' }) };
  });
  handle('tabs:select', ({ id }) => (id === null || id === undefined ? tabs.showApp() : tabs.select(Number(id))));
  handle('tabs:close', ({ id }) => tabs.close(Number(id)));
  handle('tabs:navigate', ({ url }) => { const target = normalizeUrl(url); if (target) tabs.navigate(target); });
  handle('tabs:back', () => tabs.back());
  handle('tabs:forward', () => tabs.forward());
  handle('tabs:reload', () => tabs.reload());
  handle('tabs:home', () => tabs.showApp());
  handle('tabs:external', ({ url }) => {
    const target = normalizeUrl(url);
    if (!target) return undefined;
    // The built-in server's own pages open here, signed in: no other browser
    // on this machine has an account on it.
    if (builtin() && stack && stack.url && originOf(target) === originOf(stack.url)) {
      const at = new URL(target);
      return { id: tabs.open(stack.signinUrl(`${at.pathname}${at.search}${at.hash}`), { kind: 'page', title: 'LineRight Regbot website' }) };
    }
    openExternal(target).catch(() => {});
    return undefined;
  });
  handle('chrome:height', ({ px }) => tabs.setChromeHeight(px));

  // -- the application half
  handle('server:sites', async ({ q }) => {
    await serverReady();
    const doc = await client.sites(q || '');
    if (!q) {
      sitesCache = doc.sites || [];
      for (const s of sitesCache) if (s.portal_url) rememberBookingOrigin(s.portal_url);
      rebuildMenu();
    }
    return doc;
  });
  handle('server:site', async ({ slug }) => {
    await serverReady();
    const doc = await client.site(slug);
    if (doc.site && doc.site.portal_url) rememberBookingOrigin(doc.site.portal_url);
    return withNeeds(doc);
  });
  handle('server:board', async ({ id }) => {
    await serverReady();
    const doc = await client.board(id);
    if (doc.portal_url) rememberBookingOrigin(doc.portal_url);
    return withNeeds(doc);
  });
  // A bid is a promise that the app can finish the booking when the turn
  // comes. It is not one to make with an empty profile, so the details this
  // line asks for are in hand before any credits move.
  handle('server:bid', async ({ queue_id, needs_of_line, ...bid }) => {
    const gap = needs.missing(needs_of_line || [], profile.values());
    if (gap.length) {
      return gateToProfile(gap, {
        why: 'This line asks for details the booking form will want, and your profile has no '
          + `${needs.phrase(gap)}.`,
        back: { page: 'board', id: queue_id },
      });
    }
    const r = await client.placeBid(queue_id, bid);
    loop.poke();
    return r;
  });
  handle('server:raise', async ({ bid_id, delta }) => { const r = await client.raiseBid(bid_id, delta); loop.poke(); return r; });
  handle('server:withdraw', async ({ bid_id }) => { const r = await client.withdrawBid(bid_id); loop.poke(); return r; });
  handle('server:account', async () => { await serverReady(); return client.account(); });
  handle('server:revoke', ({ client_id }) => client.revokeDevice(client_id));
  handle('server:topup', async ({ pack }) => {
    const r = await client.topup(pack);
    // Stripe's page, in the person's own browser: the card is typed there, never here.
    if (r.redirect_url) {
      const page = paymentPage(r.redirect_url, client.serverUrl);
      if (page) openExternal(page).catch(() => {});
      else log(`not opening ${r.redirect_url}: not a payment page this app opens`);
    }
    loop.poke();
    return r;
  });
  handle('server:credits', async () => { await serverReady(); return client.credits(); });
  handle('server:payment', async ({ id }) => {
    const r = await client.payment(id);
    if (r.status === 'paid') loop.poke();
    return r;
  });
  handle('server:payment-open', ({ url }) => {
    const page = paymentPage(url, client.serverUrl);
    if (!page) throw new Error('That is not a payment page this app opens.');
    return openExternal(page);
  });
  handle('server:payment-cancel', ({ id }) => client.cancelPayment(id));

  // -- this app's own telemetry (telemetry.js), and sharing it
  handle('telemetry:get', ({ range }) => ({
    ...telemetry.snapshot(range),
    autoShare: Boolean(store.get('telemetryAutoShare', false)),
    accepted: shareAccepted,
    paired: client.paired,
    server: client.serverUrl,
    connection,
  }));
  handle('telemetry:preview', () => {
    const body = telemetry.payload({ mode: shareMode() });
    return { payload: body, bytes: Buffer.byteLength(JSON.stringify(body)) };
  });
  handle('telemetry:share', () => shareTelemetry(false));
  handle('telemetry:auto', ({ on }) => {
    store.set('telemetryAutoShare', Boolean(on));
    return { autoShare: Boolean(on) };
  });
  handle('telemetry:clear', () => { telemetry.clear(); return telemetry.snapshot('1h'); });

  // -- asking for a line on a site the regbot site does not cover yet
  handle('requests:list', async () => { await serverReady(); return client.siteRequests(); });
  handle('requests:submit', async (body) => client.requestSite(body));
  handle('requests:support', async ({ id }) => client.supportSiteRequest(id));

  // -- signing in
  handle('pair:start', () => startSignIn());
  handle('pair:cancel', () => { cancelSignIn(); return pairState; });
  handle('pair:forget', () => signOut());
  handle('pair:state', () => pairState);
  handle('pair:open', () => { if (pairState.pending) openExternal(pairState.pending.verifyUrl).catch(() => {}); });

  // -- the profile
  handle('profile:get', () => profile.view());
  handle('profile:set', ({ data, autofill, check }) => {
    const view = profile.set(data || {}, { autofill }).view();
    if (view.filled) { store.set('suggestImport', false); rebuildMenu(); }
    // Whatever is on screen was drawn against the old profile: the dots beside
    // a line's fields, and the warning on a hand-off. Redraw it.
    if (lastDoc) send('sync:doc', withNeeds(lastDoc));
    // `check` is what a gate was waiting for, answered against what was just
    // saved, so the screen can say "that is everything" and carry on.
    return { ...view, checked: needs.status(check || [], profile.values()) };
  });
  handle('profile:clear', () => {
    const view = profile.clear().view();
    // A profile deleted on purpose is not to be filled in again next week.
    reimport.forget(store);
    rebuildMenu();
    if (lastDoc) send('sync:doc', withNeeds(lastDoc));
    return view;
  });
  handle('profile:fill', () => fillActive(true));

  // -- hand-offs and reports
  handle('handoff:booked', async ({ job_id, confirmation }) => {
    const reply = await client.booked(job_id, confirmation || '');
    loop.poke();
    return reply;
  });
  handle('handoff:pass', async ({ job_id, reason }) => {
    const reply = await client.pass(job_id, reason || '');
    loop.poke();
    return reply;
  });
  handle('handoff:open', ({ job_id, anyway }) => {
    const existing = tabs.tabFor(job_id);
    if (existing) return tabs.select(existing.id);
    const h = lastDoc && lastDoc.handoffs.find((x) => x.job_id === job_id);
    if (!h) return undefined;
    const gap = anyway ? [] : needs.missing(h.needs || [], profile.values());
    if (gap.length) {
      return gateToProfile(gap, {
        why: `${h.queue_name} is ready to book and your profile has no ${needs.phrase(gap)}.`,
        then: { action: 'handoff:open', args: { job_id } },
      });
    }
    if (h.open_url) tabs.open(h.open_url, { kind: 'handoff', jobId: job_id, title: `Your turn — ${h.queue_name}` });
    return undefined;
  });
  handle('found:submit', async (report) => {
    const reply = await client.found(report);
    loop.poke();
    return reply;
  });
  handle('found:places', ({ site_slug }) => client.places(site_slug));
  handle('found:prefill', () => {
    const current = tabs.current();
    return current ? prefillFromUrl(current.url) : {};
  });

  // -- what another browser on this machine can hand over
  handle('import:scan', () => {
    const found = browsers.scan();
    hasBrowsers = found.length > 0;
    return { platform: process.platform, sites: bookingSites(), browsers: found };
  });
  handle('import:read', async ({ dir, profile: which }) => {
    const { browser, profile: from } = browsers.find(dir, which);
    const found = await browsers.read(browser, from, {
      sites: bookingSites(), tmpdir: app.getPath('temp'),
    });
    offered = { dir, which: from.id, cookies: found.cookies, name: browser.name, profileName: from.name };
    trace(`import: ${found.fields.length} details, ${found.cookies.length} cookies from ${browser.name}`);
    const held = {};
    for (const key of Object.keys(profile.values())) held[key] = true;
    // The values go to the screen because the person has to see what they are
    // agreeing to; the cookies do not, because nobody can read one.
    return { ...found, cookies: found.cookies.length, held };
  });
  // Asked once, at startup, before the first screen is chosen.
  handle('import:offer', () => ({
    show: importWorthOffering(),
    paired: client.paired,
  }));
  handle('import:dismiss', () => {
    store.set('suggestImport', false);
    rebuildMenu();
    return { show: false };
  });
  handle('import:apply', async ({ fields, origins, others }) => {
    const picked = {};
    for (const [key, value] of Object.entries(fields || {})) {
      if (KEYS.has(key) && String(value || '').trim()) picked[key] = value;
    }
    // Where they came from goes with them, so next week's re-import knows
    // which fields are this browser's to refresh.
    const source = offered ? { dir: offered.dir, profile: offered.which, name: offered.name,
      profileName: offered.profileName } : null;
    if (Object.keys(picked).length) profile.merge(picked, source ? reimport.sourceKey(source) : null);
    store.set('suggestImport', false);
    const asked = Boolean((origins || []).length || others);
    // What the browser offered is held here, not in the screen, so a screen
    // left open across a restart can ask for cookies nobody is holding.
    const stale = Boolean(asked && !offered);
    let put = { set: 0, refused: 0 };
    if (offered && asked) put = await putCookies(browsers.chosen(offered.cookies, { origins, others }));
    offered = null;
    if (source) {
      reimport.remember(store, { ...source, fields: Object.keys(picked),
        origins: stale ? [] : origins || [], others: !stale && Boolean(others) });
      rebuildMenu();
    }
    // Every line's "in your profile / missing" was worked out a moment ago
    // against a profile that has just grown.
    if (lastDoc) send('sync:doc', withNeeds(lastDoc));
    log(`imported ${Object.keys(picked).length} details and ${put.set} sign-in cookies`);
    return { saved: Object.keys(picked).length, cookies: put.set, refused: put.refused, stale,
      profile: profile.view(), again: againView() };
  });

  // Once a week, the same again from the same browsers, in one click (reimport.js).
  handle('import:again-state', () => againView());
  handle('import:again', () => importAgain());
  handle('import:later', () => { reimport.later(store, Date.now(), appsPolicy()); return againView(); });
  handle('import:forget', ({ key } = {}) => { reimport.forget(store, key || null); rebuildMenu(); return againView(); });

  // -- the rest
  handle('settings:get', () => settingsView());
  handle('settings:set', async ({ serverMode: mode, serverUrl, updateUrl, clientName, readerEnabled, realDmvRobots,
    checking, realDmvChecks, reimportRemind }) => {
    if (typeof updateUrl === 'string') store.set('updateUrl', updateUrl.trim().replace(/\/+$/, ''));
    if (typeof readerEnabled === 'boolean') {
      store.set('readerEnabled', readerEnabled);
      reader.reconsider();
    }
    if (typeof realDmvChecks === 'boolean' || typeof checking === 'boolean') {
      // Checking lines, as one switch: on is the person's yes to looking where
      // the site's lines are — the real DMV, for a site that is not on this
      // machine — kept with when it was said, and off stops the looking.
      const on = typeof checking === 'boolean' ? checking : realDmvChecks;
      if (on && !isLoopback(client.serverUrl)) {
        store.set('realDmvChecks', true);
        store.set('realDmvChecksAt', new Date().toISOString());
      } else if (typeof realDmvChecks === 'boolean' && !realDmvChecks) {
        store.set('realDmvChecks', false);
      }
      if (typeof checking === 'boolean') store.set('readerEnabled', checking);
      reader.reconsider();
      if (loop) loop.poke();
    }
    if (typeof reimportRemind === 'boolean') store.set('reimportRemind', reimportRemind);
    if (typeof realDmvRobots === 'boolean') {
      // A yes is kept with when it was said: it is the person agreeing to
      // automated traffic from their own address, and to real appointments.
      store.set('realDmvRobots', realDmvRobots);
      store.set('realDmvRobotsAt', realDmvRobots ? new Date().toISOString() : null);
      reader.reconsider();
    }
    if (typeof clientName === 'string' && clientName.trim()) {
      store.set('clientName', clientName.trim());
      client.app.name = clientName.trim();
    }
    if (mode === 'public') {
      if (!siteUrl()) throw new Error('This build names no LineRight Regbot site.');
      if (builtin() || client.serverUrl !== siteUrl()) await useRemote(siteUrl());
    } else if (mode === 'builtin' && !builtin()) {
      await useBuiltin();
    } else if (mode === 'remote' || (mode === undefined && typeof serverUrl === 'string' && !builtin())) {
      const text = String(serverUrl === undefined ? store.get('serverUrl', '') : serverUrl).trim();
      if (!text) throw new Error('Give the address of the LineRight Regbot server to use.');
      const next = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text.replace(/\/+$/, '') : `https://${text.replace(/\/+$/, '')}`;
      if (builtin() || next !== client.serverUrl) await useRemote(next);
    }
    return settingsView();
  });
  // -- the built-in server
  handle('stack:status', () => (stack ? stack.status() : null));
  handle('stack:restart', async () => {
    if (!stack) throw new Error('This app is using another LineRight Regbot server.');
    return stack.restartAll();
  });
  handle('stack:dmv', async ({ target }) => {
    const next = target === 'live' ? 'live' : 'standin';
    store.set('dmvTarget', next);
    if (!stack) return null;
    const state = await stack.setDmv(next);
    // The DMV's booking pages moved with it.
    refreshSites('dmv changed');
    return state;
  });
  handle('stack:open', ({ what, next }) => openServerPage(what, next));
  handle('update:check', () => updates.check());
  handle('update:install', () => updates.install());
  handle('sync:now', () => loop.poke());
  handle('app:info', () => settingsView());
  handle('app:about', () => showAbout());
  handle('robots:status', () => (reader ? { ...reader.state(), ...booker.state() } : null));
  // Asked for from Settings, which has already shown what goes and been told yes.
  handle('app:reset', ({ confirm }) => {
    if (confirm !== true) throw new Error('A reset has to be confirmed.');
    return resetEverything();
  });
}

// ------------------------------------------------------------------ updates
function wireUpdates() {
  let autoUpdater = null;
  try {
    ({ autoUpdater } = require('electron-updater'));
  } catch (err) {
    updateState = { phase: 'disabled', message: `electron-updater unavailable: ${err.message}` };
    return;
  }
  updates = updater.wire(autoUpdater, {
    feedUrl: store.get('updateUrl', ''),
    isPackaged: app.isPackaged,
    force: process.env.REGBOT_FORCE_UPDATES === '1',
    log,
    onState: (state) => { updateState = state; trace(`update: ${JSON.stringify(state)}`); send('update:state', state); },
  });
}

// --------------------------------------------------------------- full reset
/**
 * Settings → Start over: everything this app keeps on this computer deleted,
 * and the app carried on as on its first launch — the server on this
 * computer made afresh (a new account, no lines, no credits), an empty profile,
 * the default settings, nothing any booking site stored in a tab, and no
 * sign-in to anybody else's server, which is told to forget this device.
 *
 * In this process rather than by relaunching: a relaunched AppImage would be
 * started from a mount that goes away with the process that asked. The update
 * feed a reset forgets stays the one in use until the app next starts.
 */
async function resetEverything() {
  if (resetting) throw new Error('A reset is already under way.');
  if (closing) throw new Error('The app is closing.');
  resetting = true;
  try {
    log('full reset: stopping the server and deleting what this app keeps on this computer');
    loop.stop();
    if (pinger) pinger.stop();
    connection = null;
    generation += 1;
    await reader.release(1500);
    reader.stop();
    cancelSignIn();
    for (const id of [...tabs.order]) tabs.close(id);
    if (stack) {
      const was = stack;
      stack = null;
      was.removeAllListeners();
      await was.stop();
    }
    send('stack:state', null);
    let removed;
    try {
      removed = reset.wipe(app.getPath('userData'));
    } catch (err) {
      // Only the server's folder can refuse, and it goes first: the profile,
      // the settings and the tabs' data are untouched, so the app carries on
      // with them and with whatever of the server is left.
      log(`full reset: stopped — ${err.message}`);
      if (builtin() && !closing) { client.token = makeStack().token; startStack(); }
      if (!closing) loop.start();
      throw new Error(`The reset stopped: the server's data could not be deleted (${err.message}). `
        + 'Your profile and settings were left as they were. Restart the app and try again.');
    }
    // Somebody else's server keeps the account; this device comes off it, as
    // File → Sign out would take it off, so no token for it outlives the reset.
    if (!builtin() && client.paired) {
      await Promise.race([client.unpair().catch(() => {}), new Promise((resolve) => setTimeout(resolve, 5000))]);
    }
    // What pages stored: sign-ins and everything else from booking sites in
    // the tabs, and the app page's own storage.
    for (const s of [session.defaultSession, session.fromPartition(tabs.partition)]) {
      await s.clearStorageData();
      await s.clearCache();
      await s.clearAuthCache();
    }
    if (closing) return;
    if (telemetry) telemetry.clear();
    loadState();
    lastDoc = null;
    sitesCache = [];
    opened.clear();
    if (booker) booker.forget();
    standingBack.clear();
    bookingOrigins.clear();
    offered = null;
    lastFill = null;
    lastNavigate = null;
    wireSync();
    reader.restart();
    rebuildMenu();
    if (builtin()) startStack();
    refreshSites('reset');
    // The page starts over too, and asks for its state as it does at launch.
    chromeContents.once('did-finish-load', () => {
      send('update:state', updateState);
      send('shell:state', tabs.state());
      send('toast', { kind: 'ok', text: 'Everything was reset. This is the app as it was when first opened.' });
    });
    chromeContents.reload();
    log(`full reset: done (deleted ${removed.length ? removed.join(', ') : 'nothing on disk'}; browsing data cleared)`);
  } finally {
    resetting = false;
  }
}

// ----------------------------------------------------------------- shutdown
// Electron cannot shut down cleanly while tab views are still alive ("Failed
// to shutdown", and a process that never exits), so every view is closed
// first, and the exit happens on the next turn of the loop.
let exiting = false;
function shutdown(code = 0) {
  if (closing) return;
  closing = true;
  trace('shutdown');
  cancelSignIn();
  if (sitesTimer) clearInterval(sitesTimer);
  if (importAgainTimer) clearInterval(importAgainTimer);
  try { if (loop) loop.stop(); } catch { /* not started */ }
  try { if (pinger) pinger.stop(); } catch { /* not started */ }
  try {
    if (telemetryTimer) clearInterval(telemetryTimer);
    if (telemetry) { telemetry.event('stop'); telemetry.save(); }
  } catch { /* the numbers are never the problem */ }
  // The read this app is at goes back to the site now, so no line waits on an
  // app that is gone; then the robots stop.
  let released = Promise.resolve(false);
  try { if (reader) released = reader.release(1500); } catch (err) { trace(`giving the read back: ${err.message}`); }
  try { if (reader) reader.stop(); } catch (err) { trace(`stopping the robots: ${err.message}`); }
  try { if (updates.stop) updates.stop(); } catch { /* not wired */ }
  // Gone from the screen at once; the views themselves go last, in the same
  // turn as the exit (see send()).
  try { if (win && !win.isDestroyed()) win.hide(); } catch (err) { trace(`hide: ${err.message}`); }
  const exit = () => {
    exiting = true;
    try { if (tabs) tabs.destroy(); } catch (err) { trace(`destroy tabs: ${err.message}`); }
    try { if (chrome) { win.contentView.removeChildView(chrome); chromeContents.close(); } } catch (err) { trace(`close chrome: ${err.message}`); }
    trace('exit');
    setImmediate(() => app.exit(code));
  };
  if (!stack) { released.catch(() => {}).then(exit); return; }
  // The server, the processor and a robot mid-run go with the app — bounded,
  // so a process that will not die cannot keep the app alive either. (Were
  // the app itself killed, each one's lifeline would close and it would go.)
  Promise.all([Promise.race([stack.stop(), new Promise((resolve) => setTimeout(resolve, 6000))]),
    released.catch(() => {})])
    .catch((err) => trace(`stopping the server: ${err.message}`))
    .then(exit);
}

// -------------------------------------------------------------------- smoke
function smoke() {
  const after = Number(argv['exit-after'] || 8000);
  setInterval(() => trace('tick'), 500);
  setTimeout(() => {
    trace('smoke: building result');
    const shellState = tabs.state();
    const result = {
      ok: true, version: app.getVersion(), server: client.serverUrl, paired: client.paired,
      synced: Boolean(lastDoc), handoffs: lastDoc ? lastDoc.handoffs.length : 0,
      positions: lastDoc ? lastDoc.positions.length : 0,
      mode: shellState.mode,
      tabs: shellState.tabs.map((t) => ({ kind: t.kind, url: t.url, title: t.title, jobId: t.jobId })),
      chromeHeight: tabs.chromeHeight, packaged: app.isPackaged, updates: updateState,
      menu: menu.outline(Menu.getApplicationMenu().items.map((i) => ({ label: i.label, submenu: (i.submenu ? i.submenu.items : []).map((s) => ({ label: s.label, type: s.type, role: s.role })) }))),
      sites: sitesCache.length,
      profile: { filled: profile.view().filled, encrypted: profile.encrypted, backend: profile.backend },
      browsers: browsers.scan().map((b) => ({ name: b.name, known: b.known, profiles: b.profiles.length })),
      offerImport: importWorthOffering(),
      robots: reader ? { ...reader.state(), ...booker.state() } : null,
      ping: pinger ? { last: pinger.last, everyMs: pinger.everyMs } : null,
      telemetry: telemetry ? { summary: telemetry.summary(), events: telemetry.events.length, shares: telemetry.shares } : null,
      connection,
      autofill: lastFill,
      screen: lastNavigate,
      bookingOrigins: [...bookingOrigins],
      serverMode,
      stack: stack ? (({ url, dmv, dmvBase, owner, packaged, python, services }) => ({
        url, dmv, dmvBase, owner, packaged, python,
        services: Object.fromEntries(Object.entries(services).map(([name, s]) => [name, { state: s.state, port: s.port, pid: s.pid, message: s.message }])),
      }))(stack.status()) : null,
    };
    trace('smoke: exiting');
    console.log(`SMOKE ${JSON.stringify(result)}`);
    shutdown(0);
  }, after);
}

// --------------------------------------------------------------------- main
/** The public regbot site this build pairs with, from config.json; '' when it names none. */
function siteUrl() {
  return String(bundled().serverUrl || '').trim().replace(/\/+$/, '');
}

/**
 * The settings, the profile, and which server with what token: at launch, and
 * again after a reset. See server-choice.js for the order of who decides.
 */
function loadState() {
  store = new Store(path.join(app.getPath('userData'), 'regbot.json'));
  profile = new Profile(path.join(app.getPath('userData'), 'profile.json'), safeStorage);
  const choice = serverChoice.resolve({ argv, env: process.env, store });
  serverMode = choice.mode;
  forcedRun = choice.forced;
  client = new SyncClient({
    serverUrl: choice.url,
    token: choice.token,
    app: { name: store.get('clientName'), version: app.getVersion(), platform: process.platform },
    onRequest: (r) => { if (telemetry) telemetry.request(r); },
  });
  if (builtin()) client.token = makeStack().token;
  pairState = { paired: client.paired, user: null, pending: null, message: '' };
}

async function main() {
  wireTelemetry();
  loadState();
  robots = new RobotRunner({
    paths: locate({ packaged: app.isPackaged, resourcesPath: process.resourcesPath, appPath: app.getAppPath() }),
    node: process.execPath,
    stateDir: path.join(app.getPath('userData'), 'robots'),
    log: (message) => log(`robots: ${message}`),
    onRun: (r) => telemetry.robot(r),
  });
  const robotsState = () => ({ ...reader.state(), ...booker.state() });
  reader = new Reader({
    runner: robots, getClient: () => client, getStore: () => store,
    log: (message) => log(`reader: ${message}`),
    onState: () => send('robots:state', robotsState()),
    onRead: (r) => telemetry.read(r),
  });
  booker = new Booker({
    runner: robots, reader, getClient: () => client, getStore: () => store,
    getProfile: () => profile.values(),
    log: (message) => log(`booker: ${message}`),
    onState: () => send('robots:state', robotsState()),
    onOutcome: (r) => telemetry.booking(r),
  });

  win = new BaseWindow({
    width: 1280, height: 860, minWidth: 760, minHeight: 480,
    title: 'LineRight Regbot', backgroundColor: '#f4f6fb', show: true,
  });
  chrome = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, sandbox: true, nodeIntegration: false,
    },
  });
  chromeContents = chrome.webContents;
  // The application page is this app's own file, and it holds the bridge to
  // everything the app can do (preload.js). It never becomes another page: a
  // link that would take it elsewhere, or a file dropped on it, goes to a tab
  // or the browser instead, and a new window is never opened from it.
  chromeContents.on('will-navigate', (event, url) => {
    event.preventDefault();
    if (webPage(url)) tabs.open(url, { activate: true });
  });
  chromeContents.setWindowOpenHandler(({ url }) => {
    if (webPage(url)) openExternal(url).catch(() => {});
    return { action: 'deny' };
  });
  tabs = new Shell(win, { chromeView: chrome, chromeHeight: CHROME_BASE });
  tabs.on('state', (state) => send('shell:state', state));
  wireAutofill();

  // Handlers before the page: it asks for its state the moment it loads.
  wireIpc();
  await chromeContents.loadFile(path.join(__dirname, '..', 'ui', 'index.html'));
  wireSync();
  wireUpdates();
  rebuildMenu();
  send('pair:state', pairState);
  send('update:state', updateState);
  send('shell:state', tabs.state());
  refreshSites('start');
  sitesTimer = setInterval(() => refreshSites(), SITES_EVERY_MS);
  // The page asks at startup itself (import:again-state); this is for the days after.
  importAgainTimer = setInterval(offerImportAgain, IMPORT_AGAIN_CHECK_MS);

  // --page=console | --page=site:ca-dmv | --page=board:20 ... and --open=<url>:
  // start somewhere in particular. For trying a screen, and for screenshots.
  if (argv.page || argv.open) {
    setTimeout(() => {
      if (argv.page) {
        const [page, arg] = String(argv.page).split(':');
        navigate(page, page === 'site' ? { slug: arg } : page === 'board' ? { id: Number(arg) } : {});
      }
      if (argv.open) {
        const target = normalizeUrl(String(argv.open));
        if (target) { rememberBookingOrigin(target); tabs.open(target, { kind: 'portal', title: 'Booking site' }); }
      }
    }, 1500);
  }

  // Not awaited: the window says the server is starting until its site is up.
  if (builtin()) startStack();

  // Kept open until the server has stopped; shutdown() ends in an exit.
  win.on('close', (event) => {
    if (exiting) return;
    event.preventDefault();
    shutdown(0);
  });
  log(`LineRight Regbot ${app.getVersion()} — server ${builtin() ? `on this computer (${stack.paths.packaged ? 'bundled' : `python ${stack.paths.python}`})` : client.serverUrl} — ${client.paired ? 'signed in' : 'not signed in'} — profile ${profile.view().filled ? (profile.encrypted ? 'encrypted' : 'plain') : 'empty'} (keychain: ${profile.backend})`);
  // The Linux launcher adds this where the system allows Chromium no sandbox
  // (scripts/linux-launcher.js); say so, since tabs show the open web.
  if (app.commandLine.hasSwitch('no-sandbox')) log("pages run without Chromium's sandbox (--no-sandbox)");
  if (argv.smoke) smoke();
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => { if (win) { win.show(); win.focus(); } });
  app.on('window-all-closed', () => shutdown(0));
  // Held until the server this app runs has stopped; shutdown() exits itself.
  app.on('before-quit', (event) => {
    if (exiting) return;
    event.preventDefault();
    shutdown(0);
  });
  app.whenReady().then(main).catch((err) => {
    console.error(err);
    app.exit(1);
  });
}
