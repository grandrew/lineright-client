/**
 * Everything one run did on the site, kept for the person whose computer ran
 * it, so that afterwards it can be told exactly what happened: which pages it
 * went to, what it asked the site and what came back, what the page said in
 * its console, and every click and keystroke with the element it went to.
 *
 * RQP_TRACE_DIR names a folder for the run (the desktop app gives each run its
 * own, under its logs). Without it nothing is kept and nothing is slowed down.
 *
 *   events.jsonl  as it happens, one JSON object a line: requests (with what
 *                 was sent), responses (with the body, for the site's own data),
 *                 failures, navigations, console messages, page errors, dialogs,
 *                 and the run log's own steps. Written line by line, so a run
 *                 that is stopped part way still leaves what it had done.
 *   doc-N.html    each document the site sent, as it arrived
 *   trace.zip     Playwright's trace: every action with its selector and the
 *                 element it resolved to, the page before and after it, the
 *                 network, the console — `npx playwright show-trace trace.zip`.
 *                 Written when the run ends, so a run killed part way has none.
 *
 * Secrets stay out (redact): tokens, cookies, passwords, captcha answers, and
 * the numbers on a form that matter if the folder is copied — a licence number,
 * a date of birth, a Social Security number. Names, emails and phone numbers,
 * the person's own, are kept: they are what a booking is made of.
 */
import fs from 'fs';
import path from 'path';

/** Keys whose values never go into a log. Kept in step with the desktop app's logbook.js. */
export const SECRET = /pass(?:word|wd|code|phrase)?\b|passport|pwd|secret|token|auth|cookie|session|csrf|xsrf|captcha|api.?key|ssn|social.?sec|dl.?(?:num|no)|licen[cs]e.?(?:num|no)|permit.?(?:num|no)|birth|\bdob\b|card.?(?:num|no)|cvv|cvc|security.?code|account.?num|routing/i;

/** How much of one body is kept. */
const MAX_BODY = 64 * 1024;

const masked = (value) => `‹redacted, ${String(value ?? '').length} chars›`;

/** `value` with every secret-looking key's value struck out, all the way down. */
export function redact(value, depth = 0) {
  if (depth > 12 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  const out = {};
  for (const [key, v] of Object.entries(value)) {
    out[key] = SECRET.test(key) && v !== null && v !== '' && typeof v !== 'object' ? masked(v)
      : SECRET.test(key) && v && typeof v === 'object' ? '‹redacted›'
        : redact(v, depth + 1);
  }
  return out;
}

/** A URL with its secret-looking query values struck out. */
export function redactUrl(url) {
  try {
    const u = new URL(url);
    let changed = false;
    for (const key of [...u.searchParams.keys()]) {
      if (SECRET.test(key)) { u.searchParams.set(key, masked(u.searchParams.get(key))); changed = true; }
    }
    return changed ? u.toString() : url;
  } catch {
    return url;
  }
}

/** A body as sent or received, its secrets struck out, cut to MAX_BODY. */
export function redactBody(text, mime = '') {
  if (text === null || text === undefined) return text;
  let body = String(text);
  const trimmed = body.trim();
  if (/json/i.test(mime) || /^[[{]/.test(trimmed)) {
    try { body = JSON.stringify(redact(JSON.parse(trimmed))); } catch { /* not JSON after all */ }
  } else if (/x-www-form-urlencoded/i.test(mime) || /^[\w.%[\]-]+=[^\s]*(&[\w.%[\]-]+=[^\s]*)*$/.test(trimmed)) {
    const params = new URLSearchParams(trimmed);
    for (const key of [...params.keys()]) if (SECRET.test(key)) params.set(key, masked(params.get(key)));
    body = params.toString();
  }
  return body.length > MAX_BODY ? `${body.slice(0, MAX_BODY)}… ‹${body.length - MAX_BODY} more chars›` : body;
}

/** Headers worth keeping: all but the secret ones, which say only that they were there. */
function headers(all = {}) {
  const out = {};
  for (const [key, value] of Object.entries(all)) out[key] = SECRET.test(key) ? masked(value) : value;
  return out;
}

const DATA = new Set(['document', 'xhr', 'fetch']);
const TEXTUAL = /json|html|text|xml|javascript/i;

/**
 * Start keeping `context`'s run in `dir`. Returns `{ note(tag, detail), stop() }`:
 * `note` puts one of the run log's own steps in among the network, and `stop`
 * ends it and writes the trace. Never throws: a log that cannot be written must
 * not take the run down with it.
 */
export async function instrument(context, { dir = null, screenshots = false, title = '' } = {}) {
  if (!dir) return { note: () => {}, stop: async () => {} };
  try { fs.mkdirSync(dir, { recursive: true }); } catch { return { note: () => {}, stop: async () => {} }; }
  const file = path.join(dir, 'events.jsonl');
  const write = (record) => {
    try { fs.appendFileSync(file, `${JSON.stringify({ t: new Date().toISOString(), ...record })}\n`); } catch { /* never the problem */ }
  };
  let docs = 0;
  let seq = 0;
  const ids = new WeakMap();
  const idOf = (request) => {
    if (!ids.has(request)) ids.set(request, ++seq);
    return ids.get(request);
  };

  const wire = (page) => {
    const pageNo = ++seq;
    write({ type: 'page', page: pageNo, url: page.url() });
    page.on('request', (request) => {
      const rtype = request.resourceType();
      const record = { type: 'request', page: pageNo, id: idOf(request), method: request.method(),
        url: redactUrl(request.url()), rtype };
      if (DATA.has(rtype)) {
        record.headers = headers(request.headers());
        const sent = request.postData();
        if (sent) record.postData = redactBody(sent, request.headers()['content-type'] || '');
      }
      write(record);
    });
    page.on('response', async (response) => {
      const request = response.request();
      const rtype = request.resourceType();
      const mime = response.headers()['content-type'] || '';
      const record = { type: 'response', page: pageNo, id: idOf(request), status: response.status(),
        url: redactUrl(response.url()), rtype, mime };
      if (!DATA.has(rtype) || !TEXTUAL.test(mime)) return write(record);
      let body = null;
      try { body = await response.text(); } catch (err) { record.bodyError = err.message; }
      if (body !== null && rtype === 'document') {
        const name = `doc-${++docs}.html`;
        try { fs.writeFileSync(path.join(dir, name), body); record.file = name; } catch { /* never the problem */ }
        record.bytes = body.length;
      } else if (body !== null) {
        record.body = redactBody(body, mime);
      }
      write(record);
    });
    page.on('requestfailed', (request) => write({ type: 'failed', page: pageNo, id: idOf(request),
      url: redactUrl(request.url()), rtype: request.resourceType(), error: request.failure()?.errorText || '' }));
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) write({ type: 'navigated', page: pageNo, url: redactUrl(frame.url()) });
    });
    page.on('console', (message) => write({ type: 'console', page: pageNo, level: message.type(),
      text: String(message.text()).slice(0, 4000) }));
    page.on('pageerror', (error) => write({ type: 'pageerror', page: pageNo, message: String(error && error.message || error).slice(0, 4000) }));
    page.on('dialog', (dialog) => write({ type: 'dialog', page: pageNo, kind: dialog.type(), message: dialog.message() }));
    page.on('close', () => write({ type: 'closed', page: pageNo }));
  };

  context.on('page', wire);
  for (const page of context.pages()) wire(page);
  let tracing = false;
  try {
    await context.tracing.start({ screenshots, snapshots: true, sources: false, title });
    tracing = true;
  } catch (err) {
    write({ type: 'trace', error: err.message });
  }
  write({ type: 'start', title, screenshots });

  let stopped = false;
  return {
    note(tag, detail = '') {
      write({ type: 'step', tag, detail: String(detail) });
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      write({ type: 'end' });
      if (!tracing) return;
      try {
        await context.tracing.stop({ path: path.join(dir, 'trace.zip') });
      } catch (err) {
        write({ type: 'trace', error: err.message });
      }
    },
  };
}
