'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { layout, rewriteManifest, RUNTIMES } = require('../scripts/appimage-runtime');

const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'regbot-appimage-'));

/** A file shaped like an AppImage: a tiny ELF, a squashfs superblock, a block map with its length. */
function fakeAppImage({ runtimeLen = 4096, bytesUsed = 10000, blockMap = 300, badTail = false } = {}) {
  const elf = Buffer.alloc(runtimeLen);
  elf.write('\x7fELF', 0, 'latin1');
  elf[4] = 2;                                   // 64-bit
  elf.writeBigUInt64LE(BigInt(runtimeLen - 3 * 64), 0x28);  // section headers at the end...
  elf.writeUInt16LE(64, 0x3a);                  // ...three of them, 64 bytes each
  elf.writeUInt16LE(3, 0x3c);
  const squashLen = Math.ceil(bytesUsed / 4096) * 4096;
  const squash = Buffer.alloc(squashLen);
  squash.write('hsqs', 0, 'latin1');
  squash.writeUInt16LE(1, 20);                  // gzip
  squash.writeBigUInt64LE(BigInt(bytesUsed), 40);
  const map = Buffer.alloc(blockMap, 7);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(badTail ? blockMap + 1 : blockMap, 0);
  const file = path.join(tmpdir(), 'app-x86_64.AppImage');
  fs.writeFileSync(file, Buffer.concat([elf, squash, map, len]));
  return { file, runtimeLen, squashLen, blockMap, bytesUsed };
}

test('layout finds the runtime, the squashfs and the block map', () => {
  const f = fakeAppImage();
  const l = layout(f.file);
  assert.equal(l.runtimeLen, f.runtimeLen);
  assert.equal(l.bytesUsed, f.bytesUsed);
  assert.equal(l.squashEnd, f.runtimeLen + f.squashLen);
  assert.equal(l.blockMapSize, f.blockMap);
  assert.equal(l.compression, 1);
  assert.equal(l.size, f.runtimeLen + f.squashLen + f.blockMap + 4);
});

test('a file without a block map is understood too', () => {
  const f = fakeAppImage({ blockMap: 0 });
  fs.truncateSync(f.file, f.runtimeLen + f.squashLen);
  assert.equal(layout(f.file).blockMapSize, 0);
});

test('a tail that is not exactly a block map is refused, not guessed at', () => {
  const f = fakeAppImage({ badTail: true });
  assert.throws(() => layout(f.file), /unexpected/);
});

test('something that is not an AppImage is refused', () => {
  const dir = tmpdir();
  const file = path.join(dir, 'x-x86_64.AppImage');
  fs.writeFileSync(file, Buffer.alloc(8192));
  assert.throws(() => layout(file), /not a 64-bit ELF/);
});

test('the manifest gets the new digest, size and block map size for the one file', () => {
  const dir = tmpdir();
  const yml = path.join(dir, 'latest-linux.yml');
  fs.writeFileSync(yml, [
    'version: 0.1.0', 'files:',
    '  - url: regbot-0.1.0-linux-x86_64.AppImage', '    sha512: OLD', '    size: 1', '    blockMapSize: 2',
    '  - url: other.AppImage', '    sha512: KEEP', '    size: 3', '    blockMapSize: 4',
    'path: regbot-0.1.0-linux-x86_64.AppImage', 'sha512: OLD', "releaseDate: '2026-09-21T00:00:00.000Z'", '',
  ].join('\n'));
  const ok = rewriteManifest(yml, 'regbot-0.1.0-linux-x86_64.AppImage', { sha512: 'NEW', size: 99, blockMapSize: 5 }, () => {});
  assert.equal(ok, true);
  const text = fs.readFileSync(yml, 'utf8');
  assert.match(text, /url: regbot-0.1.0-linux-x86_64.AppImage\n    sha512: NEW\n    size: 99\n    blockMapSize: 5\n/);
  assert.match(text, /url: other.AppImage\n    sha512: KEEP\n    size: 3\n    blockMapSize: 4\n/);
  assert.match(text, /\npath: regbot-0.1.0-linux-x86_64.AppImage\nsha512: NEW\n/);
  assert.match(text, /releaseDate: '2026-09-21T00:00:00.000Z'/);
});

test('the pinned runtime carries a digest to check against', () => {
  assert.match(RUNTIMES.x64.url, /^https:\/\/github.com\/AppImage\/type2-runtime\/releases\/download\/\d+\/runtime-x86_64$/);
  assert.match(RUNTIMES.x64.sha256, /^[0-9a-f]{64}$/);
});
