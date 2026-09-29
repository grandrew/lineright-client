'use strict';
/**
 * The reader, against files a real SQLite wrote (test/fixtures, made by
 * scripts/make-import-fixtures.js). A file-format reader tested only against
 * files it wrote itself would be testing its own opinions.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { open, readTable, Database, SqliteError, columnsOf, varint, walPages } = require('../src/sqlite');

const fixture = (name) => path.join(__dirname, 'fixtures', name);

test('a varint is seven bits a byte until the ninth', () => {
  assert.deepEqual(varint(Buffer.from([0x00]), 0), [0, 1]);
  assert.deepEqual(varint(Buffer.from([0x7f]), 0), [127, 1]);
  assert.deepEqual(varint(Buffer.from([0x81, 0x00]), 0), [128, 2]);
  assert.deepEqual(varint(Buffer.from([0x82, 0x2c]), 0), [300, 2]);
  assert.throws(() => varint(Buffer.from([0x81]), 0), SqliteError);
});

test('column names come out of the CREATE TABLE, constraints left out', () => {
  const sql = 'CREATE TABLE cookies(creation_utc INTEGER NOT NULL, "host key" TEXT, [name] TEXT, '
    + 'id INTEGER PRIMARY KEY, UNIQUE (host_key, name), CONSTRAINT c CHECK (length(name) > 0))';
  assert.deepEqual(columnsOf(sql).map((c) => c.name), ['creation_utc', 'host key', 'name', 'id']);
  assert.deepEqual(columnsOf(sql).map((c) => c.rowid), [false, false, false, true]);
  assert.deepEqual(columnsOf('not a create table'), []);
});

test('the tables of a browser database, and their rows', () => {
  const db = open(fixture('web-data.db'));
  assert.deepEqual([...db.tables().keys()].sort(), ['address_type_tokens', 'addresses', 'autofill']);
  assert.equal(db.has('autofill'), true);
  assert.equal(db.has('passwords'), false);
  const rows = [...db.rows('addresses')];
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.guid).sort(), ['old-one', 'the-one-she-uses']);
  assert.equal(typeof rows[0].use_count, 'number');
  const typed = [...db.rows('autofill')];
  assert.equal(typed.find((r) => r.name === 'emailAddress').value, 'ada@example.com');
  assert.equal(typed.find((r) => r.name === 'emailAddress').count, 9);
});

test('an integer primary key is the row id, and a blob stays a Buffer', () => {
  const db = open(fixture('cookies.db'));
  const rows = [...db.rows('cookies')];
  assert.equal(rows.length, 7);
  const session = rows.find((r) => r.name === 'SESSION');
  assert.ok(Buffer.isBuffer(session.encrypted_value));
  assert.equal(session.encrypted_value.subarray(0, 3).toString(), 'v10');
  assert.equal(session.host_key, '.dmv.example.gov');
  assert.equal(session.is_secure, 1);
  assert.equal(typeof session.expires_utc, 'number');
  assert.ok(session.expires_utc > 13e15, 'a Chromium timestamp survives as a number');
});

test('rows that live only in the write-ahead log are read — schema and all', () => {
  const db = open(fixture('wal.db'));
  assert.ok(db.wal.size >= 2, 'the log has pages the file does not');
  assert.deepEqual([...db.tables().keys()], ['autofill']);
  const rows = [...db.rows('autofill')];
  assert.deepEqual(rows.map((r) => r.value), ['in-the-file@example.com', '92064']);
  // Without the log there is nothing at all: that file is one empty page.
  const alone = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'regbot-sqlite-')), 'wal.db');
  fs.copyFileSync(fixture('wal.db'), alone);
  assert.deepEqual([...open(alone).tables().keys()], []);
});

test('a log from a different writer, or one cut off mid-transaction, is ignored', () => {
  const wal = fs.readFileSync(fixture('wal.db-wal'));
  assert.ok(walPages(wal, 512).size > 0);
  assert.equal(walPages(wal, 4096).size, 0, 'a log for another page size is not this file\'s');
  const wrongMagic = Buffer.from(wal);
  wrongMagic.writeUInt32BE(0x12345678, 0);
  assert.equal(walPages(wrongMagic, 512).size, 0);
  const halfWritten = wal.subarray(0, 32 + 10);
  assert.equal(walPages(halfWritten, 512).size, 0, 'a frame that is not all there is not replayed');
  assert.equal(walPages(null, 512).size, 0);
});

test('a payload too big for its page is followed into the overflow chain', () => {
  const db = open(fixture('cookies.db'));
  assert.equal(db.pageSize, 512);
  const big = [...db.rows('cookies')].find((r) => r.name === 'BIG');
  // Three kilobytes of cookie across seven pages, back in one piece.
  assert.ok(big.encrypted_value.length > 6 * db.pageSize, 'the fixture really does overflow');
  assert.equal(big.encrypted_value.subarray(0, 3).toString(), 'v10');
  assert.equal(big.host_key, '.dmv.example.gov', 'the columns after the long one still line up');
  assert.equal([...db.rows('cookies')].length, 7);
});

test('anything that is not a database says so, rather than returning nothing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'regbot-sqlite-'));
  const junk = path.join(dir, 'Cookies');
  fs.writeFileSync(junk, 'this is not a database, it is a note about one');
  assert.throws(() => open(junk), /not a SQLite database/);
  assert.throws(() => new Database(Buffer.alloc(4)), SqliteError);
  const db = open(fixture('cookies.db'));
  assert.throws(() => [...db.rows('nope')].length, /no table named nope/);
  assert.deepEqual(readTable(fixture('cookies.db'), 'nope'), []);
  assert.equal(readTable(fixture('cookies.db'), 'cookies').length, 7);
});
