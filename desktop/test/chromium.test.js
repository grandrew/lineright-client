'use strict';
/**
 * Finding the browsers, on all three systems at once.
 *
 * The filesystem is injected, so a machine laid out like a Windows one can be
 * described here and looked at from whatever this test is running on — which
 * is the only way the Windows and macOS paths get tested at all until
 * somebody runs the app there.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { installed, profiles, isUserDataDir, roots, prettyName, localState } = require('../src/chromium');

// The trees below are written with forward slashes, so the functions that
// take a path flavour are told which one that is. Left to the default they
// would use the one this machine runs on, and a Windows path module joins
// `/b` and `Default` into something no key in the fake filesystem matches —
// which is a fact about the test, not about the code it is testing.

/** A filesystem described as a map of file path to contents. */
function disk(files, sep = '/') {
  const dirs = new Set();
  for (const file of Object.keys(files)) {
    const parts = file.split(sep);
    for (let i = 1; i < parts.length; i += 1) dirs.add(parts.slice(0, i).join(sep));
  }
  const all = [...Object.keys(files), ...dirs];
  return {
    exists: (p) => p in files || dirs.has(p),
    isDir: (p) => dirs.has(p),
    isFile: (p) => p in files,
    read: (p) => (p in files ? files[p] : null),
    list: (p) => [...new Set(all
      .filter((x) => x.startsWith(p + sep))
      .map((x) => x.slice(p.length + 1).split(sep)[0]))],
  };
}

/**
 * What every Chromium profile has in it, in as few files as possible.
 *
 * `profileDirs: []` is the Opera shape: no per-person directory at all, the
 * databases straight in the user-data directory and nothing naming them.
 */
function browserAt(dir, { profileDirs = ['Default'], names = {}, sep = '/', network = false } = {}) {
  const files = {
    [`${dir}${sep}Local State`]: JSON.stringify({
      os_crypt: { encrypted_key: 'RFBBUEl4' },
      profile: { info_cache: Object.fromEntries(profileDirs.map((p) => [p, { name: names[p] || p }])) },
    }),
  };
  const dirs = profileDirs.length ? profileDirs.map((p) => `${dir}${sep}${p}`) : [dir];
  for (const at of dirs) {
    for (const file of ['Web Data', 'History', 'Preferences']) files[`${at}${sep}${file}`] = '';
    // Where the cookie store sits depends on how old the profile is.
    files[network ? `${at}${sep}Network${sep}Cookies` : `${at}${sep}Cookies`] = '';
  }
  return files;
}

test('the roots are the ones each system actually uses', () => {
  const win = roots({ platform: 'win32', home: 'C:\\Users\\ada', env: {} });
  assert.equal(win.local, 'C:\\Users\\ada\\AppData\\Local');
  assert.equal(win.roaming, 'C:\\Users\\ada\\AppData\\Roaming');
  assert.equal(roots({ platform: 'darwin', home: '/Users/ada', env: {} }).support, '/Users/ada/Library/Application Support');
  assert.equal(roots({ platform: 'linux', home: '/home/ada', env: {} }).config, '/home/ada/.config');
  assert.equal(roots({ platform: 'linux', home: '/home/ada', env: { XDG_CONFIG_HOME: '/elsewhere' } }).config, '/elsewhere');
});

test('Windows: Chrome, Edge and Opera are found where Windows puts them', () => {
  const local = 'C:\\Users\\ada\\AppData\\Local';
  const roaming = 'C:\\Users\\ada\\AppData\\Roaming';
  const files = {
    ...browserAt(`${local}\\Google\\Chrome\\User Data`, { profileDirs: ['Default', 'Profile 1'], names: { 'Profile 1': 'Work' }, sep: '\\' }),
    ...browserAt(`${local}\\Microsoft\\Edge\\User Data`, { sep: '\\' }),
    ...browserAt(`${roaming}\\Opera Software\\Opera Stable`, { profileDirs: [], sep: '\\' }),
  };
  const found = installed({ platform: 'win32', home: 'C:\\Users\\ada', env: {}, disk: disk(files, '\\') });
  assert.deepEqual(found.map((b) => b.name), ['Google Chrome', 'Microsoft Edge', 'Opera']);
  assert.deepEqual(found[0].profiles.map((p) => p.name), ['Default', 'Work']);
  assert.equal(found[0].product, 'Chrome');
  assert.ok(found[0].profiles[1].has.cookies.endsWith('Profile 1\\Cookies'));
  // Opera keeps one profile in the user-data directory itself, with no name.
  assert.deepEqual(found[2].profiles.map((p) => p.id), ['.']);
  assert.equal(found[2].profiles[0].name, 'Opera Stable');
});

test('macOS: the browsers are under Application Support', () => {
  const support = '/Users/ada/Library/Application Support';
  const files = {
    ...browserAt(`${support}/Google/Chrome`),
    ...browserAt(`${support}/BraveSoftware/Brave-Browser`),
    ...browserAt(`${support}/Perplexity/Comet`),
  };
  const found = installed({ platform: 'darwin', home: '/Users/ada', env: {}, disk: disk(files) });
  assert.deepEqual(found.map((b) => b.name).sort(), ['Brave', 'Comet', 'Google Chrome']);
  assert.deepEqual(found.map((b) => b.product).sort(), ['Brave', 'Chrome', 'Comet']);
});

test('Linux: ~/.config, a Snap and a Flatpak are three different browsers', () => {
  const files = {
    ...browserAt('/home/ada/.config/google-chrome'),
    ...browserAt('/home/ada/snap/chromium/common/chromium'),
    ...browserAt('/home/ada/.var/app/com.brave.Browser/config/BraveSoftware/Brave-Browser'),
  };
  const found = installed({ platform: 'linux', home: '/home/ada', env: {}, disk: disk(files) });
  assert.deepEqual(found.map((b) => b.dir).sort(), [
    '/home/ada/.config/google-chrome',
    '/home/ada/.var/app/com.brave.Browser/config/BraveSoftware/Brave-Browser',
    '/home/ada/snap/chromium/common/chromium',
  ]);
});

test('a browser nobody listed is swept up, and named after its directory', () => {
  const files = {
    ...browserAt('/home/ada/.config/google-chrome'),
    ...browserAt('/home/ada/.config/Unheard-Of/Browser'),
  };
  const found = installed({ platform: 'linux', home: '/home/ada', env: {}, disk: disk(files) });
  const swept = found.find((b) => !b.known);
  assert.equal(swept.name, 'Browser');
  assert.equal(swept.dir, '/home/ada/.config/Unheard-Of/Browser');
  assert.equal(swept.profiles.length, 1);
  assert.equal(found.filter((b) => b.known).length, 1, 'the listed one is not swept up a second time');
  assert.equal(installed({ platform: 'linux', home: '/home/ada', env: {}, disk: disk(files), skipSweep: true }).length, 1);
});

test('the cookie store is found wherever this profile keeps it', () => {
  const older = profiles('/b', disk(browserAt('/b')), path.posix);
  assert.equal(older[0].has.cookies, '/b/Default/Cookies');
  // What every current Chromium writes, and what a Windows Chrome has.
  const newer = profiles('/b', disk(browserAt('/b', { network: true })), path.posix);
  assert.equal(newer[0].has.cookies, '/b/Default/Network/Cookies');
  // A profile carrying both is the newer one; the other is what was left
  // behind when the browser moved it.
  const both = { ...browserAt('/b'), ...browserAt('/b', { network: true }) };
  assert.equal(profiles('/b', disk(both), path.posix)[0].has.cookies, '/b/Default/Network/Cookies');
});

test('an application that embeds a browser is not a browser', () => {
  // WebView2 gives Outlook, OneDrive and every updater a Chromium profile of
  // its own, Web Data and History and all. None of them is somebody's browser.
  const local = 'C:\\Users\\ada\\AppData\\Local';
  const files = {
    ...browserAt(`${local}\\Google\\Chrome\\User Data`, { sep: '\\', network: true }),
    ...browserAt(`${local}\\Microsoft\\OneDrive\\EBWebView`, { sep: '\\', network: true }),
    ...browserAt(`${local}\\WinSparkle\\EBWebView`, { sep: '\\', network: true }),
    ...browserAt(`${local}\\Some App\\App.exe.WebView2`, { sep: '\\', network: true }),
  };
  const found = installed({ platform: 'win32', home: 'C:\\Users\\ada', env: {}, disk: disk(files, '\\') });
  assert.deepEqual(found.map((b) => b.name), ['Google Chrome']);
  assert.equal(found[0].profiles[0].has.cookies, `${local}\\Google\\Chrome\\User Data\\Default\\Network\\Cookies`);
});

test('one directory reached by two names is one browser', () => {
  // AppData\Local\Application Data is a junction back to AppData\Local, so a
  // sweep that followed it would find every browser on the machine twice.
  const local = 'C:\\Users\\ada\\AppData\\Local';
  const files = {
    ...browserAt(`${local}\\Unlisted\\Browser`, { sep: '\\', network: true }),
    ...browserAt(`${local}\\Application Data\\Unlisted\\Browser`, { sep: '\\', network: true }),
  };
  const found = installed({ platform: 'win32', home: 'C:\\Users\\ada', env: {}, disk: disk(files, '\\') });
  assert.deepEqual(found.map((b) => b.dir), [`${local}\\Unlisted\\Browser`]);
});

test('an Electron application is not a browser, whatever its Local State says', () => {
  // Every Electron app keeps a Local State and a Cookies beside it — this one
  // included. None of them has a Web Data or a History, and none of them is
  // something to offer to import from.
  const files = {
    '/home/ada/.config/SomeApp/Local State': JSON.stringify({ os_crypt: { portal: 'gnome' } }),
    '/home/ada/.config/SomeApp/Cookies': '',
    '/home/ada/.config/SomeApp/Preferences': '',
  };
  assert.equal(isUserDataDir('/home/ada/.config/SomeApp', disk(files), path.posix), false);
  assert.deepEqual(installed({ platform: 'linux', home: '/home/ada', env: {}, disk: disk(files) }), []);
});

test('a profile is named by Local State, and an empty one is not offered at all', () => {
  const files = {
    ...browserAt('/b', { profileDirs: ['Default', 'Profile 2'], names: { Default: 'Ada', 'Profile 2': 'Work' } }),
    '/b/Profile 9/Preferences': '',            // a profile an uninstall left behind
  };
  const list = profiles('/b', disk(files), path.posix);
  assert.deepEqual(list.map((p) => p.name), ['Ada', 'Work']);
  assert.deepEqual(list.map((p) => p.id), ['Default', 'Profile 2']);
  assert.equal(list[0].has.details, '/b/Default/Web Data');
});

test('Local State that is missing or nonsense is not an error', () => {
  assert.deepEqual(localState('/nowhere', disk({}), path.posix), {});
  assert.deepEqual(localState('/b', disk({ '/b/Local State': '{oh dear' }), path.posix), {});
  assert.equal(localState('/b', disk({ '/b/Local State': '{"os_crypt":{"encrypted_key":"k"}}' }), path.posix).os_crypt.encrypted_key, 'k');
});

test('a directory becomes a name a person would recognise', () => {
  assert.equal(prettyName('/x/Brave-Browser', path.posix), 'Brave Browser');
  assert.equal(prettyName('C:\\x\\Google\\Chrome\\User Data', path.win32), 'Chrome');
});
