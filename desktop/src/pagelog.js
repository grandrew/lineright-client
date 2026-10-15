'use strict';
/**
 * A page in one of the app's tabs, written down as it goes, into the logbook's
 * pages-<day>.jsonl (one record a line, each naming its tab) and pages/<day>/:
 *
 *   request / response / body / failed   every request the page makes, what
 *                    was sent (headers and body, for the site's documents and
 *                    data), the status and headers that came back, and the body
 *                    itself for the site's data — documents whole, as files
 *   navigated / loaded / load-failed     where the tab went, and how it went
 *   action           what was clicked, changed, submitted or entered: the
 *                    element (tag, id, name, label, text, where in the page) and,
 *                    for a field that is not personal, its value
 *   snapshot         the page as it stood after each step, as a file
 *   console / crashed                    what the page said, and if it died
 *   autofill / confirmation / card       what the app did on it (main.js)
 *
 * The network is watched from outside the page, through the DevTools protocol
 * on the tab (webContents.debugger): the site sees nothing of it. Clicks and
 * changes are noted, and copies of the page taken, by a script in a world of
 * its own (an isolated world: the page's scripts cannot see it, nor it them),
 * which says what it saw in the console.
 *
 * A value someone typed is kept only for a field that is not personal — the
 * office searched for, a date or a time picked; a name, an email, a phone or a
 * licence number is kept as its length, and copies of the page show those
 * fields' values the same way. Secrets go nowhere (logbook.js, redact).
 */
const crypto = require('node:crypto');
const { redactUrl, redactBody, redactHeaders, clip } = require('./logbook');

/** The isolated world the recorder runs in. */
const WORLD = 1717;
/** How the recorder's console lines are told from the page's own. */
const MARK = '__lineright_trace__';
/** Request types whose headers and bodies are kept. */
const DATA = new Set(['Document', 'XHR', 'Fetch']);
const TEXTUAL = /json|html|text|xml|javascript/i;
/** How long a page is let settle after a step before it is copied. */
const SETTLE_MS = 1500;
/** Requests remembered while their answers are awaited, at most. */
const PENDING = 2000;

// What counts as personal in a field: its value is kept as a length only.
const PERSONAL_SRC = 'name|mail|phone|tel|addr|street|city|zip|postal|birth|dob|ssn|social|licen|permit|dl.?num|pass|card|cvv|account|secur';

/** Runs in the page's isolated world: notes clicks, changes, submits and Enter. */
const RECORDER = `(() => {
  if (window.__lineRightRecorder) return 'there';
  window.__lineRightRecorder = true;
  const PERSONAL = new RegExp(${JSON.stringify(PERSONAL_SRC)}, 'i');
  const say = (o) => console.debug(${JSON.stringify(MARK)} + JSON.stringify(o));
  const text = (el) => String((el && (el.innerText || el.textContent)) || '').replace(/\\s+/g, ' ').trim().slice(0, 80);
  const labelOf = (el) => {
    if (!el || !el.getAttribute) return '';
    if (el.getAttribute('aria-label')) return el.getAttribute('aria-label');
    if (el.id) { const l = document.querySelector('label[for="' + CSS.escape(el.id) + '"]'); if (l) return text(l); }
    const l = el.closest && el.closest('label');
    return l ? text(l) : '';
  };
  const where = (el) => {
    const parts = [];
    for (let n = el, i = 0; n && n.nodeType === 1 && i < 6; n = n.parentElement, i += 1) {
      let p = n.tagName.toLowerCase();
      if (n.id) { parts.unshift(p + '#' + n.id); break; }
      const cls = [...n.classList].slice(0, 2).join('.');
      if (cls) p += '.' + cls;
      parts.unshift(p);
    }
    return parts.join(' > ');
  };
  const describe = (el) => (el && el.nodeType === 1 ? {
    tag: el.tagName.toLowerCase(), id: el.id || undefined, name: el.getAttribute('name') || undefined,
    type: el.getAttribute('type') || undefined, role: el.getAttribute('role') || undefined,
    label: labelOf(el) || undefined, text: text(el) || undefined, href: el.getAttribute('href') || undefined,
    path: where(el),
  } : null);
  const personal = (el) => {
    const t = String(el.type || '').toLowerCase();
    return t === 'password' || t === 'email' || t === 'tel'
      || PERSONAL.test([el.name, el.id, el.getAttribute && el.getAttribute('autocomplete'), labelOf(el)].join(' '));
  };
  const valueOf = (el) => {
    if (!el || !el.tagName) return {};
    if (el.tagName === 'SELECT') return { chosen: [...el.selectedOptions].map(text).join(', ') };
    if (el.type === 'checkbox' || el.type === 'radio') return { checked: el.checked };
    if (!('value' in el)) return {};
    return personal(el) ? { length: String(el.value).length } : { value: String(el.value).slice(0, 200) };
  };
  const target = (e) => (e.target && e.target.closest && e.target.closest(
    'a,button,input,select,textarea,label,summary,[role=button],[role=link],[role=option],[role=tab],[onclick]')) || e.target;
  addEventListener('click', (e) => say({ action: 'click', target: describe(target(e)) }), true);
  addEventListener('change', (e) => say({ action: 'change', target: describe(e.target), ...valueOf(e.target) }), true);
  addEventListener('submit', (e) => say({ action: 'submit', target: describe(e.target) }), true);
  addEventListener('keydown', (e) => { if (e.key === 'Enter') say({ action: 'enter', target: describe(e.target), ...valueOf(e.target) }); }, true);
  return 'installed';
})()`;

/** Runs in the page's isolated world: the page as it stands, personal values struck out. */
const SNAPSHOT = `(() => {
  const PERSONAL = new RegExp(${JSON.stringify(PERSONAL_SRC)}, 'i');
  const SECRET = /token|captcha|csrf|xsrf|session|auth|nonce|pass/i;
  const live = [...document.querySelectorAll('input,textarea,select')];
  const root = document.documentElement.cloneNode(true);
  const copies = [...root.querySelectorAll('input,textarea,select')];
  live.forEach((el, i) => {
    const c = copies[i];
    if (!c || c.tagName !== el.tagName) return;
    const ident = [el.name, el.id, el.getAttribute('autocomplete'), el.getAttribute('aria-label')].join(' ');
    const t = String(el.type || '').toLowerCase();
    if (el.tagName === 'SELECT') {
      [...c.options].forEach((o, j) => { if (el.options[j] && el.options[j].selected) o.setAttribute('selected', ''); else o.removeAttribute('selected'); });
      return;
    }
    if (t === 'checkbox' || t === 'radio') { if (el.checked) c.setAttribute('checked', ''); else c.removeAttribute('checked'); return; }
    const value = String(el.value || '');
    const hide = SECRET.test(ident) || t === 'password' || t === 'email' || t === 'tel' || PERSONAL.test(ident);
    const shown = hide && value ? '‹' + value.length + ' chars›' : value;
    if (el.tagName === 'TEXTAREA') c.textContent = shown; else c.setAttribute('value', shown);
  });
  return '<!doctype html>\\n' + root.outerHTML;
})()`;

/**
 * Start writing down the page in `tab` (shell.js's: {id, kind, jobId, view}).
 * Returns `{ note(type, fields), stop() }`: `note` puts what the app did on the
 * page among the rest. Stops by itself when the tab goes.
 */
function watchTab(tab, { logbook, setTimeout: st = setTimeout, clearTimeout: ct = clearTimeout } = {}) {
  const wc = tab.view.webContents;
  const rec = (type, fields = {}) => logbook.event('pages', { tab: tab.id, kind: tab.kind, job: tab.jobId || undefined, type, ...fields });
  const pending = new Map();   // requestId -> { rtype, url, mime, keep }
  let stopped = false;
  let snapTimer = null;
  let lastHash = '';
  let docs = 0;
  let pages = 0;
  let unread = null;           // a document whose body the network had not kept: read once it has loaded

  const remember = (id, value) => {
    pending.set(id, value);
    if (pending.size > PENDING) pending.delete(pending.keys().next().value);
  };

  // -- the network, from outside the page
  const dbg = wc.debugger;
  let attached = false;
  try {
    dbg.attach('1.3');
    attached = true;
  } catch (err) {
    rec('network-off', { why: err.message });
  }
  const onMessage = (_event, method, p = {}) => {
    if (stopped) return;
    if (method === 'Network.requestWillBeSent') {
      const r = p.request || {};
      const rtype = p.type || 'Other';
      remember(p.requestId, { rtype, url: r.url });
      const record = { id: p.requestId, method: r.method, url: redactUrl(r.url), rtype };
      if (p.redirectResponse) record.redirectedFrom = { status: p.redirectResponse.status, url: redactUrl(p.redirectResponse.url) };
      if (DATA.has(rtype)) {
        const headers = r.headers || {};
        record.headers = redactHeaders(headers);
        if (r.postData) record.postData = redactBody(r.postData, headers['Content-Type'] || headers['content-type'] || '');
        else if (r.hasPostData) record.postData = '‹too long to keep›';
      }
      rec('request', record);
    } else if (method === 'Network.responseReceived') {
      const res = p.response || {};
      const known = pending.get(p.requestId) || {};
      const rtype = p.type || known.rtype;
      const record = { id: p.requestId, status: res.status, url: redactUrl(res.url), rtype, mime: res.mimeType,
        ip: res.remoteIPAddress || undefined, cached: res.fromDiskCache || undefined };
      if (DATA.has(rtype)) record.headers = redactHeaders(res.headers);
      rec('response', record);
      if (DATA.has(rtype) && TEXTUAL.test(res.mimeType || '')) remember(p.requestId, { rtype, url: res.url, mime: res.mimeType, keep: true });
    } else if (method === 'Network.loadingFinished') {
      const known = pending.get(p.requestId);
      pending.delete(p.requestId);
      if (!known || !known.keep) return;
      dbg.sendCommand('Network.getResponseBody', { requestId: p.requestId })
        .then(({ body, base64Encoded }) => kept(p.requestId, known, body, base64Encoded))
        .catch((err) => {
          // A page's first document can come before the network was being
          // kept: it is read from the page itself once it has loaded.
          if (known.rtype !== 'Document') return rec('body', { id: p.requestId, error: err.message });
          unread = { id: p.requestId, known };
          // Loaded already (the answer can come after the page has): read it now.
          if (!wc.isDestroyed() && !wc.isLoading()) readUnread();
          return null;
        });
    } else if (method === 'Network.loadingFailed') {
      const known = pending.get(p.requestId) || {};
      pending.delete(p.requestId);
      rec('failed', { id: p.requestId, url: known.url ? redactUrl(known.url) : undefined, rtype: p.type,
        error: p.errorText, canceled: p.canceled || undefined, blocked: p.blockedReason || undefined });
    }
  };
  function kept(id, known, body, base64Encoded) {
    if (base64Encoded) return rec('body', { id, bytes: String(body).length, binary: true });
    if (known.rtype === 'Document') {
      const file = logbook.keep(['pages', logbook.day()], `tab${tab.id}-doc${++docs}.html`,
        `<!-- ${redactUrl(known.url)} -->\n${body}`);
      return rec('body', { id, file, bytes: String(body).length });
    }
    return rec('body', { id, body: redactBody(body, known.mime) });
  }
  // The document the network had not kept, from the page's own resources.
  const readUnread = async () => {
    const doc = unread;
    unread = null;
    if (!doc || stopped || !attached) return;
    try {
      const { frameTree } = await dbg.sendCommand('Page.getFrameTree');
      const { content, base64Encoded } = await dbg.sendCommand('Page.getResourceContent',
        { frameId: frameTree.frame.id, url: doc.known.url });
      kept(doc.id, doc.known, content, base64Encoded);
    } catch (err) {
      rec('body', { id: doc.id, error: err.message });
    }
  };
  if (attached) {
    dbg.on('message', onMessage);
    dbg.on('detach', (_event, reason) => {
      // Closing the tab detaches it too; only any other reason is news.
      if (!stopped && !/target.?closed/i.test(String(reason))) rec('network-off', { why: `detached: ${reason}` });
    });
    dbg.sendCommand('Network.enable', { maxPostDataSize: 65536 }).catch((err) => rec('network-off', { why: err.message }));
    dbg.sendCommand('Page.enable').catch(() => {});
  }

  // -- the page, from its own world
  const snapshot = async () => {
    snapTimer = null;
    if (stopped || wc.isDestroyed()) return;
    let html;
    try {
      html = await wc.executeJavaScriptInIsolatedWorld(WORLD, [{ code: SNAPSHOT }]);
    } catch (err) {
      rec('snapshot', { error: err.message });
      return;
    }
    if (stopped || typeof html !== 'string') return;
    const url = wc.isDestroyed() ? '' : redactUrl(wc.getURL());
    const hash = crypto.createHash('sha1').update(html).digest('hex').slice(0, 12);
    if (hash === lastHash) return;
    lastHash = hash;
    const file = logbook.keep(['pages', logbook.day()], `tab${tab.id}-page${++pages}.html`, `<!-- ${url} -->\n${html}`);
    rec('snapshot', { url, file, bytes: html.length, hash });
  };
  const soon = () => {
    if (stopped) return;
    if (snapTimer) ct(snapTimer);
    snapTimer = st(snapshot, SETTLE_MS);
  };
  const install = () => {
    if (stopped || wc.isDestroyed()) return;
    wc.executeJavaScriptInIsolatedWorld(WORLD, [{ code: RECORDER }]).catch((err) => rec('recorder', { error: err.message }));
  };

  const handlers = [];
  const on = (event, fn) => { wc.on(event, fn); handlers.push([event, fn]); };
  on('did-start-navigation', (e, url, inPlace, mainFrame) => {
    const main = e && typeof e.isMainFrame === 'boolean' ? e.isMainFrame : mainFrame;
    const same = e && typeof e.isSameDocument === 'boolean' ? e.isSameDocument : inPlace;
    if (main && !same) rec('navigating', { url: redactUrl((e && e.url) || url) });
  });
  on('did-navigate', (_e, url, status, statusText) => {
    rec('navigated', { url: redactUrl(url), status, statusText: statusText || undefined });
    soon();
  });
  on('did-navigate-in-page', (_e, url, mainFrame) => {
    if (mainFrame === false) return;
    rec('navigated', { url: redactUrl(url), inPage: true });
    soon();
  });
  on('did-finish-load', () => {
    rec('loaded', { url: redactUrl(wc.getURL()), title: wc.getTitle() });
    install();
    readUnread();
    soon();
  });
  on('did-fail-load', (_e, code, description, url, mainFrame) => {
    if (mainFrame === false || code === -3) return;   // -3: replaced by another load, not a failure
    rec('load-failed', { url: redactUrl(url), code, error: description });
  });
  on('console-message', (e, level, message, line, sourceId) => {
    const d = e && typeof e.message === 'string' ? e : { level, message, lineNumber: line, sourceId };
    const text = String(d.message || '');
    if (text.startsWith(MARK)) {
      let action;
      try { action = JSON.parse(text.slice(MARK.length)); } catch { return; }
      rec('action', action);
      soon();
      return;
    }
    rec('console', { level: d.level, text: clip(text, 4000), source: d.sourceId ? redactUrl(d.sourceId) : undefined,
      line: d.lineNumber || undefined });
  });
  on('render-process-gone', (_e, details = {}) => rec('crashed', { reason: details.reason, code: details.exitCode }));
  on('unresponsive', () => rec('unresponsive'));
  on('responsive', () => rec('responsive'));
  // Gone: nothing more is asked of it (see main.js, send(): a closed page is not to be touched).
  wc.once('destroyed', () => {
    stopped = true;
    if (snapTimer) ct(snapTimer);
    rec('closed');
  });

  rec('opened', { url: redactUrl(tab.url), network: attached });
  return {
    note(type, fields = {}) { if (!stopped) rec(type, fields); },
    stop() {
      if (stopped) return;
      stopped = true;
      if (snapTimer) ct(snapTimer);
      if (wc.isDestroyed()) return;
      for (const [event, fn] of handlers) wc.removeListener(event, fn);
      if (attached) { try { dbg.removeListener('message', onMessage); dbg.detach(); } catch { /* gone */ } }
    },
  };
}

module.exports = { watchTab, RECORDER, SNAPSHOT, MARK, WORLD };
