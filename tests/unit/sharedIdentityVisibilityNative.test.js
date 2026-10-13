import { jest } from '@jest/globals';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { createSharedIdentityVisibility, createNativeWindowReadback, nativelyParked, visibilityAddonFiles } from '../../lib/shared-identity-visibility.js';
import { listNativeWindows, windowBounds } from '../../lib/park-display-launcher.js';
import { findBrowserPid, parseDarwinProcesses } from '../../lib/darwin-processes.js';

const display = {
  park: { left: -1280, top: -960, width: 1280, height: 960 },
  main: { left: 0, top: 0, width: 2048, height: 1152 },
};
const onMain = { left: 40, top: 40, width: 1280, height: 900 };

describe('listNativeWindows (darwin readback parsing)', () => {
  const fake = value => jest.fn(async () => ({ stdout: JSON.stringify(value) }));
  test('runs a bounded osascript with the pid as an argument and a whitelisted env', async () => {
    const execute = fake([]);
    await listNativeWindows(4242, { execute });
    const [file, args, options] = execute.mock.calls[0];
    expect(file).toBe('/usr/bin/osascript');
    expect(args.at(-1)).toBe('4242');
    expect(args.join(' ')).not.toContain('kCGWindowName');
    expect(options).toMatchObject({ timeout: 1500, env: { PATH: '/usr/bin:/bin' } });
  });
  test('keeps only layer-0 windows of the requested pid', async () => {
    const execute = fake([
      { number: 1, pid: 7, layer: 0, left: -1280, top: -920, width: 1280, height: 900 },
      { number: 2, pid: 7, layer: 101, left: 0, top: 0, width: 300, height: 200 },
      { number: 3, pid: 8, layer: 0, left: 0, top: 0, width: 300, height: 200 },
    ]);
    expect(await listNativeWindows(7, { execute })).toEqual([{ number: 1, left: -1280, top: -920, width: 1280, height: 900 }]);
  });
  test.each([
    ['non-array output', { left: 0 }, 'invalid native window list'],
    ['missing bounds', [{ number: 1, pid: 7, layer: 0, left: 0, top: 0 }], 'invalid native window geometry'],
    ['zero size', [{ number: 1, pid: 7, layer: 0, left: 0, top: 0, width: 0, height: 10 }], 'invalid native window geometry'],
    ['non-integer number', [{ number: 'x', pid: 7, layer: 0, left: 0, top: 0, width: 10, height: 10 }], 'invalid native window geometry'],
  ])('rejects %s', async (_name, value, message) => {
    await expect(listNativeWindows(7, { execute: fake(value) })).rejects.toThrow(message);
  });
  test('rejects an invalid pid without running osascript', async () => {
    const execute = fake([]);
    await expect(listNativeWindows(0, { execute })).rejects.toThrow('invalid browser pid');
    expect(execute).not.toHaveBeenCalled();
  });
});

describe('browser pid resolution for native readback', () => {
  const ps = parseDarwinProcesses([
    '  100     1 node server.js',
    '  200   100 /x/Camoufox.app/Contents/MacOS/camoufox -no-remote -profile /state/shared-profiles/a -juggler-pipe',
    '  201   200 /x/plugin-container.app/Contents/MacOS/plugin-container -profile /state/shared-profiles/a 3 tab',
    '  300   100 /x/Camoufox.app/Contents/MacOS/camoufox -profile /state/shared-profiles/b',
    '  400     1 /x/Camoufox.app/Contents/MacOS/camoufox -profile /state/shared-profiles/a',
  ].join('\n'));
  test('finds the single main browser process for this server and profile only', () => {
    expect(findBrowserPid(100, ps, '/state/shared-profiles/a')).toBe(200);
    expect(findBrowserPid(100, ps, '/state/shared-profiles/c')).toBe(null);
    // Another server's browser on the same profile path is never matched.
    expect(findBrowserPid(999, ps, '/state/shared-profiles/a')).toBe(null);
  });
  test('readback caches the pid while alive and re-resolves after exit', async () => {
    let alive = true;
    const snapshot = jest.fn(() => ps), list = jest.fn(async () => [{ number: 1, ...onMain }]);
    const read = createNativeWindowReadback('/state/shared-profiles/a', { platform: 'darwin', rootPid: 100, snapshot, list, alive: () => alive });
    await read(); await read();
    expect(snapshot).toHaveBeenCalledTimes(1);
    expect(list).toHaveBeenCalledWith(200);
    alive = false; await read();
    expect(snapshot).toHaveBeenCalledTimes(2);
  });
  test('names the profile when no browser can be identified, and an empty window list', async () => {
    await expect(createNativeWindowReadback('/state/none', { platform: 'darwin', rootPid: 100, snapshot: () => ps, list: async () => [] })())
      .rejects.toThrow('no single browser process for profile /state/none');
    await expect(createNativeWindowReadback('/state/shared-profiles/a', { platform: 'darwin', rootPid: 100, snapshot: () => ps, list: async () => [] })())
      .rejects.toThrow('no on-screen windows for browser pid 200');
  });
  test('non-darwin hosts and missing profiles get no native readback', () => {
    expect(createNativeWindowReadback('/p', { platform: 'linux' })).toBe(null);
    expect(createNativeWindowReadback(undefined, { platform: 'darwin' })).toBe(null);
  });
});

describe('native readback in the add-on (Camoufox-spoofed windows.get)', () => {
  let root, visibility, context, windows, intervals, nextId, browser, readback, onCreated;
  // Camoufox spoofs windows.get: it always reports the requested park geometry.
  // `native` is what CGWindowList would report.
  async function setup({ failReads = 0 } = {}) {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'park-native-'));
    context = new EventEmitter(); context.livePages = []; context.pages = () => context.livePages;
    windows = new Map(); intervals = []; nextId = 1;
    let failures = failReads;
    readback = jest.fn(async () => {
      if (failures > 0) { failures--; throw new Error('osascript timed out'); }
      return [...windows.values()].map(w => ({ number: w.id, ...w.native }));
    });
    browser = {
      windows: {
        onCreated: { addListener: fn => { onCreated = fn; } }, onRemoved: { addListener() {} },
        getAll: async () => [...windows.values()],
        get: jest.fn(async id => { const w = windows.get(id); if (!w) throw Error('window ended'); return { ...w, ...windowBounds(display.park) }; }),
        update: jest.fn(async (id, bounds) => { const w = windows.get(id); if (!w) throw Error('window ended'); w.native = { ...bounds }; return { ...w, ...bounds }; }),
        remove: jest.fn(async id => { windows.delete(id); }),
        create: async ({ url, ...bounds }) => {
          const id = nextId++;
          const p = { url: () => url, isClosed: () => false };
          // The create result claims park geometry; natively it lands on main.
          const w = { id, tabs: [{ id, windowId: id, url }], state: 'normal', native: { ...onMain } };
          windows.set(id, w); context.livePages.push(p); context.emit('page', p);
          return { ...w, ...bounds };
        },
      },
      tabs: { onRemoved: { addListener() {} }, query: async () => [], get: async () => null, update: async () => {} },
    };
    visibility = await createSharedIdentityVisibility(display, { nativeReadback: readback, rootDir: root, timeoutMs: 2000 });
    const script = await fs.readFile(path.join(visibility.addon, 'background.js'), 'utf8');
    vm.runInNewContext(script, { browser, fetch, setTimeout, setInterval: fn => { const id = setInterval(fn, 10); intervals.push(id); return id; } });
    await visibility.attach(context);
  }
  afterEach(async () => { for (const id of intervals) clearInterval(id); await visibility?.close(); await fs.rm(root, { recursive: true, force: true }); });
  // The startup snapshot must also pass for windows Camoufox restored at launch.
  test('startup with native readback acknowledges ready', async () => {
    await setup();
    expect(readback).not.toHaveBeenCalled();
  });

  test('a create that windows.get reports parked but is natively on main is moved and verified natively', async () => {
    await setup();
    await visibility.newPage(context);
    expect(windows.get(1).native).toMatchObject(windowBounds(display.park));
    expect(browser.windows.update).toHaveBeenCalledWith(1, windowBounds(display.park));
    expect(readback).toHaveBeenCalled();
    // No window-title marker is used any more.
    expect(browser.windows.update.mock.calls.some(([, b]) => 'titlePreface' in b)).toBe(false);
  });
  test('transient native readback failures are retried inside the bounded loop', async () => {
    await setup();
    let failures = 2;
    const real = readback.getMockImplementation();
    readback.mockImplementation(async () => { if (failures-- > 0) throw new Error('osascript timed out'); return real(); });
    await visibility.newPage(context);
    expect(failures).toBeLessThan(0);
    expect(windows.get(1).native).toMatchObject(windowBounds(display.park));
  });
  test('persistent readback failure is bounded and reports the readback error', async () => {
    await setup();
    readback.mockImplementation(async () => { throw new Error('native window readback found no single browser process for profile /p'); });
    await expect(visibility.newPage(context)).rejects.toThrow(/did not park.*no single browser process/);
    expect(readback.mock.calls.length).toBeLessThanOrEqual(8);
  });
  test('a recorded handoff on main is allowed; a second window on main is not', async () => {
    await setup();
    const a = await visibility.newPage(context);
    visibility.visible.set(1, { windowId: 1, tabId: 1 });
    windows.get(1).native = { ...onMain };
    await visibility.newPage(context);
    expect(windows.get(2).native).toMatchObject(windowBounds(display.park));
    expect(a).toBeTruthy();
    // Window 2 stuck on main while 1 is the handoff: 2 on main > 1 allowed.
    browser.windows.update.mockImplementation(async (id, bounds) => ({ ...windows.get(id), ...bounds }));
    await expect(visibility.newPage(context)).rejects.toThrow('did not park');
  });
  test('concurrent creates both verify even though native windows carry no Firefox id', async () => {
    await setup();
    const [a, b] = await Promise.all([visibility.newPage(context), visibility.newPage(context)]);
    expect(a).not.toBe(b);
    expect(windows.get(1).native).toMatchObject(windowBounds(display.park));
    expect(windows.get(2).native).toMatchObject(windowBounds(display.park));
  });
  test('an already-reported stuck window does not fail later creates', async () => {
    await setup();
    windows.set(50, { id: 50, tabs: [], state: 'normal', native: { ...onMain } });
    visibility.parkingFailures.set(50, 'did not park');
    await visibility.newPage(context);
    expect(windows.get(1).native).toMatchObject(windowBounds(display.park));
  });
  test('UI onCreated window that cannot move to main records inheritFailed, not parkingFailed', async () => {
    await setup();
    visibility.visible.set(77, { windowId: 77, tabId: 77 });
    const w = { id: 60, tabs: [{ id: 60, windowId: 60, url: 'https://ui.test' }], state: 'normal', native: { ...windowBounds(display.park) } };
    windows.set(60, w);
    browser.windows.update.mockImplementation(async () => { throw new Error('window busy'); });
    await onCreated(w);
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(visibility.inheritFailures.has(60)).toBe(true);
    expect(visibility.parkingFailures.has(60)).toBe(false);
  });
});

describe('/geometry bridge validation', () => {
  let root, visibility, endpoint, readback;
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'park-geometry-'));
    readback = jest.fn(async () => [{ number: 1, ...onMain }, { number: 2, ...windowBounds(display.park) }, { number: 3, left: 0, top: 0, width: 2048, height: 30 }]);
    visibility = await createSharedIdentityVisibility(display, { nativeReadback: readback, rootDir: root, timeoutMs: 2000 });
    const script = await fs.readFile(path.join(visibility.addon, 'background.js'), 'utf8');
    endpoint = script.match(/const endpoint="([^"]+)"/)[1];
    expect(script).toContain('const nativeReadback=true');
  });
  afterEach(async () => { await visibility.close(); await fs.rm(root, { recursive: true, force: true }); });
  const post = body => fetch(endpoint + '/geometry', { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) });

  test('counts unparked browser windows (ignoring helper strips) and the handoffs allowed there, excluding the checked window', async () => {
    visibility.visible.set(5, { windowId: 5 }); visibility.visible.set(9, { windowId: 9 });
    const response = await post({ windowId: 9 });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ unparked: 1, allowed: 1, contended: 0, windows: 3 });
  });
  test('a window straddling both displays counts as unparked; macOS chrome offsets do not', () => {
    // Observed on real DeskPad: 20pt overhangs the left edge of main's x-range but no pixel is on main.
    expect(nativelyParked({ left: -1260, top: -910, width: 1280, height: 774 }, display)).toBe(true);
    expect(nativelyParked({ left: -1260, top: -750, width: 1280, height: 774 }, display)).toBe(false);
    expect(nativelyParked({ left: -1280, top: -920, width: 1280, height: 900 }, display)).toBe(true);
    expect(nativelyParked({ left: -1270, top: -930, width: 1260, height: 774 }, display)).toBe(true);
    expect(nativelyParked({ left: -1280, top: -100, width: 1280, height: 900 }, display)).toBe(false);
  });
  test.each([['string id', { windowId: '1' }], ['negative id', { windowId: -1 }], ['fractional id', { windowId: 1.5 }],
    ['legacy title marker', { marker: '[camofox-window-x-1]' }], ['non-string command', { windowId: 1, commandId: 5 }], ['oversized body', 'x'.repeat(2000)]])('rejects %s', async (_name, body) => {
    const response = await post(body);
    expect(response.status).toBe(500);
    expect(readback).not.toHaveBeenCalled();
  });
  test('the route needs the secret and is absent without native readback', async () => {
    const bare = endpoint.replace(/\/[a-f0-9]{64}$/, '');
    expect((await fetch(bare + '/geometry', { method: 'POST', body: '{"windowId":1}' })).status).toBe(404);
    const plain = await createSharedIdentityVisibility(display, { nativeReadback: null, rootDir: root, timeoutMs: 2000 });
    try {
      const script = await fs.readFile(path.join(plain.addon, 'background.js'), 'utf8');
      const other = script.match(/const endpoint="([^"]+)"/)[1];
      expect(script).toContain('const nativeReadback=false');
      expect((await fetch(other + '/geometry', { method: 'POST', body: '{"windowId":1}' })).status).toBe(404);
    } finally { await plain.close(); }
  });
  test('add-on source never sets a window title marker', () => {
    expect(visibilityAddonFiles({ endpoint: 'e', park: {}, main: {}, nativeReadback: true })['background.js']).not.toContain('titlePreface');
  });
});
