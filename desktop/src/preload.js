'use strict';
/**
 * The bridge between the chrome page and the main process.
 *
 * The chrome is a web page with no Node access; this is the whole of what it
 * may ask for. Channels are named, not forwarded, so a page that was somehow
 * replaced could still only do what a chrome can do.
 */
const { contextBridge, ipcRenderer } = require('electron');

const EVENTS = new Set([
  'shell:state', 'sync:doc', 'sync:status', 'update:state', 'pair:state', 'toast',
  'app:navigate', 'autofill:done', 'stack:state', 'robots:state', 'import:due', 'developer:state',
]);
const CALLS = new Set([
  // the browser half
  'tabs:open', 'tabs:select', 'tabs:close', 'tabs:navigate', 'tabs:back', 'tabs:forward',
  'tabs:reload', 'tabs:home', 'tabs:external', 'chrome:height',
  // the application half: everything it shows comes from the server as JSON
  'server:sites', 'server:site', 'server:board', 'server:bid', 'server:raise',
  'server:withdraw', 'server:account', 'server:topup', 'server:revoke',
  // credits: the balance kept on the site, and buying more through its payment page
  'server:credits', 'server:payment', 'server:payment-open', 'server:payment-cancel',
  // asking for a line on a booking site the site does not cover yet
  'requests:list', 'requests:submit', 'requests:support',
  // this app's own telemetry, kept here, and sharing it with the site when asked to
  'telemetry:get', 'telemetry:preview', 'telemetry:share', 'telemetry:auto', 'telemetry:clear',
  // signing in
  'pair:start', 'pair:cancel', 'pair:forget', 'pair:state', 'pair:open',
  // the person's own details, kept here
  'profile:get', 'profile:set', 'profile:clear', 'profile:fill',
  // what another browser on this machine can hand over
  'import:scan', 'import:read', 'import:apply', 'import:offer', 'import:dismiss',
  // and again, once a week, from the browsers it came from
  'import:again', 'import:again-state', 'import:later', 'import:forget',
  // hand-offs and reports
  'handoff:booked', 'handoff:pass', 'handoff:open',
  'found:submit', 'found:places', 'found:prefill',
  // the server this app runs on this computer
  'stack:status', 'stack:restart', 'stack:dmv', 'stack:open',
  // the rest
  'settings:get', 'settings:set', 'update:check', 'update:install', 'sync:now', 'app:info',
  'app:about', 'app:reset', 'robots:status',
]);

contextBridge.exposeInMainWorld('regbot', {
  on(channel, handler) {
    if (!EVENTS.has(channel)) throw new Error(`unknown event ${channel}`);
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
  call(name, payload) {
    if (!CALLS.has(name)) return Promise.reject(new Error(`unknown call ${name}`));
    return ipcRenderer.invoke(`regbot:${name}`, payload);
  },
});
