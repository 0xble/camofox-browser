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
  test('native read failure aborts cleanup rather than trusting cached parked geometry', async () => {
    nativeReadback.mockRejectedValueOnce(Error('readback unavailable'));
    await expect(respond('locate', () => visibility.refresh(page))).rejects.toThrow('readback unavailable');
  });
});
