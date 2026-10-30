'use strict';
/**
 * The browser the build bundles for the robots (scripts/bundle.js), for the
 * tests that drive a real one: a build machine has that one, and none in
 * Playwright's own cache. Playwright is pointed at it unless told otherwise;
 * require this before Playwright, which reads where its browsers are as it loads.
 */
const fs = require('node:fs');
const path = require('node:path');

const OS = { linux: 'linux', darwin: 'mac', win32: 'win' }[process.platform] || process.platform;
const BUNDLED = path.join(__dirname, '..', '..', 'vendor', `${OS}-${process.arch}`, 'browsers');
if (!process.env.PLAYWRIGHT_BROWSERS_PATH && fs.existsSync(BUNDLED)) process.env.PLAYWRIGHT_BROWSERS_PATH = BUNDLED;

/** Where the robots' browsers are, for a RobotRunner's `paths.browsers`; null for Playwright's own cache. */
module.exports = { browsers: process.env.PLAYWRIGHT_BROWSERS_PATH || null };
