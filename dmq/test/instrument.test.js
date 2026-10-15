import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { EventEmitter } from 'events';

import { instrument, redact, redactUrl, redactBody } from '../src/instrument.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'rqp-trace-'));
const read = (dir) => fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const settle = () => new Promise((r) => setImmediate(r));

function fakePage(url = 'about:blank') {
  const page = new EventEmitter();
  const frame = { url: () => page.at };
  Object.assign(page, { at: url, url: () => page.at, mainFrame: () => frame, frame });
  return page;
}

const request = ({ url, method = 'GET', rtype = 'xhr', headers = {}, postData = null, failure = null }) => ({
  url: () => url, method: () => method, resourceType: () => rtype, headers: () => headers,
  postData: () => postData, failure: () => failure,
});
const response = (req, { status = 200, mime = 'application/json', body = '' } = {}) => ({
  request: () => req, status: () => status, url: () => req.url(), headers: () => ({ 'content-type': mime }),
  text: async () => body,
});

function fakeContext() {
  const context = new EventEmitter();
  const traced = { started: null, stopped: null };
  context.pages = () => [];
  context.tracing = {
    start: async (opts) => { traced.started = opts; },
    stop: async ({ path: to }) => { traced.stopped = to; fs.writeFileSync(to, 'zip'); },
  };
  return { context, traced };
}

test('without a folder nothing is kept, and nothing is asked of the browser', async () => {
  const { context, traced } = fakeContext();
  const probe = await instrument(context, {});
  probe.note('START', 'x');
  await probe.stop();
  assert.equal(traced.started, null);
  assert.equal(context.listenerCount('page'), 0);
});

test('a run keeps its network, its console and its steps, with the secrets struck out', async () => {
  const dir = tmp();
  const { context, traced } = fakeContext();
  const probe = await instrument(context, { dir, screenshots: true, title: 'book RID' });
  assert.deepEqual(traced.started, { screenshots: true, snapshots: true, sources: false, title: 'book RID' });
  const page = fakePage('https://dmv.example/portal/appointments/');
  context.emit('page', page);

  probe.note('TARGETED', 'Poway 2026-10-19 14:00');
  const doc = request({ url: 'https://dmv.example/portal/appointments/select-appointment-type?option=RID', rtype: 'document' });
  page.emit('request', doc);
  page.emit('response', response(doc, { mime: 'text/html; charset=UTF-8', body: '<html><body>Pick a service</body></html>' }));
  const dates = request({ url: 'https://dmv.example/wp-json/dmv/v1/appointment/branches/X/dates?token=abc123&services[]=RID',
    headers: { cookie: 'sid=1', accept: 'application/json' } });
  page.emit('request', dates);
  page.emit('response', response(dates, { body: JSON.stringify([{ date: '2026-10-19' }]) }));
  const book = request({ url: 'https://dmv.example/wp-json/dmv/v1/appointment/confirm-appointment', method: 'POST',
    headers: { 'content-type': 'application/json' },
    postData: JSON.stringify({ firstName: 'Ada', emailAddress: 'ada@example.test', dlNumber: 'D1234567', birthDate: '1990-12-10', token: 'tok' }) });
  page.emit('request', book);
  page.emit('requestfailed', request({ url: 'https://maps.example/tile.png', rtype: 'image', failure: { errorText: 'net::ERR_ABORTED' } }));
  page.at = 'https://dmv.example/portal/appointments/select-date';
  page.emit('framenavigated', page.frame);
  page.emit('console', { type: () => 'error', text: () => 'reCAPTCHA failed' });
  page.emit('pageerror', new Error('boom'));
  await settle(); await settle();
  await probe.stop();

  const events = read(dir);
  const of = (type) => events.filter((e) => e.type === type);
  assert.equal(of('step')[0].tag, 'TARGETED');
  assert.equal(of('response')[0].file, 'doc-1.html', 'a document is kept whole, beside the log');
  assert.equal(fs.readFileSync(path.join(dir, 'doc-1.html'), 'utf8'), '<html><body>Pick a service</body></html>');
  const sent = of('request').find((e) => e.method === 'POST');
  const body = JSON.parse(sent.postData);
  assert.equal(body.firstName, 'Ada');
  assert.equal(body.emailAddress, 'ada@example.test');
  assert.match(body.dlNumber, /^‹redacted/);
  assert.match(body.birthDate, /^‹redacted/);
  assert.match(body.token, /^‹redacted/);
  const asked = of('request').find((e) => /dates/.test(e.url));
  assert.doesNotMatch(asked.url, /abc123/, 'a token in the address is struck out');
  assert.match(asked.headers.cookie, /^‹redacted/);
  assert.equal(asked.headers.accept, 'application/json');
  assert.deepEqual(JSON.parse(of('response').find((e) => /dates/.test(e.url)).body), [{ date: '2026-10-19' }]);
  assert.equal(of('failed')[0].error, 'net::ERR_ABORTED');
  assert.equal(of('navigated')[0].url, 'https://dmv.example/portal/appointments/select-date');
  assert.deepEqual([of('console')[0].level, of('console')[0].text], ['error', 'reCAPTCHA failed']);
  assert.equal(of('pageerror')[0].message, 'boom');
  assert.equal(events.at(-1).type, 'end');
  assert.equal(traced.stopped, path.join(dir, 'trace.zip'));
});

test('redaction strikes out what matters and keeps the rest', () => {
  assert.deepEqual(redact({ password: 'hunter2', nested: [{ ssn: '000-00-0000', office: 'Poway' }], n: 3 }),
    { password: '‹redacted, 7 chars›', nested: [{ ssn: '‹redacted, 11 chars›', office: 'Poway' }], n: 3 });
  assert.equal(redactUrl('https://x.example/a?g-recaptcha-response=xyz&q=Poway'),
    'https://x.example/a?g-recaptcha-response=%E2%80%B9redacted%2C+3+chars%E2%80%BA&q=Poway');
  assert.equal(redactUrl('not a url'), 'not a url');
  assert.equal(redactBody('user=ada&password=hunter2', 'application/x-www-form-urlencoded'),
    'user=ada&password=%E2%80%B9redacted%2C+7+chars%E2%80%BA');
  assert.match(redactBody('x'.repeat(70000)), /more chars›$/);
});
