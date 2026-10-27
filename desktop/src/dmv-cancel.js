'use strict';
/**
 * Cancel one appointment on the DMV's own "View/Cancel Appointment" page
 * (/portal/appointments/appt-edit — its confirmation page links there), in a
 * tab of the app, the way a person would, once the person has said yes in the
 * app (My Bookings → Cancel appointment). The steps:
 *
 *   1. the form "View Your Appointment Information" (#appointment-info-form):
 *      the first and last name and the phone number the appointment was booked
 *      under, from the profile kept on this computer; then "View Appointment";
 *   2. "Current Appointments": the one item whose `data-appt-id` is this
 *      appointment's confirmation number, and its "Cancel Appointment";
 *   3. the dialog (#delete-confirmation) — for a drive test, the licence number
 *      and date of birth it asks for too — and its "Cancel Appointment";
 *   4. "Your appointment has been canceled.", and that item gone: done.
 *
 * Only that one appointment is ever touched: an item is pressed only when its
 * confirmation number is exactly the one asked for. A human check the DMV puts
 * up is the person's to answer in the page; the script waits for it, up to its
 * time. The DMV's live page and the stand-in (lineright-server testsite,
 * apptEditPage) share these ids and words.
 *
 * The script answers:
 *   'cancelled'      the DMV said so
 *   'not-listed'     appointments are listed under that name and number, but not this one
 *   'none'           none at all are listed under them
 *   'error: …'       the DMV answered with an error
 *   'stopped …'      it ran out of time; where it got to
 */

/** The details the page is filled in with, from the profile: {first, last, phone, email, dl, dob}. */
function cancelValues(profile) {
  const v = profile || {};
  const digits = String(v.phone || '').replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');
  // The dialog's date of birth is mm/dd/yyyy; a profile keeps it as yyyy-mm-dd.
  const dob = /^\d{4}-\d{2}-\d{2}$/.test(String(v.dob || ''))
    ? `${v.dob.slice(5, 7)}/${v.dob.slice(8, 10)}/${v.dob.slice(0, 4)}` : String(v.dob || '');
  return {
    first: String(v.first_name || '').trim(), last: String(v.last_name || '').trim(),
    phone: digits, email: String(v.email || '').trim(),
    dl: String(v.dl_number || '').trim().toUpperCase(), dob,
  };
}

/** The script the cancel tab runs, for appointment `confirmation`. */
function cancelScript(confirmation, values, { timeoutMs = 150000 } = {}) {
  const want = { confirmation: String(confirmation || ''), ...values };
  return `(async () => {
    const want = ${JSON.stringify(want)};
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const shown = (el) => Boolean(el) && !el.hidden && el.getClientRects().length > 0
      && getComputedStyle(el).visibility !== 'hidden';
    const text = (el) => String((el && (el.innerText || el.textContent)) || '').replace(/\\s+/g, ' ').trim();
    const setValue = (box, value) => {
      const proto = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
      box.focus();
      if (proto && proto.set) proto.set.call(box, value); else box.value = value;
      box.dispatchEvent(new Event('input', { bubbles: true }));
      box.dispatchEvent(new Event('change', { bubbles: true }));
      box.dispatchEvent(new Event('blur', { bubbles: true }));
    };
    const fill = (selector, value) => {
      const box = document.querySelector(selector);
      if (!box || !value || !shown(box)) return false;
      const plain = (s) => String(s || '').replace(/\\D/g, '');
      const same = selector === '#phone-number' ? plain(box.value) === plain(value)
        : box.value.trim().toLowerCase() === String(value).toLowerCase();
      if (!same) setValue(box, value);
      return true;
    };
    const button = (root, pattern) => [...(root || document).querySelectorAll('button')]
      .find((b) => pattern.test(text(b)) && shown(b));
    const state = window.__lrCancel || (window.__lrCancel = { looked: 0, pressed: 0, confirmed: 0 });
    const deadline = Date.now() + ${Number(timeoutMs)};
    while (Date.now() < deadline) {
      const esc = window.CSS && CSS.escape ? CSS.escape(want.confirmation) : want.confirmation.replace(/"/g, '\\\\"');
      const item = document.querySelector('[data-appt-id="' + esc + '"]');
      const canceled = [...document.querySelectorAll('p')].some((p) => shown(p) && /your appointment has been cancel+ed/i.test(text(p)));
      if (state.confirmed && !item && canceled) return 'cancelled';
      const dialog = document.querySelector('#delete-confirmation');
      if (shown(dialog)) {
        fill('#dlNumber', want.dl);
        fill('#dob', want.dob);
        const yes = button(dialog, /^cancel appointment$/i);
        if (yes && !yes.disabled && state.pressed && !state.confirmed) {
          yes.click();
          state.confirmed = Date.now();
          await sleep(1500);
          continue;
        }
        await sleep(500);
        continue;
      }
      // The DMV's own errors, once it has been asked something.
      const trouble = state.looked && [...document.querySelectorAll('[role="dialog"], [role="alert"], .field-error, .dmv-modal')]
        .filter((el) => shown(el) && el !== dialog)
        .map(text).find((t) => /technical difficult|could ?n.?t find|not found|try again/i.test(t));
      if (trouble) return 'error: ' + trouble.slice(0, 200);
      if (item && !state.confirmed && (!state.pressed || Date.now() - state.pressed > 4000)) {
        const cancel = item.querySelector('.btn--appt-cancel') || button(item, /cancel appointment/i);
        if (cancel) {
          cancel.click();
          state.pressed = Date.now();
          await sleep(900);
          continue;
        }
      }
      const listing = document.querySelector('#appointment-current');
      const none = [...document.querySelectorAll('p')].some((p) => shown(p) && /no appointments available/i.test(text(p)));
      // Not there: said only when the page has shown it twice, a moment apart,
      // well after the lookup — not while the answer is still on its way.
      const verdict = !state.looked || item || state.confirmed || Date.now() - state.lookedAt < 4000 ? ''
        : document.querySelectorAll('[data-appt-id]').length ? 'not-listed' : none ? 'none' : '';
      if (verdict && state.seen === verdict && Date.now() - state.seenAt >= 1500) return verdict;
      if (verdict !== state.seen) { state.seen = verdict; state.seenAt = Date.now(); }
      const form = document.querySelector('#appointment-info-form');
      if (shown(form) && !item && state.looked < 2 && (!state.lookedAt || Date.now() - state.lookedAt > 8000)
          && !(shown(listing) && document.querySelectorAll('[data-appt-id]').length)) {
        fill('#first-name', want.first);
        fill('#last-name', want.last);
        fill('#phone-number', want.phone);
        await sleep(300);
        const go = button(form, /^view appointment$/i) || form.querySelector('[type="submit"]');
        if (go) {
          go.click();
          state.looked += 1;
          state.lookedAt = Date.now();
          await sleep(2500);
          continue;
        }
      }
      await sleep(500);
    }
    return 'stopped on ' + location.pathname + (state.confirmed ? ', after confirming the cancellation'
      : state.pressed ? ', at the DMV\\'s "Are you sure?"' : state.looked ? ', after looking the appointment up' : '');
  })()`;
}

module.exports = { cancelValues, cancelScript };
