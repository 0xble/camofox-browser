import { jest } from '@jest/globals';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSharedIdentityVisibility } from '../../lib/shared-identity-visibility.js';

const display = { main: { left: 0, top: 0, width: 2048, height: 1152 },
  park: { left: -3360, top: -2100, width: 3360, height: 2100 } };

describe('parking cleanup native visibility reconciliation', () => {
  let root, visibility, endpoint, nativeWindows, nativeReadback, page, commands;
  async function post(body, suffix = '') {
    const response = await fetch(`${endpoint}${suffix}`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return response.json();
  }
  async function respond(action, start, reply) {
    const pending = start();
    pending.catch(() => {}); // Attach before native readback can reject during ack.
    for (let attempt = 0; attempt < 200; attempt++) {
      const state = await (await fetch(endpoint)).json();
      const command = state.commands.find(item => item.action === action);
      if (command) {
        commands.push(command);
        await post({ id: command.id, windowId: 7, tabId: 70, ...reply?.(command) });
        return pending;
      }
      await new Promise(resolve => setTimeout(resolve, 1));
    }
    throw Error(`no ${action} command`);
  }
  // A page the parking controller did not create: a managed popup. Its
  // evaluate implements the title marker the locate command relies on.
  function fakePopupPage({ hang = false } = {}) {
    let title = 'Popup target';
    return {
      url: () => 'https://popup.test/target',
      isClosed: () => false,
      evaluate: jest.fn(async (_fn, arg) => {
        if (hang) return new Promise(() => {});
        if (typeof arg === 'string') { const old = title; title = arg; return old; }
        if (arg?.marker && title === arg.marker) title = arg.previous;
        return undefined;
      }),
      get title() { return title; },
    };
  }
  // Simulate the add-on's windows.onCreated classification: parking the new
  // popup window already established its exact native binding server-side.
  async function bindNativeWindow(windowId, number) {
    const reservation = await post({ windowId }, '/geometry');
    nativeWindows = [...nativeWindows.filter(w => w.number !== number), { number, ...reservation.bounds }];
    expect((await post({ windowId }, '/geometry')).number).toBe(number);
  }
  // Ack every locate command (marker and tabId forms) until start() settles.
  async function ackLocates(start, reply) {
    const pending = start();
    pending.catch(() => {});
    let settled = false;
    pending.finally(() => { settled = true; });
    for (let attempt = 0; attempt < 1000 && !settled; attempt++) {
      const state = await (await fetch(endpoint)).json();
      for (const command of state.commands.filter(item => item.action === 'locate')) {
        commands.push(command);
        await post({ id: command.id, ...reply });
      }
      if (!settled) await new Promise(resolve => setTimeout(resolve, 1));
    }
    return pending;
  }
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'camofox-native-idle-'));
    nativeWindows = []; commands = [];
    nativeReadback = jest.fn(async () => nativeWindows);
    visibility = await createSharedIdentityVisibility(display, { rootDir: root, timeoutMs: 2000, nativeReadback });
    const background = await fs.readFile(path.join(visibility.addon, 'background.js'), 'utf8');
    endpoint = background.match(/const endpoint=("[^"]+")/)[1];
    endpoint = JSON.parse(endpoint);
    await respond('create', () => visibility.newPage({ pages: () => page ? [page] : [] }), command => {
      page = { url: () => command.url, isClosed: () => false };
      return {};
    });
    const reservation = await post({ windowId: 7 }, '/geometry');
    nativeWindows = [{ number: 77, ...reservation.bounds }];
    expect((await post({ windowId: 7 }, '/geometry')).number).toBe(77);
  });
  afterEach(async () => { await visibility?.close(); await fs.rm(root, { recursive: true, force: true }); page = null; });

  test('fresh exact native binding proves a parked page remains hidden without moving it', async () => {
    await respond('locate', () => visibility.refresh(page));
    expect(visibility.isPageVisible(page)).toBe(false);
    expect(nativeReadback).toHaveBeenCalled();
    expect(commands.map(command => command.action)).toEqual(['create', 'locate']);
  });
  test('an externally moved native window becomes visible before idle cleanup', async () => {
    expect(visibility.isPageVisible(page)).toBe(false);
    nativeWindows = [{ ...nativeWindows[0], left: 40, top: 40 }];
    await respond('locate', () => visibility.refresh(page));
    expect(visibility.isPageVisible(page)).toBe(true);
  });
  test('tab moved into an unverified window cannot inherit its old parked proof', async () => {
    await respond('locate', () => visibility.refresh(page), () => ({ windowId: 8 }));
    expect(visibility.isPageVisible(page)).toBe(true);
  });
  test.each(['missing', 'ambiguous'])('%s exact native window fails closed', async mode => {
    nativeWindows = mode === 'missing' ? [] : [nativeWindows[0], nativeWindows[0]];
    await respond('locate', () => visibility.refresh(page));
    expect(visibility.isPageVisible(page)).toBe(true);
  });
  test('an unrelated parked window cannot lend proof to a user-visible target', async () => {
    nativeWindows = [{ ...nativeWindows[0], number: 88 }, { ...nativeWindows[0], left: 40, top: 40 }];
    await respond('locate', () => visibility.refresh(page));
    expect(visibility.isPageVisible(page)).toBe(true);
  });
  test('transient missing proof recovers only after a fresh exact parked read', async () => {
    const parked = nativeWindows[0];
    nativeWindows = [];
    await respond('locate', () => visibility.refresh(page));
    expect(visibility.isPageVisible(page)).toBe(true);
    nativeWindows = [parked];
    await respond('locate', () => visibility.refresh(page));
    expect(visibility.isPageVisible(page)).toBe(false);
  });
  test.each(['topology', 'windowSize'])('%s invalidation stays protected until an explicit visibility command rebinds', async mode => {
    if (mode === 'topology') visibility.updateDisplay({ ...display, park: { ...display.park, width: 3359 } });
    else visibility.setWindowSize({ width: 1200, height: 900 });
    await respond('locate', () => visibility.refresh(page));
    expect(visibility.isPageVisible(page)).toBe(true);
    expect(commands.map(command => command.action)).toEqual(['create', 'locate']);
  });
  test('native read failure aborts cleanup rather than trusting cached parked geometry', async () => {
    nativeReadback.mockRejectedValueOnce(Error('readback unavailable'));
    await expect(respond('locate', () => visibility.refresh(page))).rejects.toThrow('readback unavailable');
  });
  test('a managed popup located at registration is provably parked for cleanup without another evaluate', async () => {
    const popup = fakePopupPage();
    await bindNativeWindow(9, 99);
    // Registration path: page-registry asks the controller to locate popups.
    await ackLocates(() => visibility.locatePage(popup), { windowId: 9, tabId: 90 });
    expect(popup.title).toBe('Popup target'); // title marker restored
    const evaluates = popup.evaluate.mock.calls.length;
    expect(evaluates).toBeGreaterThan(0);
    await ackLocates(() => visibility.refresh(popup), { windowId: 9, tabId: 90 });
    expect(visibility.isPageVisible(popup)).toBe(false);
    expect(popup.evaluate.mock.calls.length).toBe(evaluates); // cleanup used the bound tabId only
  });
  test('cleanup makes one bounded locate for an unbound popup and then proves it parked', async () => {
    const popup = fakePopupPage();
    await bindNativeWindow(9, 99);
    await ackLocates(() => visibility.refresh(popup), { windowId: 9, tabId: 90 });
    expect(visibility.isPageVisible(popup)).toBe(false);
    expect(popup.evaluate).toHaveBeenCalled();
    expect(popup.title).toBe('Popup target');
    // The fallback locate bound the page: the next refresh needs no evaluate.
    const evaluates = popup.evaluate.mock.calls.length;
    await ackLocates(() => visibility.refresh(popup), { windowId: 9, tabId: 90 });
    expect(visibility.isPageVisible(popup)).toBe(false);
    expect(popup.evaluate.mock.calls.length).toBe(evaluates);
  });
  test('a located popup whose exact native window is on the main display stays protected', async () => {
    const popup = fakePopupPage();
    await bindNativeWindow(9, 99);
    nativeWindows = nativeWindows.map(w => w.number === 99 ? { ...w, left: 40, top: 40 } : w);
    await ackLocates(() => visibility.refresh(popup), { windowId: 9, tabId: 90 });
    expect(visibility.isPageVisible(popup)).toBe(true);
  });
  test('a hung popup evaluate fails the bounded locate closed instead of blocking cleanup', async () => {
    const popup = fakePopupPage({ hang: true });
    const started = Date.now();
    await visibility.refresh(popup); // locate deadline is min(timeoutMs=2000, 3000)
    expect(Date.now() - started).toBeLessThan(5000);
    expect(visibility.isPageVisible(popup)).toBe(true);
    expect(popup.evaluate).toHaveBeenCalledTimes(1);
  }, 15000);
});
