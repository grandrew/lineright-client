import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

/** A marker older than this is stale whoever holds it: the bot force-closes
 *  itself after RUN_TIMEOUT_MINUTES (14 by default). */
const STALE_RUN_MS = 15 * 60 * 1000;
/** How long the store's own lock is ever held for: one read and one write. */
const STALE_LOCK_MS = 10 * 1000;

const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** Whether a process is still there. EPERM means it is, and is somebody else's. */
export function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

/**
 * Replay store for RQP/1 delivery.
 *
 * regbot guarantees at-least-once: a worker can die after DMV committed a
 * booking but before the ack lands, and the job then comes back. The connector
 * contract requires a replay to return the original confirmation rather than
 * book a second appointment, so this has to survive process restarts — an
 * in-memory cache would not.
 *
 * It also knows which bookings are under way. The desktop app runs this robot
 * as a process of its own, and an app that is closed or crashes in the middle
 * of a booking leaves it to finish; started again, the app runs a second one
 * for the same slot. That one must not race the first — whichever lost would
 * report the slot gone while the person holds the appointment — so a run marks
 * its booking as under way (`begin`), says when it submits the form (`phase`),
 * and clears the mark when it has recorded what came of it (`end`). Several
 * robots may share one store, so every read-modify-write is under a lock.
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

  /** Run `fn` holding the store's lock: a file only one process can create. */
  _locked(fn) {
    const lock = `${this.filePath}.lock`;
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    for (let waited = 0; ; waited += 20) {
      try {
        fs.closeSync(fs.openSync(lock, 'wx'));
        break;
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        // A holder that died inside its few milliseconds leaves the file behind.
        try {
          if (Date.now() - fs.statSync(lock).mtimeMs > STALE_LOCK_MS) fs.rmSync(lock, { force: true });
        } catch { /* it went as we looked */ }
        if (waited > 2 * STALE_LOCK_MS) throw new Error(`the booking store stayed locked: ${lock}`);
        pause(20);
      }
    }
    try {
      return fn();
    } finally {
      fs.rmSync(lock, { force: true });
    }
  }

  get(key) {
    return this._read()[key] ?? null;
  }

  put(key, record) {
    return this._locked(() => {
      const all = this._read();
      all[key] = { ...record, stored_at: new Date().toISOString() };
      // Write-then-rename so a crash mid-write cannot corrupt the store.
      const tmp = `${this.filePath}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(all, null, 2), 'utf8');
      fs.renameSync(tmp, this.filePath);
      return all[key];
    });
  }

  _runningFile(key) {
    const name = crypto.createHash('sha256').update(String(key)).digest('hex').slice(0, 32);
    return `${this.filePath}.${name}.running`;
  }

  /** Who is booking `key` right now, if anybody: {pid, started_at, phase}. */
  running(key) {
    try {
      return JSON.parse(fs.readFileSync(this._runningFile(key), 'utf8'));
    } catch {
      return null;
    }
  }

  /**
   * Mark this process as booking `key`. Returns { held: true }, or who has it:
   * { held: false, by, alive } — `alive` false when that run is gone, which
   * leaves it here only if it had submitted the form (phase 'submitting'): its
   * appointment may exist, and nobody can say. One gone before that booked
   * nothing, and its place is taken.
   */
  begin(key) {
    return this._locked(() => {
      const file = this._runningFile(key);
      const by = this.running(key);
      if (by) {
        const alive = processAlive(by.pid) && Date.now() - Date.parse(by.started_at) < STALE_RUN_MS;
        if (alive || by.phase === 'submitting') return { held: false, by, alive };
      }
      fs.writeFileSync(file, JSON.stringify({ key, pid: process.pid, started_at: new Date().toISOString(), phase: 'started' }));
      return { held: true };
    });
  }

  /** This run has reached `phase` ('submitting': the form is being sent). */
  phase(key, phase) {
    return this._locked(() => {
      const by = this.running(key);
      if (!by || by.pid !== process.pid) return false;
      fs.writeFileSync(this._runningFile(key), JSON.stringify({ ...by, phase }));
      return true;
    });
  }

  /** This run is over, and has recorded whatever it came to. `anyone` clears a dead run's mark too. */
  end(key, { anyone = false } = {}) {
    return this._locked(() => {
      const by = this.running(key);
      if (!by || (!anyone && by.pid !== process.pid)) return false;
      fs.rmSync(this._runningFile(key), { force: true });
      return true;
    });
  }
}
