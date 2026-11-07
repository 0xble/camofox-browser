import { test, expect, beforeEach, afterEach } from '@jest/globals';
import { EventEmitter } from 'node:events';
import net from 'node:net';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { prepareRuntimeAddons } from '../../lib/runtime-addons.js';

const frame = value => {
  const bytes = Buffer.from(JSON.stringify(value));
  return Buffer.concat([Buffer.from(bytes.length + ':'), bytes]);
};
let installer, socketPath, context, server, clients;
beforeEach(async () => {
  installer = await prepareRuntimeAddons(['/generated/visibilité', '/generated/indicator'], { timeoutMs: 1000 });
  socketPath = installer.args.at(-1);
  context = new EventEmitter(); clients = new Set();
});
afterEach(async () => {
  for (const socket of clients) socket.destroy();
  if (server?.listening) await new Promise(resolve => server.close(resolve));
  server = null;
  await installer.close();
});
async function listen(connected) {
  server = net.createServer(socket => {
    clients.add(socket); socket.on('error', () => {}); socket.once('close', () => clients.delete(socket));
    connected(socket);
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
}
function requests(socket, handle) {
  let data = Buffer.alloc(0);
  socket.on('data', chunk => {
    data = Buffer.concat([data, chunk]);
    while (true) {
      const colon = data.indexOf(58);
      if (colon < 0) return;
      const length = Number(data.subarray(0, colon));
      if (data.length < colon + 1 + length) return;
      const value = JSON.parse(data.subarray(colon + 1, colon + 1 + length));
      data = data.subarray(colon + 1 + length);
      handle(value);
    }
  });
}

test('installs both helpers once using byte-framed RDP with split and coalesced messages', async () => {
  const received = [];
  let ended;
  const disconnected = new Promise(resolve => { ended = resolve; });
  await listen(socket => {
    socket.once('end', ended);
    const greeting = frame({ from: 'root', applicationType: 'browser' });
    socket.write(greeting.subarray(0, 1));
    setImmediate(() => {
      socket.write(greeting.subarray(1, 6));
      setImmediate(() => socket.write(greeting.subarray(6)));
    });
    requests(socket, request => {
      received.push(request);
      if (request.type === 'getRoot') socket.write(Buffer.concat([
        frame({ from: 'unrelated', type: 'event' }), frame({ from: 'root', addonsActor: 'addons1' }),
      ]));
      else {
        const reply = frame({ from: 'addons1', addon: { id: 'addon-' + received.length } });
        // Split inside the UTF-8 request is already exercised by byte framing;
        // splitting the response also tests incremental JSON-body assembly.
        socket.write(reply.subarray(0, 12));
        setImmediate(() => socket.write(reply.subarray(12)));
      }
    });
  });
  await expect(installer.install(context)).resolves.toEqual(['addon-2', 'addon-3']);
  expect(received).toEqual([
    { to: 'root', type: 'getRoot' },
    { to: 'addons1', type: 'installTemporaryAddon', addonPath: '/generated/visibilité', openDevTools: false },
    { to: 'addons1', type: 'installTemporaryAddon', addonPath: '/generated/indicator', openDevTools: false },
  ]);
  await disconnected;
  await installer.close();
  await expect(fs.stat(path.dirname(socketPath))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(context.listenerCount('close')).toBe(0);
});

test('creates a short private launch-owned directory and removes only that directory', async () => {
  const directory = path.dirname(socketPath);
  expect((await fs.stat(directory)).mode & 0o777).toBe(0o700);
  expect(Buffer.byteLength(socketPath)).toBeLessThanOrEqual(103);
  await fs.writeFile(path.join(directory, 'owned'), 'launch fixture');
  await installer.close(); await installer.close();
  await expect(fs.stat(directory)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(installer.firefoxUserPrefs).toEqual({ 'devtools.chrome.enabled': true,
    'devtools.debugger.remote-enabled': true, 'devtools.debugger.prompt-connection': false });
});

test('waits for the startup listener within the same total deadline', async () => {
  const pending = installer.install(context);
  await new Promise(resolve => setTimeout(resolve, 40));
  await listen(socket => {
    socket.write(frame({ from: 'root' }));
    requests(socket, message => socket.write(frame(message.type === 'getRoot'
      ? { from: 'root', addonsActor: 'addons' } : { from: 'addons', addon: { id: 'installed' } })));
  });
  await expect(pending).resolves.toEqual(['installed', 'installed']);
});

test.each([
  ['invalid header', Buffer.from('x:bad'), /frame header/],
  ['unterminated header', Buffer.from('12345678'), /frame header/],
  ['oversized frame', Buffer.from('1048577:'), /frame length/],
  ['empty frame', Buffer.from('0:'), /frame length/],
  ['malformed JSON', Buffer.from('1:{'), /JSON/],
  ['invalid message', frame({ invalid: true }), /RDP message/],
  ['wrong greeting', frame({ from: 'other' }), /root greeting/],
  ['actor error', frame({ from: 'root', error: 'forbidden', message: 'denied' }), /forbidden: denied/],
])('fails terminally on %s without installing anything', async (_name, bytes, message) => {
  await listen(socket => socket.write(bytes));
  await expect(installer.install(context)).rejects.toThrow(message);
  expect(context.listenerCount('close')).toBe(0);
});

test.each(['missing actor', 'install error', 'missing addon id'])('fails terminally on %s', async kind => {
  const received = [];
  await listen(socket => {
    socket.write(frame({ from: 'root' }));
    requests(socket, message => {
      received.push(message);
      const reply = message.type === 'getRoot'
        ? { from: 'root', ...(kind === 'missing actor' ? {} : { addonsActor: 'addons' }) }
        : kind === 'install error' ? { from: 'addons', error: 'installFailed', message: 'refused' } : { from: 'addons' };
      socket.write(frame(reply));
    });
  });
  await expect(installer.install(context)).rejects.toThrow(/actor is unavailable|installFailed|no addon id/);
  expect(received.filter(message => message.type === 'installTemporaryAddon').length).toBe(kind === 'missing actor' ? 0 : 1);
});

test.each(['EOF', 'truncated frame', 'browser exit'])('terminates on %s during handshake', async kind => {
  await listen(socket => {
    if (kind === 'browser exit') context.emit('close');
    else socket.end(kind === 'truncated frame' ? '100:{' : undefined);
  });
  await expect(installer.install(context)).rejects.toThrow(/EOF|closed/);
});

test.each(['connect', 'greeting', 'install'])('bounds the total deadline while waiting for %s', async stage => {
  await installer.close();
  installer = await prepareRuntimeAddons(['/generated/helper'], { timeoutMs: 80 });
  socketPath = installer.args.at(-1);
  if (stage !== 'connect') await listen(socket => {
    if (stage === 'install') {
      socket.write(frame({ from: 'root' }));
      requests(socket, message => { if (message.type === 'getRoot') socket.write(frame({ from: 'root', addonsActor: 'addons' })); });
    }
  });
  await expect(installer.install(context)).rejects.toThrow('timed out');
  expect(context.listenerCount('close')).toBe(0);
});

test('rejects an already exited browser without connecting', async () => {
  context.browser = () => ({ isConnected: () => false });
  await expect(installer.install(context)).rejects.toThrow('Browser exited');
});

test('rejects unsupported platforms without creating a listener', async () => {
  await expect(prepareRuntimeAddons(['/generated/helper'], { platform: 'win32' })).rejects.toThrow('Unix debug listener');
});

test('rejects long socket paths and cleans the directory created during preparation', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'long-rdp-'));
  const long = path.join(root, 'x'.repeat(104));
  try {
    await fs.mkdir(long);
    await expect(prepareRuntimeAddons(['/generated/helper'], { tmpDir: long })).rejects.toThrow('exceeds 103 bytes');
    expect(await fs.readdir(long)).toEqual([]);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
