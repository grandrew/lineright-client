#!/usr/bin/env node
'use strict';
/**
 * Put the DMV robots and the browser they drive beside the app, so an
 * installer needs nothing else on the machine.
 *
 * The app runs the California DMV robots itself — looking for openings when
 * the site hands it a read, booking its person's own slot — and none of that
 * may assume anything is installed: no Node (the app's own binary runs them),
 * no Playwright download. So all of it ships in the installer, under the app's
 * resources:
 *
 *   resources/stack/dmq/       the robots (../dmq), with the Playwright they import
 *   resources/stack/host/      how the app starts them (host/)
 *   resources/browsers/        the headless Chromium the robots drive
 *
 * The first two are the same on every platform and are staged once into
 * vendor/stack. The browser differs by target and is fetched into
 * vendor/<os>-<arch>/ by the Playwright version package.json pins (and
 * bundle.lock.json names per target). electron-builder copies them in
 * (extraResources in electron-builder.yml) and runs this first for every
 * platform and CPU it packs (beforePack), so `npm run dist` needs nothing
 * else. By hand:
 *
 *     node scripts/bundle.js                     this machine's target
 *     node scripts/bundle.js win-x64 mac-arm64   others: every download is per-target, so any
 *                                                machine can fetch any target's
 *     node scripts/bundle.js --stack             only the platform-independent part
 *
 * The server practice mode runs, and the DMV stand-in it practises on, are
 * lineright-server's: not part of this app, and never bundled (see locate() in
 * src/stack.js).
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const REPO = path.resolve(ROOT, '..');
const LOCK = require('../bundle.lock.json');

const OS_NAMES = { linux: 'linux', darwin: 'mac', win32: 'win' };
// electron-builder's Arch enum, as handed to a beforePack hook.
const ARCH_NAMES = { 0: 'ia32', 1: 'x64', 2: 'armv7l', 3: 'arm64', 4: 'universal' };

function vendorDir() {
  return process.env.REGBOT_VENDOR_DIR || path.join(ROOT, 'vendor');
}

function hostTarget() {
  return `${OS_NAMES[process.platform] || process.platform}-${process.arch}`;
}

// ------------------------------------------------------------------ the stack
/** Copy a tree, leaving out whatever `skip(relativePath, dirent)` names. */
function copyTree(from, to, skip = () => false, rel = '') {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const here = rel ? `${rel}/${entry.name}` : entry.name;
    if (skip(here, entry)) continue;
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) copyTree(src, dst, skip, here);
    else if (entry.isFile()) fs.copyFileSync(src, dst);
  }
}

const NEVER = new Set(['__pycache__', '.pytest_cache', '.DS_Store', 'node_modules', '.venv', 'venv', '.git']);

/** What of ../dmq the robots need: the two RQP entry points, the bot, the catalogue. */
const DMQ_PARTS = ['bin', 'src', 'catalog'];

function stageStack(out, log) {
  const dmq = path.join(REPO, 'dmq');
  if (!fs.existsSync(dmq)) throw new Error(`${dmq} is missing: the app bundles the robots, so build from a full checkout`);
  fs.rmSync(out, { recursive: true, force: true });
  for (const part of DMQ_PARTS) copyTree(path.join(dmq, part), path.join(out, 'dmq', part), (rel, e) => NEVER.has(e.name));
  // The robots are ES modules; Node needs the package's "type" to load them.
  const pkg = JSON.parse(fs.readFileSync(path.join(dmq, 'package.json'), 'utf8'));
  fs.writeFileSync(path.join(out, 'dmq', 'package.json'), `${JSON.stringify({
    name: pkg.name, version: pkg.version, private: true, type: pkg.type,
    description: `${pkg.description} — the part the lineright desktop app runs`,
    dependencies: { playwright: require('playwright/package.json').version },
  }, null, 2)}\n`);
  // The Playwright the robots import is this package's, pinned in package.json
  // — the same version ../dmq locks, which test/bundle.test.js checks — so
  // the browser fetched below is the one it expects.
  for (const name of ['playwright', 'playwright-core']) {
    const from = path.dirname(require.resolve(`${name}/package.json`));
    copyTree(from, path.join(out, 'dmq', 'node_modules', name), (rel, e) => e.name === '.local-browsers');
  }
  copyTree(path.join(ROOT, 'host'), path.join(out, 'host'), (rel, e) => NEVER.has(e.name));
  log(`staged dmq (with playwright ${require('playwright/package.json').version}) and the host in ${out}`);
}

// ---------------------------------------------------------------- per target
function fetchBrowser(target, out, log) {
  const hostPlatform = LOCK.browser.hostPlatform[target];
  if (!hostPlatform) throw new Error(`no browser is pinned for ${target} (bundle.lock.json)`);
  const dir = path.join(out, 'browsers');
  fs.rmSync(dir, { recursive: true, force: true });
  // Only the browser. (Playwright adds its Windows DLL checker by itself when
  // it runs on Windows, and on no other build machine; pruneBrowser takes it
  // out again, so a Windows installer holds the same whichever machine built
  // it.)
  const args = [...LOCK.browser.install];
  const cli = path.join(path.dirname(require.resolve('playwright-core/package.json')), 'cli.js');
  log(`installing ${args.filter((a) => !a.startsWith('-')).join(' + ')} for ${hostPlatform}`);
  const r = spawnSync(process.execPath, [cli, 'install', ...args], {
    stdio: 'inherit',
    env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: dir, PLAYWRIGHT_HOST_PLATFORM_OVERRIDE: hostPlatform, PLAYWRIGHT_SKIP_BROWSER_GC: '1' },
  });
  if (r.status !== 0) throw new Error(`playwright install failed for ${target} (exit ${r.status})`);
  pruneBrowser(dir);
}

/**
 * What the robots' browser does not need. Bookkeeping for a shared cache,
 * which this is not (it names this build machine's paths); the video encoder
 * Playwright adds for recording, which the robots never do; the DLL checker it
 * adds on Windows, which the robots are told to skip
 * (PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS in src/stack.js); and the
 * translations of a user interface a headless browser does not have — a
 * quarter of its size. English stays: it is Chromium's fallback.
 */
function pruneBrowser(dir) {
  fs.rmSync(path.join(dir, '.links'), { recursive: true, force: true });
  for (const name of fs.readdirSync(dir)) {
    if (/^(ffmpeg|winldd)-/.test(name)) fs.rmSync(path.join(dir, name), { recursive: true, force: true });
  }
  const walk = (at, depth) => {
    for (const entry of fs.readdirSync(at, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const here = path.join(at, entry.name);
      if (entry.name === 'locales') {
        for (const pak of fs.readdirSync(here)) {
          if (/\.pak(\.info)?$/.test(pak) && !/^en-US\./.test(pak)) fs.rmSync(path.join(here, pak), { force: true });
        }
      } else if (depth < 3) walk(here, depth + 1);
    }
  };
  walk(dir, 0);
}

// Bumped whenever what this script does to a download changes (what it
// prunes, where it installs), so a vendor/ made the old way is made again.
const LAYOUT = 4;

/** What a target's directory was built from; unchanged means nothing to fetch. */
function stampFor(target) {
  return {
    layout: LAYOUT,
    target,
    browser: { playwright: require('playwright-core/package.json').version, install: LOCK.browser.install, hostPlatform: LOCK.browser.hostPlatform[target] },
  };
}

async function ensureTarget(target, { force = false, log = console.log } = {}) {
  const out = path.join(vendorDir(), target);
  const stampFile = path.join(out, 'bundle.json');
  const want = stampFor(target);
  let have = null;
  try { have = JSON.parse(fs.readFileSync(stampFile, 'utf8')); } catch { /* first build */ }
  const same = (key) => have && have.layout === want.layout && JSON.stringify(have[key]) === JSON.stringify(want[key]);
  fs.mkdirSync(out, { recursive: true });
  // A Python an older build fetched for the server is not needed any more.
  fs.rmSync(path.join(out, 'python'), { recursive: true, force: true });
  if (force || !same('browser') || !fs.existsSync(path.join(out, 'browsers'))) fetchBrowser(target, out, log);
  else log(`browser for ${target} is up to date`);
  fs.writeFileSync(stampFile, `${JSON.stringify(want, null, 2)}\n`);
  return out;
}

async function bundle(targets, { stack = true, force = false, log = console.log } = {}) {
  const vendor = vendorDir();
  if (stack) stageStack(path.join(vendor, 'stack'), log);
  const done = [];
  for (const target of targets) done.push(await ensureTarget(target, { force, log }));
  return done;
}

/**
 * electron-builder's beforePack hook: make sure vendor/ holds what this
 * platform and CPU need before extraResources copies it. The stack is staged
 * once per build, not once per architecture.
 */
let stagedThisBuild = false;
async function beforePack(context) {
  const target = `${OS_NAMES[context.electronPlatformName] || context.electronPlatformName}-${ARCH_NAMES[context.arch] || context.arch}`;
  const log = (m) => console.log(`  • bundle  ${m}`);
  await bundle([target], { stack: !stagedThisBuild, log });
  stagedThisBuild = true;
}

module.exports = beforePack;
module.exports.default = beforePack;
Object.assign(module.exports, { bundle, ensureTarget, stageStack, hostTarget, stampFor });

if (require.main === module) {
  const argv = process.argv.slice(2);
  const onlyStack = argv.includes('--stack');
  const force = argv.includes('--force');
  const targets = argv.filter((a) => !a.startsWith('--'));
  bundle(onlyStack ? [] : (targets.length ? targets : [hostTarget()]), { force })
    .then(() => console.log('bundle ready'))
    .catch((err) => { console.error(`bundle: ${err.message}`); process.exit(1); });
}
