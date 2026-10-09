'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const confirmations = require('../src/confirmations');

const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'regbot-confirmations-'));

test('the picture of a confirmation is shown on a page that says what it is', () => {
  const at = dir();
  const shot = path.join(at, '127.0.0.1_5000_rqp1-job-77.png');
  fs.writeFileSync(shot, 'png');
  const file = confirmations.page({ shot, confirmation: 'TS-1A2B3C4D', where: 'REAL ID — Poway <b>, 2026-10-06',
    url: 'https://www.dmv.ca.gov/portal/appointments/confirmation' });
  assert.equal(file, path.join(at, '127.0.0.1_5000_rqp1-job-77.html'));
  const html = fs.readFileSync(file, 'utf8');
  assert.match(html, /TS-1A2B3C4D/);
  assert.match(html, /<img src="127\.0\.0\.1_5000_rqp1-job-77\.png"/);
  assert.match(html, /Poway &lt;b&gt;/, 'what the site sent is text, never markup');
  assert.match(html, /href="https:\/\/www\.dmv\.ca\.gov\/portal\/appointments\/confirmation"/);
});

test('no picture, no page; an address that is not a web page is left out', () => {
  const at = dir();
  assert.equal(confirmations.page({ shot: path.join(at, 'none.png'), confirmation: 'TS-1' }), null);
  assert.equal(confirmations.page({ shot: null, confirmation: 'TS-1' }), null);
  const shot = path.join(at, 'x.png');
  fs.writeFileSync(shot, 'png');
  assert.doesNotMatch(fs.readFileSync(confirmations.page({ shot, confirmation: 'TS-1', url: 'javascript:alert(1)' }), 'utf8'), /href=/);
});

test('only the newest pictures are kept', () => {
  const at = dir();
  for (let i = 0; i < 5; i += 1) {
    const file = path.join(at, `${i}.png`);
    fs.writeFileSync(file, 'png');
    fs.utimesSync(file, new Date(1e12 + i * 1000), new Date(1e12 + i * 1000));
  }
  assert.equal(confirmations.prune(at, 2), 3);
  assert.deepEqual(fs.readdirSync(at).sort(), ['3.png', '4.png']);
  assert.equal(confirmations.prune(path.join(at, 'missing')), 0);
});
