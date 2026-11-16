import { quarantinePage, isQuarantinedPage } from '../../lib/page-registry.js';
import assert from 'node:assert/strict';
// Use the repository's Jest runner, or run this dependency-free regression with node --test.
const test = globalThis.test ?? (await import('node:test')).test;
import { EventEmitter, once } from 'node:events';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import os from 'node:os';
import { launchWithVisibilityFallback } from '../../lib/shared-identity-visibility.js';
import { createDarwinIdentityVisibility, setDarwinAppHidden } from '../../lib/darwin-identity-visibility.js';
import { findMainDisplay } from '../../lib/park-display-launcher.js';
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

function controller(setHidden = async (_pid, hidden) => ({ hidden, active: !hidden, activated: !hidden }), options = {}) {
  let processes = [{ pid: 12, ppid: 10, args: '/engine/camoufox -profile /test/profile -juggler-pipe' }];
  let nativeState;
  const visibility = createDarwinIdentityVisibility('/test/profile', { rootPid: 10, snapshot: () => processes,
    setHidden: async (...args) => { nativeState = await setHidden(...args); return nativeState; },
    readState: async () => nativeState,
    createWindowControl: async () => ({ attach: async () => {}, close: async () => {},
      open: async () => ({ onMain: true, number: 8, frontmost: true }) }), ...options });
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

test('app-wide visibility protects every page, including direct human tab switches', async () => {
  const { visibility } = controller();
  await visibility.attach();
  const shown = { bringToFront: async () => {} }, background = {};
  const opening = visibility.open(shown);
  assert.equal(visibility.isPageVisible(shown), true, 'protect target before the first await');
  await opening;
  assert.equal(visibility.isPageVisible(shown), true);
  assert.equal(visibility.isPageVisible(background), true);
  await visibility.release();
  assert.equal(visibility.isPageVisible(shown), false);
  assert.equal(visibility.isPageVisible(background), false);
});

test('cleanup refresh observes external unhide/hide without changing app visibility', async () => {
  const native = { hidden: true }, calls = [];
  const { visibility } = controller(async (_pid, hidden) => { calls.push(hidden); native.hidden = hidden; return { hidden }; },
    { readState: async () => native });
  await visibility.attach();
  native.hidden = false; // Human opens the application from the Dock.
  await visibility.refresh();
  assert.equal(visibility.isPageVisible({}), true);
  native.hidden = true; // Human Cmd+H, not a service release.
  await visibility.refresh();
  assert.equal(visibility.isPageVisible({}), false);
  assert.deepEqual(calls, [true], 'readback must not issue hide/show');
});

test('failed cleanup refresh cannot make a visible application collectible', async () => {
  let fail = false;
  const { visibility } = controller(async (_pid, hidden) => ({ hidden }), { readState: async () => { if (fail) throw Error('readback failed'); return { hidden: true }; } });
  await visibility.attach();
  fail = true;
  await assert.rejects(visibility.refresh(), /readback failed/);
  assert.equal(visibility.isPageVisible({}), true);
  assert.equal(visibility.visible.size, 0, 'failed readback is unknown, not confirmed visible');
  fail = false;
  await visibility.refresh();
  assert.equal(visibility.isPageVisible({}), false, 'a later successful refresh clears the unknown flag');
  assert.equal(visibility.visible.size, 0);
});

test('newPage re-hides after a failed visibility refresh', async () => {
  let fail = false;
  const calls = [];
  const { visibility } = controller(async (_pid, hidden) => {
    calls.push(hidden);
    return { hidden, active: !hidden, activated: !hidden };
  }, { readState: async () => { if (fail) throw Error('readback failed'); return { hidden: true }; } });
  await visibility.attach();
  const hiddenCalls = calls.length;
  fail = true;
  await assert.rejects(visibility.refresh(), /readback failed/);
  assert.equal(visibility.visible.size, 0);
  assert.equal(visibility.isPageVisible({}), true, 'cleanup still fails closed while native state is unknown');
  fail = false;
  const page = { isClosed: () => false };
  assert.equal(await visibility.newPage({ newPage: async () => page }), page);
  assert.equal(calls.length, hiddenCalls + 1, 'unknown state must not skip the re-hide a confirmed-hidden app would get');
  assert.equal(calls.at(-1), true);
  assert.equal(visibility.visible.size, 0);
  assert.equal(visibility.isPageVisible({}), false);
});

test('hide refusal reports failure and retains visible state without closing anything', async () => {
  const { visibility } = controller(async () => ({ hidden: false }));
  await assert.rejects(visibility.release(), /not confirmed/);
  assert.equal(visibility.visible.size, 1);
});

test('inactive native show succeeds without claiming focus and transfers human control', async () => {
  const { visibility } = controller(async (_pid, hidden) => ({ hidden, active: false, activated: false }));
  await visibility.attach();
  const page = { isClosed: () => false, bringToFront: async () => {} };
  const session = { visibility, context: { pages: () => [page] }, tabGroups: new Map() };
  const opener = createSharedIdentityWindowOpener({ sessions: new Map([['identity', session]]), manager: {},
    getSession: async () => session, registerPage: () => 'tab-A', isBusy: () => false });
  const opened = await opener.openWindow('identity');
  assert.equal(opened.visible, true);
  assert.equal(opened.focused, false);
  assert.equal(session.headed, true, 'visible but inactive must remain protected from expiry');
  const humans = new Set();
  const tabState = { page };
  const handedOff = await applySharedTabHandoff({ tabId: 'A', handoff: 'human', tabState, session, humanControlledTabs: humans });
  assert.equal(handedOff.visible, true);
  assert.equal(handedOff.focused, false);
  assert.equal(tabState.handoff, 'human');
  assert.equal(humans.has('A'), true);
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

for (const proof of [{ onMain: false, frontmost: true, number: 8 }, { onMain: false, frontmost: false, number: null }]) {
  test(`app-hidden handoff refuses unverified target geometry (native number=${proof.number})`, async () => {
    const { visibility } = controller(undefined, { createWindowControl: async () => ({
      attach: async () => {}, open: async () => proof, close: async () => {},
    }) });
    await visibility.attach();
    const page = { isClosed: () => false, bringToFront: async () => {} };
    const session = { visibility, tabGroups: new Map() }, humans = new Set(), tabState = { page };
    await assert.rejects(applySharedTabHandoff({ tabId: 'A', handoff: 'human', tabState, session,
      humanControlledTabs: humans }), /native.*main display/);
    assert.equal(humans.size, 0);
    assert.equal(tabState.handoff, undefined);
    assert.equal(visibility.visible.size, 1, 'unconfirmed native state remains protected from expiry');
  });
}

test('an active application cannot prove focus of a background native target window', async () => {
  const { visibility } = controller(undefined, { createWindowControl: async () => ({
    attach: async () => {}, close: async () => {},
    open: async () => ({ onMain: true, frontmost: false, number: 8 }),
  }) });
  await visibility.attach();
  assert.deepEqual(await visibility.open({ bringToFront: async () => {} }), { visible: true, focused: false });
});

test('app-hidden window addon is prepared before launch and cleaned up on launch failure', async () => {
  let prepared = false, closed = false;
  const visibility = { prepare: async () => { prepared = true; }, addon: 'native-addon', close: async () => { closed = true; } };
  await assert.rejects(launchWithVisibilityFallback({ display: null, profilePath: '/test/profile',
    createBackgroundVisibility: () => visibility,
    launch: async ({ visibility: control }) => { assert.equal(prepared, true); assert.equal(control.addon, 'native-addon'); throw Error('launch failed'); },
  }), /launch failed/);
  assert.equal(closed, true);
});

for (const failure of ['display query failed', 'display query timed out', 'addon ready ack failed', 'addon ready ack timed out']) {
  test(`${failure} degrades only handoff, preserving launch and agent pages`, async () => {
    let closes = 0, shows = 0;
    const unavailable = Error(failure);
    const { visibility } = controller(async (_pid, hidden) => {
      if (!hidden) shows++;
      return { hidden, active: !hidden };
    }, { timeoutMs: 30, createWindowControl: async () => {
      if (!failure.startsWith('addon')) await findMainDisplay({ platform: 'darwin', execute: async () => {
        if (failure.includes('timed out')) throw unavailable;
        return { stdout: '[]' };
      } });
      return { addon: 'native-addon', attach: async () => {
        if (failure.includes('timed out')) await new Promise(() => {});
        throw unavailable;
      },
        open: async () => assert.fail('an unattached addon cannot prove handoff'), close: async () => {} };
    } });
    const page = { isClosed: () => false, bringToFront: async () => {}, input: 'unsaved' };
    const context = { close: async () => { closes++; }, pages: () => [page], newPage: async () => page };
    const acquired = await launchWithVisibilityFallback({ display: null, profilePath: '/test/profile',
      createBackgroundVisibility: () => visibility, launch: async () => context });
    assert.equal(acquired, context);
    assert.equal(await visibility.newPage(context), page);
    assert.equal(page.input, 'unsaved');
    assert.equal(visibility.visible.size, 0);
    assert.equal(visibility.capability().sameContextHandoff, false);
    const session = { visibility, tabGroups: new Map() }, humans = new Set(), tabState = { page };
    await assert.rejects(applySharedTabHandoff({ tabId: 'A', handoff: 'human', tabState, session,
      humanControlledTabs: humans }), /native window handoff unavailable/);
    assert.equal(humans.size, 0);
    assert.equal(tabState.handoff, undefined);
    assert.equal(shows, 0, 'unavailable handoff must not unhide the application');
    assert.equal(closes, 0);
    await visibility.close();
  });
}

test('native unhide refusal errors and does not transfer human control', async () => {
  const { visibility } = controller(async () => ({ hidden: true, active: false, activated: true }));
  await visibility.attach();
  const page = { isClosed: () => false, bringToFront: async () => {} };
  await assert.rejects(visibility.open(page), /visibility change was not confirmed/);
  const session = { visibility, tabGroups: new Map() }, humans = new Set();
  const tabState = { page };
  await assert.rejects(applySharedTabHandoff({ tabId: 'A', handoff: 'human', tabState, session, humanControlledTabs: humans }), /visibility change was not confirmed/);
  assert.equal(humans.size, 0);
  assert.equal(tabState.handoff, undefined);
});

for (const operation of ['open', 'newPage']) {
  test(`hung ${operation} times out, releases the identity queue and fences late continuations`, async () => {
    const calls = [];
    const { visibility } = controller(async (_pid, hidden) => {
      calls.push(hidden); return { hidden, active: !hidden, activated: !hidden };
    }, { timeoutMs: 30 });
    await visibility.attach();
    let finish;
    const hung = new Promise(resolve => { finish = resolve; });
    const page = { bringToFront: () => hung };
    const operationPromise = operation === 'open' ? visibility.open(page) : visibility.newPage({ newPage: () => hung });
    // The outer guard fails the regression promptly on an unbounded implementation.
    let guard;
    try {
      const outcome = await Promise.race([
        operationPromise.then(value => value, error => error),
        new Promise(resolve => { guard = setTimeout(() => resolve(null), 250); }),
      ]);
      if (operation === 'open') {
        // A timed-out Juggler activation is abandoned and the identity is
        // rescued through the native path instead of leaving the queue wedged.
        assert.deepEqual(outcome, { visible: true, focused: false, targetUnconfirmed: true });
        assert.equal(visibility.isPageVisible({}), true);
        assert.deepEqual(calls, [true, false, false]);
      } else {
        assert.match(outcome?.message || '', /visibility.*timed out/);
        assert.equal(outcome.code, 'request_timeout');
        assert.deepEqual(calls, [true]);
        assert.equal(visibility.isPageVisible({}), true, 'unconfirmed browser work must remain protected');
        assert.equal(await visibility.release(), true, 'later work must not wait for the hung browser call');
        await visibility.open({ bringToFront: async () => {} });
        assert.deepEqual(calls, [true, true, false]);
      }
      finish({});
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(visibility.visible.size, 1);
    } finally {
      clearTimeout(guard); finish({});
      await operationPromise.catch(() => {});
    }
  });
}

test('timed-out native readback cannot overwrite a later visibility change', async () => {
  let delayed = false, finish;
  const { visibility } = controller(async (_pid, hidden, { signal }) => {
    if (delayed) {
      delayed = false;
      return new Promise((resolve, reject) => { finish = resolve; signal.addEventListener('abort', () => reject(signal.reason), { once: true }); });
    }
    return { hidden, active: !hidden, activated: true };
  }, { timeoutMs: 30 });
  await visibility.open({ bringToFront: async () => {} });
  delayed = true;
  await assert.rejects(visibility.release(), /visibility.*timed out/);
  assert.equal(visibility.visible.size, 1);
  await visibility.open({ bringToFront: async () => {} });
  finish({ hidden: true, active: false, activated: false });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(visibility.visible.size, 1, 'stale native readback must not clear newer visible state');
});

test('an unconfirmed show remains visible to expiry checks', async () => {
  let fail = false;
  const { visibility } = controller(async (_pid, hidden) => { if (fail) throw Error('readback failed'); return { hidden, active: !hidden, activated: !hidden }; });
  await visibility.attach();
  fail = true;
  await assert.rejects(visibility.open({ bringToFront: async () => {} }), /readback failed/);
  assert.equal(visibility.isPageVisible({}), true);
  assert.equal(visibility.visible.size, 0);
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
    humanControlledTabs, isQuarantinedPage, findTab: () => ({ tabState: { page: a } }) });
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

test('legacy headed acquisitions cannot bypass an app-hidden controller visibility failure', async () => {
  for (const mode of ['first', 'headless', 'ended']) {
    const page = { isClosed: () => false, bringToFront: async () => {}, url: () => 'about:blank' };
    const context = { pages: () => [page], newPage: async () => page };
    const replacement = { context, headed: false, tabGroups: new Map(), visibility: {
      visible: new Map([[0, {}]]), open: async () => { throw Error('native unhide refused'); } } };
    const sessions = new Map(mode === 'first' ? [] : [['identity', { context, headed: mode === 'ended', tabGroups: new Map() }]]);
    let focuses = 0;
    const opener = createSharedIdentityWindowOpener({ sessions,
      manager: { failedClosures: new Set(), focus: async () => mode === 'ended' && focuses++ === 0 ? null : page },
      getSession: async () => { sessions.set('identity', replacement); return replacement; },
      closeSession: async () => {}, registerPage: () => 'A', isBusy: () => false });
    await assert.rejects(opener.openWindow('identity', mode === 'first' ? 'stale' : null, { allowRestart: true }), /native unhide refused/, mode);
    assert.equal(replacement.headed, true);
  }
});

test('all legacy acquisition paths preserve inactive success and native focus readback', async () => {
  for (const mode of ['first', 'headless', 'ended']) {
    for (const active of [false, true]) {
      const { visibility } = controller(async (_pid, hidden) => ({ hidden, active: !hidden && active, activated: false }));
      const page = { isClosed: () => false, bringToFront: async () => {}, url: () => 'about:blank' };
      const context = { pages: () => [page], newPage: async () => page };
      const replacement = { context, headed: false, tabGroups: new Map(), visibility };
      const sessions = new Map(mode === 'first' ? [] : [['identity', { context, headed: mode === 'ended', tabGroups: new Map() }]]);
      let focuses = 0;
      const opener = createSharedIdentityWindowOpener({ sessions,
        manager: { failedClosures: new Set(), focus: async () => mode === 'ended' && focuses++ === 0 ? null : page },
        getSession: async () => { sessions.set('identity', replacement); return replacement; },
        closeSession: async () => {}, registerPage: () => 'A', isBusy: () => false });
      const result = await opener.openWindow('identity', mode === 'first' ? 'stale' : null, { allowRestart: true });
      assert.equal(result.visible, true, mode);
      assert.equal(result.focused, active, mode);
      assert.equal(replacement.headed, true, mode);
    }
  }
});

test('creating a task tab makes untargeted app-hidden focus select it rather than the initial blank', async () => {
  const blank = { isClosed: () => false, bringToFront: async () => {}, url: () => 'about:blank' };
  const page = { isClosed: () => false, bringToFront: async () => {}, url: () => 'about:blank#task' };
  const { visibility } = controller(async (_pid, hidden) => ({ hidden, active: false, activated: true }));
  const session = { sharedIdentity: true, context: { pages: () => [blank, page] }, visibility,
    lastUsedPage: blank, tabGroups: new Map([['initial', new Map([['blank', { page: blank }]])]]) };
  const sessions = new Map([['identity', session]]);
  let createTab;
  const start = source.indexOf("app.post('/tabs',");
  const end = source.indexOf('\n});', start) + 5;
  const registerPage = (_session, _userId, target, group) => {
    const tabId = target === page ? 'task' : 'blank', tabState = { page: target, lastNavigationHttpStatus: null };
    if (group) session.tabGroups.set(group, new Map([[tabId, tabState]]));
    return { tabId, tabState };
  };
  vm.runInNewContext(source.slice(start, end), {
    app: { post: (_path, handler) => { createTab = handler; } }, sessions,
    normalizeUserId: String, FLY_MACHINE_ID: '', MAX_TABS_PER_SESSION: 10, MAX_TABS_GLOBAL: 10,
    withRequestDeadline: operation => operation(new AbortController().signal), getSession: async () => session,
    getTotalTabCount: () => 2, createPageWithRecoveryForUser: async () => ({ session, page, lease: {} }),
    registerPage, releasePageLease() {}, refreshActiveTabsGauge() {}, pluginEvents: { emit() {} }, log() {}, requestTimeoutMs: () => 1000,
  });
  let created;
  await createTab({ body: { userId: 'identity', sessionKey: 'task-group' } }, { json: data => { created = data; } });
  assert.equal(created.tabId, 'task');
  const opener = createSharedIdentityWindowOpener({ sessions, getSession: async () => session,
    registerPage: (...args) => registerPage(...args).tabId, manager: {}, isBusy: () => false });
  const focused = await opener.openWindow('identity');
  assert.equal(focused.tabId, 'task');
  assert.equal(focused.focused, false);
  assert.equal(focused.visible, true);
});

test('headed acquisition keeps a shown but inactive app-hidden context', async () => {
  let closes = 0;
  const page = { isClosed: () => false, bringToFront: async () => {} };
  const { visibility } = controller(async (_pid, hidden) => ({ hidden, active: false, activated: true }));
  const context = { pages: () => [page], close: async () => { closes++; } };
  const acquired = await launchWithVisibilityFallback({ display: null, headed: true, profilePath: '/test/profile',
    createBackgroundVisibility: () => visibility, launch: async () => context });
  assert.equal(acquired, context);
  assert.equal(acquired.sharedIdentityVisibility, visibility);
  assert.equal(visibility.visible.size, 1);
  assert.equal(closes, 0);
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

test('main display discovery works without any secondary display and fails closed on absent geometry', async () => {
  const execute = async (_bin, _args, options) => {
    assert.equal(options.timeout, 1500);
    assert.deepEqual(Object.keys(options.env).sort(), ['HOME', 'PATH']);
    return { stdout: JSON.stringify([{ x: 0, y: 0, width: 2048, height: 1152 }]) };
  };
  assert.deepEqual(await findMainDisplay({ platform: 'darwin', execute }), { left: 0, top: 0, width: 2048, height: 1152 });
  await assert.rejects(findMainDisplay({ platform: 'darwin', execute: async () => ({ stdout: '[]' }) }), /main display/);
  await assert.rejects(findMainDisplay({ platform: 'linux', execute }), /macOS/);
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

async function appKitReadback(app, { hidden = true, readOnly = false, lookup = () => app, tick = () => {} } = {}) {
  return setDarwinAppHidden(12, hidden, { readOnly, execute: async (_file, args) => {
    const $ = { NSRunningApplication: { runningApplicationWithProcessIdentifier: lookup },
      NSRunLoop: { currentRunLoop: { runUntilDate: tick } }, NSDate: { dateWithTimeIntervalSinceNow() {} } };
    return { stdout: vm.runInNewContext(`${args[3]};run(${JSON.stringify(args.slice(-2))})`, { ObjC: { import() {} }, $, Boolean, JSON, Number, Error }) };
  } });
}

test('AppKit reissues an unconfirmed hide after servicing its run loop', async () => {
  let hides = 0, ticks = 0;
  const app = { isNil: () => false, terminated: false, hidden: false, active: false,
    get hide() { hides++; if (ticks > 0) this.hidden = true; return false; } };
  const result = await appKitReadback(app, { tick: () => { ticks++; } });
  assert.equal(result.hidden, true, 'a rejected early request needs another hide, not just more readback');
  assert.equal(hides, 2);
  assert.ok(ticks > 0);
});

test('AppKit waits a bounded run-loop turn for a newly launched PID to register', async () => {
  let ticks = 0;
  const app = { isNil: () => false, terminated: false, hidden: false, active: false,
    get hide() { this.hidden = true; } };
  const result = await appKitReadback(app, { lookup: () => ticks ? app : null, tick: () => { ticks++; } });
  assert.equal(result.hidden, true);
  assert.equal(ticks, 2, 'one registration turn and one hide readback turn');
});

test('AppKit hide confirmation tolerates startup taking longer than the old ten turns', async () => {
  let ticks = 0;
  const app = { isNil: () => false, terminated: false, hidden: false, active: false,
    get hide() { if (ticks >= 12) this.hidden = true; } };
  assert.equal((await appKitReadback(app, { tick: () => { ticks++; } })).hidden, true);
  assert.equal(ticks, 13);
});

test('AppKit hide refusal stays bounded and cannot claim hidden state', async () => {
  let hides = 0, ticks = 0;
  const app = { isNil: () => false, terminated: false, hidden: false, active: false,
    get hide() { hides++; return false; } };
  assert.equal((await appKitReadback(app, { tick: () => { ticks++; } })).hidden, false);
  assert.equal(hides, 30);
  assert.equal(ticks, 30);
  ticks = 0;
  await assert.rejects(appKitReadback(null, { tick: () => { ticks++; } }), /not running/);
  assert.equal(ticks, 10);
});

test('AppKit read-only lookup never hides, unhides or activates an application', async () => {
  const app = { isNil: () => false, terminated: false, hidden: true, active: false,
    get hide() { assert.fail('read must not hide'); }, get unhide() { assert.fail('read must not unhide'); },
    activateWithOptions() { assert.fail('read must not activate'); } };
  assert.equal((await appKitReadback(app, { hidden: false, readOnly: true })).hidden, true);
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
    // Keep the fixture alive across the bounded native calls under full-suite load.
    stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000, env: { PATH: '/usr/bin:/bin', HOME: os.homedir() },
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
      setHidden: async (pid, hidden) => { readback = await setDarwinAppHidden(pid, hidden); return readback; },
      createWindowControl: async () => ({ attach: async () => {}, close: async () => {},
        open: async () => ({ onMain: true, number: 8, frontmost: true }) }) });
    await visibility.attach();
    assert.equal(visibility.visible.size, 0);
    for (let index = 0; index < 3; index++) {
      const shown = await visibility.open({ bringToFront: async () => {} });
      assert.equal(readback.hidden, false, 'the disposable application must unhide');
      assert.equal(typeof readback.active, 'boolean');
      assert.equal(typeof readback.activated, 'boolean');
      assert.equal(shown.visible, true);
      assert.equal(shown.focused, readback.active, 'reported focus must equal native active state, whichever it is');
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

test('a queued native visibility open cannot focus a page retired while waiting', async () => {
  let resume;
  const held = new Promise(resolve => { resume = resolve; });
  const { visibility } = controller(async (_pid, hidden) => {
    if (hidden) await held;
    return { hidden, active: !hidden };
  });
  let focused = false;
  const page = { isClosed: () => false, bringToFront: async () => { focused = true; } };
  const attaching = visibility.attach();
  const opening = visibility.open(page).catch(error => error);
  await new Promise(resolve => setImmediate(resolve));
  quarantinePage(page);
  resume();
  await attaching;
  assert.equal((await opening).code, 'tab_destroyed');
  assert.equal(focused, false);
  assert.equal(visibility.visible.size, 0);
});
for (const stage of ['prepare', 'attach']) for (const cause of ['display query failed', 'identity visibility operation timed out after 12000ms']) {
  test(`native handoff degradation is typed and diagnosed (${stage}: ${cause})`, async () => {
    const logs = [];
    const original = Error(cause);
    const { visibility } = controller(undefined, { log: (...entry) => logs.push(entry),
      createWindowControl: async () => {
        if (stage === 'prepare') throw original;
        return { addon: '/addon', attach: async () => { throw original; } };
      } });
    await visibility.prepare();
    await visibility.attach();
    assert.equal(logs.length, 1, 'log once at degradation, not on every failed handoff');
    assert.equal(logs[0][0], 'warn');
    assert.equal(logs[0][2].cause, cause);
    assert.deepEqual(visibility.capability().handoffUnavailable, {
      code: 'handoff_unavailable', stage, relaunchRequired: true,
    });
    await assert.rejects(visibility.open({ bringToFront: async () => assert.fail('must not focus') }), error => {
      assert.equal(error.code, 'handoff_unavailable');
      assert.equal(error.statusCode, 409);
      assert.equal(error.cause, original);
      return true;
    });
    assert.equal(logs.length, 1);
  });
}

test('direct and parking-fallback launches forward native degradation warnings without private paths/endpoints', async () => {
  for (const display of [null, { main: {}, park: {} }]) {
    const logs = [];
    const profilePath = '/private/owned-profile';
    await launchWithVisibilityFallback({ display, profilePath, log: (...entry) => logs.push(entry),
      prepareProfile: async () => null, createVisibility: async () => { throw Error('parking failed'); },
      createBackgroundVisibility: (profile, options) => createDarwinIdentityVisibility(profile, { ...options, rootPid: 10, snapshot: () => [{ pid: 12, ppid: 10, args: `/engine/camoufox -profile ${profile} -juggler-pipe` }], setHidden: async () => ({ hidden: true }),
        createWindowControl: async () => { throw Error(`failed ${profile} http://127.0.0.1:1234/secret-token`); } }),
      launch: async () => ({ pages: () => [], once() {} }) });
    const warning = logs.find(([, message]) => message.startsWith('native window handoff unavailable'));
    assert.equal(warning[0], 'warn');
    assert.equal(warning[2].cause, 'failed [profile] [endpoint]');
  }
});
