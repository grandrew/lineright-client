'use strict';
/**
 * The application menu. File, Sites, Help — and on macOS the app and edit
 * menus the platform expects. Built from plain data so it can be tested
 * without Electron, and rebuilt whenever what it shows changes: which server
 * the app is using, whether anybody is signed in, and which sites it lists.
 *
 * View → Developer mode switches what only the people who work on the app see
 * (developer.js): test sites, marked as such in Sites; Chromium's developer
 * tools; and the servers that are not the public site. A run started with
 * --developer, or practising, has it on and cannot switch it off.
 *
 * With the server this app runs itself (`builtin`, Practice on this computer)
 * there is nobody to sign in to — the app is the person using it — so File has
 * no sign-in, and View gains that server's control room.
 *
 * Every item calls back into `actions` by name; main.js decides what the
 * names mean. Nothing here touches a window.
 */

const DEVELOPER = {
  practice: 'Developer mode (on while practising)',
  flag: 'Developer mode (on for this run)',
};

function template({ platform = process.platform, builtin = false, paired = false, user = null, sites = [],
  actions = {}, version = '', importRecommended = false, importAgain = '',
  developer = { on: false, forced: null } } = {}) {
  const act = (name, arg) => () => { if (actions[name]) actions[name](arg); };
  const mac = platform === 'darwin';
  const who = user && user.nickname ? ` (${user.nickname})` : '';

  const account = builtin ? [] : [
    paired
      ? { label: `Sign out${who}`, click: act('signOut') }
      : { label: 'Sign in…', accelerator: 'CmdOrCtrl+L', click: act('signIn') },
    { type: 'separator' },
  ];
  const file = {
    label: '&File',
    submenu: [
      ...account,
      { label: 'Profile…', accelerator: 'CmdOrCtrl+P', click: act('profile') },
      // Named as a suggestion while it is one: a profile this app can fill a
      // booking form from is the difference between a quick turn and a slow one.
      { label: `Import from your browser…${importRecommended ? ' (recommended)' : ''}`, click: act('importBrowser') },
      // One click: the browsers imported from before, again (reimport.js).
      ...(importAgain ? [{ label: `Re-import data from ${importAgain}`, click: act('importAgain') }] : []),
      { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: act('settings') },
      { label: 'Buy credits…', click: act('credits') },
      { type: 'separator' },
      { label: 'Sync now', accelerator: 'CmdOrCtrl+R', click: act('syncNow') },
      { label: 'Report a slot you found…', click: act('found') },
      { type: 'separator' },
      mac ? { role: 'close' } : { label: 'E&xit', accelerator: 'Alt+F4', click: act('quit') },
    ],
  };

  // Made-up sites are only ever here in developer mode, and say what they are.
  const siteItems = sites.map((s) => ({ label: s.mock ? `${s.name} — test site` : s.name, click: act('site', s.slug) }));
  const sitesMenu = {
    label: '&Sites',
    submenu: [
      { label: 'All sites', accelerator: 'CmdOrCtrl+1', click: act('sites') },
      { label: 'Console', accelerator: 'CmdOrCtrl+2', click: act('console') },
      { type: 'separator' },
      ...(siteItems.length ? siteItems : [{ label: 'No sites yet — is the server up?', enabled: false }]),
    ],
  };

  const view = {
    label: '&View',
    submenu: [
      { label: 'Back to the app', accelerator: 'CmdOrCtrl+0', click: act('app') },
      { label: 'Fill this form from my profile', accelerator: 'CmdOrCtrl+Shift+F', click: act('fill') },
      { type: 'separator' },
      ...(builtin ? [
        { label: 'Control room', click: act('controlRoom') },
        { type: 'separator' },
      ] : []),
      { role: 'togglefullscreen' },
      { type: 'separator' },
      { label: DEVELOPER[developer.forced] || 'Developer mode', type: 'checkbox', checked: Boolean(developer.on),
        enabled: !developer.forced, click: act('developer') },
      ...(developer.on ? [{ role: 'toggleDevTools' }] : []),
    ],
  };

  const help = {
    label: '&Help',
    role: mac ? 'help' : undefined,
    submenu: [
      { label: 'LineRight Regbot help', accelerator: 'F1', click: act('help') },
      { label: 'Ask for a site or a line…', click: act('requestSite') },
      { label: 'Advanced: telemetry and diagnostics…', click: act('advanced') },
      ...(builtin ? [{ label: 'Server logs', click: act('serverLogs') }] : []),
      { label: 'Check for updates…', click: act('checkUpdates') },
      { type: 'separator' },
      { label: `About LineRight Regbot${version ? ` ${version}` : ''}`, click: act('about') },
    ],
  };

  const items = [];
  if (mac) {
    items.push({
      label: 'LineRight Regbot',
      submenu: [
        { label: `About LineRight Regbot${version ? ` ${version}` : ''}`, click: act('about') },
        { type: 'separator' },
        { label: 'Settings…', accelerator: 'Cmd+,', click: act('settings') },
        { type: 'separator' },
        { role: 'services' }, { type: 'separator' },
        { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' },
        { role: 'quit' },
      ],
    });
  }
  items.push(file);
  if (mac) items.push({ role: 'editMenu' });
  items.push(sitesMenu, view);
  if (mac) items.push({ role: 'windowMenu' });
  items.push(help);
  return items;
}

/** Every label reachable from the top, for tests and for the help page. */
function outline(items) {
  return items.map((m) => ({
    label: m.label || m.role,
    items: (m.submenu || []).filter((i) => i.type !== 'separator').map((i) => i.label || i.role),
  }));
}

module.exports = { template, outline };
