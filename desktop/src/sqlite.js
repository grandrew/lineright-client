'use strict';
/**
 * Enough of the SQLite file format to read a browser's tables.
 *
 * Every Chromium browser keeps its cookies, its saved addresses and its
 * history in SQLite files. Reading them needs no SQL — a table scan is all
 * this app ever wants — and a native SQLite module would have to be rebuilt
 * for every platform and Electron version the installers cover, for the sake
 * of four `SELECT *`. So this reads the file format directly: the header, the
 * schema, the table b-trees, and the record encoding. Read-only, and it never
 * opens the browser's own file — import.js hands it a copy.
 *
 * It also reads the write-ahead log beside the file, because a browser that
 * was running when the copy was taken will have left the newest pages there
 * and nowhere else; without it a freshly saved address or a cookie set an
 * hour ago simply would not be in the table.
 *
 * What is deliberately not here: writing, SQL, indexes, `WITHOUT ROWID`
 * tables (reported rather than misread) and journal files from the rollback
 * mode Chromium no longer uses. Eight-byte integers come back as Numbers,
 * which rounds a Chromium microsecond timestamp to the nearest few — they are
 * used as seconds.
 */
const fs = require('node:fs');

const MAGIC = 'SQLite format 3\0';
const WAL_MAGIC = [0x377f0682, 0x377f0683];
const INTERIOR_TABLE = 0x05;
const LEAF_TABLE = 0x0d;

class SqliteError extends Error {}

/** A SQLite varint: 1-9 bytes, seven bits each until the ninth. */
function varint(buf, off) {
  let value = 0;
  for (let i = 0; i < 8; i += 1) {
    const byte = buf[off + i];
    if (byte === undefined) throw new SqliteError('truncated varint');
    if (i === 7) return [value * 256 + byte, 9];
    value = value * 128 + (byte & 0x7f);
    if (!(byte & 0x80)) return [value, i + 1];
  }
  return [value, 9];
}

/** A big-endian two's-complement integer of 1, 2, 3, 4, 6 or 8 bytes. */
function intOf(buf, off, bytes) {
  if (bytes === 8) return Number(buf.readBigInt64BE(off));
  let value = 0;
  for (let i = 0; i < bytes; i += 1) value = value * 256 + buf[off + i];
  const top = 2 ** (bytes * 8);
  return value >= top / 2 ? value - top : value;
}

/** The column names of a `CREATE TABLE`, in the order the record stores them. */
function columnsOf(sql) {
  const open = String(sql || '').indexOf('(');
  if (open < 0) return [];
  const body = String(sql).slice(open + 1, String(sql).lastIndexOf(')'));
  const parts = [];
  let depth = 0;
  let at = 0;
  for (let i = 0; i < body.length; i += 1) {
    const c = body[i];
    if (c === '(') depth += 1;
    else if (c === ')') depth -= 1;
    else if (c === ',' && depth === 0) { parts.push(body.slice(at, i)); at = i + 1; }
  }
  parts.push(body.slice(at));
  const out = [];
  for (const raw of parts) {
    const part = raw.trim();
    if (!part) continue;
    if (/^(constraint|primary|unique|check|foreign|key)\b/i.test(part)) continue;
    const quoted = part.match(/^"([^"]*)"|^\[([^\]]*)\]|^`([^`]*)`|^([A-Za-z_][\w$]*)/);
    if (!quoted) continue;
    const name = quoted[1] ?? quoted[2] ?? quoted[3] ?? quoted[4];
    // An `INTEGER PRIMARY KEY` column is the rowid: the record stores a null
    // in its place and the row's own key is the value.
    out.push({ name, rowid: /\binteger\s+primary\s+key\b/i.test(part) });
  }
  return out;
}

/**
 * The pages a write-ahead log has that the database file does not.
 *
 * Frames are replayed in order up to the last commit, so what comes back is
 * the last transaction that finished — never half of one that was still being
 * written when the copy was taken. Frames left over from an older writer
 * carry different salts and are skipped.
 */
function walPages(wal, pageSize) {
  const pages = new Map();
  if (!wal || wal.length < 32) return pages;
  if (!WAL_MAGIC.includes(wal.readUInt32BE(0))) return pages;
  if (wal.readUInt32BE(8) !== pageSize) return pages;
  const salt1 = wal.readUInt32BE(16);
  const salt2 = wal.readUInt32BE(20);
  let at = 32;
  let pending = [];
  while (at + 24 + pageSize <= wal.length) {
    const page = wal.readUInt32BE(at);
    const commit = wal.readUInt32BE(at + 4);
    if (wal.readUInt32BE(at + 8) !== salt1 || wal.readUInt32BE(at + 12) !== salt2) break;
    pending.push([page, wal.subarray(at + 24, at + 24 + pageSize)]);
    if (commit > 0) {
      for (const [n, data] of pending) pages.set(n, data);
      pending = [];
    }
    at += 24 + pageSize;
  }
  return pages;
}

class Database {
  /**
   * @param {Buffer} buf the database file
   * @param {Buffer} [wal] the `-wal` beside it, if there was one
   */
  constructor(buf, wal = null) {
    if (buf.length < 100 || buf.subarray(0, 16).toString('latin1') !== MAGIC) {
      throw new SqliteError('not a SQLite database');
    }
    this.buf = buf;
    const size = buf.readUInt16BE(16);
    this.pageSize = size === 1 ? 65536 : size;
    this.reserved = buf[20];
    this.usable = this.pageSize - this.reserved;
    this.encoding = { 1: 'utf8', 2: 'utf16le', 3: 'utf16be' }[buf.readUInt32BE(56)] || 'utf8';
    this.wal = walPages(wal, this.pageSize);
    this.schema = null;
  }

  page(n) {
    const fromWal = this.wal.get(n);
    if (fromWal) return fromWal;
    const at = (n - 1) * this.pageSize;
    if (at + this.pageSize > this.buf.length) throw new SqliteError(`page ${n} is past the end of the file`);
    return this.buf.subarray(at, at + this.pageSize);
  }

  /** Every table in the file, by name: what page it starts on and its columns. */
  tables() {
    if (this.schema) return this.schema;
    this.schema = new Map();
    for (const row of this.scan(1, ['type', 'name', 'tbl_name', 'rootpage', 'sql'])) {
      if (row.type !== 'table' || !row.rootpage) continue;
      this.schema.set(String(row.name), {
        root: Number(row.rootpage),
        columns: columnsOf(row.sql),
        withoutRowid: /\bwithout\s+rowid\s*$/i.test(String(row.sql || '')),
      });
    }
    return this.schema;
  }

  has(table) {
    return this.tables().has(table);
  }

  /** Every row of a table, as objects keyed by column name. */
  rows(table) {
    const meta = this.tables().get(table);
    if (!meta) throw new SqliteError(`no table named ${table}`);
    if (meta.withoutRowid) throw new SqliteError(`${table} is a WITHOUT ROWID table, which this reader does not read`);
    return this.scan(meta.root, meta.columns);
  }

  /**
   * Walk a table b-tree, deepest-first, yielding one object per leaf cell.
   *
   * `columns` is either the schema's column list or, for sqlite_schema
   * itself, plain names — that one table's shape is fixed by the format.
   */
  * scan(root, columns) {
    const names = columns.map((c) => (typeof c === 'string' ? { name: c, rowid: false } : c));
    const seen = new Set();
    const stack = [root];
    while (stack.length) {
      const n = stack.pop();
      if (seen.has(n)) continue;          // a loop would otherwise never end
      seen.add(n);
      const page = this.page(n);
      const start = n === 1 ? 100 : 0;
      const type = page[start];
      if (type !== INTERIOR_TABLE && type !== LEAF_TABLE) {
        if (type === 0) continue;         // a page the file has never used
        throw new SqliteError(`page ${n} is not part of a table b-tree (type ${type})`);
      }
      const cells = page.readUInt16BE(start + 3);
      const headerSize = type === INTERIOR_TABLE ? 12 : 8;
      if (type === INTERIOR_TABLE) stack.push(page.readUInt32BE(start + 8));
      for (let i = 0; i < cells; i += 1) {
        const at = page.readUInt16BE(start + headerSize + i * 2);
        if (at < start || at >= this.pageSize) throw new SqliteError(`cell ${i} of page ${n} points outside it`);
        if (type === INTERIOR_TABLE) {
          stack.push(page.readUInt32BE(at));
          continue;
        }
        const [length, lengthBytes] = varint(page, at);
        const [rowid, rowidBytes] = varint(page, at + lengthBytes);
        const payload = this.payload(page, at + lengthBytes + rowidBytes, length);
        yield this.record(payload, names, rowid);
      }
    }
  }

  /**
   * A cell's payload, following the overflow chain when it does not fit.
   *
   * The thresholds are the format's own: a big row keeps a little of itself
   * on the page so that scans stay cheap, and the rest goes to a chain of
   * pages that hold nothing else.
   */
  payload(page, at, length) {
    const maxLocal = this.usable - 35;
    if (length <= maxLocal) return page.subarray(at, at + length);
    const minLocal = Math.floor(((this.usable - 12) * 32) / 255) - 23;
    let local = minLocal + ((length - minLocal) % (this.usable - 4));
    if (local > maxLocal) local = minLocal;
    const parts = [page.subarray(at, at + local)];
    let next = page.readUInt32BE(at + local);
    let left = length - local;
    const seen = new Set();
    while (next && left > 0) {
      if (seen.has(next)) throw new SqliteError('overflow chain loops');
      seen.add(next);
      const over = this.page(next);
      const take = Math.min(left, this.usable - 4);
      parts.push(over.subarray(4, 4 + take));
      left -= take;
      next = over.readUInt32BE(0);
    }
    return Buffer.concat(parts);
  }

  /** One record: a header of serial types, then the values they describe. */
  record(payload, columns, rowid) {
    const [headerSize, headerBytes] = varint(payload, 0);
    const out = {};
    let typeAt = headerBytes;
    let valueAt = headerSize;
    for (let i = 0; i < columns.length; i += 1) {
      const column = columns[i];
      if (typeAt >= headerSize) { out[column.name] = column.rowid ? rowid : null; continue; }
      const [serial, bytes] = varint(payload, typeAt);
      typeAt += bytes;
      const [value, size] = this.value(payload, valueAt, serial);
      valueAt += size;
      out[column.name] = value === null && column.rowid ? rowid : value;
    }
    out.rowid = rowid;
    return out;
  }

  value(payload, at, serial) {
    switch (serial) {
      case 0: return [null, 0];
      case 1: case 2: case 3: case 4: {
        const bytes = serial;
        return [intOf(payload, at, bytes), bytes];
      }
      case 5: return [intOf(payload, at, 6), 6];
      case 6: return [intOf(payload, at, 8), 8];
      case 7: return [payload.readDoubleBE(at), 8];
      case 8: return [0, 0];
      case 9: return [1, 0];
      case 10: case 11: return [null, 0];      // reserved; nothing writes them
      default: {
        const size = Math.floor((serial - 12) / 2);
        const raw = payload.subarray(at, at + size);
        if (serial % 2 === 0) return [Buffer.from(raw), size];
        return [this.text(raw), size];
      }
    }
  }

  text(raw) {
    if (this.encoding === 'utf16be') {
      const swapped = Buffer.from(raw);
      swapped.swap16();
      return swapped.toString('utf16le');
    }
    return raw.toString(this.encoding);
  }
}

/**
 * Open a database file, with the write-ahead log beside it if there is one.
 * The whole file is read into memory: a browser's cookie store is measured in
 * megabytes, and the alternative is a file handle held open across an import.
 */
function open(file) {
  const db = new Database(fs.readFileSync(file), readIfThere(`${file}-wal`));
  return db;
}

function readIfThere(file) {
  try {
    return fs.readFileSync(file);
  } catch {
    return null;
  }
}

/** Every row of one table, or `[]` when the file has no such table. */
function readTable(file, table) {
  const db = open(file);
  if (!db.has(table)) return [];
  return [...db.rows(table)];
}

module.exports = { open, readTable, Database, SqliteError, columnsOf, varint, walPages };
