'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { webPage, paymentPage, approvalPage } = require('../src/links');

test('only web pages go to the browser', () => {
  for (const url of ['https://regbot.example/pair', 'http://127.0.0.1:5000/']) assert.equal(webPage(url), true, url);
  for (const url of ['file:///etc/passwd', 'smb://evil/share', 'ms-msdt:/id', 'javascript:alert(1)', 'vscode://x',
    '', null, undefined, 'not a url']) {
    assert.equal(webPage(url), false, String(url));
  }
});

test("a payment page is Stripe's — or on this machine, for a site on this machine", () => {
  const pub = 'https://regbot.example';
  const local = 'http://127.0.0.1:5000';
  const stripe = 'https://checkout.stripe.com/c/pay/cs_test_1#fid';
  assert.equal(paymentPage(stripe, pub), stripe);
  assert.equal(paymentPage(stripe, local), stripe);
  for (const url of ['http://checkout.stripe.com/c/pay/x', 'https://checkout.stripe.com.evil.example/c/pay',
    'https://evil.example/pay', 'http://127.0.0.1:12111/c/pay/cs_test_1', 'file:///tmp/pay.html', '']) {
    assert.equal(paymentPage(url, pub), null, url);
  }
  assert.equal(paymentPage('http://127.0.0.1:12111/c/pay/cs_test_1', local), 'http://127.0.0.1:12111/c/pay/cs_test_1');
  assert.equal(paymentPage('http://localhost:12111/c/pay/cs', 'http://[::1]:5000'), 'http://localhost:12111/c/pay/cs');
  for (const url of ['https://evil.example/pay', 'file:///tmp/pay.html', 'smb://127.0.0.1/share']) {
    assert.equal(paymentPage(url, local), null, url);
  }
  assert.equal(paymentPage(stripe, 'not a url'), null);
});

test('a sign-in is approved on the site the app signs in to', () => {
  const site = 'http://127.0.0.1:5000';
  assert.deepEqual(
    approvalPage({ verifyUrl: `${site}/pair?code=ABCD-1234`, siteUrl: site, code: 'ABCD-1234' }, `${site}/`),
    { verifyUrl: `${site}/pair?code=ABCD-1234`, siteUrl: site });
  assert.deepEqual(
    approvalPage({ verifyUrl: 'https://evil.example/pair?code=ABCD-1234', siteUrl: 'smb://evil', code: 'AB CD' }, site),
    { verifyUrl: `${site}/pair?code=AB%20CD`, siteUrl: site });
  assert.deepEqual(approvalPage({ code: 'X' }, site), { verifyUrl: `${site}/pair?code=X`, siteUrl: site });
});

test('the app page runs its own scripts and nothing else', () => {
  const ui = path.join(__dirname, '..', 'ui');
  const html = fs.readFileSync(path.join(ui, 'index.html'), 'utf8');
  const csp = (html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/) || [])[1] || '';
  const rules = Object.fromEntries(csp.split(';').map((r) => r.trim().split(/\s+/)).filter((r) => r[0])
    .map(([name, ...values]) => [name, values]));
  assert.deepEqual(rules['default-src'], ["'none'"]);
  assert.deepEqual(rules['script-src'], ["'self'"], 'no inline script, no eval');
  assert.ok(!('connect-src' in rules), 'the page fetches nothing itself: it asks the app');
  assert.deepEqual(rules['form-action'], ["'none'"]);
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)/, 'no inline script in the page');
  for (const file of ['index.html', 'app.js', 'charts.js']) {
    assert.doesNotMatch(fs.readFileSync(path.join(ui, file), 'utf8'), /<[a-z][^>]*\son[a-z]+=/i,
      `${file} draws no handler attributes, which the policy would stop`);
  }
});
