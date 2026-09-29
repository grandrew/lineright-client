'use strict';
/**
 * Which regbot server this run of the app talks to, and with what token.
 *
 * In order:
 *   1. `--practice` (or REGBOT_SERVER_MODE=builtin): the server the app runs
 *      itself, for this run, whatever the settings say.
 *   2. `--server=<url>` (or REGBOT_SERVER_URL): that server, for this run,
 *      without saving it. Its token is REGBOT_CLIENT_TOKEN if one is given, or
 *      a saved one only if that server issued it.
 *   3. The settings: the server the person chose, or the public site the build
 *      names (config.json), with the token that server issued — or, where the
 *      build names none and nobody chose one, the app's own.
 *
 * A token goes only to the server that issued it. Offered to any other it is at
 * best refused and at worst a way into the account for whoever runs that server.
 *
 * Pure, so the rules are tested without Electron: `store` is anything with
 * `get(key)` (src/store.js).
 */
const trim = (url) => String(url || '').trim().replace(/\/+$/, '');

function resolve({ argv = {}, env = {}, store }) {
  const practice = argv.practice === true || argv.practice === 'true'
    || String(env.REGBOT_SERVER_MODE || '').trim().toLowerCase() === 'builtin';
  if (practice) return { mode: 'builtin', url: '', token: null, forced: true };

  const tokenFor = (url) => (trim(store.get('tokenServer')) === url && url ? store.get('token') || null : null);

  const forced = trim(argv.server || env.REGBOT_SERVER_URL);
  if (forced) {
    return { mode: 'remote', url: forced, token: env.REGBOT_CLIENT_TOKEN || tokenFor(forced), forced: true };
  }
  const url = trim(store.get('serverUrl'));
  if (store.get('serverMode') !== 'remote' || !url) {
    return { mode: 'builtin', url: '', token: null, forced: false };
  }
  return { mode: 'remote', url, token: tokenFor(url), forced: false };
}

module.exports = { resolve };
