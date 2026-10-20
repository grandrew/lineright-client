/**
 * Reading one day's times.
 *
 * The live calendar opens #time-selector on the same /select-date page. The
 * heading is painted immediately and the labels arrive later, and Cancel
 * closes the dialog without a history step. The stand-in instead navigates
 * to /times and comes back by a link. Both shapes are served here, because
 * a scout that reads the heading and calls history Back records no times
 * and then cannot click the next day.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { chromium } from 'playwright';
import { readOpenDay, scanCalendar } from '../src/bot.js';

const DIALOG = `<!doctype html><meta charset="utf-8"><title>Calendar</title>
<h1>October 2026</h1>
<button type="button">19 Open Times</button>
<button type="button">20 Open Times</button>
<button type="button">21 Open Times</button>
<div id="time-selector" hidden>
  <h2>Choose an Appointment Time</h2>
  <div id="loading-gif">Loading</div>
  <ul class="appt-dialog-times__list" hidden></ul>
  <p class="appt-dialog-times__no-times" hidden>Sorry, there are no available times for this date.</p>
  <button type="button" aria-label="Close this dialog window">Cancel</button>
</div>
<script>
  const days = {
    '19 Open Times': ['1:50 PM'],
    '20 Open Times': ['2:00 PM', '9:10 AM'],
    '21 Open Times': [],
  };
  const dialog = document.getElementById('time-selector');
  const loading = document.getElementById('loading-gif');
  const list = dialog.querySelector('.appt-dialog-times__list');
  const empty = dialog.querySelector('.appt-dialog-times__no-times');
  document.querySelector('[aria-label="Close this dialog window"]').addEventListener('click', () => {
    dialog.hidden = true;
  });
  for (const button of document.querySelectorAll('button')) {
    if (!/open times/i.test(button.textContent)) continue;
    button.addEventListener('click', () => {
      dialog.hidden = false;
      loading.hidden = false;
      list.hidden = true;
      list.replaceChildren();
      empty.hidden = true;
      const times = days[button.textContent.trim()] || [];
      setTimeout(() => {
        loading.hidden = true;
        if (!times.length) { empty.hidden = false; return; }
        list.hidden = false;
        times.forEach((time, i) => {
          const li = document.createElement('li');
          li.className = 'appt-dialog-time__slot';
          li.innerHTML = '<input type="radio" name="timeSelect" id="t' + i + '">'
            + '<label class="appt-dialog-time__label" for="t' + i + '"></label>';
          li.querySelector('label').textContent = time;
          list.appendChild(li);
        });
      }, 1000);
    });
  }
</script>`;

const NAV_CALENDAR = `<!doctype html><meta charset="utf-8"><title>Calendar</title>
<button type="button" onclick="location.href='/portal/appointments/times'">29 Open Times</button>`;

const TIMES = `<!doctype html><meta charset="utf-8"><title>Times</title>
<h2>Choose an appointment time</h2>
<button type="button" class="time">8:00 AM</button>
<a href="/portal/appointments/select-date?nav=1">Back to the calendar</a>`;

const OFFICES = `<!doctype html><meta charset="utf-8"><title>Offices</title>
<a href="/portal/appointments/select-date">Calendar</a>`;

// What a live month actually looks like when the scout records nothing.
// The heading says November. The first open cell's visible text is "1 Open
// Times", while a hidden span and the times request both say December 1.
// The label the dialog draws is "Invalid Date", so a reader of the label
// records no clock time even though /api/times returned some. Cancel hides
// the dialog and leaves the overlay over the next day.
const LIVE = `<!doctype html><meta charset="utf-8"><title>Calendar</title>
<style>
  .dialog-overlay { position: fixed; inset: 0; z-index: 1; }
  #time-selector { position: relative; z-index: 2; background: white; }
</style>
<div class="calendar"><span class="month">November 2026</span>
  <button type="button" data-date="2026-12-01">
    <span style="display:none">December 1, 2026</span>
    <span>1</span> Open Times
  </button>
  <button type="button" data-date="2026-10-29">
    <span style="display:none">October 29, 2026</span>
    <span>29</span> Open Times
  </button>
</div>
<div id="appointments-dialog-root">
  <div class="dialog-overlay" hidden></div>
  <div id="time-selector" hidden>
    <h2 id="time-selector-title__text">Choose an Appointment Time</h2>
    <label class="appt-dialog-time__label">Invalid Date</label>
    <button type="button" aria-label="Close this dialog window">Cancel</button>
  </div>
</div>
<script>
  const root = document.getElementById('appointments-dialog-root');
  const overlay = root.querySelector('.dialog-overlay');
  const dialog = document.getElementById('time-selector');
  const closeAll = () => {
    dialog.hidden = true;
    overlay.hidden = true;
    root.classList.remove('overlay-active');
  };
  dialog.querySelector('[aria-label="Close this dialog window"]').addEventListener('click', (event) => {
    event.stopPropagation();
    dialog.hidden = true;
  });
  overlay.addEventListener('click', closeAll);
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape') closeAll(); });
  for (const button of document.querySelectorAll('button[data-date]')) {
    button.addEventListener('click', async () => {
      root.classList.add('overlay-active');
      overlay.hidden = false;
      const response = await fetch('/api/times?date=' + button.dataset.date);
      await response.json();
      dialog.hidden = false;
    });
  }
</script>`;

function listen() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    let body = 'missing';
    if (url.pathname === '/offices') body = OFFICES;
    else if (url.pathname === '/portal/appointments/times') body = TIMES;
    else if (url.pathname === '/portal/appointments/select-date') {
      if (url.searchParams.get('nav')) body = NAV_CALENDAR;
      else if (url.searchParams.get('live')) body = LIVE;
      else body = DIALOG;
    } else if (url.pathname === '/api/times') {
      const date = url.searchParams.get('date');
      const times = date === '2026-12-01' ? ['08:00', '14:20'] : ['14:20'];
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(times));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(body);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, origin: `http://127.0.0.1:${port}` });
    });
  });
}

test('a late time dialog is read and closed without leaving the calendar', { timeout: 20000 }, async () => {
  const { server, origin } = await listen();
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(`${origin}/offices`);
    await page.getByRole('link', { name: 'Calendar' }).click();
    await page.waitForURL(/\/select-date$/);
    let departed = false;
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame() && !/\/select-date\b/.test(new URL(frame.url()).pathname)) {
        departed = true;
      }
    });

    const started = Date.now();
    assert.deepEqual((await readOpenDay(page, 0)).times, ['13:50']);
    assert.ok(Date.now() - started >= 700, 'read the heading before the time was drawn');
    assert.deepEqual((await readOpenDay(page, 1)).times, ['09:10', '14:00']);
    assert.deepEqual((await readOpenDay(page, 2)).times, []);
    assert.equal(departed, false);
    assert.match(page.url(), /\/portal\/appointments\/select-date$/);
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('a times document is read and the calendar link brings the scout back', { timeout: 20000 }, async () => {
  const { server, origin } = await listen();
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(`${origin}/portal/appointments/select-date?nav=1`);
    assert.deepEqual((await readOpenDay(page, 0)).times, ['08:00']);
    assert.match(page.url(), /\/select-date\?nav=1$/);
    await page.getByRole('button', { name: /29 open times/i }).waitFor({ state: 'visible' });
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('a live day is dated from the times response and the overlay does not block the next day', { timeout: 20000 }, async () => {
  const { server, origin } = await listen();
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(8000);
    await page.goto(`${origin}/portal/appointments/select-date?live=1`);
    const candidates = await scanCalendar(page, {
      calendarTimeoutMs: 5000,
      startDate: new Date(2026, 9, 1),
      endDate: new Date(2026, 11, 31),
    }, () => {}, 'Santa Clara');
    assert.deepEqual(candidates.map((c) => c.date.getMonth()), [9, 11]);
    assert.deepEqual(candidates.map((c) => c.date.getDate()), [29, 1]);

    const first = await readOpenDay(page, 0);
    assert.equal(first.date, '2026-12-01');
    assert.deepEqual(first.times, ['08:00', '14:20']);

    const started = Date.now();
    const second = await readOpenDay(page, 1);
    assert.ok(Date.now() - started < 8000, 'the overlay must not eat the next Open Times click');
    assert.equal(second.date, '2026-10-29');
    assert.deepEqual(second.times, ['14:20']);
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});
