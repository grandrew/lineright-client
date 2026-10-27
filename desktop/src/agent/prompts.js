'use strict';
/**
 * What the AI is told: who it is working for, what the one task is, what it
 * may and may not do. Plain words, because that is all a model has to go on —
 * and because a site described in plain words is one the AI can try to book
 * with no robot written for it at all (`siteTask`).
 *
 * Three moments a booking robot can get stuck in (dmq/src/bot.js), each its own brief:
 *   booking     it stopped on a page before the booking was sent — a button
 *               renamed, a label changed, a page drawn differently: finish it
 *   gone        it found nothing to choose at all where its slot should be:
 *               look whether the slot is really gone, and book it if it is not
 *   confirming  it sent the booking and saw no confirmation number: read the
 *               page, and only read it
 */

const pad = (n) => String(n).padStart(2, '0');

/** "Tuesday, November 3, 2026" from "2026-11-03". */
function dayWords(date) {
  const d = new Date(`${date}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return String(date || '');
  return d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

/** "10:20 AM" from "10:20". */
function timeWords(time) {
  const [h, m] = String(time || '').split(':').map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return String(time || '');
  return `${h % 12 || 12}:${pad(m)} ${h < 12 ? 'AM' : 'PM'}`;
}

const RULES = [
  'Book exactly the office, day and time in the task, never another.',
  'The person\'s details show on pages as placeholders such as [first_name], [last_name], [email], [phone]. To type one, '
    + 'pass exactly the placeholder as the text — "[first_name]" — and the app puts the real value in. Never make a detail up.',
  'Press the button that finally sends the booking once only. A press that holds a time, or goes on to the next page, '
    + 'is not that button.',
  'A captcha or other human check is the person\'s to do: if one blocks you, finish with human_check. Never try to solve it.',
  'Never cancel, reschedule or change an existing appointment, sign in, pay, or leave the site.',
  'The numbers in square brackets name the controls of the latest reading of the page. After each action you get the page '
    + 'as it is then; if an action fails, look again before you try something else.',
  'Be quick and sparing: a step costs the person credits, and the time to book is short. Finish as soon as the outcome is clear.',
];

function bookingBrief({ site, service, slot, guide }) {
  return [
    `Site: ${site || 'the booking site'}.`,
    service ? `What is being booked: ${service}.` : '',
    slot ? `The appointment to book: ${slot.office_name || slot.office || 'the office named below'}, `
      + `${dayWords(slot.date)}${slot.time ? ` at ${timeWords(slot.time)}` : ''}.` : '',
    guide ? `How this site's booking goes, step by step:\n${guide}` : '',
  ].filter(Boolean).join('\n');
}

/** What the robot did before it stopped: its last steps, as it logged them. */
function robotSteps(steps = []) {
  if (!steps.length) return '';
  return `What the robot did, last steps first to last:\n${steps.slice(-10).map((s) => `- ${s.tag}${s.detail ? `: ${s.detail}` : ''}`).join('\n')}`;
}

/**
 * The brief for taking over a booking robot that is stuck. `trouble` is what
 * the robot said (control.js): `stage`, `why`, `step`; `h` the hand-off it was
 * booking (the site's handoff_view) — its slot, its line, and the site's own
 * description of its pages (`robot.guide`).
 */
function overseeBooking({ trouble = {}, h = {}, steps = [], seconds = 180, maxSteps = 30, allowed = [] }) {
  const slot = h.slot || (trouble.wanted && { office_name: trouble.wanted.office, date: trouble.wanted.date, time: trouble.wanted.time }) || null;
  const brief = bookingBrief({ site: h.site_name, service: h.queue_name, slot, guide: h.robot && h.robot.guide });
  const stage = trouble.stage;
  const system = [
    'You are the senior overseer of a booking robot in the LineRight Regbot desktop app. The robot books an appointment',
    'for a person on a public booking website, in a browser on their own computer. It follows the site\'s pages as they',
    'were when it was written; when the site changes, it stops. You now have its browser, on the page where it stopped.',
    stage === 'confirming'
      ? 'The booking has ALREADY BEEN SENT. You may only read the page — press nothing. Find whether the site confirmed it.'
      : stage === 'gone'
        ? 'The robot believes the appointment is no longer offered, because it found nothing at all to choose from where it '
          + 'should be. Check: if the appointment is still offered, book it; if it truly is not, finish with gone.'
        : 'Finish the booking the robot started, from where it stopped, or establish that it cannot be done.',
    '',
    'Rules:',
    ...RULES.map((r) => `- ${r}`),
    stage === 'confirming'
      ? '- Finish with booked and the confirmation number exactly as shown if the page confirms the booking; with failed if it '
        + 'says the booking did not go through; with unconfirmed if you cannot tell.'
      : '- When the page confirms the booking, finish with booked and the confirmation number exactly as shown. If the slot '
        + 'is no longer offered, finish with gone. If you cannot get further after a few tries, finish with failed and say why.',
    `- You have about ${seconds} seconds and ${maxSteps} steps.`,
  ].join('\n');
  const user = [
    brief,
    '',
    `Where the robot stopped: ${trouble.step || stage || 'unknown'} — ${trouble.why || 'no reason given'}.`,
    robotSteps(steps),
    allowed.length ? `Details you can type: ${allowed.map((k) => `[${k}]`).join(', ')}.` : '',
  ].filter((l) => l !== '').join('\n');
  return { kind: 'book', system, user };
}

/**
 * A site described in plain words, and a task on it — the beginning of booking
 * where no robot has been written: `site` is { name, description, start_url }
 * and the task is to check what is available (`kind: 'check'`, nothing booked)
 * or to book (`kind: 'book'`). `want` says what is wanted, in words or as
 * { what, where, from, to, time }.
 */
function siteTask({ site = {}, kind = 'check', want = {}, allowed = [], seconds = 300, maxSteps = 40 }) {
  const wantWords = typeof want === 'string' ? want : [
    want.what ? `What: ${want.what}.` : '',
    want.where ? `Where: ${want.where}.` : '',
    want.from || want.to ? `Between ${want.from || 'now'} and ${want.to || 'any time later'}.` : '',
    want.time ? `Time of day: ${want.time}.` : '',
  ].filter(Boolean).join(' ');
  const system = [
    'You work a web browser for a person, in the LineRight Regbot desktop app, on their own computer. The site and what',
    'to do on it are described below in plain words; nothing else about the site is known, so read each page carefully.',
    kind === 'check'
      ? 'Your task is to CHECK what appointments are available that match what is wanted, and report them. Do not book, '
        + 'hold or reserve anything: stop at the list of times.'
      : 'Your task is to BOOK one appointment that matches what is wanted: the earliest that does.',
    '',
    'Rules:',
    ...RULES.slice(1).map((r) => `- ${r}`),
    kind === 'check'
      ? '- Finish with checked and the findings (each: where, date YYYY-MM-DD, time HH:MM 24-hour) — an empty list if '
        + 'there is nothing; with human_check if a check blocks you; with failed if the site will not let you see.'
      : '- Finish with booked and the confirmation number exactly as shown, gone if nothing matching is offered, or failed.',
    `- You have about ${seconds} seconds and ${maxSteps} steps.`,
  ].join('\n');
  const user = [
    `Site: ${site.name || 'unnamed'}${site.start_url ? ` (${site.start_url})` : ''}.`,
    site.description ? `About the site and how booking works there:\n${site.description}` : '',
    `What is wanted: ${wantWords || 'any appointment'}.`,
    allowed.length ? `Details you can type: ${allowed.map((k) => `[${k}]`).join(', ')}.` : '',
  ].filter(Boolean).join('\n');
  return { kind: kind === 'book' ? 'book' : 'check', system, user };
}

module.exports = { overseeBooking, siteTask, dayWords, timeWords, RULES };
