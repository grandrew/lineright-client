'use strict';
/**
 * Typing the person's own details into a booking page the app opened.
 *
 * A booking form asks the same handful of things everywhere — first name,
 * last name, date of birth, licence number, email, phone — and labels them
 * in the same handful of ways. This module matches a page's inputs to the
 * profile by what the field *says it is*: its autocomplete token, its label,
 * its aria-label, its placeholder, and only then its name or id. Nothing is
 * matched by position.
 *
 * It only runs on pages the app itself opened for booking (the origin of a
 * hand-off's page, or a site's booking portal), never on an arbitrary tab —
 * a Social Security number is not something to type wherever a form asks.
 * Even there, a field already holding text is left alone unless the person
 * clicked "Fill form" themselves.
 *
 * Two halves: RULES and matchKey() run here, in tests; pageFill() is
 * stringified and run inside the page with the same rules handed to it.
 */

// Order matters where two rules could both match ("first name" and "name"):
// the more specific rule comes first.
const RULES = [
  { key: 'first_name', autocomplete: ['given-name'], label: 'first\\s*name|given\\s*name|forename', attr: '^(first|fname|firstname|given[_-]?name|first[_-]?name)$' },
  { key: 'middle_name', autocomplete: ['additional-name'], label: 'middle\\s*(name|initial)', attr: '^(middle|mname|middle[_-]?name)$' },
  { key: 'last_name', autocomplete: ['family-name'], label: 'last\\s*name|surname|family\\s*name', attr: '^(last|lname|lastname|surname|family[_-]?name|last[_-]?name)$' },
  { key: 'full_name', autocomplete: ['name'], label: '^(full\\s*)?name$|full\\s*name|name\\s+(as|on|of)\\b|licen[cs]e\\s*holder|patient\\s*name|party\\s*leader|applicant\\s*name', attr: '^(name|fullname|full[_-]?name)$' },
  { key: 'dob', autocomplete: ['bday'], label: 'date\\s*of\\s*birth|birth\\s*date|birthday|\\bdob\\b', attr: '^(dob|birthdate|birth[_-]?date|date[_-]?of[_-]?birth)$' },
  { key: 'ssn', autocomplete: [], label: 'social\\s*security|\\bssn\\b', attr: '^(ssn|social[_-]?security(?:[_-]?number)?)$' },
  { key: 'dl_number', autocomplete: [], label: "driver'?s?\\s*licen[cs]e|permit\\s*number|licen[cs]e\\s*(or\\s*permit\\s*)?(number|no\\b|#)|\\bdl\\s*(number|no\\b|#)", attr: '^(dl|dln|dl[_-]?number|license[_-]?number|licence[_-]?number|driverlicense|drivers[_-]?license)$' },
  { key: 'passport', autocomplete: [], label: 'passport\\s*(number|no\\b|#)?', attr: '^(passport|passport[_-]?(number|no))$' },
  { key: 'email', autocomplete: ['email'], type: 'email', label: 'e-?mail', attr: '^(email|e[_-]?mail|email[_-]?address)$' },
  { key: 'phone', autocomplete: ['tel', 'tel-national'], type: 'tel', label: 'phone|mobile|telephone|cell', attr: '^(phone|tel|telephone|mobile|phone[_-]?number|mobile[_-]?number|cell)$' },
  { key: 'street', autocomplete: ['street-address', 'address-line1'], label: 'street|address\\s*(line\\s*1)?$|^address\\b', attr: '^(street|address|address1|address[_-]?line[_-]?1|street[_-]?address)$' },
  { key: 'city', autocomplete: ['address-level2'], label: '\\bcity\\b|\\btown\\b', attr: '^(city|town|locality)$' },
  { key: 'state', autocomplete: ['address-level1'], label: '^state$|\\bstate\\b(?!ment)|province', attr: '^(state|province|region)$' },
  { key: 'zip', autocomplete: ['postal-code'], label: '\\bzip\\b|postal\\s*code|postcode', attr: '^(zip|zipcode|zip[_-]?code|postal|postal[_-]?code|postcode)$' },
];

/**
 * Which profile key a field is, from how the page describes it.
 * @param {{autocomplete?:string,type?:string,label?:string,attr?:string}} d
 */
function matchKey(d, rules = RULES) {
  const auto = String((d && d.autocomplete) || '').trim().toLowerCase();
  if (auto && auto !== 'off' && auto !== 'on') {
    for (const r of rules) if (r.autocomplete.includes(auto)) return r.key;
  }
  const type = String((d && d.type) || '').toLowerCase();
  const label = String((d && d.label) || '').trim();
  const attr = String((d && d.attr) || '').trim();
  for (const r of rules) {
    if (label && new RegExp(r.label, 'i').test(label)) return r.key;
  }
  for (const r of rules) {
    if (r.type && r.type === type) return r.key;
  }
  for (const r of rules) {
    if (attr && new RegExp(r.attr, 'i').test(attr)) return r.key;
  }
  return null;
}

/**
 * Runs INSIDE the page. Self-contained: no closures over this module.
 * Returns {filled, skipped, fields:[{key, how}]}.
 */
function pageFill(values, rules, options) {
  const force = Boolean(options && options.force);
  const seen = new Set();
  const out = { filled: 0, skipped: 0, fields: [] };

  function textOf(node) { return (node && (node.innerText || node.textContent) || '').replace(/\s+/g, ' ').trim(); }
  function labelFor(input) {
    const parts = [];
    if (input.getAttribute('aria-label')) parts.push(input.getAttribute('aria-label'));
    const by = input.getAttribute('aria-labelledby');
    if (by) for (const id of by.split(/\s+/)) { const el = document.getElementById(id); if (el) parts.push(textOf(el)); }
    if (input.id) for (const l of document.querySelectorAll('label[for]')) { if (l.htmlFor === input.id) parts.push(textOf(l)); }
    const wrap = input.closest('label'); if (wrap) parts.push(textOf(wrap));
    if (input.placeholder) parts.push(input.placeholder);
    if (input.title) parts.push(input.title);
    return parts.filter(Boolean).join(' | ');
  }
  function match(d) {
    const auto = String(d.autocomplete || '').trim().toLowerCase();
    if (auto && auto !== 'off' && auto !== 'on') { for (const r of rules) if (r.autocomplete.includes(auto)) return r.key; }
    for (const r of rules) if (d.label && new RegExp(r.label, 'i').test(d.label)) return r.key;
    for (const r of rules) if (r.type && r.type === d.type) return r.key;
    for (const r of rules) if (d.attr && new RegExp(r.attr, 'i').test(d.attr)) return r.key;
    return null;
  }
  function setValue(input, value) {
    const proto = input.tagName === 'SELECT' ? HTMLSelectElement.prototype : (input.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype);
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) desc.set.call(input, value); else input.value = value;
    for (const type of ['input', 'change']) input.dispatchEvent(new Event(type, { bubbles: true }));
  }
  function forDate(input, value) {
    if (input.type === 'date') {
      const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value);
      return m ? `${m[3]}-${m[1]}-${m[2]}` : value;
    }
    return value;
  }

  const inputs = document.querySelectorAll('input, textarea, select');
  for (const input of inputs) {
    const type = (input.type || 'text').toLowerCase();
    if (['hidden', 'submit', 'button', 'checkbox', 'radio', 'file', 'password', 'search', 'range', 'color'].includes(type)) continue;
    if (input.disabled || input.readOnly) continue;
    const d = { autocomplete: input.getAttribute('autocomplete') || '', type, label: labelFor(input), attr: [input.name, input.id].filter(Boolean).join(' ') };
    let key = null;
    for (const attr of (d.attr ? d.attr.split(' ') : [''])) { key = match({ ...d, attr }); if (key) break; }
    if (!key || seen.has(key)) continue;
    let value = values[key];
    if (!value) continue;
    if (input.value && !force) { out.skipped += 1; continue; }
    if (input.tagName === 'SELECT') {
      const want = String(value).toLowerCase();
      const opt = [...input.options].find((o) => o.value.toLowerCase() === want || o.text.trim().toLowerCase() === want);
      if (!opt) continue;
      value = opt.value;
    } else {
      value = forDate(input, value);
    }
    setValue(input, value);
    seen.add(key);
    out.filled += 1;
    out.fields.push({ key, how: d.autocomplete && d.autocomplete !== 'off' ? 'autocomplete' : (d.label ? 'label' : 'name') });
  }
  return out;
}

/** The script to hand to webContents.executeJavaScript. */
function buildFillScript(values, { force = false } = {}) {
  const rules = RULES.map((r) => ({ key: r.key, autocomplete: r.autocomplete, type: r.type || '', label: r.label, attr: r.attr }));
  return `(${pageFill.toString()})(${JSON.stringify(values || {})}, ${JSON.stringify(rules)}, ${JSON.stringify({ force })})`;
}

/** Is this page one the app opened for booking? Compared by origin. */
function isBookingPage(url, origins) {
  try {
    return origins.has(new URL(String(url)).origin);
  } catch {
    return false;
  }
}

function originOf(url) {
  try {
    return new URL(String(url)).origin;
  } catch {
    return null;
  }
}

module.exports = { RULES, matchKey, pageFill, buildFillScript, isBookingPage, originOf };
