'use strict';
/**
 * Reading a web page the way the AI oversight needs it: as short text, in the
 * order a person reads it, with every control they could use numbered.
 *
 *   # Your details
 *   This appointment is held for you for 9:41.
 *   [3] textbox "Given name" value="[first_name]" required
 *   [4] textbox "Family name" required
 *   [5] button "Review my details"
 *   [6] link "Start again" -> /portal/appointments/
 *
 * The numbers are written onto the page's own elements (`data-lr-ref`), so an
 * action names one — "press [5]" — and the robot's browser or the app's tab
 * finds it again by `[data-lr-ref="5"]` (drivers.js). An element keeps its
 * number while it is on the page; one drawn anew gets a new one.
 *
 * `readPage` runs inside the page, so it is one self-contained function: it is
 * sent there as its source (READ_PAGE) and nothing outside it is in reach.
 * What it returns is the page as the page has it — values typed into the form
 * included — and is scrubbed of the person (scrub.js) before it goes anywhere.
 */

/* eslint-disable no-restricted-globals */
function readPage(opts) {
  const max = (opts && opts.max) || 14000;
  const lines = [];
  const kinds = [];               // per line: 'control' | 'heading' | 'alert' | 'text'
  let text = [];
  let heading = 0;
  // Text a control already says as its name — its label's, a clickable's own — is not said twice.
  let mute = 0;
  let refs = 0;
  const seq = () => {
    window.__lrSeq = (window.__lrSeq || 0) + 1;
    return window.__lrSeq;
  };
  const tidy = (s, n) => {
    const t = String(s || '').replace(/\s+/g, ' ').trim();
    return n && t.length > n ? `${t.slice(0, n - 1)}…` : t;
  };
  const quote = (s) => JSON.stringify(tidy(s, 120));
  const emit = (line, kind) => { lines.push(line); kinds.push(kind); };
  const flush = () => {
    // Apart: two elements side by side are two words, however their styles lay
    // them out ("Name" "Ada", not "NameAda"); punctuation keeps to its word.
    const t = tidy(text.join(' ').replace(/\s+([.,;:!?)])/g, '$1').replace(/([(])\s+/g, '$1'), 400);
    text = [];
    if (!t) return;
    if (heading) emit(`${'#'.repeat(Math.min(heading, 3))} ${t}`, 'heading');
    else emit(t, 'text');
  };
  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'CANVAS', 'HEAD', 'META', 'LINK']);
  const BLOCK = /^(ADDRESS|ARTICLE|ASIDE|BLOCKQUOTE|DD|DIALOG|DIV|DL|DT|FIELDSET|FIGCAPTION|FIGURE|FOOTER|FORM|H[1-6]|HEADER|HR|LEGEND|LI|MAIN|NAV|OL|P|PRE|SECTION|TABLE|TBODY|TD|TH|THEAD|TR|UL|BR)$/;
  const ROLES = /^(button|link|checkbox|radio|switch|tab|menuitem|menuitemcheckbox|menuitemradio|option|combobox|textbox|searchbox|spinbutton|slider|listbox|gridcell|treeitem)$/;
  const visible = (el) => {
    if (el.hidden || el.getAttribute('aria-hidden') === 'true') return false;
    if (typeof el.checkVisibility === 'function') {
      return el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
    }
    const style = getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden' && el.getClientRects().length > 0;
  };
  const roleOf = (el) => {
    const role = (el.getAttribute('role') || '').toLowerCase();
    if (role && ROLES.test(role)) return role;
    const tag = el.tagName;
    if (tag === 'A' && el.hasAttribute('href')) return 'link';
    if (tag === 'BUTTON' || tag === 'SUMMARY') return 'button';
    if (tag === 'SELECT') return el.multiple ? 'listbox' : 'select';
    if (tag === 'TEXTAREA') return 'textbox';
    if (tag === 'INPUT') {
      const type = (el.getAttribute('type') || 'text').toLowerCase();
      if (type === 'hidden') return '';
      if (['button', 'submit', 'reset', 'image'].includes(type)) return 'button';
      if (type === 'checkbox' || type === 'radio') return type;
      if (type === 'range') return 'slider';
      if (type === 'file') return 'file';
      return type === 'text' ? 'textbox' : `textbox:${type}`;
    }
    if (el.hasAttribute('onclick') || (el.tabIndex >= 0 && el.hasAttribute('tabindex'))) return 'clickable';
    return '';
  };
  const nameOf = (el) => {
    const aria = el.getAttribute('aria-label');
    if (aria && aria.trim()) return aria;
    const by = el.getAttribute('aria-labelledby');
    if (by) {
      const said = by.split(/\s+/).map((id) => {
        const it = document.getElementById(id);
        return it ? it.innerText || it.textContent : '';
      }).join(' ');
      if (said.trim()) return said;
    }
    if (el.labels && el.labels.length) {
      const said = Array.from(el.labels).map((l) => l.innerText || l.textContent).join(' ');
      if (said.trim()) return said;
    }
    if (el.tagName === 'INPUT' && ['button', 'submit', 'reset'].includes((el.type || '').toLowerCase())) return el.value;
    if (!['INPUT', 'SELECT', 'TEXTAREA'].includes(el.tagName)) {
      const own = el.innerText || el.textContent || '';
      if (own.trim()) return own;
    }
    return el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('alt')
      || (el.querySelector && el.querySelector('img[alt]') ? el.querySelector('img[alt]').alt : '')
      || el.getAttribute('name') || '';
  };
  const describe = (el, role) => {
    let ref = el.getAttribute('data-lr-ref');
    if (!ref) {
      ref = String(seq());
      el.setAttribute('data-lr-ref', ref);
    }
    refs += 1;
    const bits = [`[${ref}] ${role.replace(/^textbox:/, 'textbox ')} ${quote(nameOf(el))}`];
    if (el.tagName === 'SELECT') {
      const chosen = el.selectedOptions && el.selectedOptions[0];
      if (chosen) bits.push(`value=${quote(chosen.label || chosen.text)}`);
      const options = Array.from(el.options).slice(0, 40).map((o) => tidy(o.label || o.text, 50)).filter(Boolean);
      if (options.length) bits.push(`options: ${options.join(' | ')}${el.options.length > 40 ? ' | …' : ''}`);
    } else if (/^textbox/.test(role) || role === 'slider') {
      const type = (el.getAttribute('type') || '').toLowerCase();
      if (type === 'password') bits.push(el.value ? 'value=(hidden)' : 'empty');
      else if (el.value) bits.push(`value=${quote(el.value)}`);
      else bits.push('empty');
    }
    if (role === 'checkbox' || role === 'radio' || role === 'switch') {
      const on = el.checked !== undefined ? el.checked : el.getAttribute('aria-checked') === 'true';
      bits.push(on ? 'checked' : 'not checked');
    }
    if (el.getAttribute('aria-pressed') === 'true' || el.getAttribute('aria-selected') === 'true') bits.push('selected');
    if (el.getAttribute('aria-expanded')) bits.push(el.getAttribute('aria-expanded') === 'true' ? 'expanded' : 'collapsed');
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') bits.push('disabled');
    if (el.required || el.getAttribute('aria-required') === 'true') bits.push('required');
    if (el.getAttribute('aria-invalid') === 'true') bits.push('invalid');
    if (role === 'link') {
      try {
        const u = new URL(el.getAttribute('href'), location.href);
        if (u.origin === location.origin) bits.push(`-> ${u.pathname}${u.search ? '?…' : ''}`);
        else if (/^https?:$/.test(u.protocol)) bits.push(`-> ${u.host}`);
      } catch (e) { /* not an address */ }
    }
    return bits.join(' ');
  };
  const walk = (node) => {
    if (node.nodeType === 3) {
      if (!mute) text.push(node.nodeValue);
      return;
    }
    if (node.nodeType !== 1) return;
    const el = node;
    if (SKIP.has(el.tagName.toUpperCase())) return;
    if (el.tagName === 'IFRAME') {
      const src = el.getAttribute('src') || '';
      const captcha = /recaptcha|hcaptcha|turnstile|captcha/i.test(src);
      // An invisible captcha sits on many pages and asks nothing of anybody
      // until it shows a challenge: only one showing, big enough to answer, is a human check.
      const r = el.getBoundingClientRect();
      const showing = visible(el) && r.width >= 60 && r.height >= 60;
      if (captcha && showing) {
        flush();
        emit('[a human check (captcha) is showing on this page: it is for the person to answer]', 'alert');
      } else if (captcha && !window.__lrSaidCaptcha) {
        window.__lrSaidCaptcha = true;
      } else if (!captcha && visible(el)) {
        flush();
        emit(`[frame${el.title ? ` ${quote(el.title)}` : ''}]`, 'alert');
      }
      return;
    }
    if (!visible(el)) return;
    const role = roleOf(el);
    const block = BLOCK.test(el.tagName);
    const alerting = /^(alert|alertdialog|status)$/.test(el.getAttribute('role') || '') || el.getAttribute('aria-live') === 'assertive';
    const dialog = el.tagName === 'DIALOG' || /^(dialog|alertdialog)$/.test(el.getAttribute('role') || '');
    if (role) {
      flush();
      emit(describe(el, role), 'control');
      // A control's inside is its name; but a list, or something clickable, may hold more controls.
      if (el.tagName === 'SELECT' || !/^(listbox|clickable)$/.test(role)) return;
    }
    const muting = Boolean(role) || (el.tagName === 'LABEL' && el.control && visible(el.control));
    if (muting) mute += 1;
    const level = /^H([1-6])$/.exec(el.tagName);
    if (block || level || alerting || dialog) flush();
    if (dialog) emit(`[dialog${el.getAttribute('aria-label') ? ` ${quote(el.getAttribute('aria-label'))}` : ''}]`, 'alert');
    const outer = heading;
    if (level) heading = Number(level[1]);
    const before = lines.length;
    for (const child of Array.from(el.childNodes)) walk(child);
    if (el.shadowRoot) for (const child of Array.from(el.shadowRoot.childNodes)) walk(child);
    if (block || level || alerting || dialog) flush();
    if (alerting && lines.length > before) kinds[before] = 'alert';
    if (alerting && lines.length > before) lines[before] = `! ${lines[before]}`;
    if (dialog) emit('[end of dialog]', 'alert');
    if (muting) mute -= 1;
    heading = outer;
  };
  walk(document.body || document.documentElement);
  flush();

  // Too long: the controls, headings and warnings stay; plain text goes from the end.
  let size = lines.reduce((n, l) => n + l.length + 1, 0);
  let dropped = 0;
  for (let i = lines.length - 1; i >= 0 && size > max; i -= 1) {
    if (kinds[i] !== 'text') continue;
    size -= lines[i].length + 1;
    lines[i] = null;
    dropped += 1;
  }
  let out = lines.filter((l) => l !== null).join('\n');
  if (out.length > max) out = `${out.slice(0, max)}\n… (the page goes on)`;
  if (dropped) out += `\n(${dropped} lines of plain text left out to keep this short)`;
  return {
    url: location.href, title: document.title, text: out, controls: refs,
    scrolled: Math.round(window.scrollY), height: Math.round(document.documentElement.scrollHeight),
    viewport: Math.round(window.innerHeight),
  };
}

/** The reading script, as the source a browser runs. */
const READ_PAGE = readPage.toString();

/** The selector that finds a numbered element again. */
function refSelector(ref) {
  const n = Number(ref);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`"${ref}" is not one of the numbers on the page`);
  return `[data-lr-ref="${n}"]`;
}

/** Where an element is, for a click by mouse (the app's tabs): scrolled into view first. */
function locateScript() {
  return (function locate(selector) {
    const el = document.querySelector(selector);
    if (!el) return null;
    el.scrollIntoView({ block: 'center', inline: 'center' });
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height,
      tag: el.tagName, disabled: Boolean(el.disabled) };
  }).toString();
}

module.exports = { readPage, READ_PAGE, refSelector, locateScript };
