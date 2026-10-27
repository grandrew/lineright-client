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
 * person's own slot when it is theirs (booker.js).
 *
 * Developer mode (developer.js; View → Developer mode, or --developer) adds
 * what only the people who work on regbot need: the test sites a development
 * server lists, marked as test sites; Chromium's developer tools; and the
 * servers that are not the public site — another one at an address, or
 * Practice on this computer, which runs the whole of regbot here instead (the
 * website, the queue processor, and the stand-in the robots practise on, from
 * a lineright-server checkout: stack.js), signed in to as the person with no
 * sign-in at all. See ../README.md.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const {
  app, BaseWindow, WebContentsView, ipcMain, Menu, Notification, dialog, safeStorage, session,
  shell: osShell, powerMonitor,
} = require('electron');

const { Store, bundled } = require('./store');
const serverChoice = require('./server-choice');
const developerMode = require('./developer');
const { SyncClient, SyncLoop, NotPaired, diffHandoffs, describeHandoff, clock } = require('./sync');
const { Shell } = require('./shell');
const { Profile, KEYS } = require('./profile');
const browsers = require('./import');
const reimport = require('./reimport');
const needs = require('./needs');
const { buildFillScript, isBookingPage, originOf } = require('./autofill');
const { webPage, paymentPage, approvalPage } = require('./links');
const { prefillFromUrl } = require('./portal');
const { outsideReach, reachFor } = require('./reach');
const turnTabs = require('./turntabs');
const { guideScript } = require('./dmv-guide');
const { cancelValues, cancelScript } = require('./dmv-cancel');
const { Reminders } = require('./bookings');
const menu = require('./menu');
const updater = require('./updater');
const { Stack, locate, NO_SERVER } = require('./stack');
const reset = require('./reset');
const { RobotRunner, isLoopback } = require('./robots');
const { Reader } = require('./reader');
const { Booker, mayBook, definitive } = require('./booker');
const { Overseer } = require('./overseer');
const { runSiteTask } = require('./agent/sitetask');
const { Pinger } = require('./pinger');
const confirmations = require('./confirmations');
const { Telemetry } = require('./telemetry');
const { Logbook } = require('./logbook');
const { watchTab } = require('./pagelog');
const { Scrubber } = require('./scrub');
const { TraceStore } = require('./traces');
const { TraceTaps } = require('./tracetaps');

const CHROME_BASE = 98;          // tab strip + address bar + the line, in browser mode
const SITES_EVERY_MS = 10 * 60 * 1000;
// How often to look whether the weekly re-import is due, for an app left running for days.
const IMPORT_AGAIN_CHECK_MS = 30 * 60 * 1000;
// How often this app's own numbers are sampled and saved, and, when its person
// turned sharing on, how often they are shared with the site at most.
const TELEMETRY_EVERY_MS = 60 * 1000;
const AUTO_SHARE_EVERY_S = 6 * 3600;
// How often the trace says how the app has been doing (app.stats): syncs, round trips, memory.
const TRACE_STATS_EVERY_MS = 5 * 60 * 1000;

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
// The app is in English, and so is every date and time in it: the native date
// and time boxes, and what a page in a tab asks a site for, too — the booking
// sites are American. Left to the system, a Russian Mac drew "вт, 6 окт." among
// English words. The app's own formatting names en-US as well (english.test.js).
app.commandLine.appendSwitch('lang', 'en-US');

function log(...parts) {
  console.log(new Date().toISOString().slice(11, 19), ...parts);
  if (logbook) logbook.line('app', parts.join(' '));
  trace(parts.join(' '));
}

/**
 * One request to the LineRight Regbot site, in the logs (site-<day>.jsonl):
 * what was sent and what came back. An answer the same as that path's last —
 * the sync's, every few seconds, most of the time — is written as "same".
 */
function logSiteExchange({ method, path: where, status, ms, body, reply, error }) {
  if (!logbook) return;
  const record = { method, path: where, status, ms };
  if (body !== undefined) record.body = body;
  if (error) record.error = error;
  if (reply !== undefined) {
    let text = '';
    try { text = JSON.stringify(reply); } catch { /* written as it is */ }
    if (text && lastReplies.get(where) === text) record.same = true;
    else {
      lastReplies.set(where, text);
      record.reply = reply;
    }
  }
  logbook.event('site', record);
}

/** What the app did on the page in a tab, among the rest of that page's log (pagelog.js). */
function pageNote(tabId, type, fields) {
  const watcher = pageLogs.get(tabId);
  if (watcher) watcher.note(type, fields);
}

/** The logs folder, in whatever this machine opens folders with. */
async function openLogs() {
  if (!logbook) throw new Error('This app keeps no logs yet.');
  logbook.folder();
  const failed = await osShell.openPath(logbook.dir);
  if (failed) throw new Error(failed);
}

// REGBOT_TRACE=<file>: a synchronous, timestamped trace of what the main
// process is doing, for the smoke test and for a report when the app misbehaves
// on a machine where stdout is not to hand.
function trace(text) {
  if (!process.env.REGBOT_TRACE) return;
  try {
    fs.appendFileSync(process.env.REGBOT_TRACE, `${Date.now() % 100000} ${text}\n`);
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
let developer = { on: false, forced: null }; // developer mode (developer.js), and what holds it on
let stack = null;                 // the built-in server, while that is the one in use
let reregistering = false;        // the built-in site is being restarted to learn the app's token again
let closing = false;              // shutdown() has begun
let resetting = false;            // Settings → Start over is under way
let robots = null;                // the DMV robots this app runs for the regbot site (robots.js)
let reader = null;                // looking for openings when the site asks (reader.js)
let booker = null;                // booking the person's own slot (booker.js)
let overseer = null;              // AI oversight of that booking robot, when the person has bought it (overseer.js)
let reminders = null;             // the person's appointments, and a reminder before each (bookings.js)
const cancelling = new Map();     // booking id -> how cancelling it on the booking site goes: {phase, text, tabId}
const cancelsUnsaid = new Map();  // booking id -> how it was cancelled, until the site has heard
let pinger = null;                // presence, timing, and hearing of a slot at once (pinger.js)
let connection = null;            // how this app's connection stands, as the site last said
let telemetry = null;             // this app's own numbers, kept here (telemetry.js)
let traces = null;                // what this app did, kept for the site to ask for (traces.js)
let scrubber = null;              // what takes the person out of it: their details, however spelt (scrub.js)
let taps = null;                  // what makes it from the logs and the robots' runs (tracetaps.js)
let traceTimer = null;
let tracesUploading = null;       // the ask an upload is on its way for
let tracesRefused = null;         // {id, until}: an ask whose upload failed, not tried again before `until`
let telemetryTimer = null;
let logbook = null;               // what the app did, kept on this computer for a few days (logbook.js)
let pruneTimer = null;
const pageLogs = new Map();       // tab id -> what writes its page down (pagelog.js)
const lastReplies = new Map();    // site path -> its last answer, so an unchanged one is not written again
let sharing = false;              // a share is on its way to the site
let shareAccepted = null;         // what the site said, on the last sync, about taking shares
let autoShareAfter = 0;           // no automatic share before this (epoch ms): after a refusal
let asked = null;                 // the lines this person asked for, as the last sync said: id -> answered_at
let generation = 0;               // counts resets: a robot's answer from before one is dropped
const opened = new Set();         // hand-off job ids a tab was opened for
const confirmationTabs = new Map(); // hand-off job id -> the tab its DMV confirmation opened in
const standingBack = new Set();   // hand-offs another of the person's devices is booking
const bookingOrigins = new Set(); // origins the app itself sent the person to book at

// Through a kept reference, and never while closing: Electron (38, at least on
// Linux) wedges its main thread for good when a view's contents are reached
// through the view, or sent to, after they have been closed — and stopping
// the server this app runs takes long enough for events to arrive meanwhile.
function send(channel, payload) {
  // What the app told its person, in the trace: what went wrong for them is the first thing to know.
  if (channel === 'toast' && traces && payload) traces.add('ui.toast', { kind: payload.kind, text: payload.text });
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
  bookedInTab.clear();
  turnCards.clear();
  standingBack.clear();
  sitesCache = [];
  forgetBookings();
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
  noteDeveloper();
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
  noteDeveloper();
  loop.poke();
  startStack();
}

// ----------------------------------------------------------- developer mode
/**
 * Developer mode as it stands now (developer.js), told to the menu and the
 * screens when it changed: which sites are listed, what Settings offers.
 */
function noteDeveloper() {
  const was = developer;
  developer = developerMode.resolve({ argv, env: process.env, store, practice: builtin() });
  if (was.on === developer.on && was.forced === developer.forced) return;
  log(`developer mode ${developer.on ? 'on' : 'off'}${developer.forced === 'practice' ? ' (practising)' : developer.forced ? ' (--developer)' : ''}`);
  if (!developer.on) sitesCache = sitesCache.filter((s) => !s.mock);
  rebuildMenu();
  send('developer:state', developer);
  // Turned on, the test sites are listed again; the server is asked.
  if (developer.on) refreshSites('developer mode');
}

/** View → Developer mode: on or off, and remembered. Not while a run or practice holds it on. */
function setDeveloper(on) {
  if (developer.forced) {
    send('toast', { kind: 'warn', text: developer.forced === 'practice'
      ? 'Developer mode stays on while the app practises on this computer: Settings → Server leaves practice.'
      : 'This run was started with --developer, so developer mode stays on until the app starts again.' });
    rebuildMenu();
    return;
  }
  if (on) store.set('developerMode', true);
  else if (store.chosen('developerMode')) store.delete('developerMode');
  noteDeveloper();
  const elsewhere = !on && !builtin() && client.serverUrl !== siteUrl();
  send('toast', { kind: 'ok', ms: 9000, text: on
    ? 'Developer mode is on: test sites are listed, each marked as one, and Settings offers practice and other servers.'
    : `Developer mode is off: the app shows what everybody else sees.${elsewhere ? ` It stays on ${client.serverUrl} until you choose LineRight Regbot in Settings.` : ''}` });
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
    sites: sitesCache.map((s) => ({ name: s.name, slug: s.slug, mock: s.mock })),
    developer,
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
      developer: () => setDeveloper(!developer.on),
      controlRoom: () => openServerPage('admin').catch((err) => send('toast', { kind: 'bad', text: err.message })),
      serverLogs: () => openServerPage('logs').catch((err) => send('toast', { kind: 'bad', text: err.message })),
      openLogs: () => openLogs().catch((err) => send('toast', { kind: 'bad', text: err.message })),
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
    ...(developer.on ? ['Developer mode: on'] : []),
    '',
    'Your place in line for appointments that are hard to get. This app shows your lines, looks for openings, and books your slot when it is your turn — or opens the booking page for you to finish. It keeps your personal details on this machine and never sees your password.',
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
    sitesCache = developerMode.sitesFor(doc.sites, developer.on);
    for (const s of sitesCache) if (s.portal_url) rememberBookingOrigin(s.portal_url);
    rebuildMenu();
    trace(`sites: ${sitesCache.length} (${reason})`);
  } catch (err) {
    trace(`sites failed: ${err.message}`);
  }
}

// ------------------------------------------------------------- signing in
function setPair(next) {
  if (traces && typeof next.paired === 'boolean' && next.paired !== pairState.paired) traces.add('app.pair', { paired: next.paired });
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
  bookedInTab.clear();
  turnCards.clear();
  standingBack.clear();
  forgetBookings();
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
      if (traces) traces.add('handoff.click', { job: handoff.job_id });
      win.show();
      win.focus();
      const tab = tabs.tabFor(handoff.job_id);
      if (tab) tabs.select(tab.id);
    });
    note.show();
    if (traces) traces.add('handoff.notify', { job: handoff.job_id, title });
  } catch (err) {
    log('notification failed:', err.message);
  }
}

// ----------------------------------------------------------------- bookings
/**
 * A reminder before an appointment (bookings.js), on the desktop: clicking it
 * opens My Bookings. The sound is the app page's (bookings:chime).
 */
function remindNote({ title, body, booking, kind }) {
  if (traces) traces.add('booking.remind', { booking: booking && booking.id, kind });
  if (process.env.REGBOT_NO_NOTIFY === '1' || !Notification.isSupported()) return;
  try {
    const note = new Notification({ title, body, silent: false,
      urgency: kind === 'hour' || kind === 'test' ? 'critical' : 'normal' });
    note.on('click', () => {
      if (win) { win.show(); win.focus(); }
      navigate('bookings');
    });
    note.show();
  } catch (err) {
    log('notification failed:', err.message);
  }
}

function reminderChime(kind) {
  if (store.get('reminderSound', true) === false && kind !== 'test') return;
  send('bookings:chime', { kind });
}

/** The picture this computer's robot kept of an appointment's confirmation page, if it kept one. */
function confirmationShot(b) {
  if (!b || !b.job_id || !client) return null;
  const dir = path.join(app.getPath('userData'), 'robots', 'confirmations');
  let host = '';
  try { host = new URL(client.serverUrl).host.replace(/[^A-Za-z0-9._-]+/g, '_'); } catch { return null; }
  try {
    const hit = fs.readdirSync(dir)
      .filter((f) => f.endsWith('.png') && f.startsWith(`${host}_`) && f.includes(`-job-${Number(b.job_id)}-`))
      .sort().pop();
    return hit ? path.join(dir, hit) : null;
  } catch {
    return null;
  }
}

/** What My Bookings shows: every appointment with its next reminder, and how a cancel is going. */
function bookingsView() {
  const v = reminders ? reminders.view() : { list: [], coming: 0 };
  return {
    ...v,
    list: v.list.map((b) => ({ ...b, shot: Boolean(confirmationShot(b)), cancelling: cancelling.get(b.id) || null })),
    sound: store.get('reminderSound', true) !== false,
  };
}

function sendBookings() {
  send('bookings:state', bookingsView());
}

/** Another account, or another site: its appointments go with it. */
function forgetBookings() {
  cancelling.clear();
  cancelsUnsaid.clear();
  if (reminders) reminders.update([]);
}

/** What the site says the appointments are, with the cancellations it has not heard of yet. */
function noteBookings(list) {
  if (!reminders || !Array.isArray(list)) return;
  reminders.update(list);
  for (const id of cancelsUnsaid.keys()) reminders.cancelled(id);
  sendBookings();
  // Said again, until the site has heard.
  for (const [id, how] of [...cancelsUnsaid]) {
    const b = list.find((x) => x.id === id);
    if (b && b.status === 'cancelled') { cancelsUnsaid.delete(id); continue; }
    client.bookingCancelled(id, how).then(() => cancelsUnsaid.delete(id))
      .catch((err) => log(`the site did not hear that booking ${id} is cancelled: ${err.message}`));
  }
}

/** This appointment is cancelled: no more reminders for it, and the site is told. */
async function bookingGone(b, how) {
  reminders.cancelled(b.id);
  cancelsUnsaid.set(b.id, how);
  try {
    await client.bookingCancelled(b.id, how);
    cancelsUnsaid.delete(b.id);
  } catch (err) {
    log(`the site did not hear that booking ${b.id} is cancelled: ${err.message} — said again on the next sync`);
  }
  if (loop) loop.poke();
}

const FIELD_WORDS = { first_name: 'first name', last_name: 'last name', phone: 'phone number',
  email: 'email address', dl_number: 'licence number', dob: 'date of birth' };

function whereBooked(b) {
  return `${b.office_name || b.queue_name} on ${b.date} at ${b.time}`;
}

function cancelProgress(id, phase, text = '', tabId = null) {
  const was = cancelling.get(id) || {};
  cancelling.set(id, { phase, text, tabId: tabId || was.tabId || null, at: Date.now() });
  sendBookings();
}

/**
 * Cancel an appointment on the booking site's own page, in a tab the person
 * watches: the cancel guide (dmv-cancel.js) types in the name and phone number
 * it was booked under, finds it by its confirmation number, and answers the
 * site's "Are you sure?". The person said yes in the app first.
 */
function cancelBooking(id) {
  const b = reminders && reminders.find(id);
  if (!b || b.status !== 'booked') throw new Error('That appointment is not among your bookings any more.');
  if (!b.manage_url) {
    throw new Error(`The app cannot cancel appointments on ${b.site_name || 'this site'}. Cancel it on that site, then mark it cancelled here.`);
  }
  const values = profile.values();
  const missing = (b.cancel_needs || []).filter((k) => !String(values[k] || '').trim());
  if (missing.length) {
    const words = missing.map((k) => FIELD_WORDS[k] || k);
    const err = new Error(`To find your appointment, the DMV asks for your ${words.join(' and ')}. Add ${missing.length === 1 ? 'it' : 'them'} to your profile first.`);
    err.body = { missing };
    throw err;
  }
  const was = cancelling.get(b.id);
  if (was && was.phase === 'cancelling' && was.tabId && tabs.tabs.has(was.tabId)) {
    tabs.select(was.tabId);
    return { tab: was.tabId, already: true };
  }
  const tabId = tabs.open(b.manage_url, { kind: 'page', title: `Cancel — ${b.office_name} ${b.date}` });
  const tab = tabs.tabs.get(tabId);
  tab.cancelGuide = { booking: b, values: cancelValues(values), runs: 0, done: false };
  log(`cancelling booking ${b.id} (${whereBooked(b)}, confirmation ${b.confirmation}) on ${b.manage_url}`);
  if (traces) traces.add('booking.cancel', { booking: b.id, step: 'start' });
  cancelProgress(b.id, 'cancelling', 'Cancelling it on the DMV page… If the DMV asks you to prove you are a person, do it in the page.', tabId);
  if (!tab.loading) runCancel(tab);
  return { tab: tabId };
}

function runCancel(tab) {
  const g = tab && tab.cancelGuide;
  if (!g || g.done) return;
  if (g.running) { g.again = true; return; }
  if (g.runs >= 8) return;
  g.running = true;
  g.again = false;
  g.runs += 1;
  const b = g.booking;
  tab.view.webContents.executeJavaScript(cancelScript(b, g.values), true).then((status) => {
    g.running = false;
    finishCancel(tab, b, String(status || ''));
  }).catch((err) => {
    g.running = false;
    if (!tabs.tabs.has(tab.id)) {
      g.done = true;
      log(`cancelling booking ${b.id}: its page was closed`);
      cancelProgress(b.id, 'stopped', 'The DMV page was closed before the appointment was cancelled.');
      return;
    }
    // The page went to another address part way: it runs again once that has loaded.
    log(`cancelling booking ${b.id}: the page moved on (${err.message})`);
    if (g.again && !tab.loading) runCancel(tab);
  });
}

function finishCancel(tab, b, status) {
  const g = tab.cancelGuide;
  g.done = true;
  log(`cancelling booking ${b.id}: ${status}`);
  if (traces) traces.add('booking.cancel', { booking: b.id, step: status.split(/[:,]/)[0].slice(0, 40) });
  if (status === 'cancelled') {
    cancelProgress(b.id, 'cancelled', `Cancelled on the DMV: ${whereBooked(b)}.`);
    send('toast', { kind: 'ok', ms: 15000, text: `Cancelled: ${b.queue_name} — ${whereBooked(b)}. The DMV has given the time back.` });
    remindNote({ title: 'Appointment cancelled', body: `${b.queue_name} — ${whereBooked(b)}. Confirmation ${b.confirmation}.`, booking: b, kind: 'cancelled' });
    bookingGone(b, 'app');
    return;
  }
  if (status === 'none' || status === 'not-listed') {
    cancelProgress(b.id, 'not-listed', status === 'none'
      ? 'The DMV lists no appointments under your name and phone number. If this one was cancelled already, mark it cancelled here.'
      : `The DMV lists appointments under your name and phone number, but none at ${b.office_name} on ${b.date} at ${b.time}. If this one was cancelled already, mark it cancelled here.`);
    return;
  }
  if (status === 'ambiguous') {
    cancelProgress(b.id, 'not-listed', `The DMV lists more than one appointment on ${b.date} at ${b.time} under your name and phone number, so the app touched none of them. Cancel the right one on the DMV page.`);
    return;
  }
  if (status.startsWith('error:')) {
    cancelProgress(b.id, 'error', `The DMV said: ${status.slice(6).trim()} Try again in a few minutes, or finish on its page.`);
    return;
  }
  cancelProgress(b.id, 'stopped', `The app stopped part way (${status.replace(/^stopped /, '')}). Finish on the DMV page, or try again.`);
}

function handleDoc(doc) {
  const { arrived, gone, kept } = diffHandoffs(lastDoc ? lastDoc.handoffs : [], doc.handoffs);
  noteTraces(doc, { arrived, gone, kept, before: lastDoc });
  trace(`doc: ${doc.positions.length} positions, ${doc.handoffs.length} handoffs, ${arrived.length} new`);
  lastDoc = doc;
  for (const p of doc.positions) if (p.portal_url) rememberBookingOrigin(p.portal_url);
  for (const h of doc.handoffs) if (h.open_url) rememberBookingOrigin(h.open_url);
  if (!pairState.paired || !pairState.user || pairState.user.nickname !== doc.user.nickname) {
    setPair({ paired: true, user: doc.user, pending: null, message: '' });
  }
  send('sync:doc', withNeeds(doc));
  noteBookings(doc.bookings);
  noteOversightTerms(doc.agent);
  noteAppsPolicy(doc.apps);
  if (reader && !builtin()) {
    if (doc.reader) reader.notePace(doc.reader);
    reader.offer(doc.reads || []);
  }
  if (booker && !builtin()) booker.retryReports();
  noteConnection(doc.latency);
  const current = new Set(doc.handoffs.map((h) => h.job_id));
  for (const id of [...standingBack]) if (!current.has(id)) standingBack.delete(id);
  noteTurnsOver(doc);
  // A turn that ended while its page was covered — another device booked it,
  // or its time ran out — is uncovered; one this computer's robot booked says so.
  for (const [id, card] of [...turnCards]) {
    if (card.kind === 'booking' && !current.has(id) && !(booker && booker.running.has(id))) setCard(id, null);
  }
  for (const h of doc.handoffs) {
    // The device of this person's that was booking it has gone quiet — closed,
    // crashed, off the network: this one takes it over rather than let it wait
    // out its deadline.
    if (standingBack.has(h.job_id) && h.phase === 'booking' && h.booker && !h.booker.you
        && h.booker.silent) {
      standingBack.delete(h.job_id);
      takeHandoff(h, `${h.booker.name} stopped answering while booking it`);
    } else if (standingBack.has(h.job_id) && booker && booker.recorded(h)) {
      // A robot this app left running when it stopped has booked it since:
      // that is the appointment, whoever holds the slot now.
      standingBack.delete(h.job_id);
      takeHandoff(h, 'this computer\'s robot booked it before the app stopped');
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
function rememberReach(bidId, code) {
  if (!bidId || !code) return;
  const reaches = { ...(store.get('reaches') || {}) };
  reaches[String(bidId)] = code;
  store.set('reaches', reaches);
}

function chosenReach(h) {
  const remembered = (store.get('reaches') || {})[String(h.bid_id)];
  const pos = lastDoc && (lastDoc.positions || []).find((p) => p.bid_id === h.bid_id);
  return reachFor(pos, remembered);
}

/**
 * A slot past the reach this bid asked for is passed, here, even when the
 * server still hands out the earliest opening in the window.
 */
function passIfTooFar(h) {
  const code = chosenReach(h);
  const pos = lastDoc && (lastDoc.positions || []).find((p) => p.bid_id === h.bid_id);
  const slot = h.slot;
  if (!code || !pos || !slot) return false;
  if (!outsideReach({
    preferredDate: pos.preferred_date, preferredTime: pos.preferred_time, code,
    slotDate: slot.date, slotTime: slot.time,
  })) return false;
  const where = describeHandoff(h);
  log(`passing ${where}: later than the ${code} you asked for`);
  send('toast', { kind: 'warn', ms: 12000,
    text: `${where} is farther than the ${code} you asked for, so it was passed. You keep your place.` });
  client.pass(h.job_id, `later than ${code}`).catch((err) => log(`pass failed: ${err.message}`));
  if (loop) loop.poke();
  return true;
}

function runGuide(tab) {
  if (!tab || !tab.guideSlot || tab.guideDone) return;
  if (tab.guideRunning) {
    tab.guideAgain = true;
    return;
  }
  tab.guideRunning = true;
  tab.guideAgain = false;
  const where = tab.guideWhere || 'this slot';
  const slot = tab.guideSlot;
  tab.view.webContents.executeJavaScript(guideScript(slot), true).then((status) => {
    if (tab.guideSlot !== slot) return; // the tab went on to the next turn meanwhile
    tab.guideRunning = false;
    if (status === 'time') tab.guideDone = true;
    log(`booking page for ${where}: ${status}`);
    if (tab.guideAgain && !tab.guideDone) runGuide(tab);
  }).catch((err) => {
    if (tab.guideSlot !== slot) return;
    tab.guideRunning = false;
    log(`booking page for ${where} could not be walked: ${err.message}`);
    if (tab.guideAgain && !tab.guideDone) runGuide(tab);
  });
}

function armGuide(h) {
  const tab = tabs && tabs.tabFor(h.job_id);
  if (!tab || !h.slot) return;
  tab.guideSlot = h.slot;
  tab.guideWhere = describeHandoff(h);
  if (!tab.loading) runGuide(tab);
}

function takeHandoff(h, note = '') {
  const took = (how, fields = {}) => { if (traces) traces.add('handoff.take', { job: h.job_id, how, note, ...fields }); };
  if (passIfTooFar(h)) { took('too_far'); return; }
  if (h.over) {
    // Offered to several of us, and it went before this app got to it.
    took('over', { over: h.over.kind });
    log(`${describeHandoff(h)}: ${h.over.message}`);
    return;
  }
  const robot = booker && !builtin() ? booker.wants(h) : { ok: false, why: 'practice' };
  took(robot.ok ? 'robot' : robot.why === 'elsewhere' ? 'elsewhere' : 'page', { robot_why: robot.ok ? undefined : robot.why });
  if (robot.ok) {
    log(`your turn: ${describeHandoff(h)} — ${note ? `${note}; ` : ''}booking it with this computer's robot`);
    notify(`Your turn — ${h.queue_name}`, `Booking ${describeHandoff(h)} for you now…`, h);
    // The page opens all the same, for the person to see where they are being
    // booked: covered while the robot is at the DMV's form, so that a booking by
    // hand cannot be made beside it.
    setCard(h.job_id, { kind: 'booking', title: 'Your app is booking this for you', where: describeHandoff(h),
      text: 'Its robot is filling in the DMV\'s form out of sight, with the details in your profile. '
        + 'Nothing to do here — please do not book it on this page as well. If the robot cannot finish, '
        + 'this page is yours to book it on.' });
    turnTab(h);
    if (!win.isVisible()) win.show();
    const mine = generation;
    booker.book(h).then((outcome) => { if (mine === generation) afterBooking(h, outcome); });
    return;
  }
  if (robot.why === 'elsewhere') {
    standingBack.add(h.job_id);
    log(`your turn: ${describeHandoff(h)} — ${robot.device} is booking it`);
    notify(`Your turn — ${h.queue_name}`, `${robot.device} is booking ${describeHandoff(h)}.`, h);
    setCard(h.job_id, elsewhereCard(h, robot.device));
    turnTab(h);
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
  if (traces) {
    traces.add('handoff.page', { job: h.job_id, why, secs_left: h.seconds_left,
      missing: gap.length ? gap.map((f) => f.profileKey) : undefined });
  }
  if (gap.length) {
    // Their turn is still their turn — notify, raise the window — but send
    // them to the profile rather than to a form nothing can fill in.
    gateToProfile(gap, {
      why: `${h.queue_name} is ready to book and your profile has no ${needs.phrase(gap)}.`,
      then: { action: 'handoff:open', args: { job_id: h.job_id } },
    });
    trace(`handoff gated: profile missing ${gap.map((f) => f.profileKey).join(', ')}`);
  } else {
    turnTab(h);
    armGuide(h);
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
  if (traces) traces.add('app.connection', { state: state(connection), ms: connection ? connection.ms : undefined, why: connection ? connection.why : undefined });
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

/**
 * AI oversight, as the person sees it: while it has the robot's page, the
 * booking's tab says so; and once, when the site first offers it to this
 * account, a word on what it is, what it costs, and where it is turned off.
 */
function noteOversight(o) {
  if (!o || !o.active) return;
  const card = turnCards.get(o.active.job_id);
  if (!card || card.kind !== 'booking') return;
  const text = o.active.stage === 'confirming'
    ? 'The robot sent the booking and could not see the DMV\'s confirmation. AI oversight is reading the page for it — nothing more is pressed.'
    : 'The robot got stuck on the DMV\'s pages. AI oversight has taken its browser over and is finishing the booking'
      + ` (${o.active.steps} step${o.active.steps === 1 ? '' : 's'} so far, ${o.active.credits} credit${o.active.credits === 1 ? '' : 's'}).`;
  if (card.text !== text) setCard(o.active.job_id, { ...card, title: 'AI oversight is finishing your booking', text });
}

function noteOversightTerms(terms) {
  if (!terms || !terms.available || !overseer || !overseer.on() || store.get('aiOversightNoticed', false)) return;
  store.set('aiOversightNoticed', true);
  send('toast', { kind: 'ok', ms: 30000, text: 'AI booking oversight is on: when the app\'s robot gets stuck on the DMV\'s pages, '
    + `an AI takes its browser over and finishes the booking — about ${terms.step_credits} credit${terms.step_credits === 1 ? '' : 's'} a step, `
    + `at most ${terms.session_credits} a booking, from the credits you bought. Settings → AI booking oversight turns it off.` });
}

/** What the app's robot made of the person's slot (booker.js), told to them. */
function afterBooking(h, outcome) {
  if (closing) {
    closingNote(h, outcome);
    return;
  }
  const where = describeHandoff(h);
  // Whatever came of it, the page is the person's again; booked, it says so;
  // another device of theirs at it, it says that.
  if (outcome.kind !== 'booked' && outcome.kind !== 'elsewhere') setCard(h.job_id, null);
  if (outcome.kind === 'booked') {
    log(`booked ${where} — DMV confirmation ${outcome.confirmation}`
        + (outcome.unreported ? ` (the site did not record it: ${outcome.unreported})` : ''));
    notify(`Booked — ${h.queue_name}`, `${where}. Confirmation ${outcome.confirmation}.`, h);
    const helped = outcome.overseen ? ' The robot got stuck on the DMV\'s pages, and AI oversight finished it.' : '';
    send('toast', outcome.unreported
      ? { kind: 'warn', ms: 20000, text: `Booked ${where} — confirmation ${outcome.confirmation}.${helped} The LineRight Regbot site did not record it: ${outcome.unreported}` }
      : { kind: 'ok', ms: 15000, text: `Booked ${where} — confirmation ${outcome.confirmation}.${helped}` });
    const shown = showConfirmation(h, outcome);
    if (shown) confirmationTabs.set(h.job_id, shown);
    setCard(h.job_id, { kind: 'booked', title: '✓ Booked', where, reference: `Confirmation ${outcome.confirmation}`,
      text: (shown ? 'The DMV\'s confirmation is open in the next tab. ' : 'Keep this number: it is what the DMV knows the appointment by. ')
        + (outcome.unreported ? `LineRight Regbot has not recorded it yet: ${outcome.unreported}`
          : 'LineRight Regbot has it recorded, and your bid is settled.') });
  } else if (outcome.kind === 'gone' && outcome.quiet) {
    log(`${where} was gone when the robot got there — ${outcome.device} may have booked it before it stopped answering`);
    send('toast', { kind: 'warn', ms: 20000, text: `${where} was no longer listed. ${outcome.device} was booking it before it stopped answering and may have got it — check your email for a confirmation.` });
  } else if (outcome.kind === 'gone') {
    log(`${where} was gone when the robot got there`);
    send('toast', { kind: 'warn', text: `${where} was gone by the time the app got there. You keep your place in line.` });
  } else if (outcome.kind === 'elsewhere') {
    standingBack.add(h.job_id);
    setCard(h.job_id, elsewhereCard(h, outcome.device));
    send('toast', { kind: 'ok', text: `${outcome.device} is booking ${where}.` });
  } else if (outcome.kind === 'late') {
    log(`${where}: ${outcome.why}`);
    send('toast', { kind: 'warn', text: `${where} is no longer held for you: ${outcome.why}` });
  } else {
    // The page, for the person to finish: while the slot is still theirs —
    // loaded afresh, the calendar under the cover being minutes old by now.
    const now = lastDoc && lastDoc.handoffs.find((x) => x.job_id === h.job_id);
    if (now) {
      const tab = tabs.tabFor(h.job_id);
      if (tab && now.open_url && !tab.view.webContents.isDestroyed()) tab.view.webContents.loadURL(now.open_url).catch(() => {});
      offerHandoff(now, outcome.why);
    } else {
      log(`${where}: ${outcome.why} — and it is no longer held for you`);
      send('toast', { kind: 'warn', ms: 15000, text: `The app could not book ${where}, and it is no longer held for you.`
        + (outcome.unconfirmed ? ' The DMV may have booked it anyway: check your email for a confirmation.' : '') });
    }
  }
  if (loop) loop.poke();
}

/**
 * A booking the app finished while it was closing (shutdown waits for it), told
 * the one way left: the window is gone, so a notification, and no click.
 */
function closingNote(h, outcome) {
  const where = describeHandoff(h);
  log(`${where}: ${outcome.kind} as the app closed${outcome.confirmation ? ` (DMV confirmation ${outcome.confirmation})` : ''}`);
  const note = outcome.kind === 'booked'
    ? { title: `Booked — ${h.queue_name}`, body: `${where}. Confirmation ${outcome.confirmation}.` }
    : outcome.kind === 'page'
      ? { title: `Not booked — ${h.queue_name}`, body: `The app's robot could not book ${where}. Open LineRight Regbot again to book it before its time runs out.` }
      : null;
  if (!note || process.env.REGBOT_NO_NOTIFY === '1' || !Notification.isSupported()) return;
  try {
    new Notification({ ...note, urgency: 'critical' }).show();
  } catch (err) {
    log('notification failed:', err.message);
  }
}

function wireSync() {
  // Each loop answers only while it is the app's: one a reset replaced may
  // still have a request out, for the account that was just deleted.
  const self = new SyncLoop(client, {
    // On the regbot site this app looks for openings when asked; its own
    // practice server looks for itself.
    // And how far this app's trace goes, for the site to ask for when it wants it (traces.js).
    body: () => ({ ...(reader && !builtin() ? { reader: reader.capabilities() } : {}),
      ...(traces ? { traces: traces.status() } : {}) }),
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
    // Which fields, and how each was matched; never what went in them.
    pageNote(tabId, 'autofill', { asked: Boolean(force), filled: result.filled, skipped: result.skipped, fields: result.fields });
    if (result.filled) {
      send('toast', { kind: 'ok', text: `Filled ${result.filled} field${result.filled === 1 ? '' : 's'} from your profile.` });
    } else if (force) {
      send('toast', { kind: 'warn', text: result.skipped ? 'Nothing to add — the form already has your details.' : 'No field on this page matches your profile.' });
    }
    send('autofill:done', lastFill);
    return lastFill;
  } catch (err) {
    trace(`autofill failed: ${err.message}`);
    pageNote(tabId, 'autofill', { asked: Boolean(force), error: err.message });
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
  if (force) tabs.touch(current.id);
  return fill(current.id, force);
}

function wireAutofill() {
  tabs.on('loaded', ({ id }) => {
    const tab = tabs.tabs.get(id);
    if (tab && tab.kind === 'handoff' && tab.guideSlot && !tab.guideDone) runGuide(tab);
    if (tab && tab.cancelGuide && !tab.cancelGuide.done) runCancel(tab);
  });
  tabs.on('loaded', ({ id, url, jobId }) => {
    // A turn's tab is read for a confirmation again after every load (lookAtEnded).
    const tab = tabs.tabs.get(id);
    if (tab) { tab.loads = (tab.loads || 0) + 1; tab.endLook = null; }
    // The cover goes back over every page while the robot books; "booked" is
    // said once, and stays gone once the person has looked underneath.
    if (jobId && turnCards.has(jobId) && turnCards.get(jobId).kind === 'booking') paintCard(jobId);
    checkHandoffTab(id);
    if (!profile.autofill) return;
    if (!isBookingPage(url, bookingOrigins)) return;
    fill(id, false);
  });
  // A booking site that draws its pages itself changes them without loading
  // one, so the confirmation is looked for every few seconds as well.
  setInterval(() => {
    for (const tab of tabs.tabs.values()) {
      if (tab.kind !== 'handoff') continue;
      checkHandoffTab(tab.id);
      if (tab.endedAt && !tab.endLook) lookAtEnded(tab.id);
    }
  }, 2000).unref();
  // A turn's tab nobody had a use for closes a while after its turn (turntabs.js).
  setInterval(sweepTurnTabs, Math.max(500, Math.min(30000, Math.round(turnTabCloseMs() / 4)))).unref();
}

// ------------------------------------------------------------ the turn's tab
/**
 * The turn's booking page, in a tab of its own: brought forward when it has
 * one; loaded in the tab of the last turn on the same line, when that turn is
 * over and its page went unused (turntabs.js); otherwise opened.
 */
function turnTab(h) {
  const existing = tabs.tabFor(h.job_id);
  if (existing) {
    tabs.select(existing.id);
    return existing.id;
  }
  if (!h.open_url) return null;
  const title = `Your turn — ${h.queue_name}`;
  const line = turnTabs.lineOf(h);
  const spare = turnTabs.spareFor(turnTabList(), line);
  let id;
  if (spare) {
    const tab = tabs.tabs.get(spare.id);
    const was = tab.jobId;
    log(`your turn: ${describeHandoff(h)} — its page opens in the tab of the turn before on this line `
        + `(${tab.where || `job ${was}`}), which is over and was not used`);
    pageNote(tab.id, 'reused', { from: was, job: h.job_id });
    // The last turn's card and confirmation went with its page.
    turnCards.delete(was);
    confirmationTabs.delete(was);
    Object.assign(tab, { endedAt: null, endLook: null, guideSlot: null, guideWhere: null,
      guideDone: false, guideRunning: false, guideAgain: false });
    id = tabs.reuse(tab.id, h.open_url, { jobId: h.job_id, title });
  } else {
    id = tabs.open(h.open_url, { kind: 'handoff', jobId: h.job_id, title });
  }
  Object.assign(tabs.tabs.get(id), { line, where: describeHandoff(h) });
  return id;
}

/**
 * How long a turn's tab nobody used stays open after the turn: as long as the
 * bar says how the turn ended. Tests shorten it; an installed app never does.
 */
function turnTabCloseMs() {
  const asked = app.isPackaged ? 0 : Number(process.env.REGBOT_TURN_TAB_MS || 0);
  return asked > 0 ? asked : turnTabs.CLOSE_AFTER_MS;
}

/** What turntabs.js weighs about one turn's tab. */
function turnTabFacts(tab) {
  const h = lastDoc && lastDoc.handoffs.find((x) => x.job_id === tab.jobId);
  const card = turnCards.get(tab.jobId);
  const shown = confirmationTabs.get(tab.jobId);
  return {
    live: !tab.endedAt || Boolean(h && !h.over),
    touched: Boolean(tab.touched),
    booking: Boolean((card && card.kind === 'booking') || (booker && booker.running.has(tab.jobId))),
    bookedByHand: bookedInTab.has(tab.jobId),
    booked: Boolean(card && card.kind === 'booked'),
    confirmationOpen: Boolean(shown && tabs.tabs.has(shown)),
    looked: Boolean(tab.endLook),
    shows: Boolean(tab.endLook && tab.endLook.ref),
  };
}

function turnTabList() {
  return [...tabs.tabs.values()].filter((t) => t.kind === 'handoff')
    .map((t) => ({ id: t.id, line: t.line, endedAt: t.endedAt, facts: turnTabFacts(t) }));
}

/** Each turn's tab learns when its turn is over: gone from the sync, or gone to somebody else first. */
function noteTurnsOver(doc) {
  if (!tabs) return;
  for (const tab of tabs.tabs.values()) {
    if (tab.kind !== 'handoff' || !tab.jobId) continue;
    const h = doc.handoffs.find((x) => x.job_id === tab.jobId);
    if (h && !h.over) {
      tab.endedAt = null;
    } else if (!tab.endedAt) {
      tab.endedAt = Date.now();
      pageNote(tab.id, 'over', { job: tab.jobId, how: h ? h.over.kind : 'gone' });
    }
  }
}

const readingEnded = new Set();   // tab ids being read by lookAtEnded right now

/**
 * A turn's page, read for a booking confirmation once the turn is over, and
 * again after every load since: a number there keeps the tab open.
 */
async function lookAtEnded(id) {
  const tab = tabs.tabs.get(id);
  if (!tab || readingEnded.has(id)) return;
  readingEnded.add(id);
  try {
    const parse = await parseConfirmation();
    const wc = tab.view.webContents;
    if (wc.isDestroyed()) return;
    const loads = tab.loads;
    let ref = null;
    if (parse) {
      const text = await Promise.race([
        wc.executeJavaScript('document.body ? document.body.innerText : ""'),
        new Promise((_, reject) => setTimeout(() => reject(new Error('the page did not answer')), 10000)),
      ]);
      ref = parse({ url: wc.getURL(), text: String(text || '').slice(0, 100000) }) || null;
    }
    if (tab.loads !== loads || !tab.endedAt) return; // loaded again, or taken by a turn, meanwhile
    tab.endLook = { at: Date.now(), ref };
    if (ref) {
      if (scrubber) scrubber.learn('confirmation', ref);
      pageNote(id, 'kept', { job: tab.jobId, why: 'confirmation', ref });
      log(`the page of ${tab.where || `job ${tab.jobId}`} shows a booking confirmation, so its tab stays open`);
    }
  } catch {
    // Not readable just now: read again in a moment.
  } finally {
    readingEnded.delete(id);
  }
}

/** Close the turns' tabs that have been spare long enough, and not the page on screen. */
function sweepTurnTabs() {
  if (!tabs || closing) return;
  const now = Date.now();
  const after = turnTabCloseMs();
  for (const t of turnTabList()) {
    const tab = tabs.tabs.get(t.id);
    const onScreen = t.id === tabs.active && win && win.isVisible() && win.isFocused();
    if (!turnTabs.closeNow({ ...t, onScreen }, now, after)) continue;
    const ago = now - t.endedAt;
    log(`closing the page of ${tab.where || `job ${tab.jobId}`}: its turn ended `
        + `${ago < 90000 ? `${Math.round(ago / 1000)} s` : `${Math.round(ago / 60000)} min`} ago, and it was not used`);
    pageNote(t.id, 'closing', { job: tab.jobId, why: 'spare' });
    tabs.close(t.id);
  }
  for (const [job, id] of [...confirmationTabs]) if (!tabs.tabs.has(id)) confirmationTabs.delete(job);
}

/**
 * What is laid over a turn's booking page, by job: while this computer's robot
 * books it ("booking": the page is covered, so nothing is booked by hand beside
 * it — painted again on every load of the page), and once it has ("booked": the
 * number, and where the confirmation is — painted once). Taken off when the
 * page is the person's to book on.
 */
const turnCards = new Map();

function elsewhereCard(h, device) {
  return { kind: 'booking', title: `${device} is booking this for you`, where: describeHandoff(h),
    text: `Another of your computers has this one, and its robot is at the DMV's form. Nothing to do here — `
      + 'please do not book it on this page as well. Should it stop answering, this computer takes it over.' };
}

function setCard(jobId, card) {
  if (card) turnCards.set(jobId, card);
  else if (!turnCards.delete(jobId)) return;
  paintCard(jobId);
}

function paintCard(jobId) {
  const tab = tabs && tabs.tabFor(jobId);
  if (!tab || tab.view.webContents.isDestroyed()) return;
  const card = turnCards.get(jobId) || null;
  pageNote(tab.id, 'card', { card: card ? card.kind : null, title: card ? card.title : undefined });
  tab.view.webContents.executeJavaScript(`(${drawCard.toString()})(${JSON.stringify(card)})`).catch(() => {});
}

/** Run in the booking page: lay the card over it, or take it off (null). Text only, never markup. */
function drawCard(card) {
  const ID = '__lineright_turn_card';
  const old = document.getElementById(ID);
  if (old) old.remove();
  if (!card) return;
  const booked = card.kind === 'booked';
  const veil = document.createElement('div');
  veil.id = ID;
  Object.assign(veil.style, {
    position: 'fixed', inset: '0', zIndex: '2147483647', display: 'flex', alignItems: 'center',
    justifyContent: 'center', background: 'rgba(15, 23, 42, 0.5)', font: '15px/1.5 system-ui, sans-serif',
  });
  const box = document.createElement('div');
  Object.assign(box.style, {
    background: '#fff', color: '#0b1020', borderRadius: '14px', padding: '24px 28px', maxWidth: '480px',
    margin: '16px', boxShadow: '0 20px 60px rgba(0, 0, 0, 0.3)', textAlign: 'left',
    borderTop: `6px solid ${booked ? '#047857' : '#6366f1'}`,
  });
  const line = (text, style) => {
    const el = document.createElement('div');
    el.textContent = text;
    Object.assign(el.style, style || {});
    box.appendChild(el);
  };
  line(card.title, { fontSize: '22px', fontWeight: '700', marginBottom: '6px', color: booked ? '#047857' : '#0b1020' });
  line(card.where, { fontWeight: '600', marginBottom: '8px' });
  if (card.reference) line(card.reference, { font: '700 22px/1.3 ui-monospace, monospace', margin: '4px 0 10px' });
  line(card.text, { color: '#475569' });
  if (booked) {
    const hide = document.createElement('button');
    hide.textContent = 'Show the page underneath';
    Object.assign(hide.style, {
      marginTop: '16px', padding: '8px 14px', borderRadius: '999px', border: '1px solid #cbd5e1',
      background: '#fff', color: '#0b1020', font: 'inherit', cursor: 'pointer',
    });
    hide.addEventListener('click', () => veil.remove());
    box.appendChild(hide);
  }
  veil.appendChild(box);
  document.documentElement.appendChild(veil);
}

/**
 * The confirmation, as the DMV showed it, in a tab of its own: its page, when
 * the address carries the number and so opens anywhere (the stand-in's does);
 * otherwise the picture the robot kept of it (booker.js `shotsDir`). Returns
 * the tab, or null when there is neither.
 */
function showConfirmation(h, outcome) {
  const ref = String(outcome.confirmation || '');
  const title = `Confirmation ${ref}`;
  if (ref && outcome.url && webPage(outcome.url) && outcome.url.includes(ref)) {
    return tabs.open(outcome.url, { kind: 'confirmation', title });
  }
  let page = null;
  try {
    page = outcome.shot ? confirmations.page({ ...outcome, where: describeHandoff(h) }) : null;
  } catch (err) {
    log(`could not show the confirmation picture: ${err.message}`);
  }
  return page ? tabs.open(pathToFileURL(page).href, { kind: 'confirmation', title }) : null;
}

// ------------------------------------------------------- booked in the tab
/**
 * A booking the person made by hand in a hand-off's tab, said for them: when
 * the tab shows the booking site's confirmation number — read the way the
 * robot reads it (dmq's parseConfirmation) — the app says "I booked it" with
 * that number. Somebody who booked and never pressed the button would
 * otherwise have their turn run out on them, and leave the line.
 */
let confirmationParser = null;
const bookedInTab = new Set();    // job ids said booked from their tab, or being said
const lookingAt = new Set();      // tab ids being read right now

function parseConfirmation() {
  if (!confirmationParser) {
    const dmq = robots && robots.paths ? robots.paths.dmq : null;
    const file = dmq ? path.join(dmq, 'src', 'selectors.js') : '';
    confirmationParser = file && fs.existsSync(file)
      ? import(pathToFileURL(file).href).then((m) => m.parseConfirmation, (err) => {
        log(`cannot read booking confirmations: ${err.message}`);
        return null;
      })
      : Promise.resolve(null);
  }
  return confirmationParser;
}

async function checkHandoffTab(id) {
  const tab = tabs.tabs.get(id);
  if (!tab || tab.kind !== 'handoff' || !tab.jobId || bookedInTab.has(tab.jobId) || lookingAt.has(id)) return;
  // The robot's to say, while it is booking this one or once it has.
  if (turnCards.has(tab.jobId)) return;
  const h = lastDoc && lastDoc.handoffs.find((x) => x.job_id === tab.jobId && x.phase === 'booking');
  if (!h) return;
  lookingAt.add(id);
  try {
    const parse = await parseConfirmation();
    const wc = tab.view.webContents;
    if (!parse || wc.isDestroyed()) return;
    const text = await wc.executeJavaScript('document.body ? document.body.innerText : ""').catch(() => '');
    const ref = parse({ url: wc.getURL(), text: String(text || '').slice(0, 100000) });
    if (!ref || bookedInTab.has(h.job_id)) return;
    bookedInTab.add(h.job_id);
    const where = describeHandoff(h);
    pageNote(id, 'confirmation', { ref, url: wc.getURL(), job: h.job_id });
    if (scrubber) scrubber.learn('confirmation', ref);
    try {
      await client.booked(h.job_id, ref);
      pageNote(id, 'reported', { job: h.job_id, ref });
      if (traces) traces.add('book.end', { job: h.job_id, outcome: 'booked', by: 'page', reported: true });
      log(`booked ${where} in its tab — confirmation ${ref}, said to the site`);
      notify(`Booked — ${h.queue_name}`, `${where}. Confirmation ${ref}.`, h);
      send('toast', { kind: 'ok', ms: 12000, text: `Booked ${where} — confirmation ${ref}. The app told LineRight Regbot for you.` });
    } catch (err) {
      // Not reached: looked for again in a moment. Refused: said once.
      pageNote(id, 'reported', { job: h.job_id, ref, error: err.message, status: err.status || 0 });
      if (traces) traces.add('book.end', { job: h.job_id, outcome: 'booked', by: 'page', reported: false, err: err.message, http: err.status || 0 });
      if (!definitive(err)) { bookedInTab.delete(h.job_id); return; }
      log(`booked ${where} in its tab — confirmation ${ref} — and the site would not take it: ${err.message}`);
      send('toast', { kind: 'warn', ms: 20000, text: `You booked ${where} — confirmation ${ref} — but LineRight Regbot would not record it: ${err.message}` });
    }
    if (loop) loop.poke();
  } finally {
    lookingAt.delete(id);
  }
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

// ------------------------------------------------------------------- traces
/**
 * What this app did, kept for the site to ask for (traces.js). The person is
 * taken out of it by what the app knows of them (scrub.js): the profile, kept
 * in step as it changes, and every confirmation number the app is given or the
 * site has recorded. It is made from the logs as they are written and the
 * robots' runs as they end (tracetaps.js), and from what this file says as it
 * happens: the app starting and stopping, every turn and what came of it, what
 * the person was told.
 *
 * Nothing goes unless the site asks (noteTraces): every sync says how far the
 * trace goes, and the site answers what to write down, what it has, and —
 * when it wants them — which events to send.
 */
function wireTraces() {
  scrubber = new Scrubber();
  scrubber.setProfile(profile.values());
  traces = new TraceStore({ dir: path.join(app.getPath('userData'), 'traces'), scrubber });
  taps = new TraceTaps({
    add: (kind, fields, opts) => traces.add(kind, fields, opts),
    learn: (label, value) => scrubber.learn(label, value),
    isBooking: (url) => isBookingPage(url, bookingOrigins),
  });
  logbook.tap = {
    event: (name, record) => taps.logbookEvent(name, record),
    line: (name, text) => taps.logbookLine(name, text),
  };
  startTrace();
  traceTimer = setInterval(traceStats, TRACE_STATS_EVERY_MS);
  traceTimer.unref();
  // A crash of the main process is said before it goes (a monitor: the crash itself goes on as it would).
  process.on('uncaughtExceptionMonitor', (err, origin) => {
    if (!traces) return;
    traces.add('app.error', { where: 'main', origin, name: err && err.name, msg: err && err.message,
      stack: err && err.stack });
    traces.flush();
  });
  app.on('child-process-gone', (_event, d = {}) => {
    if (traces && d.reason !== 'clean-exit') traces.add('app.crash', { what: d.type, name: d.name, why: d.reason, code: d.exitCode });
  });
  for (const state of ['suspend', 'resume', 'lock-screen', 'unlock-screen', 'on-ac', 'on-battery', 'shutdown']) {
    try { powerMonitor.on(state, () => { if (traces) traces.add('app.power', { state }); }); } catch { /* not on this system */ }
  }
}

/** A new run of the app, with what it runs on — and no more of the computer than that. */
function startTrace() {
  let tz = '';
  try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { /* unknown */ }
  traces.add('app.start', {
    session: traces.newSession(), version: app.getVersion(), electron: process.versions.electron,
    chrome: process.versions.chrome, os: process.platform, os_version: os.release(), arch: process.arch,
    packaged: app.isPackaged, locale: app.getLocale(), tz, tz_offset_min: -new Date().getTimezoneOffset(),
    mode: shareMode(), developer: developer.on, cpus: os.cpus().length,
    mem_gb: Math.round(os.totalmem() / 1e8) / 10, server: originOf(client.serverUrl) || undefined,
    paired: client.paired, profile: profileShape(), reader: store.get('readerEnabled', true) !== false,
    robot_booking: mayBook(store),
  });
}

/** Which details the profile holds: the names of the fields, never what is in them. */
function profileShape() {
  const values = profile ? profile.values() : {};
  return { filled: [...KEYS].filter((k) => values[k]), missing: [...KEYS].filter((k) => !values[k]) };
}

/** Every five minutes: how the app has been doing since the last time (telemetry.js's minutes). */
function traceStats() {
  if (!traces || !telemetry) return;
  const to = telemetry.nowS();
  const rows = telemetry.within(to - TRACE_STATS_EVERY_MS / 1000, to);
  if (!rows.length) return;
  const sum = (key) => rows.reduce((a, m) => a + (Number(m[key]) || 0), 0);
  const most = (key) => rows.reduce((a, m) => (m[key] === null || m[key] === undefined ? a : Math.max(a, m[key])), 0);
  traces.add('app.stats', {
    syncs: sum('syncs'), sync_errors: sum('sync_errors'),
    sync_ms: sum('syncs') ? Math.round(sum('sync_ms_sum') / sum('syncs')) : undefined, sync_ms_max: most('sync_ms_max'),
    rtt_ms: sum('rtt_n') ? Math.round(sum('rtt_ms_sum') / sum('rtt_n')) : undefined, pings: sum('rtt_n'),
    api_calls: sum('api_calls'), api_errors: sum('api_errors'), offline_min: rows.filter((m) => m.offline > 0).length,
    reads: sum('reads'), robot_runs: sum('robot_runs'), mem_mb: most('memory_mb'), cpu_pct: most('cpu_pct'),
    heap_mb: most('heap_mb'), tabs: tabs ? tabs.order.length : undefined,
  });
}

/** A turn as the trace keeps it: the line, the slot, how long was left — never who. */
function handoffFields(h) {
  const slot = h.slot || {};
  return {
    job: h.job_id, bid: h.bid_id, queue: h.queue_id, line: h.queue_slug, phase: h.phase,
    office: slot.office_code, office_name: slot.office_name, date: slot.date, time: slot.time, miles: slot.miles,
    secs_left: h.seconds_left, since: h.since, rank: h.rank_at, wave: h.wave ? `${h.wave.place}/${h.wave.of}` : undefined,
    robot: Boolean(h.robot), booker: h.booker ? (h.booker.you ? 'this' : 'other') : undefined,
    silent: h.booker && h.booker.silent ? true : undefined, over: h.over ? h.over.kind : undefined,
  };
}

/**
 * What a sync said that the trace keeps, or answers: the turns that came, went
 * or moved on; the confirmation numbers the site has recorded (taken out from
 * now on); and the site's word on the trace — how much to write down, what it
 * has (deleted here), and, when it wants them, an ask to answer.
 */
function noteTraces(doc, { arrived = [], gone = [], kept = [], before = null } = {}) {
  if (!traces) return;
  for (const b of doc.settled || []) if (b && b.confirmation) scrubber.learn('confirmation', b.confirmation);
  for (const h of arrived) traces.add('handoff.arrive', handoffFields(h));
  const was = new Map(((before && before.handoffs) || []).map((h) => [h.job_id, h]));
  for (const h of kept) {
    const old = was.get(h.job_id);
    const who = (x) => (x.booker ? (x.booker.you ? 'this' : 'other') : '');
    if (old && (old.phase !== h.phase || Boolean(old.over) !== Boolean(h.over) || who(old) !== who(h))) {
      traces.add('handoff.change', { ...handoffFields(h), from: old.phase });
    }
  }
  for (const h of gone) traces.add('handoff.gone', { job: h.job_id, phase: h.phase, secs_left: h.seconds_left });
  const said = doc.traces;
  if (!said || typeof said !== 'object') {
    // A site that takes no traces will never ask: nothing more is written down for it.
    traces.setLevel('off');
    return;
  }
  traces.setLevel(said.level);
  if (said.stream === traces.state.stream && Number.isFinite(said.acked)) traces.ack(said.acked);
  // An upload the site refused is not sent again for that ask — it lets the ask
  // lapse and makes another — and one that could not get through waits a little.
  const held = tracesRefused && tracesRefused.id === (said.ask && said.ask.id) && Date.now() < tracesRefused.until;
  if (said.ask && said.ask.id && !tracesUploading && !held) uploadTraces(said.ask);
}

/** The site's ask answered: the events after what it has, as many as it said, gzipped. */
async function uploadTraces(ask) {
  if (!traces || !client || !client.paired || tracesUploading) return;
  tracesUploading = ask.id;
  const mine = client;
  let made = null;
  try {
    made = traces.upload(ask, { version: app.getVersion(), platform: process.platform, arch: process.arch });
    const reply = await mine.uploadTraces(made);
    if (reply && reply.stream === traces.state.stream && Number.isFinite(reply.acked)) traces.ack(reply.acked);
    traces.noteUpload({ ok: true, events: made.events, bytes: made.gzip.length, message: reply && reply.more ? 'more to send' : '' });
  } catch (err) {
    traces.noteUpload({ ok: false, events: made ? made.events : 0, bytes: made ? made.gzip.length : 0, message: err.message });
    const refused = err.status >= 400 && err.status < 500;
    tracesRefused = { id: ask.id, until: Date.now() + (refused ? 24 * 3600 * 1000 : 30 * 1000) };
    log(`trace: the site did not take an upload — ${err.message}`);
  } finally {
    tracesUploading = null;
  }
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
    // Developer mode, and what holds it on: practice, --developer, or nothing
    // (View → Developer mode). Off, Settings offers the public site only.
    developer,
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
    // The logs: where they are, how long they are kept, and how much they took at the last look (logbook.js).
    logs: logbook ? { dir: logbook.dir, keepDays: logbook.keepDays, bytes: logbook.lastPrune ? logbook.lastPrune.bytes : null } : null,
    // This computer's robots, for the regbot site: whether it looks for
    // openings when asked, whether it may look at the real DMV, and whether it
    // may book a slot that is the person's (booker.js) — anywhere.
    readerEnabled: store.get('readerEnabled', true) !== false,
    robotBooking: mayBook(store),
    // A sound with each reminder before an appointment (bookings.js).
    reminderSound: store.get('reminderSound', true) !== false,
    // AI booking oversight (overseer.js): whether the person has it on, and the site's terms.
    oversight: overseer ? overseer.state() : null,
    realDmvChecks: reader ? reader.mayLookAtRealDmv() : false,
    // Checking lines for everybody, which earns credits on the site.
    checking: reader ? reader.enabled() : false,
    publicSite: !builtin() && !isLoopback(client.serverUrl),
    // The weekly re-import from the browsers imported from (reimport.js).
    importAgain: againView(),
    robots: reader ? { ...reader.state(), ...booker.state(), available: robots.available() } : null,
    telemetry: telemetry ? { autoShare: Boolean(store.get('telemetryAutoShare', false)),
      lastShare: telemetry.lastShare(), accepted: shareAccepted } : null,
    traces: traces ? traces.view() : null,
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
  // The window draws these and then they are gone. The app log keeps the sequence.
  handle('ui:note', ({ kind, text }) => {
    if (kind !== 'notice' && kind !== 'banner' && kind !== 'sound') return;
    const line = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 800);
    if (line) log(`ui ${kind}: ${line}`);
  });

  // -- the application half
  // Test sites, made up for demos and tests, only in developer mode — and
  // marked, so a screen never shows one without saying so (developer.js).
  handle('server:sites', async ({ q }) => {
    await serverReady();
    const doc = await client.sites(q || '');
    const sites = developerMode.sitesFor(doc.sites, developer.on);
    if (!q) {
      sitesCache = sites;
      for (const s of sitesCache) if (s.portal_url) rememberBookingOrigin(s.portal_url);
      rebuildMenu();
    }
    return { ...doc, sites };
  });
  handle('server:site', async ({ slug }) => {
    await serverReady();
    const doc = await client.site(slug);
    if (doc.site) {
      doc.site.mock = developerMode.isMock(doc.site);
      if (doc.site.mock && !developer.on) throw new Error(developerMode.TEST_ONLY);
      if (doc.site.portal_url) rememberBookingOrigin(doc.site.portal_url);
    }
    return withNeeds(doc);
  });
  handle('server:board', async ({ id }) => {
    await serverReady();
    const doc = await client.board(id);
    if (doc.queue) {
      doc.queue.mock = developerMode.isMock(doc.queue);
      if (doc.queue.mock && !developer.on) throw new Error(developerMode.TEST_ONLY);
    }
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
    if (r && r.bid_id && bid.if_passed) rememberReach(r.bid_id, bid.if_passed);
    loop.poke();
    return r;
  });
  handle('server:raise', async ({ bid_id, delta }) => { const r = await client.raiseBid(bid_id, delta); loop.poke(); return r; });
  handle('server:if-passed', async ({ bid_id, if_passed }) => {
    // Remembered even when the server has no such route yet, so a later
    // opening past this reach is passed instead of offered.
    rememberReach(bid_id, if_passed);
    const r = await client.setIfPassed(bid_id, if_passed);
    loop.poke();
    return r;
  });
  handle('server:advice', async ({ bid_id, key }) => {
    const r = await client.applyAdvice(bid_id, key);
    if (r && r.if_passed) rememberReach(bid_id, r.if_passed);
    loop.poke();
    return r;
  });
  handle('server:quote', ({ bid_id, change }) => client.quoteBid(bid_id, change));
  handle('server:options', ({ queue_id, draft }) => client.bidOptions(queue_id, draft));
  handle('server:widen-options', ({ bid_id }) => client.widenOptions(bid_id));
  handle('server:prefs', async (prefs) => {
    const r = await client.setPreferences(prefs);
    loop.poke();
    return r;
  });
  handle('server:change', async ({ bid_id, change }) => {
    const r = await client.changeBid(bid_id, change);
    // The reach the app passes openings by is the one just saved.
    if (change && change.if_passed) rememberReach(bid_id, change.if_passed);
    loop.poke();
    return r;
  });
  handle('server:withdraw', async ({ bid_id }) => { const r = await client.withdrawBid(bid_id); loop.poke(); return r; });
  handle('server:account', async () => { await serverReady(); return client.account(); });
  handle('server:revoke', ({ client_id }) => client.revokeDevice(client_id));
  handle('server:nickname', async ({ nickname }) => {
    const r = await client.setNickname(nickname);
    // The menu and the bar show the new name now, not on the next sync.
    if (r.user && pairState.user) setPair({ user: { ...pairState.user, nickname: r.user.nickname } });
    loop.poke();
    return r;
  });
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
  // -- the trace the site may ask for (traces.js): what it holds, what went, and the person's switch
  handle('traces:get', ({ n }) => ({ ...traces.view(), recent: traces.recent(Math.min(Number(n) || 60, 300)),
    server: client.serverUrl, paired: client.paired }));
  handle('traces:on', ({ on }) => {
    traces.setOn(Boolean(on));
    log(on ? 'trace on: kept for the site to ask for' : 'trace off: nothing more is written down, and what was kept is deleted');
    if (on) startTrace();
    return traces.view();
  });
  handle('traces:clear', () => { traces.clear(); return traces.view(); });
  // Which screen the person is on: a word, from the app's own page.
  handle('trace:ui', ({ page }) => {
    if (traces && typeof page === 'string' && /^[a-z][a-z0-9:_-]{0,39}$/i.test(page)) traces.add('ui.view', { page });
  });

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
    // From now on the trace takes out what the profile holds now.
    if (scrubber) scrubber.setProfile(profile.values());
    if (traces) traces.add('app.profile', profileShape());
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
    if (scrubber) scrubber.setProfile(profile.values());
    if (traces) traces.add('app.profile', profileShape());
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
  // -- My Bookings: the person's appointments (bookings.js)
  handle('bookings:get', () => bookingsView());
  // All of them, past and cancelled too, from the site.
  handle('bookings:all', async () => {
    if (!client.paired) return { list: [] };
    const reply = await client.bookings();
    return { list: Array.isArray(reply.bookings) ? reply.bookings : [] };
  });
  handle('bookings:cancel', ({ id }) => cancelBooking(Number(id)));
  // Cancelled somewhere the app did not see: no more reminders for it.
  handle('bookings:mark', async ({ id }) => {
    const b = reminders.find(Number(id));
    if (!b) throw new Error('That appointment is not among your bookings any more.');
    cancelling.delete(b.id);
    log(`booking ${b.id} (${whereBooked(b)}) marked cancelled by hand`);
    await bookingGone(b, 'elsewhere');
    return { message: `Marked as cancelled: ${whereBooked(b)}. No more reminders for it.` };
  });
  // The booking site's own page for it, or the picture of its confirmation.
  handle('bookings:open', ({ id, what }) => {
    const b = reminders.find(Number(id));
    if (!b) throw new Error('That appointment is not among your bookings any more.');
    if (what === 'confirmation') {
      const shot = confirmationShot(b);
      if (!shot) throw new Error('No picture of its confirmation page was kept on this computer.');
      const page = confirmations.page({ shot, confirmation: b.confirmation, where: `${b.queue_name} — ${whereBooked(b)}` });
      if (!page) throw new Error('The picture of its confirmation page could not be shown.');
      return { id: tabs.open(pathToFileURL(page).href, { kind: 'confirmation', title: `Confirmation ${b.confirmation}` }) };
    }
    if (!b.manage_url) throw new Error('This booking site has no page for it.');
    return { id: tabs.open(b.manage_url, { kind: 'page', title: `${b.office_name} ${b.date}` }) };
  });
  // How a reminder sounds and looks.
  handle('bookings:try', () => {
    const b = reminders.coming()[0];
    remindNote({ title: 'This is how a reminder looks', kind: 'test', booking: b || null,
      body: b ? `Before ${b.queue_name} — ${whereBooked(b)}: a day before, six hours before (8 am–7 pm) and an hour before.`
        : 'One comes a day before each appointment, six hours before (8 am–7 pm) and an hour before.' });
    reminderChime('test');
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
    if (h.open_url) {
      turnTab(h);
      armGuide(h);
    }
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
  handle('settings:set', async ({ serverMode: mode, serverUrl, updateUrl, clientName, readerEnabled, robotBooking,
    checking, realDmvChecks, reimportRemind, logKeepDays, reminderSound, aiOversight }) => {
    // Another server, practice and an update feed of the app's own are for the
    // people who work on regbot: developer mode's, wherever the asking came from.
    const elsewhere = mode === 'builtin' || mode === 'remote'
      || (mode === undefined && typeof serverUrl === 'string' && !builtin());
    if ((elsewhere || typeof updateUrl === 'string') && !developer.on) {
      throw new Error('That is part of developer mode: turn it on first (View → Developer mode).');
    }
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
    if (logKeepDays !== undefined && logbook) {
      store.set('logKeepDays', logbook.setKeepDays(logKeepDays));
      logbook.prune();
    }
    if (typeof reminderSound === 'boolean') {
      store.set('reminderSound', reminderSound);
      sendBookings();
    }
    if (typeof aiOversight === 'boolean') {
      // Kept with when it was said: it lets the app spend the person's bought credits.
      store.set('aiOversight', aiOversight);
      store.set('aiOversightAt', new Date().toISOString());
      if (overseer) overseer.changed();
    }
    if (typeof robotBooking === 'boolean') {
      // A yes is kept with when it was said: it is the person agreeing to
      // automated traffic from their own address, and to real appointments.
      store.set('robotBooking', robotBooking);
      store.set('robotBookingAt', robotBooking ? new Date().toISOString() : null);
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
    if (traces) {
      // What was switched, by name: never an address or a name.
      const said = { mode, readerEnabled, robotBooking, checking, realDmvChecks, reimportRemind,
        logKeepDays: logKeepDays === undefined ? undefined : Number(logKeepDays) };
      const changed = Object.fromEntries(Object.entries(said).filter(([, v]) => typeof v === 'boolean'
        || (typeof v === 'number' && Number.isFinite(v)) || (typeof v === 'string' && /^[a-z]{1,12}$/.test(v))));
      if (Object.keys(changed).length) traces.add('app.setting', changed);
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
  handle('logs:open', () => openLogs());
  handle('update:install', () => updates.install());
  handle('sync:now', () => loop.poke());
  handle('app:info', () => settingsView());
  handle('app:about', () => showAbout());
  // Developer mode: a site described in plain words, and the AI alone on it (agent/sitetask.js).
  handle('agent:task', async ({ site = {}, kind = 'check', want = '' }) => {
    if (!developer.on) throw new Error('That is part of developer mode: turn it on first (View → Developer mode).');
    if (!client.paired) throw new Error('Sign in first: the AI is asked through your LineRight Regbot account.');
    const scrub = new Scrubber();
    scrub.setProfile(profile.values());
    const allowed = kind === 'book' ? ['first_name', 'last_name', 'email', 'phone'] : [];
    log(`AI task (${kind}) on ${String(site.start_url || '')}: ${String(want).slice(0, 200)}`);
    const run = await runSiteTask({
      runner: robots, client, site, kind: kind === 'book' ? 'book' : 'check', want: String(want || ''),
      values: profile.values(), allowed, scrub: (t) => scrub.plain(String(t == null ? '' : t)),
      log: (line) => log(`AI task: ${line}`), appVersion: app.getVersion(),
    });
    if (traces) traces.add('agent.task', { kind, session: run.session, outcome: run.outcome ? run.outcome.outcome : 'stopped', calls: run.calls, credits: run.credits });
    return { outcome: run.outcome, steps: run.steps.map((x) => ({ tool: x.tool, result: x.result })), calls: run.calls,
      credits: run.credits, stopped: run.stopped, session: run.session };
  });
  handle('robots:status', () => (reader ? { ...reader.state(), ...booker.state(),
    oversight: overseer ? overseer.state() : null } : null));
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
    // A feed chosen in Settings is a developer's, and followed only in developer
    // mode: what an installed copy runs next is the published release's to say.
    feedUrl: developer.on ? store.get('updateUrl', '') : (store.defaults.updateUrl || ''),
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
    // Everything this app keeps goes, the account with it: a booking too.
    if (robots) robots.stopAll();
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
    if (traces) {
      traces.reset();
      scrubber.setProfile(profile.values());
      startTrace();
    }
    lastDoc = null;
    sitesCache = [];
    opened.clear();
    if (booker) booker.forget();
    bookedInTab.clear();
    turnCards.clear();
    confirmationTabs.clear();
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
  if (pruneTimer) clearInterval(pruneTimer);
  log('closing');
  try { if (loop) loop.stop(); } catch { /* not started */ }
  try { if (pinger) pinger.stop(); } catch { /* not started */ }
  try {
    if (telemetryTimer) clearInterval(telemetryTimer);
    if (telemetry) { telemetry.event('stop'); telemetry.save(); }
  } catch { /* the numbers are never the problem */ }
  try {
    if (traceTimer) clearInterval(traceTimer);
    if (traces) {
      traces.add('app.stop', { uptime_s: Math.round(process.uptime()) });
      traces.flush();
    }
  } catch { /* a trace is never the problem */ }
  // The read this app is at goes back to the site now, so no line waits on an
  // app that is gone; then the robots that look stop.
  let released = Promise.resolve(false);
  try { if (reader) released = reader.release(1500); } catch (err) { trace(`giving the read back: ${err.message}`); }
  try { if (reader) reader.stop(); } catch (err) { trace(`stopping the robots: ${err.message}`); }
  // A robot booking the person's slot finishes first, and the site hears how
  // it went: stopped part way, it may have booked the slot with nobody left to
  // say so, and the turn would run out as missed. Its own time bounds the wait.
  let finished = Promise.resolve(true);
  try {
    if (booker && booker.running.size) {
      log(`closing once the robot has finished booking ${[...booker.running.values()].map((b) => b.where).join(' and ')}`);
      finished = booker.finish();
    }
  } catch (err) { trace(`finishing the booking: ${err.message}`); }
  try { if (updates.stop) updates.stop(); } catch { /* not wired */ }
  // Gone from the screen at once; the views themselves go last, in the same
  // turn as the exit (see send()).
  try { if (win && !win.isDestroyed()) win.hide(); } catch (err) { trace(`hide: ${err.message}`); }
  const exit = () => {
    exiting = true;
    // What was written down while the app closed, kept for the next start.
    try { if (traces) traces.flush(); } catch { /* a trace is never the problem */ }
    try { if (tabs) tabs.destroy(); } catch (err) { trace(`destroy tabs: ${err.message}`); }
    try { if (chrome) { win.contentView.removeChildView(chrome); chromeContents.close(); } } catch (err) { trace(`close chrome: ${err.message}`); }
    trace('exit');
    setImmediate(() => app.exit(code));
  };
  if (!stack) { Promise.all([released.catch(() => {}), finished]).then(exit); return; }
  // The server, the processor and a robot mid-run go with the app — bounded,
  // so a process that will not die cannot keep the app alive either. (Were
  // the app itself killed, each one's lifeline would close and it would go.)
  Promise.all([Promise.race([stack.stop(), new Promise((resolve) => setTimeout(resolve, 6000))]),
    released.catch(() => {}), finished])
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
      tabs: shellState.tabs.map((t) => ({ id: t.id, kind: t.kind, url: t.url, title: t.title, jobId: t.jobId, touched: t.touched })),
      chromeHeight: tabs.chromeHeight, packaged: app.isPackaged, updates: updateState,
      menu: menu.outline(Menu.getApplicationMenu().items.map((i) => ({ label: i.label, submenu: (i.submenu ? i.submenu.items : []).map((s) => ({ label: s.label, type: s.type, role: s.role })) }))),
      sites: sitesCache.length,
      profile: { filled: profile.view().filled, encrypted: profile.encrypted, backend: profile.backend },
      browsers: browsers.scan().map((b) => ({ name: b.name, known: b.known, profiles: b.profiles.length })),
      offerImport: importWorthOffering(),
      robots: reader ? { ...reader.state(), ...booker.state(), oversight: overseer ? overseer.state() : null } : null,
      ping: pinger ? { last: pinger.last, everyMs: pinger.everyMs } : null,
      telemetry: telemetry ? { summary: telemetry.summary(), events: telemetry.events.length, shares: telemetry.shares } : null,
      traces: traces ? { ...traces.view(), status: traces.status(), kinds: traces.recent(300).map((e) => e.k),
        // What the AI oversight wrote, however much the robots' network came after it.
        agent: traces.recent(5000).filter((e) => /^agent\./.test(e.k)).map((e) => e.k) } : null,
      connection,
      autofill: lastFill,
      screen: lastNavigate,
      cards: [...turnCards].map(([jobId, c]) => ({ jobId, kind: c.kind })),
      bookingOrigins: [...bookingOrigins],
      serverMode,
      developer,
      siteList: sitesCache.map((s) => ({ slug: s.slug, mock: s.mock })),
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
  // The logs, in the user data folder, kept as long as Settings says: three days unless told.
  if (!logbook) logbook = new Logbook({ dir: path.join(app.getPath('userData'), 'logs'), keepDays: store.get('logKeepDays', 3) });
  else logbook.setKeepDays(store.get('logKeepDays', 3));
  profile = new Profile(path.join(app.getPath('userData'), 'profile.json'), safeStorage);
  const choice = serverChoice.resolve({ argv, env: process.env, store });
  serverMode = choice.mode;
  forcedRun = choice.forced;
  client = new SyncClient({
    serverUrl: choice.url,
    token: choice.token,
    app: { name: store.get('clientName'), version: app.getVersion(), platform: process.platform },
    onRequest: (r) => { if (telemetry) telemetry.request(r); },
    onExchange: (r) => logSiteExchange(r),
  });
  if (builtin()) client.token = makeStack().token;
  pairState = { paired: client.paired, user: null, pending: null, message: '' };
  developer = developerMode.resolve({ argv, env: process.env, store, practice: builtin() });
}

async function main() {
  wireTelemetry();
  loadState();
  wireTraces();
  // What is older than the logs are kept for goes: now, and every hour after.
  logbook.prune();
  pruneTimer = setInterval(() => logbook.prune(), 60 * 60 * 1000);
  pruneTimer.unref();
  log(`LineRight Regbot ${app.getVersion()} starting (${process.platform}, Electron ${process.versions.electron});`
    + ` logs in ${logbook.dir}, kept ${logbook.keepDays} day${logbook.keepDays === 1 ? '' : 's'}`);
  robots = new RobotRunner({
    paths: locate({ packaged: app.isPackaged, resourcesPath: process.resourcesPath, appPath: app.getAppPath() }),
    node: process.execPath,
    stateDir: path.join(app.getPath('userData'), 'robots'),
    log: (message) => log(`robots: ${message}`),
    onRun: (r) => telemetry.robot(r),
    // Each run, read back into the trace from its own record once it ends (tracetaps.js).
    onFinish: (r) => { if (taps) taps.robotRun(r); },
    logbook,
  });
  const robotsState = () => ({ ...reader.state(), ...booker.state(), oversight: overseer ? overseer.state() : null });
  reader = new Reader({
    runner: robots, getClient: () => client, getStore: () => store,
    log: (message) => log(`reader: ${message}`),
    onState: () => send('robots:state', robotsState()),
    onRead: (r) => {
      telemetry.read(r);
      if (traces) {
        traces.add('read.end', { read: r.read, queue: r.queue, status: r.status, robot: r.robot, found: r.found,
          ms: r.ms, offices: r.offices, verdicts: r.verdicts, http: r.http || undefined, err: r.error });
      }
    },
  });
  const shotsDir = path.join(app.getPath('userData'), 'robots', 'confirmations');
  confirmations.prune(shotsDir);
  overseer = new Overseer({
    getClient: () => client, getStore: () => store, getProfile: () => profile.values(),
    // What the site says this account may have, on every sync (its agent.py).
    getStatus: () => (lastDoc && lastDoc.agent) || null,
    appVersion: app.getVersion(),
    log: (message) => log(`oversight: ${message}`),
    onState: (o) => { send('robots:state', robotsState()); noteOversight(o); },
    onEvent: (e) => {
      const { kind, ...fields } = e;
      if (traces) traces.add(kind, fields);
    },
  });
  booker = new Booker({
    runner: robots, reader, getClient: () => client, getStore: () => store,
    getProfile: () => profile.values(), shotsDir, overseer,
    log: (message) => log(`booker: ${message}`),
    onState: () => send('robots:state', robotsState()),
    onOutcome: (r) => {
      telemetry.booking(r);
      const o = r.outcome || {};
      if (o.confirmation && scrubber) scrubber.learn('confirmation', o.confirmation);
      if (traces) {
        traces.add('book.end', { job: r.job, outcome: r.kind, by: o.overseen ? 'robot+ai' : 'robot', ms: r.ms, why: o.why,
          unconfirmed: o.unconfirmed, unreported: o.unreported, quiet: o.quiet, device: o.device,
          recorded: o.recorded, shot: o.shot ? true : undefined });
      }
    },
  });

  reminders = new Reminders({
    store, notify: remindNote, chime: reminderChime,
    onChange: () => sendBookings(),
    log: (message) => log(`bookings: ${message}`),
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
  // An error in the app's own page is the app's, and goes in the trace.
  chromeContents.on('console-message', (e, level, message, line, sourceId) => {
    const d = e && typeof e.message === 'string' ? e : { level, message, lineNumber: line, sourceId };
    if (traces && (d.level === 'error' || d.level === 3)) {
      traces.add('ui.error', { text: d.message, src: d.sourceId ? path.basename(String(d.sourceId)) : undefined, line: d.lineNumber });
    }
  });
  chromeContents.on('render-process-gone', (_event, d = {}) => {
    if (traces) traces.add('app.crash', { what: 'ui', why: d.reason, code: d.exitCode });
  });
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
  // Every page in a tab is written down as it goes (pagelog.js), from before its first request.
  tabs.on('created', (tab) => {
    try {
      pageLogs.set(tab.id, watchTab(tab, { logbook }));
      tab.view.webContents.once('destroyed', () => pageLogs.delete(tab.id));
    } catch (err) {
      log(`could not keep a log of tab ${tab.id}: ${err.message}`);
    }
  });
  // Used by the person: a turn's tab is then theirs, and stays (turntabs.js).
  tabs.on('touched', (tab) => pageNote(tab.id, 'used', { job: tab.jobId || undefined }));
  wireAutofill();

  // Handlers before the page: it asks for its state the moment it loads.
  wireIpc();
  await chromeContents.loadFile(path.join(__dirname, '..', 'ui', 'index.html'));
  wireSync();
  // The page is there to sound a reminder: one due while the app was closed comes now.
  reminders.start();
  sendBookings();
  wireUpdates();
  rebuildMenu();
  send('pair:state', pairState);
  send('update:state', updateState);
  send('shell:state', tabs.state());
  // Once, for whoever had this app before it kept a trace, and on a first start: what it is, and where it is turned off.
  if (traces && traces.state.on && !store.get('tracesNoticed', false)) {
    store.set('tracesNoticed', true);
    send('toast', { kind: 'ok', ms: 25000, text: 'This app keeps a record of what it does — with your personal details taken out — '
      + 'and sends it to LineRight Regbot when the site asks, so the people running it can see why a booking did or did not work. '
      + 'Help → Advanced shows it, and turns it off.' });
  }
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
  log(`LineRight Regbot ${app.getVersion()} — server ${builtin() ? `on this computer (${stack.paths.packaged ? 'bundled' : `python ${stack.paths.python}`})` : client.serverUrl} — ${client.paired ? 'signed in' : 'not signed in'} — profile ${profile.view().filled ? (profile.encrypted ? 'encrypted' : 'plain') : 'empty'} (keychain: ${profile.backend})${developer.on ? ' — developer mode' : ''}`);
  // The Linux launcher adds this where the system allows Chromium no sandbox
  // (scripts/linux-launcher.js); say so, since tabs show the open web.
  if (app.commandLine.hasSwitch('no-sandbox')) log("pages run without Chromium's sandbox (--no-sandbox)");
  if (argv.smoke) smoke();
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (closing) {
      // Opened again while it closes, waiting for its robot to finish a booking:
      // there is no window to show, only a moment to wait.
      if (process.env.REGBOT_NO_NOTIFY !== '1' && Notification.isSupported()) {
        try {
          new Notification({ title: 'LineRight Regbot is closing',
            body: 'It is finishing a booking first. Open it again once it has gone.' }).show();
        } catch (err) { trace(`notification: ${err.message}`); }
      }
      return;
    }
    if (win) { win.show(); win.focus(); }
  });
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
