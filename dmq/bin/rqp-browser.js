#!/usr/bin/env node
/**
 * A browser for the app's AI to work, with no robot's script in it.
 *
 * The other robots here know one site's pages (bot.js). This one knows none:
 * it opens a page and hands it, at once, to whoever runs it over the control
 * channel (control.js) — the desktop app's AI, given a site described in plain
 * words and a task on it (desktop/src/agent/sitetask.js). It is how a site no
 * robot has been written for can be checked, or booked, by the AI alone.
 *
 * Reads one `browse.request` envelope on stdin:
 *   { protocol: 'RQP/1', kind: 'browse.request', start_url, budget_ms }
 * and writes one `browse.result` on stdout: what the overseer said it came to.
 * The page never leaves the site it was opened on (control.js `goto`).
 * Without a control channel there is nobody to work it, and it says so.
 */
import { chromium } from 'playwright';
import { controlChannel } from '../src/control.js';

for (const stream of [process.stdout, process.stderr]) stream.on('error', () => {});

function readStdin() {
  return new Promise((resolve, reject) => {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { buf += c; });
    process.stdin.on('end', () => resolve(buf));
    process.stdin.on('error', reject);
  });
}

const answer = (fields) => process.stdout.write(`${JSON.stringify({ protocol: 'RQP/1', kind: 'browse.result',
  at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'), ...fields })}\n`);

async function main() {
  let request;
  try {
    request = JSON.parse(await readStdin());
  } catch (error) {
    answer({ status: 'rejected', message: `Malformed request JSON: ${error.message}` });
    return;
  }
  let start;
  try {
    start = new URL(String(request.start_url || ''));
    if (!/^https?:$/.test(start.protocol)) throw new Error('not a web address');
  } catch (error) {
    answer({ status: 'rejected', message: `No page to open: ${error.message}` });
    return;
  }
  const control = controlChannel();
  if (!control) {
    answer({ status: 'rejected', message: 'Nobody to work the browser: it runs only under the desktop app.' });
    return;
  }
  const budget = Math.max(10000, Math.min(15 * 60000, Number(request.budget_ms) || 300000));
  const browser = await chromium.launch({ headless: process.env.HEADLESS !== 'false' });
  const killer = setTimeout(() => process.exit(1), budget + 30000);
  try {
    const page = await browser.newPage();
    control.event('step', { tag: 'OPEN', detail: start.origin + start.pathname });
    await page.goto(start.toString(), { waitUntil: 'domcontentloaded', timeout: 45000 }).catch((error) => {
      control.event('step', { tag: 'OPEN_FAILED', detail: error.message.split('\n')[0] });
    });
    control.event('ready', { url: page.url() });
    const outcome = await control.serve(page, { deadline: Date.now() + budget, base: start.origin });
    answer({ status: outcome.status === 'timeout' ? 'unavailable' : 'confirmed', outcome, url: page.url() });
  } finally {
    clearTimeout(killer);
    control.close();
    await browser.close().catch(() => {});
  }
}

main().then(() => process.exit(0)).catch((error) => {
  answer({ status: 'unavailable', message: `The browser failed: ${error.message}` });
  process.exit(0);
});
