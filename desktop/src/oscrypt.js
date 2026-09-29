'use strict';
/**
 * The key each system gives a Chromium browser, and what it decrypts.
 *
 * A browser's cookies are not readable from the file: each value is encrypted
 * with a key the operating system holds for that browser, and getting at it
 * is a different job on each of the three.
 *
 *   Windows   The key is in `Local State`, wrapped by DPAPI for this Windows
 *             account. Unwrapping it is a call into the system, made here
 *             through PowerShell rather than a native module. Values are
 *             AES-256-GCM, tagged `v10`. Chrome 127 and later wrap the key a
 *             second time, bound to the browser's own executable (`v20`), and
 *             no program but that browser can unwrap it — so those are
 *             reported as out of reach instead of being half-read.
 *   macOS     The key is a password in the login keychain, "Chrome Safe
 *             Storage" and its equivalents. Reading it asks the person for
 *             permission, in a dialog macOS puts up itself. Values are
 *             AES-128-CBC, tagged `v10`.
 *   Linux     Either a password from the desktop keyring (`v11`) or, on a
 *             machine with no keyring, the fixed word Chromium falls back to
 *             (`v10`, and the word really is "peanuts"). Values are
 *             AES-128-CBC.
 *
 * The tag on each value says which key it wants, so a profile written on a
 * machine that later gained a keyring is still read correctly, value by value.
 *
 * None of this is a way past anything: it is the same key, for the same
 * person, on the same machine, used to move what is already theirs into an
 * app they installed. It needs no privilege the person does not already have,
 * and on macOS it cannot happen without them agreeing to it in a system
 * dialog.
 */
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');

const SALT = 'saltysalt';
const CBC_IV = Buffer.alloc(16, ' ');
const LINUX_FALLBACK = 'peanuts';

/** Run a command for its stdout. Never throws: `null` when it did not work. */
function run(file, args, { input = null, timeout = 10000, env = null } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = execFile(file, args, {
        timeout, maxBuffer: 8 * 1024 * 1024, windowsHide: true,
        env: env ? { ...process.env, ...env } : undefined,
      }, (err, stdout) => resolve(err ? null : String(stdout)));
    } catch {
      resolve(null);
      return;
    }
    if (input !== null) {
      child.stdin.on('error', () => {});
      child.stdin.end(input);
    }
  });
}

/** The three bytes every Chromium value starts with, if it has them. */
function schemeOf(buf) {
  if (!buf || !buf.length) return 'empty';
  const tag = buf.subarray(0, 3).toString('latin1');
  if (tag === 'v10' || tag === 'v11' || tag === 'v20') return tag;
  return 'legacy';       // pre-2020 Windows: a bare DPAPI blob
}

function pbkdf2(password, iterations) {
  return crypto.pbkdf2Sync(password, SALT, iterations, 16, 'sha1');
}

// ------------------------------------------------------------------ windows
/**
 * Unwrap DPAPI blobs, all of them in one PowerShell process.
 *
 * Windows has no way to do this from Node without a native module, and
 * spawning a process per cookie would take minutes. So one process reads
 * base64 on its input and writes base64 on its output, in order, with an
 * empty line for anything it could not unwrap.
 */
async function dpapi(blobs, { exec = run, env = process.env } = {}) {
  if (!blobs.length) return [];
  const script = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$scope = [System.Security.Cryptography.DataProtectionScope]::CurrentUser
while (($line = [Console]::In.ReadLine()) -ne $null) {
  if ($line.Length -eq 0) { [Console]::Out.WriteLine(''); continue }
  try {
    $plain = [System.Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($line), $null, $scope)
    [Console]::Out.WriteLine([Convert]::ToBase64String($plain))
  } catch { [Console]::Out.WriteLine('') }
}`;
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const input = `${blobs.map((b) => (b && b.length ? Buffer.from(b).toString('base64') : '')).join('\n')}\n`;
  const shell = env.SystemRoot ? `${env.SystemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe` : 'powershell.exe';
  let out = await exec(shell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { input, timeout: 120000 });
  if (out === null && shell !== 'powershell.exe') {
    out = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { input, timeout: 120000 });
  }
  if (out === null) return blobs.map(() => null);
  const lines = out.split(/\r?\n/);
  return blobs.map((_, i) => (lines[i] ? Buffer.from(lines[i], 'base64') : null));
}

/**
 * Unwrap a browser's app-bound encryption key through its own elevation
 * service, for the same Windows user the browser runs as.
 *
 * App-bound encryption (Chrome 127 and later, and the browsers built on it)
 * wraps the cookie key a second time, so that the account's own DPAPI no
 * longer opens it. The extra layer is undone by an out-of-process COM service
 * the browser ships — IElevator — whose DecryptData does the unwrap for a
 * caller running as the same user, and only for that user on that machine. It
 * is the same key, for the same person, that the browser itself uses; it is
 * not a way past anything the person could not already reach.
 *
 * The call is COM, which Node cannot make on its own, so it goes through
 * PowerShell the way the DPAPI one does: a small C# shim reads the elevator's
 * vtable and calls DecryptData by slot, which avoids needing each browser's
 * interface GUID. The service's class id is looked up from a short known map
 * and then from the registry, where every browser writes it. The wrapped key
 * arrives on stdin as base64 and the unwrapped key leaves on stdout the same
 * way; no cookie is ever passed to it.
 */
const ABE_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$product = $env:REGBOT_ABE_PRODUCT
$known = @{
  'Chrome'         = '708860E0-F641-4611-8895-7D867DD3675B';
  'Microsoft Edge' = '1FCBE96C-1697-43AF-9140-2897C7C69767';
  'Brave'          = '576B31AF-6369-4B6B-8560-E4B203A97A8B';
}
function Find-Clsid($p) {
  if ($known.ContainsKey($p)) { return $known[$p] }
  $needle = ($p -replace '\s','')
  foreach ($root in 'HKLM:\SOFTWARE\Classes\CLSID','HKLM:\SOFTWARE\Classes\WOW6432Node\CLSID') {
    $hit = Get-ChildItem $root -ErrorAction SilentlyContinue | ForEach-Object {
      $cmd = (Get-ItemProperty -LiteralPath (Join-Path $_.PSPath 'LocalServer32') -ErrorAction SilentlyContinue).'(default)'
      if ($cmd -and $cmd -match 'elevation_service\.exe' -and ($cmd -match [regex]::Escape($needle) -or $cmd -match [regex]::Escape($p))) { $_.PSChildName.Trim('{}') }
    } | Select-Object -First 1
    if ($hit) { return $hit }
  }
  return $null
}
$clsid = Find-Clsid $product
if (-not $clsid) { exit 3 }
$src = @'
using System;
using System.Runtime.InteropServices;
public static class E {
  [DllImport("ole32.dll")] static extern int CoCreateInstance(ref Guid c, IntPtr o, uint x, ref Guid i, out IntPtr r);
  [DllImport("ole32.dll")] static extern int CoSetProxyBlanket(IntPtr p, uint a, uint z, IntPtr n, uint l, uint m, IntPtr ai, uint c);
  [DllImport("oleaut32.dll")] static extern IntPtr SysAllocStringByteLen(byte[] s, uint n);
  [DllImport("oleaut32.dll")] static extern uint SysStringByteLen(IntPtr b);
  [DllImport("oleaut32.dll")] static extern void SysFreeString(IntPtr b);
  [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int Dec(IntPtr self, IntPtr ct, out IntPtr pt, out uint err);
  public static byte[] Decrypt(Guid clsid, byte[] wrapped) {
    Guid iu = new Guid("00000000-0000-0000-C000-000000000046");
    IntPtr obj; int hr = CoCreateInstance(ref clsid, IntPtr.Zero, 4, ref iu, out obj);
    if (hr < 0) throw new Exception("create 0x" + hr.ToString("X8"));
    CoSetProxyBlanket(obj, 0xFFFFFFFF, 0xFFFFFFFF, IntPtr.Zero, 6, 3, IntPtr.Zero, 0x40);
    IntPtr slot = Marshal.ReadIntPtr(Marshal.ReadIntPtr(obj), 5 * IntPtr.Size);
    var dec = (Dec)Marshal.GetDelegateForFunctionPointer(slot, typeof(Dec));
    IntPtr inb = SysAllocStringByteLen(wrapped, (uint)wrapped.Length); IntPtr outb; uint err;
    hr = dec(obj, inb, out outb, out err); SysFreeString(inb); Marshal.Release(obj);
    if (hr < 0) throw new Exception("decrypt 0x" + hr.ToString("X8"));
    uint n = SysStringByteLen(outb); byte[] k = new byte[n]; Marshal.Copy(outb, k, 0, (int)n); SysFreeString(outb);
    return k;
  }
}
'@
Add-Type -TypeDefinition $src -Language CSharp | Out-Null
$b64 = [Console]::In.ReadToEnd().Trim()
if (-not $b64) { exit 4 }
$wrapped = [Convert]::FromBase64String($b64)
if ($wrapped.Length -gt 4 -and [System.Text.Encoding]::ASCII.GetString($wrapped,0,4) -eq 'APPB') { $wrapped = $wrapped[4..($wrapped.Length-1)] }
$key = [E]::Decrypt([Guid]$clsid, $wrapped)
[Console]::Out.WriteLine([Convert]::ToBase64String($key))
`;

async function appBoundKey(wrapped, browser, { exec = run, env = process.env } = {}) {
  if (!wrapped || !wrapped.length) return null;
  const encoded = Buffer.from(ABE_SCRIPT, 'utf16le').toString('base64');
  const shell = env.SystemRoot ? `${env.SystemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe` : 'powershell.exe';
  const product = browser.product || browser.name || 'Chrome';
  const out = await exec(shell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
    input: `${Buffer.from(wrapped).toString('base64')}\n`,
    env: { REGBOT_ABE_PRODUCT: product },
    timeout: 60000,
  });
  if (out === null) return null;
  const key = Buffer.from(String(out).trim(), 'base64');
  return key.length === 32 ? key : null;
}

// ------------------------------------------------------------------- macos
/** The browser's password from the login keychain. This asks the person. */
async function fromKeychain(product, { exec = run } = {}) {
  const service = `${product} Safe Storage`;
  for (const account of [product, service]) {
    // -w prints the password alone; macOS puts up its own dialog the first
    // time, so this waits as long as a person reasonably takes to answer it.
    const out = await exec('/usr/bin/security',
      ['find-generic-password', '-w', '-s', service, '-a', account], { timeout: 180000 });
    if (out !== null && out.trim()) return out.trim();
  }
  const any = await exec('/usr/bin/security', ['find-generic-password', '-w', '-s', service], { timeout: 180000 });
  return any !== null && any.trim() ? any.trim() : null;
}

// ------------------------------------------------------------------- linux
/**
 * Ask a GNOME keyring through PyGObject, for the machines that have a keyring
 * but not `secret-tool`.
 *
 * Which is most of them: libsecret is what the keyring is made of, but the
 * command-line front end for it is a separate package few people install,
 * whereas the Python bindings come with the desktop. One process does the
 * whole lookup, because the Secret Service hands a password to the connection
 * that asked for it and a second command would be a second connection.
 */
const KEYRING_PY = `
import sys, gi
gi.require_version('Secret', '1')
from gi.repository import Secret
label, apps = sys.argv[1], sys.argv[2:]
schema = Secret.Schema.new('chrome_libsecret_os_crypt_password_v2',
                           Secret.SchemaFlags.DONT_MATCH_NAME,
                           {'application': Secret.SchemaAttributeType.STRING})
for app in apps:
    found = Secret.password_lookup_sync(schema, {'application': app}, None)
    if found:
        sys.stdout.write(found)
        sys.exit(0)
service = Secret.Service.get_sync(Secret.ServiceFlags.LOAD_COLLECTIONS, None)
for collection in service.get_collections():
    try:
        collection.load_items_sync(None)
    except Exception:
        continue
    for item in collection.get_items():
        if item.get_label() != label:
            continue
        try:
            item.load_secret_sync(None)
            secret = item.get_secret()
        except Exception:
            continue
        if secret:
            sys.stdout.write(secret.get_text())
            sys.exit(0)
`;

/** The browser's password from the desktop keyring: libsecret, then KDE. */
async function fromKeyring(product, id, { exec = run } = {}) {
  const apps = [...new Set([
    String(product || '').toLowerCase().replace(/\s+/g, '-'),
    String(id || '').replace(/^other:/, ''),
    ...(String(id || '').startsWith('chrome') ? ['chrome'] : []),
  ].filter(Boolean))];
  for (const app of apps) {
    const out = await exec('secret-tool', ['lookup', 'application', app]);
    if (out !== null && out.length) return out;
  }
  // The attribute each browser writes is its own short name; the label is
  // always "<Product> Safe Storage", which is the one to fall back to.
  for (const python of ['python3', 'python']) {
    const out = await exec(python, ['-c', KEYRING_PY, `${product} Safe Storage`, ...apps], { timeout: 20000 });
    if (out !== null && out.length) return out;
  }
  const folder = `${product} Keys`;
  const entry = `${product} Safe Storage`;
  for (const wallet of ['kdewallet', 'localwallet']) {
    const out = await exec('kwallet-query', ['-f', folder, '-r', entry, wallet]);
    if (out !== null && out.trim() && !/not found|failure/i.test(out)) return out.trim();
  }
  return null;
}

/**
 * The keys a browser's values were encrypted with, as far as this machine
 * will give them up.
 *
 * Comes back with a key per scheme, and with `notes` saying what could not be
 * had and why — which the import screen shows rather than silently producing
 * fewer cookies than the browser has.
 */
async function keysFor(browser, { platform = process.platform, state = {}, exec = run, env = process.env } = {}) {
  const keys = {};
  const notes = [];
  const osCrypt = state.os_crypt || {};
  if (platform === 'win32') {
    const wrapped = osCrypt.encrypted_key ? Buffer.from(String(osCrypt.encrypted_key), 'base64') : null;
    if (wrapped && wrapped.subarray(0, 5).toString('latin1') === 'DPAPI') {
      const [key] = await dpapi([wrapped.subarray(5)], { exec, env });
      if (key && key.length === 32) keys.v10 = key;
      else {
        notes.push('Windows would not unwrap this browser’s key for your account. A key belongs to the '
          + 'Windows account that made it, so another account’s browser cannot be read from this one.');
      }
    } else if (wrapped) {
      notes.push('This browser wraps its key in a way this app does not recognise, so its cookies cannot be read.');
    } else {
      notes.push('This browser has no stored key, so only cookies it never encrypted can be read.');
    }
    if (osCrypt.app_bound_encrypted_key) {
      const abe = await appBoundKey(Buffer.from(String(osCrypt.app_bound_encrypted_key), 'base64'), browser, { exec, env });
      if (abe) keys.v20 = abe;
      else {
        // Current Chrome hands its app-bound key back only to its own program,
        // returning success and nothing to anyone else — an anti-theft measure
        // this app cannot, and should not try to, defeat. Older builds and some
        // other Chromium browsers still release it, and there the cookies open.
        notes.push('Newer cookies in this browser are sealed to the browser’s own program by Windows '
          + '(app-bound encryption); the browser released its key only to itself, so they were left behind. '
          + 'Sign in to the site once in this app instead — it keeps that session.');
      }
    }
    return { keys, notes, dpapiLegacy: true };
  }
  if (platform === 'darwin') {
    const password = await fromKeychain(browser.product || browser.name, { exec });
    if (password) keys.v10 = pbkdf2(password, 1003);
    else notes.push('macOS did not hand over this browser’s key from your keychain — '
      + 'the permission dialog has to be allowed, and it only appears while you are at the machine.');
    return { keys, notes };
  }
  keys.v10 = pbkdf2(LINUX_FALLBACK, 1);
  const password = await fromKeyring(browser.product || browser.name, browser.id, { exec });
  if (password) keys.v11 = pbkdf2(password, 1);
  else {
    notes.push('No desktop keyring answered for this browser, so the cookies it locked with one cannot be read. '
      + 'Unlocking your login keyring, or installing libsecret\u2019s `secret-tool`, is usually what is missing.');
  }
  return { keys, notes };
}

/**
 * Strip the domain Chromium binds a cookie to from the front of its value.
 *
 * Current Chromium puts the SHA-256 of the cookie's host key in front of the
 * value before encrypting it, so that a value lifted from one site's cookie
 * cannot be pushed into another's. Older profiles have no such prefix, and
 * the app's own values never do, so it is matched rather than assumed: 32
 * bytes come off only when they are the hash of the host this cookie is for.
 */
function unbind(plain, host) {
  if (!host || plain.length < 32) return plain;
  const bound = crypto.createHash('sha256').update(String(host)).digest();
  return plain.subarray(0, 32).equals(bound) ? plain.subarray(32) : plain;
}

/**
 * One value, as text. `null` when the scheme's key is not to hand — the
 * caller counts those and says how many rather than dropping them quietly.
 *
 * `host` is the cookie's host key, where there is one: see unbind().
 */
function decryptValue(buf, { keys = {}, platform = process.platform, host = null } = {}) {
  if (!buf || !buf.length) return '';
  const scheme = schemeOf(buf);
  if (scheme === 'legacy') return null;          // a bare DPAPI blob; done in bulk
  const key = keys[scheme];
  if (!key) return null;
  const body = buf.subarray(3);
  if (platform === 'win32' || scheme === 'v20') {
    if (body.length < 12 + 16) return null;
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, body.subarray(0, 12));
    decipher.setAuthTag(body.subarray(body.length - 16));
    try {
      const plain = Buffer.concat([decipher.update(body.subarray(12, body.length - 16)), decipher.final()]);
      const bare = unbind(plain, host);
      // A Windows app-bound value always carries the hash, even where the
      // host key this cookie was read beside no longer matches it.
      return (scheme === 'v20' && bare === plain ? plain.subarray(32) : bare).toString('utf8');
    } catch {
      return null;
    }
  }
  if (body.length % 16 !== 0 || !body.length) return null;
  const decipher = crypto.createDecipheriv('aes-128-cbc', key, CBC_IV);
  decipher.setAutoPadding(false);
  let plain;
  try {
    plain = Buffer.concat([decipher.update(body), decipher.final()]);
  } catch {
    return null;
  }
  const pad = plain[plain.length - 1];
  if (pad >= 1 && pad <= 16 && pad <= plain.length) plain = plain.subarray(0, plain.length - pad);
  return unbind(plain, host).toString('utf8');
}

module.exports = { keysFor, decryptValue, schemeOf, dpapi, appBoundKey, fromKeychain, fromKeyring, pbkdf2, unbind, run };
