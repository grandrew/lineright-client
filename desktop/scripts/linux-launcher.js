#!/usr/bin/env node
'use strict';
/**
 * Start on Linuxes that give Chromium no sandbox, instead of aborting.
 *
 * Chromium sandboxes its pages in a user namespace, or, where it cannot make
 * one, through its setuid helper chrome-sandbox. Ubuntu 24.04 and later let
 * only the programs AppArmor names make user namespaces, and an AppImage
 * cannot carry a setuid helper — its files are mounted nosuid — so run from
 * the file, the app had neither and died before running a line:
 *
 *     FATAL:setuid_sandbox_host.cc The SUID sandbox helper binary was found,
 *     but is not configured correctly. ... Trace/breakpoint trap
 *
 * The .deb the same, where its install script finds user namespaces working
 * for root and so leaves the helper unprivileged. electron-builder passes
 * --no-sandbox only from the menu entry it writes into the AppImage, which a
 * file run from a file manager or a terminal never reads.
 *
 * So the executable electron-builder names (regbot-desktop — what AppRun,
 * the .deb's /usr/bin link and its menu entry all start) becomes this
 * launcher, and Electron itself moves beside it as `regbot`. The launcher
 * keeps Chromium's sandbox wherever it can work, and adds --no-sandbox only
 * where it cannot: no user namespace for this user, and no setuid-root helper
 * outside an AppImage. It execs, so the app keeps the launcher's process id.
 *
 * Runs as electron-builder's afterPack hook, before any Linux target is made
 * from the packed directory. By hand, on a finished one:
 *
 *     node scripts/linux-launcher.js dist/linux-unpacked
 */
const fs = require('node:fs');
const path = require('node:path');

const ELECTRON = 'regbot';
const MARK = '# regbot linux launcher';

function launcher(electron = ELECTRON) {
  return `#!/bin/sh
${MARK}: starts ${electron}, beside it, with Chromium's sandbox wherever this
# system allows one. See scripts/linux-launcher.js in the desktop app's source.
here=$(dirname "$(readlink -f "$0")")

sandbox_works() {
  # The setuid helper, when root has made it so. Never inside an AppImage:
  # its files are mounted nosuid, whoever owns them.
  if [ -z "$APPIMAGE" ] && [ -u "$here/chrome-sandbox" ] &&
     [ "$(stat -c %u "$here/chrome-sandbox" 2>/dev/null)" = 0 ]; then
    return 0
  fi
  # A user namespace with this user's id mapped into it, which is what
  # Chromium tries first. Ubuntu's AppArmor refuses the mapping.
  unshare --user --map-root-user true >/dev/null 2>&1
}

if sandbox_works; then
  exec "$here/${electron}" "$@"
fi
exec "$here/${electron}" --no-sandbox "$@"
`;
}

/** Put the launcher in front of the packed Electron binary in `dir`. Idempotent. */
function install(dir, executableName, { log = console.log } = {}) {
  const exe = path.join(dir, executableName);
  const electron = path.join(dir, ELECTRON);
  if (executableName === ELECTRON) throw new Error(`the executable is already named ${ELECTRON}`);
  const head = fs.readFileSync(exe).subarray(0, 64).toString('latin1');
  if (head.startsWith('#!')) {
    if (!head.includes(MARK)) throw new Error(`${exe} is a script, but not this launcher`);
    if (!fs.existsSync(electron)) throw new Error(`${exe} is the launcher, but ${electron} is missing`);
  } else {
    if (!head.startsWith('\x7fELF')) throw new Error(`${exe} is neither Electron nor the launcher`);
    fs.renameSync(exe, electron);
  }
  fs.writeFileSync(exe, launcher(), { mode: 0o755 });
  fs.chmodSync(exe, 0o755);
  log(`${executableName} starts ${ELECTRON} through the sandbox check`);
}

async function afterPack(context) {
  if (context.electronPlatformName !== 'linux') return;
  install(context.appOutDir, context.packager.executableName, {
    log: (m) => console.log(`  • launcher  ${m}`),
  });
}

module.exports = afterPack;
module.exports.default = afterPack;
Object.assign(module.exports, { install, launcher, ELECTRON });

if (require.main === module) {
  const dir = process.argv[2];
  if (!dir) {
    console.error('usage: node scripts/linux-launcher.js <dist/linux-unpacked> [executable name]');
    process.exit(2);
  }
  try {
    install(path.resolve(dir), process.argv[3] || require('../package.json').name);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
