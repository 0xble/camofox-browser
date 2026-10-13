import { jest } from '@jest/globals';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { findParkDisplay, selectParkDisplay, windowBounds } from '../../lib/park-display-launcher.js';
import { createSharedIdentityVisibility, prepareParkedProfile, visibilityAddonFiles, launchWithVisibilityFallback, cleanupVisibilityAddons } from '../../lib/shared-identity-visibility.js';
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
  test('defaults ignore physical second monitors and find virtual displays by name', () => {
    const physical = { ...screens[1], name: 'DELL U2723QE' };
    expect(selectParkDisplay([screens[0], physical])).toBeNull();
    expect(selectParkDisplay([screens[0], physical, screens[1]])).toEqual(display);
    for (const name of ['deskPAD Display', 'BetterDisplay Dummy', 'Virtual Display']) {
      expect(selectParkDisplay([screens[0], { ...physical, name }]).name).toBe(name);
    }
    expect(selectParkDisplay([screens[0], { ...physical, name: 'BetterDisplay physical monitor' }])).toBeNull();
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

describe('parking initialization failures', () => {
  test.each(['create', 'prepare', 'attach', 'launch'])('%s failure falls back once and leaves the identity usable', async stage => {
    const failure = new Error('parking broke');
    const parked = { close: jest.fn(async () => {}), once: jest.fn() };
    const legacy = {};
    const visibility = { park: {}, attach: jest.fn(async () => { if (stage === 'attach') throw failure; }), close: jest.fn(async () => {}) };
    const createVisibility = jest.fn(async () => { if (stage === 'create') throw failure; return visibility; });
    const prepareProfile = jest.fn(async () => { if (stage === 'prepare') throw failure; });
    const launch = jest.fn(async options => { if (options.visibility && stage === 'launch') throw failure; return options.visibility ? parked : legacy; });
    const log = jest.fn();
    expect(await launchWithVisibilityFallback({ display, profilePath: 'unused', launch, log, createVisibility, prepareProfile })).toBe(legacy);
    expect(legacy.sharedIdentityVisibility).toBeNull();
    expect(launch.mock.calls.at(-1)[0]).toEqual({ headed: false, visibility: null });
    expect(log).toHaveBeenCalledTimes(1);
    expect(parked.close).toHaveBeenCalledTimes(stage === 'attach' ? 1 : 0);
    expect(visibility.close).toHaveBeenCalledTimes(stage === 'create' ? 0 : 1);
  });
  test('visibility failure restores profile geometry before legacy fallback', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'park-fallback-'));
    const key = 'chrome://browser/content/browser.xhtml';
    const original = { [key]: { 'main-window': { screenX: '10', screenY: '20', width: '800', height: '600', custom: 'retained' } } };
    try {
      await fs.writeFile(path.join(root, 'xulstore.json'), JSON.stringify(original));
      const visibility = { park: windowBounds(display.park), attach: async () => { throw Error('attach failed'); }, close: async () => {} };
      const parked = { close: async () => {}, once: () => {} };
      const legacy = {};
      let legacyProfile;
      const launch = jest.fn(async options => {
        if (options.visibility) return parked;
        legacyProfile = JSON.parse(await fs.readFile(path.join(root, 'xulstore.json'), 'utf8'));
        return legacy;
      });
      const prepareProfile = profile => prepareParkedProfile(profile, windowBounds(display.park));
      await expect(launchWithVisibilityFallback({ display, profilePath: root, launch, createVisibility: async () => visibility, prepareProfile }))
        .resolves.toBe(legacy);
      expect(legacyProfile).toEqual(original);
      expect(JSON.parse(await fs.readFile(path.join(root, 'xulstore.json'), 'utf8'))).toEqual(original);
      expect(launch.mock.calls.at(-1)[0]).toEqual({ headed: false, visibility: null });
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
  test('an /open whose parking init fails falls back straight to a headed launch', async () => {
    const legacy = {};
    const launch = jest.fn(async options => options.visibility ? { close: async () => {}, once() {} } : legacy);
    const visibility = { park: {}, attach: async () => { throw Error('attach failed'); }, close: async () => {} };
    expect(await launchWithVisibilityFallback({ display, profilePath: 'unused', fallbackHeaded: true, launch,
      createVisibility: async () => visibility, prepareProfile: async () => {} })).toBe(legacy);
    expect(launch.mock.calls.map(call => call[0].headed)).toEqual([true, true]);
    expect(launch.mock.calls.at(-1)[0]).toEqual({ headed: true, visibility: null });
    expect(legacy.sharedIdentityHeaded).toBe(true);
  });
  test('the opener focuses a headed fallback session instead of relaunching it', async () => {
    const p = { isClosed: () => false };
    const session = { headed: true, visibility: null, tabGroups: new Map() };
    const sessions = new Map();
    const getSession = jest.fn(async () => { sessions.set('identity', session); return session; });
    const closeSession = jest.fn(), focus = jest.fn(async () => p);
    const opener = createSharedIdentityWindowOpener({ parkingEnabled: true, sessions, manager: { failedClosures: new Map(), focus },
      getSession, closeSession, registerPage: () => 'T', isBusy: () => false });
    expect(await opener.openWindow('identity')).toMatchObject({ focused: true, tabId: 'T' });
    expect(getSession).toHaveBeenCalledTimes(1); expect(getSession).toHaveBeenCalledWith('identity', { parkedOpen: true });
    expect(closeSession).not.toHaveBeenCalled(); expect(focus).toHaveBeenCalledTimes(1);
  });
  test('a fallback context still opens its requested tab through the legacy path', async () => {
    const p = { isClosed: () => false, bringToFront: jest.fn(async () => {}) };
    const session = { headed: true, visibility: null, tabGroups: new Map([['caller', new Map([['B', { page: p }]])]]) };
    const sessions = new Map([['identity', session]]);
    const opener = createSharedIdentityWindowOpener({ parkingEnabled: true, sessions,
      manager: { failedClosures: new Map() }, getSession: async () => session,
      closeSession: jest.fn(), registerPage: () => 'B', isBusy: () => false });
    expect(await opener.openWindow('identity', 'B')).toMatchObject({ focused: true, tabId: 'B' });
    expect(p.bringToFront).toHaveBeenCalledTimes(1);
  });
  test('unconfirmed profile ownership blocks fallback instead of double launching', async () => {
    const context = { close: async () => { throw Error('close failed'); }, once() {} };
    const launch = jest.fn(async () => context);
    const visibility = { park: {}, attach: async () => { throw Error('attach failed'); }, close: async () => {} };
    await expect(launchWithVisibilityFallback({ display, profilePath: 'unused', launch, createVisibility: async () => visibility, prepareProfile: async () => {} }))
      .rejects.toMatchObject({ profileOwnershipUnconfirmed: true });
    expect(launch).toHaveBeenCalledTimes(1);
  });
  test.each(['{corrupt', 'null', '[]', '{"chrome://browser/content/browser.xhtml":[]}'])('invalid xulstore %s is rebuilt', async value => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'park-corrupt-'));
    try {
      await fs.writeFile(path.join(root, 'xulstore.json'), value);
      await prepareParkedProfile(root, windowBounds(display.park));
      const data = JSON.parse(await fs.readFile(path.join(root, 'xulstore.json'), 'utf8'));
      expect(data['chrome://browser/content/browser.xhtml']['main-window'].screenX).toBe('-3320');
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
  test('startup reaps dead-owner add-ons but preserves active server add-ons', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'park-cleanup-'));
    const dead = path.join(root, '00000000-0000-0000-0000-000000000000');
    const alive = path.join(root, '00000000-0000-0000-0000-000000000001');
    try {
      for (const [dir, pid] of [[dead, 2147483647], [alive, process.pid]]) {
        await fs.mkdir(dir); await fs.writeFile(path.join(dir, 'owner.json'), JSON.stringify({ pid }));
      }
      await cleanupVisibilityAddons(root);
      await expect(fs.access(dead)).rejects.toMatchObject({ code: 'ENOENT' }); await expect(fs.access(alive)).resolves.toBeUndefined();
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
});

describe('no-relaunch visibility with two concurrent callers', () => {
  let root, visibility, context, windows, intervals, nextId, onCreated, onTabRemoved, browser, script;
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
        get: async id => { const w = windows.get(id); if (!w) throw Error('window ended'); return w; },
        update: jest.fn(async (id, bounds) => { const w = windows.get(id); if (!w) throw Error('window ended'); Object.assign(w, bounds); return w; }),
        remove: jest.fn(async id => {
          const w = windows.get(id); windows.delete(id);
          if (w) context.livePages = context.livePages.filter(p => !w.tabs.some(t => t.page === p));
        }),
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
        onRemoved: { addListener: fn => { onTabRemoved = fn; } },
        update: async () => {},
        get: async id => { const t = [...windows.values()].flatMap(w => w.tabs).find(t => t.id === id); if (!t) throw Error('tab ended'); return t; },
        query: async ({ title, windowId } = {}) => [...windows.values()].flatMap(w => w.tabs).filter(t => (title == null || t.page.document.title === title) && (windowId == null || t.windowId === windowId)),
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
  test('popup from a visible window inherits visibility, while new API windows stay parked', async () => {
    const a = await visibility.newPage(context); await visibility.open(a);
    const popup = page('https://fixture.test/oauth');
    const w = { id: 50, tabs: [{ id: 50, windowId: 50, openerTabId: 1, page: popup, url: popup.url() }], ...windowBounds(display.main, true) };
    windows.set(50, w); context.livePages.push(popup); await onCreated(w);
    expect(w).toMatchObject(windowBounds(display.main, true));
    expect(visibility.visible.has(50)).toBe(true);
    await visibility.newPage(context);
    expect(windows.get(2)).toMatchObject(windowBounds(display.park));
    expect(visibility.visible.has(2)).toBe(false);
  });
  test('background restart preserves a UI popup and does not relabel previously parked API windows', async () => {
    const a = await visibility.newPage(context), b = await visibility.newPage(context);
    await visibility.open(b);
    for (const id of intervals) clearInterval(id);
    const popup = page('https://fixture.test/oauth');
    windows.set(50, { id: 50, tabs: [{ id: 50, windowId: 50, openerTabId: 2, page: popup, url: popup.url() }], ...windowBounds(display.park) });
    context.livePages.push(popup);
    vm.runInNewContext(script, { browser, fetch, setInterval: fn => { const id = setInterval(fn, 10); intervals.push(id); return id; } });
    await new Promise(resolve => setTimeout(resolve, 60));
    expect(windows.get(50)).toMatchObject(windowBounds(display.main, true));
    expect(visibility.visible.has(50)).toBe(true);
    expect(windows.get(1)).toMatchObject(windowBounds(display.park)); expect(visibility.visible.has(1)).toBe(false);
    expect(context.pages()).toEqual([a, b, popup]);
  });
  test('targeted release leaves the other callers visible window alone', async () => {
    const a = await visibility.newPage(context), b = await visibility.newPage(context);
    await visibility.open(b); await visibility.open(a);
    expect(await visibility.release({ page: b })).toBe(true);
    expect(windows.get(1)).toMatchObject(windowBounds(display.main, true));
    expect(windows.get(2)).toMatchObject(windowBounds(display.park));
    expect(visibility.visible.has(1)).toBe(true);
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
  test.each([['latest', {}], ['all', { all: true }]])('%s release parks the recorded handoff window after its original tab moves', async (_mode, options) => {
    const a = await visibility.newPage(context), b = await visibility.newPage(context), c = await visibility.newPage(context);
    await visibility.open(c); await visibility.open(a);
    const human = page('https://fixture.test/checkout');
    const original = windows.get(1), destination = windows.get(2);
    const tab = original.tabs.pop(); tab.windowId = 2;
    destination.tabs.push(tab);
    original.tabs.push({ id: 99, windowId: 1, page: human, url: human.url(), active: true });
    context.livePages.push(human);
    browser.windows.update.mockClear();

    expect(await visibility.release(options)).toBe(true);
    expect(original).toMatchObject(windowBounds(display.park));
    expect(destination).toMatchObject(windowBounds(display.park));
    expect(browser.windows.update.mock.calls.map(([id]) => id).sort()).toEqual(options.all ? [1, 3] : [1]);
    expect([...visibility.visible.keys()]).toEqual(options.all ? [] : [3]);
    expect(windows.get(3)).toMatchObject(options.all ? windowBounds(display.park) : windowBounds(display.main, true));
    expect(await visibility.release(options)).toBe(!options.all);
    expect(await visibility.release({ all: true })).toBe(false);
    expect(visibility.visible.size).toBe(0);
    expect(context.pages()).toEqual([a, b, c, human]);
    expect(a.state.input).toBe('unsaved form state');
    expect(context.close).not.toHaveBeenCalled();
    expect(browser.windows.remove).not.toHaveBeenCalled();
  });
  test('explicit page release follows its moved tab instead of the recorded handoff window', async () => {
    const a = await visibility.newPage(context), b = await visibility.newPage(context);
    await visibility.open(a); await visibility.open(b);
    const original = windows.get(1), destination = windows.get(2);
    const tab = original.tabs.pop(); tab.windowId = 2; destination.tabs.push(tab);
    original.tabs.push({ id: 99, windowId: 1, page: page('https://fixture.test/checkout'), active: true });
    browser.windows.update.mockClear();

    expect(await visibility.release({ page: a })).toBe(true);
    expect(browser.windows.update.mock.calls.map(([id]) => id)).toEqual([2]);
    expect(original).toMatchObject(windowBounds(display.main, true));
    expect(destination).toMatchObject(windowBounds(display.park));
    expect([...visibility.visible.keys()]).toEqual([1]);
    expect(await visibility.release({ all: true })).toBe(true);
    expect(original).toMatchObject(windowBounds(display.park));
    expect(visibility.visible.size).toBe(0);
  });
  test.each([['latest', {}], ['all', { all: true }]])('%s release drops a missing handoff window even when its original tab survives elsewhere', async (_mode, options) => {
    const a = await visibility.newPage(context); await visibility.newPage(context);
    await visibility.open(a);
    const tab = windows.get(1).tabs.pop(); tab.windowId = 2; windows.get(2).tabs.push(tab);
    windows.delete(1);
    browser.windows.update.mockClear();

    expect(await visibility.release(options)).toBe(true);
    expect(visibility.visible.size).toBe(0);
    expect(browser.windows.update).not.toHaveBeenCalled();
    expect(windows.get(2)).toMatchObject(windowBounds(display.park));
    expect(await visibility.release(options)).toBe(false);
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
  test('title rewriting SPAs can still be located and the latest app title is preserved', async () => {
    const p = page('https://fixture.test/spa');
    windows.set(50, { id: 50, tabs: [{ id: 50, windowId: 50, page: p, url: p.url() }] });
    context.livePages.push(p);
    let n = 0; const timer = setInterval(() => { p.document.title = `SPA ${++n}`; }, 7);
    try { await visibility.open(p); expect(windows.get(50)).toMatchObject(windowBounds(display.main, true)); }
    finally { clearInterval(timer); }
    expect(p.document.title).toMatch(/^SPA /);
  });
  test('simultaneous first-time UI show/release shares one title association', async () => {
    const p = page('https://fixture.test/ui');
    windows.set(50, { id: 50, tabs: [{ id: 50, windowId: 50, page: p, url: p.url() }], ...windowBounds(display.park) });
    context.livePages.push(p);
    await Promise.all([visibility.open(p), visibility.release({ page: p })]);
    expect(windows.get(50)).toMatchObject(windowBounds(display.park));
    expect(visibility.visible.has(50)).toBe(false); expect(p.document.title).toBe('Original title');
  });
  test('commands on the same window serialize show then release', async () => {
    const p = await visibility.newPage(context);
    const original = browser.windows.update.getMockImplementation();
    let active = 0, maxActive = 0;
    browser.windows.update.mockImplementation(async (...args) => {
      maxActive = Math.max(maxActive, ++active);
      await new Promise(resolve => setTimeout(resolve, 30));
      try { return await original(...args); } finally { active--; }
    });
    await Promise.all([visibility.open(p), visibility.release({ page: p })]);
    expect(maxActive).toBe(1);
    expect(windows.get(1)).toMatchObject(windowBounds(display.park));
    expect(visibility.visible.size).toBe(0);
  });
  test('show then release stays serialized when its tab moves while queued', async () => {
    const p = await visibility.newPage(context), blocker = await visibility.newPage(context);
    const source = windows.get(1), originalTab = source.tabs[0];
    const blockerTab = windows.get(2).tabs.pop(); blockerTab.windowId = 1; source.tabs.push(blockerTab);
    const destination = { id: 3, tabs: [], ...windowBounds(display.park) };
    windows.set(3, destination);
    let queuedLookupStarted, parkLookupStarted;
    const queuedLookup = new Promise(resolve => { queuedLookupStarted = resolve; });
    const parkLookup = new Promise(resolve => { parkLookupStarted = resolve; });
    const originalGet = browser.tabs.get;
    let lookups = 0;
    browser.tabs.get = async id => {
      const tab = { ...await originalGet(id) };
      if (id === originalTab.id) {
        if (++lookups === 1) queuedLookupStarted();
        if (lookups >= 3) parkLookupStarted();
      }
      return tab;
    };
    let releaseSource, sourceStarted, releaseShow, showStarted, active = 0, maxActive = 0;
    const sourceBlocked = new Promise(resolve => { releaseSource = resolve; });
    const sourceStart = new Promise(resolve => { sourceStarted = resolve; });
    const showBlocked = new Promise(resolve => { releaseShow = resolve; });
    const showStart = new Promise(resolve => { showStarted = resolve; });
    const originalUpdate = browser.windows.update.getMockImplementation();
    browser.windows.update.mockImplementation(async (id, bounds) => {
      if (id === destination.id) maxActive = Math.max(maxActive, ++active);
      try {
        if (bounds.focused && id === source.id) { sourceStarted(); await sourceBlocked; }
        if (bounds.focused && id === destination.id) { showStarted(); await showBlocked; }
        return await originalUpdate(id, bounds);
      } finally { if (id === destination.id) active--; }
    });
    const blocking = visibility.open(blocker); await sourceStart;
    const shown = visibility.open(p); await queuedLookup;
    // The source update stays pending while dispatch appends the second show.
    await new Promise(resolve => setTimeout(resolve, 30));
    source.tabs.splice(source.tabs.indexOf(originalTab), 1);
    originalTab.windowId = destination.id; destination.tabs.push(originalTab);
    releaseSource(); await blocking; await showStart;
    const released = visibility.release({ page: p });
    await parkLookup;
    // Allow the release to reach the destination queue while show is pending.
    await new Promise(resolve => setTimeout(resolve, 30));
    releaseShow(); await Promise.all([shown, released]);

    expect(destination).toMatchObject(windowBounds(display.park));
    expect([...visibility.visible.keys()]).toEqual([source.id]);
    expect(maxActive).toBe(1);
    expect(context.pages()).toEqual([p, blocker]);
    expect(p.state.input).toBe('unsaved form state');
    expect(context.close).not.toHaveBeenCalled();
    browser.tabs.get = originalGet;
  });
  test('moved tabs resolve their new window instead of cached creation geometry', async () => {
    const p = await visibility.newPage(context);
    const tab = windows.get(1).tabs.pop(); tab.windowId = 50;
    windows.set(50, { id: 50, tabs: [tab] });
    await visibility.open(p);
    expect(windows.get(50)).toMatchObject(windowBounds(display.main, true));
    expect(windows.get(1)).toMatchObject(windowBounds(display.park));
  });
  test('initial blank page events wait for the API fragment before UI registration', async () => {
    let url = 'about:blank';
    const p = { url: () => url, isClosed: () => false, waitForURL: async () => { url = 'about:blank#camofox-late'; } };
    expect(await visibility.shouldRegisterUIPage(p)).toBe(false);
  });
  test('a late create is closed and cannot become a registered UI page', async () => {
    const original = browser.windows.create;
    let resume, started;
    const start = new Promise(resolve => { started = resolve; });
    browser.windows.create = async args => { started(); await new Promise(resolve => { resume = resolve; }); return original(args); };
    const result = visibility.newPage(context);
    const failed = expect(result).rejects.toThrow('timed out');
    await start; await failed;
    const registered = [];
    context.on('page', p => { if (!visibility.isManagedPage(p)) registered.push(p); });
    resume(); await new Promise(resolve => setTimeout(resolve, 100));
    expect(browser.windows.remove).toHaveBeenCalledWith(1);
    expect(windows.size).toBe(0); expect(context.pages()).toEqual([]); expect(registered).toEqual([]);
  });
  test('expired creates reconcile after the add-on background restarts', async () => {
    const original = browser.windows.create;
    let created; const start = new Promise(resolve => { created = resolve; });
    browser.windows.create = async args => { const w = await original(args); created(); return new Promise(() => {}); };
    const failed = expect(visibility.newPage(context)).rejects.toThrow('timed out');
    await start; for (const id of intervals) clearInterval(id); await failed;
    expect(windows.size).toBe(1);
    vm.runInNewContext(script, { browser, fetch, setInterval: fn => { const id = setInterval(fn, 10); intervals.push(id); return id; } });
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(windows.size).toBe(0); expect(context.pages()).toEqual([]);
  });
  test('a late show is re-parked after caller receives a timeout', async () => {
    const p = await visibility.newPage(context);
    const original = browser.windows.update.getMockImplementation();
    let resume, started; const start = new Promise(resolve => { started = resolve; });
    browser.windows.update.mockImplementation(async (id, bounds) => {
      if (bounds.focused) { started(); await new Promise(resolve => { resume = resolve; }); }
      return original(id, bounds);
    });
    const failed = expect(visibility.open(p)).rejects.toThrow('timed out');
    await start; await failed; resume();
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(windows.get(1)).toMatchObject(windowBounds(display.park)); expect(visibility.visible.size).toBe(0);
  });
  test('a closed handoff tab inside a surviving window can still be parked, even if onRemoved was missed', async () => {
    const a = await visibility.newPage(context), b = await visibility.newPage(context);
    await visibility.open(a); await visibility.open(b);
    // A human opens a second tab in the handoff window, then closes the original.
    const w = windows.get(2), human = page('https://fixture.test/checkout');
    w.tabs.push({ id: 99, windowId: 2, page: human, url: human.url(), active: true });
    w.tabs = w.tabs.filter(t => t.id !== 2);
    expect(visibility.visible.get(2)).toMatchObject({ tabId: 2 });
    expect(await visibility.release()).toBe(true);
    expect(windows.get(2)).toMatchObject(windowBounds(display.park));
    expect(visibility.visible.has(2)).toBe(false);
    // The remaining handoff still parks, so release({ all }) is not stuck either.
    expect(await visibility.release({ all: true })).toBe(true);
    expect(visibility.visible.size).toBe(0);
    expect(windows.get(1)).toMatchObject(windowBounds(display.park));
  });
  test('tab removal re-keys the visible entry to a live tab in its window', async () => {
    const p = await visibility.newPage(context); await visibility.open(p);
    windows.get(1).tabs = [{ id: 7, windowId: 1, page: page('https://fixture.test/'), active: true }];
    await onTabRemoved(1, { windowId: 1, isWindowClosing: false });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(visibility.visible.get(1)).toEqual({ windowId: 1, tabId: 7 });
    expect(await visibility.release()).toBe(true);
    expect(windows.get(1)).toMatchObject(windowBounds(display.park)); expect(visibility.visible.size).toBe(0);
  });
  test('a visible window that vanished without onRemoved is dropped on release', async () => {
    const p = await visibility.newPage(context); await visibility.open(p);
    windows.delete(1);
    expect(await visibility.release({ all: true })).toBe(true);
    expect(visibility.visible.size).toBe(0); expect(visibility.visible.has(1)).toBe(false);
  });
  test('one failed park does not keep other handoffs visible, and the error still surfaces', async () => {
    const a = await visibility.newPage(context), b = await visibility.newPage(context);
    await visibility.open(a); await visibility.open(b);
    const original = browser.windows.update.getMockImplementation();
    browser.windows.update.mockImplementation(async (id, bounds) => { if (id === 1) throw Error('stuck window'); return original(id, bounds); });
    await expect(visibility.release({ all: true })).rejects.toThrow('1 of 2 window park operations failed');
    expect(windows.get(2)).toMatchObject(windowBounds(display.park));
    expect([...visibility.visible.keys()]).toEqual([1]);
  });
  test('a concurrent open timeout cannot roll back the preceding successful handoff', async () => {
    const p = await visibility.newPage(context);
    const original = browser.windows.update.getMockImplementation();
    let resumeFirst, resumeSecond, firstStarted, secondStarted, shows = 0;
    const firstStart = new Promise(resolve => { firstStarted = resolve; });
    const secondStart = new Promise(resolve => { secondStarted = resolve; });
    browser.windows.update.mockImplementation(async (id, bounds) => {
      if (bounds.focused) {
        if (++shows === 1) { firstStarted(); await new Promise(resolve => { resumeFirst = resolve; }); }
        else { secondStarted(); await new Promise(resolve => { resumeSecond = resolve; }); }
      }
      return original(id, bounds);
    });
    const first = visibility.open(p);
    await firstStart;
    const failed = expect(visibility.open(p)).rejects.toThrow('timed out');
    // Inspect the real HTTP bridge: both commands were issued while parked.
    const endpoint = JSON.parse(script.match(/^const endpoint=(.*);$/m)[1]);
    const queued = await (await fetch(endpoint)).json();
    expect(queued.commands.filter(c => c.action === 'show')).toHaveLength(2);
    expect(queued.visible).toEqual([]);
    resumeFirst(); await first; await secondStart;
    expect(visibility.visible.has(1)).toBe(true);
    await failed; resumeSecond();
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(windows.get(1)).toMatchObject(windowBounds(display.main, true));
    expect(visibility.visible.has(1)).toBe(true);
    expect(browser.windows.update.mock.calls.filter(([, bounds]) => !bounds.focused)).toHaveLength(0);
    expect(context.pages()).toEqual([p]); expect(p.state.input).toBe('unsaved form state');
    expect(context.close).not.toHaveBeenCalled();
  });
  test('an expired show never hides a window an earlier open already handed off', async () => {
    const p = await visibility.newPage(context);
    await visibility.open(p);
    const original = browser.windows.update.getMockImplementation();
    let resume, started; const start = new Promise(resolve => { started = resolve; });
    browser.windows.update.mockImplementation(async (id, bounds) => {
      if (bounds.focused) { started(); await new Promise(resolve => { resume = resolve; }); }
      return original(id, bounds);
    });
    const failed = expect(visibility.open(p)).rejects.toThrow('timed out');
    await start; await failed; resume();
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(windows.get(1)).toMatchObject(windowBounds(display.main, true));
    expect(visibility.visible.has(1)).toBe(true);
  });
  test('popups from parked tabs stay parked while another window is handed off', async () => {
    const a = await visibility.newPage(context), b = await visibility.newPage(context);
    await visibility.open(b);
    const popup = page('https://fixture.test/automation-popup');
    const w = { id: 60, tabs: [{ id: 60, windowId: 60, openerTabId: 1, page: popup, url: popup.url() }], ...windowBounds(display.park) };
    windows.set(60, w); context.livePages.push(popup); await onCreated(w);
    expect(w).toMatchObject(windowBounds(display.park));
    expect(visibility.visible.has(60)).toBe(false);
    expect(windows.get(2)).toMatchObject(windowBounds(display.main, true));
    expect(context.pages()).toEqual([a, b, popup]);
  });
  test('an opener-less UI window during a handoff still goes to the main display', async () => {
    const p = await visibility.newPage(context); await visibility.open(p);
    const ui = page('about:newtab');
    const w = { id: 61, tabs: [{ id: 61, windowId: 61, page: ui, url: ui.url() }], ...windowBounds(display.park) };
    windows.set(61, w); context.livePages.push(ui); await onCreated(w);
    expect(w).toMatchObject(windowBounds(display.main, true)); expect(visibility.visible.has(61)).toBe(true);
  });
  test('expired commands are acknowledged without creating a window', async () => {
    const emitted = [], jobs = [];
    const files = visibilityAddonFiles({ endpoint: 'fake', park: {}, main: {} });
    const expired = { id: 'expired', action: 'create', url: 'about:blank#camofox-expired', expiresAt: Date.now() - 1 };
    vm.runInNewContext(files['background.js'], { browser, setInterval: fn => jobs.push(fn), fetch: async (_url, opts) => {
      if (opts) { emitted.push(JSON.parse(opts.body)); return { json: async () => ({ accepted: false }) }; }
      return { json: async () => ({ commands: [expired], visible: [], parked: [] }) };
    } });
    await new Promise(resolve => setTimeout(resolve, 10)); await jobs[0]();
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(emitted).toContainEqual({ id: 'expired', error: 'expired' }); expect(windows.size).toBe(0);
  });
  test('visibility add-on has no page content scripts or web-accessible resources', () => {
    const manifest = JSON.parse(visibilityAddonFiles({ endpoint: 'http://127.0.0.1:1/private', park: {}, main: {} })['manifest.json']);
    expect(manifest.content_scripts).toBeUndefined(); expect(manifest.web_accessible_resources).toBeUndefined();
  });
});
