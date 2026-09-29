import fs from 'fs';
import path from 'path';

/**
 * Replay store for RQP/1 delivery.
 *
 * regbot guarantees at-least-once: a worker can die after DMV committed a
 * booking but before the ack lands, and the job then comes back. The connector
 * contract requires a replay to return the original confirmation rather than
 * book a second appointment, so this has to survive process restarts — an
 * in-memory cache would not.
 */
export class BookingStore {
  constructor(filePath) {
    this.filePath = path.resolve(filePath);
  }

  _read() {
    try {
      return JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
    } catch {
      return {};
    }
  }

  get(key) {
    return this._read()[key] ?? null;
  }

  put(key, record) {
    const all = this._read();
    all[key] = { ...record, stored_at: new Date().toISOString() };
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    // Write-then-rename so a crash mid-write cannot corrupt the store.
    const tmp = `${this.filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(all, null, 2), 'utf8');
    fs.renameSync(tmp, this.filePath);
    return all[key];
  }
}
