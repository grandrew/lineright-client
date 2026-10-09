'use strict';
/**
 * The pictures the booking robot keeps of the DMV's confirmation pages
 * (booker.js `shotsDir`, dmq's RQP_CONFIRMATION_SHOT), and the page the app
 * shows one in when the confirmation itself does not open by its address — on
 * the real DMV it is the end of a session, not a page of its own.
 */
const fs = require('node:fs');
const path = require('node:path');

const esc = (v) => String(v == null ? '' : v)
  .replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * Write a page beside the picture saying what it is: the number, the
 * appointment, when the robot saw it, and the DMV's own address for it when
 * there is one. Returns the page's file, or null when there is no picture.
 */
function page({ shot, url = null, confirmation, where = '' }) {
  if (!shot || !fs.existsSync(shot)) return null;
  const when = fs.statSync(shot).mtime.toLocaleString();
  const live = url && /^https?:\/\//i.test(url) ? ` — <a href="${esc(url)}">open it on the DMV's site</a>` : '';
  const file = `${shot.replace(/\.png$/i, '')}.html`;
  fs.writeFileSync(file, `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Confirmation ${esc(confirmation)}</title>
<style>body{margin:0;background:#f4f6fb;color:#0b1020;font:15px/1.5 system-ui,sans-serif}header{padding:18px 24px;background:#fff;border-bottom:1px solid #e2e8f0}
h1{margin:0 0 4px;font-size:20px;color:#047857}.ref{font:700 22px/1.3 ui-monospace,monospace}.muted{color:#64748b}main{padding:18px 24px}
img{max-width:100%;border:1px solid #cbd5e1;border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.08)}</style></head><body>
<header><h1>✓ Booked — your DMV confirmation</h1><div class="ref">${esc(confirmation)}</div><div>${esc(where)}</div>
<div class="muted">The DMV's confirmation page as this computer's robot saw it, ${esc(when)}${live}.</div></header>
<main><img src="${esc(encodeURIComponent(path.basename(shot)))}" alt="The DMV's confirmation page"></main></body></html>
`);
  return file;
}

/** Keep the newest `keep` files, pictures and pages alike. */
function prune(dir, keep = 40) {
  let files;
  try {
    files = fs.readdirSync(dir).map((name) => path.join(dir, name))
      .map((file) => ({ file, at: fs.statSync(file).mtimeMs }))
      .sort((a, b) => b.at - a.at);
  } catch {
    return 0;
  }
  for (const { file } of files.slice(keep)) fs.rmSync(file, { force: true });
  return Math.max(0, files.length - keep);
}

module.exports = { page, prune };
