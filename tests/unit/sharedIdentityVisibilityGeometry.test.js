import { jest } from '@jest/globals';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { createSharedIdentityVisibility } from '../../lib/shared-identity-visibility.js';
import { windowBounds } from '../../lib/park-display-launcher.js';

const display = {
  park: { left: -1280, top: -960, width: 1280, height: 960 },
  main: { left: 0, top: 0, width: 2048, height: 1152 },
};

describe('startup park geometry verification', () => {
  let root, visibility, context, browser, w, emitted;
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'park-startup-'));
    context = new EventEmitter();
    emitted = [];
    w = { id: 1, tabs: [{ id: 1, windowId: 1, url: 'about:blank' }], ...windowBounds(display.main) };
    browser = {
      windows: {
        getAll: async () => [w],
        get: jest.fn(async () => ({ ...w })),
        update: jest.fn(async (_id, bounds) => Object.assign(w, bounds)),
        onCreated: { addListener() {} }, onRemoved: { addListener() {} },
      },
      tabs: { onRemoved: { addListener() {} } },
    };
    visibility = await createSharedIdentityVisibility(display, { nativeReadback: null, rootDir: root, timeoutMs: 2000 });
  });
  afterEach(async () => { await visibility.close(); await fs.rm(root, { recursive: true, force: true }); });
  async function start() {
    const script = await fs.readFile(path.join(visibility.addon, 'background.js'), 'utf8');
    vm.runInNewContext(script, { browser, setTimeout, setInterval() {}, fetch: async (url, opts) => {
      if (opts) emitted.push(JSON.parse(opts.body));
      return fetch(url, opts);
    } });
    return visibility.attach(context);
  }

  test('startup readiness waits for actual placement, retrying an ignored update', async () => {
    const original = browser.windows.update.getMockImplementation();
    let ignored = false;
    browser.windows.update.mockImplementation(async (id, bounds) => {
      if (!ignored) { ignored = true; return { ...w, ...bounds }; }
      return original(id, bounds);
    });
    await start();
    expect(w).toMatchObject(windowBounds(display.park));
    expect(browser.windows.update).toHaveBeenCalledTimes(2);
    expect(browser.windows.get).toHaveBeenCalledTimes(3);
    expect(browser.windows.get).toHaveBeenNthCalledWith(1, 1, { populate: true });
    expect(emitted).toContainEqual({ parked: 1, topologyVersion: 0 });
    expect(emitted.at(-1)).toEqual({ ready: true });
  });
  test('uncorrectable startup geometry rejects readiness rather than recording parked', async () => {
    browser.windows.update.mockImplementation(async (_id, bounds) => ({ ...w, ...bounds }));
    await expect(start()).rejects.toThrow('did not park on the parking display');
    expect(browser.windows.update).toHaveBeenCalledTimes(5);
    expect(emitted.some(v => v.parked != null || v.ready)).toBe(false);
    expect(emitted.at(-1).readyError).toContain('did not park');
  });
  test('placement drift after the first update is corrected before startup readiness', async () => {
    const original = browser.windows.update.getMockImplementation();
    let drift = true;
    browser.windows.update.mockImplementation(async (id, bounds) => {
      const value = await original(id, bounds);
      if (drift) { drift = false; setTimeout(() => Object.assign(w, { left: 20, top: 50 }), 15); }
      return value;
    });
    await start();
    expect(w).toMatchObject(windowBounds(display.park));
    expect(browser.windows.update).toHaveBeenCalledTimes(2);
    expect(emitted.at(-1)).toEqual({ ready: true });
  });
  test('real macOS chrome offsets are accepted only when no pixels overlap main', async () => {
    browser.windows.update.mockImplementation(async () => Object.assign(w, { left: -1260, top: -910, width: 1280, height: 774 }));
    await start();
    expect(browser.windows.update).toHaveBeenCalledTimes(1);
    expect(emitted).toContainEqual({ parked: 1, topologyVersion: 0 });
  });
  test('main display overlap fails verification even with the center and most area parked', async () => {
    browser.windows.update.mockImplementation(async () => Object.assign(w, { left: -1260, top: -750, width: 1280, height: 774 }));
    await expect(start()).rejects.toThrow('did not park on the parking display');
    expect(emitted.some(v => v.parked != null || v.ready)).toBe(false);
  });
});
