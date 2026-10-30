'use strict';
/**
 * Keeping the app running: the computer kept awake (src/awake.js), and the
 * notice and bar that say to keep the app open (ui/keepopen.js).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { Awake, KIND } = require('../src/awake');
const keepOpen = require('../ui/keepopen');

function fakeBlocker({ fails = false } = {}) {
  const started = new Set();
  let next = 1;
  return {
    started,
    calls: [],
    start(kind) {
      this.calls.push(['start', kind]);
      if (fails) throw new Error('no inhibitor');
      const id = next++;
      started.add(id);
      return id;
    },
    stop(id) { this.calls.push(['stop', id]); started.delete(id); },
    isStarted(id) { return started.has(id); },
  };
}

function storeOf(values = {}) {
  return { get: (key, fallback) => (key in values ? values[key] : fallback), values };
}

test('the computer is kept awake unless the person said not to, and asked only once', () => {
  const blocker = fakeBlocker();
  const store = storeOf();
  const awake = new Awake({ blocker, store });
  assert.equal(awake.apply(), true);
  assert.equal(awake.apply(), true);
  assert.deepEqual(blocker.calls, [['start', KIND]]);
  assert.equal(KIND, 'prevent-app-suspension', 'the screen may still turn off');
  assert.deepEqual(awake.state(), { on: true, held: true });

  store.values.keepAwake = false;
  assert.equal(awake.apply(), false);
  assert.deepEqual(blocker.calls.at(-1), ['stop', 1]);
  assert.deepEqual(awake.state(), { on: false, held: false });

  store.values.keepAwake = true;
  assert.equal(awake.apply(), true);
  assert.deepEqual(blocker.calls.at(-1), ['start', KIND]);
});

test('a system that will not keep awake is said in the log, and the app goes on', () => {
  const said = [];
  const awake = new Awake({ blocker: fakeBlocker({ fails: true }), store: storeOf(), log: (m) => said.push(m) });
  assert.equal(awake.apply(), false);
  assert.deepEqual(awake.state(), { on: true, held: false });
  assert.match(said.join('\n'), /could not keep the computer awake: no inhibitor/);
});

test('the notice shows at start until understood; the bar at every start until told no more', () => {
  assert.equal(keepOpen.showNotice(null), false, 'not before the settings are known');
  assert.equal(keepOpen.showNotice({}), true);
  assert.equal(keepOpen.showNotice({ keepOpen: { understood: false, remind: true } }), true);
  assert.equal(keepOpen.showNotice({ keepOpen: { understood: true, remind: true } }), false);

  assert.equal(keepOpen.showBar(null, false), false);
  assert.equal(keepOpen.showBar({ keepOpen: { understood: true, remind: true } }, false), true);
  assert.equal(keepOpen.showBar({ keepOpen: { understood: true, remind: true } }, true), false, 'closed this run');
  assert.equal(keepOpen.showBar({ keepOpen: { understood: true, remind: false } }, false), false);
});

test('the notice is short, and says what to do about sleep as the app is set', () => {
  const kept = keepOpen.notice({ keepAwake: { on: true, held: true } });
  assert.match(kept, /Keep this app open/);
  assert.match(kept, /laptop lid/);
  assert.match(kept, /The app stops the computer from going to sleep/);
  assert.match(kept, /id="keep-never"[^>]*> Understood, do not show this again/);
  assert.ok(kept.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').length < 520, 'short enough to read at a glance');

  const notKept = keepOpen.notice({ keepAwake: { on: false, held: false } });
  assert.match(notKept, /set it never to go to sleep/);
  assert.doesNotMatch(notKept, /The app stops the computer/);

  const bar = keepOpen.bar();
  assert.match(bar, /Keep this app open/);
  assert.match(bar, /id="keepbar-never"[^>]*> Don't remind me again/);
  assert.match(bar, /id="keepbar-close"/);
});
