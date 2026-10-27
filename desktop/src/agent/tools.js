'use strict';
/**
 * What the AI may do on a page, as the model is told it (OpenAI-style function
 * tools), and doing it with a driver (drivers.js).
 *
 * The person's details never go to the model. A page it reads has them taken
 * out (scrub.js: "[first_name]", "[phone]", …), and to type one the model
 * writes that same placeholder; it is put back here, on this computer, just
 * before the text goes into the form — and only the details the task allows
 * (a booking's `requires`), whatever the model writes.
 *
 * After an action the result carries the page as it is then, so the model sees
 * what its press did without spending a step to look.
 */

const PLACEHOLDER = /\[([a-z_]{2,30})\]/g;

/** What the model may finish with: the booking's ends, or a check's. */
const BOOK_ENDS = ['booked', 'gone', 'unconfirmed', 'human_check', 'failed'];
const CHECK_ENDS = ['checked', 'human_check', 'failed'];

const fn = (name, description, properties = {}, required = []) => ({
  type: 'function',
  function: { name, description, parameters: { type: 'object', properties, required, additionalProperties: false } },
});
const REF = { type: 'integer', description: 'The number in square brackets before the element, from the latest look at the page.' };

/** Every tool, by name. */
function schemas({ kind = 'book' } = {}) {
  const finish = kind === 'check'
    ? fn('finish', 'End the task and say what you found.', {
      outcome: { type: 'string', enum: CHECK_ENDS },
      findings: { type: 'array', description: 'What is available, one item each.',
        items: { type: 'object', properties: { where: { type: 'string' }, date: { type: 'string', description: 'YYYY-MM-DD' },
          time: { type: 'string', description: 'HH:MM, 24-hour' }, note: { type: 'string' } } } },
      summary: { type: 'string', description: 'One or two sentences: what you did and what you saw.' },
    }, ['outcome', 'summary'])
    : fn('finish', 'End the task: say how it ended. Call it as soon as the outcome is clear.', {
      outcome: { type: 'string', enum: BOOK_ENDS, description: 'booked: the site shows the booking confirmed. gone: the slot is no '
        + 'longer offered. unconfirmed: the booking was sent but no confirmation is shown. human_check: a captcha or other '
        + 'human check is in the way. failed: anything else.' },
      confirmation: { type: 'string', description: 'With booked: the confirmation number exactly as the page shows it.' },
      submitted: { type: 'boolean', description: 'Whether you pressed the button that sends the booking.' },
      summary: { type: 'string', description: 'One or two sentences: what had changed on the site, and what you did.' },
    }, ['outcome', 'submitted', 'summary']);
  return {
    look_at_page: fn('look_at_page', 'Read the page as it is now: its text, and each control numbered.'),
    read_text: fn('read_text', 'All the text on the page, with no controls: for finding a number or a message the look cut short.'),
    click: fn('click', 'Press a button, link or other control.', { ref: REF, why: { type: 'string' } }, ['ref']),
    type_text: fn('type_text', 'Put text into a text box, replacing what is there. For one of the person\'s details write its '
      + 'placeholder exactly, e.g. "[first_name]".', { ref: REF, text: { type: 'string' } }, ['ref', 'text']),
    choose_option: fn('choose_option', 'Choose an option in a drop-down list, by its words as listed.',
      { ref: REF, option: { type: 'string' } }, ['ref', 'option']),
    set_checkbox: fn('set_checkbox', 'Tick or untick a checkbox.', { ref: REF, checked: { type: 'boolean' } }, ['ref', 'checked']),
    press_key: fn('press_key', 'Press a key in the page.', { key: { type: 'string',
      enum: ['Enter', 'Escape', 'Tab', 'ArrowDown', 'ArrowUp', 'Space'] } }, ['key']),
    scroll: fn('scroll', 'Scroll the page.', { direction: { type: 'string', enum: ['down', 'up'] } }, ['direction']),
    wait: fn('wait', 'Wait for the page, when it is still loading.', { seconds: { type: 'number', minimum: 1, maximum: 10 } }, ['seconds']),
    go_back: fn('go_back', 'Go back to the page before.'),
    open_page: fn('open_page', 'Open another page of the same site by its address or path.', { url: { type: 'string' } }, ['url']),
    finish,
  };
}

/** The tools for a task: all of them, or — read only, after a booking was sent — only the looking ones. */
function toolsFor({ kind = 'book', readOnly = false, allowOpen = false } = {}) {
  const all = schemas({ kind });
  const names = readOnly ? ['look_at_page', 'read_text', 'scroll', 'wait', 'finish']
    : Object.keys(all).filter((n) => allowOpen || n !== 'open_page');
  return names.map((n) => all[n]);
}

/** The placeholders in `text`, put back from `values` — only the allowed ones. */
function fillIn(text, values = {}, allowed = []) {
  const unknown = [];
  const out = String(text).replace(PLACEHOLDER, (whole, key) => {
    if (!allowed.includes(key)) {
      unknown.push(whole);
      return whole;
    }
    const value = String(values[key] || '').trim();
    if (!value) unknown.push(whole);
    return value || whole;
  });
  if (unknown.length) {
    throw new Error(`${unknown.join(', ')} ${unknown.length === 1 ? 'is' : 'are'} not a detail you can type here`
      + `${allowed.length ? ` — these are: ${allowed.map((k) => `[${k}]`).join(', ')}` : ''}`);
  }
  return out;
}

/** The arguments of a call, as the model wrote them: `{}` for nothing it could parse. */
function argsOf(call) {
  try {
    const parsed = JSON.parse((call && call.function && call.function.arguments) || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/** The page as the model reads it: where, how far down, what is there — the person taken out. */
function pageText(page, scrub) {
  if (!page) return '(the page could not be read)';
  let where = page.url || '';
  try {
    const u = new URL(page.url);
    where = `${u.host}${u.pathname}`;
  } catch { /* keep it as it was */ }
  const scrolled = page.height > page.viewport
    ? ` (scrolled ${page.scrolled || 0} of ${page.height} px; ${page.viewport} px show at once)` : '';
  return `Page: ${scrub(page.title || '')} — ${scrub(where)}${scrolled}\n${scrub(page.text || '')}`;
}

/** Words that name the press that sends a booking: a press like that may have booked. */
const FINAL = /\b(schedule|book|submit|complete|finish|place)\b/i;

/**
 * Do one call with `driver`. Resolves to `{ text, page, final, label }`: what
 * the model is told, whether that carries the page, the finish (for `finish`),
 * and the label of what was pressed (for the log).
 */
async function execute(call, { driver, values = {}, allowed = [], readOnly = false, scrub = (s) => s, max = 14000,
  allowOpen = false } = {}) {
  const name = call && call.function && call.function.name;
  const a = argsOf(call);
  const look = async () => pageText(await driver.look(max), scrub);
  const after = async (said) => {
    let page;
    try {
      page = await look();
    } catch (err) {
      page = `(the page could not be read: ${err.message})`;
    }
    return { text: `${said}\nThe page now:\n${page}`, page: true };
  };
  const lookingOnly = new Set(['look_at_page', 'read_text', 'scroll', 'wait', 'finish']);
  if (readOnly && !lookingOnly.has(name)) {
    return { text: `"${name}" is not allowed: the booking was sent, so this page is only looked at.` };
  }
  switch (name) {
    case 'look_at_page':
      return { text: await look(), page: true };
    case 'read_text': {
      const text = scrub(String(await driver.text() || ''));
      return { text: text.length > 20000 ? `${text.slice(0, 20000)}\n… (cut)` : text, page: true };
    }
    case 'click': {
      const label = await driver.label(a.ref);
      await driver.click(a.ref);
      return { ...(await after(`Pressed [${a.ref}]${label ? ` "${scrub(label)}"` : ''}.`)), label: label || '' };
    }
    case 'type_text': {
      const text = fillIn(a.text ?? '', values, allowed);
      await driver.fill(a.ref, text);
      return after(`Typed into [${a.ref}].`);
    }
    case 'choose_option':
      await driver.choose(a.ref, String(a.option ?? ''));
      return after(`Chose "${scrub(String(a.option ?? ''))}" in [${a.ref}].`);
    case 'set_checkbox':
      await driver.check(a.ref, a.checked !== false);
      return after(`${a.checked === false ? 'Unticked' : 'Ticked'} [${a.ref}].`);
    case 'press_key':
      await driver.press(String(a.key || 'Enter'));
      return after(`Pressed ${a.key}.`);
    case 'scroll':
      await driver.scroll(a.direction !== 'up');
      return after(`Scrolled ${a.direction === 'up' ? 'up' : 'down'}.`);
    case 'wait':
      await driver.wait(Math.max(1, Math.min(10, Number(a.seconds) || 2)) * 1000);
      return after(`Waited ${Math.max(1, Math.min(10, Number(a.seconds) || 2))} s.`);
    case 'go_back':
      await driver.back();
      return after('Went back.');
    case 'open_page':
      if (!allowOpen) return { text: 'Opening pages by address is not allowed in this task: use the page\'s own links.' };
      await driver.open(String(a.url || ''));
      return after(`Opened ${scrub(String(a.url || ''))}.`);
    case 'finish':
      return { text: 'Finished.', final: {
        outcome: String(a.outcome || 'failed'),
        confirmation: a.confirmation ? String(a.confirmation).trim().slice(0, 60) : '',
        submitted: Boolean(a.submitted),
        summary: String(a.summary || '').slice(0, 1000),
        findings: Array.isArray(a.findings) ? a.findings.slice(0, 50) : undefined,
      } };
    default:
      return { text: `There is no tool "${name}".` };
  }
}

module.exports = { schemas, toolsFor, execute, fillIn, argsOf, pageText, FINAL, BOOK_ENDS, CHECK_ENDS };
