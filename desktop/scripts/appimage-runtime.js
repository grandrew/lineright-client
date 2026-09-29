#!/usr/bin/env node
'use strict';
/**
 * Give the AppImage a runtime that runs on today's Linux.
 *
 * electron-builder 25 embeds the 2019 AppImage runtime, which needs libfuse2.
 * Ubuntu 22.04 and later, Fedora and most current desktops ship only FUSE 3,
 * so the file dies with "AppImages require FUSE to run" before the app ever
 * starts. The AppImage project's newer static runtime (type2-runtime) mounts
 * through FUSE 3 and needs nothing installed.
 *
 * An AppImage is three things in one file: the runtime (an ELF), a squashfs
 * image right after it, and — in electron-builder's case — a block map at the
 * tail that electron-updater reads for differential downloads, followed by
 * its four-byte big-endian length. This swaps the first part, keeps the
 * second, regenerates the third with electron-builder's own tool, and rewrites
 * latest-linux.yml so the size and digest the updater checks are the new ones.
 * Every step verifies the layout it expects and refuses rather than guesses.
 *
 * Runs as electron-builder's artifactBuildCompleted hook — the one that fires
 * before an artifact is uploaded and before its update info is recorded, so
 * the manifest electron-builder then writes (and publishes) describes the
 * swapped file. Not afterAllArtifactBuild: that fires after uploads are
 * scheduled and before latest-linux.yml exists, which is how a first attempt
 * published a manifest with the old digest. By hand, on a finished dist/:
 *
 *     node scripts/appimage-runtime.js dist/regbot-0.1.0-linux-x86_64.AppImage
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');

//: Pinned by release tag and digest. Update both together.
const RUNTIMES = {
  x64: {
    url: 'https://github.com/AppImage/type2-runtime/releases/download/20251108/runtime-x86_64',
    sha256: '2fca8b443c92510f1483a883f60061ad09b46b978b2631c807cd873a47ec260d',
  },
};
const SQUASHFS_MAGIC = 'hsqs';
const PAGE = 4096;

function archOf(file) {
  const name = path.basename(file);
  if (/x86_64|x64|amd64/.test(name)) return 'x64';
  if (/aarch64|arm64/.test(name)) return 'arm64';
  return null;
}

async function fetchRuntime(arch, log) {
  const pinned = RUNTIMES[arch];
  if (!pinned) throw new Error(`no static runtime pinned for ${arch}`);
  const dir = process.env.REGBOT_RUNTIME_CACHE || path.join(os.homedir(), '.cache', 'regbot-desktop');
  const file = path.join(dir, `appimage-runtime-${pinned.sha256.slice(0, 12)}-${arch}`);
  if (!fs.existsSync(file)) {
    log(`downloading AppImage runtime for ${arch} from ${pinned.url}`);
    const res = await fetch(pinned.url);
    if (!res.ok) throw new Error(`runtime download failed: ${res.status}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(`${file}.part`, Buffer.from(await res.arrayBuffer()));
    fs.renameSync(`${file}.part`, file);
  }
  const digest = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  if (digest !== pinned.sha256) {
    fs.unlinkSync(file);
    throw new Error(`runtime digest mismatch for ${arch}: ${digest} (expected ${pinned.sha256})`);
  }
  return file;
}

/** Where the runtime ends: the ELF's section header table is the last thing in it. */
function elfLength(fd) {
  const h = Buffer.alloc(64);
  fs.readSync(fd, h, 0, 64, 0);
  if (h.toString('latin1', 0, 4) !== '\x7fELF' || h[4] !== 2) throw new Error('not a 64-bit ELF');
  const shoff = Number(h.readBigUInt64LE(0x28));
  return shoff + h.readUInt16LE(0x3a) * h.readUInt16LE(0x3c);
}

function layout(file) {
  const size = fs.statSync(file).size;
  const fd = fs.openSync(file, 'r');
  try {
    const runtimeLen = elfLength(fd);
    const sb = Buffer.alloc(96);
    fs.readSync(fd, sb, 0, 96, runtimeLen);
    if (sb.toString('latin1', 0, 4) !== SQUASHFS_MAGIC) {
      throw new Error(`no squashfs at ${runtimeLen}; not a layout this script understands`);
    }
    const compression = sb.readUInt16LE(20);
    const bytesUsed = Number(sb.readBigUInt64LE(40));
    const squashEnd = runtimeLen + Math.ceil(bytesUsed / PAGE) * PAGE;
    if (squashEnd > size) throw new Error('squashfs runs past the end of the file');
    let blockMapSize = 0;
    if (size > squashEnd) {
      const tail = Buffer.alloc(4);
      fs.readSync(fd, tail, 0, 4, size - 4);
      blockMapSize = tail.readUInt32BE(0);
      if (squashEnd + blockMapSize + 4 !== size) {
        throw new Error(`unexpected ${size - squashEnd} bytes after the squashfs (block map says ${blockMapSize})`);
      }
    }
    return { size, runtimeLen, compression, bytesUsed, squashEnd, blockMapSize };
  } finally {
    fs.closeSync(fd);
  }
}

function copyRange(src, dst, start, end) {
  return new Promise((resolve, reject) => {
    fs.createReadStream(src, { start, end: end - 1 })
      .on('error', reject)
      .pipe(fs.createWriteStream(dst, { flags: 'a' }))
      .on('error', reject)
      .on('finish', resolve);
  });
}

function appBuilder(args) {
  const { appBuilderPath } = require('app-builder-bin');
  return new Promise((resolve, reject) => {
    execFile(appBuilderPath, args, { maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`app-builder ${args[0]} failed: ${stderr || err.message}`));
      resolve(JSON.parse(stdout));
    });
  });
}

/** Rewrite the digest, size and block map size of one file in latest-linux.yml. */
function rewriteManifest(ymlFile, name, info, log) {
  if (!fs.existsSync(ymlFile)) return false;
  const lines = fs.readFileSync(ymlFile, 'utf8').split('\n');
  let inOurs = false;
  let topLevelIsOurs = false;
  let touched = 0;
  const out = lines.map((line) => {
    const entry = /^\s+- url: (.+)$/.exec(line);
    if (entry) { inOurs = entry[1].trim() === name; return line; }
    const top = /^path: (.+)$/.exec(line);
    if (top) { topLevelIsOurs = top[1].trim() === name; inOurs = false; return line; }
    if (/^\S/.test(line) && !/^sha512:/.test(line)) inOurs = false;
    if (inOurs) {
      const m = /^(\s+)(sha512|size|blockMapSize): /.exec(line);
      if (m) { touched += 1; return `${m[1]}${m[2]}: ${info[m[2]]}`; }
    }
    if (topLevelIsOurs && /^sha512: /.test(line)) { touched += 1; return `sha512: ${info.sha512}`; }
    return line;
  });
  fs.writeFileSync(ymlFile, out.join('\n'));
  log(`${path.basename(ymlFile)}: ${touched} field(s) rewritten for ${name}`);
  return touched > 0;
}

async function retarget(file, { log = console.log, manifest = true } = {}) {
  const arch = archOf(file);
  if (!arch) { log(`${path.basename(file)}: cannot tell the architecture; left alone`); return null; }
  if (!RUNTIMES[arch]) { log(`${path.basename(file)}: no static runtime pinned for ${arch}; left alone`); return null; }
  const before = layout(file);
  const runtime = await fetchRuntime(arch, log);
  const runtimeLen = fs.statSync(runtime).size;
  if (before.runtimeLen === runtimeLen && fs.readFileSync(file).subarray(0, runtimeLen).equals(fs.readFileSync(runtime))) {
    log(`${path.basename(file)}: already carries the static runtime`);
    return null;
  }
  const tmp = `${file}.retarget`;
  fs.rmSync(tmp, { force: true });
  fs.copyFileSync(runtime, tmp);
  await copyRange(file, tmp, before.runtimeLen, before.squashEnd);
  fs.chmodSync(tmp, 0o755);
  // The same call electron-builder makes: appends the block map and its
  // length, and reports what latest-linux.yml has to say about the file.
  const info = await appBuilder(['blockmap', '--input', tmp, '--compression', 'deflate']);
  const after = layout(tmp);
  if (after.runtimeLen !== runtimeLen || after.bytesUsed !== before.bytesUsed || after.blockMapSize !== info.blockMapSize || after.size !== info.size) {
    fs.rmSync(tmp, { force: true });
    throw new Error('the rebuilt file does not have the layout it should; nothing replaced');
  }
  fs.renameSync(tmp, file);
  if (manifest) rewriteManifest(path.join(path.dirname(file), 'latest-linux.yml'), path.basename(file), info, log);
  log(`${path.basename(file)}: runtime ${before.runtimeLen} → ${runtimeLen} bytes (static, FUSE 3), ` +
      `squashfs ${before.bytesUsed} bytes (compression ${before.compression}), block map ${info.blockMapSize} bytes, size ${info.size}`);
  return info;
}

async function artifactBuildCompleted(event) {
  if (!event || typeof event.file !== 'string' || !event.file.endsWith('.AppImage')) return;
  // electron-builder writes latest-linux.yml from event.updateInfo later, so
  // the corrected numbers go there rather than into a file that does not exist yet.
  const info = await retarget(event.file, { manifest: false });
  if (info && event.updateInfo) {
    event.updateInfo = { ...event.updateInfo, sha512: info.sha512, size: info.size, blockMapSize: info.blockMapSize };
  }
}

module.exports = artifactBuildCompleted;
module.exports.retarget = retarget;
module.exports.layout = layout;
module.exports.rewriteManifest = rewriteManifest;
module.exports.RUNTIMES = RUNTIMES;

if (require.main === module) {
  const files = process.argv.slice(2);
  if (!files.length) {
    console.error('usage: node scripts/appimage-runtime.js <file.AppImage> [...]');
    process.exit(2);
  }
  Promise.all(files.map((f) => retarget(path.resolve(f)))).catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
