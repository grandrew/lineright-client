/* Keeping the app open: the app books a person's turn only while it runs, on a
   computer that is on, awake and online. Two ways of saying so, each with its
   own "no more": a notice over the app when it starts, until the person ticks
   "Understood, do not show this again"; and a bar along the top at every start,
   until they tick "Don't remind me again" and close it. Closed without the
   tick, the bar is back at the next start. Settings → Keeping the app running
   turns the bar back on (keepOpenRemind) and the computer's staying awake off
   (keepAwake, the main process's awake.js). */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.keepOpen = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  function view(settings) {
    const s = settings || {};
    const k = s.keepOpen || {};
    return {
      understood: Boolean(k.understood),
      remind: k.remind !== false,
      // Whether the app keeps the computer awake itself: then the person need
      // not change how their computer sleeps, only keep it on with the lid open.
      awake: !s.keepAwake || s.keepAwake.on !== false,
    };
  }

  /** The notice over the app at start: until the person says they understood. */
  function showNotice(settings) {
    return Boolean(settings) && !view(settings).understood;
  }

  /** The bar along the top: at every start, unless the person said no more, or closed it this run. */
  function showBar(settings, closedThisRun) {
    return Boolean(settings) && view(settings).remind && !closedThisRun;
  }

  function notice(settings) {
    const v = view(settings);
    return `<h2 id="keep-title">Keep this app open</h2>
      <p>The app can book your turn only while it is open and your computer is on and online.</p>
      <ul class="keep-list">
        <li>Don't close this window or quit the app.</li>
        <li>Don't shut down the computer or close the laptop lid.</li>
        <li>${v.awake ? 'Keep it plugged in. The app stops the computer from going to sleep.'
          : 'Keep it plugged in, and set it never to go to sleep.'}</li>
      </ul>
      <p class="small muted">If the app is not running when your turn comes, the turn is lost.</p>
      <div class="between" style="margin-top:16px">
        <label class="keep-never"><input type="checkbox" id="keep-never"> Understood, do not show this again</label>
        <button class="btn btn-accent" id="keep-ok">OK</button>
      </div>`;
  }

  function bar() {
    return `<span class="mark">☾</span>
      <span class="text"><b>Keep this app open</b> and your computer on and awake, or the app can't book your turn.</span>
      <span class="actions">
        <label class="keep-never tiny"><input type="checkbox" id="keepbar-never"> Don't remind me again</label>
        <button class="pill" id="keepbar-close" title="Close" aria-label="Close">×</button>
      </span>`;
  }

  return { view, showNotice, showBar, notice, bar };
});
