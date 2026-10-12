import { jest } from '@jest/globals';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { findParkDisplay, selectParkDisplay, windowBounds } from '../../lib/park-display-launcher.js';
import { createSharedIdentityVisibility, prepareParkedProfile, visibilityAddonFiles } from '../../lib/shared-identity-visibility.js';
import { createSharedIdentityWindowOpener } from '../../lib/shared-identity-window.js';
import { createSharedIdentityRequestTracker } from '../../lib/shared-identity-requests.js';
import { launchSharedIdentityContext } from '../../lib/shared-identity-launch.js';
import { createPageWithSessionRecovery } from '../../lib/new-page-recovery.js';

const screens = [{ name: 'Main', x: 0, y: 0, width: 2048, height: 1152 },
  { name: 'DeskPad Display', x: -3360, y: 1152, width: 3360, height: 2100 }];
const display = selectParkDisplay(screens);

function page(url, title = 'Original title') {
  const document = { title };
  return { document, state: { input: 'unsaved form state' }, url: () => url, isClosed: () => false,
    evaluate: jest.fn(async (fn, args) => vm.runInNewContext(`(${fn.toString()})(args)`, { document, args })) };
}

describe('virtual display selection and launch', () => {
  test('NSScreen bottom-left coordinates become browser top-left coordinates', () => {
    expect(display).toEqual({ name: 'DeskPad Display', main: { left: 0, top: 0, width: 2048, height: 1152 },
      park: { left: -3360, top: -2100, width: 3360, height: 2100 } });
    expect(windowBounds(display.park)).toEqual({ left: -3320, top: -2060, width: 1280, height: 900, focused: false, state: 'normal' });
    expect(selectParkDisplay(screens, 'DeskPad Display')).toEqual(display);
  });
  test('no park display uses legacy behavior, never selecting the main display', async () => {
    expect(selectParkDisplay(screens.slice(0, 1))).toBeNull();
    expect(selectParkDisplay(screens, 'Main')).toBeNull();
    expect(selectParkDisplay(screens, 'missing')).toBeNull();
    const execute = jest.fn();
    expect(await findParkDisplay({ platform: 'linux', execute })).toBeNull();
    expect(await findParkDisplay({ platform: 'darwin', name: 'off', execute })).toBeNull();
    expect(execute).not.toHaveBeenCalled();
  });
  test('native discovery uses a finite timeout and a whitelisted environment', async () => {
    const execute = jest.fn(async () => ({ stdout: JSON.stringify(screens) }));
    expect(await findParkDisplay({ platform: 'darwin', execute })).toEqual(display);
    expect(execute.mock.calls[0][2]).toMatchObject({ timeout: 5000, env: { PATH: '/usr/bin:/bin', HOME: os.homedir() } });
    expect(Object.keys(execute.mock.calls[0][2].env)).toEqual(['PATH', 'HOME']);
  });
  test('headed shared launch suppresses foreground and keeps the existing indicator/extension launch path', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'park-launch-'));
    const firefox = { launchPersistentContext: jest.fn(async () => ({})) };
    try {
      await launchSharedIdentityContext(root, { headed: true, visibility: { addon: '/fake/parking-addon' }, firefox,
        launchOptions: async value => value, os: { platform: () => 'darwin' }, getHostOS: () => 'macos',
        config: {}, events: { emitAsync: async () => {} } });
      expect(firefox.launchPersistentContext).toHaveBeenCalledTimes(1);
      expect(firefox.launchPersistentContext.mock.calls[0][1]).toMatchObject({ headless: false,
        ignoreDefaultArgs: ['-foreground'], addons: ['/fake/parking-addon'], config: { allowAddonNewtab: true } });
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
  test('initial profile geometry is parked without overwriting unrelated UI state', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'park-profile-'));
    try {
      const key = 'chrome://browser/content/browser.xhtml';
      await fs.writeFile(path.join(root, 'xulstore.json'), JSON.stringify({ other: { value: 'retained' }, [key]: { sidebar: { open: true }, 'main-window': { custom: 'retained' } } }));
      await prepareParkedProfile(root, windowBounds(display.park));
      const data = JSON.parse(await fs.readFile(path.join(root, 'xulstore.json'), 'utf8'));
      expect(data.other).toEqual({ value: 'retained' });
      expect(data[key].sidebar).toEqual({ open: true });
      expect(data[key]['main-window']).toMatchObject({ custom: 'retained', screenX: '-3320', screenY: '-2060', sizemode: 'normal' });
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
});

describe('no-relaunch visibility with two concurrent callers', () => {
  let root, visibility, context, windows, intervals, nextId, onCreated, browser, script;
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'park-visibility-'));
    context = new EventEmitter();
    context.livePages = [];
    context.pages = () => context.livePages;
    context.close = jest.fn();
    windows = new Map(); intervals = []; nextId = 1;
    browser = {
      windows: {
        onCreated: { addListener: fn => { onCreated = fn; } },
        onRemoved: { addListener() {} },
        getAll: async () => [...windows.values()],
        update: jest.fn(async (id, bounds) => { const w = windows.get(id); if (!w) throw Error('window ended'); Object.assign(w, bounds); return w; }),
        create: async ({ url, ...bounds }) => {
          const id = nextId++;
          const p = page(url);
          const tab = { id, windowId: id, page: p, url };
          const w = { id, tabs: [tab], ...bounds };
          windows.set(id, w); context.livePages.push(p); context.emit('page', p); await onCreated(w);
          return w;
        },
      },
      tabs: {
        update: async () => {},
        query: async ({ title }) => [...windows.values()].flatMap(w => w.tabs).filter(t => title == null || t.page.document.title === title),
      },
    };
    visibility = await createSharedIdentityVisibility(display, { rootDir: root, timeoutMs: 2000 });
    script = await fs.readFile(path.join(visibility.addon, 'background.js'), 'utf8');
    vm.runInNewContext(script, { browser, fetch, setInterval: fn => { const id = setInterval(fn, 10); intervals.push(id); return id; } });
    await visibility.attach(context);
  });
  afterEach(async () => { for (const id of intervals) clearInterval(id); await visibility.close(); await fs.rm(root, { recursive: true, force: true }); });

  test('caller B open/release preserves caller A page, URL, registration and unsaved form state without any identity gate', async () => {
    const a = await visibility.newPage(context);
    const b = await visibility.newPage(context);
    const groupA = new Map([['A', { page: a }]]), groupB = new Map([['B', { page: b }]]);
    const session = { context, visibility, createPage: () => visibility.newPage(context), tabGroups: new Map([['caller-a', groupA], ['caller-b', groupB]]) };
    const sessions = new Map([['identity', session]]);
    const closeSession = jest.fn();
    const isBusy = jest.fn(() => true);
    const getSession = jest.fn(async () => session);
    const opener = createSharedIdentityWindowOpener({ parkingEnabled: true, sessions, manager: {}, closeSession, isBusy, getSession,
      registerPage: (_session, _userId, p) => p === a ? 'A' : 'B' });
    const result = await opener.openWindow('identity', 'B');
    expect(result).toMatchObject({ tabId: 'B', restarted: false });
    expect(windows.get(1)).toMatchObject(windowBounds(display.park));
    expect(windows.get(2)).toMatchObject(windowBounds(display.main, true));
    expect(await visibility.release()).toBe(true);
    expect(groupA.get('A').page).toBe(a);
    expect(a.url()).toContain('about:blank#camofox-');
    expect(a.state.input).toBe('unsaved form state');
    expect(a.isClosed()).toBe(false);
    expect(context.pages()).toEqual([a, b]);
    expect(a.evaluate).not.toHaveBeenCalled();
    expect(b.evaluate).not.toHaveBeenCalled();
    expect(context.close).not.toHaveBeenCalled();
    expect(closeSession).not.toHaveBeenCalled();
    expect(isBusy).not.toHaveBeenCalled();
    expect(opener.transitioning('identity')).toBe(false);
    const res = new EventEmitter(); res.status = jest.fn(() => res); res.json = jest.fn();
    const next = jest.fn();
    createSharedIdentityRequestTracker({ getSessions: () => sessions, manager: { owns: () => true, closings: new Map() },
      normalizeUserId: String, transitioning: opener.transitioning, requests: new Map(), findTab: (s, id) => ({ tabState: s.tabGroups.get('caller-a').get(id) }) })({ path: '/tabs/A/navigate' }, res, next);
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });
  test('page-recovery construction uses the parked page factory, not context.newPage', async () => {
    const target = page('about:blank');
    const s = { context: { newPage: jest.fn(() => { throw Error('unparked creation'); }) }, createPage: jest.fn(async () => target) };
    const result = await createPageWithSessionRecovery({ session: s, userId: 'identity', withTimeout: value => value });
    expect(result.page).toBe(target);
    expect(s.createPage).toHaveBeenCalledTimes(1);
    expect(s.context.newPage).not.toHaveBeenCalled();
  });
  test('background restarts never park a window already handed to a human', async () => {
    const a = await visibility.newPage(context), b = await visibility.newPage(context);
    await visibility.open(b);
    for (const id of intervals) clearInterval(id);
    vm.runInNewContext(script, { browser, fetch, setInterval: fn => { const id = setInterval(fn, 10); intervals.push(id); return id; } });
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(windows.get(2)).toMatchObject(windowBounds(display.main, true));
    expect(windows.get(1)).toMatchObject(windowBounds(display.park));
    expect(context.pages()).toEqual([a, b]);
  });
  test('release affects the latest handoff only; idle release parks all visible windows', async () => {
    const a = await visibility.newPage(context), b = await visibility.newPage(context);
    await Promise.all([visibility.open(a), visibility.open(b)]);
    expect(visibility.visible.size).toBe(2);
    await visibility.release();
    expect(visibility.visible.size).toBe(1);
    await visibility.release({ all: true });
    expect(visibility.visible.size).toBe(0);
    expect(windows.get(1)).toMatchObject(windowBounds(display.park));
    expect(windows.get(2)).toMatchObject(windowBounds(display.park));
    expect(context.pages()).toEqual([a, b]);
  });
  test('UI-created tabs with identical URLs resolve independently and restore their own titles', async () => {
    const a = await visibility.newPage(context), b = page(a.url(), 'UI title');
    windows.set(2, { id: 2, tabs: [{ id: 2, windowId: 2, page: b }] }); context.livePages.push(b);
    await visibility.open(b);
    expect(windows.get(2)).toMatchObject(windowBounds(display.main, true));
    expect(windows.get(1)).toMatchObject(windowBounds(display.park));
    expect(b.document.title).toBe('UI title');
    expect(a.evaluate).not.toHaveBeenCalled();
  });
  test('visibility add-on has no page content scripts or web-accessible resources', () => {
    const manifest = JSON.parse(visibilityAddonFiles({ endpoint: 'http://127.0.0.1:1/private', park: {}, main: {} })['manifest.json']);
    expect(manifest.content_scripts).toBeUndefined(); expect(manifest.web_accessible_resources).toBeUndefined();
  });
});
