/* regbot desktop — the application's screens, and the browser strip when a
   booking site is open. A plain page with no Node access; everything goes
   through window.regbot (see src/preload.js), and everything it shows came
   from the server as JSON or from the profile kept on this machine. */
(() => {
  'use strict';
  const api = window.regbot;
  const $ = (id) => document.getElementById(id);

  const state = {
    shell: { tabs: [], active: null, mode: 'app' },
    doc: null, docAt: 0,
    status: { state: 'unpaired' },
    stack: null,       // the server this app runs, while it is the one in use
    pair: { paired: false, user: null, pending: null, message: '' },
    update: { phase: 'disabled' },
    route: { page: 'sites' },
    sites: null, sitesAt: 0, siteDocs: {}, board: null, account: null, profile: null, settings: null,
    imports: null,     // { platform, sites, browsers } once the machine has been looked at
    found: null,       // what one browser offered, awaiting a yes
    reading: '',       // the browser being read right now
    query: '',
    form: null,        // the found-slot form
    prompt: null,      // job id whose booking reference is being typed
    bannerKey: '',
    adviceGone: null,  // suggestion keys closed with ×, kept across syncs (advice.js)
    adviceNoted: '',
    situationPace: null,  // when the nearest-opening bar next comes back (situation.js)
    situationNoted: '',
    situationPainted: '',
    adviceHold: null,     // last suggestion, kept across a short gap in sync (advice.js)
    situationTimer: null,
    ended: [],         // turns that ended lately, and how: [{job_id, at, kind, text}] (endedTurns)
    consoleTab: 'positions',
    nickEdit: null,    // the new nickname being typed on the account tab, if any

    boardTimer: null, boardShape: '',
    change: null,      // a bid change being drawn up: {bidId, draft, quote, error, busy, seq, shape} (bidchange.js)
    pairTimer: null,
    credits: null,     // the balance, packs and purchases, from the site
    checkout: null,    // a purchase waiting on the payment page: {id, url, status, message}
    checkoutTimer: null,
    advRange: '1h', advTimer: null, advPreview: null, advTrace: false,
    again: null,       // the weekly re-import, when it is asking: {due, sources, busy, result} (reimport.js)
    againKey: '',
  };

  // ------------------------------------------------------------ helpers
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const clock = (secs) => { const s = Math.max(0, Math.floor(secs)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
  const coins = (n) => `⧗${Number(n || 0).toLocaleString()}`;
  // A number the site sent, as text: a count, a rank, an id — never markup,
  // whatever arrived in its place.
  const num = (v) => { const x = Number(v); return Number.isFinite(x) ? String(x) : ''; };
  const left = (h) => (h.seconds_left || 0) - (Date.now() - state.docAt) / 1000;
  const paired = () => Boolean(state.pair && state.pair.paired);
  const builtin = () => Boolean(state.settings ? state.settings.serverMode === 'builtin' : state.stack);
  // Developer mode (src/developer.js): test sites, practice, other servers.
  const dev = () => Boolean(state.settings && state.settings.developer && state.settings.developer.on);
  // What a test site says about itself, wherever one is shown.
  const TEST_NOTE = '<b>Test site.</b> Made up for demos and tests: nothing booked here is real. It is listed because developer mode is on.';
  function ago(ts) {
    if (!ts) return '—';
    const secs = Math.max(0, Math.round((Date.now() - Date.parse(ts)) / 1000));
    if (secs < 60) return `${secs}s ago`;
    if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
    if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
    return `${Math.floor(secs / 86400)}d ago`;
  }
  function prettyDate(iso) {
    const d = new Date(`${iso}T00:00:00`);
    return Number.isNaN(d.getTime()) ? (iso || '—') : d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
  }
  const REACHES = [
    ['1h', 'Book in the nearest 1 hour'],
    ['2h', 'Book in the nearest 2 hours'],
    ['5h', 'Book in the nearest 5 hours'],
    ['1d', 'Book in the nearest 1 day'],
    ['5d', 'Book in the nearest 5 days'],
    ['2w', 'Book in the nearest 2 weeks'],
    ['1mo', 'Book in the nearest 1 month'],
    ['6mo', 'Book in the nearest 6 months'],
  ];
  const chosenReach = {};
  function shownReach(p) {
    return (p && (p.if_passed || chosenReach[p.bid_id] || chosenReach[String(p.bid_id)])) || '';
  }
  function reachLabel(code) {
    const hit = REACHES.find(([value]) => value === code);
    return hit ? hit[1].replace(/^Book in the /, '') : '';
  }
  function reachSelect(code, bidId) {
    return `<label class="field" style="margin:8px 0 0"><span class="field-label">If that time passes</span>
      <select data-if-passed="${num(bidId)}">
        ${code ? '' : '<option value="" selected>Choose how far to look</option>'}
        ${REACHES.map(([value, label]) => `<option value="${esc(value)}"${value === code ? ' selected' : ''}>${esc(label)}</option>`).join('')}
      </select>
      <span class="field-help">Until that moment, an earlier opening is taken. Once it has passed, the nearest later opening within this reach is taken. Nothing farther out is offered.</span></label>`;
  }
  function uiNote(kind, text) {
    api.call('ui:note', { kind, text }).catch(() => {});
  }
  function toast(kind, text, ms = 6000) {
    const surface = state.shell.mode === 'tab' ? 'top-bar' : 'bottom-right';
    uiNote('notice', `${surface} ${kind || 'ok'} for ${ms}ms — ${text}`);
    if (state.shell.mode === 'tab') {
      const bar = $('navtoast');
      bar.className = kind;
      bar.textContent = text;
      clearTimeout(toast.timer);
      toast.timer = setTimeout(() => { bar.textContent = ''; bar.className = ''; }, ms);
      return;
    }
    const el = document.createElement('div');
    el.className = `toast ${kind}`;
    el.textContent = text;
    $('toasts').appendChild(el);
    setTimeout(() => el.remove(), ms);
  }
  function fit() {
    if (state.shell.mode !== 'tab') return;
    requestAnimationFrame(() => api.call('chrome:height', { px: $('bars').offsetHeight }));
  }
  async function call(name, payload) {
    const reply = await api.call(name, payload);
    if (reply && reply.error) {
      const err = new Error(reply.error);
      err.status = reply.status;
      // A 402 carries how many credits are missing and where to buy them.
      err.detail = reply.detail || {};
      err.retryAfter = reply.retryAfter || 0;
      throw err;
    }
    return reply;
  }

  // --------------------------------------------------------------- mode
  function applyMode() {
    document.body.classList.toggle('mode-tab', state.shell.mode === 'tab');
    document.body.classList.toggle('has-tabs', state.shell.tabs.length > 0);
    renderTabs();
    fit();
  }

  function renderTabs() {
    const box = $('tabs');
    box.innerHTML = '';
    $('apptab').classList.toggle('active', state.shell.mode === 'app');
    for (const t of state.shell.tabs) {
      const el = document.createElement('div');
      el.className = `tab${t.active ? ' active' : ''}${t.loading ? ' loading' : ''}`;
      el.setAttribute('role', 'tab');
      el.title = t.url;
      el.innerHTML = `${t.kind === 'handoff' ? '<span class="k">☞</span>' : ''}<span class="t">${esc(t.title || t.url)}</span><button class="x" title="Close tab" aria-label="Close tab">×</button>`;
      el.addEventListener('click', () => api.call('tabs:select', { id: t.id }));
      el.querySelector('.x').addEventListener('click', (e) => { e.stopPropagation(); api.call('tabs:close', { id: t.id }); });
      box.appendChild(el);
    }
    const active = state.shell.tabs.find((t) => t.active);
    $('back').disabled = !(active && active.canGoBack);
    $('forward').disabled = !(active && active.canGoForward);
    const address = $('address');
    if (document.activeElement !== address) address.value = active ? active.url : '';
  }

  // --------------------------------------------------------------- bars
  function renderWho() {
    const doc = state.doc;
    let html;
    if (doc && doc.user) {
      // The balance is the site's: every sync brings it. It opens the Credits screen.
      html = `<b>${esc(doc.user.nickname)}</b> <a class="num credits-link" data-credits title="Your credits — the site keeps them; click to buy more">${coins(doc.user.balance)}</a>${doc.user.escrow ? ` <span class="tiny" title="Staked on your bids">${coins(doc.user.escrow)} staked</span>` : ''}`;
    } else if (paired()) {
      html = `<span class="muted">${esc(state.pair.user ? state.pair.user.nickname : 'signed in')} · syncing…</span>`;
    } else {
      html = `<a data-page="signin">Sign in</a>`;
    }
    $('who').innerHTML = html;
    $('navwho').innerHTML = html;
    for (const a of document.querySelectorAll('#who a, #navwho a')) {
      a.addEventListener('click', () => (a.hasAttribute('data-credits') ? go('credits') : go('signin')));
    }
    $('buy').classList.toggle('hidden', !(doc && doc.user));
    const positions = (doc && doc.positions) || [];
    $('found').classList.toggle('hidden', !positions.length);
    $('found2').classList.toggle('hidden', !positions.length);
    renderStatus();
  }

  // The status line in the bottom-right corner (#statusline): empty, it is not there.
  function renderStatus() {
    const el = $('statusline');
    const s = state.status || {};
    paintStatus(el, s);
    el.classList.toggle('hidden', !el.textContent);
  }

  function paintStatus(el, s) {
    if (!paired()) { el.className = 'muted'; el.textContent = ''; return; }
    if (s.state === 'synced') {
      // What this computer's robots are doing for the site, ahead of the sync time.
      const r = state.robots || {};
      // Checking lines earns credits on the site for every hour of it (its allowance.py).
      const earning = state.doc && state.doc.allowance && state.doc.allowance.checking;
      const doing = r.booking ? `booking ${r.booking.queue_name}… · `
        : r.reading ? `looking for openings: ${r.reading.queue_name} · `
        : earning && earning.counting ? `checking lines, +${coins(earning.per_hour)}/h · ` : '';
      // How this app's connection stands among the apps online (the site says).
      const l = state.doc && state.doc.latency;
      const slow = l && l.dropped ? `too slow for slots (${num(l.ms)} ms) · `
        : l && l.warn ? `slow connection (${num(l.ms)} ms) · ` : '';
      el.className = l && l.dropped ? 'bad' : l && l.warn ? 'warn' : 'muted';
      el.title = l && (l.dropped || l.warn) ? `Your round trip to the site: ${num(l.ms)} ms — ${l.why}.` : '';
      el.textContent = `${slow}${doing}synced ${Math.max(0, Math.round((Date.now() - (s.at || state.docAt)) / 1000))}s ago`;
    }
    else if (s.state === 'syncing') { el.className = 'muted'; el.textContent = 'syncing…'; }
    else if (s.state === 'offline') { el.className = 'bad'; el.textContent = `server not answering — retry in ${Math.round((s.retryMs || 0) / 1000)}s`; }
    else if (s.state === 'starting') {
      const web = state.stack && state.stack.services && state.stack.services.web;
      const down = web && (web.state === 'failed' || web.state === 'restarting');
      el.className = down ? 'bad' : 'muted';
      el.textContent = down ? 'the server on this computer is not running — see Settings' : 'starting the server on this computer…';
    }
    else { el.className = 'muted'; el.textContent = ''; }
  }

  // Said in the top bar while developer mode is on, so a test site is never
  // taken for what everybody else sees.
  function renderDev() {
    $('devmode').classList.toggle('hidden', !dev());
  }

  function renderUpdate() {
    const btn = $('update');
    const u = state.update || {};
    if (u.phase === 'ready') { btn.className = 'pill'; btn.textContent = `Update ${u.version || ''} ready — restart`; btn.onclick = () => api.call('update:install'); }
    else if (u.phase === 'available' || u.phase === 'downloading') { btn.className = 'pill busy'; btn.textContent = u.phase === 'downloading' ? `Downloading update ${u.percent || 0}%` : 'Update found…'; btn.onclick = null; }
    else { btn.className = 'pill hidden'; }
    if (state.route.page === 'settings' && state.settings) { state.settings.updates = u; renderSettings(); }
  }

  function renderCrumbs() {
    const r = state.route;
    const parts = [];
    const link = (label, page, params) => `<a data-go="${esc(JSON.stringify({ page, params: params || {} }))}">${esc(label)}</a>`;
    const here = (label) => `<span class="here">${esc(label)}</span>`;
    // The two top-level screens are already named by the buttons beside the crumbs.
    if (r.page === 'sites' || r.page === 'console') { /* nothing */ }
    else if (r.page === 'site') { const d = state.siteDocs[r.slug]; parts.push(link('Sites', 'sites'), here(d ? d.site.name : r.slug)); }
    else if (r.page === 'board') {
      const b = state.board && state.board.queue.id === Number(r.id) ? state.board : null;
      parts.push(link('Sites', 'sites'));
      if (b) parts.push(link(b.queue.site_name, 'site', { slug: b.queue.site_slug }), here(b.queue.name));
      else parts.push(here(`Line ${r.id}`));
    } else parts.push(here({ signin: 'Sign in', profile: 'Your profile', import: 'Import from your browser', settings: 'Settings', help: 'Help', found: 'Found a slot', credits: 'Credits', advanced: 'Advanced — telemetry and diagnostics', request: 'Ask for a line' }[r.page] || r.page));
    $('crumbs').innerHTML = parts.join('<span>›</span>');
    for (const a of $('crumbs').querySelectorAll('a[data-go]')) {
      a.addEventListener('click', () => { const t = JSON.parse(a.dataset.go); go(t.page, t.params); });
    }
    for (const b of document.querySelectorAll('#topnav button')) b.classList.toggle('on', b.dataset.page === r.page || (b.dataset.page === 'sites' && (r.page === 'site' || r.page === 'board')));
  }

  // -------------------------------------------------------- your turn
  /**
   * Turns that were in the last sync and are not in this one: how each ended,
   * from what the site says of the bid now — booked, run out (and what came
   * back), or gone on to somebody else with the place kept. Said in the banner
   * over the booking page, which stays open, until dismissed or a while later.
   */
  function endedTurns(before, doc) {
    if (!before || !doc) return;
    const now = new Set((doc.handoffs || []).map((h) => h.job_id));
    for (const h of before.handoffs || []) {
      if (now.has(h.job_id) || state.ended.some((e) => e.job_id === h.job_id)) continue;
      const where = h.slot ? `${h.queue_name} — ${h.slot.office_name}, ${h.slot.date} at ${h.slot.time}` : h.queue_name;
      const settled = (doc.settled || []).find((x) => x.bid_id === h.bid_id);
      const still = (doc.positions || []).find((x) => x.bid_id === h.bid_id);
      let kind = 'muted';
      let text = `Your turn on ${where} has ended.`;
      if (settled && settled.status === 'fulfilled') {
        kind = 'ok';
        text = `Booked: ${where}${settled.confirmation ? ` — confirmation ${settled.confirmation}` : ''}.`;
      } else if (settled && !['active', 'processing'].includes(settled.status)) {
        kind = 'bad';
        text = `${where}: ${settled.note || `your bid ended ${settled.status}.`}`;
      } else if (still) {
        text = `${where} went on to the next person.${still.note ? ` ${still.note}` : ' You keep your place in line.'}`;
      }
      state.ended.unshift({ job_id: h.job_id, at: Date.now(), kind, text });
      const handoffsNow = [...now].join(',') || 'none';
      uiNote('banner', `Your turn ended job ${h.job_id} ${kind} — ${text} | handoffs now ${handoffsNow} | position ${still ? still.status : 'none'} | settled ${settled ? settled.status : 'none'}`);
    }
    state.ended = state.ended.filter((e) => Date.now() - e.at < 15 * 60000).slice(0, 3);
  }

  /** What the person does now, and what letting it run out costs (the site's `missed`). */
  function turnSteps(h) {
    const what = h.slot
      ? `Book it on the booking page: choose <b>${esc(h.slot.office_name)}</b> on ${esc(h.slot.date)} at ${esc(h.slot.time)} and confirm`
      : 'Book the first time that suits you on the booking page';
    const m = h.missed;
    const cost = !m ? 'then it passes to the next bidder. You keep your place either way.'
      : `Can't take it? Pass, and you keep your place. Let the time run out and you leave the line${m.kept ? ` with ${coins(m.refund)} of your ${coins(m.refund + m.kept)} back (${num(m.refund_percent)}%)` : ', your bid refunded'}.`;
    return `${what} — your details fill in from your profile, and the app sees the confirmation. ${cost}`;
  }

  function adviceGoneMap() {
    if (state.adviceGone) return state.adviceGone;
    const gone = {};
    try {
      const raw = JSON.parse(localStorage.getItem('regbot.adviceGone') || '[]');
      if (Array.isArray(raw)) for (const key of raw) if (typeof key === 'string') gone[key] = true;
    } catch { /* a dismiss this session still sticks in the map below */ }
    state.adviceGone = gone;
    return gone;
  }

  function rememberAdviceGone(key) {
    const gone = adviceGoneMap();
    gone[key] = true;
    try {
      localStorage.setItem('regbot.adviceGone', JSON.stringify(Object.keys(gone).slice(-40)));
    } catch { /* still remembered until the page reloads */ }
  }

  function situationPace() {
    if (state.situationPace) return state.situationPace;
    try {
      const raw = JSON.parse(localStorage.getItem('regbot.situationPace') || 'null');
      if (raw && typeof raw.key === 'string' && Number.isFinite(Number(raw.nextAt))) {
        state.situationPace = {
          key: raw.key,
          closed: Number(raw.closed) || 0,
          nextAt: Number(raw.nextAt),
          open: !!raw.open,
        };
        return state.situationPace;
      }
    } catch { /* a wait this session still sticks in the state below */ }
    return null;
  }

  function saveSituationPace(pace) {
    state.situationPace = pace;
    try {
      if (!pace) localStorage.removeItem('regbot.situationPace');
      else localStorage.setItem('regbot.situationPace', JSON.stringify(pace));
    } catch { /* still remembered until the page reloads */ }
  }

  function armSituation(ms) {
    if (state.situationTimer) clearTimeout(state.situationTimer);
    state.situationTimer = null;
    if (ms == null || ms < 0) return;
    state.situationTimer = setTimeout(() => renderSituation(true), Math.min(ms + 20, 2147483647));
  }

  /** The second bar: the nearest opening, with no button that changes the bid. */
  function renderSituation(force, doc) {
    const box = $('situation');
    if (!box || !window.situationBar) return;
    const decided = window.situationBar.visible(doc || state.doc, situationPace(), Date.now());
    saveSituationPace(decided.pace);
    armSituation(decided.armIn);
    const show = decided.show;
    const news = window.situationBar.announced(state.situationNoted, show, decided.pace);
    const painted = show ? news.noted : '';
    if (!show) {
      if (!box.classList.contains('hidden')) {
        box.classList.add('hidden');
        box.innerHTML = '';
        state.situationPainted = '';
        fit();
      }
      return;
    }
    if (!force && state.situationPainted === painted && !box.classList.contains('hidden')) return;
    box.classList.remove('hidden');
    const line = show.queue_name ? `${show.queue_name} — ` : '';
    const said = window.situationBar.sentence(show, prettyDate);
    box.innerHTML = `<span class="mark">·</span>
      <span class="text"><b>Nearest opening</b> · ${esc(line + said)}
        <br><span class="tiny">This does not change your bid.</span></span>
      <span class="actions"><button class="pill" data-act="dismiss" title="Dismiss">×</button></span>`;
    box.querySelector('[data-act=dismiss]').addEventListener('click', () => {
      saveSituationPace(window.situationBar.dismiss(situationPace(), Date.now()));
      state.situationNoted = '';
      state.situationPainted = '';
      renderSituation(true, doc);
    });
    state.situationPainted = painted;
    if (news.log) {
      state.situationNoted = news.noted;
      uiNote('banner', `situation ${show.key} — ${said}`);
    }
    fit();
  }

  function renderBanner(force) {
    const box = $('banner');
    const handoffs = (state.doc && state.doc.handoffs) || [];
    const robotOn = (state.robots && state.robots.booking && state.robots.booking.job_id) || null;
    state.ended = state.ended.filter((e) => Date.now() - e.at < 15 * 60000);
    // The hand-off whose booking page is the one on screen: no button to open it.
    const showing = (state.shell.tabs.find((t) => t.active) || {}).jobId || null;
    // A turn already on the banner is the whole of it. The suggestion comes
    // back on its own once that turn is gone, unless this exact key was closed.
    const kept = window.adviceBanner && window.adviceBanner.hold
      ? window.adviceBanner.hold(state.doc, state.adviceHold, Date.now(), adviceGoneMap())
      : { advice: null, at: 0, doc: state.doc };
    state.adviceHold = kept.advice ? { advice: kept.advice, at: kept.at } : null;
    const advice = kept.advice;
    renderSituation(false, kept.doc || state.doc);
    const adviceMark = advice ? `${advice.key}|${advice.office_code || ''}|${advice.slot_date || ''}|${advice.slot_time || ''}` : '';
    const key = handoffs.map((h) => `${h.job_id}:${h.phase}:${h.booker ? `${h.booker.name}:${h.booker.silent}` : ''}:${h.over ? h.over.kind : ''}`).join(',')
      + `|${state.prompt}|${robotOn}|${state.ended.map((e) => e.job_id).join(',')}|${showing}|${adviceMark}`;
    if (!force && key === state.bannerKey) { tickClocks(); return; }
    state.bannerKey = key;
    box.innerHTML = '';
    if (!handoffs.length && !state.ended.length && !advice) { box.classList.add('hidden'); fit(); return; }
    box.classList.remove('hidden');
    for (const e of state.ended) {
      const row = document.createElement('div');
      row.className = `banner-row ended-${e.kind}`;
      row.innerHTML = `<span class="mark">${e.kind === 'ok' ? '✓' : e.kind === 'bad' ? '✗' : '☞'}</span>
        <span class="text"><b>Your turn ended</b> · ${esc(e.text)}</span>
        <span class="actions"><button class="pill" data-act="dismiss" title="Dismiss">×</button></span>`;
      row.querySelector('[data-act=dismiss]').addEventListener('click', () => {
        state.ended = state.ended.filter((x) => x.job_id !== e.job_id);
        renderBanner(true);
      });
      box.appendChild(row);
    }
    if (advice) {
      const row = document.createElement('div');
      row.className = 'banner-row advice';
      const line = advice.queue_name ? `${advice.queue_name} — ` : '';
      const said = window.adviceBanner.sentence(advice, prettyDate);
      row.innerHTML = `<span class="mark">↑</span>
        <span class="text"><b>A better opening</b> · ${esc(line + said)}
          <br><span class="tiny">Nothing changes until you apply this.</span></span>
        <span class="actions">
          <button class="pill primary" data-act="apply">${esc(window.adviceBanner.actionLabel(advice))}</button>
          <button class="pill" data-act="dismiss" title="Dismiss">×</button>
        </span>`;
      row.querySelector('[data-act=apply]').addEventListener('click', () => doAdvice(advice));
      row.querySelector('[data-act=dismiss]').addEventListener('click', () => {
        rememberAdviceGone(advice.key);
        renderBanner(true);
      });
      box.appendChild(row);
      if (state.adviceNoted !== advice.key) {
        state.adviceNoted = advice.key;
        uiNote('banner', `recommendation ${advice.key} — ${said}`);
      }
    }
    for (const h of handoffs) {
      const row = document.createElement('div');
      row.className = 'banner-row';
      const where = h.slot ? `<b>${esc(h.slot.office_name)}</b>, ${esc(h.slot.date)} at ${esc(h.slot.time)}${h.slot.miles ? ` <span class="tiny">(${num(h.slot.miles)} mi)</span>` : ''}` : `you are at the front of <b>${esc(h.queue_name)}</b>`;
      const settling = h.phase === 'booked';
      const gap = missingOf(h);
      // This app's robot is booking it, or another of the person's devices is.
      const robot = robotOn === h.job_id;
      const elsewhere = h.booker && !h.booker.you ? h.booker.name : '';
      const quiet = Boolean(elsewhere && h.booker.silent);
      // Offered to several people a few seconds apart; the first to book it has it.
      const wave = h.wave ? ` <span class="tiny">· offered to ${num(h.wave.of)} people, you ${h.wave.place === 1 ? 'first' : `#${num(h.wave.place)} in turn`}</span>` : '';
      row.innerHTML = `
        <span class="mark">☞</span>
        <span class="text"><b>Your turn</b> · ${esc(h.queue_name)} <span class="tiny">${esc(h.site_name)}</span><br>
          ${where}${wave} — ${settling ? 'you said you booked it; the processor is settling it'
            : h.over ? `${h.over.kind === 'taken' ? 'somebody else offered it too got it first' : 'it was gone'} (${esc(h.over.message)}). You keep your place in line.`
            : robot ? `this computer's robot is booking it for you now · <span class="clock" data-job="${num(h.job_id)}">${clock(left(h))}</span> left`
            : quiet ? `${esc(elsewhere)} was booking it and stopped answering · <span class="clock" data-job="${num(h.job_id)}">${clock(left(h))}</span> left`
            : elsewhere ? `${esc(elsewhere)} is booking it · <span class="clock" data-job="${num(h.job_id)}">${clock(left(h))}</span> left`
            : `<span class="clock" data-job="${num(h.job_id)}">${clock(left(h))}</span> left.<br><span class="steps">${turnSteps(h)}</span>`}
          ${gap.length && !settling ? `<br><span class="tiny">Your profile has no ${esc(tellNames(gap))} — the app asks for them before it opens the form.</span>` : ''}
        </span>
        <span class="actions"></span>`;
      const actions = row.querySelector('.actions');
      // Nothing to press while this computer's robot is at the form: a booking
      // started by hand beside it could make two. Nor once it has gone.
      if (!settling && !robot && !h.over) {
        if (state.prompt === h.job_id) {
          actions.innerHTML = `<input type="text" maxlength="80" placeholder="Booking reference (optional)" aria-label="Booking reference"><button class="pill primary" data-act="confirm">Confirm</button><button class="pill" data-act="cancel">Cancel</button>`;
          const input = actions.querySelector('input');
          setTimeout(() => input.focus(), 0);
          input.addEventListener('keydown', (e) => { if (e.key === 'Enter') actions.querySelector('[data-act=confirm]').click(); });
          actions.querySelector('[data-act=confirm]').addEventListener('click', async () => {
            try { const reply = await call('handoff:booked', { job_id: h.job_id, confirmation: input.value.trim() }); toast('ok', reply.message || 'Recorded.'); }
            catch (err) { toast('bad', err.message, 9000); }
            state.prompt = null; renderBanner(true);
          });
          actions.querySelector('[data-act=cancel]').addEventListener('click', () => { state.prompt = null; renderBanner(true); });
        } else {
          const open = gap.length || showing !== h.job_id;
          actions.innerHTML = `${open ? `<button class="pill" data-act="open">${gap.length ? 'Add your details' : 'Open the booking page ↗'}</button>` : ''}<button class="pill primary" data-act="booked">I booked it</button><button class="pill" data-act="pass" title="Hand it to the next bidder; you keep your place">Pass</button>`;
          if (open) actions.querySelector('[data-act=open]').addEventListener('click', () => api.call('handoff:open', { job_id: h.job_id }));
          actions.querySelector('[data-act=booked]').addEventListener('click', () => { state.prompt = h.job_id; renderBanner(true); });
          actions.querySelector('[data-act=pass]').addEventListener('click', async () => {
            try { const reply = await call('handoff:pass', { job_id: h.job_id, reason: '' }); toast('ok', reply.message || 'Passed.'); }
            catch (err) { toast('bad', err.message, 9000); }
          });
        }
      }
      box.appendChild(row);
    }
    fit();
  }

  function tickClocks() {
    const handoffs = (state.doc && state.doc.handoffs) || [];
    for (const el of document.querySelectorAll('.clock')) {
      const h = handoffs.find((x) => String(x.job_id) === el.dataset.job);
      if (h) el.textContent = clock(left(h));
    }
    const pend = $('pair-left');
    if (pend && state.pair.pending) {
      const secs = (Date.parse(state.pair.pending.expiresAt) - Date.now()) / 1000;
      pend.textContent = secs > 0 ? `code good for ${clock(secs)}` : 'code expired — start again';
    }
  }

  // ------------------------------------------------------- found form
  async function openFound() {
    if (state.form) { state.form = null; renderFound(); return; }
    const positions = (state.doc && state.doc.positions) || [];
    if (!positions.length) { toast('warn', 'Join a line first — reports are taken from bidders on the line.'); return; }
    const prefill = await api.call('found:prefill');
    const first = prefill.office_code ? (positions.find((p) => p.has_places) || positions[0]) : positions[0];
    state.form = { queueId: first.queue_id, places: [], result: null, busy: false, prefill: prefill || {} };
    renderFound();
    await loadPlaces();
  }

  async function loadPlaces() {
    const f = state.form;
    if (!f) return;
    const pos = state.doc.positions.find((p) => p.queue_id === f.queueId);
    f.places = pos && pos.has_places ? (await api.call('found:places', { site_slug: pos.site_slug })) : [];
    if (!Array.isArray(f.places)) f.places = [];
    renderFound();
  }

  function renderFound() {
    const box = $('foundform');
    const f = state.form;
    if (!f) { box.classList.add('hidden'); box.innerHTML = ''; fit(); return; }
    const positions = (state.doc && state.doc.positions) || [];
    const pos = positions.find((p) => p.queue_id === f.queueId) || positions[0];
    const pre = f.prefill || {};
    const office = f.places.length
      ? `<label>Office<select id="f-office">${f.places.map((p) => `<option value="${esc(p.code)}" ${pre.office_code && (pre.office_code === p.code || pre.office_code === p.slug) ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></label>`
      : `<label>Office<input id="f-office" value="${esc(pos && pos.site_name)}" disabled></label>`;
    box.innerHTML = `
      <h3>Report a slot you found <span class="tiny">— the board decides who gets it; if that is not you, it is passed to them</span> <button class="pill" id="f-close" style="float:right">Close</button></h3>
      <div class="fgrid">
        <label>Line<select id="f-line">${positions.map((p) => `<option value="${num(p.queue_id)}" ${p.queue_id === (pos && pos.queue_id) ? 'selected' : ''}>#${num(p.rank)} ${esc(p.queue_name)} — ${esc(p.site_name)}</option>`).join('')}</select></label>
        ${office}
        <label>Date<input id="f-date" type="date" value="${esc(pre.slot_date || '')}" min="${esc(pos && pos.window ? pos.window[0] : '')}" max="${esc(pos && pos.window ? pos.window[1] : '')}"></label>
        <label>Time<input id="f-time" type="time" value="${esc(pre.slot_time || '')}"></label>
        <button class="pill primary" id="f-send" ${f.busy ? 'disabled' : ''}>Report</button>
      </div>
      ${f.result ? `<div class="result ${esc(f.result.kind)}">${esc(f.result.text)}</div>` : ''}`;
    box.classList.remove('hidden');
    $('f-line').addEventListener('change', (e) => { f.queueId = Number(e.target.value); f.result = null; loadPlaces(); });
    $('f-send').addEventListener('click', submitFound);
    $('f-close').addEventListener('click', () => { state.form = null; renderFound(); });
    fit();
  }

  async function submitFound() {
    const f = state.form;
    if (!f || f.busy) return;
    const report = { queue_id: Number($('f-line').value), slot_date: $('f-date').value, slot_time: $('f-time').value };
    if (f.places.length) report.office_code = $('f-office').value;
    f.busy = true; renderFound();
    const reply = await api.call('found:submit', report);
    f.busy = false;
    if (reply.error) f.result = { kind: 'error', text: reply.error };
    else f.result = { kind: reply.verdict === 'yours' ? 'yours' : (reply.verdict === 'passed' ? 'passed' : ''), text: reply.message };
    renderFound();
  }

  // -------------------------------------------------------------- router
  function go(page, params = {}) {
    if (page === 'found') { openFound(); return; }
    // A browser installed since the last look should be in the list.
    if (page === 'import') state.imports = null;
    if (state.boardTimer) { clearInterval(state.boardTimer); state.boardTimer = null; }
    if (state.advTimer) { clearInterval(state.advTimer); state.advTimer = null; }
    if (page === 'credits') {
      state.credits = null;
      // A purchase that has settled has said so; a new visit starts clean.
      if (state.checkout && state.checkout.status !== 'pending') state.checkout = null;
    }
    state.route = { page, ...params };
    $('page').scrollTop = 0;
    // Which screen, by its name, for the trace (src/traces.js).
    api.call('trace:ui', { page }).catch(() => {});
    render();
    renderAgain();
  }

  function render() {
    renderCrumbs();
    const page = $('page');
    switch (state.route.page) {
      case 'signin': return renderSignin();
      case 'sites': return renderSites();
      case 'site': return renderSite();
      case 'board': return renderBoard();
      case 'console': return renderConsole();
      case 'profile': return renderProfile();
      case 'import': return renderImport();
      case 'settings': state.resetAsk = false; return renderSettings(true);
      case 'help': return renderHelp();
      case 'credits': return renderCredits();
      case 'request': state.requests = null; return renderRequest();
      case 'advanced': state.advPreview = null; return renderAdvanced(true);
      default: page.innerHTML = '<div class="wrap"><div class="empty">Nothing here.</div></div>';
    }
    return undefined;
  }

  function needSignin(what) {
    $('page').innerHTML = `<div class="wrap"><div class="signin"><h1>Sign in first</h1><p class="lead">${esc(what)} needs an account.</p>
      <button class="btn btn-accent" id="s-go">Sign in on the website</button></div></div>`;
    $('s-go').addEventListener('click', () => go('signin'));
  }

  // -------------------------------------------------------------- sign in
  function renderSignin() {
    const p = state.pair;
    const pend = p.pending;
    let body;
    if (builtin()) {
      $('page').innerHTML = `<div class="wrap"><div class="signin">
        <h1>Practising on this computer</h1>
        <p class="lead">This app is running its own copy of LineRight Regbot for practice, and you are its account${p.user ? ` — <b>${esc(p.user.nickname)}</b>` : ''}. The lines here are practice: nobody else is in them, and there is nothing to sign in to.</p>
        <div class="panel"><div class="row"><button class="btn btn-accent" id="s-sites">Go to the sites</button><button class="btn btn-ghost" id="s-settings">Use the LineRight Regbot site…</button></div></div>
      </div></div>`;
      $('s-sites').addEventListener('click', () => go('sites'));
      $('s-settings').addEventListener('click', () => go('settings'));
      return;
    }
    if (p.paired) {
      body = `<div class="panel"><p class="small" style="margin:0 0 10px">You are signed in as <b>${esc((p.user || {}).nickname || '')}</b>.</p>
        <div class="row"><button class="btn btn-accent" id="s-sites">Go to the sites</button><button class="btn btn-ghost" id="s-out">Sign out</button></div></div>`;
    } else if (pend) {
      body = `<div class="panel">
        <p class="small" style="margin:0">Your browser has opened the LineRight Regbot website with this app's code. Create your account there — or sign in — and approve it:</p>
        <div class="code" id="pair-code">${esc(pend.code)}</div>
        <p class="small muted" style="margin:0 0 12px">Waiting for the approval… <span id="pair-left" class="num"></span>. If nothing opened, go to <a id="s-open">${esc(pend.siteUrl || '')}/pair</a> yourself and type the code.</p>
        <div class="row"><button class="btn" id="s-open2">Open the website again</button><button class="btn btn-ghost" id="s-cancel">Cancel</button></div>
      </div>`;
    } else {
      body = `<div class="panel">
        <ol class="steps">
          <li>Click the button. Your usual browser opens the LineRight Regbot website, on a page showing the code this app is waiting on.</li>
          <li>Create your account there — or sign in, if you have one, with a password or with Google when the site offers it.</li>
          <li>Approve the code. The app signs itself in within a few seconds; your password never passes through it.</li>
        </ol>
        <button class="btn btn-accent btn-block" id="s-start">Create an account or sign in</button>
        ${p.message ? `<p class="small ${/fail|not reach|unpaired|expired|declined/i.test(p.message) ? 'bad' : 'muted'}" style="margin:12px 0 0">${esc(p.message)}</p>` : ''}
      </div>`;
    }
    const where = (state.settings && state.settings.serverUrl) || '';
    let host = where;
    try { host = new URL(where).host; } catch { /* not an address yet */ }
    $('page').innerHTML = `<div class="wrap"><div class="signin">
      <h1>${p.paired ? 'Signed in' : 'Create your LineRight Regbot account'}</h1>
      <p class="lead">${p.paired
        ? 'The LineRight Regbot app shows your lines, looks for openings, and books a slot for you from this computer when it is your turn. It keeps your personal details on this machine.'
        : `LineRight Regbot keeps the line on its website${host ? `, <b>${esc(host)}</b>` : ''}: who is waiting, in what order, and what a place is worth. Your account is there; this app is how you take part — it bids, looks for openings, and books for you from this computer, with your personal details never leaving it.`}</p>
      ${body}
      <p class="small muted" style="margin:16px 0 0; text-align:center">Server: <span class="num">${esc((state.settings && state.settings.serverUrl) || '')}</span>${dev() ? ' · <a id="s-settings">change</a>' : ''} · <a id="s-browse">browse the sites without signing in</a></p>
    </div></div>`;
    const on = (id, fn) => { const el = $(id); if (el) el.addEventListener('click', fn); };
    on('s-start', async () => { const reply = await api.call('pair:start'); state.pair = reply; renderSignin(); });
    on('s-open', () => api.call('pair:open'));
    on('s-open2', () => api.call('pair:open'));
    on('s-cancel', async () => { state.pair = await api.call('pair:cancel'); renderSignin(); });
    on('s-sites', () => go('sites'));
    on('s-out', () => api.call('pair:forget'));
    on('s-settings', () => go('settings'));
    on('s-browse', () => go('sites'));
    tickClocks();
    if (!state.settings) api.call('settings:get').then((s) => { state.settings = s; if (state.route.page === 'signin') renderSignin(); });
  }

  // ---------------------------------------------------------------- sites
  async function loadSites(force) {
    if (!force && state.sites && Date.now() - state.sitesAt < 30000) return state.sites;
    const doc = await call('server:sites', {});
    state.sites = doc.sites || [];
    state.sitesAt = Date.now();
    return state.sites;
  }

  function siteMatches(s, q) {
    if (!q) return true;
    const hay = [s.name, s.tagline, s.category, s.description, s.slug, ...(s.queues || []).map((x) => `${x.name} ${x.description}`)].join(' ').toLowerCase();
    return q.toLowerCase().split(/\s+/).filter(Boolean).every((w) => hay.includes(w));
  }

  // ------------------------------------------------ checking lines, and earning
  /**
   * The ask: let this app check lines for everybody, and earn credits for it.
   *
   * Every opening anyone in line gets is found by somebody's app, and the site
   * pays for the looking (its allowance.py). On a site whose lines are on the
   * real DMV the app looks only once its person has said yes — it is automated
   * traffic from their address — so it asks, once, with yes as the button.
   * Either answer is kept; Settings changes it after.
   */
  function checkingAsk() {
    const r = state.robots || {};
    if (!paired() || builtin() || !r.available || !r.wanted || r.agreed || r.answered) return '';
    const k = state.doc && state.doc.allowance && state.doc.allowance.checking;
    const per = k && k.per_hour ? coins(k.per_hour) : '';
    return `<div class="panel earn-ask" id="earn-ask">
      <div class="row" style="margin-bottom:7px"><span class="chip chip-accent">${per ? 'Earn credits' : 'Help everyone in line'}</span>
        <b>Check lines while this app runs</b></div>
      <p class="small" style="margin:0 0 12px; max-width:74ch">Every opening anybody in line gets is found by somebody's app, looking
      at the DMV's booking pages. Let this one take its turn: now and then it checks a line's offices from this computer, in a browser
      you do not see${per ? ` — and earns you <b>${per} an hour</b> while the app runs` : ''}. It is automated traffic from your own
      internet address, a few pages at a time. Whatever it finds goes to whoever is first in line, which may be you.</p>
      <div class="row"><button class="btn btn-accent" id="earn-yes">Check lines${per ? ' and earn credits' : ''}</button>
        <button class="btn btn-ghost btn-sm" id="earn-no">Not now</button>
        <span class="tiny muted">Settings turns it off again.</span></div></div>`;
  }

  function wireCheckingAsk(rerender) {
    const yes = $('earn-yes');
    if (yes) yes.addEventListener('click', () => turnCheckingOn(rerender));
    const no = $('earn-no');
    if (no) {
      no.addEventListener('click', async () => {
        try { await call('settings:set', { realDmvChecks: false }); } catch (err) { toast('bad', err.message, 9000); }
        state.robots = await api.call('robots:status');
        rerender();
      });
    }
  }

  async function turnCheckingOn(rerender, { confirm = false } = {}) {
    if (confirm && state.settings && state.settings.publicSite
      && !window.confirm('Let this app check lines for everybody on dmv.ca.gov, from this computer? It is automated traffic from your internet address, a few pages at a time.')) return;
    try {
      state.settings = await call('settings:set', { checking: true });
      const k = state.doc && state.doc.allowance && state.doc.allowance.checking;
      toast('ok', k && k.per_hour ? `Checking lines — ${coins(k.per_hour)} an hour while the app runs.` : 'Checking lines for everybody in line.');
    } catch (err) {
      toast('bad', err.message, 9000);
    }
    state.robots = await api.call('robots:status');
    rerender();
  }

  function renderSites() {
    const page = $('page');
    const mine = new Map(((state.doc && state.doc.positions) || []).map((p) => [p.site_slug, (mineCount(p.site_slug))]));
    function mineCount(slug) { return ((state.doc && state.doc.positions) || []).filter((p) => p.site_slug === slug).length; }
    const sites = state.sites;
    const shown = (sites || []).filter((s) => siteMatches(s, state.query));
    // Only ever here in developer mode (main.js leaves them out otherwise), and said so.
    const tests = (sites || []).filter((s) => s.mock).length;
    page.innerHTML = `<div class="wrap">
      ${checkingAsk()}
      <div class="search">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
        <input id="q" type="text" value="${esc(state.query)}" autocomplete="off" spellcheck="false" placeholder="Search sites or lines — try “DMV” or “REAL ID”">
      </div>
      ${tests ? `<div class="note test-note" style="margin-bottom:14px"><b>Developer mode:</b> ${num(tests)} test site${tests === 1 ? ' is' : 's are'} listed too, marked <span class="test-badge">Test site</span>. They are made up for demos and tests, and nothing booked on them is real. <b>View → Developer mode</b> hides them.</div>` : ''}
      ${sites === null ? '<div class="empty">Loading the sites…</div>'
        : !sites.length ? (builtin() ? '<div class="empty">The server on this computer lists no sites yet. Settings → Server says how it is doing.</div>'
          : `<div class="empty">The server lists no sites. Is it running at <span class="num">${esc((state.settings && state.settings.serverUrl) || 'the configured address')}</span>?</div>`)
        : !shown.length ? `<div class="card empty">Nothing matches <strong>${esc(state.query)}</strong>. <a id="q-clear">Show all ${sites.length} sites</a></div>`
        : `<div class="site-grid">${shown.map((s) => `
          <div class="card site-card${s.mock ? ' site-test' : ''}" data-slug="${esc(s.slug)}" style="--accent-raw:${esc(s.accent)}">
            <div class="site-img"><span class="site-cat">${esc(s.category)}</span>${s.mock ? '<span class="test-badge on-img">Test site</span>' : ''}<img src="${esc(s.image_url)}" alt="" loading="lazy"></div>
            <div class="site-body">
              <h3>${esc(s.name)}</h3>
              <p>${esc(s.tagline)}</p>
              ${s.mock ? '<p class="tiny test-line">Made up for demos and tests — no real appointments.</p>' : ''}
              <div class="site-foot">
                <span><b>${num(s.open_queues)}</b> line${s.open_queues === 1 ? '' : 's'}</span>
                <span><b>${num(s.live_bids)}</b> bidding</span>
                ${mine.get(s.slug) ? `<span class="site-mine">you: ${mine.get(s.slug)} position${mine.get(s.slug) === 1 ? '' : 's'}</span>` : ''}
                <span style="margin-left:auto">top <b>${coins(s.top_bid)}</b></span>
              </div>
            </div>
          </div>`).join('')}</div>`}
      ${sites && sites.length ? `<div class="card rq-ask"><div><b>Not here?</b> <span class="muted">Can't find your booking site, or the appointments you need?</span></div>
        <button class="btn btn-sm" id="ask-line">Ask for a line →</button></div>` : ''}
    </div>`;
    const ask = $('ask-line');
    if (ask) ask.addEventListener('click', () => go('request', { prefill: state.query ? { site_name: state.query } : null }));
    wireCheckingAsk(() => { if (state.route.page === 'sites') renderSites(); });
    const q = $('q');
    q.addEventListener('input', () => { state.query = q.value; const at = q.selectionStart; renderSites(); const nq = $('q'); nq.focus(); nq.setSelectionRange(at, at); });
    const clear = $('q-clear'); if (clear) clear.addEventListener('click', () => { state.query = ''; renderSites(); });
    for (const card of page.querySelectorAll('.site-card')) card.addEventListener('click', () => go('site', { slug: card.dataset.slug }));
    if (sites === null || Date.now() - state.sitesAt > 30000) {
      loadSites(true).then(() => { if (state.route.page === 'sites') renderSites(); })
        .catch((err) => { if (state.route.page === 'sites') page.innerHTML = `<div class="wrap"><div class="note bad">Could not load the sites: ${esc(err.message)}</div></div>`; });
    }
  }

  // ----------------------------------------------------------------- site
  /**
   * Which of a line's personal fields are in the profile.
   *
   * The main process works this out (it is the only side that can see the
   * values) and hangs `needs_status` on whatever it sends. Everything here
   * reads that: the dots, the notice on the join form, the warning on a
   * hand-off. `missingOf` is the list that stops a bid.
   */
  const statusOf = (d) => (d && d.needs_status) || [];
  const missingOf = (d) => statusOf(d).filter((f) => f.state === 'missing');
  const tellNames = (list) => {
    const names = list.map((f) => String(f.label).toLowerCase());
    return names.length <= 1 ? (names[0] || '')
      : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  };

  function keptList(d) {
    const dot = { held: 'var(--ok)', missing: 'var(--gold)', 'on-form': 'var(--faint)', optional: 'var(--faint)' };
    const says = { held: '· in your profile', missing: '· missing from your profile', 'on-form': '· typed on the form', optional: '· not needed for this line' };
    return `<ul class="req-list">${statusOf(d).map((f) => `
      <li><span class="req-dot" style="background:${dot[f.state]}"></span><span>${esc(f.label)} <span class="home">${says[f.state]}</span></span></li>`).join('')}</ul>`;
  }

  /**
   * How a line hands out its slots, as the server says (`dispatch`): each one
   * as an app finds it, to the best-placed bidder it fits — or a turn for the
   * top few every cycle, the only kind with a next hand-off to count down to.
   * A server from before it said so has cycles everywhere.
   */
  const byOffers = (q) => Boolean(q && q.dispatch === 'offers');
  const dispatchChip = (q) => (byOffers(q) ? 'each slot as an app finds it'
    : `top ${num(q.slots_per_cycle)} get a turn every ${num(q.cycle_seconds)}s`);

  function renderSite() {
    const slug = state.route.slug;
    const page = $('page');
    const d = state.siteDocs[slug];
    if (!d) {
      page.innerHTML = '<div class="wrap"><div class="empty">Loading…</div></div>';
      call('server:site', { slug }).then((doc) => { state.siteDocs[slug] = doc; if (state.route.page === 'site' && state.route.slug === slug) { renderCrumbs(); renderSite(); } })
        .catch((err) => { page.innerHTML = `<div class="wrap"><div class="note bad">${esc(err.message)}</div></div>`; });
      if (!state.profile) api.call('profile:get').then((p) => { state.profile = p; });
      return;
    }
    const s = d.site;
    page.innerHTML = `<div class="wrap" style="--accent-raw:${esc(s.accent)}">
      ${s.mock ? `<div class="note test-note" style="margin-bottom:14px">${TEST_NOTE}</div>` : ''}
      <div class="sitehead">
        <img src="${esc(s.image_url)}" alt="">
        <div style="flex:1; min-width:0">
          <span class="chip chip-accent">${esc(s.category)}</span>
          <h1>${esc(s.name)}</h1>
          <p>${esc(s.tagline)}</p>
        </div>
        <div class="stack" style="gap:8px">
          <button class="btn btn-accent" id="site-portal" title="${esc(s.portal_url)}">Open the booking site ↗</button>
        </div>
      </div>
      <div class="split">
        <div class="stack">
          <div class="panel">
            <div class="panel-title">Lines · ${d.queues.length}</div>
            ${d.queues.map((q) => `
              <div class="queue-card" data-id="${num(q.id)}">
                <div class="between" style="align-items:flex-start">
                  <div style="min-width:0">
                    <h4>${esc(q.name)} ${q.status !== 'open' ? `<span class="tag tag-${esc(q.status)}">${esc(q.status)}</span>` : ''}</h4>
                    <p class="qdesc">${esc(q.description)}</p>
                  </div>
                  <div class="queue-metrics">
                    <div><div class="metric-v">${coins(q.top_bid)}</div><div class="metric-k">Top bid</div></div>
                    <div><div class="metric-v">${num(q.live_bids)}</div><div class="metric-k">In line</div></div>
                    ${q.mine ? `<div><div class="metric-v" style="color:var(--accent)">#${num(q.mine.rank)}</div><div class="metric-k">You · ${coins(q.mine.amount)}</div></div>` : ''}
                  </div>
                </div>
                <div class="chips">
                  <span class="chip">📅 <strong>${esc(prettyDate(q.window[0]))}</strong> → <strong>${esc(prettyDate(q.window[1]))}</strong></span>
                  <span class="chip">🕐 <strong>${esc(q.hours[0])}–${esc(q.hours[1])}</strong> ${esc(q.timezone)}</span>
                  <span class="chip">${esc(q.weekdays)}</span>
                  <span class="chip">entry <strong>${coins(q.min_bid)}</strong></span>
                  <span class="chip">${dispatchChip(q)}</span>
                </div>
              </div>`).join('')}
            <p class="tiny muted" style="margin:10px 0 0">Need another kind of appointment on ${esc(s.name)}? <a id="site-ask">Ask for a line</a>.</p>
          </div>
          <div class="panel"><div class="panel-title">About this site</div><p class="small muted" style="margin:0; line-height:1.6">${esc(s.description)}</p></div>
        </div>
        <div class="stack">
          <div class="panel">
            <div class="panel-title">What a bid says</div>
            ${d.fields.length ? `<ul class="req-list">${d.fields.map((f) => `<li><span class="req-dot"></span><span>${esc(f.label)}${f.required ? ' <span class="bad">*</span>' : ''}</span></li>`).join('')}</ul>` : '<p class="small muted" style="margin:0">Only your bid, and the date and time you prefer.</p>'}
            <p class="tiny muted" style="margin:10px 0 0">This is all the board ever holds about you, plus a nickname.</p>
          </div>
          <div class="panel">
            <div class="panel-title">Kept on this machine</div>
            ${d.kept_on_device.length ? keptList(d) : '<p class="small muted" style="margin:0">This site asks for nothing personal.</p>'}
            <p class="tiny muted" style="margin:10px 0 0">The booking form asks for these; they are typed in from <a id="site-profile">your profile</a> and never sent to LineRight Regbot.</p>
          </div>
          ${d.places ? `<div class="panel"><div class="panel-title">Offices</div><p class="small muted" style="margin:0">${num(d.places)} locations. Say which one, or how far you will travel, when you bid.</p></div>` : ''}
        </div>
      </div>
    </div>`;
    for (const q of page.querySelectorAll('.queue-card')) q.addEventListener('click', () => go('board', { id: Number(q.dataset.id) }));
    $('site-portal').addEventListener('click', () => api.call('tabs:open', { url: s.portal_url, kind: 'portal', title: s.name }));
    $('site-profile').addEventListener('click', () => go('profile'));
    $('site-ask').addEventListener('click', () => go('request', { prefill: { url: s.portal_url || '', site_name: s.name } }));
  }

  // ---------------------------------------------------------------- board
  async function loadBoard(id) {
    const doc = await call('server:board', { id });
    if (state.route.page !== 'board' || Number(state.route.id) !== Number(id)) return null;
    doc._at = Date.now();
    state.board = doc;
    return doc;
  }

  function fieldHtml(f, values) {
    const v = values[f.key];
    const req = f.required ? ' <span class="req">*</span>' : '';
    if (f.type === 'checkbox') {
      return `<div class="check" data-key="${esc(f.key)}"><input type="checkbox" id="bf-${esc(f.key)}" name="${esc(f.key)}" ${v ? 'checked' : ''}><label for="bf-${esc(f.key)}"><span class="small">${esc(f.label)}${req}</span>${f.help ? `<span class="field-help">${esc(f.help)}</span>` : ''}</label></div>`;
    }
    let input;
    if (f.type === 'select') {
      input = `<select name="${esc(f.key)}"><option value="">Choose…</option>${(f.options || []).map((o) => { const val = typeof o === 'object' ? o.value : o; const label = typeof o === 'object' ? o.label : o; return `<option value="${esc(val)}" ${v === val ? 'selected' : ''}>${esc(label)}</option>`; }).join('')}</select>`;
    } else if (f.type === 'textarea') {
      input = `<textarea name="${esc(f.key)}" placeholder="${esc(f.placeholder || '')}">${esc(v || '')}</textarea>`;
    } else {
      input = `<input type="${esc(f.type || 'text')}" name="${esc(f.key)}" value="${esc(v || '')}" placeholder="${esc(f.placeholder || '')}" autocomplete="off">`;
    }
    return `<label class="field" data-key="${esc(f.key)}"><span class="field-label">${esc(f.label)}${req}</span>${input}${f.help ? `<span class="field-help">${esc(f.help)}</span>` : ''}</label>`;
  }

  function applyWhen(form, fields) {
    const valueOf = (key) => { const el = form.querySelector(`[name="${key}"]`); if (!el) return ''; return el.type === 'checkbox' ? (el.checked ? 'on' : '') : el.value; };
    for (const f of fields) {
      if (!f.when) continue;
      const wrap = form.querySelector(`[data-key="${f.key}"]`);
      if (!wrap) continue;
      const expected = f.when.equals;
      const on = Array.isArray(expected) ? expected.includes(valueOf(f.when.key)) : valueOf(f.when.key) === expected;
      wrap.classList.toggle('hidden', !on);
    }
  }

  function boardRows(b) {
    // Who is in the window for the next turn: a line that hands each slot out
    // as it is found has no such window — the slot goes to whoever it fits.
    const slots = byOffers(b.queue) ? 0 : b.queue.slots_per_cycle;
    if (!b.bids.length) return '<div class="empty">Nobody is in this line yet. The first bid takes the lead outright.</div>';
    return b.bids.map((r, i) => `${slots && i === slots && b.bids.length > slots ? `<div class="slot-line">next ${slots} get handed over</div>` : ''}
      <div class="bid-row r${i + 1}${r.mine ? ' mine' : ''}${i < slots ? ' in-slot' : ''}">
        <div class="bid-rank">${num(r.rank)}</div>
        <div class="bid-who"><span class="bid-nick">${esc(r.nickname)}${r.mine ? '<span class="tag tag-you">you</span>' : ''}${r.status === 'processing' ? '<span class="tag tag-processing">booking</span>' : ''}</span>
          <span class="bid-sub">${esc(r.age)}${r.raises ? ` · raised ${num(r.raises)}×` : ''}</span></div>
        <div class="bid-amount">${coins(r.amount)}</div>
        <div class="bid-meta">${esc(prettyDate(r.preferred_date))}<br>${esc(r.preferred_time)}${r.if_passed ? `<br><span class="tiny muted">${esc(reachLabel(r.if_passed))}</span>` : ''}</div>
      </div>`).join('');
  }

  function renderBoard() {
    const id = Number(state.route.id);
    const page = $('page');
    const b = state.board && state.board.queue.id === id ? state.board : null;
    if (!b) {
      page.innerHTML = '<div class="wrap"><div class="empty">Loading the board…</div></div>';
      loadBoard(id).then((doc) => { if (doc) { renderCrumbs(); renderBoard(); } })
        .catch((err) => { page.innerHTML = `<div class="wrap"><div class="note bad">${esc(err.message)}</div></div>`; });
      if (!state.profile) api.call('profile:get').then((p) => { state.profile = p; });
      return;
    }
    const q = b.queue;
    if (state.change && !(b.mine && b.mine.bid_id === state.change.bidId && b.mine.status === 'active' && !b.handoff)) state.change = null;
    if (!state.change && state.route.change && b.mine && b.mine.status === 'active' && !b.handoff) {
      state.route = { ...state.route, change: false };
      openChange(b);
    }
    const shape = `${b.mine ? b.mine.status : 'none'}|${b.handoff ? b.handoff.job_id : ''}|${paired()}|${state.change ? state.change.bidId : ''}`;
    const editing = document.activeElement && document.activeElement.closest('#bidForm, #changePanel');
    if (page.querySelector('#boardRows') && (shape === state.boardShape || editing)) {
      // Patch in place: the rows and the numbers, not the form somebody is typing in.
      page.querySelector('#boardRows').innerHTML = boardRows(b);
      const set = (sel, v) => { const el = page.querySelector(sel); if (el) el.textContent = v; };
      set('#myRank', b.mine ? b.mine.rank : ''); set('#myField', b.field_size); set('#myAmount', b.mine ? coins(b.mine.amount) : '');
      set('#toLead', coins(b.to_lead));
      state.boardShape = shape;
      return;
    }
    state.boardShape = shape;
    const side = b.mine ? youPanel(b) : joinPanel(b);
    const offers = byOffers(q);
    page.innerHTML = `<div class="wrap" style="--accent-raw:${esc(q.accent)}">
      ${q.mock ? `<div class="note test-note" style="margin-bottom:14px">${TEST_NOTE}</div>` : ''}
      <div class="board-head">
        <h1>${esc(q.name)}</h1>
        <p class="small muted" style="margin:0 0 10px">${esc(q.description)}</p>
        <div class="chips">
          <span class="chip">📅 <strong>${esc(prettyDate(q.window[0]))}</strong> → <strong>${esc(prettyDate(q.window[1]))}</strong></span>
          <span class="chip">🕐 <strong>${esc(q.hours[0])}–${esc(q.hours[1])}</strong> ${esc(q.timezone)}</span>
          <span class="chip">${esc(q.weekdays)}</span>
          <span class="chip chip-accent">entry <strong>${coins(q.min_bid)}</strong></span>
          ${q.status !== 'open' ? `<span class="tag tag-${esc(q.status)}">${esc(q.status)}</span>` : ''}
        </div>
      </div>
      <div class="board-split">
        <div class="card">
          <div class="between" style="padding:14px 18px 12px; border-bottom:1px solid var(--line-soft)">
            <div><div class="panel-title" style="margin:0">Live order book</div><div class="tiny muted" style="margin-top:3px">Highest bid first · ties go to whoever bid earliest</div></div>
            ${offers ? '<div class="tiny muted" style="text-align:right; max-width:260px">Each opening an app finds goes at once to the best-placed bidder whose offices it fits.</div>'
              : '<div style="text-align:right"><div class="countdown" id="countdown">—</div><div class="tiny muted">until next hand-off</div></div>'}
          </div>
          ${offers ? '' : '<div class="dispatch-bar"><div class="dispatch-fill" id="dispatchFill" style="width:0%"></div></div>'}
          <div class="board-header-row"><span>#</span><span>Bidder</span><span>Bid</span><span>Preferred slot</span></div>
          <div id="boardRows">${boardRows(b)}</div>
        </div>
        <aside class="stack">
          ${side}
          ${state.change && b.mine ? changePanel(b) : ''}
          <div class="panel">
            <div class="panel-title">The line</div>
            <dl>
              ${offers ? '<div class="kv"><dt>Slots</dt><dd style="font-family:var(--sans)">as apps find them</dd></div>'
                : `<div class="kv"><dt>Turns per cycle</dt><dd>${num(q.slots_per_cycle)}</dd></div>
              <div class="kv"><dt>Cycle length</dt><dd>${num(q.cycle_seconds)}s</dd></div>`}
              <div class="kv"><dt>Booking system</dt><dd>${esc(q.connector)}</dd></div>
              <div class="kv"><dt>Status</dt><dd><span class="tag tag-${q.status === 'open' ? 'active' : esc(q.status)}">${esc(q.status)}</span></dd></div>
            </dl>
            <button class="btn btn-block btn-sm" id="board-portal" style="margin-top:12px" title="${esc(b.portal_url)}">Open the booking site ↗</button>
          </div>
        </aside>
      </div>
    </div>`;
    wireBoard(b);
    if (state.change) wireChange(b);
    if (!state.boardTimer) {
      state.boardTimer = setInterval(() => { if (!document.hidden) loadBoard(id).then((doc) => { if (doc) renderBoard(); }).catch(() => {}); }, 4000);
    }
  }

  function youPanel(b) {
    const m = b.mine;
    const q = b.queue;
    let inner;
    if (b.handoff) {
      inner = `<div class="sep"></div><div class="note warn">☞ It is your turn on this line — see the bar at the top. Book it on the site, then click <b>I booked it</b>.</div>`;
    } else if (m.status === 'processing') {
      inner = '<div class="sep"></div><p class="small warn" style="margin:0">A slot is being booked for you right now. Your bid is held until that settles.</p>';
    } else {
      const lead = Math.max(b.to_lead - m.amount, b.min_raise);
      inner = `<div class="sep"></div>
        <span class="field-label">Bid up</span>
        <div class="raise-grid">
          <button class="btn" data-raise="25">+${coins(25)}</button>
          <button class="btn" data-raise="100">+${coins(100)}</button>
          <button class="btn btn-accent" data-raise="${lead}" ${m.rank === 1 ? 'disabled' : ''}>${m.rank === 1 ? 'Leading' : 'Take the lead'}</button>
        </div>
        <div class="row"><input type="number" id="raiseCustom" min="${num(b.min_raise)}" step="1" placeholder="Custom raise" style="flex:1"><button class="btn" id="raiseGo">Raise</button></div>
        ${state.change ? '' : `<button class="btn btn-block btn-sm" id="change-open" style="margin-top:10px">Change range, time or amount…</button>
        <p class="tiny muted" style="margin:6px 0 0">See what each amount buys, and get back what your place does not need.</p>`}
        <div class="sep"></div>
        <div class="between"><span class="tiny muted">${esc(m.note || '')}</span><button class="btn btn-sm btn-danger" id="withdraw">Withdraw</button></div>`;
    }
    return `<div class="panel you-panel">
      <div class="panel-title">Your position</div>
      <div class="position-big"><span class="position-num" id="myRank">${num(m.rank)}</span><span class="position-of">of <span id="myField">${num(b.field_size)}</span> · <span id="myAmount">${coins(m.amount)}</span> staked</span></div>
      ${byOffers(q) && m.rank === 1 ? '<p class="small ok" style="margin:4px 0 0">✓ First in line: the next opening that fits your offices is yours.</p>'
        : !byOffers(q) && m.rank <= q.slots_per_cycle ? '<p class="small ok" style="margin:4px 0 0">✓ In the hand-off window — your turn comes on the next cycle.</p>'
        : `<p class="small muted" style="margin:4px 0 0"><span id="toLead">${coins(b.to_lead)}</span> takes the lead right now.</p>`}
      ${m.status === 'active' ? reachSelect(shownReach(m), m.bid_id) : ''}
      ${inner}
    </div>`;
  }

  function joinPanel(b) {
    const q = b.queue;
    if (!paired()) {
      return `<div class="panel"><div class="panel-title">Join this line</div>
        <p class="small muted" style="margin:0 0 12px">You need an account to hold a position — bids are tied to a nickname and a wallet.</p>
        <button class="btn btn-accent btn-block" id="join-signin">Sign in to bid</button></div>`;
    }
    const values = state.bidDraft && state.bidDraft.queueId === q.id ? state.bidDraft.values : {};
    const kept = b.kept_on_device || [];
    const gap = missingOf(b);
    return `<div class="panel"><div class="panel-title">Join this line</div>
      ${gap.length ? `<div class="note warn" style="margin:0 0 12px">
        <div><b>Your profile is not ready for this line.</b> It asks for ${esc(tellNames(gap))} —
        the app types them into ${esc(q.site_name)}'s form when your turn comes, so they go in
        before you bid rather than while the clock is running.</div>
        <div style="margin-top:10px"><button class="btn btn-sm" id="join-fill">Add your details</button></div>
        </div>` : ''}
      <form id="bidForm">
        <label class="field"><span class="field-label">Your bid <span class="req">*</span></span>
          <input type="number" name="amount" min="${num(q.min_bid)}" step="1" required value="${Math.max(b.to_lead, q.min_bid)}">
          <span class="field-help">Entry ${coins(q.min_bid)} · <strong id="toLead">${coins(b.to_lead)}</strong> takes the lead right now. The credits are held while you wait and refunded in full unless the booking succeeds.</span></label>
        <div id="bidShort" class="note warn hidden" style="margin:-4px 0 12px"></div>
        <div class="grid-2">
          <label class="field"><span class="field-label">Preferred date <span class="req">*</span></span><input type="date" name="preferred_date" required value="${esc(b.default_date)}" min="${esc(q.window[0])}" max="${esc(q.window[1])}"></label>
          <label class="field"><span class="field-label">Preferred time <span class="req">*</span></span><input type="time" name="preferred_time" required value="${esc(q.hours[0])}" min="${esc(q.hours[0])}" max="${esc(q.hours[1])}" step="900"></label>
        </div>
        <label class="field"><span class="field-label">If that time passes</span>
          <select name="if_passed">
            ${REACHES.map(([value, label]) => `<option value="${esc(value)}"${value === '1d' ? ' selected' : ''}>${esc(label)}</option>`).join('')}
          </select>
          <span class="field-help">Until that moment, an earlier opening is taken. Once it has passed, the nearest later opening within this reach is taken. Nothing farther out is offered.</span></label>
        ${b.fields.length ? `<div class="sep"></div><div class="panel-title" style="margin-bottom:10px">${esc(q.site_name)} needs to know</div>${b.fields.map((f) => fieldHtml(f, values)).join('')}` : ''}
        ${kept.length ? `<div class="sep"></div><div class="panel-title" style="margin-bottom:10px">Kept on this machine</div>${keptList(b)}<p class="tiny muted" style="margin:8px 0 0">Typed into the booking form from <a id="join-profile">your profile</a>, never sent to LineRight Regbot.</p>` : ''}
        <button class="btn btn-accent btn-block" type="submit" style="margin-top:12px">${gap.length ? 'Add your details to join' : 'Pay bid &amp; take a position'}</button>
        <p class="tiny muted" style="margin:8px 0 0; text-align:center">You have ${coins(state.doc && state.doc.user ? state.doc.user.balance : 0)} to spend · <a data-go-credits>buy credits</a></p>
        <div id="bidError" class="note bad hidden" style="margin-top:10px"></div>
      </form></div>`;
  }

  function wireBoard(b) {
    const page = $('page');
    const on = (sel, fn) => { const el = page.querySelector(sel); if (el) el.addEventListener('click', fn); };
    on('#board-portal', () => api.call('tabs:open', { url: b.portal_url, kind: 'portal', title: b.queue.site_name }));
    on('#join-signin', () => go('signin'));
    on('#join-profile', (e) => { e.preventDefault(); go('profile'); });
    on('#join-fill', (e) => {
      e.preventDefault();
      go('profile', { gate: { need: missingOf(b), back: { page: 'board', id: b.queue.id },
        why: `${b.queue.site_name} asks for these when it books, and they stay on this machine.` } });
    });
    for (const btn of page.querySelectorAll('[data-raise]')) {
      btn.addEventListener('click', () => doRaise(b.mine.bid_id, Number(btn.dataset.raise)));
    }
    on('#raiseGo', () => { const v = Number(page.querySelector('#raiseCustom').value); if (v > 0) doRaise(b.mine.bid_id, v); });
    on('#change-open', () => { openChange(b); renderBoard(); });
    for (const sel of page.querySelectorAll('[data-if-passed]')) {
      sel.addEventListener('change', () => { if (sel.value) doIfPassed(Number(sel.dataset.ifPassed), sel.value); });
    }
    on('#withdraw', async () => {
      if (!window.confirm(`Withdraw and get ${coins(b.mine.amount)} back?`)) return;
      try { const r = await call('server:withdraw', { bid_id: b.mine.bid_id }); toast('ok', r.message); state.board = null; renderBoard(); }
      catch (err) { toast('bad', err.message, 9000); }
    });
    const form = page.querySelector('#bidForm');
    const buyFor = (need) => go('credits', { need, back: { page: 'board', id: b.queue.id } });
    for (const a of page.querySelectorAll('[data-go-credits]')) a.addEventListener('click', () => buyFor(0));
    if (form) {
      applyWhen(form, b.fields);
      form.addEventListener('change', () => applyWhen(form, b.fields));
      // Said before it is sent: the site refuses a bid the credits do not cover
      // (and is the one that decides — this is only the balance it last sent).
      const shortBox = form.querySelector('#bidShort');
      const checkShort = () => {
        const bal = state.doc && state.doc.user ? state.doc.user.balance : null;
        const want = Number(form.amount.value) || 0;
        if (bal === null || want <= bal) { shortBox.classList.add('hidden'); return; }
        shortBox.innerHTML = `That is <b>${coins(want - bal)}</b> more than the ${coins(bal)} you have. <a data-buy="${want}">Buy credits</a>`;
        shortBox.classList.remove('hidden');
        shortBox.querySelector('[data-buy]').addEventListener('click', () => buyFor(want));
      };
      form.amount.addEventListener('input', checkShort);
      checkShort();
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const fields = {};
        for (const f of b.fields) {
          const el = form.querySelector(`[name="${f.key}"]`);
          if (!el) continue;
          fields[f.key] = el.type === 'checkbox' ? el.checked : el.value;
        }
        const body = { queue_id: b.queue.id, amount: Number(form.amount.value), preferred_date: form.preferred_date.value, preferred_time: form.preferred_time.value, if_passed: form.if_passed.value, fields, needs_of_line: b.kept_on_device || [] };
        const errBox = form.querySelector('#bidError');
        errBox.classList.add('hidden');
        // Keep what they typed either way: a trip to the profile must not cost
        // them the amount, the date and the answers they just filled in.
        state.bidDraft = { queueId: b.queue.id, values: fields };
        try {
          const r = await call('server:bid', body);
          if (r && r.gated) { toast('warn', `Add ${tellNames(r.need)} to your profile to join this line.`, 9000); return; }
          toast('ok', r.message);
          state.bidDraft = null;
          state.board = null; renderBoard();
        } catch (err) {
          errBox.textContent = err.message; errBox.classList.remove('hidden');
          if (err.status === 402) {
            // Not enough credits: the site said how many are missing.
            const buy = document.createElement('button');
            buy.type = 'button';
            buy.className = 'btn btn-sm btn-accent';
            buy.style.marginLeft = '8px';
            buy.textContent = `Buy ${coins(err.detail.short || 0)} more`;
            buy.addEventListener('click', () => buyFor(err.detail.need || body.amount));
            errBox.appendChild(buy);
          }
          state.bidDraft = { queueId: b.queue.id, values: fields };
        }
      });
    }
  }

  // ------------------------------------------------------- changing a bid
  // Drawn up beside the position: a wider range, a later time, and the amount.
  // The site prices every amount worth paying (regbot/quote.py) and says which
  // one it would choose; nothing changes until Save. What is being drawn up
  // lives in state.change, because the board is fetched again every few seconds.
  const BC = window.bidChange;

  function openChange(b) {
    const m = b.mine;
    state.change = {
      bidId: m.bid_id, quote: null, error: '', saveError: '', busy: false, seq: 0, shape: null,
      draft: { place: '', date: m.preferred_date || '', time: m.preferred_time || '', reach: m.if_passed || '', amount: m.amount },
    };
    requestQuote(b);
  }

  function requestQuote(b) {
    const c = state.change;
    if (!c) return;
    const sent = BC.body({ ...c.draft, amount: null }, b.mine);
    c.shape = BC.shapeKey(c.draft);
    c.seq += 1;
    const seq = c.seq;
    c.loading = true;
    paintQuote(b);
    call('server:quote', { bid_id: c.bidId, change: sent }).then((doc) => {
      if (state.change !== c || seq !== c.seq) return;
      c.quote = doc; c.error = ''; c.loading = false;
      paintQuote(b);
    }).catch((err) => {
      if (state.change !== c || seq !== c.seq) return;
      c.quote = null; c.error = err.message; c.loading = false;
      paintQuote(b);
    });
  }

  function quoteHtml(b) {
    const c = state.change;
    if (c.error) return `<div class="note bad">${esc(c.error)}</div>`;
    const doc = c.quote;
    if (!doc) return '<p class="small muted" style="margin:6px 0">Working out what each amount buys…</p>';
    const pick = doc.suggested || {};
    const use = pick.amount !== Number(c.draft.amount)
      ? ` <button class="btn btn-sm" data-change-amount="${num(pick.amount)}" style="margin-top:8px">Use ${coins(pick.amount)}${pick.delta ? ` · ${esc(BC.deltaText(pick.delta, coins))}` : ''}</button>` : '';
    const tone = pick.kind === 'refund' ? 'ok' : (pick.kind === 'raise' ? 'warn' : '');
    const opts = (doc.options || []).map((o) => `<button type="button" class="quote-opt${o.amount === Number(c.draft.amount) ? ' on' : ''}" data-change-amount="${num(o.amount)}" ${o.afford ? '' : 'disabled title="More than you have to spend"'}>
        <span class="q-amt">${coins(o.amount)}</span><span class="q-what">${esc(BC.title(o))}</span><span class="q-delta">${esc(BC.deltaText(o.delta, coins))}</span>
        <span class="q-when">${esc(BC.soon(o.outlook, doc.basis && doc.basis.horizon_days))}</span></button>`).join('');
    const ahead = (doc.rivals && doc.rivals.ahead) || [];
    const basis = doc.basis || {};
    return `<div class="note ${tone}" style="margin:6px 0 10px">${esc(pick.why || '')}${use}</div>
      <div class="quote-opts">${opts}</div>
      ${ahead.length ? `<p class="tiny muted" style="margin:6px 0 0">Ahead of you for these offices: ${ahead.map((r) => `${esc(r.nickname)} ${coins(r.amount)} (#${num(r.rank)})`).join(', ')}.</p>` : ''}
      <p class="tiny muted" style="margin:6px 0 0">Worked out from the ${num(basis.openings)} openings found on this line in the last ${esc(String(basis.days || 0))} days, played against the board as it is now. ${doc.lowers_left ? `This bid can be lowered ${num(doc.lowers_left)} more time${doc.lowers_left === 1 ? '' : 's'} today` : 'This bid cannot be lowered again today'}.</p>`;
  }

  function paintQuote(b) {
    const box = $('changeQuote');
    if (box) {
      box.innerHTML = quoteHtml(b);
      for (const btn of box.querySelectorAll('[data-change-amount]')) {
        btn.addEventListener('click', () => setChangeAmount(b, Number(btn.dataset.changeAmount)));
      }
    }
    paintSave(b);
  }

  function paintSave(b) {
    const c = state.change;
    const save = $('change-save');
    if (!c || !save) return;
    save.textContent = c.busy ? 'Saving…' : BC.saveLabel(c.draft, b.mine, coins);
    save.disabled = c.busy || !Object.keys(BC.body(c.draft, b.mine)).length || Boolean(c.error);
    const said = $('changeError');
    if (said) { said.textContent = c.saveError || ''; said.classList.toggle('hidden', !c.saveError); }
  }

  function setChangeAmount(b, amount) {
    const c = state.change;
    if (!c) return;
    c.draft.amount = amount;
    const input = document.querySelector('#changePanel [data-change="amount"]');
    if (input) input.value = String(amount);
    paintQuote(b);
  }

  function changePanel(b) {
    const m = b.mine;
    const q = b.queue;
    const c = state.change;
    const d = c.draft;
    const places = BC.placeChoices(m.place);
    const reaches = BC.reachChoices(m.if_passed);
    return `<div class="panel" id="changePanel">
      <div class="panel-title">Change your bid</div>
      <label class="field"><span class="field-label">Offices</span>
        <select data-change="place">${places.map((o) => `<option value="${esc(o.value)}"${o.value === d.place ? ' selected' : ''}>${esc(o.label)}</option>`).join('')}</select>
        <span class="field-help">You can add offices, never drop one. To ask for fewer, withdraw and bid again.</span></label>
      ${reaches.length ? `<div class="grid-2">
        <label class="field"><span class="field-label">Preferred date</span><input type="date" data-change="date" value="${esc(d.date)}" min="${esc(m.preferred_date)}" max="${esc(q.window[1])}"></label>
        <label class="field"><span class="field-label">Preferred time</span><input type="time" data-change="time" value="${esc(d.time)}" min="${esc(q.hours[0])}" max="${esc(q.hours[1])}" step="900"></label>
      </div>
      <label class="field"><span class="field-label">If that time passes</span>
        <select data-change="reach">${reaches.map((o) => `<option value="${esc(o.value)}"${o.value === d.reach ? ' selected' : ''}>${esc(o.label)}</option>`).join('')}</select>
        <span class="field-help">Later, or farther: every time the bid takes now stays in.</span></label>`
        : '<p class="tiny muted" style="margin:0 0 12px">This bid already takes any time in the line\'s window.</p>'}
      <div class="sep"></div>
      <span class="field-label">Your bid</span>
      <div id="changeQuote">${quoteHtml(b)}</div>
      <label class="field" style="margin-top:10px"><span class="field-label">Or type an amount</span>
        <input type="number" data-change="amount" min="${num(q.min_bid)}" step="1" value="${num(d.amount)}"></label>
      <div class="row" style="margin-top:12px"><button class="btn btn-accent" id="change-save" style="flex:1"></button><button class="btn btn-ghost" id="change-cancel">Cancel</button></div>
      <div id="changeError" class="note bad hidden" style="margin-top:10px"></div>
    </div>`;
  }

  function wireChange(b) {
    const panel = $('changePanel');
    const c = state.change;
    if (!panel || !c) return;
    let timer = null;
    const shapeChanged = () => {
      paintSave(b);
      if (BC.shapeKey(c.draft) === c.shape) return;
      clearTimeout(timer);
      timer = setTimeout(() => requestQuote(b), 350);
    };
    for (const el of panel.querySelectorAll('[data-change]')) {
      const key = el.dataset.change;
      const read = () => {
        c.saveError = '';
        if (key === 'amount') { c.draft.amount = Number(el.value) || 0; paintQuote(b); return; }
        c.draft[key] = el.value;
        shapeChanged();
      };
      el.addEventListener(key === 'amount' ? 'input' : 'change', read);
    }
    paintQuote(b);
    $('change-cancel').addEventListener('click', () => { state.change = null; renderBoard(); });
    $('change-save').addEventListener('click', async () => {
      const change = { ...BC.body(c.draft, b.mine), expect_amount: b.mine.amount };
      c.busy = true; c.saveError = ''; paintSave(b);
      try {
        const r = await call('server:change', { bid_id: c.bidId, change });
        if (change.if_passed) chosenReach[c.bidId] = change.if_passed;
        toast('ok', r.message, 9000);
        state.change = null;
        state.board = null;
        renderBoard();
      } catch (err) {
        c.busy = false;
        if (err.status === 402) {
          go('credits', { need: err.detail.need, back: { page: 'board', id: b.queue.id } });
          return;
        }
        c.saveError = err.message;
        paintSave(b);
        if (err.status === 409) {
          toast('warn', err.message, 9000);
          // The bid moved under the form: show it as it is now, and price it again.
          loadBoard(b.queue.id).then((doc) => {
            if (!doc || state.change !== c) return;
            c.draft.amount = doc.mine ? doc.mine.amount : c.draft.amount;
            state.boardShape = '';
            renderBoard();
            if (state.change === c) requestQuote(doc);
          }).catch(() => {});
        }
      }
    });
  }

  async function doAdvice(advice) {
    try {
      const reply = await call('server:advice', { bid_id: advice.bid_id, key: advice.key });
      if (advice.kind === 'time' && advice.if_passed) {
        chosenReach[advice.bid_id] = advice.if_passed;
        const positions = state.doc && state.doc.positions;
        const pos = positions && positions.find((p) => p.bid_id === advice.bid_id);
        if (pos) pos.if_passed = advice.if_passed;
        if (state.board && state.board.mine && state.board.mine.bid_id === advice.bid_id) {
          state.board.mine.if_passed = advice.if_passed;
        }
      }
      toast('ok', reply.message || 'Updated.');
      rememberAdviceGone(advice.key);
      renderBanner(true);
      if (state.route.page === 'board') renderBoard();
      if (state.route.page === 'console') renderConsole();
    } catch (err) {
      toast('bad', err.message, 9000);
    }
  }

  async function doIfPassed(bidId, code) {
    chosenReach[bidId] = code;
    try {
      const r = await call('server:if-passed', { bid_id: bidId, if_passed: code });
      toast('ok', r.message);
      const positions = state.doc && state.doc.positions;
      if (positions) {
        const pos = positions.find((p) => p.bid_id === bidId);
        if (pos) pos.if_passed = code;
      }
      if (state.board && state.board.mine && state.board.mine.bid_id === bidId) {
        state.board.mine.if_passed = code;
        const row = (state.board.bids || []).find((item) => item.mine);
        if (row) row.if_passed = code;
      }
      if (state.route.page === 'board') renderBoard();
      if (state.route.page === 'console') renderConsole();
    } catch (err) {
      toast('bad', err.message, 9000);
    }
  }

  async function doRaise(bidId, delta) {
    try { const r = await call('server:raise', { bid_id: bidId, delta }); toast('ok', r.message); state.board = null; if (state.route.page === 'board') renderBoard(); if (state.route.page === 'console') renderConsole(); }
    catch (err) {
      toast('bad', err.message, 9000);
      // Short of credits: the Credits screen, with the pack that covers it marked.
      if (err.status === 402) go('credits', { need: err.detail.need, back: state.route.page === 'board' ? { page: 'board', id: state.route.id } : { page: 'console' } });
    }
  }

  function tickBoard() {
    const b = state.board;
    if (!b || state.route.page !== 'board') return;
    const cd = $('countdown'); const fill = $('dispatchFill');
    const remaining = Math.max(0, b.queue.next_dispatch_in - (Date.now() - (b._at || 0)) / 1000);
    if (cd) cd.textContent = remaining <= 0 ? 'due now' : (remaining >= 60 ? `${Math.floor(remaining / 60)}m ${String(Math.floor(remaining % 60)).padStart(2, '0')}s` : `${Math.floor(remaining)}s`);
    if (fill) fill.style.width = `${Math.max(0, Math.min(100, (1 - remaining / b.queue.cycle_seconds) * 100))}%`;
  }

  // -------------------------------------------------------------- console
  async function loadAccount() {
    state.account = await call('server:account');
    return state.account;
  }

  function renderConsole() {
    const page = $('page');
    if (!paired()) return needSignin('The console');
    const doc = state.doc;
    const a = state.account;
    if (!a) {
      page.innerHTML = '<div class="wrap"><div class="empty">Loading your console…</div></div>';
      loadAccount().then(() => { if (state.route.page === 'console') renderConsole(); })
        .catch((err) => { if (err.status === 401) needSignin('The console'); else page.innerHTML = `<div class="wrap"><div class="note bad">${esc(err.message)}</div></div>`; });
      return;
    }
    const positions = (doc && doc.positions) || [];
    const handoffs = new Map(((doc && doc.handoffs) || []).map((h) => [h.bid_id, h]));
    const user = (doc && doc.user) || a.user;
    const tab = state.consoleTab;
    let body = '';
    if (tab === 'positions') {
      body = `<div class="card">${positions.length ? positions.map((p) => `
        <div class="pos-card" style="--accent-raw:${esc(p.accent)}">
          <div class="pos-rank ${p.rank === 1 ? 'lead' : ''}">${num(p.rank)}</div>
          <div style="min-width:0">
            <div class="row" style="gap:8px; flex-wrap:wrap"><a data-board="${num(p.queue_id)}"><strong>${esc(p.queue_name)}</strong></a><span class="tag tag-${esc(p.status)}">${esc(p.status)}</span>${handoffs.has(p.bid_id) ? '<span class="tag tag-booking">your turn</span>' : ''}${p.mock ? '<span class="test-badge">Test site</span>' : ''}</div>
            <div class="small muted" style="margin-top:3px">${esc(p.site_name)} · position ${num(p.rank)} of ${num(p.field_size)} · asked for ${esc(prettyDate(p.preferred_date))} at ${esc(p.preferred_time)}${shownReach(p) ? ` · if it passes, ${esc(reachLabel(shownReach(p)))}, and nothing farther` : ''}</div>
            ${p.status === 'active' ? reachSelect(shownReach(p), p.bid_id) : ''}
            ${p.note ? `<div class="tiny muted" style="margin-top:3px">${esc(p.note)}</div>` : ''}
          </div>
          <div class="pos-actions">
            <div style="text-align:right; margin-right:6px"><div class="num" style="font-weight:700; font-size:16px">${coins(p.amount)}</div><div class="tiny muted">${esc(p.site_name)}</div></div>
            ${p.status === 'active' ? `<button class="btn btn-sm" data-raise50="${num(p.bid_id)}" title="Raise by 50 credits">+${coins(50)}</button>
            <button class="btn btn-sm" data-change-bid="${num(p.queue_id)}" title="A wider range, a later time, or another amount">Change</button>` : ''}
            <button class="btn btn-sm btn-ghost" data-board="${num(p.queue_id)}">Board</button>
          </div>
        </div>`).join('') : '<div class="empty">No live positions. <a data-go-sites>Find a line to join →</a></div>'}</div>`;
    } else if (tab === 'history') {
      body = `<div class="card">${a.history.length ? `<table class="data"><thead><tr><th>Settled</th><th>Site</th><th>Line</th><th>Outcome</th><th class="right">Bid</th><th>Reference</th></tr></thead><tbody>
        ${a.history.map((h) => `<tr><td class="muted">${esc(ago(h.settled_at))}</td><td>${esc(h.site_name)}</td><td class="muted"><a data-board="${num(h.queue_id)}">${esc(h.queue_name)}</a></td><td><span class="tag tag-${esc(h.status)}">${esc(h.status)}</span></td><td class="right num">${coins(h.amount)}</td><td class="num muted">${esc(h.confirmation || '—')}</td></tr>`).join('')}
        </tbody></table>` : '<div class="empty">Nothing settled yet. Won, lost and withdrawn bids all land here.</div>'}</div>`;
    } else if (tab === 'wallet') {
      body = creditsBody({ ...a, balance: user.balance, packs: a.packs, payments: a.payments,
        purchases: a.purchases || [], ledger: a.ledger }, {});
    } else {
      body = `<div class="split">
        <div class="panel"><div class="panel-title">Account</div><dl>
          <div class="kv"><dt>Nickname</dt><dd>${esc(user.nickname)}${state.nickEdit ? '' : ` <a id="acct-nick-edit" class="tiny" style="font-family:var(--sans)">Change</a>`}</dd></div>
          <div class="kv"><dt>Email</dt><dd>${esc(a.user.email || '—')}</dd></div>
          <div class="kv"><dt>Joined</dt><dd>${esc((a.user.created_at || '').slice(0, 10))}</dd></div>
          <div class="kv"><dt>Bids placed</dt><dd>${num(a.stats.total)}</dd></div>
          <div class="kv"><dt>Won / lost</dt><dd>${num(a.stats.won)} / ${num(a.stats.lost)}</dd></div>
        </dl>
        ${nicknameForm()}
        <p class="tiny muted" style="margin:12px 0 0">Your password and sign-in providers are changed on <a data-external="${esc(a.account_url)}">your account page</a> on the website.</p></div>
        <div class="panel"><div class="panel-title">This device</div>
          ${builtin()
            ? `<p class="small muted" style="margin:0 0 12px">Signed in as <b>${esc(a.user.nickname)}</b> on the LineRight Regbot server this app runs on this computer — your lines, bids and practice credits are kept in its database here.</p>
          <div class="row"><button class="btn btn-ghost btn-sm" id="acct-server">The server…</button><button class="btn btn-ghost btn-sm" id="acct-profile">Your profile</button></div>`
            : `<p class="small muted" style="margin:0 0 12px">Signed in as <b>${esc(a.user.nickname)}</b>. Signing out revokes this device's token; your positions keep their rank.</p>
          <div class="row"><button class="btn btn-danger btn-sm" id="acct-signout">Sign out on this device</button><button class="btn btn-ghost btn-sm" id="acct-profile">Your profile</button></div>`}
        </div>
      </div>
      <div class="panel" style="margin-top:14px"><div class="panel-title">Paired devices</div>
        ${a.devices.length ? `<table class="data"><thead><tr><th>Device</th><th>Platform</th><th>Version</th><th>Paired</th><th>Last seen</th><th></th></tr></thead><tbody>
          ${a.devices.map((d) => `<tr><td>${esc(d.name || '—')}${d.this ? ' <span class="tiny muted">this device</span>' : ''}</td><td class="muted">${esc(d.platform || '—')}</td><td class="num muted">${esc(d.app_version || '—')}</td><td class="muted">${esc(ago(d.created_at))}</td><td class="muted">${d.last_seen_at ? esc(ago(d.last_seen_at)) : 'never'}</td>
            <td class="right">${d.this || builtin() ? '' : `<button class="btn btn-ghost btn-sm" data-revoke="${num(d.id)}">Unpair</button>`}</td></tr>`).join('')}
        </tbody></table>` : '<div class="empty">No paired devices.</div>'}
        <p class="tiny muted" style="margin:10px 0 0">Unpair a device you no longer use, or one that went missing with its computer: its next request is refused.</p>
      </div>`;
    }
    const typing = document.activeElement && document.activeElement.id === 'acct-nick-input'
      ? [document.activeElement.selectionStart, document.activeElement.selectionEnd] : null;
    page.innerHTML = `<div class="wrap">
      <div class="wallet-hero">
        <div class="wallet-cell"><div class="v">${coins(user.balance)}</div><div class="k">Credits to spend</div></div>
        <div class="wallet-cell"><div class="v warn">${coins(user.escrow)}</div><div class="k">Staked on bids</div></div>
        <div class="wallet-cell"><div class="v">${positions.length}</div><div class="k">Live positions</div></div>
        <div class="wallet-cell"><div class="v ok">${num(a.stats.won)}</div><div class="k">Appointments won</div></div>
        <div class="wallet-cell"><div class="v">${coins(a.stats.spent)}</div><div class="k">Spent on wins</div></div>
      </div>
      <div class="tabs">
        <button data-tab="positions" class="${tab === 'positions' ? 'on' : ''}">Positions <span class="muted">${positions.length}</span></button>
        <button data-tab="history" class="${tab === 'history' ? 'on' : ''}">History <span class="muted">${a.history.length}</span></button>
        <button data-tab="wallet" class="${tab === 'wallet' ? 'on' : ''}">Credits</button>
        <button data-tab="account" class="${tab === 'account' ? 'on' : ''}">Account</button>
      </div>
      ${body}
    </div>`;
    for (const b of page.querySelectorAll('.tabs button')) b.addEventListener('click', () => { state.consoleTab = b.dataset.tab; renderConsole(); });
    for (const a2 of page.querySelectorAll('[data-board]')) a2.addEventListener('click', () => go('board', { id: Number(a2.dataset.board) }));
    for (const a2 of page.querySelectorAll('[data-go-sites]')) a2.addEventListener('click', () => go('sites'));
    for (const a2 of page.querySelectorAll('[data-external]')) a2.addEventListener('click', () => api.call('tabs:external', { url: a2.dataset.external }));
    for (const b of page.querySelectorAll('[data-raise50]')) b.addEventListener('click', () => doRaise(Number(b.dataset.raise50), 50));
    for (const b of page.querySelectorAll('[data-change-bid]')) b.addEventListener('click', () => go('board', { id: Number(b.dataset.changeBid), change: true }));
    for (const sel of page.querySelectorAll('[data-if-passed]')) {
      sel.addEventListener('change', () => { if (sel.value) doIfPassed(Number(sel.dataset.ifPassed), sel.value); });
    }
    if (tab === 'wallet') wireCredits(page, () => { state.account = null; renderConsole(); });
    for (const b of page.querySelectorAll('[data-revoke]')) {
      b.addEventListener('click', async () => {
        if (!window.confirm('Unpair that device? Its next request will be refused.')) return;
        b.disabled = true;
        try { await call('server:revoke', { client_id: Number(b.dataset.revoke) }); toast('ok', 'Unpaired.'); await loadAccount(); renderConsole(); }
        catch (err) { toast('bad', err.message, 9000); b.disabled = false; }
      });
    }
    wireNickname(user, typing);
    const out = $('acct-signout'); if (out) out.addEventListener('click', () => api.call('pair:forget'));
    const prof = $('acct-profile'); if (prof) prof.addEventListener('click', () => go('profile'));
    const srv = $('acct-server'); if (srv) srv.addEventListener('click', () => go('settings'));
  }

  // The name other bidders see, changed here rather than on the website. What
  // is being typed lives in state.nickEdit, because every sync redraws the page.
  function nicknameForm() {
    const ne = state.nickEdit;
    if (!ne) return '';
    return `<form id="acct-nick-form" style="margin-top:10px">
      <div class="row"><input id="acct-nick-input" maxlength="24" value="${esc(ne.value)}" spellcheck="false" autocomplete="off" aria-label="New nickname" style="flex:1; min-width:0">
        <button class="btn btn-sm btn-accent" type="submit" ${ne.busy ? 'disabled' : ''}>Save</button><button class="btn btn-sm btn-ghost" type="button" id="acct-nick-cancel">Cancel</button></div>
      <p class="tiny ${ne.bad ? 'bad' : 'muted'}" style="margin:6px 0 0">${esc(ne.note || 'The only thing other bidders see next to your bids — never your name or email.')}</p>
    </form>`;
  }

  function wireNickname(user, typing) {
    const edit = $('acct-nick-edit');
    if (edit) edit.addEventListener('click', () => { state.nickEdit = { value: user.nickname }; renderConsole(); $('acct-nick-input').select(); });
    const form = $('acct-nick-form');
    if (!form) return;
    const input = $('acct-nick-input');
    if (typing) { input.focus(); input.setSelectionRange(typing[0], typing[1]); }
    input.addEventListener('input', () => { state.nickEdit.value = input.value; });
    input.addEventListener('keydown', (e) => { if (e.key === 'Escape') { state.nickEdit = null; renderConsole(); } });
    $('acct-nick-cancel').addEventListener('click', () => { state.nickEdit = null; renderConsole(); });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const wanted = input.value.trim();
      if (!wanted || wanted === user.nickname) { state.nickEdit = null; renderConsole(); return; }
      state.nickEdit = { value: wanted, busy: true, note: 'Saving…' };
      renderConsole();
      try {
        const r = await call('server:nickname', { nickname: wanted });
        state.nickEdit = null;
        toast('ok', `You now appear on every board as ${r.user.nickname}.`);
        await loadAccount();
      } catch (err) {
        state.nickEdit = { value: wanted, bad: true,
          note: err.status === 404 ? 'This server cannot change it from the app. Use your account page on the website.' : err.message };
      }
      if (state.route.page === 'console') renderConsole();
      const again = $('acct-nick-input'); if (again) again.focus();
    });
  }

  // -------------------------------------------------------------- credits
  // Credits are the site's: what an account holds to bid with, kept in its
  // database and brought by every sync. They are bought on the payment
  // provider's own page, which opens in the person's browser — the card is
  // typed there, never in this app — and arrive when the provider confirms the
  // payment. A practice server hands them out for nothing, and says so.
  async function loadCredits() {
    try {
      state.credits = await call('server:credits');
    } catch (err) {
      if (err.status !== 404) throw err;
      // An older site: the account document carries the same parts.
      const a = await call('server:account');
      state.credits = { balance: a.user.balance, escrow: a.user.escrow, packs: a.packs, payments: a.payments,
        purchases: a.purchases || [], ledger: a.ledger, credits_url: a.credits_url || a.account_url };
    }
    return state.credits;
  }

  const MONEY = (p) => (p.provider === 'simulated' ? 'practice' : p.price);

  function checkoutPanel() {
    const c = state.checkout;
    if (!c) return '';
    if (c.status === 'pending') {
      return `<div class="note warn" style="margin-bottom:14px" id="checkout-note">
        <div><b>Waiting for your payment.</b> The payment page opened in your browser — pay there, and the
        credits appear here as soon as it is confirmed. ${c.note ? esc(c.note) : ''}</div>
        <div class="row" style="margin-top:10px; flex-wrap:wrap">
          <button class="btn btn-sm" id="checkout-open">Open the payment page again</button>
          <button class="btn btn-sm btn-ghost" id="checkout-cancel">Cancel this purchase</button>
        </div></div>`;
    }
    const kind = c.status === 'paid' ? 'ok' : 'bad';
    return `<div class="note ${kind}" style="margin-bottom:14px"><b>${c.status === 'paid' ? 'Paid.' : 'Not paid.'}</b> ${esc(c.message || '')}
      <a id="checkout-dismiss" style="margin-left:8px">Dismiss</a></div>`;
  }

  /** What the Credits screen and the console's Credits tab both show. */
  function creditsBody(c, route = {}) {
    const pay = c.payments;
    const short = route.need ? Math.max(0, route.need - c.balance) : 0;
    const packs = c.packs || [];
    const covers = short ? packs.find((p) => (p.credits || p.coins) >= short) : null;
    const buy = pay ? `<div class="packs">${packs.map((p) => {
      const amount = p.credits || p.coins;
      const flag = covers && covers.id === p.id;
      return `<div class="pack${flag ? ' pack-pick' : ''}">${flag ? '<span class="pack-flag">covers it</span>' : ''}
        <div class="pack-coins">${coins(amount)}</div><div class="pack-label">${esc(p.label)} · credits</div>
        <p class="pack-blurb">${esc(p.blurb)}</p>
        <button class="btn btn-accent btn-block" data-pack="${esc(p.id)}" ${state.checkout && state.checkout.status === 'pending' ? 'disabled' : ''}>${pay.practice ? `Add ${coins(amount)} free` : `Buy for ${esc(p.price)}`}</button></div>`;
    }).join('')}</div>
      <p class="tiny muted" style="margin:12px 0 0">${pay.practice
        ? '<b>Practice server.</b> These are practice credits: nothing is charged and no money moves.'
        : `Paid on ${esc(pay.display)}'s own page, which opens in your browser: your card number never reaches LineRight Regbot or this app.${pay.emulated ? ' <b>This site uses a Stripe emulator — no money moves.</b>' : (pay.live ? '' : ' <b>Test mode</b> — use a Stripe test card.')}`}</p>`
      : '<p class="small bad" style="margin:0">Credits cannot be bought on this server right now — its payment provider is not set up.</p>';
    const need = short ? `<div class="note warn" style="margin-bottom:14px">That needs <b>${coins(route.need)}</b> and you have <b>${coins(c.balance)}</b> to spend — <b>${coins(short)}</b> short.
      ${covers ? 'The pack marked below covers it.' : 'No single pack covers it on its own.'}
      ${route.back ? '<a id="credits-back" style="margin-left:6px">Back to the line</a>' : ''}</div>` : '';
    const purchases = (c.purchases || []).length ? `<div class="card" style="margin-bottom:14px"><table class="data"><thead><tr><th>Started</th><th>Pack</th><th class="right">Credits</th><th class="right">Paid</th><th>Status</th><th></th></tr></thead><tbody>
      ${c.purchases.map((p) => `<tr><td class="muted">${esc(ago(p.created_at))}</td><td>${esc(p.pack)}</td><td class="right num">${coins(p.credits)}</td><td class="right num">${esc(MONEY(p))}</td>
        <td><span class="tag tag-${p.status === 'paid' ? 'fulfilled' : p.status === 'pending' ? 'processing' : 'failed'}">${esc(p.refunded ? 'refunded' : p.status)}</span>${p.failure && p.status !== 'paid' ? ` <span class="tiny muted">${esc(p.failure)}</span>` : ''}</td>
        <td class="right">${p.status === 'pending' && p.checkout_url ? `<a data-reopen="${esc(p.checkout_url)}" data-payment="${num(p.id)}">pay</a>` : ''}</td></tr>`).join('')}
      </tbody></table></div>` : '';
    const ledger = `<div class="card"><table class="data"><thead><tr><th>When</th><th>Movement</th><th>Reason</th><th class="right">Change</th><th class="right">Balance</th></tr></thead><tbody>
      ${(c.ledger || []).map((l) => `<tr><td class="muted">${esc(ago(l.created_at))}</td><td><span class="tag tag-${l.delta > 0 ? 'fulfilled' : (l.delta === 0 ? 'cancelled' : 'pending')}">${esc(MOVEMENT[l.kind] || l.kind)}</span></td><td class="muted">${esc(l.memo)}${l.site_name ? ` <span class="tiny">· ${esc(l.site_name)}</span>` : ''}</td><td class="right num ${l.delta > 0 ? 'ok' : (l.delta === 0 ? 'muted' : 'bad')}">${l.delta > 0 ? '+' : ''}${num(l.delta)}</td><td class="right num muted">${num(l.balance_after)}</td></tr>`).join('')
        || '<tr><td colspan="5" class="muted">No credit has moved yet.</td></tr>'}
    </tbody></table></div>`;
    return `${need}${checkoutPanel()}${freePanel(c)}
      <div class="panel" style="margin-bottom:14px"><div class="panel-title">${pay && !pay.practice ? 'Or buy more' : 'Buy credits'}</div>${buy}</div>
      ${purchases}${ledger}`;
  }

  /** What each line of the ledger was, in words (the site's ledger kinds). */
  const MOVEMENT = { grant: 'welcome', weekly: 'weekly top-up', earned: 'checking lines', topup: 'bought',
    hold: 'staked', raise: 'raised', refund: 'returned', capture: 'spent', reversal: 'refunded' };

  /**
   * The credits nobody pays for: the weekly top-up, and what this app earns
   * checking lines (the site's allowance.py). The sync brings the live numbers;
   * the Credits document, the ones as of when it was fetched.
   */
  function freePanel(c) {
    const a = (state.doc && state.doc.allowance) || c.allowance;
    if (!a || (c.payments && c.payments.practice)) return '';
    const t = a.topup || {};
    const k = a.checking || {};
    const r = state.robots || {};
    const next = t.next_at ? new Date(t.next_at).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' }) : '';
    const weekly = t.to ? `<div class="free-row"><span class="k">Every ${t.every_days === 7 ? 'week' : `${num(t.every_days)} days`}</span>
      <span class="small">Back to <b>${coins(t.to)}</b> to spend${next ? ` — next on ${esc(next)}` : ''}. Credits staked on your places do not count, so the longer you wait, the more you can stake.</span></div>` : '';
    const now = k.counting ? '<span class="ok">This app is checking lines now.</span>'
      : r.available === false ? 'This build carries no robots, so it cannot check lines.'
      : r.wanted === false || !r.agreed ? 'Checking is off on this app. <a id="earn-on">Turn it on</a>'
      : 'This app will count once it is syncing.';
    const earned = k.hours ? ` So far: ${num(k.hours)} h checked, ${coins(k.earned || 0)} earned, ${coins(k.toward_next || 0)} toward the next.` : '';
    const checking = k.per_hour ? `<div class="free-row"><span class="k">Checking lines</span>
      <span class="small"><b>${coins(k.per_hour)}</b> an hour while this app checks lines for everyone in line.${earned}<br>${now}</span></div>` : '';
    if (!weekly && !checking) return '';
    return `<div class="panel" id="free-panel" style="margin-bottom:14px"><div class="panel-title">Free credits</div>${weekly}${checking}</div>`;
  }

  /**
   * The Credits screen, kept current as syncs arrive: when the balance moved —
   * a top-up, a credit earned checking, a bid — the whole of it, ledger and
   * all, fetched again; otherwise only what checking lines has come to.
   */
  function creditsLive(before, doc) {
    if (state.route.page !== 'credits' || !doc || !doc.user || !state.credits) return;
    const was = before && before.user;
    if (!was || was.balance !== doc.user.balance || was.escrow !== doc.user.escrow) {
      loadCredits().then(() => { if (state.route.page === 'credits') renderCredits(); }).catch(() => {});
      return;
    }
    const panel = $('free-panel');
    if (!panel) return;
    panel.outerHTML = freePanel(state.credits);
    const earnOn = $('earn-on');
    if (earnOn) earnOn.addEventListener('click', () => turnCheckingOn(renderCredits, { confirm: true }));
  }

  function wireCredits(root, rerender) {
    const earnOn = root.querySelector('#earn-on');
    if (earnOn) earnOn.addEventListener('click', () => turnCheckingOn(rerender, { confirm: true }));
    for (const b of root.querySelectorAll('[data-pack]')) {
      b.addEventListener('click', async () => {
        b.disabled = true;
        try { await buyPack(b.dataset.pack); } catch (err) { toast('bad', err.message, 9000); }
        rerender();
      });
    }
    for (const a of root.querySelectorAll('[data-reopen]')) {
      a.addEventListener('click', () => {
        state.checkout = { id: Number(a.dataset.payment), url: a.dataset.reopen, status: 'pending' };
        api.call('server:payment-open', { url: a.dataset.reopen });
        pollCheckout();
        rerender();
      });
    }
    const open = root.querySelector('#checkout-open');
    if (open) open.addEventListener('click', () => api.call('server:payment-open', { url: state.checkout.url }));
    const cancel = root.querySelector('#checkout-cancel');
    if (cancel) {
      cancel.addEventListener('click', async () => {
        try {
          const p = await call('server:payment-cancel', { id: state.checkout.id });
          state.checkout = { ...state.checkout, status: p.status, message: p.message };
          if (p.status === 'paid') toast('ok', p.message);
        } catch (err) { toast('bad', err.message, 9000); }
        state.credits = null;
        rerender();
      });
    }
    const dismiss = root.querySelector('#checkout-dismiss');
    if (dismiss) dismiss.addEventListener('click', () => { state.checkout = null; rerender(); });
    const back = root.querySelector('#credits-back');
    if (back) back.addEventListener('click', () => go(state.route.back.page, state.route.back.id ? { id: state.route.back.id } : {}));
  }

  async function buyPack(packId) {
    const r = await call('server:topup', { pack: packId });
    if (!r.redirect_url && !r.checkout_url) {
      // Practice credits: already on the account.
      toast('ok', r.message);
      state.credits = null;
      return;
    }
    state.checkout = { id: r.payment_id, url: r.checkout_url || r.redirect_url, status: 'pending', since: Date.now() };
    toast('ok', r.message, 9000);
    pollCheckout();
  }

  /** Ask the site how the purchase stands every few seconds — it asks the provider. */
  function pollCheckout() {
    clearTimeout(state.checkoutTimer);
    const c = state.checkout;
    if (!c || c.status !== 'pending') return;
    state.checkoutTimer = setTimeout(async () => {
      if (state.checkout !== c) return;
      try {
        const p = await call('server:payment', { id: c.id });
        c.status = p.status;
        c.message = p.message;
        c.note = p.note || '';
        if (p.status === 'paid') toast('ok', p.message, 9000);
        else if (p.status !== 'pending') toast('warn', p.message, 9000);
      } catch (err) {
        c.note = err.message;
      }
      if (c.status !== 'pending') state.credits = null;
      if (state.route.page === 'credits') renderCredits();
      else if (state.route.page === 'console' && state.consoleTab === 'wallet') { state.account = null; renderConsole(); }
      if (c.status === 'pending' && Date.now() - (c.since || Date.now()) < 65 * 60 * 1000) pollCheckout();
    }, 3000);
  }

  function renderCredits() {
    const page = $('page');
    if (!paired()) return needSignin('Buying credits');
    const c = state.credits;
    if (!c) {
      page.innerHTML = '<div class="wrap"><div class="empty">Loading your credits…</div></div>';
      loadCredits().then(() => { if (state.route.page === 'credits') renderCredits(); })
        .catch((err) => { page.innerHTML = `<div class="wrap"><div class="note bad">${esc(err.message)}</div></div>`; });
      return;
    }
    const doc = state.doc;
    const balance = doc && doc.user ? doc.user.balance : c.balance;
    const escrow = doc && doc.user ? doc.user.escrow : c.escrow;
    page.innerHTML = `<div class="wrap" style="max-width:900px">
      <div class="between" style="margin-bottom:14px"><h1 style="font-size:24px">Credits</h1>
        <span class="tiny muted">Kept on the LineRight Regbot site; this app shows them within seconds of any change.</span></div>
      <div class="wallet-hero">
        <div class="wallet-cell"><div class="v">${coins(balance)}</div><div class="k">To spend</div></div>
        <div class="wallet-cell"><div class="v warn">${coins(escrow)}</div><div class="k">Staked on bids</div></div>
      </div>
      <p class="small muted" style="margin:-4px 0 16px">A bid holds its credits while you wait. They come back in full if you leave the line, or if the booking does not happen; they are spent only when an appointment is booked for you. A bid your credits do not cover is refused.</p>
      ${creditsBody({ ...c, balance }, state.route)}
    </div>`;
    wireCredits(page, renderCredits);
  }

  // ------------------------------------------------------ asking for a line
  // A line on a booking site the regbot site does not cover yet: asked for
  // here, counted together with everybody who asked for the same, and answered
  // by the people running regbot (the server's site_requests.py). What a person
  // writes goes to them only; the site, the count and the answer are public
  // once they have read it.
  const REQUEST_SAY = { new: 'asked', reviewing: 'being looked at', planned: 'planned', live: 'live', declined: 'declined' };
  const REQUEST_TAG = { new: 'pending', reviewing: 'processing', planned: 'open', live: 'fulfilled', declined: 'cancelled' };

  // Somebody who wants appointments first, and ticked: the site's JSON comes in
  // alphabetical order, which would put "runs this booking system" first.
  const roleOrder = (roles) => ['person', 'operator', 'other'].filter((k) => roles[k])
    .concat(Object.keys(roles).filter((k) => !['person', 'operator', 'other'].includes(k)));

  function requestRow(r, { mine = false } = {}) {
    const what = `<b>${esc(r.site_name)}</b>${r.line_name ? ` <span class="muted">— ${esc(r.line_name)}</span>` : ''}`;
    const where = `${esc(r.domain)}${r.region ? ` · ${esc(r.region)}` : ''}`;
    const act = mine || r.asked ? '<span class="tiny muted">you asked</span>'
      : r.status === 'live' ? '' : `<button class="btn btn-sm" data-metoo="${Number(r.id)}">Me too</button>`;
    return `<div class="rq-item">
      <div class="rq-count num" title="people who asked">${Number(r.supporters) || 0}</div>
      <div class="rq-what">${what}<div class="tiny muted">${where}</div>
        <span class="tag tag-${REQUEST_TAG[r.status] || 'pending'}">${esc(REQUEST_SAY[r.status] || r.status)}</span>
        ${r.reply ? `<div class="tiny muted" style="margin-top:4px; white-space:pre-wrap">${esc(r.reply)}</div>` : ''}
        ${r.status === 'live' && r.queue_id ? `<div style="margin-top:6px"><a data-board="${Number(r.queue_id)}">Open the line →</a></div>` : ''}</div>
      <div class="rq-act">${act}</div>
    </div>`;
  }

  function renderRequest() {
    const page = $('page');
    if (!paired()) return needSignin('Asking for a line');
    const r = state.requests;
    if (!r) {
      page.innerHTML = '<div class="wrap"><div class="empty">Loading…</div></div>';
      call('requests:list').then((v) => { state.requests = v; if (state.route.page === 'request') renderRequest(); })
        .catch((err) => { page.innerHTML = `<div class="wrap"><div class="note bad">${esc(err.status === 404 ? 'This LineRight Regbot site does not take requests for new lines yet.' : err.message)}</div></div>`; });
      return;
    }
    const pre = state.route.prefill || {};
    const roles = r.roles || { person: 'wants appointments there', operator: 'runs this booking system', other: 'something else' };
    page.innerHTML = `<div class="wrap" style="max-width:1100px">
      <h1 style="font-size:24px; margin-bottom:6px">Ask for a line</h1>
      <p class="small muted" style="margin:0 0 16px; max-width:80ch">If the booking system you need is not among the sites — another state's DMV, a consulate, a clinic, a permit office, or another kind of appointment on a site that is here — ask for it. Everybody who asks for the same one is counted together, so the most wanted come first; the answer shows here, and the app tells you when it comes. If you run the booking system yourself, say so.</p>
      <div class="split">
        <div>
          <form class="panel" id="rq-form">
            <div class="panel-title">The booking site</div>
            <label class="field"><span class="field-label">Its address <span class="req">*</span></span>
              <input name="url" required maxlength="300" placeholder="https://… — the page you book appointments on" value="${esc(pre.url || '')}" spellcheck="false"></label>
            <div class="grid-2">
              <label class="field"><span class="field-label">What it is called <span class="req">*</span></span>
                <input name="site_name" required maxlength="80" placeholder="e.g. Nevada DMV" value="${esc(pre.site_name || '')}"></label>
              <label class="field"><span class="field-label">Which appointments</span>
                <input name="line_name" maxlength="80" placeholder="e.g. Road test, visa interview" value="${esc(pre.line_name || '')}"></label>
            </div>
            <label class="field"><span class="field-label">Where</span>
              <input name="region" maxlength="80" placeholder="City, state or country — or the offices you mean"></label>
            <span class="field-label">You</span>
            <div class="rq-roles">${roleOrder(roles).map((key) => `<label class="rq-role"><input type="radio" name="role" value="${esc(key)}" ${key === 'person' ? 'checked' : ''}> <span>${esc(roles[key].charAt(0).toUpperCase() + roles[key].slice(1))}</span></label>`).join('')}</div>
            <label class="field"><span class="field-label">Anything we should know</span>
              <textarea name="details" maxlength="2000" rows="4" placeholder="How hard it is to get a slot, how often they appear, which offices…"></textarea>
              <span class="field-help">Please leave out anything personal — no licence numbers, dates of birth or booking references. It goes to the people running LineRight Regbot only.</span></label>
            <label class="field"><span class="field-label">Email <span class="muted">— only if you want to be reached somewhere other than your account</span></span>
              <input name="email" type="email" maxlength="254" placeholder="Needed only if you run the booking system and your account has none"></label>
            <div id="rq-error" class="note bad hidden" style="margin-bottom:10px"></div>
            <button class="btn btn-accent" type="submit">Ask for this line</button>
          </form>
          ${(r.mine || []).length ? `<div class="panel" style="margin-top:14px"><div class="panel-title">What you asked for</div>${r.mine.map((m) => requestRow(m, { mine: true })).join('')}</div>` : ''}
        </div>
        <div class="panel"><div class="panel-title">What people have asked for</div>
          ${(r.popular || []).length ? r.popular.map((p) => requestRow(p)).join('') : '<p class="small muted" style="margin:0">Nothing to show yet.</p>'}
          <p class="tiny muted" style="margin:12px 0 0">A new request appears here once the people running LineRight Regbot have read it.</p>
        </div>
      </div>
    </div>`;
    const form = $('rq-form');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const body = Object.fromEntries(new FormData(form).entries());
      const box = $('rq-error');
      box.classList.add('hidden');
      const button = form.querySelector('button[type=submit]');
      button.disabled = true;
      try {
        const done = await call('requests:submit', body);
        toast('ok', done.message, 9000);
        state.requests = null;
        state.route.prefill = null;
        renderRequest();
      } catch (err) {
        box.textContent = err.message;
        box.classList.remove('hidden');
        button.disabled = false;
      }
    });
    for (const b of page.querySelectorAll('[data-metoo]')) {
      b.addEventListener('click', async () => {
        b.disabled = true;
        try { const done = await call('requests:support', { id: Number(b.dataset.metoo) }); toast('ok', done.message, 9000); }
        catch (err) { toast('bad', err.message, 9000); }
        state.requests = null;
        renderRequest();
      });
    }
    for (const a of page.querySelectorAll('[data-board]')) a.addEventListener('click', () => go('board', { id: Number(a.dataset.board) }));
  }

  // -------------------------------------------------------------- advanced
  // This app's own telemetry, kept on this computer (src/telemetry.js): how its
  // conversation with the site is going, how fast the site says it answers,
  // what its robots did, and what it costs this computer. Drawn with the same
  // charts as the site's admin panel (charts.js). Shared with the site only
  // when the person presses Share, or turns sharing on — and what would go is
  // shown first, exactly.
  const ADV_CHARTS = [
    { id: 'syncs', title: 'Syncs with the site', kind: 'bars', series: [['ok', 'Answered', '#16a34a'], ['sync_errors', 'Failed', '#dc2626']] },
    { id: 'synctime', title: 'How long a sync takes', unit: 'ms', kind: 'line', series: [['sync_ms', 'Average', '#0d9488'], ['sync_ms_max', 'Slowest', '#d97706']] },
    { id: 'rtt', title: 'Round trip, timed by the site', unit: 'ms', kind: 'line', series: [['rtt_ms', 'Round trip', '#2563eb']] },
    { id: 'robots', title: 'What the robots did', kind: 'bars', series: [['reads_done', 'Looked', '#0d9488'], ['reads_blocked', 'Stopped by a check', '#d97706'], ['reads_failed', 'Failed', '#dc2626'], ['bookings', 'Bookings', '#7c3aed']] },
    { id: 'memory', title: 'Memory this app uses', unit: 'MB', kind: 'line', series: [['memory_mb', 'All its processes', '#64748b']] },
    { id: 'cpu', title: 'CPU this app uses', unit: '%', kind: 'line', series: [['cpu_pct', 'All its processes', '#db2777']] },
  ];

  function advChart(t, spec) {
    const series = spec.series.map(([key, label, color]) => {
      let values = t.series[key] || [];
      if (key === 'ok') values = (t.series.syncs || []).map((n, i) => Math.max(0, n - ((t.series.sync_errors || [])[i] || 0)));
      return { key, label, color, values };
    });
    return { id: spec.id, title: spec.title, unit: spec.unit || '', kind: spec.kind, series };
  }

  const fmtN = (v, unit = '') => (v === null || v === undefined ? '–' : `${Math.round(v * 10) / 10}${unit}`);

  function advTiles(t) {
    const s = t.summary;
    const l = t.connection;
    const standing = l && l.dropped ? '<span class="bad">too slow — offered nothing</span>' : l && l.warn ? '<span class="warn">slow — may lose a slot</span>' : l && l.ms !== null && l.ms !== undefined ? '<span class="ok">fine</span>' : '<span class="muted">not timed yet</span>';
    const tile = (v, k, sub = '') => `<div class="wallet-cell"><div class="v">${v}</div><div class="k">${k}</div>${sub ? `<div class="tiny muted" style="margin-top:4px">${sub}</div>` : ''}</div>`;
    return `<div class="wallet-hero">
      ${tile(num(s.syncs), 'Syncs', s.sync_errors ? `<span class="bad">${num(s.sync_errors)} failed</span>${s.offline_minutes ? ` · ${num(s.offline_minutes)} min offline` : ''}` : 'none failed')}
      ${tile(fmtN(s.sync_ms_p50, ' ms'), 'Sync, median', `95th: ${fmtN(s.sync_ms_p95, ' ms')}`)}
      ${tile(fmtN(s.rtt_ms_p50, ' ms'), 'Round trip, median', `${standing}${l && l.slower_than !== null && l.slower_than !== undefined && l.n > 1 ? ` · slower than ${num(l.slower_than)}% of ${num(l.n)}` : ''}`)}
      ${tile(`${num(s.reads_done)}/${num(s.reads)}`, 'Reads looked', `${num(s.reads_blocked)} stopped · ${num(s.openings_found)} opening${s.openings_found === 1 ? '' : 's'}`)}
      ${tile(num(s.robot_runs), 'Robot runs', `${num(s.robot_failures)} without an answer · ${num(s.bookings_booked)}/${num(s.bookings)} booked`)}
      ${tile(fmtN(s.memory_mb_max, ' MB'), 'Memory, most', `CPU ${fmtN(s.cpu_pct_p50, '%')} typical · up ${Math.floor(s.uptime_minutes / 60)}h ${s.uptime_minutes % 60}m`)}
    </div>`;
  }

  function advEvents(t) {
    if (!t.events.length) return '<div class="empty">Nothing has happened yet.</div>';
    const words = (e) => Object.entries(e).filter(([k]) => !['t', 'kind', 'status', 'ms'].includes(k)).map(([k, v]) => `${k.replace(/_/g, ' ')} ${v}`).join(' · ');
    return `<table class="data"><thead><tr><th>When</th><th>What</th><th>How</th><th class="right">Took</th><th></th></tr></thead><tbody>
      ${t.events.map((e) => `<tr><td class="muted num">${esc(new Date(e.t * 1000).toLocaleTimeString())}</td><td>${esc(e.kind.replace(/_/g, ' '))}</td><td class="muted">${esc((e.status || '').replace(/_/g, ' '))}</td>
        <td class="right num muted">${e.ms !== undefined ? esc(e.ms >= 60000 ? `${Math.round(e.ms / 6000) / 10} min` : e.ms >= 1000 ? `${Math.round(e.ms / 100) / 10} s` : `${e.ms} ms`) : ''}</td>
        <td class="tiny muted">${esc(words(e))}</td></tr>`).join('')}
    </tbody></table>`;
  }

  function advShare(t) {
    const accepted = t.accepted;
    const last = t.lastShare;
    const offline = !t.paired;
    const refused = accepted && accepted.accepts === false;
    const history = (t.shares || []).map((x) => `<div class="kv"><dt>${esc(new Date(x.at * 1000).toLocaleString())}${x.auto ? ' · automatic' : ''}</dt><dd class="${x.ok ? 'ok' : 'bad'}" style="font-family:var(--sans)">${x.ok ? 'shared' : 'refused'} — ${esc(x.message)}</dd></div>`).join('');
    return `<div class="panel"><div class="panel-title">Share with LineRight Regbot</div>
      <p class="small" style="margin:0 0 8px">Sharing sends this app's numbers to <b>${esc(t.server || 'the LineRight Regbot site')}</b>, where the people running it can see how the apps are doing — how long syncs take, how often they fail, how fast round trips are, what the robots managed, and how much memory and CPU the app uses.</p>
      <p class="tiny muted" style="margin:0 0 12px">What goes is numbers and a short list of words — kinds of event, how they ended — plus this app's version and operating system. Nothing from your profile, no line, office, date or booking reference, no page you opened. The site keeps it for a few months. <a id="adv-preview">${state.advPreview ? 'Hide' : 'See'} exactly what would be sent</a></p>
      ${state.advPreview ? `<pre class="json-box">${esc(JSON.stringify(state.advPreview.payload, null, 2))}</pre><p class="tiny muted" style="margin:6px 0 12px">${Math.round(state.advPreview.bytes / 102.4) / 10} KB</p>` : ''}
      ${refused ? '<div class="note warn" style="margin-bottom:10px">This LineRight Regbot site is not taking app telemetry at the moment.</div>' : ''}
      ${offline ? '<div class="note" style="margin-bottom:10px">Sign in to share: it goes to the site this app is signed in to.</div>' : ''}
      <div class="row" style="flex-wrap:wrap; margin-bottom:10px">
        <button class="btn btn-accent btn-sm" id="adv-share-now" ${offline || refused ? 'disabled' : ''}>Share now</button>
        <label class="small row" style="gap:6px; margin:0; cursor:pointer"><input type="checkbox" id="adv-auto" ${t.autoShare ? 'checked' : ''}> Share automatically, every six hours</label>
      </div>
      <p class="tiny muted" style="margin:0 0 8px">${last ? `Last shared ${esc(new Date(last.at * 1000).toLocaleString())}.` : 'Never shared.'}</p>
      ${history}
    </div>`;
  }

  // The trace the site asks for (src/traces.js): what this app did, with the
  // person taken out (src/scrub.js), sent only when LineRight Regbot asks for
  // it — and the switch that stops it and deletes what was kept.
  const LEVEL_WORDS = { full: 'everything', outline: 'an outline — no single requests', off: 'nothing at the moment' };

  function advTrace(x) {
    if (!x) return '';
    const last = (x.uploads || [])[0];
    const kb = Math.round((x.bytes || 0) / 102.4) / 10;
    const lines = (x.recent || []).slice(-40).reverse().map((e) => {
      const { s: n, t, k, ...rest } = e;
      return `${new Date(t).toLocaleTimeString()}  ${k}  ${JSON.stringify(rest)}`;
    }).join('\n');
    return `<div class="panel"><div class="panel-title">A trace for LineRight Regbot</div>
      <p class="small" style="margin:0 0 8px">This app writes down what it does — the booking pages it opens and how long each request takes, what its robots saw, how each of your turns went, and what it told you — with you taken out of it: your name, date of birth, licence, passport and Social Security numbers, address, phone and email, in every way a page could spell them; any confirmation number; and nothing you type into a form. <b>${esc(x.server || 'The LineRight Regbot site')}</b> asks for it now and then, so the people running it can see why a booking did or did not work.</p>
      <label class="small row" style="gap:6px; margin:0 0 8px; cursor:pointer"><input type="checkbox" id="adv-trace-on" ${x.on ? 'checked' : ''}> Keep a trace, and send it when the site asks</label>
      ${x.on ? `<p class="tiny muted" style="margin:0 0 8px">${num(x.kept)} event${x.kept === 1 ? '' : 's'} kept here (${kb} KB) · ${num(x.sent)} sent so far · the site asks for ${esc(LEVEL_WORDS[x.level] || x.level)}${x.lost ? ` · ${num(x.lost)} too old to send, deleted` : ''}.
        ${last ? `Last upload ${esc(new Date(last.at).toLocaleString())}: ${last.ok ? `${num(last.events)} events` : `<span class="bad">refused — ${esc(last.message)}</span>`}.` : 'Nothing sent yet.'}</p>
        <div class="row" style="flex-wrap:wrap; margin-bottom:8px"><button class="btn btn-sm" id="adv-trace-see">${state.advTrace ? 'Hide' : 'See'} the last events</button>
          <button class="btn btn-sm btn-danger" id="adv-trace-clear">Delete what is kept</button></div>
        ${state.advTrace ? `<pre class="json-box" style="max-height:340px; overflow:auto">${esc(lines || 'Nothing yet.')}</pre>` : ''}`
    : '<p class="tiny muted" style="margin:0">Off: nothing is written down, and nothing is sent.</p>'}
    </div>`;
  }

  async function renderAdvanced(fresh) {
    const page = $('page');
    let t;
    try { t = await call('telemetry:get', { range: state.advRange }); }
    catch (err) { page.innerHTML = `<div class="wrap"><div class="note bad">${esc(err.message)}</div></div>`; return; }
    if (state.route.page !== 'advanced') return;
    const built = page.querySelector('#adv-root');
    if (fresh || !built) {
      page.innerHTML = `<div class="wrap" id="adv-root" style="max-width:1100px">
        <div class="between" style="margin-bottom:14px; flex-wrap:wrap">
          <div><h1 style="font-size:24px">Advanced — telemetry and diagnostics</h1>
            <p class="small muted" style="margin:4px 0 0">How this app is doing, kept on this computer for the last day. These numbers leave it only if you share them; the trace, with your details taken out, goes to LineRight Regbot when the site asks — unless you turn it off.</p></div>
          <div class="rc-range" id="adv-range">${['1h', '6h', '24h'].map((r) => `<button type="button" data-range="${r}" class="${r === state.advRange ? 'on' : ''}">${r}</button>`).join('')}</div>
        </div>
        <div id="adv-tiles"></div>
        <div class="rc-charts" id="adv-charts" style="margin-bottom:18px">${ADV_CHARTS.map((c) => `<div id="adv-${c.id}"></div>`).join('')}</div>
        <div class="split">
          <div class="card"><div class="card-pad" style="padding-bottom:0"><div class="panel-title">What happened</div></div><div id="adv-events"></div></div>
          <div class="stack"><div id="adv-trace"></div><div id="adv-share"></div>
            <div class="panel"><div class="panel-title">Kept on this computer</div>
              <p class="tiny muted" style="margin:0 0 10px">A minute at a time for the last day, and the last few hundred events, in telemetry.json in this app's data folder. Start over in Settings deletes it too.</p>
              <button class="btn btn-sm btn-danger" id="adv-clear">Clear this app's telemetry</button></div></div>
        </div>
      </div>`;
      for (const b of page.querySelectorAll('#adv-range [data-range]')) {
        b.addEventListener('click', () => { state.advRange = b.dataset.range; renderAdvanced(true); });
      }
      page.querySelector('#adv-clear').addEventListener('click', async () => {
        if (!window.confirm("Delete this app's telemetry from this computer?")) return;
        await call('telemetry:clear');
        toast('ok', 'Cleared.');
        renderAdvanced(true);
      });
      if (state.advTimer) clearInterval(state.advTimer);
      state.advTimer = setInterval(() => { if (state.route.page === 'advanced' && !document.hidden) renderAdvanced(false); }, 15000);
    }
    $('adv-tiles').innerHTML = advTiles(t);
    for (const spec of ADV_CHARTS) window.RegbotCharts.render($(`adv-${spec.id}`), advChart(t, spec), { points: t.points, step: t.step });
    $('adv-events').innerHTML = advEvents(t);
    let x = null;
    try { x = await call('traces:get', { n: 60 }); } catch { /* an app without one */ }
    if (state.route.page !== 'advanced') return;
    const box = $('adv-trace');
    box.innerHTML = advTrace(x);
    if (x) {
      box.querySelector('#adv-trace-on').addEventListener('change', async (e) => {
        if (!e.target.checked && !window.confirm('Turn the trace off? What is kept here is deleted, and nothing more is written down or sent.')) {
          e.target.checked = true;
          return;
        }
        await call('traces:on', { on: e.target.checked });
        toast('ok', e.target.checked ? 'The trace is on: LineRight Regbot gets it when the site asks.' : 'The trace is off, and what was kept is deleted.');
        renderAdvanced(false);
      });
      const see = box.querySelector('#adv-trace-see');
      if (see) see.addEventListener('click', () => { state.advTrace = !state.advTrace; renderAdvanced(false); });
      const clear = box.querySelector('#adv-trace-clear');
      if (clear) {
        clear.addEventListener('click', async () => {
          if (!window.confirm('Delete the trace kept on this computer? What the site already has stays there.')) return;
          await call('traces:clear');
          toast('ok', 'Deleted.');
          renderAdvanced(false);
        });
      }
    }
    const share = $('adv-share');
    share.innerHTML = advShare(t);
    share.querySelector('#adv-preview').addEventListener('click', async () => {
      state.advPreview = state.advPreview ? null : await call('telemetry:preview');
      renderAdvanced(false);
    });
    const shareNow = share.querySelector('#adv-share-now');
    shareNow.addEventListener('click', async () => {
      const preview = await call('telemetry:preview');
      if (!window.confirm(`Send ${Math.round(preview.bytes / 102.4) / 10} KB of this app's telemetry to ${t.server}?`)) return;
      shareNow.disabled = true;
      try {
        const r = await call('telemetry:share');
        toast('ok', r.reply && r.reply.duplicate ? 'That was already shared.' : 'Shared — thank you.');
      } catch (err) { toast('bad', err.message, 9000); }
      renderAdvanced(false);
    });
    share.querySelector('#adv-auto').addEventListener('change', async (e) => {
      await call('telemetry:auto', { on: e.target.checked });
      toast('ok', e.target.checked ? 'This app will share its telemetry every six hours.' : 'Automatic sharing is off.');
    });
  }

  // -------------------------------------------------------------- profile
  /**
   * Finish what the gate interrupted.
   *
   * Either an action that was waiting on the details — opening a booking page —
   * or simply the line they were about to bid on.
   */
  function runGate(gate) {
    if (gate.then) { api.call(gate.then.action, gate.then.args || {}); return; }
    if (gate.back) { go(gate.back.page, gate.back.id ? { id: gate.back.id } : {}); return; }
    go('sites');
  }

  function renderProfile() {
    const page = $('page');
    const p = state.profile;
    const gate = state.route.gate && state.route.gate.need && state.route.gate.need.length
      ? state.route.gate : null;
    if (!p) {
      page.innerHTML = '<div class="wrap"><div class="empty">Loading…</div></div>';
      api.call('profile:get').then((v) => { state.profile = v; if (state.route.page === 'profile') renderProfile(); });
      return;
    }
    const storage = p.error ? `<div class="note bad">Your saved profile could not be read: ${esc(p.error)}. Saving again writes a fresh one.</div>`
      : p.filled === 0 ? '<div class="note">Nothing saved yet — and most of it is already in the browser you use. <b>⇱ Import from your browser</b> fills this in in a few seconds, which is the quickest way to be ready to bid.</div>'
        : p.encrypted ? `<div class="note ok">Saved on this machine, encrypted by the operating system (${esc(p.backend)}).</div>`
          : p.available ? `<div class="note warn">Saved on this machine as plain text, from a time when no keychain was available. Save again and it is encrypted with ${esc(p.backend)}.</div>`
            : `<div class="note warn">Saved on this machine as plain text: no keychain is available here (${esc(p.backend)}). Anyone who can read your files can read it. On a desktop with a keyring it is encrypted automatically.</div>`;
    const wanted = new Set(gate ? gate.need.map((f) => f.profileKey) : []);
    // "full name" is held as two fields, so ask for the two.
    if (wanted.delete('full_name')) { wanted.add('first_name'); wanted.add('last_name'); }
    const gateNote = gate ? `<div class="note warn" style="margin-bottom:14px">
        <b>${esc(gate.why || 'Some details are missing.')}</b>
        <div class="small" style="margin-top:6px">Fill in the highlighted fields below and save —
        they stay on this machine, and the app types them into the booking form for you.</div>
        ${gate.then ? '<button class="btn btn-sm" id="gate-skip" style="margin-top:8px">Open the booking page without them</button>' : ''}
      </div>` : '';
    page.innerHTML = `<div class="wrap" style="max-width:860px">
      ${gateNote}
      <div class="between" style="margin-bottom:14px; align-items:flex-start">
        <div><h1 style="font-size:24px">Your profile</h1>
          <p class="small muted" style="margin:4px 0 0; max-width:64ch">What booking forms ask for. It stays on this machine — LineRight Regbot's server never receives it — and is typed into the form for you when the app opens a booking page. A Social Security number is only ever typed into a field that asks for it by name.</p></div>
        <button class="btn btn-sm${p.filled ? '' : ' btn-accent'}" id="p-import" title="Take what your browser has already saved">⇱ Import from your browser</button>
      </div>
      ${storage}
      <form id="profileForm" class="panel" style="margin-top:14px">
        ${p.groups.map(([g, label]) => `<div class="pgroup"><h3>${esc(label)}</h3><div class="pgrid">${p.fields.filter((f) => f.group === g).map((f) => `
          <label class="field${wanted.has(f.key) ? ' field-wanted' : ''}"><span class="field-label">${esc(f.label)}${wanted.has(f.key) ? ' <span class="req">needed</span>' : ''}</span>
            <input type="${f.secret ? 'password' : (f.type || 'text')}" name="${esc(f.key)}" value="${esc(p.data[f.key] || '')}" placeholder="${esc(f.placeholder || '')}" autocomplete="off" spellcheck="false" ${f.pattern ? `pattern="${esc(f.pattern)}"` : ''}>
            ${f.hint ? `<span class="field-help">${esc(f.hint)}</span>` : ''}</label>`).join('')}</div></div>`).join('')}
        <div class="sep"></div>
        <div class="check"><input type="checkbox" id="p-autofill" ${p.autofill ? 'checked' : ''}><label for="p-autofill"><span class="small">Fill booking forms automatically when the app opens one</span><span class="field-help">Off, and the <b>✎ Fill form</b> button still does it when you ask.</span></label></div>
        <div class="check"><input type="checkbox" id="p-show"><label for="p-show"><span class="small">Show the hidden numbers</span></label></div>
        <div class="row" style="margin-top:8px"><button class="btn btn-accent" type="submit">Save on this machine</button><button class="btn btn-danger" type="button" id="p-clear">Delete everything</button><span class="tiny muted" style="margin-left:auto">${esc(p.file)}</span></div>
      </form>
    </div>`;
    $('p-import').addEventListener('click', () => go('import'));
    const form = $('profileForm');
    const firstWanted = form.querySelector('.field-wanted input');
    if (firstWanted) setTimeout(() => firstWanted.focus(), 0);
    const skip = $('gate-skip');
    if (skip) {
      skip.addEventListener('click', () => {
        toast('warn', 'Opening it unfilled — you will have to type your details on the form.', 9000);
        api.call(gate.then.action, { ...(gate.then.args || {}), anyway: true });
      });
    }
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const data = {};
      for (const f of p.fields) data[f.key] = form.querySelector(`[name="${f.key}"]`).value;
      const saved = await api.call('profile:set', {
        data, autofill: $('p-autofill').checked, check: gate ? gate.need : [],
      });
      state.profile = saved;
      // Every line's "in your profile / missing" was worked out against what
      // the profile held a moment ago. Drop them so they are asked for again.
      state.board = null;
      state.siteDocs = {};
      const short = (saved.checked || []).filter((f) => f.state === 'missing');
      if (gate && !short.length) {
        toast('ok', 'Saved — that is everything this line asks for.');
        state.route.gate = null;
        runGate(gate);
        return;
      }
      if (gate) {
        state.route.gate = { ...gate, need: short };
        toast('warn', `Saved, but ${tellNames(short)} is still empty.`, 9000);
      } else {
        toast('ok', 'Profile saved on this machine.');
      }
      renderProfile();
    });
    $('p-show').addEventListener('change', (e) => { for (const f of p.fields) if (f.secret) form.querySelector(`[name="${f.key}"]`).type = e.target.checked ? 'text' : 'password'; });
    $('p-clear').addEventListener('click', async () => {
      if (!window.confirm('Delete every saved detail from this machine?')) return;
      state.profile = await api.call('profile:clear');
      toast('ok', 'Profile deleted.');
      renderProfile();
    });
  }

  // ---------------------------------------------- import from your browser
  /**
   * What another browser on this machine can hand over.
   *
   * Two steps, because the second one costs something: the machine is looked
   * at for browsers (cheap, and nothing is read), and then one browser is
   * opened on request — which on macOS puts up a keychain dialog, so it is
   * not a thing to do to five browsers because somebody opened a screen.
   * Nothing is written until the button at the bottom, and every line of it
   * is a tick box.
   */
  function renderImport() {
    const page = $('page');
    const scan = state.imports;
    if (!scan) {
      page.innerHTML = '<div class="wrap"><div class="empty">Looking for browsers on this machine…</div></div>';
      api.call('import:scan').then((v) => { state.imports = v; if (state.route.page === 'import') renderImport(); });
      return;
    }
    // Arrived at on startup rather than asked for: say why it is worth the
    // minute now, when the alternative is finding out with a clock running.
    const first = Boolean(state.route.first);
    const why = first ? `<div class="panel" style="margin-bottom:14px; border-left:3px solid var(--accent)">
        <div class="row" style="margin-bottom:7px"><span class="chip chip-accent">Setting up</span>
          <b>Worth doing now: it is what makes your turn quick</b></div>
        <p class="small" style="margin:0; max-width:70ch">Booking forms ask for the same handful of things — name, date of birth, licence
        number, email, phone, address — and this app types them in for you from a profile kept on this machine. A line checks it has what its
        form will ask for <em>before</em> it takes your bid, and when a slot is yours a clock runs while you fill the form in. That is the worst
        possible moment to be hunting for a licence number. Your browser has most of it already; this takes a few seconds.</p>
      </div>` : '';
    const head = `${why}<div style="margin-bottom:14px">
      <h1 style="font-size:24px">Import from your browser</h1>
      <p class="small muted" style="margin:4px 0 0; max-width:70ch">Take the details you have already saved in Chrome, Edge, Brave or any other
      Chromium browser — your name, email, phone and address — straight into the profile this app fills booking forms from. Where you are
      already signed in to a booking site, that sign-in can come across too, so your turn does not start at a login page. Everything is
      read on this machine, shown to you first, and nothing is sent anywhere.</p></div>`;

    if (!scan.browsers.length) {
      page.innerHTML = `<div class="wrap" style="max-width:860px">${head}
        <div class="panel"><div class="empty">No Chromium browser was found on this machine.<br>
        <span class="small">Chrome, Edge, Brave, Vivaldi, Opera, Arc and Comet are all read the same way. Firefox and Safari keep their
        data differently and are not read.</span></div></div>
        <p class="small" style="margin-top:14px"><a id="i-profile">Fill the profile in by hand instead</a></p></div>`;
      $('i-profile').addEventListener('click', async () => { await api.call('import:dismiss'); go('profile'); });
      return;
    }

    const found = state.found;
    page.innerHTML = `<div class="wrap" style="max-width:860px">${head}
      <div class="panel"><div class="panel-title">Browsers on this machine</div>
        ${scan.browsers.map((b, i) => `<div class="between" style="padding:8px 0; border-top:${i ? '1px solid var(--line-soft)' : '0'}">
          <div style="min-width:0">
            <div><b>${esc(b.name)}</b>${b.known ? '' : ' <span class="chip">found on disk</span>'}</div>
            <div class="tiny muted" style="overflow:hidden; text-overflow:ellipsis">${esc(b.dir)}</div>
          </div>
          <div class="row">
            ${b.profiles.length > 1 ? `<select id="i-who-${i}" class="small">${b.profiles.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('')}</select>` : ''}
            <button class="btn btn-sm" data-look="${i}" ${state.reading ? 'disabled' : ''}>${state.reading === b.dir ? 'Reading…' : 'Look inside'}</button>
          </div></div>`).join('')}
        ${scan.platform === 'darwin' ? '<div class="note" style="margin-top:12px">macOS will ask your permission before handing over a browser’s key. The dialog is the system’s own; nothing is read until you allow it.</div>' : ''}
      </div>
      ${found ? offerHtml(found) : ''}
      ${first ? `<div class="row" style="margin-top:16px"><button class="btn btn-ghost" id="i-skip">Skip for now — I'll type them in myself</button>
        <span class="tiny muted">It stays in <b>File → Import from your browser</b>${paired() ? '' : ', and signing in comes next'}.</span></div>` : ''}
      <p class="small muted" style="margin-top:16px">Passwords, payment cards, history and bookmarks are never read — this app has no use for the
      first two, and nowhere to put the others. Cookies are read to count them and copied only where you tick.</p>
    </div>`;

    const skip = $('i-skip');
    if (skip) {
      skip.addEventListener('click', async () => {
        await api.call('import:dismiss');
        go(paired() ? 'sites' : 'signin');
      });
    }
    for (const btn of page.querySelectorAll('[data-look]')) {
      btn.addEventListener('click', async () => {
        const i = Number(btn.dataset.look);
        const browser = scan.browsers[i];
        const which = $(`i-who-${i}`) ? $(`i-who-${i}`).value : (browser.profiles[0] || {}).id;
        state.reading = browser.dir;
        state.found = null;
        renderImport();
        try {
          state.found = await call('import:read', { dir: browser.dir, profile: which });
        } catch (err) {
          toast('bad', `Could not read ${browser.name}: ${err.message}`, 9000);
        } finally {
          state.reading = '';
          if (state.route.page === 'import') renderImport();
        }
      });
    }
    if (found) wireOffer(found);
  }

  /** A licence or a Social Security number, shown the way a receipt shows a card. */
  const mask = (v) => (String(v).length > 4 ? `${'•'.repeat(Math.min(8, String(v).length - 4))}${String(v).slice(-4)}` : '••••');

  /** What one browser turned out to hold, as a list of things to tick. */
  function offerHtml(found) {
    const fields = found.fields || [];
    const sites = found.sites || [];
    const nothing = !fields.length && !sites.length && !(found.others || {}).count;
    const details = fields.map((f) => {
      const options = [{ value: f.value, from: f.from }, ...(f.others || [])];
      const replaces = found.held && found.held[f.key];
      return `<div class="check">
        <input type="checkbox" id="i-f-${esc(f.key)}" data-field="${esc(f.key)}" ${replaces ? '' : 'checked'}>
        <label for="i-f-${esc(f.key)}" style="flex:1; min-width:0">
          <div class="between" style="gap:10px">
            <span class="small"><b>${esc(f.label)}</b></span>
            ${options.length > 1
    ? `<select data-value="${esc(f.key)}" class="small" style="max-width:52%">${options.map((o) => `<option value="${esc(o.value)}">${esc(f.secret ? mask(o.value) : o.value)} — ${esc(o.from.toLowerCase())}</option>`).join('')}</select>`
    : `<span class="small" data-value="${esc(f.key)}" data-fixed="${esc(f.value)}">${esc(f.secret ? mask(f.value) : f.value)}</span>`}
          </div>
          <span class="field-help">${esc(options.length > 1 ? `${options.length} to choose from` : f.from)}${replaces ? ' · replaces what your profile has' : ''}</span>
        </label></div>`;
    }).join('');
    const rest = found.others || { count: 0, hosts: 0 };
    const signins = sites.map((s) => `<div class="check">
      <input type="checkbox" id="i-s-${esc(s.origin)}" data-site="${esc(s.origin)}" checked>
      <label for="i-s-${esc(s.origin)}"><span class="small"><b>${esc(s.name)}</b> — ${num(s.count)} cookie${s.count === 1 ? '' : 's'}</span>
      <span class="field-help">${esc(s.origin)}</span></label></div>`).join('')
      + (rest.count ? `<div class="check">
        <input type="checkbox" id="i-s-rest" data-others="1" checked>
        <label for="i-s-rest"><span class="small"><b>Everywhere else you are signed in</b> — ${rest.count.toLocaleString()} cookie${rest.count === 1 ? '' : 's'} across ${rest.hosts.toLocaleString()} site${rest.hosts === 1 ? '' : 's'}</span>
        <span class="field-help">A sign-in does not always stay on the site you signed in to: a portal that hands you to an identity provider
        leaves half of it on a host LineRight Regbot has never heard of, and there is no list of those to keep. So the jar comes across whole unless you say
        otherwise — untick this to bring only the sites named above.</span></label></div>` : '');
    return `<div class="panel" style="margin-top:14px">
      <div class="panel-title">${esc(found.browser.name)} · ${esc(found.profile.name)}</div>
      ${nothing ? `<div class="empty">Nothing this app can use.<br><span class="small">No saved address, and no sign-in for a booking site LineRight Regbot knows about.</span></div>` : ''}
      ${fields.length ? `<h3 style="font-size:13px; margin:0 0 10px">Your details</h3>${details}
        <div class="check"><input type="checkbox" id="i-show"><label for="i-show"><span class="small">Show the hidden numbers</span></label></div>` : ''}
      ${signins ? `<div class="sep"></div><h3 style="font-size:13px; margin:0 0 4px">Sign-ins</h3>
        <p class="tiny muted" style="margin:0 0 10px">Copied into this app's own browser, so a booking page opens signed in. Your browser keeps its own,
        and nothing is sent anywhere.</p>${signins}` : ''}
      ${found.locked ? `<div class="note warn">${num(found.locked)} cookie${found.locked === 1 ? '' : 's'} could not be unlocked on this machine and ${found.locked === 1 ? 'was' : 'were'} left behind.</div>` : ''}
      ${(found.notes || []).map((n) => `<div class="note warn" style="margin-top:8px">${esc(n)}</div>`).join('')}
      ${nothing ? '' : `<div class="row" style="margin-top:14px"><button class="btn btn-accent" id="i-apply">Import what is ticked</button>
        <span class="tiny muted">${found.addresses ? `${num(found.addresses)} saved address${found.addresses === 1 ? '' : 'es'}` : 'no saved address'}${found.forms ? `, ${num(found.forms)} remembered form field${found.forms === 1 ? '' : 's'}` : ''}</span></div>`}
    </div>`;
  }

  function wireOffer(found) {
    const page = $('page');
    const show = $('i-show');
    if (show) {
      show.addEventListener('change', () => {
        for (const f of found.fields) {
          if (!f.secret) continue;
          const el = page.querySelector(`[data-value="${f.key}"]`);
          if (!el) continue;
          if (el.tagName === 'SELECT') {
            for (const o of el.options) o.textContent = `${show.checked ? o.value : mask(o.value)} — ${o.textContent.split(' — ').pop()}`;
          } else {
            el.textContent = show.checked ? el.dataset.fixed : mask(el.dataset.fixed);
          }
        }
      });
    }
    const apply = $('i-apply');
    if (!apply) return;
    apply.addEventListener('click', async () => {
      const fields = {};
      for (const box of page.querySelectorAll('[data-field]')) {
        if (!box.checked) continue;
        const el = page.querySelector(`[data-value="${box.dataset.field}"]`);
        fields[box.dataset.field] = el.tagName === 'SELECT' ? el.value : el.dataset.fixed;
      }
      const origins = [...page.querySelectorAll('[data-site]')].filter((b) => b.checked).map((b) => b.dataset.site);
      const others = Boolean($('i-s-rest') && $('i-s-rest').checked);
      const onOffer = (found.sites || []).reduce((n, s) => n + s.count, 0) + ((found.others || {}).count || 0);
      apply.disabled = true;
      try {
        const done = await call('import:apply', { fields, origins, others });
        state.profile = done.profile;
        state.board = null;
        state.siteDocs = {};
        state.found = null;
        const parts = [];
        if (done.saved) parts.push(`${done.saved} detail${done.saved === 1 ? '' : 's'} into your profile`);
        if (done.cookies) parts.push(`${done.cookies} sign-in cookie${done.cookies === 1 ? '' : 's'}`);
        if (done.stale) toast('warn', 'The sign-ins were no longer held — look inside the browser again to bring them across.', 9000);
        else {
          const weekly = done.again && done.again.sources.length ? ' Every week the app offers to bring them across again, in one click.' : '';
          toast(parts.length ? 'ok' : 'warn', parts.length ? `Imported ${parts.join(' and ')}.${weekly}` : 'Nothing was ticked, so nothing was imported.', weekly ? 9000 : 6000);
        }
        if (done.refused) toast('warn', `${done.refused} cookie${done.refused === 1 ? '' : 's'} would not go in — that site may have to be signed in to here.`, 9000);
        else if (!done.cookies && onOffer && !origins.length && !others) {
          toast('warn', `The ${onOffer.toLocaleString()} sign-ins were left unticked, so none came across — you will sign in to booking sites here yourself.`, 9000);
        }
        // First run: the details are in; the account the app pairs with is next.
        if (!paired() && state.route.first) go('signin');
        else if (done.saved) go('profile');
        else renderImport();
      } catch (err) {
        toast('bad', `Could not import: ${err.message}`, 9000);
        apply.disabled = false;
      }
    });
  }

  // ------------------------------------------- the same again, once a week
  /**
   * The browsers details were imported from, read again with one button
   * (reimport.js). The main process says when its week is up — at startup, and
   * every half hour for an app left running for days — and the screen asks,
   * but never over something more pressing: not on the first-run screens, not
   * while it is somebody's turn, and never over a booking page. Asked for from
   * the menu or Settings, it opens whatever else is on. "Not now" asks again
   * tomorrow; Settings stops the asking.
   */
  function againAllowed(a) {
    if (state.shell.mode !== 'app') return false;
    if (a.asked || a.busy || a.result) return true;
    if (['import', 'signin'].includes(state.route.page)) return false;
    return !((state.doc && state.doc.handoffs) || []).length;
  }

  /** A few profile fields by name: "phone, street address and email". */
  function fieldNames(keys) {
    const labels = Object.fromEntries(((state.profile && state.profile.fields) || []).map((f) => [f.key, f.label]));
    const names = keys.map((k) => String(labels[k] || k.replace(/_/g, ' ')).toLowerCase());
    return names.length <= 1 ? (names[0] || '') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  }

  async function openAgain(asked = false) {
    try {
      const view = await api.call('import:again-state');
      if (!view.sources.length) { go('import'); return; }
      state.again = { ...view, due: true, asked };
    } catch (err) {
      toast('bad', err.message, 9000);
      return;
    }
    renderAgain();
  }

  function renderAgain() {
    const box = $('modal');
    const a = state.again;
    const show = Boolean(a && (a.due || a.busy || a.result) && a.sources && a.sources.length && againAllowed(a));
    const key = show ? JSON.stringify([a.busy, a.result ? a.result.done.length + a.result.failed.length : -1, a.sources.map((s) => s.key)]) : '';
    if (key === state.againKey) return;
    state.againKey = key;
    if (!show) { box.classList.add('hidden'); box.innerHTML = ''; return; }
    const names = a.sources.map((src) => src.label);
    const from = names.length <= 1 ? (names[0] || 'your browser') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
    const since = a.sources[0] && a.sources[0].at ? ago(a.sources[0].at) : '';
    let body;
    if (a.result) {
      const r = a.result;
      const said = [];
      if (r.updated.length) said.push(`updated your ${fieldNames(r.updated)}`);
      if (r.cookies) said.push(`brought ${num(r.cookies)} sign-in cookie${r.cookies === 1 ? '' : 's'} across`);
      const head = !r.done.length ? 'Nothing could be read'
        : said.length ? `Done — ${said.join(' and ')}` : 'Done — nothing had changed since last time';
      body = `<h2 id="again-title">${esc(head)}.</h2>
        ${r.kept.length ? `<p class="small">Kept your own ${esc(fieldNames(r.kept))}: you changed ${r.kept.length === 1 ? 'it' : 'them'} in your profile by hand, so the browser's ${r.kept.length === 1 ? 'is' : 'are'} not taken.</p>` : ''}
        ${r.fresher ? `<p class="small muted">${num(r.fresher)} sign-in cookie${r.fresher === 1 ? '' : 's'} this app already held fresher ${r.fresher === 1 ? 'was' : 'were'} left as ${r.fresher === 1 ? 'it was' : 'they were'}.</p>` : ''}
        ${r.refused ? `<p class="small muted">${num(r.refused)} cookie${r.refused === 1 ? '' : 's'} would not go in.</p>` : ''}
        ${r.failed.map((f) => `<div class="note warn" style="margin-top:8px">${esc(f.name)} could not be read: ${esc(f.message)} Closing that browser and trying again usually settles it.</div>`).join('')}
        ${(r.notes || []).map((n) => `<div class="note warn" style="margin-top:8px">${esc(n)}</div>`).join('')}
        <div class="row" style="margin-top:16px"><button class="btn btn-accent" id="again-close">Done</button>
          ${r.failed.length ? '<button class="btn btn-ghost" id="again-retry">Try again</button>' : ''}</div>`;
    } else {
      body = `<h2 id="again-title">Bring your details across again</h2>
        <p class="small">Your details and sign-ins came from <b>${esc(from)}</b>${since ? `, ${esc(since)}` : ''}. Your browser has kept them
          current since: bring them across again, so your turn does not start at a login page, or with an old phone number.</p>
        <button class="btn btn-accent btn-big" id="again-go" ${a.busy ? 'disabled' : ''}>${a.busy ? `Re-importing from ${esc(from)}…` : 'Re-import data from your browser'}</button>
        <div class="between" style="margin-top:12px"><button class="btn btn-ghost btn-sm" id="again-later" ${a.busy ? 'disabled' : ''}>Not now</button>
          <a id="again-choose" class="small">Choose what to import…</a></div>
        <p class="tiny muted" style="margin:14px 0 0">The same as last time: the details you took then, and the sign-ins you chose.
          Anything you changed in your profile by hand is kept, and nothing is sent anywhere.</p>`;
    }
    box.innerHTML = `<div class="modal" role="dialog" aria-modal="true" aria-labelledby="again-title">${body}</div>`;
    box.classList.remove('hidden');
    const close = () => { state.again = null; renderAgain(); };
    const later = async () => {
      try { await api.call('import:later'); } catch { /* it asks again at the next look */ }
      close();
    };
    const run = async () => {
      a.busy = true;
      a.result = null;
      renderAgain();
      try {
        const r = await call('import:again');
        state.profile = r.profile;
        state.board = null;
        state.siteDocs = {};
        Object.assign(a, { busy: false, result: r, sources: r.again.sources.length ? r.again.sources : a.sources });
      } catch (err) {
        a.busy = false;
        toast('bad', `Could not re-import: ${err.message}`, 9000);
      }
      renderAgain();
      if (state.route.page === 'profile') renderProfile();
    };
    const on = (id, fn) => { const el = $(id); if (el) el.addEventListener('click', fn); };
    on('again-go', run);
    on('again-retry', run);
    on('again-later', later);
    on('again-close', close);
    on('again-choose', async () => { await later(); go('import'); });
    box.onkeydown = (e) => { if (e.key === 'Escape' && !a.busy) (a.result ? close : later)(); };
    const primary = $('again-go') || $('again-close');
    if (primary) setTimeout(() => primary.focus(), 0);
  }

  // ------------------------------------------------------------- settings
  function updateText(u) {
    switch ((u || {}).phase) {
      case 'disabled': return `off — ${u.message || 'installed builds only'}`;
      case 'idle': return `on · feed: ${u.feed || 'embedded'}`;
      case 'checking': return 'checking…';
      case 'available': return `downloading ${u.version || ''}`;
      case 'downloading': return `downloading… ${u.percent || 0}%`;
      case 'ready': return `version ${u.version || ''} downloaded — restart to install`;
      case 'none': return u.version ? `up to date (${u.version})` : (u.message || 'up to date');
      case 'error': return `error — ${u.message || ''}`;
      default: return '';
    }
  }

  const SERVICE_NAMES = { web: 'Website', worker: 'Queue processor', standin: 'DMV stand-in', admin: 'Control room' };

  function serviceRow(name, svc) {
    const st = (svc && svc.state) || 'stopped';
    const dot = { running: 'var(--ok)', starting: 'var(--gold)', restarting: 'var(--gold)', failed: 'var(--bad)', stopped: 'var(--faint)' }[st] || 'var(--faint)';
    const said = {
      running: svc && svc.port ? `running · 127.0.0.1:${svc.port}` : 'running',
      starting: 'starting…',
      restarting: 'restarting',
      failed: 'not running',
      stopped: name === 'admin' ? 'starts when you open it' : 'off',
    }[st] || st;
    const opens = { standin: st === 'running' ? 'Open' : '', admin: 'Open' }[name];
    return `<tr><td style="white-space:nowrap">${esc(SERVICE_NAMES[name])}</td>
      <td><span class="req-dot" style="background:${dot}; display:inline-block; vertical-align:middle"></span> ${esc(said)}
        ${svc && svc.message ? `<div class="tiny ${st === 'running' ? 'muted' : 'bad'}" style="margin-top:3px">${esc(svc.message)}</div>` : ''}</td>
      <td class="right">${opens ? `<a data-open-service="${name}">${opens}</a>` : ''}</td></tr>`;
  }

  function serverPanel(s) {
    const mode = s.serverMode;
    const st = s.stack;
    // Three places the app can be: the public site the build names (where the
    // real line is), practice on this computer, or somebody else's server.
    const picked = s.pendingRemote ? 'remote' : (s.serverChoice || (mode === 'builtin' ? 'builtin' : 'remote'));
    let siteHost = s.siteUrl || '';
    try { siteHost = new URL(s.siteUrl).host; } catch { /* no site named */ }
    const signedIn = `<p class="small" style="margin:0">${s.user ? `Signed in as <b>${esc(s.user.nickname)}</b>. <a id="s-signout">Sign out</a>` : `Not signed in. <a id="s-signin">Create an account or sign in</a>`}</p>`;
    const name = `<label class="field"><span class="field-label">This device's name</span><div class="row"><input id="s-name" value="${esc(s.clientName)}" style="flex:1"><button class="btn" id="s-name-save">Save</button></div>
      <span class="field-help">How this app appears in the website's list of paired devices.</span></label>`;
    if (!(s.developer && s.developer.on)) {
      // The public app: the site the build names, and nothing else to choose.
      // A server chosen in developer mode, or given on the command line, is
      // said, with the way back.
      if (picked === 'public') {
        return `<div class="panel"><div class="panel-title">Server</div>
          <p class="small" style="margin:0 0 12px"><b>LineRight Regbot</b> — ${esc(siteHost)}. The site that holds the line: everybody bidding is there, and this app pairs with your account on it, looks for openings for everyone, and books yours from this computer.</p>
          ${name}${signedIn}</div>`;
      }
      return `<div class="panel"><div class="panel-title">Server</div>
        <p class="small" style="margin:0 0 12px">This app is using <span class="num">${esc(s.serverUrl)}</span>${s.forced ? ', as it was told when it started (<span class="num">--server</span>)' : ', chosen in developer mode'}.</p>
        ${s.siteUrl && !s.forced ? `<button class="btn btn-sm" id="s-use-public" style="margin-bottom:12px">Use LineRight Regbot — ${esc(siteHost)}</button>` : ''}
        ${name}${signedIn}</div>`;
    }
    const choice = `
      ${s.siteUrl ? `<div class="check"><input type="radio" name="s-mode" id="s-mode-public" value="public" ${picked === 'public' ? 'checked' : ''}>
        <label for="s-mode-public"><span class="small"><b>LineRight Regbot</b> — ${esc(siteHost)}</span>
        <span class="field-help">The site that holds the line. Everybody bidding is there; this app pairs with your account on it, looks for openings for everyone, and books yours from this computer.</span></label></div>` : ''}
      <div class="check"><input type="radio" name="s-mode" id="s-mode-builtin" value="builtin" ${picked === 'builtin' ? 'checked' : ''} ${s.practiceAvailable || picked === 'builtin' ? '' : 'disabled'}>
        <label for="s-mode-builtin"><span class="small"><b>Practice on this computer</b> — a private copy of LineRight Regbot <span class="test-badge">Developer</span></span>
        <span class="field-help">The website, the queue processor, the DMV robots and a practice DMV run here, with simulated rivals and the test sites. Nothing you do there reaches anybody else, and nobody signs in.${s.practiceAvailable ? '' : ' It runs the LineRight Regbot server, which does not come with this app: it is offered when a checkout of it (lineright-server) is beside lineright-client, or <span class="num">LINERIGHT_SERVER_DIR</span> names one.'}</span></label></div>
      <div class="check"><input type="radio" name="s-mode" id="s-mode-remote" value="remote" ${picked === 'remote' ? 'checked' : ''}>
        <label for="s-mode-remote"><span class="small"><b>Another LineRight Regbot server</b> <span class="test-badge">Developer</span></span>
        <span class="field-help">A development server at an address. You sign in on its website with a code this app shows you.</span></label></div>
      ${s.forced ? '<p class="tiny muted" style="margin:6px 0 0">This run was told where to go when it started (<span class="num">--server</span> or <span class="num">--practice</span>). A choice made here is saved for the next one.</p>' : ''}
      <p class="tiny muted" style="margin:6px 0 0">Practice and other servers are here because developer mode is on (<b>View → Developer mode</b>).</p>`;
    if (mode !== 'builtin' || s.pendingRemote) {
      // Chosen here but not saved yet: the app is still where it was, whose own
      // address is no answer to "which other server".
      const pending = Boolean(s.pendingRemote);
      if (picked === 'public') {
        return `<div class="panel"><div class="panel-title">Server</div>${choice}${name}${signedIn}</div>`;
      }
      return `<div class="panel"><div class="panel-title">Server</div>${choice}
        <label class="field"><span class="field-label">Address</span><div class="row"><input id="s-server" value="${esc(pending ? (s.remoteUrl || '') : (s.serverUrl || s.remoteUrl || ''))}" placeholder="https://lineright.example" style="flex:1"><button class="btn" id="s-server-save">${pending ? 'Use this server' : 'Save'}</button></div>
        <span class="field-help">${pending
          ? 'You sign in on this one next. Your practice lines on this computer stay where they are, for when you switch back.'
          : 'Changing it signs this device out; sign in again on the new server.'}</span></label>
        ${name}
        ${pending ? '' : signedIn}
      </div>`;
    }
    const services = (st && st.services) || {};
    const live = s.dmvTarget === 'live';
    return `<div class="panel"><div class="panel-title">Server</div>${choice}
      <table class="data" style="margin:4px 0 12px"><tbody>
        ${['web', 'worker', 'standin', 'admin'].map((n) => serviceRow(n, services[n])).join('')}
      </tbody></table>
      <p class="small" style="margin:0 0 12px">${st && st.owner ? `You are <b>${esc(st.owner.nickname)}</b> on this server.` : ''}
        ${st && st.server ? `<span class="tiny muted">The lineright server from ${esc(st.server)}, on ${esc(st.python || '')}.</span>` : ''}</p>
      <div class="sep"></div>
      <h3 style="font-size:13px; margin:12px 0 8px">California DMV</h3>
      <div class="check"><input type="radio" name="s-dmv" id="s-dmv-standin" value="standin" ${live ? '' : 'checked'}>
        <label for="s-dmv-standin"><span class="small"><b>Practice</b> — the DMV stand-in on this computer</span>
        <span class="field-help">The robots look for slots and book on a local copy of the DMV's appointment site, and a hand-off opens its pages. Nothing reaches dmv.ca.gov.</span></label></div>
      <div class="check"><input type="radio" name="s-dmv" id="s-dmv-live" value="live" ${live ? 'checked' : ''}>
        <label for="s-dmv-live"><span class="small"><b>The real DMV</b> — dmv.ca.gov</span>
        <span class="field-help">The robots read the real appointment calendar from this computer every couple of minutes, for every bidder on the board — the simulated rivals too, unless you turn them off in the control room — and a hand-off opens the real booking page. A robot still books nothing unless the server's settings file says RQP_ALLOW_BOOKING=true.</span></label></div>
      <div class="sep"></div>
      <div class="row" style="flex-wrap:wrap; gap:8px; margin-top:12px">
        <button class="btn btn-sm" id="s-restart">Restart the server</button>
        <button class="btn btn-sm btn-ghost" id="s-logs">Logs</button>
        <button class="btn btn-sm btn-ghost" id="s-config">Settings file</button>
        <button class="btn btn-sm btn-ghost" id="s-data">Data folder</button>
      </div>
      <p class="tiny muted" style="margin:10px 0 0">${st ? `Data in ${esc(st.dataDir)}. The settings file (${esc(st.envFile)}) is read when the server starts.` : ''}</p>
    </div>`;
  }

  // This computer's robots, working for the regbot site: looking for openings
  // when the site asks, for everybody in line, and booking this person's slot.
  // On the real DMV neither happens until the person has said yes.
  function robotsPanel(s) {
    if (s.serverMode === 'builtin') return '';
    const r = s.robots || {};
    if (r.available === false) {
      return `<div class="panel"><div class="panel-title">This computer's robots</div>
        <p class="small muted" style="margin:0">This build carries no robots, so it neither looks for openings nor books by itself: when a slot is yours it opens the booking page for you.</p></div>`;
    }
    const last = r.last;
    const earning = state.doc && state.doc.allowance && state.doc.allowance.checking;
    const perHour = earning && earning.per_hour ? coins(earning.per_hour) : '';
    const mineToo = (o) => (o.to.also || []).find((a) => a.you);
    const lastLine = last ? `Last looked at ${esc(last.queue_name)}: ${last.recorded ? `${num(last.recorded)} opening${last.recorded === 1 ? '' : 's'}` : 'nothing new'}${(last.offers || []).filter((o) => o.to).map((o) => ` — ${esc(o.where)} ${o.to.you ? 'is yours' : `went to #${num(o.to.rank)}${mineToo(o) ? `, and to you ${Math.round(mineToo(o).after_ms / 1000)} s later` : ''}`}`).join('')}.` : '';
    const b = r.lastBooking;
    const came = b && ({
      booked: `booked it — confirmation ${esc(b.confirmation)}${b.unreported ? ' (the site did not record it)' : ''}`,
      gone: 'it was gone when the robot got there', elsewhere: `${esc(b.device)} booked it`,
      late: 'its time to book had run out', page: 'the robot could not finish, so it opened for you',
    })[b.kind];
    const bookedLine = b ? `Last booking: ${esc(b.where)} — ${came || esc(b.kind)}.` : '';
    const l = state.doc && state.doc.latency;
    const standing = !l || l.ms === null || l.ms === undefined ? 'not timed yet'
      : `${num(l.ms)} ms round trip to the site${l.slower_than !== null && l.slower_than !== undefined && l.n > 1 ? ` — slower than ${num(l.slower_than)}% of the ${num(l.n)} apps online` : ''}`;
    const connectionLine = `<p class="tiny ${l && l.dropped ? 'bad' : l && l.warn ? 'warn' : 'muted'}" style="margin:0 0 10px" id="s-connection">Connection: ${esc(standing)}.${l && (l.dropped || l.warn) ? ` ${l.dropped ? 'Too slow for slots to be offered to this app' : 'A slower app may lose a slot to a faster one'}: ${esc(l.why)}.` : ''}</p>`;
    return `<div class="panel"><div class="panel-title">This computer's robots</div>
      ${connectionLine}
      <div class="check"><input type="checkbox" id="s-reader" ${s.checking ? 'checked' : ''}>
        <label for="s-reader"><span class="small"><b>Check lines for everybody in line</b>${s.publicSite ? ' — on the real DMV (dmv.ca.gov)' : ''}${perHour ? ` · earns ${perHour} an hour` : ''}</span>
        <span class="field-help">Now and then the site asks this app to look at a line's offices and report what it sees, from this computer, with a browser the app runs out of sight. What it finds goes to whoever is first — which may be you.${s.publicSite ? ' On the real DMV it is automated traffic from your own internet address, a few pages at a time, so it waits for your yes.' : ''}${perHour ? ` The site adds ${perHour} to your credits for every hour this app is checking.` : ''}</span></label></div>
      <div class="check"><input type="checkbox" id="s-bookforme" ${s.robotBooking ? 'checked' : ''}>
        <label for="s-bookforme"><span class="small"><b>Let the app book for me</b>${s.publicSite ? ' — on the real DMV (dmv.ca.gov)' : ''}</span>
        <span class="field-help">Off until you say so: when a slot is yours, the booking page opens in a tab with your details filled in, and you book it. On, the app's robot books it with the details in your profile while that tab says what it is doing, then shows you the DMV's confirmation; if it cannot finish, the tab is yours to book in.${s.publicSite ? ' A booking it makes is a real appointment in your name.' : ''}</span></label></div>
      <p class="tiny muted" style="margin:8px 0 0" id="s-robots-now">${r.booking ? `Booking ${esc(r.booking.where)} now.` : r.reading ? `Looking at ${esc(r.reading.queue_name)} now — ${num(r.reading.offices)} office${r.reading.offices === 1 ? '' : 's'}.` : lastLine}</p>
      ${bookedLine && !r.booking ? `<p class="tiny muted" style="margin:4px 0 0">${bookedLine}</p>` : ''}
    </div>`;
  }

  // The browsers details were imported from, and the weekly offer to do it again.
  function againPanel(s) {
    const a = s.importAgain;
    if (!a) return '';
    const list = a.sources.map((src) => `<div class="between" style="padding:6px 0">
        <span class="small"><b>${esc(src.label)}</b> <span class="muted">— ${src.fields ? `${num(src.fields)} detail${src.fields === 1 ? '' : 's'}` : 'no details'}${src.sites || src.others ? ', sign-ins' : ''}; last ${esc(ago(src.at))}</span></span>
        <button class="btn btn-sm btn-ghost" data-forget="${esc(src.key)}">Forget</button></div>`).join('');
    return `<div class="panel"><div class="panel-title">Your browser</div>
      ${a.sources.length ? `${list}
        <div class="check" style="margin-top:8px"><input type="checkbox" id="s-again-remind" ${a.remind ? 'checked' : ''}>
          <label for="s-again-remind"><span class="small"><b>Ask ${a.every_days === 7 ? 'every week' : a.every_days ? `every ${num(a.every_days)} days` : 'from time to time'} to bring them across again</b>${a.every_days === 0 ? ' <span class="muted">— the site has turned the asking off for now</span>' : ''}</span>
          <span class="field-help">One click takes the same things from the same browsers: the details you took, and the sign-ins you chose. Anything you changed in your profile by hand is kept.</span></label></div>
        <button class="btn btn-sm" id="s-again-now" style="margin-top:8px">Re-import now</button>`
    : '<p class="small muted" style="margin:0">Nothing has been imported from a browser yet — <b>File → Import from your browser</b> does it, and the app then offers to bring it across again every week.</p>'}
    </div>`;
  }

  // What the app keeps of what it did, and for how long (logbook.js, pagelog.js).
  function logsPanel(s) {
    const l = s.logs;
    if (!l) return '';
    const size = l.bytes === null || l.bytes === undefined ? ''
      : ` They take ${l.bytes < 1048576 ? `${Math.max(1, Math.round(l.bytes / 1024))} KB` : `${Math.round(l.bytes / 1048576)} MB`} now.`;
    return `<div class="panel"><div class="panel-title">Logs</div>
      <p class="small" style="margin:0 0 10px">Everything the app does is written down on this computer, so that what happened on a booking site can be told exactly afterwards: each page in its tabs, what the page asked the site and what came back, what was clicked and filled in, a copy of the page after each step; what the robots did, with a trace of every step; and each exchange with the LineRight Regbot site. Nothing in them is sent anywhere.</p>
      <p class="tiny muted" style="margin:0 0 10px">Passwords, tokens, cookies and captcha answers are never written, nor licence or Social Security numbers or dates of birth; a name, email or phone you typed is kept as its length. Pages you booked on, copied, show what they showed you. Start over deletes the logs too.${size}</p>
      <div class="row" style="align-items:center; gap:8px; flex-wrap:wrap">
        <label class="small" for="s-logdays">Keep them for</label>
        <input id="s-logdays" type="number" min="1" max="30" step="1" value="${esc(String(l.keepDays))}" style="width:72px">
        <span class="small">days</span>
        <button class="btn btn-sm" id="s-logdays-save">Save</button>
        <button class="btn btn-sm" id="s-logs-open">Open the logs folder</button>
      </div>
      <p class="tiny muted" style="margin:8px 0 0">In <span class="num">${esc(l.dir)}</span></p></div>`;
  }

  // This app's telemetry: the Advanced screen, and whether it is shared.
  function advancedPanel(s) {
    const t = s.telemetry || {};
    const last = t.lastShare;
    return `<div class="panel"><div class="panel-title">Advanced</div>
      <p class="small" style="margin:0 0 10px">Telemetry and diagnostics: how this app's conversation with the site is going, the round trips the site timed, what the robots did, and the memory and CPU the app uses — plotted over the last day, kept on this computer.</p>
      <p class="tiny muted" style="margin:0 0 10px">${t.autoShare ? 'Shared with the site automatically every six hours.' : 'Shared with the site only when you press Share.'}${last ? ` Last shared ${esc(new Date(last.at * 1000).toLocaleString())}.` : ''}</p>
      <p class="tiny muted" style="margin:0 0 10px">${s.traces && s.traces.on ? 'A trace of what the app does, with your details taken out, goes to LineRight Regbot when the site asks.' : 'The trace for LineRight Regbot is off.'} Advanced shows it, and turns it ${s.traces && s.traces.on ? 'off' : 'on'}.</p>
      <button class="btn btn-sm" id="s-advanced">Open Advanced</button></div>`;
  }

  // Two steps, the second naming everything that goes: nothing about it can
  // be undone, and the server's credits and history are among it.
  function resetPanel(s) {
    if (!state.resetAsk) {
      return `<div class="panel"><div class="panel-title">Start over</div>
        <p class="small" style="margin:0 0 10px">Delete everything this app keeps on this computer and begin again, as on the day it was installed.</p>
        <button class="btn btn-sm btn-danger" id="s-reset">Reset everything…</button></div>`;
    }
    const busy = state.resetting ? 'disabled' : '';
    return `<div class="panel" id="s-reset-panel" style="border-color:#f0ccd5">
      <div class="panel-title">Start over</div>
      <p class="small" style="margin:0 0 6px"><b>This deletes from this computer, for good:</b></p>
      <ul class="small" style="margin:0 0 10px; padding-left:20px">
        ${dev() ? '<li>the practice server on this computer, if there is one, and everything on it: your account there, your lines, bids, practice credits and their history, its settings file and its logs</li>' : ''}
        <li>this app's telemetry — what the Advanced screen plots — and the trace kept for LineRight Regbot</li>
        <li>this app's logs — what it did on booking sites, and the copies of those pages</li>
        <li>your profile, every personal detail kept for booking forms</li>
        <li>sign-ins and anything else booking sites stored in this app's tabs</li>
        <li>these settings: ${dev() ? 'which server, which DMV the robots use, the update feed, developer mode, ' : ''}this device's name, and what you said about checking lines and booking</li>
        ${s.serverMode !== 'builtin' && s.paired ? `<li>this device's sign-in to <span class="num">${esc(s.serverUrl)}</span>, which signs it out there too; your account on that server stays as it is</li>` : ''}
      </ul>
      <p class="small muted" style="margin:0 0 12px">Your other browsers and the app itself are not touched. The app then starts again as it did the first time.</p>
      <div class="row"><button class="btn btn-sm" id="s-reset-cancel" ${busy}>Keep everything</button>
        <button class="btn btn-sm btn-danger" id="s-reset-go" ${busy}>${state.resetting ? 'Resetting…' : 'Delete everything and start over'}</button></div>
    </div>`;
  }

  function renderSettings(fresh) {
    const page = $('page');
    const s = state.settings;
    if (!s || fresh) {
      if (!s) page.innerHTML = '<div class="wrap"><div class="empty">Loading…</div></div>';
      api.call('settings:get').then((v) => { state.settings = v; state.stack = v.stack; if (state.route.page === 'settings') renderSettings(false); });
      if (!s) return;
    }
    const editing = document.activeElement && document.activeElement.closest('#settingsForm') && document.activeElement.tagName === 'INPUT' && ['text', 'number'].includes(document.activeElement.type);
    if (editing) return;
    s.stack = state.stack || s.stack;
    page.innerHTML = `<div class="wrap" style="max-width:760px">
      <h1 style="font-size:24px; margin-bottom:14px">Settings</h1>
      <div id="settingsForm" class="stack">
        ${serverPanel(s)}
        <div class="panel"><div class="panel-title">Updates</div>
          <p class="small" style="margin:0 0 10px"><span id="s-update-text">${esc(updateText(s.updates))}</span> <button class="btn btn-sm" id="s-check" ${s.updates && s.updates.phase === 'disabled' ? 'disabled' : ''} style="margin-left:8px">Check now</button></p>
          ${dev() ? `<label class="field"><span class="field-label">Update feed <span class="test-badge">Developer</span></span><div class="row"><input id="s-feed" value="${esc(s.updateUrl || '')}" placeholder="blank = the feed this build was published to (GitHub Releases)" style="flex:1"><button class="btn" id="s-feed-save">Save</button></div>
            <span class="field-help">Followed only in developer mode, from the next start.</span></label>` : ''}
        </div>
        ${robotsPanel(s)}
        ${againPanel(s)}
        ${logsPanel(s)}
        ${advancedPanel(s)}
        ${resetPanel(s)}
        <p class="tiny muted">LineRight Regbot ${esc(s.version)} · Electron ${esc(s.electron)} · ${esc(s.platform)}${s.packaged ? '' : ' · unpackaged'} · profile at ${esc(s.profileFile)}</p>
      </div>
    </div>`;
    const on = (id, fn) => { const el = $(id); if (el) el.addEventListener('click', fn); };
    const settle = (v) => { state.settings = v; state.stack = v.stack; state.sites = null; state.siteDocs = {}; state.account = null; state.board = null; renderSettings(false); };
    const guarded = (fn) => async () => { try { await fn(); } catch (err) { toast('bad', err.message, 9000); renderSettings(true); } };
    for (const r of page.querySelectorAll('input[name=s-mode]')) {
      r.addEventListener('change', guarded(async () => {
        if (r.value === 'builtin') { settle(await call('settings:set', { serverMode: 'builtin' })); toast('ok', 'Practising on this computer.'); }
        else if (r.value === 'public') { settle(await call('settings:set', { serverMode: 'public' })); toast('ok', 'Using the LineRight Regbot site. Create your account or sign in next.'); }
        else { state.settings = { ...s, serverMode: 'remote', serverChoice: 'remote', pendingRemote: true }; renderSettings(false); const box = $('s-server'); if (box) box.focus(); }
      }));
    }
    for (const r of page.querySelectorAll('input[name=s-dmv]')) {
      r.addEventListener('change', guarded(async () => {
        toast('ok', r.value === 'live' ? 'Pointing the robots at dmv.ca.gov…' : 'Pointing the robots at the stand-in…');
        await call('stack:dmv', { target: r.value });
        settle(await call('settings:get'));
      }));
    }
    for (const a of page.querySelectorAll('[data-open-service]')) {
      a.addEventListener('click', guarded(async () => {
        const which = a.dataset.openService;
        if (which === 'standin') await call('tabs:open', { url: state.stack.standin, kind: 'portal', title: 'DMV stand-in' });
        else await call('stack:open', { what: which === 'web' ? 'site' : 'admin' });
      }));
    }
    on('s-server-save', guarded(async () => { settle(await call('settings:set', { serverMode: 'remote', serverUrl: $('s-server').value })); toast('ok', 'Server saved. Sign in on it next.'); }));
    on('s-name-save', async () => { state.settings = await api.call('settings:set', { clientName: $('s-name').value }); toast('ok', 'Name saved — it shows on the next sign-in.'); renderSettings(false); });
    on('s-feed-save', guarded(async () => { settle(await call('settings:set', { updateUrl: $('s-feed').value })); toast('ok', 'Update feed saved — it is followed from the next start.'); }));
    on('s-use-public', guarded(async () => { settle(await call('settings:set', { serverMode: 'public' })); toast('ok', 'Using the LineRight Regbot site. Create your account or sign in next.'); }));
    on('s-check', () => api.call('update:check'));
    on('s-signout', () => api.call('pair:forget'));
    on('s-signin', () => go('signin'));
    on('s-advanced', () => go('advanced'));
    on('s-logs-open', guarded(() => call('logs:open')));
    on('s-logdays-save', guarded(async () => {
      const v = await call('settings:set', { logKeepDays: Number($('s-logdays').value) });
      settle(v);
      toast('ok', `Logs are kept for ${v.logs.keepDays} day${v.logs.keepDays === 1 ? '' : 's'}; anything older is gone.`);
    }));
    on('s-restart', guarded(async () => { toast('ok', 'Restarting the server on this computer…'); state.stack = await call('stack:restart'); renderSettings(true); }));
    on('s-logs', guarded(() => call('stack:open', { what: 'logs' })));
    on('s-config', guarded(() => call('stack:open', { what: 'config' })));
    on('s-data', guarded(() => call('stack:open', { what: 'data' })));
    const reading = $('s-reader');
    if (reading) {
      reading.addEventListener('change', guarded(async () => {
        if (reading.checked && s.publicSite && !s.realDmvChecks
          && !window.confirm('Let this app check lines for everybody on dmv.ca.gov, from this computer? It is automated traffic from your internet address, a few pages at a time.')) {
          reading.checked = false;
          return;
        }
        settle(await call('settings:set', { checking: reading.checked }));
      }));
    }
    const bookForMe = $('s-bookforme');
    if (bookForMe) {
      bookForMe.addEventListener('change', guarded(async () => {
        const where = state.settings && state.settings.publicSite ? ' on dmv.ca.gov' : '';
        if (bookForMe.checked && !window.confirm(`Let this app book appointments for you${where}, from this computer, with the details in your profile?`)) {
          bookForMe.checked = false;
          return;
        }
        settle(await call('settings:set', { robotBooking: bookForMe.checked }));
      }));
    }
    const remind = $('s-again-remind');
    if (remind) remind.addEventListener('change', guarded(async () => { settle(await call('settings:set', { reimportRemind: remind.checked })); }));
    on('s-again-now', () => openAgain(true));
    for (const b of page.querySelectorAll('[data-forget]')) {
      b.addEventListener('click', guarded(async () => {
        await call('import:forget', { key: b.dataset.forget });
        settle(await call('settings:get'));
      }));
    }
    on('s-reset', () => {
      state.resetAsk = true;
      renderSettings(false);
      const panel = $('s-reset-panel');
      if (panel) panel.scrollIntoView({ block: 'nearest' });
    });
    on('s-reset-cancel', () => { state.resetAsk = false; renderSettings(false); });
    on('s-reset-go', async () => {
      state.resetting = true;
      renderSettings(false);
      try {
        // Done, the app reloads this page with everything fresh.
        await call('app:reset', { confirm: true });
      } catch (err) {
        state.resetting = false;
        state.resetAsk = false;
        toast('bad', err.message, 12000);
        renderSettings(true);
      }
    });
  }

  // ----------------------------------------------------------------- help
  function renderHelp() {
    $('page').innerHTML = `<div class="wrap"><div class="help">
      <h1>LineRight Regbot help</h1>
      <p>LineRight Regbot keeps an open, orderly line for appointments that are hard to get. You stake credits on a position in a line; the highest stake sits at the top; when an appointment turns up it goes to the best-placed person who will take it. This app is how you join, follow and book from your desk.</p>
      <h2>Credits</h2>
      <p>Credits are what a place in a line is staked with, and your balance is kept on the LineRight Regbot site — the app shows it beside your name and brings it up to date on every sync. You do not have to buy any: a new account starts with enough for a place in a line, every week the site tops you back up to that many to spend (credits staked on your places do not count, so the longer you wait, the more you can stake), and while this app checks lines for everybody it earns you more, every hour — <b>+ Credits</b> in the top bar shows how much, and when the next top-up is. Buying more is a way to move up faster: <b>+ Credits</b> (or <b>File → Buy credits</b>) shows what is on sale; buying opens the payment page in your own browser, where your card is typed — never in this app — and the credits appear as soon as the payment is confirmed. A bid holds its credits while you wait and gives them back in full if you leave the line or the booking does not happen; they are spent only when an appointment is booked for you. A bid your credits do not cover is refused, and the app offers to buy the difference.</p>
      <h2>Asking for a line</h2>
      <p>Need a booking system LineRight Regbot does not cover yet — another DMV, a consulate, a clinic — or another kind of appointment on a site that is here? <b>Help → Ask for a site or a line</b> (or <b>Not here?</b> under the sites) asks the people running LineRight Regbot for it: the site's address, what it is called, which appointments and where. Everybody who asks for the same one is counted together, and once the people running LineRight Regbot have read a request, it is listed there for anybody to add themselves to with <b>Me too</b>. When they answer, the app tells you, and the answer shows on that screen. If you run the booking system, say so in the form.</p>
      <h2>Logs</h2>
      <p>Everything the app does is written down on this computer, so what happened on a booking site can be told exactly afterwards: each page in its tabs — what it asked the site and what came back, what was clicked and filled in, a copy of the page after each step — what the robots did, with a trace of every step, and each exchange with the LineRight Regbot site. <b>Help → Open the logs folder</b> shows them. They are kept three days unless <b>Settings → Logs</b> says otherwise, and nothing in them is sent anywhere. Passwords, tokens, cookies, captcha answers, licence and Social Security numbers and dates of birth are never written; a name, email or phone you type is kept as its length.</p>
      <h2>Advanced: telemetry and diagnostics</h2>
      <p><b>Help → Advanced</b> (or <b>Settings → Advanced</b>) plots how this app is doing over the last day: its syncs with the site and how long they take, the round trips the site timed, what its robots did, and the memory and CPU it uses, with a log of what happened. It is kept on this computer. <b>Share now</b> sends those numbers to the LineRight Regbot site — numbers and a short list of words, never anything from your profile — and shows exactly what would go first; sharing can also be turned on every six hours.</p>
      <p>Besides those numbers the app keeps a <b>trace</b> of what it does — the booking pages it opens, each request they make and how long it takes, what its robots saw, how each of your turns went and what it told you — with you taken out of it first: your name, date of birth, licence, passport and Social Security numbers, address, phone and email, wherever and however they appear, any confirmation number, and anything you type into a form. Pages you open on other sites are kept as the site's name alone. The LineRight Regbot site asks for the trace now and then — the app never sends it of its own accord — so the people running it can see why a booking did or did not work. Advanced shows the last of it as it would go, and turns it off; off, nothing more is written down and what was kept is deleted.</p>
      <h2>Your account and the LineRight Regbot site</h2>
      <p>The line itself — who is waiting, in what order, and what a place is worth — is kept on the LineRight Regbot website, and your account is there. The first time the app opens it asks you to create that account, or sign in if you have one: it opens the website in your usual browser on a page showing this app's code, you create the account (or sign in, with a password or with Google when the site offers it) and approve the code, and the app is signed in within a few seconds. It never sees your password. <b>File → Sign out</b> revokes this device; your positions keep their rank. Other devices of yours are listed under <b>Console → Account</b>, where any of them can be unpaired.</p>
      <h2>This app looks, and books, for you</h2>
      <p>While it is open the app checks lines for everybody in line: now and then the site asks it to look at a line's offices for openings, and the app's robot does, from this computer, and reports what it saw — and the site adds credits to your account for every hour of it. On the real DMV that is automated traffic from your own internet address, so the app asks once before it starts (<b>Check lines and earn credits</b>), and <b>Settings</b> turns it off again. The site decides who is first — finding a slot gives nobody a claim on it — and tells that person's app. When it is you, the booking page opens in a tab, and you book it there before the clock runs out. Once you have said it may, in <b>Settings</b> (a separate yes from checking lines), your app's robot books it for you instead, with the details in your profile, on this computer; if the booking site asks for a human check, or anything else stops the robot, the tab is yours to finish in.</p>
      ${dev() ? `<h2>Developer mode</h2>
      <p>Developer mode is for the people who work on LineRight Regbot, and it is on: <b>View → Developer mode</b> turns it off (or on again), and <span class="num">--developer</span> on the command line turns it on for one run. It adds:</p>
      <ul>
        <li><b>Test sites.</b> A development or practice server lists made-up sites beside the real ones, for demos and tests. They are listed here only in developer mode, each marked <span class="test-badge">Test site</span>, and nothing booked on them is real.</li>
        <li><b>Practice on this computer</b> (<b>Settings → Server</b>): a private copy of LineRight Regbot inside the app — the website, the queue processor, the DMV robots and a stand-in DMV, with simulated rival bidders — run from a checkout of the server (lineright-server) beside this app's. Nobody signs in. <b>Settings → Server</b> shows each part running, restarts them and opens their logs, and <b>View → Control room</b> opens its operator's panel. Developer mode stays on while the app practises.</li>
        <li><b>Another LineRight Regbot server</b> (<b>Settings → Server</b>), at an address, such as a development one; and an <b>update feed</b> of the app's own (<b>Settings → Updates</b>).</li>
        <li>Chromium's developer tools, in the <b>View</b> menu.</li>
      </ul>` : ''}
      <h2>Sites and lines</h2>
      <p><b>Sites</b> lists the booking systems LineRight Regbot keeps lines for; search by name or line. A site has one or more <em>lines</em> — one per appointment type — and each line is a live order book. Open a line to see who is ahead of you and to join it: your bid, the date and time you would like, and for some sites which office (or how far you will travel). Raise from the same panel; withdraw and the whole escrow comes back.</p>
      <h2>Your turn</h2>
      <p>When the board hands you a slot, a bar appears at the top with a countdown, your desktop gets a notification, and the booking page opens in a tab. Book it there; the app notices the DMV's confirmation, or click <b>I booked it</b> (a reference is optional), and the processor captures your escrow. If you let the app book for you (<b>Settings</b>), its robot books it in that tab, says so, and opens the confirmation in a second tab. Click <b>Pass</b> and it goes to the next bidder; you keep your place. Let the clock run out and you leave the line with part of your bid back; the bar says how much.</p>
      <h2>Found a slot yourself?</h2>
      <p><b>⌕ Found a slot</b> reports it to the board. If it is yours, the board hands it to you within moments; if somebody above you will take it, it is passed to them and you are told who — that is how everyone's place is respected.</p>
      <h2>Your profile</h2>
      <p><b>File → Profile</b> holds what booking forms ask for: name, date of birth, licence number, Social Security number, contact and address. It stays on this machine, encrypted by the operating system where a keychain exists, and is typed into the booking form when the app opens one. <b>✎ Fill form</b> in the browser bar does it on request. Nothing in the profile is ever sent to LineRight Regbot.</p>
      <h2>Importing from a browser</h2>
      <p><b>File → Import from your browser</b> looks for Chrome, Edge, Brave, Vivaldi, Opera, Arc, Comet and any other Chromium browser on this machine, and offers what they hold that this app can use: the name, email, phone and address you have saved for filling forms in, and the sign-ins you already have, so your turn does not start at a login page. Each booking site LineRight Regbot knows is listed and counted on its own; everything else you are signed in to is one line with a number on it, for the portals that hand you to an identity provider and leave half the sign-in on a host LineRight Regbot has never heard of. Both start ticked; untick either, and what you leave unticked is never copied. Passwords, payment cards, history and bookmarks are never touched.</p>
      <p>It is the quickest way to be ready to bid, so the app opens it on startup while your profile is still empty and there is a browser to take it from — once you have imported, filled the profile in, or said <em>skip for now</em>, it stays in the File menu and startup goes straight to your lines.</p>
      <p>Your browser goes on keeping things current — a new phone number, a sign-in renewed — so a week after an import the app asks to bring them across again: one button, <b>Re-import data from your browser</b>, takes the same things from the same browsers — the details you took, and the sign-ins you chose. A detail you have changed in your profile by hand is yours and is left alone, and a sign-in this app already holds fresher is kept. <b>Not now</b> asks again the next day; <b>File → Re-import data</b> does it whenever you like, and <b>Settings → Your browser</b> stops the asking or forgets a browser.</p>
      <h2>The browser</h2>
      <p>A booking site opens as a tab with an address bar, back and forward — a browser, because signing in to a DMV needs one. <b>◉ LineRight Regbot</b> in the tab strip (or <kbd>Ctrl</kbd>+<kbd>0</kbd>) brings the application back; the tab stays open.</p>
      <h2>Keys</h2>
      <table class="data"><tbody>
        <tr><td><kbd>Ctrl</kbd>+<kbd>1</kbd></td><td>Sites</td></tr>
        <tr><td><kbd>Ctrl</kbd>+<kbd>2</kbd></td><td>Console</td></tr>
        <tr><td><kbd>Ctrl</kbd>+<kbd>0</kbd></td><td>Back to the application from a tab</td></tr>
        <tr><td><kbd>Ctrl</kbd>+<kbd>L</kbd></td><td>Sign in</td></tr>
        <tr><td><kbd>Ctrl</kbd>+<kbd>P</kbd></td><td>Profile</td></tr>
        <tr><td><kbd>Ctrl</kbd>+<kbd>R</kbd></td><td>Sync now</td></tr>
        <tr><td><kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>F</kbd></td><td>Fill the form on this page from your profile</td></tr>
        <tr><td><kbd>F1</kbd></td><td>This page</td></tr>
      </tbody></table>
      <h2>Updates</h2>
      <p>An installed copy checks for updates after launch and every six hours, downloads in the background, and offers <b>restart</b> in the top bar when one is ready. <b>Help → Check for updates</b> looks now.</p>
    </div></div>`;
  }

  // --------------------------------------------------------------- wiring
  $('apptab').addEventListener('click', () => api.call('tabs:home'));
  $('newtab').addEventListener('click', () => { const url = window.prompt('Address to open'); if (url) api.call('tabs:open', { url }); });
  $('back').addEventListener('click', () => api.call('tabs:back'));
  $('forward').addEventListener('click', () => api.call('tabs:forward'));
  $('reload').addEventListener('click', () => api.call('tabs:reload'));
  $('home').addEventListener('click', () => api.call('tabs:home'));
  $('fill').addEventListener('click', () => api.call('profile:fill'));
  $('found').addEventListener('click', openFound);
  $('found2').addEventListener('click', openFound);
  $('gear').addEventListener('click', () => go('settings'));
  $('buy').addEventListener('click', () => go('credits'));
  $('devmode').addEventListener('click', () => go('help'));
  for (const b of document.querySelectorAll('#topnav button')) b.addEventListener('click', () => go(b.dataset.page));
  const address = $('address');
  address.addEventListener('focus', () => address.select());
  address.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { api.call('tabs:navigate', { url: address.value }); address.blur(); }
    if (e.key === 'Escape') { address.blur(); renderTabs(); }
  });

  api.on('shell:state', (shell) => { const was = state.shell.mode; state.shell = shell; applyMode(); renderBanner(was !== shell.mode && shell.mode === 'app'); renderAgain(); });
  api.on('import:due', (view) => {
    if (state.again && (state.again.busy || state.again.result)) return;
    state.again = { ...view };
    renderAgain();
  });
  api.on('sync:doc', (doc) => {
    const wasPaired = Boolean(state.doc);
    const before = state.doc;
    state.doc = doc; state.docAt = Date.now();
    creditsLive(before, doc);
    endedTurns(before, doc);
    renderWho(); renderBanner(false); renderAgain();
    if (state.form && !doc) { state.form = null; renderFound(); }
    if (state.route.page === 'console' && doc) renderConsole();
    if (state.route.page === 'sites' && !wasPaired && doc) renderSites();
  });
  api.on('sync:status', (status) => { state.status = status; renderStatus(); });
  api.on('pair:state', (pair) => {
    const was = paired();
    state.pair = pair;
    renderWho();
    if (state.route.page === 'signin') renderSignin();
    if (was && !pair.paired) { state.account = null; state.board = null; state.siteDocs = {}; if (['console'].includes(state.route.page)) go('signin'); }
    if (!was && pair.paired) { state.siteDocs = {}; state.board = null; if (state.route.page === 'board' || state.route.page === 'site') render(); }
  });
  api.on('update:state', (u) => { state.update = u; renderUpdate(); });
  api.on('robots:state', (r) => {
    const asking = Boolean($('earn-ask'));
    state.robots = r;
    if (state.route.page === 'sites' && asking !== Boolean(checkingAsk())) renderSites();
    renderStatus();
    renderBanner(false);
    if (state.route.page === 'settings' && state.settings) { state.settings.robots = { ...(state.settings.robots || {}), ...r }; renderSettings(false); }
  });
  api.on('stack:state', (st) => {
    state.stack = st;
    renderStatus();
    if (state.route.page === 'settings' && state.settings) renderSettings(false);
  });
  // View → Developer mode, switched: the sites are listed again with or without
  // the test ones, and a test site's page is not one to stay on.
  api.on('developer:state', (d) => {
    const onTest = (state.route.page === 'site' && state.siteDocs[state.route.slug] && state.siteDocs[state.route.slug].site.mock)
      || (state.route.page === 'board' && state.board && state.board.queue.mock);
    if (state.settings) state.settings.developer = d;
    state.sites = null; state.siteDocs = {}; state.board = null;
    renderDev();
    if (onTest && !d.on) go('sites');
    else render();
  });
  api.on('toast', (t) => toast(t.kind || 'ok', t.text, t.ms));
  api.on('app:navigate', ({ page, params }) => go(page, params || {}));
  api.on('autofill:done', () => {});

  setInterval(() => { tickClocks(); renderStatus(); tickBoard(); }, 1000);

  // Boot: the import screen while it is still worth offering — a profile is
  // what the app fills a booking form from, and the browser on this machine
  // already has most of it. Then the sign-in screen when nobody is signed in,
  // and the sites otherwise.
  api.call('pair:state').then(async (pair) => {
    state.pair = pair || state.pair;
    renderWho();
    const offer = await api.call('import:offer');
    if (offer && offer.show) { go('import', { first: true }); return; }
    go(paired() ? 'sites' : 'signin');
    // A week since the last import: ask, once the first screen is up.
    const again = await api.call('import:again-state');
    if (again && again.due) { state.again = again; renderAgain(); }
  });
  api.call('settings:get').then((s) => {
    state.settings = s; state.stack = s.stack; renderStatus(); renderDev();
    // The help and the sign-in screen say more in developer mode.
    if (s.developer && s.developer.on && ['help', 'signin'].includes(state.route.page)) render();
  });
  api.call('profile:get').then((p) => { state.profile = p; });
  api.call('robots:status').then((r) => { state.robots = r; renderStatus(); });
  applyMode(); renderUpdate();
})();
