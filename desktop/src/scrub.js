'use strict';
/**
 * What may leave this computer in a trace (traces.js): everything the app did,
 * with the person taken out.
 *
 * The app knows which private details it holds, because it is the one holding
 * them: the profile it types into booking forms, the confirmation numbers a
 * booking site gave it, the account this computer runs under. So it does not
 * guess at those. Every one of them is replaced wherever it turns up — in an
 * address, a page's title, a console line, the app's own log — by the name of
 * what it was: `[first_name]`, `[dob]`, `[phone]`. And in every spelling a page
 * or a request carries it in: any case; URL- or form-encoded; HTML-escaped; a
 * phone or Social Security number with or without its separators; a date of
 * birth in the formats forms ask for. A detail that reached a page or a request
 * from this app came from the profile, so this is the sure rule.
 *
 * Behind it, the shapes of private things in general, for what somebody typed
 * that the profile does not hold: email addresses, phone numbers written with
 * separators, Social Security numbers, card numbers (an issuer's prefix and the
 * Luhn check), a California licence number, tokens. The folder the app runs
 * from becomes `~`, so a path does not name the person it belongs to.
 *
 * A URL keeps its scheme, host and path — each part of the path scrubbed, and
 * an opaque token in it replaced — and the keys of its query. A query value
 * stays only when it is plainly nothing personal (a number, a date, a time, one
 * word) and never when its key says it is personal, secret or free text.
 *
 * Plain Node, so it runs under `node --test`.
 */
const os = require('node:os');
const { SECRET } = require('./logbook');

/** Query keys whose values are a person's, a secret, or whatever somebody typed. */
const PERSONAL_KEY = /name|e?mail|phone|\btel|mobile|addr|street|city|zip|postal|birth|\bdob\b|ssn|social|licen[cs]e|permit|dl.?(?:num|no)|passport|pass(?:word|wd|code)?\b|pwd|secret|token|auth|cookie|session|\bsid\b|csrf|xsrf|captcha|api.?key|signature|\bsig\b|card|cvv|cvc|account|secur|confirm|\bcode\b|\bref\b|user|login|member|customer|person|owner|holder|\bq\b|query|search|term|keyword|text|comment|note|message|desc/i;
/** Keys of a trace event whose string values are addresses. */
const URL_KEY = /^(?:url|href|src|source|location|referr?er|from|to|base)$/i;
/** Values shorter than this are not looked for: two letters are in every word. */
const MIN = 3;
/** How much of one string is looked at, and kept. */
const LOOK_AT = 20000;
const KEEP = 500;

/** What each profile field is called once it is taken out. City and state stay: an office is named after its city. */
const LABELS = {
  full_name: 'name', first_name: 'first_name', middle_name: 'middle_name', last_name: 'last_name',
  dob: 'dob', ssn: 'ssn', dl_number: 'dl_number', passport: 'passport', email: 'email', phone: 'phone',
  street: 'street', zip: 'zip',
};
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september',
  'october', 'november', 'december'];

const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
/** Between the digits of a phone or SSN, as a page or a URL may write them. */
const SEP = '(?:[\\s().+\\-/]|%2[0-9A-Fa-f]){0,3}';
/** Between the parts of a date. */
const DSEP = '(?:[\\s/.\\-]|%2[Ff]|%20){0,2}';
/** Between the words of a name or a street. */
const SPACE = '(?:\\s+|%20|\\+|&nbsp;|\\u00a0)';
// Where a value starts and ends: not inside a longer word or number — but just
// after a URL-encoded byte (%20, %3A) is a start, though that byte ends in a digit.
const ENCODED_BEFORE = '(?<=%[0-9A-Fa-f]{2})';
const NOT_WORD_BEFORE = `(?:(?<![\\p{L}\\p{N}])|${ENCODED_BEFORE})`;
const NOT_WORD_AFTER = '(?![\\p{L}\\p{N}])';
const NOT_DIGIT_BEFORE = `(?:(?<!\\d)|${ENCODED_BEFORE})`;

/** One word of a name or a street, spelt as it is, URL-encoded, or HTML-escaped. */
function wordSpellings(word) {
  const out = new Set([word]);
  try { out.add(encodeURIComponent(word)); } catch { /* a lone surrogate */ }
  out.add(word.replace(/&/g, '&amp;').replace(/'/g, '&#39;').replace(/"/g, '&quot;'));
  out.add(word.replace(/'/g, '&#x27;'));
  out.add(word.replace(/'/g, '’'));
  return [...out].map(esc);
}

/** A name, a street, a licence number: its words in any case, with any space between. */
function wordsPattern(value) {
  const words = String(value).trim().split(/\s+/).filter(Boolean);
  if (!words.length) return null;
  const body = words.map((w) => {
    const spelt = wordSpellings(w);
    return spelt.length > 1 ? `(?:${spelt.join('|')})` : spelt[0];
  }).join(SPACE);
  return `${NOT_WORD_BEFORE}${body}${NOT_WORD_AFTER}`;
}

/**
 * A number however it is written: 408-555-0123, (408) 555 0123, 4085550123,
 * %28408%29… — after `prefix` if there is one (a phone's +1).
 */
function digitsPattern(digits, prefix = '') {
  return `${NOT_DIGIT_BEFORE}${prefix ? `(?:${prefix})?` : ''}(?:\\(|%28)?${digits.split('').join(SEP)}(?!\\d)`;
}

/** An email address, and the name before its @ when that is long enough to be the person's. */
function emailPatterns(value) {
  const v = String(value).trim();
  const at = v.indexOf('@');
  const whole = [v, encodeURIComponent(v)].map(esc).join('|');
  const out = [`(?<![\\w.+%-])(?:${whole})(?![\\w.-])`];
  const local = at > 0 ? v.slice(0, at) : '';
  if (local.length >= 5) out.push(`(?<![\\w.+%-])${esc(local)}(?![\\w-])`);
  return out;
}

/** A date of birth in the orders and formats a form or a URL uses. */
function datePatterns(value) {
  const m = String(value).trim().match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/)
    || String(value).trim().match(/^(\d{4})[/.-](\d{1,2})[/.-](\d{1,2})$/);
  if (!m) return [];
  const [mo, d, y] = m[1].length === 4 ? [m[2], m[3], m[1]] : [m[1], m[2], m[3]];
  const month = Number(mo);
  const day = Number(d);
  if (!(month >= 1 && month <= 12 && day >= 1 && day <= 31)) return [];
  const pm = `0?${month}`;
  const pd = `0?${day}`;
  const name = MONTHS[month - 1];
  return [
    `${NOT_DIGIT_BEFORE}${pm}${DSEP}${pd}${DSEP}(?:${y}|${y.slice(2)})(?!\\d)`,
    `${NOT_DIGIT_BEFORE}${y}${DSEP}${pm}${DSEP}${pd}(?!\\d)`,
    `${NOT_WORD_BEFORE}(?:${name}|${name.slice(0, 3)}\\.?)${SPACE}${pd},?${SPACE}${y}(?!\\d)`,
  ];
}

function luhn(digits) {
  let sum = 0;
  for (let i = 0; i < digits.length; i += 1) {
    let n = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) { n *= 2; if (n > 9) n -= 9; }
    sum += n;
  }
  return sum % 10 === 0;
}
const CARD_PREFIX = /^(?:4\d{12}(?:\d{3})?|5[1-5]\d{14}|2[2-7]\d{14}|3[47]\d{13}|6(?:011|5\d\d)\d{12})$/;

/** The shapes of private things, for what the profile does not hold. In order. */
const PATTERNS = [
  [/eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/g, '[token]'],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [token]'],
  [/[A-Za-z0-9._%+-]+(?:@|%40)[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g, '[email]'],
  [/(?<![\d-])\d{3}-\d{2}-\d{4}(?![\d-])/g, '[ssn]'],
  [/(?<![\d-])(?:\+?1[\s.-]?)?(?:\(\d{3}\)\s?|\d{3}[\s.-])\d{3}[\s.-]\d{4}(?![\d-])/g, '[phone]'],
  [/(?<!\d)(?:\d[ -]?){12,18}\d(?!\d)/g, (match) => {
    const digits = match.replace(/\D/g, '');
    return CARD_PREFIX.test(digits) && luhn(digits) ? '[card]' : match;
  }],
  [/(?<![A-Za-z0-9])[A-Z]\d{7}(?![A-Za-z0-9])/g, '[dl]'],
];

/** A value a query may keep as it is: plainly not a person's. */
const SAFE_VALUE = [
  /^-?\d{1,16}(?:\.\d+)?$/,
  /^\d{4}-\d{2}-\d{2}(?:[T ][\d:.]+(?:Z|[+-]\d{2}:?\d{2})?)?$/,
  /^\d{1,2}\/\d{1,2}\/\d{2,4}$/,
  /^\d{1,2}:\d{2}(?::\d{2})?(?:\s?[AaPp][Mm])?$/,
  /^[A-Za-z0-9_.:-]{1,64}$/,
  /^(?:\[[a-z_]+\]|\[\d+-chars\]|‹[^›]*›)$/,
  /^(?:true|false|null|undefined)$/i,
];

/** A run of letters and digits long enough and mixed enough to be a token or an id, not a word. */
function opaque(part) {
  if (part.length < 16 || !/^[A-Za-z0-9+=~]+$/.test(part)) return false;
  const digits = (part.match(/\d/g) || []).length;
  return digits >= 3 && part.length - digits >= 3;
}

/** One part of a path, or a word of a fragment, encoded back but readable. */
function encodePart(text) {
  return encodeURIComponent(text).replace(/%5B/gi, '[').replace(/%5D/gi, ']').replace(/%3A/gi, ':')
    .replace(/%2C/gi, ',').replace(/%40/gi, '@').replace(/%E2%80%B9/gi, '‹').replace(/%E2%80%BA/gi, '›');
}

function decode(text) {
  try { return decodeURIComponent(String(text).replace(/\+/g, ' ')); } catch { return String(text); }
}

function clip(text, max) {
  const s = String(text);
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

class Scrubber {
  /**
   * @param {object} [opts]
   * @param {string} [opts.home]   the folder to write as `~` (this computer's home)
   * @param {string} [opts.user]   the account name this computer runs under
   */
  constructor({ home = safe(() => os.homedir(), ''), user = safe(() => os.userInfo().username, '') } = {}) {
    this.home = home && home.length > 1 ? home : '';
    this.rules = [];          // [{label, re}]: the known values, longest first
    this.profile = {};
    this.extra = new Map();   // label -> Set of values learnt as the app goes (a confirmation number)
    this.user = user && user.length >= MIN && !/^(?:root|user|admin|runner|ubuntu|guest)$/i.test(user) ? user : '';
    this.build();
  }

  /** The profile's values (profile.js values()): from now on, each is taken out. */
  setProfile(values = {}) {
    this.profile = { ...(values || {}) };
    this.build();
  }

  /** A value learnt along the way — a booking's confirmation number — taken out from now on. */
  learn(label, value) {
    const v = String(value || '').trim();
    if (v.length < MIN) return;
    if (!this.extra.has(label)) this.extra.set(label, new Set());
    if (this.extra.get(label).has(v)) return;
    this.extra.get(label).add(v);
    this.build();
  }

  build() {
    const rules = [];
    const add = (label, source, weight) => {
      if (!source) return;
      try { rules.push({ label: `[${label}]`, re: new RegExp(source, 'giu'), weight }); } catch { /* not a pattern after all */ }
    };
    for (const [key, label] of Object.entries(LABELS)) {
      const raw = this.profile[key];
      const value = typeof raw === 'string' ? raw.trim() : '';
      if (value.length < MIN) continue;
      if (key === 'phone') {
        let digits = value.replace(/\D/g, '');
        if (digits.length === 11 && digits.startsWith('1')) digits = digits.slice(1);
        if (digits.length >= 7) add(label, digitsPattern(digits, `\\+?1${SEP}`), digits.length);
      } else if (key === 'ssn') {
        const digits = value.replace(/\D/g, '');
        if (digits.length >= 7) add(label, digitsPattern(digits), digits.length);
      } else if (key === 'zip') {
        const digits = value.replace(/\D/g, '').slice(0, 5);
        if (digits.length === 5) add(label, `${NOT_DIGIT_BEFORE}${digits}(?:-\\d{4})?(?!\\d)`, 5);
      } else if (key === 'dob') {
        for (const p of datePatterns(value)) add(label, p, 10);
      } else if (key === 'email') {
        emailPatterns(value).forEach((p, i) => add(i ? 'email_name' : label, p, value.length - i));
      } else if (key === 'dl_number' || key === 'passport') {
        const chars = value.replace(/[\s-]/g, '');
        if (chars.length >= MIN) add(label, `${NOT_WORD_BEFORE}${chars.split('').map(esc).join('[\\s-]?')}${NOT_WORD_AFTER}`, chars.length);
      } else {
        add(label, wordsPattern(value), value.length);
      }
    }
    for (const [label, values] of this.extra) {
      for (const v of values) add(label, wordsPattern(v), v.length);
    }
    if (this.user) add('user', `${NOT_WORD_BEFORE}${esc(this.user)}${NOT_WORD_AFTER}`, this.user.length);
    // The longest first: the full name before the first name inside it.
    rules.sort((a, b) => b.weight - a.weight);
    this.rules = rules;
  }

  /** Known values and the shapes of private things out of `text`, and nothing else changed. */
  plain(text) {
    let s = String(text);
    if (this.home) s = s.split(this.home).join('~').split(this.home.replace(/\\/g, '/')).join('~');
    for (const { label, re } of this.rules) {
      re.lastIndex = 0;
      s = s.replace(re, label);
    }
    for (const [re, to] of PATTERNS) s = s.replace(re, to);
    return s;
  }

  /** Free text — a title, a console line, a line of the app's log — scrubbed and cut to `max`. */
  text(value, max = KEEP) {
    if (value === null || value === undefined) return value;
    const s = String(value).slice(0, LOOK_AT);
    // An address in the text is scrubbed as an address: its query values go too.
    const withUrls = s.replace(/\b(?:https?|wss?):\/\/[^\s"'<>)]+/g, (u) => this.url(u));
    return clip(this.plain(withUrls), max);
  }

  /** An address: scheme, host and path kept, scrubbed; a query's keys kept, its values only when plainly not a person's. */
  url(raw, max = 1000) {
    if (raw === null || raw === undefined || raw === '') return raw;
    const text = String(raw).slice(0, LOOK_AT);
    let u;
    try {
      u = new URL(text);
    } catch {
      return clip(this.plain(text), max);
    }
    if (u.protocol === 'data:') return `data:${(u.pathname.split(/[;,]/)[0] || '').slice(0, 40)},…`;
    if (u.protocol === 'about:') return clip(`about:${u.pathname}`, max);
    if (u.protocol === 'blob:') return `blob:${u.origin && u.origin !== 'null' ? u.origin : ''}/…`;
    const path = u.pathname.split('/').map((part) => this.pathPart(part)).join('/');
    const query = [];
    for (const [key, value] of u.searchParams) query.push(`${encodePart(this.plain(key).slice(0, 60))}=${this.queryValue(key, value)}`);
    const hash = u.hash ? `#${this.fragment(u.hash.slice(1))}` : '';
    // user:password@ is never kept, nor said to have been there.
    const host = u.protocol === 'file:' ? '' : u.host;
    return clip(`${u.protocol}//${host}${path}${query.length ? `?${query.join('&')}` : ''}${hash}`, max);
  }

  pathPart(part) {
    if (!part) return part;
    const decoded = decode(part);
    const scrubbed = this.plain(decoded);
    const pieces = scrubbed.split(/([-_.,;])/).map((p) => (opaque(p) ? ':id' : p));
    return encodePart(pieces.join(''));
  }

  queryValue(key, value) {
    if (value === '') return '';
    if (PERSONAL_KEY.test(key) || SECRET.test(key)) return '[redacted]';
    const scrubbed = this.plain(value);
    if (SAFE_VALUE.some((re) => re.test(scrubbed))) return encodePart(opaque(scrubbed) ? ':id' : scrubbed);
    return `[${String(value).length}-chars]`;
  }

  fragment(hash) {
    if (/[=&]/.test(hash)) {
      const params = new URLSearchParams(hash);
      return [...params].map(([k, v]) => `${encodePart(this.plain(k).slice(0, 60))}=${this.queryValue(k, v)}`).join('&');
    }
    return this.pathPart(hash.slice(0, 200));
  }

  /**
   * A whole trace event's fields, all the way down: strings scrubbed (as
   * addresses under an address's key), a secret-looking key's value struck,
   * numbers kept, and nothing deeper than four levels or longer than fifty.
   */
  value(v, key = '', depth = 0) {
    if (v === null || v === undefined) return v;
    if (typeof v === 'string') {
      if (key && SECRET.test(key) && v && !/^‹redacted/.test(v)) return '[redacted]';
      return URL_KEY.test(key) ? this.url(v) : this.text(v);
    }
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    if (typeof v === 'boolean') return v;
    if (depth >= 4) return '[…]';
    if (Array.isArray(v)) return v.slice(0, 50).map((x) => this.value(x, key, depth + 1));
    if (typeof v === 'object') {
      const out = {};
      for (const [k, x] of Object.entries(v).slice(0, 50)) {
        if (x !== undefined) out[k] = this.value(x, k, depth + 1);
      }
      return out;
    }
    return null;
  }

  /** Whether `text` still holds anything this scrubber would take out (for the tests, and a last check). */
  finds(text) {
    return this.plain(String(text)) !== String(text);
  }
}

function safe(fn, fallback) {
  try { return fn(); } catch { return fallback; }
}

/**
 * What a person typed, said without saying it: how long, and what it looks like.
 * A field's value never goes into a trace; this is all that does.
 */
function shape(value) {
  const s = String(value === null || value === undefined ? '' : value);
  if (!s) return { len: 0 };
  let kind = 'text';
  if (/^\d+$/.test(s)) kind = 'digits';
  else if (/^[\p{L}]+$/u.test(s)) kind = 'letters';
  else if (/@/.test(s)) kind = 'email';
  else if (/^[\d\s().+-]+$/.test(s)) kind = 'number';
  else if (/^[\p{L}\s'.-]+$/u.test(s)) kind = 'words';
  else if (/^[\p{L}\p{N}]+$/u.test(s)) kind = 'mixed';
  return { len: s.length, kind };
}

module.exports = { Scrubber, shape, PERSONAL_KEY, PATTERNS, SAFE_VALUE, opaque, luhn };
