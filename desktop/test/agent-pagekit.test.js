'use strict';
/**
 * Reading a page for the AI (agent/pagekit.js), in a real browser: the text in
 * reading order, every control numbered and described, the numbers kept on the
 * page so an action finds its element again, and a long page cut where it
 * matters least.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// The browser the build bundles for the robots (scripts/bundle.js), when there
// is no other: a build machine has that one and none in Playwright's own cache.
const OS = { linux: 'linux', darwin: 'mac', win32: 'win' }[process.platform] || process.platform;
const BUNDLED = path.join(__dirname, '..', 'vendor', `${OS}-${process.arch}`, 'browsers');
if (!process.env.PLAYWRIGHT_BROWSERS_PATH && fs.existsSync(BUNDLED)) process.env.PLAYWRIGHT_BROWSERS_PATH = BUNDLED;

let chromium = null;
try { ({ chromium } = require('playwright')); } catch { /* no browser to test with */ }
const { READ_PAGE, refSelector, locateScript } = require('../src/agent/pagekit');

/** A browser, or the reason there is none: these tests then skip rather than fail. */
let browserProblem = chromium ? null : 'no Playwright';
test.before(async () => {
  if (!chromium) return;
  try {
    const b = await chromium.launch({ headless: true });
    await b.close();
  } catch (err) {
    browserProblem = `no browser to run: ${String(err.message).split('\n')[0]}`;
  }
});

const PAGE = `<!doctype html><meta charset="utf-8"><title>Your details</title>
<header><nav><a href="/portal/">Home</a> <a href="https://elsewhere.example/x">Elsewhere</a></nav></header>
<main>
  <h1>Your details</h1>
  <p>This appointment is held for you for <b>9:41</b>.</p>
  <div role="alert">Please enter a ten-digit phone number.</div>
  <form>
    <label for="fn">Given name</label><input id="fn" value="Ada" required>
    <label>Family name <input id="ln"></label>
    <input id="em" type="email" aria-label="Email" placeholder="you@example.com">
    <input id="pw" type="password" aria-label="Secret" value="hunter2">
    <select id="when" aria-label="When"><option>Morning</option><option selected>Afternoon</option></select>
    <label><input type="checkbox" id="sms" checked> Text me a reminder</label>
    <input type="hidden" name="token" value="abc">
    <button type="button" id="go" onclick="this.textContent='Done'">Review my details</button>
    <button type="button" disabled>Book this appointment</button>
    <div onclick="1" tabindex="0">A clickable card</div>
  </form>
  <p style="display:none">Hidden text</p>
  <iframe src="https://www.google.com/recaptcha/api2/anchor?k=x" style="width:1px;height:1px"></iframe>
  <dialog open aria-label="Times"><button>10:00 AM</button></dialog>
</main>`;

const read = (page, arg) => page.evaluate(`(${READ_PAGE})(${JSON.stringify(arg || {})})`);

test('a page as the AI reads it', async (t) => {
  if (browserProblem) return t.skip(browserProblem);
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  // Served from an address of its own, as a site is; nothing else is fetched.
  await page.route('**/*', (route) => (route.request().url().startsWith('https://dmv.test/')
    ? route.fulfill({ contentType: 'text/html', body: PAGE }) : route.abort()));
  await page.goto('https://dmv.test/portal/appointments/details');
  const got = await read(page);
  const text = got.text;
  assert.equal(got.title, 'Your details');
  assert.match(text, /^# Your details$/m);
  assert.match(text, /This appointment is held for you for 9:41\./);
  assert.match(text, /^! Please enter a ten-digit phone number\.$/m, 'an alert is marked');
  assert.match(text, /\[\d+\] textbox "Given name" value="Ada" required/);
  assert.match(text, /\[\d+\] textbox "Family name" empty/);
  assert.match(text, /\[\d+\] textbox email "Email" empty/);
  assert.match(text, /\[\d+\] textbox password "Secret" value=\(hidden\)/, 'a password is never read out');
  assert.ok(!text.includes('hunter2'));
  assert.match(text, /\[\d+\] select "When" value="Afternoon" options: Morning \| Afternoon/);
  assert.match(text, /\[\d+\] checkbox "Text me a reminder" checked/);
  assert.match(text, /\[\d+\] button "Review my details"/);
  assert.match(text, /\[\d+\] button "Book this appointment" disabled/);
  assert.match(text, /\[\d+\] clickable "A clickable card"/);
  assert.match(text, /\[\d+\] link "Home" -> \/portal\//);
  assert.match(text, /\[\d+\] link "Elsewhere" -> elsewhere\.example/);
  assert.ok(!/human check/.test(text), 'an invisible captcha asks nothing of anybody');
  assert.match(text, /\[dialog "Times"\]\n\[\d+\] button "10:00 AM"\n\[end of dialog\]/);
  assert.ok(!text.includes('Hidden text'));
  assert.ok(!text.includes('token'), 'a hidden input is not a control');
  assert.equal(text.match(/Given name/g).length, 1, 'a label is said once, as its control\'s name');
  assert.equal(text.match(/Text me a reminder/g).length, 1);
  assert.equal(text.match(/A clickable card/g).length, 1);
  const order = ['# Your details', 'held for you', 'Given name', 'Family name', 'Review my details'].map((w) => text.indexOf(w));
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'in reading order');

  // The numbers stay with their elements, and find them again.
  const ref = Number(/\[(\d+)\] button "Review my details"/.exec(text)[1]);
  await page.click(refSelector(ref));
  assert.equal(await page.textContent('#go'), 'Done');
  const again = await read(page);
  assert.match(again.text, new RegExp(`\\[${ref}\\] button "Done"`), 'the same number on a second look');
  const where = await page.evaluate(`(${locateScript()})(${JSON.stringify(refSelector(ref))})`);
  assert.ok(where.x > 0 && where.y > 0 && where.tag === 'BUTTON');
});

test('a captcha showing a challenge is a human check', async (t) => {
  if (browserProblem) return t.skip(browserProblem);
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.route('**/*', (route) => (route.request().url().startsWith('https://dmv.test/')
    ? route.fulfill({ contentType: 'text/html', body: '<h1>Dates</h1><iframe src="https://www.google.com/recaptcha/api2/bframe?k=x" style="width:400px;height:580px"></iframe>' })
    : route.abort()));
  await page.goto('https://dmv.test/portal/appointments/select-date');
  assert.match((await read(page)).text, /\[a human check \(captcha\) is showing on this page: it is for the person to answer\]/);
});

test('a long page keeps its controls and drops plain text', async (t) => {
  if (browserProblem) return t.skip(browserProblem);
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const filler = Array.from({ length: 200 }, (_, i) => `<p>Paragraph ${i} ${'words '.repeat(30)}</p>`).join('');
  await page.setContent(`<h1>Long</h1>${filler}<button>At the very end</button>`);
  const got = await read(page, { max: 3000 });
  assert.ok(got.text.length < 3600, `${got.text.length} chars`);
  assert.match(got.text, /button "At the very end"/);
  assert.match(got.text, /^# Long/);
  assert.match(got.text, /lines of plain text left out/);
});

test('a number that is not one', () => {
  assert.equal(refSelector(12), '[data-lr-ref="12"]');
  assert.equal(refSelector('7'), '[data-lr-ref="7"]');
  for (const bad of [0, -1, 'x', '1"] , body', 1.5, null]) assert.throws(() => refSelector(bad));
});
