'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { template, outline } = require('../src/menu');

test('signed out, File offers Sign in; signed in, Sign out with the nickname', () => {
  const out = outline(template({ platform: 'linux', paired: false }));
  assert.deepEqual(out.map((m) => m.label), ['&File', '&Sites', '&View', '&Help']);
  assert.ok(out[0].items.includes('Sign in…'));
  assert.ok(out[0].items.includes('E&xit'));
  const on = outline(template({ platform: 'linux', paired: true, user: { nickname: 'ada' } }));
  assert.ok(on[0].items.includes('Sign out (ada)'));
  assert.ok(!on[0].items.includes('Sign in…'));
});

test('the import is named as a suggestion only while it is one', () => {
  const plain = outline(template({ platform: 'linux' }))[0].items;
  assert.ok(plain.includes('Import from your browser…'), plain);
  const urged = outline(template({ platform: 'linux', importRecommended: true }))[0].items;
  assert.ok(urged.some((i) => /^Import from your browser….*recommended/.test(i)), urged);
});

test('once something was imported, File re-imports it in one click, naming where from', () => {
  const none = outline(template({ platform: 'linux' }))[0].items;
  assert.ok(!none.some((i) => /^Re-import/.test(i)), none);
  const calls = [];
  const items = template({ platform: 'linux', importAgain: 'Google Chrome (Person 1)',
    actions: { importAgain: () => calls.push('again') } });
  const file = items.find((m) => m.label === '&File').submenu;
  const again = file.find((i) => i.label === 'Re-import data from Google Chrome (Person 1)');
  assert.ok(again, file.map((i) => i.label).join(', '));
  again.click();
  assert.deepEqual(calls, ['again']);
});

test('the Sites menu lists what the app lists, test sites named as such, and says so when it lists nothing', () => {
  const items = template({ platform: 'win32', sites: [{ name: 'California DMV', slug: 'ca-dmv' }, { name: 'Helios Arena', slug: 'helios-arena', mock: true }] });
  const sites = outline(items).find((m) => m.label === '&Sites');
  assert.deepEqual(sites.items, ['All sites', 'Console', 'California DMV', 'Helios Arena — test site']);
  const none = outline(template({ platform: 'win32', sites: [] })).find((m) => m.label === '&Sites');
  assert.ok(none.items.some((i) => /No sites yet/.test(i)));
});

test('View switches developer mode, and only developer mode has the developer tools', () => {
  const view = (developer) => template({ platform: 'linux', developer }).find((m) => m.label === '&View').submenu;
  const switchOf = (items) => items.find((i) => /^Developer mode/.test(i.label || ''));

  const off = view({ on: false, forced: null });
  assert.equal(switchOf(off).type, 'checkbox');
  assert.equal(switchOf(off).checked, false);
  assert.equal(switchOf(off).enabled, true);
  assert.ok(!off.some((i) => i.role === 'toggleDevTools'), 'the public app has no developer tools in its menu');
  assert.ok(!view(undefined).some((i) => i.role === 'toggleDevTools'), 'nor does one built without saying');

  const on = view({ on: true, forced: null });
  assert.equal(switchOf(on).checked, true);
  assert.equal(switchOf(on).enabled, true, 'turned on from the menu, it turns off there too');
  assert.ok(on.some((i) => i.role === 'toggleDevTools'));

  // Held on by the command line, or by practising: said, and not switchable.
  for (const [forced, label] of [['flag', 'Developer mode (on for this run)'], ['practice', 'Developer mode (on while practising)']]) {
    const item = switchOf(view({ on: true, forced }));
    assert.deepEqual([item.label, item.checked, item.enabled], [label, true, false]);
  }

  const calls = [];
  const items = template({ platform: 'linux', actions: { developer: () => calls.push('developer') } });
  switchOf(items.find((m) => m.label === '&View').submenu).click();
  assert.deepEqual(calls, ['developer']);
});

test('items call their actions by name, with the site slug where there is one', () => {
  const calls = [];
  const actions = new Proxy({}, { get: (_t, name) => (arg) => calls.push([name, arg]) });
  const items = template({ platform: 'linux', paired: true, sites: [{ name: 'DMV', slug: 'ca-dmv' }], actions });
  const find = (menu, label) => items.find((m) => m.label === menu).submenu.find((i) => i.label === label);
  find('&File', 'Sign out').click();
  find('&File', 'Import from your browser…').click();
  find('&Sites', 'DMV').click();
  find('&Help', 'LineRight Regbot help').click();
  find('&View', 'Fill this form from my profile').click();
  find('&File', 'E&xit').click();
  assert.deepEqual(calls, [['signOut', undefined], ['importBrowser', undefined], ['site', 'ca-dmv'],
    ['help', undefined], ['fill', undefined], ['quit', undefined]]);
});

test('macOS gets the app, edit and window menus and closes rather than exits', () => {
  const out = outline(template({ platform: 'darwin', version: '0.1.0' }));
  assert.deepEqual(out.map((m) => m.label), ['LineRight Regbot', '&File', 'editMenu', '&Sites', '&View', 'windowMenu', '&Help']);
  assert.ok(out[0].items.includes('About LineRight Regbot 0.1.0'));
  assert.ok(out[1].items.includes('close'));
  assert.ok(!out[1].items.includes('E&xit'));
});

test('with the server on this computer there is nobody to sign in to, and its control room is in View', () => {
  const out = outline(template({ platform: 'linux', builtin: true, paired: true, user: { nickname: 'ada' } }));
  const file = out.find((m) => m.label === '&File').items;
  assert.ok(!file.some((i) => /^Sign (in|out)/.test(i)), file.join(', '));
  const view = out.find((m) => m.label === '&View').items;
  assert.ok(view.includes('Control room') && !view.includes('The regbot website'), view.join(', '));
  assert.ok(out.find((m) => m.label === '&Help').items.includes('Server logs'));
  const remote = outline(template({ platform: 'linux', builtin: false }));
  assert.ok(!remote.find((m) => m.label === '&View').items.includes('Control room'));
  assert.ok(!remote.find((m) => m.label === '&Help').items.includes('Server logs'));

  const calls = [];
  const actions = new Proxy({}, { get: (_t, name) => (arg) => calls.push(name) });
  const items = template({ platform: 'linux', builtin: true, actions });
  const find = (menu, label) => items.find((m) => m.label === menu).submenu.find((i) => i.label === label);
  find('&View', 'Control room').click();
  find('&Help', 'Server logs').click();
  assert.deepEqual(calls, ['controlRoom', 'serverLogs']);
});

test('credits and the Advanced screen are in the menus', () => {
  const calls = [];
  const actions = new Proxy({}, { get: (_t, name) => () => calls.push(name) });
  const items = template({ platform: 'linux', paired: true, actions });
  const find = (menu, label) => items.find((m) => m.label === menu).submenu.find((i) => i.label === label);
  find('&File', 'Buy credits…').click();
  find('&Help', 'Advanced: telemetry and diagnostics…').click();
  find('&Help', 'Ask for a site or a line…').click();
  assert.deepEqual(calls, ['credits', 'advanced', 'requestSite']);
});
