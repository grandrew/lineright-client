'use strict';
/**
 * Over-the-air updates, wired but not decided here.
 *
 * electron-updater does the work: it reads the feed the build embedded
 * (app-update.yml, from electron-builder's `publish` block — GitHub Releases
 * by default) or the generic feed the person pointed the app at, compares
 * versions, downloads in the background, and swaps the install on quit. This
 * module only decides *when* to look and tells the chrome what happened, and
 * it takes the updater and the timers as arguments so all of that can be
 * tested with a fake one.
 *
 * Nothing here runs in an unpackaged checkout: there is no installed copy to
 * replace, and electron-updater says so loudly. REGBOT_FORCE_UPDATES=1 turns
 * it on anyway, for trying the feed against `electron .` with a dev-app-update.yml.
 */
const SIX_HOURS = 6 * 60 * 60 * 1000;

/**
 * What a failed check means, in one line.
 *
 * electron-updater reports a failed feed request as an HttpError whose message
 * carries every response header, and a log wants one line of that. A 404 from
 * the feed is not a fault at all: it is what GitHub answers for a repository
 * that has published no release yet (or that is private), which is every fresh
 * install before the first tag.
 */
function classify(err) {
  const message = String((err && err.message) || err || 'unknown error').split('\n')[0].trim();
  if (err && err.statusCode === 404) {
    return { phase: 'none', message: 'no release published yet (the feed answered 404)' };
  }
  return { phase: 'error', message };
}

function wire(autoUpdater, {
  feedUrl = '',
  isPackaged = false,
  force = false,
  log = () => {},
  onState = () => {},
  setTimeout: st = setTimeout,
  setInterval: si = setInterval,
  clearInterval: ci = clearInterval,
  firstDelayMs = 15000,
  everyMs = SIX_HOURS,
} = {}) {
  const state = (phase, extra = {}) => onState({ phase, ...extra });

  if (!isPackaged && !force) {
    state('disabled', { message: 'Updates run in an installed build only.' });
    return { enabled: false, check: async () => null, install: () => false, stop: () => {} };
  }

  if (feedUrl) {
    // A generic feed: any static host serving latest*.yml and the artifacts,
    // e.g. scripts/update-server.js. Without one, the embedded feed stands.
    autoUpdater.setFeedURL({ provider: 'generic', url: feedUrl });
  }
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  if (typeof autoUpdater.logger !== 'undefined') autoUpdater.logger = null;

  autoUpdater.on('checking-for-update', () => state('checking'));
  autoUpdater.on('update-available', (info) => state('available', { version: info && info.version }));
  autoUpdater.on('update-not-available', (info) => state('none', { version: info && info.version }));
  autoUpdater.on('download-progress', (p) => state('downloading', { percent: Math.round(p.percent || 0) }));
  autoUpdater.on('update-downloaded', (info) => state('ready', { version: info && info.version }));
  // The updater emits 'error' and then rejects checkForUpdates with the same
  // failure, so one bad check would otherwise be logged and shown twice.
  let reported = null;
  const report = (err) => {
    if (reported && (err === reported || (err && err.message === reported.message))) return;
    reported = err;
    const what = classify(err);
    log(`update ${what.phase === 'error' ? 'error' : 'check'}: ${what.message}`);
    state(what.phase, { message: what.message });
  };
  autoUpdater.on('error', report);

  const check = async () => {
    reported = null;
    try {
      return await autoUpdater.checkForUpdates();
    } catch (err) {
      report(err);
      return null;
    }
  };
  const install = () => {
    autoUpdater.quitAndInstall();
    return true;
  };

  const first = st(check, firstDelayMs);
  const every = si(check, everyMs);
  state('idle', { feed: feedUrl || 'embedded' });
  return {
    enabled: true, check, install,
    stop: () => { clearTimeout(first); ci(every); },
  };
}

module.exports = { wire, SIX_HOURS };
