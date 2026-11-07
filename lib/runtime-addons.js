import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const MAX_FRAME = 1024 * 1024;

// Camoufox's config.addons is installed by every browser window. Generated
// runtime helpers instead belong to the browser lifetime. Use Firefox's
// shipped addons actor once, then disconnect and unlink its Unix listener.
export async function prepareRuntimeAddons(addons, { platform = os.platform(), tmpDir = os.tmpdir(), timeoutMs = 10000, profilePath } = {}) {
  if (!['darwin', 'linux'].includes(platform))
    throw new Error('Generated runtime addons require a Firefox Unix debug listener on this platform');
  if (!addons.length || !addons.every(addon => typeof addon === 'string' && path.isAbsolute(addon)))
    throw new Error('Runtime addon paths must be nonempty absolute paths');
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('Invalid runtime addon deadline');
  const directory = await fs.mkdtemp(path.join(tmpDir, 'cfx-'));
  const socketPath = path.join(directory, 'rdp');
  const firefoxUserPrefs = { 'devtools.chrome.enabled': true, 'devtools.debugger.remote-enabled': true,
    'devtools.debugger.prompt-connection': false };
  let restoreStartupPrefs;
  const close = async () => {
    let failure;
    try { await restoreStartupPrefs?.(); } catch (error) { failure = error; }
    try { await fs.rm(directory, { recursive: true, force: true }); }
    catch (error) { if (failure) failure.cleanupError = error; else failure = error; }
    if (failure) throw failure;
  };
  try {
    // The engine creates the socket as 0666. Its launch-owned parent must be
    // private before Firefox starts, even under a permissive process umask.
    await fs.chmod(directory, 0o700);
    if (Buffer.byteLength(socketPath) > 103) throw new Error('Runtime addon Unix socket path exceeds 103 bytes');
    // Playwright applies firefoxUserPrefs through Browser.enable, after Firefox
    // has already decided whether to start its command-line debug listener.
    if (profilePath) restoreStartupPrefs = await prepareStartupPrefs(profilePath, firefoxUserPrefs);
    return {
      args: ['--start-debugger-server', socketPath],
      firefoxUserPrefs,
      install: context => installAddons(socketPath, addons, context, timeoutMs),
      close,
    };
  } catch (error) {
    try { await close(); } catch (cleanupError) { error.cleanupError = cleanupError; }
    throw error;
  }
}

async function prepareStartupPrefs(profilePath, prefs) {
  const file = path.join(profilePath, 'user.js');
  const suffix = Buffer.from('\n' + Object.entries(prefs)
    .map(([key, value]) => `user_pref(${JSON.stringify(key)}, ${JSON.stringify(value)});`).join('\n') + '\n');
  let handle, created = false, metadata, original, restored = false;
  // Keep the inode, permissions, ownership and arbitrary user code intact.
  // Refuse symlinks instead of modifying a file outside the owned profile.
  try { handle = await fs.open(file, constants.O_RDWR | constants.O_NOFOLLOW); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    handle = await fs.open(file, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    created = true;
  }
  const restore = async () => {
    if (restored) return;
    const current = await fs.open(file, constants.O_RDWR | constants.O_NOFOLLOW);
    try {
      const stat = await current.stat();
      if (metadata && (stat.ino !== metadata.ino || stat.dev !== metadata.dev))
        throw new Error('Runtime addon startup user.js was replaced before cleanup');
      if (original) {
        const bytes = await current.readFile();
        const tail = bytes.subarray(original.length);
        // Also recognize a partial append if preparation itself failed. Never
        // truncate someone else's changes or parse/rewrite their user code.
        if (bytes.length < original.length || !bytes.subarray(0, original.length).equals(original)
          || tail.length > suffix.length || !tail.equals(suffix.subarray(0, tail.length)))
          throw new Error('Runtime addon startup user.js changed before cleanup');
        if (!created) await current.truncate(original.length);
      }
      if (created) await fs.unlink(file);
      else if (metadata) await current.utimes(metadata.atimeMs / 1000, metadata.mtimeMs / 1000);
      restored = true;
    } finally { await current.close(); }
  };
  try {
    metadata = await handle.stat();
    if (!metadata.isFile()) throw new Error('Runtime addon startup user.js is not a regular file');
    original = await handle.readFile();
    await handle.writeFile(suffix);
    await handle.close();
    handle = null;
    return restore;
  } catch (error) {
    try { await handle?.close(); } catch (closeError) { error.closeError = closeError; }
    try { await restore(); } catch (cleanupError) { error.cleanupError = cleanupError; }
    throw error;
  }
}

async function installAddons(socketPath, addons, context, timeoutMs) {
  let socket, buffer = Buffer.alloc(0), waiting, stopped = false, timer;
  const inbox = [];
  let rejectFailure;
  const failed = new Promise((_, reject) => { rejectFailure = reject; });
  const fail = error => { rejectFailure(error); };
  const onClosed = () => fail(new Error('Browser closed during runtime addon installation'));
  const check = () => { if (stopped) throw new Error('Runtime addon installation stopped'); };
  const receive = () => inbox.length ? Promise.resolve(inbox.shift()) : new Promise(resolve => { waiting = resolve; });
  function data(chunk) {
    try {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length) {
        const colon = buffer.indexOf(58);
        if (colon < 0) {
          if (buffer.length > 7 || !/^\d*$/.test(buffer.toString())) throw new Error('Invalid RDP frame header');
          return;
        }
        const header = buffer.subarray(0, colon).toString();
        if (!/^\d{1,7}$/.test(header)) throw new Error('Invalid RDP frame header');
        const length = Number(header);
        if (length <= 0 || length > MAX_FRAME) throw new Error('Invalid RDP frame length');
        if (buffer.length < colon + 1 + length) return;
        const value = JSON.parse(buffer.subarray(colon + 1, colon + 1 + length).toString('utf8'));
        buffer = buffer.subarray(colon + 1 + length);
        if (!value || typeof value !== 'object' || typeof value.from !== 'string') throw new Error('Invalid RDP message');
        if (value.error) throw new Error(`RDP ${value.error}: ${value.message || 'runtime addon operation failed'}`);
        if (waiting) { const resolve = waiting; waiting = null; resolve(value); }
        else {
          if (inbox.length >= 64) throw new Error('Too many unsolicited RDP messages');
          inbox.push(value);
        }
      }
    } catch (error) { fail(error); }
  }
  async function connect() {
    while (true) {
      check();
      try {
        await new Promise((resolve, reject) => {
          let connected = false;
          socket = net.createConnection(socketPath);
          socket.on('data', data);
          socket.once('connect', () => { connected = true; resolve(); });
          socket.on('error', error => connected ? fail(error) : reject(error));
          socket.once('close', () => { if (connected) fail(new Error('RDP socket closed during runtime addon installation')); });
          socket.once('end', () => fail(new Error('RDP EOF during runtime addon installation')));
        });
        return;
      } catch (error) {
        socket.destroy();
        if (!['ENOENT', 'ECONNREFUSED'].includes(error.code)) throw error;
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    }
  }
  async function request(message) {
    check();
    const bytes = Buffer.from(JSON.stringify(message));
    socket.write(Buffer.concat([Buffer.from(bytes.length + ':'), bytes]));
    while (true) {
      const reply = await receive();
      check();
      if (reply.from === message.to) return reply;
    }
  }
  context.once('close', onClosed);
  try {
    return await Promise.race([
      failed,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Runtime addon installation timed out')), timeoutMs); }),
      (async () => {
        if (context.browser?.()?.isConnected() === false) throw new Error('Browser exited before runtime addon installation');
        await connect();
        const greeting = await receive();
        if (greeting.from !== 'root') throw new Error('Invalid RDP root greeting');
        const root = await request({ to: 'root', type: 'getRoot' });
        if (typeof root.addonsActor !== 'string' || !root.addonsActor) throw new Error('Firefox RDP addons actor is unavailable');
        const ids = [];
        for (const addonPath of addons) {
          const reply = await request({ to: root.addonsActor, type: 'installTemporaryAddon', addonPath, openDevTools: false });
          if (typeof reply.addon?.id !== 'string' || !reply.addon.id) throw new Error('RDP addon install returned no addon id');
          ids.push(reply.addon.id);
        }
        return ids;
      })(),
    ]);
  } finally {
    stopped = true;
    clearTimeout(timer);
    context.removeListener('close', onClosed);
    socket?.destroy();
  }
}
