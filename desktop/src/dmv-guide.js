'use strict';
/**
 * Walk a DMV booking tab from the appointment-type page to the allocated
 * office, date and time.
 *
 * The live site's link stops at the appointment type. Its own script then
 * opens the office map, with no office selected. This runs inside that page
 * and does the steps a person would: search the office, choose it, open the
 * day, and select the time. It does not press Confirm. The person books.
 */

const MONTHS = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
];

function isoFromCell(text) {
  const match = String(text || '').match(
    new RegExp(`\\b(${MONTHS.join('|')})\\s+(\\d{1,2}),\\s+(\\d{4})`, 'i')
  );
  if (!match) return null;
  const month = MONTHS.indexOf(match[1].toLowerCase());
  const day = Number(match[2]);
  const year = Number(match[3]);
  const date = new Date(Date.UTC(year, month, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month || date.getUTCDate() !== day) return null;
  return `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * The script the booking tab runs. It polls the page it is in, including
 * after the DMV app changes the address without loading a new document.
 * Returns 'time' once that time is selected, or a short reason it stopped.
 */
function guideScript(slot) {
  const wanted = {
    office: String(slot.office_name || ''),
    date: String(slot.date || ''),
    time: String(slot.time || ''),
  };
  return `(async () => {
    const wanted = ${JSON.stringify(wanted)};
    const months = ${JSON.stringify(MONTHS)};
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const isoFromCell = (text) => {
      const match = String(text || '').match(new RegExp('\\\\b(' + months.join('|') + ')\\\\s+(\\\\d{1,2}),\\\\s+(\\\\d{4})', 'i'));
      if (!match) return null;
      const month = months.indexOf(match[1].toLowerCase());
      const day = Number(match[2]);
      const year = Number(match[3]);
      return year + '-' + String(month + 1).padStart(2, '0') + '-' + String(day).padStart(2, '0');
    };
    const to24 = (text) => {
      const match = String(text || '').replace(/\\s+/g, ' ').trim().match(/^(\\d{1,2}):(\\d{2})\\s*([ap]m)?$/i);
      if (!match) return null;
      let hour = Number(match[1]);
      const minute = match[2];
      const ap = (match[3] || '').toLowerCase();
      if (ap === 'pm' && hour < 12) hour += 12;
      if (ap === 'am' && hour === 12) hour = 0;
      if (hour > 23 || Number(minute) > 59) return null;
      return String(hour).padStart(2, '0') + ':' + minute;
    };
    if (!window.__lrTimes) {
      window.__lrTimes = [];
      const orig = window.fetch.bind(window);
      window.fetch = function (...args) {
        const pending = orig(...args);
        try {
          const url = String((args[0] && args[0].url) || args[0] || '');
          if (/\\/times\\b/.test(url)) {
            pending.then((res) => res.clone().json()).then((body) => {
              const found = url.match(/date=(\\d{4}-\\d{2}-\\d{2})/);
              if (found && Array.isArray(body)) window.__lrTimes.push({ date: found[1], times: body });
            }).catch(() => {});
          }
        } catch { /* the page's own fetch still ran */ }
        return pending;
      };
    }
    const setValue = (box, value) => {
      const proto = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
      if (proto && proto.set) proto.set.call(box, value);
      else box.value = value;
      box.dispatchEvent(new Event('input', { bubbles: true }));
      box.dispatchEvent(new Event('change', { bubbles: true }));
    };
    const deadline = Date.now() + 50000;
    let monthsTurned = 0;
    while (Date.now() < deadline) {
      const path = location.pathname || '';
      if (/select-location/.test(path)) {
        const box = document.querySelector('#inputKeyWord');
        if (box && box.offsetParent !== null && box.value.trim().toLowerCase() !== wanted.office.toLowerCase()) {
          box.focus();
          setValue(box, wanted.office);
          box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
          const form = box.closest('form');
          if (form && form.requestSubmit) { try { form.requestSubmit(); } catch { /* no submit button */ } }
          await sleep(800);
        }
        const cards = [...document.querySelectorAll('li.location-results__list-item, li.search-card')];
        const escaped = wanted.office.replace(/[.*+?^$()|[\\]\\\\]/g, '\\\\$&');
        const card = cards.find((item) => new RegExp('\\\\b' + escaped + '\\\\b', 'i').test(item.innerText || ''));
        const button = card && [...card.querySelectorAll('button, a')].find((item) => /select location/i.test(item.innerText || ''));
        if (button) {
          button.click();
          await sleep(1200);
          continue;
        }
      }
      if (/select-date/.test(path)) {
        const labels = [...document.querySelectorAll('label.appt-dialog-time__label')];
        if (labels.length) {
          let label = labels.find((item) => to24(item.textContent) === wanted.time);
          if (!label) {
            const captured = [...window.__lrTimes].reverse().find((item) => item.date === wanted.date);
            const index = captured ? captured.times.indexOf(wanted.time) : -1;
            if (index >= 0) label = labels[index];
          }
          if (label) {
            label.click();
            return 'time';
          }
        }
        const buttons = [...document.querySelectorAll('[role="button"]')].filter((item) => /open times/i.test(item.textContent || ''));
        const day = buttons.find((item) => isoFromCell(item.textContent || '') === wanted.date);
        if (day) {
          day.click();
          await sleep(900);
          continue;
        }
        const next = [...document.querySelectorAll('button')].find((item) => /next month|^next$/i.test((item.getAttribute('aria-label') || item.textContent || '').trim()));
        if (next && monthsTurned < 8 && buttons.length) {
          monthsTurned += 1;
          next.click();
          await sleep(900);
          continue;
        }
      }
      await sleep(400);
    }
    return 'stopped on ' + location.pathname;
  })()`;
}

module.exports = { isoFromCell, guideScript };
