'use strict';
/**
 * Which addresses this app hands to the person's own browser.
 *
 * The site's answers name pages to open — the page to approve a sign-in on,
 * Stripe's page to pay on — and a site that is wrong, or not the site it
 * should be, could name anything: a file, a network share, another program's
 * link. So what the site names is checked here first. Plain functions, so they
 * run under `node --test`.
 */

const LOOPBACK = ['127.0.0.1', 'localhost', '[::1]'];

function parse(url) {
  try {
    return new URL(String(url || ''));
  } catch {
    return null;
  }
}

/** A web page, and nothing else. */
function webPage(url) {
  const at = parse(url);
  return Boolean(at && (at.protocol === 'http:' || at.protocol === 'https:'));
}

/**
 * A payment page, if it is one this app opens: Stripe's Checkout — or, for a
 * site on this very machine, a Stripe emulator on it too
 * (the server's payments/emulator.py). Returns the address, or null.
 */
function paymentPage(url, serverUrl) {
  const at = parse(url);
  const server = parse(serverUrl);
  if (!at || !server) return null;
  if (at.protocol === 'https:' && at.hostname === 'checkout.stripe.com') return at.href;
  const local = LOOPBACK.includes(server.hostname) && LOOPBACK.includes(at.hostname);
  return local && webPage(at.href) ? at.href : null;
}

/**
 * The page to approve a sign-in code on: on the site this app signs in to,
 * whatever else the answer says. Returns {verifyUrl, siteUrl}.
 */
function approvalPage({ verifyUrl, siteUrl, code } = {}, serverUrl) {
  const site = String(serverUrl || '').replace(/\/+$/, '');
  const home = parse(site);
  const same = (url) => { const at = parse(url); return Boolean(at && home && at.origin === home.origin); };
  return {
    verifyUrl: same(verifyUrl) ? verifyUrl : `${site}/pair?code=${encodeURIComponent(String(code || ''))}`,
    siteUrl: same(siteUrl) ? siteUrl : site,
  };
}

module.exports = { LOOPBACK, webPage, paymentPage, approvalPage };
