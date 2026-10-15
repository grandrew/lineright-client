'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { Logbook } = require('../src/logbook');
const { watchTab, MARK, WORLD, SNAPSHOT, RECORDER } = require('../src/pagelog');

const settle = () => new Promise((r) => setImmediate(r));

function fakeTab({ attachFails = false, bodies = {} } = {}) {
  const dbg = new EventEmitter();
  const commands = [];
  Object.assign(dbg, {
    attach: () => { if (attachFails) throw new Error('Another debugger is already attached'); },
    detach: () => {},
    sendCommand: async (method, params) => {
      commands.push({ method, params });
      if (method === 'Network.getResponseBody') {
        if (!bodies[params.requestId]) throw new Error('No resource with given identifier found');
        return bodies[params.requestId];
      }
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'F1' } } };
      if (method === 'Page.getResourceContent') return { content: `<html>read back: ${params.url}</html>`, base64Encoded: false };
      return {};
    },
  });
  const wc = new EventEmitter();
  const worlds = [];
  let destroyed = false;
  let html = '<html><body><input id="inputKeyWord" value="Poway"></body></html>';
  Object.assign(wc, {
    debugger: dbg,
    isDestroyed: () => destroyed,
    isLoading: () => false,
    getURL: () => 'https://dmv.example/portal/appointments/select-date',
    getTitle: () => 'Appointments',
    executeJavaScriptInIsolatedWorld: async (world, scripts) => {
      worlds.push({ world, code: scripts[0].code });
      return scripts[0].code === SNAPSHOT ? html : 'installed';
    },
    destroy: () => { destroyed = true; wc.emit('destroyed'); },
    setHtml: (next) => { html = next; },
  });
  const tab = { id: 4, kind: 'handoff', jobId: 77, url: 'https://dmv.example/portal/appointments/', view: { webContents: wc } };
  return { tab, wc, dbg, commands, worlds };
}

function harness(options) {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'regbot-pagelog-')), 'logs');
  const logbook = new Logbook({ dir });
  const timers = [];
  const fake = fakeTab(options);
  const watcher = watchTab(fake.tab, { logbook, setTimeout: (fn) => { timers.push(fn); return timers.length; }, clearTimeout: () => {} });
  const records = () => fs.readFileSync(logbook.file('pages', 'jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const flush = async () => { while (timers.length) await timers.shift()(); await settle(); };
  return { ...fake, logbook, watcher, records, flush, dir };
}

test('a tab\'s network is written down from outside the page: requests, answers, bodies, failures', async () => {
  const h = harness({ bodies: {
    'r1': { body: '<html>the type page</html>', base64Encoded: false },
    'r2': { body: JSON.stringify([{ date: '2026-10-19', token: 'abc' }]), base64Encoded: false },
  } });
  assert.deepEqual(h.commands[0], { method: 'Network.enable', params: { maxPostDataSize: 65536 } });
  const send = (method, params) => h.dbg.emit('message', {}, method, params);
  send('Network.requestWillBeSent', { requestId: 'r1', type: 'Document',
    request: { method: 'GET', url: 'https://dmv.example/portal/appointments/select-appointment-type?option=RID', headers: { Cookie: 'sid=1' } } });
  send('Network.responseReceived', { requestId: 'r1', type: 'Document',
    response: { status: 200, url: 'https://dmv.example/portal/appointments/select-appointment-type?option=RID', mimeType: 'text/html', headers: {} } });
  send('Network.loadingFinished', { requestId: 'r1' });
  send('Network.requestWillBeSent', { requestId: 'r2', type: 'XHR',
    request: { method: 'POST', url: 'https://dmv.example/wp-json/dmv/v1/appointment/dates?token=t0k', headers: { 'Content-Type': 'application/json' },
      postData: JSON.stringify({ firstName: 'Ada', dlNumber: 'D1234567' }) } });
  send('Network.responseReceived', { requestId: 'r2', type: 'XHR',
    response: { status: 200, url: 'https://dmv.example/wp-json/dmv/v1/appointment/dates', mimeType: 'application/json', headers: { 'Set-Cookie': 'x=1' } } });
  send('Network.loadingFinished', { requestId: 'r2' });
  send('Network.requestWillBeSent', { requestId: 'r3', type: 'Image', request: { method: 'GET', url: 'https://maps.example/t.png', headers: { a: 'b' } } });
  send('Network.loadingFailed', { requestId: 'r3', type: 'Image', errorText: 'net::ERR_BLOCKED_BY_CLIENT', blockedReason: 'inspector' });
  await settle(); await settle();

  const all = h.records();
  const of = (type) => all.filter((r) => r.type === type);
  assert.equal(all[0].type, 'opened');
  assert.equal(all[0].network, true);
  assert.deepEqual([all[0].tab, all[0].kind, all[0].job], [4, 'handoff', 77]);
  const doc = of('body').find((r) => r.id === 'r1');
  assert.match(doc.file, /^pages[\\/]\d{4}-\d{2}-\d{2}[\\/].*-tab4-doc1\.html$/);
  assert.match(fs.readFileSync(path.join(h.dir, doc.file), 'utf8'), /<html>the type page<\/html>/);
  const posted = of('request').find((r) => r.id === 'r2');
  assert.equal(JSON.parse(posted.postData).firstName, 'Ada');
  assert.match(JSON.parse(posted.postData).dlNumber, /^‹redacted/);
  assert.doesNotMatch(posted.url, /t0k/);
  assert.match(of('request').find((r) => r.id === 'r1').headers.Cookie, /^‹redacted/);
  assert.match(of('response').find((r) => r.id === 'r2').headers['Set-Cookie'], /^‹redacted/);
  const data = JSON.parse(of('body').find((r) => r.id === 'r2').body);
  assert.equal(data[0].date, '2026-10-19');
  assert.match(data[0].token, /^‹redacted/);
  assert.equal(of('request').find((r) => r.id === 'r3').headers, undefined, 'an image is a line, not its headers');
  assert.deepEqual(of('failed')[0], { ...of('failed')[0], url: 'https://maps.example/t.png', error: 'net::ERR_BLOCKED_BY_CLIENT', blocked: 'inspector' });
});

test('where the tab goes, what was clicked and changed, and the page after each step', async () => {
  const h = harness();
  h.wc.emit('did-start-navigation', { url: 'https://dmv.example/portal/appointments/select-date', isMainFrame: true, isSameDocument: false });
  h.wc.emit('did-navigate', {}, 'https://dmv.example/portal/appointments/select-date', 200, 'OK');
  h.wc.emit('did-finish-load', {});
  await h.flush();
  assert.ok(h.worlds.every((w) => w.world === WORLD), 'only ever in a world of its own');
  assert.ok(h.worlds.some((w) => w.code === RECORDER), 'the recorder is put in on each load');
  h.wc.emit('console-message', { level: 'debug', message: `${MARK}${JSON.stringify({ action: 'click', target: { tag: 'button', text: 'Select Location' } })}` });
  h.wc.emit('console-message', {}, 2, 'reCAPTCHA timed out', 12, 'https://dmv.example/app.js');
  h.wc.setHtml('<html><body>the calendar</body></html>');
  await h.flush();
  h.wc.emit('did-navigate-in-page', {}, 'https://dmv.example/portal/appointments/select-date', true);
  await h.flush();   // the same page as before: not copied twice
  h.wc.emit('did-fail-load', {}, -3, 'ERR_ABORTED', 'https://dmv.example/x', true);
  h.wc.emit('did-fail-load', {}, -105, 'ERR_NAME_NOT_RESOLVED', 'https://nowhere.example/', true);
  h.watcher.note('autofill', { filled: 2, fields: [{ key: 'first_name', how: 'label' }] });
  h.wc.destroy();
  h.watcher.note('card', { card: 'booked' });
  await settle();

  const all = h.records();
  const types = all.map((r) => r.type);
  assert.deepEqual(types.filter((t) => ['navigating', 'navigated', 'loaded'].includes(t)), ['navigating', 'navigated', 'loaded', 'navigated']);
  assert.equal(all.find((r) => r.type === 'navigated').status, 200);
  assert.deepEqual(all.find((r) => r.type === 'action').target, { tag: 'button', text: 'Select Location' });
  const consoleLine = all.find((r) => r.type === 'console');
  assert.deepEqual([consoleLine.level, consoleLine.text, consoleLine.line], [2, 'reCAPTCHA timed out', 12]);
  const snaps = all.filter((r) => r.type === 'snapshot');
  assert.equal(snaps.length, 2, 'the page as loaded, and after the click; the same page again is not copied');
  assert.match(fs.readFileSync(path.join(h.dir, snaps[1].file), 'utf8'), /the calendar/);
  assert.match(fs.readFileSync(path.join(h.dir, snaps[1].file), 'utf8'), /^<!-- https:\/\/dmv\.example\/portal\/appointments\/select-date -->/);
  assert.deepEqual(all.filter((r) => r.type === 'load-failed').map((r) => r.code), [-105], 'a load replaced by another is not a failure');
  assert.equal(all.find((r) => r.type === 'autofill').filled, 2);
  assert.equal(types.at(-1), 'closed', 'nothing is written after the tab has gone');
});

test('a first document the network did not keep is read back from the page once it has loaded', async () => {
  const h = harness();
  const send = (method, params) => h.dbg.emit('message', {}, method, params);
  const url = 'https://dmv.example/portal/appointments/';
  send('Network.requestWillBeSent', { requestId: 'd1', type: 'Document', request: { method: 'GET', url, headers: {} } });
  send('Network.responseReceived', { requestId: 'd1', type: 'Document', response: { status: 200, url, mimeType: 'text/html', headers: {} } });
  send('Network.loadingFinished', { requestId: 'd1' });
  await settle(); await settle(); await settle();
  const body = h.records().find((r) => r.type === 'body');
  assert.ok(body && body.file, JSON.stringify(h.records()));
  assert.match(fs.readFileSync(path.join(h.dir, body.file), 'utf8'), /read back: https:\/\/dmv\.example\/portal\/appointments\//);
  assert.ok(h.commands.some((c) => c.method === 'Page.getResourceContent' && c.params.frameId === 'F1'));
});

test('with the network closed to it, the page is still written down', async () => {
  const h = harness({ attachFails: true });
  h.wc.emit('did-navigate', {}, 'https://dmv.example/', 200, 'OK');
  const all = h.records();
  assert.equal(all[0].type, 'network-off');
  assert.match(all[0].why, /already attached/);
  assert.equal(all.find((r) => r.type === 'opened').network, false);
  assert.ok(all.some((r) => r.type === 'navigated'));
});
