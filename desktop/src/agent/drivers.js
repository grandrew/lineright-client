'use strict';
/**
 * A browser the AI oversight can work: the same few things a person does —
 * look, press, type, choose, scroll, wait, go back — on whichever browser the
 * page is in.
 *
 *   RobotDriver  the robot's own headless browser, mid-booking, over the robot
 *                process's channel (dmq/src/control.js): the page the robot
 *                was stuck on, taken over as it is
 *   TabDriver    a tab of this app (an Electron webContents): a page the person
 *                can watch, for a task the AI does from scratch
 *
 * Both take an element by the number the page reading gave it (pagekit.js).
 * Neither goes to another site: the robot refuses one itself, and a tab is
 * held to the site it was opened on here.
 */
const { READ_PAGE, refSelector, locateScript } = require('./pagekit');

/** What an element says, for the step log: its label or its text. Runs in the page. */
function labelScript() {
  return (function label(selector) {
    const el = document.querySelector(selector);
    if (!el) return null;
    const said = el.getAttribute('aria-label') || (el.labels && el.labels[0] && el.labels[0].innerText)
      || el.innerText || el.value || el.getAttribute('placeholder') || el.getAttribute('title') || el.tagName;
    return String(said).replace(/\s+/g, ' ').trim().slice(0, 80);
  }).toString();
}
const LABEL = labelScript();

function sameOrigin(url, base) {
  try {
    const to = new URL(url, base);
    return /^https?:$/.test(to.protocol) && to.origin === new URL(base).origin;
  } catch {
    return false;
  }
}

class RobotDriver {
  /**
   * @param {function} request (op, args) -> Promise of the value: one command to the robot's page
   */
  constructor(request) {
    this.request = request;
    this.kind = 'robot';
  }

  look(max) { return this.request('eval', { source: READ_PAGE, arg: { max } }); }

  label(ref) { return this.request('eval', { source: LABEL, arg: refSelector(ref) }).catch(() => null); }

  click(ref) { return this.request('click', { selector: refSelector(ref) }); }

  fill(ref, value) { return this.request('fill', { selector: refSelector(ref), value }); }

  choose(ref, option) { return this.request('select', { selector: refSelector(ref), value: option }); }

  check(ref, on) { return this.request('check', { selector: refSelector(ref), on }); }

  press(key) { return this.request('press', { key }); }

  scroll(down) { return this.request('scroll', { dy: down ? 600 : -600 }); }

  wait(ms) { return this.request('wait', { ms }); }

  back() { return this.request('back', {}); }

  open(url) { return this.request('goto', { url }); }

  text() { return this.request('text', {}); }
}

/** Electron's name for a key, from the names the tools use. */
const KEYS = { Enter: 'Enter', Escape: 'Escape', Tab: 'Tab', ArrowDown: 'Down', ArrowUp: 'Up', ArrowLeft: 'Left',
  ArrowRight: 'Right', Backspace: 'Backspace', Space: 'Space', PageDown: 'PageDown', PageUp: 'PageUp' };

class TabDriver {
  /**
   * @param {object} contents  the tab's webContents
   * @param {object} [opts]
   * @param {string} [opts.site] the address it may go about in (its origin); the page's own when not given
   */
  constructor(contents, { site = '', wait = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
    this.contents = contents;
    this.site = site;
    this.kind = 'tab';
    this.sleep = wait;
  }

  run(source, arg) {
    if (this.contents.isDestroyed()) return Promise.reject(new Error('the tab was closed'));
    return this.contents.executeJavaScript(`(${source})(${JSON.stringify(arg === undefined ? null : arg)})`, true);
  }

  async settle() {
    await this.sleep(400);
    const until = Date.now() + 10000;
    while (!this.contents.isDestroyed() && this.contents.isLoading() && Date.now() < until) await this.sleep(150);
    await this.sleep(300);
  }

  look(max) { return this.run(READ_PAGE, { max }); }

  label(ref) { return this.run(LABEL, refSelector(ref)).catch(() => null); }

  async at(ref) {
    const where = await this.run(locateScript(), refSelector(ref));
    if (!where) throw new Error(`[${ref}] is not on the page any more: take a new look`);
    return where;
  }

  async click(ref) {
    const where = await this.at(ref);
    if (where.disabled) throw new Error(`[${ref}] is disabled`);
    const x = Math.round(where.x);
    const y = Math.round(where.y);
    this.contents.sendInputEvent({ type: 'mouseMove', x, y });
    this.contents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
    this.contents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
    await this.settle();
    return { url: this.contents.getURL() };
  }

  async fill(ref, value) {
    await this.at(ref);
    const ok = await this.run((function focus(selector) {
      const el = document.querySelector(selector);
      if (!el) return false;
      el.focus();
      if (typeof el.select === 'function') el.select();
      return true;
    }).toString(), refSelector(ref));
    if (!ok) throw new Error(`[${ref}] is not on the page any more: take a new look`);
    // Typed as a person types, so the page's own scripts see it as they would.
    await this.contents.insertText(String(value));
    await this.run((function changed(selector) {
      const el = document.querySelector(selector);
      if (el) el.dispatchEvent(new Event('change', { bubbles: true }));
    }).toString(), refSelector(ref));
    return { ok: true };
  }

  async choose(ref, option) {
    const ok = await this.run((function choose(args) {
      const el = document.querySelector(args.selector);
      if (!el || el.tagName !== 'SELECT') return 'not a list to choose from';
      const want = String(args.option).trim().toLowerCase();
      const hit = Array.from(el.options).find((o) => (o.label || o.text).trim().toLowerCase() === want
        || o.value.toLowerCase() === want);
      if (!hit) return 'no such option';
      el.value = hit.value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return '';
    }).toString(), { selector: refSelector(ref), option });
    if (ok) throw new Error(ok);
    return { ok: true };
  }

  async check(ref, on) {
    const now = await this.run((function checked(selector) {
      const el = document.querySelector(selector);
      return el ? Boolean(el.checked || el.getAttribute('aria-checked') === 'true') : null;
    }).toString(), refSelector(ref));
    if (now === null) throw new Error(`[${ref}] is not on the page any more: take a new look`);
    if (now !== Boolean(on)) await this.click(ref);
    return { ok: true };
  }

  async press(key) {
    const name = KEYS[key] || (/^[A-Za-z0-9]$/.test(key) ? key : null);
    if (!name) throw new Error(`no key "${key}"`);
    this.contents.sendInputEvent({ type: 'keyDown', keyCode: name });
    if (name.length === 1 || name === 'Enter') this.contents.sendInputEvent({ type: 'char', keyCode: name === 'Enter' ? '\r' : name });
    this.contents.sendInputEvent({ type: 'keyUp', keyCode: name });
    await this.settle();
    return { url: this.contents.getURL() };
  }

  scroll(down) { return this.run((function scroll(dy) { window.scrollBy(0, dy); return true; }).toString(), down ? 600 : -600); }

  async wait(ms) {
    await this.sleep(Math.max(0, Math.min(15000, Number(ms) || 1000)));
    await this.settle();
    return { url: this.contents.getURL() };
  }

  async back() {
    const history = this.contents.navigationHistory;
    if (history && history.canGoBack()) history.goBack();
    else if (!history && this.contents.canGoBack()) this.contents.goBack();
    await this.settle();
    return { url: this.contents.getURL() };
  }

  async open(url) {
    const base = this.site || this.contents.getURL();
    if (!sameOrigin(url, base)) throw new Error('only pages of the same site');
    await this.contents.loadURL(new URL(url, base).toString());
    await this.settle();
    return { url: this.contents.getURL() };
  }

  text() { return this.run((function text() { return document.body ? document.body.innerText.slice(0, 200000) : ''; }).toString()); }
}

module.exports = { RobotDriver, TabDriver, sameOrigin, KEYS };
