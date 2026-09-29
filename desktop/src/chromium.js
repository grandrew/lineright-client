'use strict';
/**
 * Where the Chromium browsers keep their data, on each of the three systems,
 * and which profiles each of them has.
 *
 * Every browser built on Chromium — Chrome, Edge, Brave, Vivaldi, Opera, Arc,
 * Comet and the rest — lays its user-data directory out the same way: a
 * `Local State` file at the top, then one directory per person
 * (`Default`, `Profile 1`, …) holding `Cookies`, `Web Data` and `History` as
 * SQLite files. So the catalogue below is only about *where* each one puts
 * that directory; everything after this module treats them alike.
 *
 * The catalogue is not the whole story, because a browser released next month
 * will not be in it. After the known ones have been looked for, the same
 * roots are swept for any other directory that is laid out this way, which is
 * how a browser nobody here has heard of still turns up in the list. The test
 * is deliberately strict — a `Local State` alone is not enough, since every
 * Electron application on the machine has one of those, this app included —
 * so a directory has to have a profile with a browser's databases in it.
 *
 * Nothing here reads a database or decrypts anything; it hands back paths.
 * The filesystem is injected so that all three platforms can be tested from
 * whichever one the tests happen to be running on.
 */
const fs = require('node:fs');
const nodePath = require('node:path');

/**
 * The browsers worth naming, and where they live.
 *
 * `product` is the name the browser gives its own key in the system keychain
 * ("Chrome Safe Storage") and in a Linux keyring; oscrypt.js needs it. The
 * paths are relative to one of the roots below. Where a path is a guess for a
 * browser whose installer this project has not seen — Arc and Comet on
 * Windows, mainly — a wrong guess costs nothing: the directory is not there,
 * the browser is not listed, and the sweep may still find it.
 */
const CATALOGUE = [
  { id: 'chrome', name: 'Google Chrome', product: 'Chrome',
    win32: [['local', 'Google/Chrome/User Data']], darwin: [['support', 'Google/Chrome']],
    linux: [['config', 'google-chrome'], ['flatpak', 'com.google.Chrome/config/google-chrome']] },
  { id: 'chrome-beta', name: 'Google Chrome Beta', product: 'Chrome',
    win32: [['local', 'Google/Chrome Beta/User Data']], darwin: [['support', 'Google/Chrome Beta']],
    linux: [['config', 'google-chrome-beta']] },
  { id: 'chrome-dev', name: 'Google Chrome Dev', product: 'Chrome',
    win32: [['local', 'Google/Chrome Dev/User Data']], darwin: [['support', 'Google/Chrome Dev']],
    linux: [['config', 'google-chrome-unstable']] },
  { id: 'chrome-canary', name: 'Google Chrome Canary', product: 'Chrome',
    win32: [['local', 'Google/Chrome SxS/User Data']], darwin: [['support', 'Google/Chrome Canary']], linux: [] },
  { id: 'chromium', name: 'Chromium', product: 'Chromium',
    win32: [['local', 'Chromium/User Data']], darwin: [['support', 'Chromium']],
    linux: [['config', 'chromium'], ['snap', 'chromium/common/chromium'], ['flatpak', 'org.chromium.Chromium/config/chromium']] },
  { id: 'edge', name: 'Microsoft Edge', product: 'Microsoft Edge',
    win32: [['local', 'Microsoft/Edge/User Data']], darwin: [['support', 'Microsoft Edge']],
    linux: [['config', 'microsoft-edge'], ['config', 'microsoft-edge-beta'], ['flatpak', 'com.microsoft.Edge/config/microsoft-edge']] },
  { id: 'brave', name: 'Brave', product: 'Brave',
    win32: [['local', 'BraveSoftware/Brave-Browser/User Data']], darwin: [['support', 'BraveSoftware/Brave-Browser']],
    linux: [['config', 'BraveSoftware/Brave-Browser'], ['flatpak', 'com.brave.Browser/config/BraveSoftware/Brave-Browser']] },
  { id: 'vivaldi', name: 'Vivaldi', product: 'Vivaldi',
    win32: [['local', 'Vivaldi/User Data']], darwin: [['support', 'Vivaldi']],
    linux: [['config', 'vivaldi'], ['flatpak', 'com.vivaldi.Vivaldi/config/vivaldi']] },
  { id: 'opera', name: 'Opera', product: 'Opera',
    win32: [['roaming', 'Opera Software/Opera Stable']], darwin: [['support', 'com.operasoftware.Opera']],
    linux: [['config', 'opera'], ['flatpak', 'com.opera.Opera/config/opera']] },
  { id: 'opera-gx', name: 'Opera GX', product: 'Opera',
    win32: [['roaming', 'Opera Software/Opera GX Stable']], darwin: [['support', 'com.operasoftware.OperaGX']], linux: [] },
  { id: 'arc', name: 'Arc', product: 'Arc',
    win32: [['local', 'Packages/TheBrowserCompany.Arc_ttt1ap7aakyb4/LocalCache/Local/Arc/User Data'], ['local', 'Arc/User Data']],
    darwin: [['support', 'Arc/User Data']], linux: [] },
  { id: 'comet', name: 'Comet', product: 'Comet',
    win32: [['local', 'Perplexity/Comet/User Data'], ['local', 'Comet/User Data']],
    darwin: [['support', 'Perplexity/Comet'], ['support', 'Comet']],
    linux: [['config', 'comet'], ['config', 'perplexity-comet']] },
  { id: 'dia', name: 'Dia', product: 'Dia',
    win32: [['local', 'Dia/User Data']], darwin: [['support', 'Dia/User Data'], ['support', 'Dia']], linux: [] },
  { id: 'yandex', name: 'Yandex Browser', product: 'Yandex',
    win32: [['local', 'Yandex/YandexBrowser/User Data']], darwin: [['support', 'Yandex/YandexBrowser']],
    linux: [['config', 'yandex-browser']] },
  { id: 'whale', name: 'Naver Whale', product: 'Whale',
    win32: [['local', 'Naver/Naver Whale/User Data']], darwin: [['support', 'Naver/Whale']],
    linux: [['config', 'naver-whale']] },
];

/**
 * The databases a profile directory has to hold before it counts as one, and
 * where inside it they are.
 *
 * Chromium moved the cookie store down into a `Network` directory, and which
 * of the two places it is in depends on how old the profile is rather than on
 * the platform: a Windows Chrome has `Default\Network\Cookies` where the one
 * on this Linux machine still has `Default/Cookies`. Both are looked for, the
 * newer place first.
 */
const DATABASES = {
  cookies: ['Network/Cookies', 'Cookies'],
  details: ['Web Data'],
  history: ['History'],
};

/** How deep the sweep for unlisted browsers goes under each root. */
const SWEEP_DEPTH = { win32: 3, darwin: 2, linux: 3 };

/**
 * Directories that are laid out like a browser profile without being one.
 *
 * The WebView2 runtime gives every application that embeds it a Chromium
 * profile of its own — Outlook, OneDrive, an updater — and each has a
 * `Web Data` and a `History` like any other. Nobody's saved address is in
 * Outlook's embedded browser, and four of them in a list of browsers is noise
 * in front of the one the person actually uses.
 */
const EMBEDDED = /^ebwebview$|^webview2$|\.webview2$/i;

/**
 * Old Windows names that are junctions to somewhere already being looked at.
 * Following them finds the same browsers a second time, under a path nobody
 * would recognise.
 */
const JUNCTIONS = /^(application data|local settings|temporary internet files)$/i;

function io(custom) {
  return {
    exists: (p) => { try { fs.accessSync(p); return true; } catch { return false; } },
    isDir: (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } },
    isFile: (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } },
    list: (p) => { try { return fs.readdirSync(p); } catch { return []; } },
    read: (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } },
    real: (p) => { try { return fs.realpathSync.native ? fs.realpathSync.native(p) : fs.realpathSync(p); } catch { return p; } },
    ...custom,
  };
}

/**
 * The directories a browser's user data can sit under, per platform.
 *
 * Windows keeps most of them in Local and Opera's in Roaming; macOS puts them
 * all in Application Support; Linux uses ~/.config, with a sandboxed copy per
 * app for Flatpak and Snap.
 */
function roots({ platform = process.platform, home, env = process.env } = {}) {
  const at = platform === 'win32' ? nodePath.win32 : nodePath.posix;
  const dir = home || env.HOME || env.USERPROFILE || '';
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA || at.join(dir, 'AppData', 'Local');
    const roaming = env.APPDATA || at.join(dir, 'AppData', 'Roaming');
    return { at, local, roaming, config: local, support: local, snap: null, flatpak: null };
  }
  if (platform === 'darwin') {
    const support = at.join(dir, 'Library', 'Application Support');
    return { at, support, config: support, local: support, roaming: support, snap: null, flatpak: null };
  }
  const config = env.XDG_CONFIG_HOME || at.join(dir, '.config');
  return { at, config, support: config, local: config, roaming: config,
    snap: at.join(dir, 'snap'), flatpak: at.join(dir, '.var', 'app') };
}

/** `Local State`, parsed. Missing or unreadable is not an error: `{}`. */
function localState(userDataDir, disk = io(), at = nodePath) {
  const raw = disk.read(at.join(userDataDir, 'Local State'));
  if (!raw) return {};
  try {
    return JSON.parse(raw) || {};
  } catch {
    return {};
  }
}

/**
 * The profiles inside a user-data directory.
 *
 * `Local State` names them ("Ada", "Work") in `profile.info_cache`; where it
 * does not, the directory names stand in. Opera keeps one profile in the
 * user-data directory itself, so that shape is allowed too. A directory with
 * none of the three databases is not a profile — an empty `Default` left
 * behind by an uninstall should not be offered as something to import from.
 */
function profiles(userDataDir, disk = io(), at = nodePath) {
  const state = localState(userDataDir, disk, at);
  const cache = (state.profile && state.profile.info_cache) || {};
  const names = new Set([...Object.keys(cache), 'Default']);
  for (const entry of disk.list(userDataDir)) {
    if (/^Profile \d+$/.test(entry) && disk.isDir(at.join(userDataDir, entry))) names.add(entry);
  }
  const out = [];
  const consider = (dir, id, name) => {
    const has = {};
    for (const [key, places] of Object.entries(DATABASES)) {
      for (const place of places) {
        const file = at.join(dir, ...place.split('/'));
        if (disk.isFile(file)) { has[key] = file; break; }
      }
    }
    // Saved addresses or history make it a browser profile. Cookies alone do
    // not: every Electron application on the machine — this one included —
    // keeps a `Cookies` beside a `Local State`, and none of them is a browser.
    if (!has.details && !has.history) return;
    out.push({ id, name, dir, has });
  };
  for (const id of names) {
    const info = cache[id] || {};
    consider(at.join(userDataDir, id), id, info.name || info.gaia_name || id);
  }
  // Opera and its kin: the user-data directory is the profile.
  consider(userDataDir, '.', at.basename(userDataDir));
  return out.sort((a, b) => (a.id === 'Default' ? -1 : b.id === 'Default' ? 1 : a.id.localeCompare(b.id)));
}

/** Does this directory hold a Chromium browser's user data? */
function isUserDataDir(dir, disk = io(), at = nodePath) {
  if (!disk.exists(at.join(dir, 'Local State'))) return false;
  return profiles(dir, disk, at).length > 0;
}

/** "Brave-Browser" -> "Brave Browser"; ".../Google/Chrome/User Data" -> "Chrome". */
function prettyName(dir, at = nodePath) {
  let base = at.basename(dir);
  if (/^user data$/i.test(base)) base = at.basename(at.dirname(dir));
  return base.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Sweep the roots for user-data directories the catalogue does not name.
 *
 * Shallow and bounded: a browser puts its data two or three levels under one
 * of a handful of directories, and once a directory turns out to be a
 * browser's there is no reason to look inside it. Directories that start with
 * a dot, and the caches every application leaves about, are skipped.
 */
function sweep(r, platform, disk, found) {
  const at = r.at;
  const out = [];
  const seen = new Set(found);
  const skip = /^(\.|cache|caches|crashpad|crash reports|logs|temp|tmp|node_modules)/i;
  const real = (p) => (typeof disk.real === 'function' ? disk.real(p) : p);
  const starts = [{ dir: r.config, left: SWEEP_DEPTH[platform] || 2 }];
  if (r.roaming && r.roaming !== r.config) starts.push({ dir: r.roaming, left: SWEEP_DEPTH[platform] || 2 });
  if (r.flatpak) {
    for (const app of disk.list(r.flatpak).slice(0, 200)) {
      starts.push({ dir: at.join(r.flatpak, app, 'config'), left: 3 });
    }
  }
  if (r.snap) {
    for (const app of disk.list(r.snap).slice(0, 200)) {
      starts.push({ dir: at.join(r.snap, app, 'common'), left: 2 });
    }
  }
  const queue = starts;
  let budget = 4000;
  while (queue.length && budget > 0) {
    const { dir, left } = queue.shift();
    for (const entry of disk.list(dir).slice(0, 300)) {
      if (budget-- <= 0) break;
      if (skip.test(entry) || EMBEDDED.test(entry) || JUNCTIONS.test(entry)) continue;
      const child = at.join(dir, entry);
      if (!disk.isDir(child)) continue;
      const here = real(child);
      if (seen.has(child) || seen.has(here)) continue;
      if (isUserDataDir(child, disk, at)) {
        seen.add(child);
        seen.add(here);
        out.push(child);
        continue;                       // a browser's directory holds no others
      }
      if (left > 1) queue.push({ dir: child, left: left - 1 });
    }
  }
  return out;
}

/**
 * Every Chromium browser on this machine, with its profiles.
 *
 * The catalogue first, so that the ones people have heard of come back named
 * and with the right keychain service; then the sweep, for everything else.
 */
function installed({ platform = process.platform, home, env = process.env, disk = io(), skipSweep = false } = {}) {
  const r = roots({ platform, home, env });
  const at = r.at;
  const out = [];
  const seen = new Set();
  for (const browser of CATALOGUE) {
    for (const [root, rel] of browser[platform] || []) {
      const base = r[root];
      if (!base) continue;
      const dir = at.join(base, ...rel.split('/'));
      const here = typeof disk.real === 'function' ? disk.real(dir) : dir;
      if (seen.has(dir) || seen.has(here) || !isUserDataDir(dir, disk, at)) continue;
      seen.add(dir);
      seen.add(here);
      out.push({ id: browser.id, name: browser.name, product: browser.product, dir, known: true,
        profiles: profiles(dir, disk, at) });
    }
  }
  if (!skipSweep) {
    for (const dir of sweep(r, platform, disk, seen)) {
      const name = prettyName(dir, at);
      out.push({ id: `other:${name.toLowerCase().replace(/\s+/g, '-')}`, name, product: name,
        dir, known: false, profiles: profiles(dir, disk, at) });
    }
  }
  return out;
}

module.exports = {
  CATALOGUE, DATABASES, EMBEDDED, installed, profiles, roots, localState, isUserDataDir, prettyName, io,
};
