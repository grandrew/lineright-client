'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Logbook, redact, redactUrl, redactBody, redactHeaders } = require('../src/logbook');

const DAY = 24 * 60 * 60 * 1000;
const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'regbot-logbook-')), 'logs');
const age = (file, days, now = Date.now()) => {
  const at = new Date(now - days * DAY);
  fs.utimesSync(file, at, at);
};

test('lines and records go into the day\'s files, and nothing written has a secret in it', () => {
  const dir = tmp();
  const at = new Date(2026, 9, 14, 17, 55, 12, 123).getTime();
  const book = new Logbook({ dir, now: () => at });
  book.line('app', 'booked Poway — confirmation TS-1');
  book.event('site', { method: 'POST', path: '/api/client/pair', reply: { token: 'abc123secret', user: { nickname: 'ada' } } });
  assert.match(fs.readFileSync(path.join(dir, 'app-2026-10-14.log'), 'utf8'), /Z booked Poway — confirmation TS-1\n$/);
  const record = JSON.parse(fs.readFileSync(path.join(dir, 'site-2026-10-14.jsonl'), 'utf8'));
  assert.equal(record.reply.user.nickname, 'ada');
  assert.equal(record.reply.token, '‹redacted, 12 chars›');
  assert.equal(record.t, new Date(at).toISOString());
  const kept = book.keep(['pages', book.day()], 'tab3-page1.html', '<html></html>');
  assert.equal(kept, path.join('pages', '2026-10-14', '20261014-175512-123-tab3-page1.html'));
  assert.equal(fs.readFileSync(path.join(dir, kept), 'utf8'), '<html></html>');
  assert.equal(path.basename(book.runDir('robots', 'book job77')), '20261014-175512-123-book_job77');
});

test('what is older than the days kept goes, a run or a day at a time, and the rest stays', () => {
  const dir = tmp();
  const book = new Logbook({ dir, keepDays: 3 });
  book.line('app', 'today');
  const old = path.join(dir, 'app-2026-10-01.log');
  fs.writeFileSync(old, 'old\n');
  age(old, 4);
  const oldRun = book.runDir('robots', 'scout-old');
  fs.writeFileSync(path.join(oldRun, 'run.json'), '{}');
  age(path.join(oldRun, 'run.json'), 5);
  age(oldRun, 5);
  const newRun = book.runDir('robots', 'book-new');
  fs.writeFileSync(path.join(newRun, 'run.json'), '{}');
  const oldDay = path.join(dir, 'pages', '2026-10-01');
  fs.mkdirSync(oldDay, { recursive: true });
  fs.writeFileSync(path.join(oldDay, 'a.html'), 'x');
  age(path.join(oldDay, 'a.html'), 4);
  age(oldDay, 4);

  book.prune();
  assert.equal(fs.existsSync(old), false, 'an old day\'s file');
  assert.equal(fs.existsSync(oldRun), false, 'an old run, folder and all');
  assert.equal(fs.existsSync(oldDay), false, 'an old day of pages');
  assert.equal(fs.existsSync(path.join(newRun, 'run.json')), true);
  assert.equal(fs.existsSync(book.file('app')), true);

  // Kept for a day only: the file of four days ago went, and two days ago goes now.
  const two = path.join(dir, 'app-2026-10-12.log');
  fs.writeFileSync(two, 'x\n');
  age(two, 2);
  assert.equal(book.setKeepDays(1), 1);
  book.prune();
  assert.equal(fs.existsSync(two), false);
  assert.equal(Logbook.days('nonsense'), 3);
  assert.equal(Logbook.days(0), 3);
  assert.equal(Logbook.days(90), 30);
});

test('past the size it may take, the oldest goes first, whatever its age', () => {
  const dir = tmp();
  const book = new Logbook({ dir, keepDays: 30, maxBytes: 2500 });
  const files = ['a', 'b', 'c'].map((name, i) => {
    const file = path.join(dir, `${name}.log`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, 'x'.repeat(1000));
    age(file, 3 - i);
    return file;
  });
  const left = book.prune();
  assert.deepEqual(files.map((f) => fs.existsSync(f)), [false, true, true]);
  assert.equal(left.bytes, 2000);
});

test('a folder deleted under it is made again, and an unwritable one is no reason to stop', () => {
  const dir = tmp();
  const book = new Logbook({ dir });
  book.line('app', 'one');
  fs.rmSync(dir, { recursive: true, force: true });
  book.line('app', 'two');
  assert.match(fs.readFileSync(book.file('app'), 'utf8'), /two/);
  const blocked = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'regbot-logbook-')), 'file');
  fs.writeFileSync(blocked, 'not a folder');
  const nowhere = new Logbook({ dir: path.join(blocked, 'logs') });
  nowhere.line('app', 'lost');
  nowhere.event('site', { a: 1 });
  assert.equal(nowhere.keep(['pages'], 'x.html', 'x'), null);
  assert.equal(nowhere.runDir('robots', 'x'), null);
  assert.doesNotThrow(() => nowhere.prune());
  assert.throws(() => new Logbook({ dir: 'relative/logs' }), /absolute/);
});

test('what counts as a secret is struck out, in records, addresses, bodies and headers', () => {
  assert.deepEqual(redact({ firstName: 'Ada', email: 'ada@example.test', dlNumber: 'D1234567', birthDate: '1990-12-10',
    password: 'x', nested: { authorization: 'Bearer t', office: 'Poway' }, list: [{ ssn: '000-00-0000' }] }), {
    firstName: 'Ada', email: 'ada@example.test', dlNumber: '‹redacted, 8 chars›', birthDate: '‹redacted, 10 chars›',
    password: '‹redacted, 1 chars›', nested: { authorization: '‹redacted, 8 chars›', office: 'Poway' },
    list: [{ ssn: '‹redacted, 11 chars›' }],
  });
  assert.deepEqual(redact({ passed: 2, passes: 'kept', pass: 'gone' }), { passed: 2, passes: 'kept', pass: '‹redacted, 4 chars›' });
  assert.doesNotMatch(redactUrl('https://dmv.example/dates?token=abc&services[]=RID'), /abc/);
  assert.match(redactUrl('https://dmv.example/dates?token=abc&services[]=RID'), /services%5B%5D=RID|services\[\]=RID/);
  assert.equal(JSON.parse(redactBody('{"apptId":"123","dlNumber":"D1"}', 'application/json')).dlNumber, '‹redacted, 2 chars›');
  assert.match(redactBody('a=1&captcha=xyz', 'application/x-www-form-urlencoded'), /^a=1&captcha=%E2%80%B9/);
  assert.equal(redactBody('plain text'), 'plain text');
  assert.deepEqual(redactHeaders({ Cookie: 'sid=1', Accept: 'text/html' }), { Cookie: '‹redacted, 5 chars›', Accept: 'text/html' });
});
