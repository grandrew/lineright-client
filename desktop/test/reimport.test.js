'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const reimport = require('../src/reimport');
const { Profile } = require('../src/profile');

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.parse('2026-09-01T10:00:00Z');

/** The settings, as store.js keeps them: in memory here. */
function memoryStore(initial = {}) {
  const saved = { ...initial };
  return {
    saved,
    get: (key, fallback) => (key in saved && saved[key] !== null && saved[key] !== undefined ? saved[key] : fallback),
    set: (key, value) => { saved[key] = value; return value; },
    chosen: (key) => key in saved,
  };
}

const profileFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'regbot-reimport-')), 'profile.json');
const chrome = { dir: '/home/p/.config/google-chrome', profile: 'Default', name: 'Google Chrome', profileName: 'Person 1' };
const edge = { dir: '/home/p/.config/microsoft-edge', profile: 'Profile 1', name: 'Microsoft Edge', profileName: '' };
const CHROME = reimport.sourceKey(chrome);
const EDGE = reimport.sourceKey(edge);

/** What import.read hands back for a browser's fields. */
const field = (key, value, ...others) => ({ key, label: key, value, from: 'Saved address', others: others.map((v) => ({ value: v, from: 'A form you filled in' })) });

test('an import is remembered — where from and what was taken, never the values — and asked again a week on', () => {
  const store = memoryStore();
  reimport.remember(store, { ...chrome, fields: ['email', 'phone', 'nonsense'], origins: ['https://www.dmv.ca.gov'], others: true }, T0);
  const [src] = reimport.sources(store);
  assert.deepEqual(src.fields, ['email', 'phone'], 'only fields the profile has');
  assert.deepEqual(src.origins, ['https://www.dmv.ca.gov']);
  assert.equal(src.others, true);
  assert.doesNotMatch(JSON.stringify(store.saved), /@|555/, 'no values in the settings');
  assert.equal(reimport.due(store, T0 + 6 * DAY), false);
  assert.equal(reimport.due(store, T0 + 7 * DAY), true, 'a week on');
  assert.equal(reimport.view(store, T0 + 7 * DAY).sources[0].label, 'Google Chrome (Person 1)');
});

test('an import that took nothing is not one to repeat', () => {
  const store = memoryStore();
  assert.equal(reimport.remember(store, { ...chrome, fields: [], origins: [], others: false }, T0), null);
  assert.deepEqual(reimport.sources(store), []);
  assert.equal(reimport.due(store, T0 + 30 * DAY), false, 'nothing to ask about');
});

test('the last import from a browser says what to take from it; the newest browser comes first', () => {
  const store = memoryStore();
  reimport.remember(store, { ...chrome, fields: ['email', 'phone'], origins: [] }, T0);
  reimport.remember(store, { ...edge, fields: ['street'], origins: [] }, T0 + DAY);
  reimport.remember(store, { ...chrome, fields: ['email'], origins: ['https://www.dmv.ca.gov'] }, T0 + 2 * DAY);
  const list = reimport.sources(store);
  assert.deepEqual(list.map((s) => s.name), ['Google Chrome', 'Microsoft Edge']);
  assert.deepEqual(list[0].fields, ['email']);
  for (let i = 0; i < 6; i += 1) reimport.remember(store, { dir: `/b${i}`, profile: 'Default', name: `B${i}`, fields: ['email'], origins: [] }, T0);
  assert.equal(reimport.sources(store).length, reimport.MAX_SOURCES);
});

test('"Not now" asks again tomorrow; the person can stop the asking; a browser can be forgotten', () => {
  const store = memoryStore();
  reimport.remember(store, { ...chrome, fields: ['email'], origins: [] }, T0);
  reimport.remember(store, { ...edge, fields: ['email'], origins: [] }, T0);
  reimport.later(store, T0 + 8 * DAY);
  assert.equal(reimport.due(store, T0 + 8 * DAY + DAY / 2), false);
  assert.equal(reimport.due(store, T0 + 9 * DAY), true);
  store.set('reimportRemind', false);
  assert.equal(reimport.due(store, T0 + 30 * DAY), false);
  store.set('reimportRemind', true);
  reimport.forget(store, EDGE);
  assert.deepEqual(reimport.sources(store).map((s) => s.name), ['Google Chrome']);
  reimport.forget(store);
  assert.deepEqual(reimport.sources(store), []);
});

test('doing it again takes the browser\'s new values for what was taken from it, and nothing else', () => {
  const src = { ...chrome, fields: ['email', 'phone', 'street'], origins: [] };
  const offered = [field('email', 'new@example.com'), field('phone', '6505550199'), field('street', '1 Main St'),
    field('city', 'Poway')];
  const { take, kept } = reimport.plan(src, offered,
    { email: 'old@example.com', phone: '6505550100', street: '1 Main St' },
    { email: CHROME, phone: CHROME, street: CHROME });
  assert.deepEqual(take, { email: 'new@example.com', phone: '6505550199' }, 'the street had not changed; the city was never taken');
  assert.deepEqual(kept, []);
});

test('what the person typed or cleared by hand is theirs', () => {
  const src = { ...chrome, fields: ['email', 'phone', 'zip'], origins: [] };
  const offered = [field('email', 'browser@example.com'), field('phone', '6505550199'), field('zip', '92064')];
  const { take, kept } = reimport.plan(src, offered, { email: 'mine@example.com', phone: '' },
    { email: 'hand', phone: 'hand' });
  assert.deepEqual(take, { zip: '92064' }, 'an empty field nobody cleared is filled in');
  assert.deepEqual(kept, ['email'], 'the cleared phone stays cleared, and is not reported as kept');
});

test('a value of unknown origin is the person\'s, and another browser\'s field is left to it', () => {
  const src = { ...chrome, fields: ['email', 'phone'], origins: [] };
  const { take, kept } = reimport.plan(src, [field('email', 'b@example.com'), field('phone', '6505550199')],
    { email: 'a@example.com', phone: '6505550100' }, { phone: EDGE });
  assert.deepEqual(take, {});
  assert.deepEqual(kept, ['email']);
});

test('a value the browser still offers is kept, though it is not the browser\'s first choice', () => {
  const src = { ...chrome, fields: ['phone'], origins: [] };
  const offered = [field('phone', '6505550100', '6505550142')];
  assert.deepEqual(reimport.plan(src, offered, { phone: '6505550142' }, { phone: CHROME }).take, {});
  assert.deepEqual(reimport.plan(src, offered, { phone: '6505550999' }, { phone: CHROME }).take, { phone: '6505550100' },
    'gone from the browser: the browser\'s first choice now');
});

test('a sign-in the app holds fresher is kept; a newer one from the browser comes across', () => {
  const cookie = (name, expirationDate, extra = {}) => ({ cookie: { url: 'https://www.dmv.ca.gov/', name, value: 'v', path: '/', domain: '.dmv.ca.gov', expirationDate, ...extra } });
  const taking = [cookie('renewed', 2_000_000_000), cookie('older', 1_700_000_000), cookie('new', 1_800_000_000),
    cookie('session', undefined), cookie('hostonly', 1_900_000_000, { domain: undefined })];
  const existing = [
    { domain: '.dmv.ca.gov', path: '/', name: 'renewed', expirationDate: 1_750_000_000 },
    { domain: '.dmv.ca.gov', path: '/', name: 'older', expirationDate: 1_750_000_000 },
    { domain: 'dmv.ca.gov', path: '/', name: 'session' },
    { domain: 'www.dmv.ca.gov', path: '/', name: 'hostonly' },
  ];
  assert.deepEqual(reimport.fresher(taking, existing).map((c) => c.cookie.name), ['renewed', 'new']);
});

test('one click does it all again: refreshes the profile, keeps what was typed, and asks again in a week', async () => {
  const store = memoryStore();
  const profile = new Profile(profileFile());
  profile.merge({ email: 'old@example.com', phone: '6505550100', zip: '92064' }, CHROME);
  profile.set({ ...profile.data, zip: '92065' });                      // typed by hand since
  reimport.remember(store, { ...chrome, fields: ['email', 'phone', 'zip'], origins: ['https://www.dmv.ca.gov'] }, T0);
  const puts = [];
  const out = await reimport.run({
    store, profile, now: T0 + 7 * DAY,
    read: async (src) => {
      assert.equal(src.dir, chrome.dir);
      return { fields: [field('email', 'new@example.com'), field('phone', '6505550100'), field('zip', '92064')],
        cookies: [], notes: [] };
    },
    cookies: async (src) => { puts.push(src.origins); return { set: 12, refused: 1, fresher: 3 }; },
  });
  assert.deepEqual(out.updated, ['email']);
  assert.deepEqual(out.kept, ['zip']);
  assert.deepEqual([out.cookies, out.refused, out.fresher], [12, 1, 3]);
  assert.deepEqual(puts, [['https://www.dmv.ca.gov']], 'the sign-ins for the sites chosen last time');
  assert.deepEqual(out.done, ['Google Chrome (Person 1)']);
  assert.deepEqual(profile.data, { email: 'new@example.com', phone: '6505550100', zip: '92065' });
  assert.equal(profile.origins().email, CHROME);
  assert.equal(profile.origins().zip, 'hand');
  assert.equal(reimport.due(store, T0 + 13 * DAY), false);
  assert.equal(reimport.due(store, T0 + 14 * DAY), true);
  assert.equal(reimport.sources(store)[0].at, new Date(T0 + 7 * DAY).toISOString());
});

test('a browser that cannot be read is reported, and with nothing read it asks again tomorrow', async () => {
  const store = memoryStore();
  const profile = new Profile(profileFile());
  reimport.remember(store, { ...chrome, fields: ['email'], origins: [] }, T0);
  const out = await reimport.run({
    store, profile, now: T0 + 7 * DAY,
    read: async () => { throw new Error('That browser is no longer where it was.'); },
    cookies: async () => ({ set: 0, refused: 0 }),
  });
  assert.deepEqual(out.failed, [{ name: 'Google Chrome (Person 1)', message: 'That browser is no longer where it was.' }]);
  assert.equal(reimport.due(store, T0 + 7 * DAY + DAY / 2), false);
  assert.equal(reimport.due(store, T0 + 8 * DAY), true);
});

test('where two browsers could fill the same empty field, the one imported from last does', async () => {
  const store = memoryStore();
  const profile = new Profile(profileFile());
  reimport.remember(store, { ...edge, fields: ['city'], origins: [] }, T0);
  reimport.remember(store, { ...chrome, fields: ['city'], origins: [] }, T0 + DAY);
  const out = await reimport.run({
    store, profile, now: T0 + 8 * DAY,
    read: async (src) => ({ fields: [field('city', src.dir === chrome.dir ? 'Poway' : 'Ramona')], cookies: [] }),
    cookies: async () => ({ set: 0, refused: 0 }),
  });
  assert.deepEqual(out.updated, ['city']);
  assert.equal(profile.data.city, 'Poway');
  assert.equal(profile.origins().city, CHROME);
});

test('the site says how often to ask, and a change applies at once', () => {
  const store = memoryStore();
  reimport.remember(store, { ...chrome, fields: ['email'], origins: [] }, T0);
  const often = { reimport_days: 3, reimport_later_hours: 2 };
  assert.equal(reimport.due(store, T0 + 2 * DAY, often), false);
  assert.equal(reimport.due(store, T0 + 3 * DAY, often), true);
  assert.equal(reimport.due(store, T0 + 3 * DAY), false, 'a week, until the site says otherwise');
  reimport.later(store, T0 + 3 * DAY, often);
  assert.equal(reimport.due(store, T0 + 3 * DAY + 1.5 * 3600e3, often), false);
  assert.equal(reimport.due(store, T0 + 3 * DAY + 2 * 3600e3, often), true, 'Not now is two hours here');
  assert.equal(reimport.view(store, T0, often).every_days, 3);
  const off = { reimport_days: 0, reimport_later_hours: 24 };
  assert.equal(reimport.due(store, T0 + 365 * DAY, off), false, 'the site can turn the asking off');
  assert.equal(reimport.view(store, T0, off).at, null);
  assert.deepEqual(reimport.schedule({ reimport_days: 'x' }), { every: reimport.EVERY_MS, later: reimport.LATER_MS },
    'nonsense from a site is not a schedule');
});
