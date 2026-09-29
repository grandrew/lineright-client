'use strict';
/**
 * The window's two faces.
 *
 * The app itself is one WebContentsView (`chromeView`) loaded from the
 * bundle. With no tab open it fills the window: that is the application —
 * sites, boards, the console, the profile. Open a booking site and the same
 * view shrinks to a strip across the top — tabs, back, forward, the address
 * — with the site's page in a second WebContentsView underneath: a browser,
 * because that is what signing in to a DMV needs.
 *
 * `active === null` is the app; a tab id is the browser. Every tab is a page
 * a person asked for, or a booking page the app opened because the board
 * said it was their turn — those carry the job id, so a second sync for the
 * same hand-off finds its tab instead of opening another.
 *
 * Content tabs get the strictest web preferences Electron offers: sandboxed,
 * isolated, no Node, and a persistent partition of their own so that a
 * sign-in survives a restart. The only thing that touches a page from here is
 * the autofill main.js runs on pages the app opened for booking, and the
 * page says when it has loaded.
 */
const { EventEmitter } = require('node:events');
const { WebContentsView } = require('electron');

class Shell extends EventEmitter {
  constructor(win, { chromeView, chromeHeight = 74, homeUrl, partition = 'persist:regbot' }) {
    super();
    this.win = win;
    this.chromeView = chromeView;
    this.chromeHeight = chromeHeight;
    this.homeUrl = homeUrl;
    this.partition = partition;
    this.tabs = new Map();
    this.order = [];
    this.active = null;
    this.seq = 0;
    win.contentView.addChildView(chromeView);
    win.on('resize', () => this.layout());
    this.layout();
  }

  // ------------------------------------------------------------ geometry
  layout() {
    const [width, height] = this.win.getContentSize();
    // The app fills the window; the browser strip only takes what it asks for.
    const strip = this.active === null ? height : this.chromeHeight;
    this.chromeView.setBounds({ x: 0, y: 0, width, height: strip });
    for (const tab of this.tabs.values()) {
      tab.view.setBounds({ x: 0, y: this.chromeHeight, width, height: Math.max(0, height - this.chromeHeight) });
      tab.view.setVisible(tab.id === this.active);
    }
  }

  get mode() {
    return this.active === null ? 'app' : 'tab';
  }

  setChromeHeight(px) {
    const next = Math.max(40, Math.min(600, Math.round(Number(px) || 0)));
    if (next === this.chromeHeight) return;
    this.chromeHeight = next;
    this.layout();
  }

  // ---------------------------------------------------------------- tabs
  open(url, { activate = true, kind = 'page', jobId = null, title = '' } = {}) {
    const id = ++this.seq;
    const view = new WebContentsView({
      webPreferences: {
        sandbox: true, contextIsolation: true, nodeIntegration: false,
        partition: this.partition, spellcheck: false,
      },
    });
    const tab = { id, view, url, title: title || url, kind, jobId, loading: true };
    this.tabs.set(id, tab);
    this.order.push(id);
    this.win.contentView.addChildView(view);
    this.wire(tab);
    view.webContents.loadURL(url).catch(() => {});
    if (activate || !this.active) this.select(id);
    else this.layout();
    this.changed();
    return id;
  }

  wire(tab) {
    const wc = tab.view.webContents;
    const sync = () => {
      tab.url = wc.getURL() || tab.url;
      tab.title = wc.getTitle() || tab.title;
      tab.loading = wc.isLoading();
      this.changed();
    };
    for (const event of ['page-title-updated', 'did-navigate', 'did-navigate-in-page',
      'did-start-loading', 'did-stop-loading', 'did-fail-load']) {
      wc.on(event, sync);
    }
    // Said separately from 'state' so that pairing can react to a sign-in on
    // the site without being run on every title change.
    wc.on('did-navigate', (_event, url) => this.emit('navigated', { id: tab.id, url, kind: tab.kind }));
    // The moment a booking form can be filled in. Said with the URL the page
    // actually ended up at, not the one the tab was opened with.
    wc.on('did-finish-load', () => this.emit('loaded', { id: tab.id, url: wc.getURL(), kind: tab.kind, jobId: tab.jobId }));
    // A link that wants a new window gets a new tab here instead.
    wc.setWindowOpenHandler(({ url }) => {
      this.open(url, { activate: true });
      return { action: 'deny' };
    });
    wc.on('destroyed', () => this.forget(tab.id));
  }

  select(id) {
    if (id === null || id === undefined) return this.showApp();
    if (!this.tabs.has(id)) return;
    this.active = id;
    this.layout();
    this.changed();
  }

  /** Back to the application: every tab stays open, none is shown. */
  showApp() {
    this.active = null;
    this.layout();
    this.changed();
  }

  close(id) {
    const tab = this.tabs.get(id);
    if (!tab) return;
    this.forget(id);
    try {
      this.win.contentView.removeChildView(tab.view);
      tab.view.webContents.close();
    } catch {
      // already gone
    }
    // Closing the last tab, or the one being looked at, returns to the app;
    // closing a background tab changes nothing on screen.
    if (!this.tabs.size || this.active === null) this.showApp();
    else this.changed();
  }

  forget(id) {
    if (!this.tabs.has(id)) return;
    const at = this.order.indexOf(id);
    this.tabs.delete(id);
    this.order = this.order.filter((t) => t !== id);
    if (this.active === id) {
      this.active = null;
      this.layout();
    }
  }

  // ---------------------------------------------------------- navigation
  current() {
    return this.active === null ? null : this.tabs.get(this.active) || null;
  }

  navigate(url, id = null) {
    const tab = id === null ? this.current() : this.tabs.get(id);
    if (!tab) return this.open(url);
    tab.view.webContents.loadURL(url).catch(() => {});
    return tab.id;
  }

  back() { const t = this.current(); if (t && t.view.webContents.navigationHistory.canGoBack()) t.view.webContents.navigationHistory.goBack(); }
  forward() { const t = this.current(); if (t && t.view.webContents.navigationHistory.canGoForward()) t.view.webContents.navigationHistory.goForward(); }
  reload() { const t = this.current(); if (t) t.view.webContents.reload(); }

  home() {
    return this.showApp();
  }

  /** Run a script in a tab's page. Only main.js's autofill uses this. */
  async run(id, script) {
    const tab = this.tabs.get(id);
    if (!tab) return null;
    return tab.view.webContents.executeJavaScript(script, true);
  }

  tabFor(jobId) {
    return [...this.tabs.values()].find((t) => t.jobId === jobId) || null;
  }

  /** Close every view, in the order Electron wants them gone. Called on quit. */
  destroy() {
    for (const id of [...this.order]) {
      const tab = this.tabs.get(id);
      this.tabs.delete(id);
      try { this.win.contentView.removeChildView(tab.view); } catch { /* gone */ }
      try { tab.view.webContents.close({ waitForBeforeUnload: false }); } catch { /* gone */ }
    }
    this.order = [];
    this.active = null;
  }

  // ------------------------------------------------------------- reports
  state() {
    const tabs = this.order.map((id) => {
      const t = this.tabs.get(id);
      const wc = t.view.webContents;
      return {
        id: t.id, url: t.url, title: t.title, kind: t.kind, jobId: t.jobId, loading: t.loading,
        active: t.id === this.active,
        canGoBack: wc.navigationHistory ? wc.navigationHistory.canGoBack() : false,
        canGoForward: wc.navigationHistory ? wc.navigationHistory.canGoForward() : false,
      };
    });
    return { tabs, active: this.active, mode: this.mode };
  }

  changed() {
    this.emit('state', this.state());
  }
}

module.exports = { Shell };
