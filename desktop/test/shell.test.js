'use strict';
/**
 * The window's two faces (shell.js): which view has the keys. A BaseWindow
 * does not give them to its views by itself, and on Windows a form in the app
 * took clicks but no typing after a tab had come and gone, or the window had
 * been away and come back.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const { EventEmitter } = require('node:events');

/** A pretend view: its contents say when they are focused. */
function view(name, log) {
  const wc = new EventEmitter();
  Object.assign(wc, { focus: () => log.push(name), isDestroyed: () => false, loadURL: async () => {},
    getURL: () => '', getTitle: () => '', isLoading: () => false, setWindowOpenHandler: () => {}, close: () => {},
    navigationHistory: { clear: () => {}, canGoBack: () => false, canGoForward: () => false } });
  return { name, webContents: wc, setBounds: () => {}, setVisible: () => {} };
}

function load(log) {
  let n = 0;
  const real = Module._load;
  Module._load = function (request, ...rest) {
    if (request === 'electron') {
      return { WebContentsView: function WebContentsView() { n += 1; return view(`tab${n}`, log); } };
    }
    return real.call(this, request, ...rest);
  };
  try {
    delete require.cache[require.resolve('../src/shell')];
    return require('../src/shell');
  } finally {
    Module._load = real;
  }
}

function world({ focused = true } = {}) {
  const log = [];
  const { Shell } = load(log);
  const win = new EventEmitter();
  Object.assign(win, { focused, getContentSize: () => [1200, 800], isFocused: () => win.focused,
    contentView: { addChildView: () => {}, removeChildView: () => {} } });
  const chrome = view('app', log);
  const shell = new Shell(win, { chromeView: chrome, homeUrl: 'about:blank' });
  return { shell, win, log };
}

test('the keys go to the face that is showing, as it changes', () => {
  const { shell, log } = world();
  const id = shell.open('https://example.org/');
  assert.equal(log.at(-1), 'tab1', 'a tab opened in front has them');
  shell.showApp();
  assert.equal(log.at(-1), 'app', 'back to the app');
  shell.select(id);
  shell.close(id);
  assert.equal(log.at(-1), 'app', 'the tab closed: the app has them, not a view that is gone');
});

test('a window focused again gives the keys back to what it shows', () => {
  const { shell, win, log } = world();
  win.emit('focus');
  assert.equal(log.at(-1), 'app');
  shell.open('https://example.org/');
  win.emit('focus');
  assert.equal(log.at(-1), 'tab1');
});

test('the app\'s page has the keys once it has loaded', () => {
  const { shell, log } = world();
  shell.chromeView.webContents.emit('did-finish-load');
  assert.deepEqual(log, ['app']);
  shell.open('https://example.org/');
  shell.chromeView.webContents.emit('did-finish-load');
  assert.equal(log.at(-1), 'tab1', 'not while a tab is the face showing');
});

test('a tab opened while the window is in the background does not take the focus', () => {
  const { shell, win, log } = world({ focused: false });
  shell.open('https://example.org/');
  assert.deepEqual(log, [], 'nothing focused behind another program');
  win.focused = true;
  win.emit('focus');
  assert.deepEqual(log, ['tab1']);
});
