'use strict';
/**
 * The model's stand-in, for tests and for trying the AI oversight's plumbing
 * without a model: a few rules that read the latest page the conversation
 * carries, as the model would get it, and answer with tool calls, as the model
 * would. `bookingBrain` books one slot on the DMV stand-in, whatever its words;
 * `checkBrain` pages its calendar to the first open day and reports it.
 * `diagnoseBrain` finds out why a robot could not read a calendar, as the
 * site's AI check does: it searches the office, presses its button whatever
 * it says now, opens the first open day, and reports what had changed.
 * `serveBrain` puts one behind an address that speaks the model's API
 * (POST /chat/completions), for a regbot site to call as it would DeepSeek.
 */
const http = require('node:http');

/** "09:00" from "9:00 AM". */
function to24(label) {
  const m = /^(\d{1,2}):(\d{2})\s*([AP]M)$/i.exec(String(label).trim());
  if (!m) return label;
  let h = Number(m[1]) % 12;
  if (/pm/i.test(m[3])) h += 12;
  return `${String(h).padStart(2, '0')}:${m[2]}`;
}

function caller() {
  let n = 0;
  return (name, args) => ({ id: `call_${++n}`, type: 'function', function: { name, arguments: JSON.stringify(args) } });
}

const ref = (page, pattern) => {
  const m = new RegExp(`^\\[(\\d+)\\] ${pattern}`, 'm').exec(page);
  return m ? Number(m[1]) : null;
};

/** The latest page in the conversation, from "Page: " on. */
function latestPage(body) {
  const last = [...body.messages].reverse().find((m) => (m.role === 'tool' || m.role === 'user') && /Page: /.test(m.content || ''));
  return last ? last.content.slice(last.content.indexOf('Page: ')) : '';
}

const reply = (calls) => ({ message: { role: 'assistant', content: null, tool_calls: calls }, charged: 1 });

/**
 * The model's stand-in: reads the latest page the conversation carries and
 * does the obvious next thing a person would, as a tool call.
 */
function bookingBrain(target) {
  const heard = [];
  const call = caller();
  return {
    heard,
    async chat(body) {
      heard.push(body);
      const page = latestPage(body);
      const ref24 = /\b(TS-[0-9A-F]{8})\b/.exec(page);
      if (ref24 && /confirmed/i.test(page)) {
        return reply([call('finish', { outcome: 'booked', confirmation: ref24[1], submitted: true,
          summary: 'The confirmation page shows the booking reference.' })]);
      }
      const book = ref(page, 'button "(?:Book this appointment|Schedule appointment)"');
      if (book) return reply([call('click', { ref: book })]);
      const boxes = [['(?:Given name|First Name)', '[first_name]'], ['(?:Family name|Last Name)', '[last_name]'],
        ['textbox email "(?:Email|Email Address)"|textbox "(?:Email|Email Address)"', '[email]'],
        ['textbox tel "(?:Mobile number|Phone Number)"|textbox "(?:Mobile number|Phone Number)"', '[phone]']];
      const fills = [];
      for (const [label, value] of boxes) {
        const m = new RegExp(`^\\[(\\d+)\\] (?:${label.startsWith('textbox') ? label : `textbox "${label}"`})(?: "[^"]*")? empty`, 'm').exec(page);
        if (m) fills.push(call('type_text', { ref: Number(m[1]), text: value }));
      }
      if (fills.length) return reply(fills);
      const next = ref(page, 'button "(?:Review my details|Continue)"');
      if (next) return reply([call('click', { ref: next })]);
      const time = ref(page, `button "${target.label}"(?! selected)`);
      if (time) return reply([call('click', { ref: time })]);
      const hold = ref(page, 'button "(?:Hold this time|Confirm)"(?! disabled)');
      if (hold) return reply([call('click', { ref: hold })]);
      const office = ref(page, 'button "(?:Choose this office|Select Location)"');
      if (office) return reply([call('click', { ref: office })]);
      const day = ref(page, `(?:button|link) "[^"]*\\b${Number(target.date.slice(8))}\\b[^"]*Open Times"`);
      if (day) return reply([call('click', { ref: day })]);
      const later = ref(page, 'button "Next month[^"]*"(?! disabled)');
      if (later && /select-date/.test(page)) return reply([call('click', { ref: later })]);
      return reply([call('finish', { outcome: 'failed', submitted: false, summary: 'Nothing on the page to do.' })]);
    },
  };
}

/**
 * Checks a calendar: pages forward to the first open day and reports it. The
 * month comes from the calendar's heading ("## December 2026").
 */
function checkBrain({ where = 'Poway', months = 4 } = {}) {
  const heard = [];
  const call = caller();
  let paged = 0;
  return {
    heard,
    async chat(body) {
      heard.push(body);
      const page = latestPage(body);
      const open = /^\[(\d+)\] button "(\d{1,2}) Open Times"/m.exec(page);
      const month = /^## ([A-Z][a-z]+ \d{4})$/m.exec(page);
      if (open && month) {
        const d = new Date(`${month[1]} ${open[2]} 12:00 UTC`);
        const date = Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
        return reply([call('finish', { outcome: 'checked', summary: `The first open day at ${where}.`,
          findings: [{ where, date, note: 'open times' }] })]);
      }
      const later = ref(page, 'button "Next month[^"]*"(?! disabled)');
      if (later && paged < months) {
        paged += 1;
        return reply([call('click', { ref: later })]);
      }
      return reply([call('finish', { outcome: 'checked', summary: 'Nothing open.', findings: [] })]);
    },
  };
}

/**
 * The AI check of a line the robots cannot read (agent/diagnose.js): the
 * office search, the office's button whatever its words, the first open day,
 * its times — then the finish, with the button's words as the cause and the fix.
 */
function diagnoseBrain({ office: named = '', expected = 'Select Location', months = 4 } = {}) {
  const heard = [];
  const call = caller();
  let said = '';
  let paged = 0;
  return {
    heard,
    async chat(body) {
      heard.push(body);
      const page = latestPage(body);
      // The office the brief names, unless the test said which.
      const brief = /Offices to look at: ([^;.\n]+)/.exec((body.messages[1] && body.messages[1].content) || '');
      const office = named || (brief ? brief[1].trim() : 'Poway');
      const times = [...page.matchAll(/^\[\d+\] button "(\d{1,2}:\d{2} [AP]M)"/gm)].map((m) => m[1]);
      if (times.length) {
        const changed = said && said !== expected;
        return reply([call('finish', { outcome: changed ? 'site_changed' : 'read', times_seen: times.length,
          cause: changed ? `The office's button says "${said}" now, not "${expected}".` : 'Nothing has changed that I could see.',
          fix: changed ? `Press the office's button by "${said}" as well as "${expected}".` : 'None.',
          summary: `Searched ${office}, pressed "${said}", and saw ${times.length} time(s) on the first open day.` })]);
      }
      const day = ref(page, 'button "\\d{1,2} Open Times"');
      if (day) return reply([call('click', { ref: day })]);
      if (/^## [A-Z][a-z]+ \d{4}$/m.test(page)) {
        const later = ref(page, 'button "Next month[^"]*"(?! disabled)');
        if (later && paged < months) {
          paged += 1;
          return reply([call('click', { ref: later })]);
        }
        return reply([call('finish', { outcome: 'no_times', cause: 'The calendar has no open day.', fix: 'None.', summary: 'Nothing open.' })]);
      }
      const card = new RegExp(`^### ${office}$[\\s\\S]*?^\\[(\\d+)\\] button "([^"]+)"`, 'm').exec(page);
      if (card) {
        said = card[2];
        return reply([call('click', { ref: Number(card[1]) })]);
      }
      const box = ref(page, 'textbox "Search by city or ZIP" empty');
      if (box) return reply([call('type_text', { ref: box, text: office })]);
      const search = /textbox "Search by city or ZIP"[^\n]*\n(?:[^\n]*\n)*?\[(\d+)\] button "Search"/.exec(page);
      if (search) return reply([call('click', { ref: Number(search[1]) })]);
      return reply([call('finish', { outcome: 'failed', cause: 'Nothing on the page to do.', fix: '', summary: 'Stuck.' })]);
    },
  };
}

/**
 * A brain behind the model's API, on this machine: POST /chat/completions
 * answers as DeepSeek would, with `usage` counted roughly from the sizes.
 * Resolves to `{ url, close, heard }`.
 */
async function serveBrain(brain, { port = 0 } = {}) {
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => { raw += d; });
    req.on('end', async () => {
      try {
        const body = JSON.parse(raw || '{}');
        const out = await brain.chat(body);
        const data = JSON.stringify({ id: 'standin', model: body.model, object: 'chat.completion',
          choices: [{ index: 0, message: out.message, finish_reason: out.message.tool_calls ? 'tool_calls' : 'stop' }],
          usage: { prompt_tokens: Math.ceil(raw.length / 4), completion_tokens: 40,
            prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: Math.ceil(raw.length / 4) } });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(data);
      } catch (err) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: err.message } }));
      }
    });
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)), heard: brain.heard };
}

module.exports = { bookingBrain, checkBrain, diagnoseBrain, serveBrain, to24, latestPage };
