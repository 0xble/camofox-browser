import assert from 'node:assert/strict';
// Use the repository's Jest runner, or run this dependency-free regression with node --test.
const test = globalThis.test ?? (await import('node:test')).test;
import { EventEmitter, once } from 'node:events';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { launchWithVisibilityFallback } from '../../lib/shared-identity-visibility.js';
import { createDarwinIdentityVisibility, setDarwinAppHidden } from '../../lib/darwin-identity-visibility.js';
import { createSharedIdentityWindowOpener } from '../../lib/shared-identity-window.js';
import { applySharedTabHandoff } from '../../lib/shared-tab-handoff.js';

const source = await fs.readFile(new URL('../../server.js', import.meta.url), 'utf8');
function serverFunction(name, dependencies) {
  const start = source.indexOf(`async function ${name}(`);
  const end = source.indexOf('\n}\n', start) + 2;
  return vm.runInNewContext(`(${source.slice(start, end)})`, dependencies);
}

for (const all of [false, true]) {
  test(`single-display first acquisition and release (all=${all}) retain both tasks' live pages`, async () => {
    const a = { input: 'unsaved A', isClosed: () => false, url: () => 'https://form.test/a' };
    const b = { input: 'unsaved B', isClosed: () => false, url: () => 'https://form.test/b' };
    const context = new EventEmitter();
    context.pages = () => [a, b];
    let closed = 0, launched;
    context.close = async () => { closed++; a.input = b.input = ''; };
    const visible = new Map([[1, {}]]);
    const visibility = { visible, attach: async () => {}, open: async () => {}, release: async () => { visible.clear(); return true; } };
    const create = serverFunction('createSharedIdentityContext', {
      os: { platform: () => 'darwin' }, CONFIG: { sharedIdentityExtensions: [], sharedIdentityAliases: {}, identityColors: {} },
      refreshSharedParkDisplay: async () => null,
      createDarwinIdentityVisibility: () => visibility,
      createSharedIdentityVisibility: () => { throw Error('No secondary display exists'); },
      launchWithVisibilityFallback,
      launchSharedIdentityContext: async (_profile, options) => { launched = options; return context; },
      extensionsForIdentity: () => [], identityIndicator: () => null, launchOptions() {}, firefox: {}, getHostOS() {}, pluginEvents: {}, log() {}, proxyPool: null,
    });
    await create('identity', '/unused/profile', { headed: all });
    const session = { context, sharedIdentity: true, headed: true, visibility: context.sharedIdentityVisibility,
      tabGroups: new Map([['a', new Map([['tab-a', { page: a }]])], ['b', new Map([['tab-b', { page: b }]])]]) };
    const release = serverFunction('releaseIdentity', {
      sessions: new Map([['identity', session]]), sharedParkDisplay: null, sessionCreations: new Map(),
      identityBusy: () => false, closeSession: async () => context.close(), sharedIdentityLastUrls: new Map(), log() {},
    });
    await release('identity', { all });
    assert.equal(closed, 0, 'visibility release must never close the shared context');
    assert.equal(launched.headed, true);
    assert.equal(context.sharedIdentityVisibility, visibility, 'first acquisition must install a same-context controller');
    assert.deepEqual(context.pages(), [a, b]);
    assert.deepEqual([a.input, b.input], ['unsaved A', 'unsaved B']);
    assert.equal(session.headed, false);
  });
}

function controller(setHidden = async (_pid, hidden) => ({ hidden, active: !hidden, activated: !hidden })) {
  let processes = [{ pid: 12, ppid: 10, args: '/engine/camoufox -profile /test/profile -juggler-pipe' }];
  const visibility = createDarwinIdentityVisibility('/test/profile', { rootPid: 10, snapshot: () => processes, setHidden });
  return { visibility, forgetProcess: () => { processes = []; } };
}

test('first lazy open and repeated releases show/hide the same context without relaunching', async () => {
  const changes = [];
  const { visibility } = controller(async (pid, hidden) => { changes.push([pid, hidden]); return { hidden, active: !hidden, activated: !hidden }; });
  const page = { isClosed: () => false, bringToFront: async () => {}, url: () => 'https://form.test' };
  const session = { visibility, context: { pages: () => [page] }, tabGroups: new Map() };
  let acquisitions = 0;
  const sessions = new Map();
  const opener = createSharedIdentityWindowOpener({ sessions, parkingEnabled: true, manager: {},
    getSession: async () => { acquisitions++; sessions.set('identity', session); return session; },
    closeSession: () => assert.fail('must not close'), registerPage: () => 'tab-A', isBusy: () => false });
  await visibility.attach();
  for (let index = 0; index < 2; index++) {
    assert.equal((await opener.openWindow('identity')).restarted, false);
    assert.equal(await visibility.release({ all: true }), true);
    assert.equal(await visibility.release(), false);
  }
  assert.equal(acquisitions, 2);
  assert.equal(session.context.pages()[0], page);
  assert.deepEqual(changes.map(([, hidden]) => hidden), [true, false, true, true, false, true, true]);
  assert.ok(changes.every(([pid]) => pid === 12));
});

test('visibility requests run in caller order after failures without blocking another identity', async () => {
  const calls = [];
  let finishFirst;
  const first = new Promise(resolve => { finishFirst = resolve; });
  const { visibility } = controller(async (_pid, hidden) => {
    calls.push(hidden);
    if (calls.length === 1) { await first; throw Error('first hide failed'); }
    return { hidden, active: !hidden, activated: !hidden };
  });
  const failed = assert.rejects(visibility.attach(), /first hide failed/);
  const page = { bringToFront: async () => {} };
  const show = visibility.open(page);
  const hide = visibility.release();
  await new Promise(resolve => setImmediate(resolve));
  try {
    assert.deepEqual(calls, [true], 'same-identity native operations must not overlap');
    const other = controller().visibility;
    await other.attach();
    assert.equal(other.visible.size, 0);
  } finally { finishFirst(); await Promise.all([failed, show, hide]); }
  assert.deepEqual(calls, [true, false, true]);
  assert.equal(visibility.visible.size, 0, 'the last caller must win');
});

test('hide refusal reports failure and retains visible state without closing anything', async () => {
  const { visibility } = controller(async () => ({ hidden: false }));
  await assert.rejects(visibility.release(), /not confirmed/);
  assert.equal(visibility.visible.size, 1);
});

test('inactive native show is rejected by open and human handoff without claiming focus', async () => {
  const { visibility } = controller(async (_pid, hidden) => ({ hidden, active: false, activated: false }));
  await visibility.attach();
  const page = { isClosed: () => false, bringToFront: async () => {} };
  const session = { visibility, context: { pages: () => [page] }, tabGroups: new Map() };
  const opener = createSharedIdentityWindowOpener({ sessions: new Map([['identity', session]]), manager: {},
    getSession: async () => session, registerPage: () => 'tab-A', isBusy: () => false });
  await assert.rejects(opener.openWindow('identity'), /activation was not confirmed/);
  assert.equal(session.headed, true, 'visible but inactive must remain protected from expiry');
  const humans = new Set();
  await assert.rejects(applySharedTabHandoff({ tabId: 'A', handoff: 'human', tabState: { page }, session, humanControlledTabs: humans }), /activation was not confirmed/);
  assert.equal(humans.size, 0);
  const native = await setDarwinAppHidden(12, false, { execute: async (_file, args) => {
    const app = { isNil: () => false, terminated: false, hidden: true, active: false,
      get unhide() { this.hidden = false; }, activateWithOptions: () => false };
    const $ = { NSRunningApplication: { runningApplicationWithProcessIdentifier: () => app },
      NSRunLoop: { currentRunLoop: { runUntilDate() {} } }, NSDate: { dateWithTimeIntervalSinceNow() {} } };
    return { stdout: vm.runInNewContext(`${args[3]};run(['12','show'])`, { ObjC: { import() {} }, $, Boolean, JSON, Number, Error }) };
  } });
  assert.equal(native.hidden, false);
  assert.equal(native.active, false, 'read back native activation instead of equating unhide with focus');
  assert.equal(native.activated, false);
});

test('an unconfirmed show remains visible to expiry checks', async () => {
  let fail = false;
  const { visibility } = controller(async (_pid, hidden) => { if (fail) throw Error('readback failed'); return { hidden, active: !hidden, activated: !hidden }; });
  await visibility.attach();
  fail = true;
  await assert.rejects(visibility.open({ bringToFront: async () => {} }), /readback failed/);
  assert.equal(visibility.visible.size, 1);
});

test('native lookup is fresh and cannot act on a missing or reused browser PID', async () => {
  let calls = 0;
  const { visibility, forgetProcess } = controller(async (_pid, hidden) => { calls++; return { hidden, active: !hidden, activated: !hidden }; });
  await visibility.attach();
  forgetProcess();
  await assert.rejects(visibility.release(), /no single owned/);
  assert.equal(calls, 1);
});

test('application-wide release preserves another human-controlled task', async () => {
  let hides = 0;
  const { visibility } = controller(async (_pid, hidden) => { hides++; return { hidden, active: !hidden, activated: !hidden }; });
  const a = { isClosed: () => false }, b = { isClosed: () => false };
  const session = { visibility, headed: true, tabGroups: new Map([['tasks', new Map([['A', { page: a }], ['B', { page: b }]])]]) };
  const humanControlledTabs = new Set(['A', 'B']);
  await applySharedTabHandoff({ tabId: 'A', handoff: 'agent', tabState: { page: a }, session, humanControlledTabs });
  assert.equal(hides, 0);
  assert.equal(humanControlledTabs.has('A'), false);
  assert.equal(humanControlledTabs.has('B'), true);
  assert.equal(session.headed, true);
  const release = serverFunction('releaseIdentity', { sessions: new Map([['identity', session]]), sessionCreations: new Map(),
    humanControlledTabs, findTab: () => ({ tabState: { page: a } }) });
  assert.equal((await release('identity', { all: true })).released, false);
  assert.equal(hides, 0);
});

test('failed first hide closes only the new empty context, with no fallback relaunch', async () => {
  let launches = 0, closes = 0;
  await assert.rejects(launchWithVisibilityFallback({ display: null, profilePath: '/test/profile',
    createBackgroundVisibility: () => ({ attach: async () => { throw Error('hide failed'); } }),
    launch: async () => { launches++; return { close: async () => { closes++; } }; } }), /hide failed/);
  assert.equal(launches, 1);
  assert.equal(closes, 1);
});

test('legacy headed acquisitions cannot bypass an app-hidden controller focus failure', async () => {
  for (const mode of ['first', 'headless', 'ended']) {
    const page = { isClosed: () => false, bringToFront: async () => {}, url: () => 'about:blank' };
    const context = { pages: () => [page], newPage: async () => page };
    const replacement = { context, headed: false, tabGroups: new Map(), visibility: {
      visible: new Map([[0, {}]]), open: async () => { throw Error('native focus refused'); } } };
    const sessions = new Map(mode === 'first' ? [] : [['identity', { context, headed: mode === 'ended', tabGroups: new Map() }]]);
    let focuses = 0;
    const opener = createSharedIdentityWindowOpener({ sessions,
      manager: { failedClosures: new Set(), focus: async () => mode === 'ended' && focuses++ === 0 ? null : page },
      getSession: async () => { sessions.set('identity', replacement); return replacement; },
      closeSession: async () => {}, registerPage: () => 'A', isBusy: () => false });
    await assert.rejects(opener.openWindow('identity', mode === 'first' ? 'stale' : null, { allowRestart: true }), /native focus refused/, mode);
    assert.equal(replacement.headed, true);
  }
});

test('explicit headed acquisition shows the app-hidden context and propagates focus failure', async () => {
  let shown = 0, closes = 0;
  const page = { isClosed: () => false };
  const visibility = { attach: async () => {}, open: async target => { assert.equal(target, page); shown++; throw Error('activation was not confirmed'); } };
  await assert.rejects(launchWithVisibilityFallback({ display: null, headed: true, profilePath: '/test/profile',
    createBackgroundVisibility: () => visibility,
    launch: async () => ({ pages: () => [page], close: async () => { closes++; } }) }), /activation was not confirmed/);
  assert.equal(shown, 1);
  assert.equal(closes, 1);
});

test('failed initial hide preserves its error and records an unconfirmed close', async () => {
  const hideError = Error('hide failed'), closeError = Error('close failed');
  let launches = 0;
  await assert.rejects(launchWithVisibilityFallback({ display: null, profilePath: '/test/profile',
    createBackgroundVisibility: () => ({ attach: async () => { throw hideError; } }),
    launch: async () => { launches++; return { close: async () => { throw closeError; } }; } }), error => {
    assert.equal(error, hideError);
    assert.equal(error.profileOwnershipUnconfirmed, true);
    assert.equal(error.closeError, closeError);
    return true;
  });
  assert.equal(launches, 1);
});

test('AppKit operation has finite bounds and does not pass the host environment', async () => {
  const result = await setDarwinAppHidden(12, true, { execute: async (file, args, options) => {
    assert.equal(file, '/usr/bin/osascript');
    assert.deepEqual(args.slice(-2), ['12', 'hide']);
    assert.equal(options.timeout, 3000);
    assert.deepEqual(Object.keys(options.env), ['PATH', 'HOME']);
    return { stdout: '{"hidden":true}' };
  } });
  assert.equal(result.hidden, true);
  await assert.rejects(setDarwinAppHidden(-1, true), /invalid/);
});

// Exercise the real AppKit bridge without touching a live browser or account.
const nativeTest = process.platform === 'darwin' ? test : test.skip;
nativeTest('native AppKit readback confirms repeated hide/show of an owned disposable application', async () => {
  const code = `ObjC.import('AppKit');const app=$.NSApplication.sharedApplication;
    app.setActivationPolicy(0);
    const win=$.NSWindow.alloc.initWithContentRectStyleMaskBackingDefer($.NSMakeRect(100,100,320,120),15,2,false);
    win.title='Disposable Visibility Test';win.orderFrontRegardless;
    console.log('fixture-ready');app.run;`;
  const child = spawn('/usr/bin/osascript', ['-l', 'JavaScript', '-e', code], {
    stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000,
  });
  try {
    await new Promise((resolve, reject) => {
      child.stderr.on('data', data => { if (String(data).includes('fixture-ready')) resolve(); });
      child.once('error', reject);
      child.once('exit', code => reject(new Error(`native fixture exited: ${code}`)));
    });
    let readback;
    const visibility = createDarwinIdentityVisibility('/fixture/profile', { rootPid: process.pid,
      snapshot: () => [{ pid: child.pid, ppid: process.pid, args: '/fixture/camoufox -profile /fixture/profile -juggler-pipe' }],
      setHidden: async (pid, hidden) => { readback = await setDarwinAppHidden(pid, hidden); return readback; } });
    await visibility.attach();
    assert.equal(visibility.visible.size, 0);
    for (let index = 0; index < 3; index++) {
      let error;
      try { await visibility.open({ bringToFront: async () => {} }); }
      catch (failure) { error = failure; }
      assert.equal(readback.hidden, false, 'the disposable application must unhide');
      assert.equal(typeof readback.active, 'boolean');
      assert.equal(typeof readback.activated, 'boolean');
      if (readback.active && readback.activated) assert.equal(error, undefined);
      else assert.match(error?.message || '', /activation was not confirmed/);
      assert.equal(visibility.visible.size, 1);
      await visibility.release();
      assert.equal(visibility.visible.size, 0);
    }
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGTERM');
      await exited;
    }
  }
});

test('the app-hidden controller implements the page-registration interface server.js calls', async () => {
  // server.js calls isManagedPage for every existing page at session creation
  // and shouldRegisterUIPage for every context 'page' event, on any controller.
  const visibility = createDarwinIdentityVisibility('/test/profile', { rootPid: 10, snapshot: () => [], setHidden: async () => ({ hidden: true }) });
  const page = { isClosed: () => false, url: () => 'https://accounts.test/oauth' };
  assert.equal(typeof visibility.isManagedPage, 'function');
  assert.equal(typeof visibility.shouldRegisterUIPage, 'function');
  // App hiding creates no helper pages, so every real page is a user or agent tab.
  assert.equal(visibility.isManagedPage(page), false);
  assert.equal(await visibility.shouldRegisterUIPage(page), true);
  assert.equal(await visibility.shouldRegisterUIPage({ ...page, isClosed: () => true }), false);
  for (const name of ['isManagedPage', 'shouldRegisterUIPage']) {
    assert.ok(source.includes(`visibility.${name}(`) || source.includes(`visibility?.${name}(`), `server.js no longer calls ${name}`);
  }
});
