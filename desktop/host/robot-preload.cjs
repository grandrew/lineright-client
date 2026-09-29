'use strict';
/**
 * Loaded into the DMV robots on Windows, ahead of their own code
 * (NODE_OPTIONS=--require, set by src/stack.js).
 *
 * The robots run on the app's own executable, which Windows starts with no
 * console: it is a windowed program. The browser they drive is a console
 * program, and Windows gives a console program whose parent has no console one
 * of its own — a black window, opened and closed on the person's screen every
 * time a robot looks for a slot. Playwright starts the browser without asking
 * for that window to be hidden, so this asks on its behalf: every process the
 * robots start is started hidden, unless the caller said otherwise.
 *
 * Elsewhere there is no such window and this does nothing.
 */
// The options object goes after the command and its arguments and before any
// callback; one is added where there is none.
function hidden(args) {
  const out = [...args];
  for (let i = 1; i < out.length; i += 1) {
    const arg = out[i];
    if (arg && typeof arg === 'object' && !Array.isArray(arg)) {
      if (arg.windowsHide === undefined) out[i] = { ...arg, windowsHide: true };
      return out;
    }
    if (typeof arg === 'function') {
      out.splice(i, 0, { windowsHide: true });
      return out;
    }
  }
  out.push({ windowsHide: true });
  return out;
}

function hideWindows(childProcess = require('node:child_process')) {
  for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync']) {
    const original = childProcess[name];
    childProcess[name] = function withWindowsHidden(...args) {
      return original.apply(this, hidden(args));
    };
  }
}

if (process.platform === 'win32') hideWindows();

module.exports = { hidden, hideWindows };
