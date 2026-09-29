'use strict';
/**
 * What an installer carries beside the app (scripts/bundle.js): that every
 * platform electron-builder packs has a pinned Python and browser, that the
 * Playwright the robots are given is the one ../dmq was tested with, that a
 * wheel unpacks where it should and nowhere else, and that the staged server
 * has what it runs on and none of a developer's leftovers. Nothing here
 * downloads anything.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const bundle = require('../scripts/bundle');
const LOCK = require('../bundle.lock.json');

const ROOT = path.join(__dirname, '..');

const tmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

/** The platforms electron-builder.yml packs, as ${os}-${arch}. */
function packedTargets() {
  const yml = fs.readFileSync(path.join(ROOT, 'electron-builder.yml'), 'utf8');
  const targets = new Set();
  const section = (name) => (yml.split(new RegExp(`^${name}:\\s*$`, 'm'))[1] || '').split(/^\S/m)[0];
  const os = { win: 'win', mac: 'mac', linux: 'linux' };
  for (const key of Object.keys(os)) {
    const body = section(key);
    const arches = [...body.matchAll(/arch:\s*\[([^\]]+)\]/g)].flatMap((m) => m[1].split(',').map((a) => a.trim()));
    for (const arch of arches.length ? arches : ['x64']) targets.add(`${os[key]}-${arch}`);
  }
  return [...targets];
}

test('every platform an installer is built for has a browser pinned', () => {
  const targets = packedTargets();
  assert.ok(targets.includes('win-x64') && targets.includes('mac-arm64') && targets.includes('linux-x64'), targets.join(' '));
  for (const target of targets) assert.ok(LOCK.browser.hostPlatform[target], `no browser for ${target}`);
  assert.equal(LOCK.python, undefined, 'no Python: the server practice mode runs is not part of this app');
});

test('the robots are given the Playwright ../dmq locks, so the browser is the one they expect', () => {
  const desktop = require('../package.json').devDependencies.playwright;
  const lock = JSON.parse(fs.readFileSync(path.join(ROOT, '..', 'dmq', 'package-lock.json'), 'utf8'));
  const dmq = lock.packages['node_modules/playwright'].version;
  assert.equal(desktop, dmq, 'bump desktop/package.json and ../dmq together');
  assert.equal(require('playwright-core/package.json').version, dmq, 'npm ci has installed what package.json pins');
});

test('electron-builder copies the robots and the browser of the platform it packs, and no server', () => {
  const yml = fs.readFileSync(path.join(ROOT, 'electron-builder.yml'), 'utf8');
  for (const line of ['from: vendor/stack', 'from: vendor/${os}-${arch}/browsers', 'beforePack: scripts/bundle.js']) {
    assert.ok(yml.includes(line), line);
  }
  assert.ok(!yml.includes('/python'), 'no Python goes in an installer');
  assert.match(yml, /repo: lineright-client/, 'updates come from this repository\'s releases');
  assert.equal(typeof bundle, 'function', 'the hook is the module itself');
});

test("the staged stack is the robots and how they start, and none of the server", () => {
  const out = path.join(tmp('regbot-stage-'), 'stack');
  bundle.stageStack(out, () => {});
  const has = (p) => fs.existsSync(path.join(out, p));
  for (const p of ['dmq/bin/rqp-handler.js', 'dmq/bin/rqp-scout.js', 'dmq/src/bot.js', 'dmq/catalog/ca-dmv-offices.json',
    'dmq/node_modules/playwright/package.json', 'dmq/node_modules/playwright-core/lib', 'host/robot-preload.cjs']) {
    assert.ok(has(p), `${p} is staged`);
  }
  assert.deepEqual(fs.readdirSync(out).sort(), ['dmq', 'host'], 'no server');
  assert.deepEqual(fs.readdirSync(path.join(out, 'host')), ['robot-preload.cjs'], 'no Python host, no stand-in');
  assert.deepEqual(fs.readdirSync(path.join(out, 'dmq')).sort(), ['bin', 'catalog', 'node_modules', 'package.json', 'src'],
    'the robots and nothing else: no DMV stand-in, no tests');
  const pkg = JSON.parse(fs.readFileSync(path.join(out, 'dmq', 'package.json'), 'utf8'));
  assert.equal(pkg.type, 'module', 'the robots are ES modules');
  assert.deepEqual(Object.keys(pkg.dependencies), ['playwright'], 'no twilio, no dotenv: the RQP entry points need neither');
});

test('a target is fetched again when a pin, or what the script does with it, changes', () => {
  const a = bundle.stampFor('linux-x64');
  assert.deepEqual(bundle.stampFor('linux-x64'), a);
  assert.notDeepEqual(bundle.stampFor('win-x64'), a);
  assert.equal(typeof a.layout, 'number');
  assert.equal(a.python, undefined);
  assert.equal(a.browser.playwright, require('playwright-core/package.json').version);
});
