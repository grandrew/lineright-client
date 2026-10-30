'use strict';
/**
 * Keeping the computer awake while the app runs.
 *
 * The app books a person's turn only while it runs: a computer that has gone to
 * sleep when the turn comes loses it. Electron's power-save blocker asks the
 * system not to sleep — SetThreadExecutionState on Windows, a power assertion
 * on macOS, the desktop's inhibitor (GNOME, KDE…) on Linux — and still lets the
 * screen go dark and lock as it would. Nothing here can keep a closed laptop
 * lid from sleeping, or a computer on that is shut down: the notice in the
 * window says so (ui/keepopen.js).
 *
 * On unless the person turns it off (Settings → Keeping the app running), kept
 * in the store as `keepAwake`.
 */
const KIND = 'prevent-app-suspension';

class Awake {
  /**
   * @param {object} opts
   * @param {object} opts.blocker  Electron's powerSaveBlocker (start, stop, isStarted)
   * @param {object} opts.store    the app's store (get)
   */
  constructor({ blocker, store, log = () => {} }) {
    this.blocker = blocker;
    this.store = store;
    this.log = log;
    this.id = null;
  }

  /** Whether the person wants the computer kept awake: yes unless they said no. */
  wanted() {
    return this.store.get('keepAwake', true) !== false;
  }

  /** Whether the system has been asked, and still holds it. */
  held() {
    try {
      return this.id !== null && this.blocker.isStarted(this.id);
    } catch {
      return false;
    }
  }

  /** Ask the system, or stop asking, as the setting says. Returns whether it is held. */
  apply() {
    if (!this.wanted()) {
      this.release();
      return false;
    }
    if (this.held()) return true;
    try {
      this.id = this.blocker.start(KIND);
      this.log('keeping the computer awake while the app runs (the screen may still turn off)');
    } catch (err) {
      this.id = null;
      this.log(`could not keep the computer awake: ${err.message}`);
    }
    return this.held();
  }

  release() {
    if (this.id === null) return;
    try {
      if (this.blocker.isStarted(this.id)) this.blocker.stop(this.id);
    } catch { /* already gone with the app */ }
    this.id = null;
    this.log('no longer keeping the computer awake');
  }

  state() {
    return { on: this.wanted(), held: this.held() };
  }
}

module.exports = { Awake, KIND };
