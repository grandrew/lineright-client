/**
 * The robots the stand-in stands in for: this repository's dmq/.
 *
 * The tests that drive the robots through the stand-in, or hold the stand-in
 * to the robots' own service map, load them from there (REGBOT_CADMV_DIR
 * points them at another copy). Without the robots' dependencies (npm ci in
 * dmq/), those tests skip and say why; the stand-in's own tests need nothing.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

export const DMQ = process.env.REGBOT_CADMV_DIR
  ? path.resolve(process.env.REGBOT_CADMV_DIR)
  : path.join(REPO, 'dmq');

/** Why the robots' code cannot be loaded, or false when it can. */
export const noRobots = fs.existsSync(path.join(DMQ, 'src', 'bot.js')) ? false
  : `no robots at ${DMQ} (REGBOT_CADMV_DIR)`;

/** Why the robots cannot run a browser, or false when they can (Playwright is theirs). */
export const noPlaywright = noRobots
  || (fs.existsSync(path.join(DMQ, 'node_modules', 'playwright')) ? false
    : `the robots' dependencies are not installed: npm ci in ${DMQ}`);

/** One of the robots' modules: `await robot('src/bot.js')`. */
export const robot = (file) => import(pathToFileURL(path.join(DMQ, file)).href);

/** A package as the robots resolve it — the Playwright they drive. */
export const robotPackage = (name) => createRequire(path.join(DMQ, 'package.json'))(name);
