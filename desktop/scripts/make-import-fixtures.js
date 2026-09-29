'use strict';
/**
 * Make the browser databases the import tests read.
 *
 * `test/fixtures/` holds three small SQLite files shaped exactly like the
 * ones a Chromium browser keeps — the old address tables and the new ones,
 * the key/value store of everything ever typed into a form, and a cookie
 * store whose values are encrypted the way Chromium encrypts them on a Linux
 * machine with no keyring. The tests read them with src/sqlite.js, which is
 * the point: a reader of a file format should be tested against files
 * something else wrote.
 *
 * Run it when the fixtures need changing, not as part of the tests:
 *
 *     npm run fixtures
 *
 * It needs a SQLite that can write, which the tests deliberately do not have.
 * Node 22.5 and later have one built in; on an older Node this runs under the
 * Electron already installed here, which has the same. Nothing but this
 * script needs either.
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const OUT = path.join(__dirname, '..', 'test', 'fixtures');

/**
 * As Chromium encrypts on a machine with no keyring: AES-128-CBC, "peanuts".
 *
 * With `host`, as current Chromium encrypts everywhere: the SHA-256 of the
 * cookie's host key goes in front of the value first, binding it to that
 * domain. Both shapes are in the fixture because both are in the wild.
 */
function seal(text, { host = null, password = 'peanuts', iterations = 1 } = {}) {
  const key = crypto.pbkdf2Sync(password, 'saltysalt', iterations, 16, 'sha1');
  const cipher = crypto.createCipheriv('aes-128-cbc', key, Buffer.alloc(16, ' '));
  const body = host
    ? Buffer.concat([crypto.createHash('sha256').update(host).digest(), Buffer.from(text, 'utf8')])
    : Buffer.from(text, 'utf8');
  return Buffer.concat([Buffer.from('v10'), cipher.update(body), cipher.final()]);
}

/** Chromium counts microseconds from 1601. */
const chromeTime = (ms) => Math.round(ms * 1000 + 11644473600 * 1e6);

function open(file) {
  const { DatabaseSync } = require('node:sqlite');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.rmSync(file, { force: true });
  fs.rmSync(`${file}-wal`, { force: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA page_size = 512');
  return db;
}

function webData(file) {
  const db = open(file);
  // The shape Chromium has used since 2024: one row per address, one row per
  // field of it, the field named by its own FieldType number.
  db.exec(`CREATE TABLE addresses (guid VARCHAR PRIMARY KEY, use_count INTEGER NOT NULL DEFAULT 0,
    use_date INTEGER NOT NULL DEFAULT 0, date_modified INTEGER NOT NULL DEFAULT 0, language_code VARCHAR,
    label VARCHAR, initial_creator_id INTEGER DEFAULT 0, record_type INTEGER DEFAULT 0)`);
  db.exec(`CREATE TABLE address_type_tokens (guid VARCHAR, type INTEGER, value VARCHAR,
    verification_status INTEGER DEFAULT 0, observations BLOB, PRIMARY KEY (guid, type))`);
  const address = db.prepare('INSERT INTO addresses VALUES (?,?,?,?,?,?,?,?)');
  const token = db.prepare('INSERT INTO address_type_tokens VALUES (?,?,?,?,?)');
  address.run('old-one', 2, 1700000000, 1700000000, 'en', '', 0, 1);
  for (const [type, value] of [[3, 'Augusta'], [5, 'King'], [9, 'augusta@example.org'], [35, '94016']]) {
    token.run('old-one', type, value, 3, Buffer.alloc(0));
  }
  address.run('the-one-she-uses', 17, 1780000000, 1770000000, 'en', '', 0, 1);
  for (const [type, value] of [
    [3, 'Ada'], [4, 'Byron'], [5, 'Lovelace'], [7, 'Ada Byron Lovelace'],
    [9, 'ada@example.com'], [14, '+1 (650) 555-0123'],
    [77, '12 Marylebone Road'], [30, '12 Marylebone Road'], [33, 'Poway'], [34, 'CA'], [35, '92064'], [36, 'US'],
  ]) {
    token.run('the-one-she-uses', type, value, 3, Buffer.alloc(0));
  }

  // Everything ever typed into a form, which is where a licence number could
  // come from — and a card number, which must not.
  db.exec(`CREATE TABLE autofill (name VARCHAR, value VARCHAR, value_lower VARCHAR,
    date_created INTEGER DEFAULT 0, date_last_used INTEGER DEFAULT 0, count INTEGER DEFAULT 1)`);
  const typed = db.prepare('INSERT INTO autofill VALUES (?,?,?,?,?,?)');
  for (const [name, value, count] of [
    ['dl_number', 'X9912345', 4],
    ['contact.contactPhoneNumber', '6505550199', 1],
    ['date_of_birth', '1815-12-10', 2],
    ['emailAddress', 'ada@example.com', 9],
    ['cardNumber', '4111111111111111', 6],
    ['cardHolderName', 'A B LOVELACE', 6],
    ['cvv', '123', 3],
    ['searchQuery', 'difference engine', 30],
  ]) {
    typed.run(name, value, value.toLowerCase(), 0, 1780000000, count);
  }
  db.close();
}

function legacyWebData(file) {
  const db = open(file);
  // The shape Chromium used until 2023: a table per part of an address.
  db.exec(`CREATE TABLE autofill_profiles (guid VARCHAR PRIMARY KEY, company_name VARCHAR,
    street_address VARCHAR, dependent_locality VARCHAR, city VARCHAR, state VARCHAR, zipcode VARCHAR,
    sorting_code VARCHAR, country_code VARCHAR, date_modified INTEGER NOT NULL DEFAULT 0,
    origin VARCHAR DEFAULT '', language_code VARCHAR, use_count INTEGER NOT NULL DEFAULT 0,
    use_date INTEGER NOT NULL DEFAULT 0)`);
  db.exec('CREATE TABLE autofill_profile_names (guid VARCHAR, first_name VARCHAR, middle_name VARCHAR, last_name VARCHAR, full_name VARCHAR)');
  db.exec('CREATE TABLE autofill_profile_emails (guid VARCHAR, email VARCHAR)');
  db.exec('CREATE TABLE autofill_profile_phones (guid VARCHAR, number VARCHAR)');
  db.prepare('INSERT INTO autofill_profiles VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run('one', '', '12 Marylebone Road', '', 'Poway', 'CA', '92064', '', 'US', 1770000000, '', 'en', 3, 1780000000);
  db.prepare('INSERT INTO autofill_profile_names VALUES (?,?,?,?,?)').run('one', 'Ada', 'Byron', 'Lovelace', 'Ada Byron Lovelace');
  db.prepare('INSERT INTO autofill_profile_emails VALUES (?,?)').run('one', 'ada@example.com');
  db.prepare('INSERT INTO autofill_profile_phones VALUES (?,?)').run('one', '650-555-0123');
  db.close();
}

function cookies(file) {
  const db = open(file);
  db.exec(`CREATE TABLE cookies (creation_utc INTEGER NOT NULL, host_key TEXT NOT NULL,
    top_frame_site_key TEXT NOT NULL DEFAULT '', name TEXT NOT NULL, value TEXT NOT NULL,
    encrypted_value BLOB NOT NULL DEFAULT '', path TEXT NOT NULL, expires_utc INTEGER NOT NULL,
    is_secure INTEGER NOT NULL, is_httponly INTEGER NOT NULL, last_access_utc INTEGER NOT NULL,
    has_expires INTEGER NOT NULL DEFAULT 1, is_persistent INTEGER NOT NULL DEFAULT 1,
    priority INTEGER NOT NULL DEFAULT 1, samesite INTEGER NOT NULL DEFAULT -1,
    source_scheme INTEGER NOT NULL DEFAULT 0, source_port INTEGER NOT NULL DEFAULT -1,
    last_update_utc INTEGER NOT NULL DEFAULT 0)`);
  const add = db.prepare('INSERT INTO cookies VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
  const soon = chromeTime(Date.UTC(2099, 0, 1));
  const gone = chromeTime(Date.UTC(2020, 0, 1));
  const now = chromeTime(Date.now());
  // A session on the booking site, its sibling subdomain, one that has
  // expired, one whose value was never encrypted, and one for somewhere else
  // entirely, which must not be read.
  add.run(now, '.dmv.example.gov', '', 'SESSION', '', seal('the-session-token'), '/', soon, 1, 1, now, 1, 1, 1, 1, 2, 443, now);
  add.run(now, 'book.dmv.example.gov', '', 'flow', '', seal('step-3'), '/appointments', soon, 1, 0, now, 1, 1, 1, 2, 2, 443, now);
  add.run(now, '.dmv.example.gov', '', 'LAST_YEAR', '', seal('stale'), '/', gone, 1, 1, now, 1, 1, 1, -1, 2, 443, now);
  add.run(now, 'dmv.example.gov', '', 'plain_one', 'no-encryption-here', Buffer.alloc(0), '/', 0, 0, 0, now, 0, 0, 1, -1, 1, 80, now);
  add.run(now, '.somewhere.else.example', '', 'PRIVATE', '', seal('none-of-our-business'), '/', soon, 1, 1, now, 1, 1, 1, -1, 2, 443, now);
  // A cookie the size real ones reach, which in a 512-byte-page database
  // cannot fit on one: the reader has to follow the overflow chain.
  add.run(now, '.dmv.example.gov', '', 'BIG', '', seal(`long.${'abcdefgh'.repeat(400)}.end`), '/', soon, 1, 1, now, 1, 1, 1, -1, 2, 443, now);
  // And one written by a current Chromium, bound to its own domain.
  add.run(now, '.dmv.example.gov', '', 'BOUND', '', seal('bound-to-this-domain', { host: '.dmv.example.gov' }), '/', soon, 1, 1, now, 1, 1, 1, -1, 2, 443, now);
  db.close();
}

/**
 * A database whose newest rows are only in the write-ahead log, which is what
 * a browser that is running right now looks like from outside.
 *
 * The process is killed rather than closed, because closing folds the log
 * back into the file and there would be nothing left to test.
 */
function wal(file) {
  const db = open(file);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('CREATE TABLE autofill (name VARCHAR, value VARCHAR, value_lower VARCHAR, date_created INTEGER, date_last_used INTEGER, count INTEGER)');
  const add = db.prepare('INSERT INTO autofill VALUES (?,?,?,?,?,?)');
  add.run('emailAddress', 'in-the-file@example.com', 'in-the-file@example.com', 0, 0, 1);
  add.run('zip_code', '92064', '92064', 0, 0, 1);
  process.exit(0);
}

const PARTS = {
  'web-data.db': webData,
  'web-data-legacy.db': legacyWebData,
  'cookies.db': cookies,
  'wal.db': wal,
};

function main() {
  const [name] = process.argv.slice(2);
  if (name) {
    PARTS[name](path.join(OUT, name));
    return;
  }
  for (const part of Object.keys(PARTS)) {
    // Each in its own process: the write-ahead log one has to end abruptly.
    const node = process.execPath;
    const args = [__filename, part];
    const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_NO_WARNINGS: '1' };
    const done = spawnSync(node, args, { env, stdio: 'inherit' });
    if (done.status !== 0) throw new Error(`${part} failed`);
    fs.rmSync(path.join(OUT, `${part}-shm`), { force: true });   // an index into the log; rebuilt on demand
    console.log(`${part}: ${fs.statSync(path.join(OUT, part)).size} bytes`
      + (fs.existsSync(path.join(OUT, `${part}-wal`)) ? `, ${fs.statSync(path.join(OUT, `${part}-wal`)).size} in its log` : ''));
  }
}

main();
