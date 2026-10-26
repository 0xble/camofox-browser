import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe as nodeDescribe, it as nodeIt } from 'node:test';
import vm from 'node:vm';
import { coalesceInflight } from '../../lib/inflight.js';

// Keep the focused Node runner and the existing Jest unit lane on the same tests.
const describe = globalThis.describe ?? nodeDescribe;
const it = globalThis.it ?? nodeIt;
const serverSource = readFileSync(new URL('../../server.js', import.meta.url), 'utf8');

function extract(pattern, label) {
  const matches = [...serverSource.matchAll(pattern)];
  assert.equal(matches.length, 1, `expected exactly one actual server ${label}`);
  assert.ok(matches[0][0].trim(), `empty actual server ${label}`);
  return matches[0][0];
}

function serverFunction(name) {
  return extract(new RegExp(`^(?:async )?function ${name}\\([^\\n]*\\) \\{[\\s\\S]*?^\\}`, 'gm'), name);
}

const lifecycleSource = [
  extract(/^const sessionCreations = new Map\(\);$/gm, 'acquisition map'),
  extract(/^const INTENTIONAL_STOP_REASONS = new Set\([^\n]+\);$/gm, 'intentional stop reasons'),
  ...['scheduleBrowserIdleShutdown', 'clearBrowserIdleTimer', 'ensureBrowser',
    'normalizeUserId', 'getSession', 'closeBrowserFully'].map(serverFunction),
  extract(/^\/\/ Idle memory pressure restart[\s\S]*?^setInterval\([\s\S]*?^\}, 30_000\);/gm, 'idle memory interval'),
  extract(/^app\.get\('\/health',[\s\S]*?^\}\);/gm, 'health route'),
].join('\n');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

// Evaluate the server's actual admission and acquisition code. Only browser,
// context, process-resource, timer and plugin collaborators are fake. No server
// import, listening socket, OS process discovery or browser teardown is needed.
function fixture({ timeoutMs = 300_000, hasBrowser = true, machineId = '' } = {}) {
  const barrier = deferred();
  const entered = deferred();
  const timers = new Map();
  const cleared = [];
  const closes = [];
  const restarts = [];
  const sessions = new Map();
  const routes = new Map();
  const contextCalls = [];
  const context = { on() {}, pages: () => [] };
  let timerId = 0;
  let memoryTick;
  let nativeMb = 100;
  let browserRssMb = 0;
  let warmRetries = 0;
  let api;
  const acquire = (kind) => {
    contextCalls.push(kind);
    entered.resolve();
    return barrier.promise;
  };
  const browser = { isConnected: () => true, newContext: () => acquire('ordinary') };
  const sharedIdentities = {
    owns: key => key === 'shared',
    failedClosures: new Set(), closings: new Set(), opens: new Map(),
    open: (key, factory) => factory(`/fake-profile/${key}`),
  };
  const sandbox = {
    initialBrowser: hasBrowser ? browser : null,
    sessions, coalesceInflight, sharedIdentities,
    sharedIdentityRequests: new Map(), sharedIdentityLastUrls: new Map(),
    CONFIG: { browserIdleTimeoutMs: timeoutMs, sharedIdentityAliases: {},
      sharedIdentityNames: [], directIdentity: {}, browserRssRestartThresholdMb: 1000 },
    MAX_SESSIONS: 50, FLY_MACHINE_ID: machineId, NATIVE_MEM_RESTART_THRESHOLD_MB: 100,
    proxyPool: null, browserLaunchProxy: null,
    contextIdentityOptions: () => ({}),
    pluginEvents: { emitAsync: async () => {} },
    createSharedIdentityContext: () => acquire('shared'),
    log() {}, failuresTotal: { labels: () => ({ inc() {} }) },
    browserRestartsTotal: { labels: reason => ({ inc: () => restarts.push(reason) }) },
    process: { memoryUsage: () => ({ rss: (nativeMb + 64) * 1048576, heapUsed: 64 * 1048576 }) },
    _browserPid: () => 42001,
    browserProcessTreeRssMb: () => browserRssMb,
    browserProcessNameRssMb: () => { throw new Error('unexpected name-based RSS fallback'); },
    _closeBrowserFullyImpl: async (reason) => {
      closes.push(reason);
      api.recordBrowserStopped(reason);
    },
    launchBrowserInstance: () => { throw new Error('unexpected browser launch'); },
    setTimeout: (callback, ms) => {
      const id = ++timerId;
      timers.set(id, { callback, ms });
      return id;
    },
    clearTimeout: (id) => { cleared.push(id); timers.delete(id); },
    setInterval: (callback, ms) => {
      assert.equal(ms, 30_000);
      assert.equal(memoryTick, undefined, 'only the memory interval is extracted');
      memoryTick = callback;
    },
    app: { get: (path, callback) => routes.set(path, callback) },
    healthState: { isRecovering: false }, sharedParkDisplay: null,
    getTotalTabCount: () => 0, userNavHealth: new Map(),
    scheduleBrowserWarmRetry: () => { warmRetries++; },
  };
  vm.runInNewContext(`
    let browser = initialBrowser;
    let browserIdleTimer = null;
    let browserLaunchPromise = null;
    let _browserClosePromise = null;
    let _lastBrowserStopReason = null;
    let _nativeMemBaseline = null;
    const BROWSER_IDLE_TIMEOUT_MS = CONFIG.browserIdleTimeoutMs;
    ${lifecycleSource}
    globalThis.api = {
      schedule: scheduleBrowserIdleShutdown,
      cancel: clearBrowserIdleTimer,
      getSession, closeBrowserFully,
      recordBrowserStopped(reason) {
        browser = null;
        _lastBrowserStopReason = reason;
        clearBrowserIdleTimer();
      },
      get timer() { return browserIdleTimer; },
      get browser() { return browser; },
      get baseline() { return _nativeMemBaseline; },
      get acquisitions() { return sessionCreations; },
      get launchPromise() { return browserLaunchPromise; },
    };
  `, sandbox, { filename: 'server-idle-acquisition-fixture.js' });
  api = sandbox.api;
  assert.equal(typeof memoryTick, 'function', 'actual memory callback must be captured');
  assert.equal(typeof routes.get('/health'), 'function', 'actual health route must be captured');
  return {
    api, sessions, timers, cleared, closes, restarts, entered, barrier, context,
    contextCalls, sharedIdentities, sharedIdentityRequests: sandbox.sharedIdentityRequests,
    async fire(id = api.timer) {
      const timer = timers.get(id);
      if (!timer) return false; // A cleared timeout never invokes its callback.
      timers.delete(id);
      await timer.callback();
      return true;
    },
    tickMemory: () => memoryTick(),
    setNativeMb: value => { nativeMb = value; },
    setBrowserRssMb: value => { browserRssMb = value; },
    async health({ recovering = false } = {}) {
      sandbox.healthState.isRecovering = recovering;
      let status = 200;
      let body;
      const response = { status(code) { status = code; return this; }, json(value) { body = value; } };
      await routes.get('/health')({}, response);
      return { status, body, warmRetries };
    },
  };
}

async function pendingAcquisition(h, kind, check, { reject = false } = {}) {
  const outcome = h.api.getSession(kind).then(value => ({ value }), error => ({ error }));
  try {
    await Promise.race([
      h.entered.promise,
      outcome.then(({ error }) => { throw error || new Error('acquisition did not reach the deferred context'); }),
    ]);
    assert.equal(h.sessions.size, 0, 'context acquisition has not published a session');
    assert.equal(h.api.acquisitions.size, 1, 'real coalescer owns the pending acquisition');
    assert.ok(h.api.acquisitions.has(kind));
    // These narrower signals cannot substitute for the acquisition-wide map.
    assert.equal(h.api.launchPromise, null);
    assert.equal(h.sharedIdentities.opens.size, 0);
    assert.equal(h.sharedIdentityRequests.size, 0);
    assert.deepEqual(h.contextCalls, [kind]);
    await check();
  } finally {
    if (reject) h.barrier.reject(new Error('context acquisition rejected'));
    else h.barrier.resolve(h.context);
    const settled = await outcome;
    assert.equal(h.api.acquisitions.size, 0, 'settlement releases the actual acquisition marker');
    if (reject) {
      assert.match(settled.error?.message || '', /context acquisition rejected/);
      assert.equal(h.sessions.size, 0);
    } else {
      if (settled.error) throw settled.error;
      assert.equal(h.sessions.get(kind), settled.value);
      assert.equal(settled.value.context, h.context);
      assert.equal(settled.value.sharedIdentity, kind === 'shared');
    }
  }
}

function applyPressure(h, cause) {
  if (cause === 'browser_rss_pressure') h.setBrowserRssMb(1000);
  else {
    h.tickMemory(); // Establish the real callback's native-memory baseline while idle.
    assert.equal(h.api.baseline, 100);
    h.setNativeMb(200);
  }
}

describe('actual server idle shutdown', () => {
  it('repeated truly-idle cleanup ticks retain one timer and close once', async () => {
    const h = fixture();
    h.api.schedule();
    const first = h.api.timer;
    h.api.schedule();
    h.api.schedule();
    assert.equal(h.api.timer, first);
    assert.equal(h.timers.size, 1);
    assert.equal(h.timers.get(first).ms, 300_000);
    assert.deepEqual(h.cleared, []);
    assert.equal(await h.fire(first), true);
    assert.deepEqual(h.closes, ['idle_shutdown']);
    assert.equal(h.api.timer, null);
    h.api.schedule();
    assert.equal(h.timers.size, 0);
    assert.equal(await h.fire(first), false);
    assert.deepEqual(h.closes, ['idle_shutdown']);
  });

  it('zero timeout disables scheduling', () => {
    const h = fixture({ timeoutMs: 0 });
    h.api.schedule();
    assert.equal(h.api.timer, null);
    assert.equal(h.timers.size, 0);
  });

  it('a missing browser prevents scheduling', () => {
    const h = fixture({ hasBrowser: false });
    h.api.schedule();
    assert.equal(h.timers.size, 0);
  });

  it('published sessions prevent both scheduling and a previously armed callback', async () => {
    const h = fixture();
    h.api.schedule();
    const timer = h.api.timer;
    await pendingAcquisition(h, 'shared', async () => {});
    assert.equal(h.sessions.size, 1);
    h.api.schedule();
    assert.equal(h.api.timer, timer);
    assert.equal(await h.fire(timer), true);
    assert.deepEqual(h.closes, []);
    h.api.schedule();
    assert.equal(h.timers.size, 0);
  });

  it('ordinary acquisition cancels an old timer through actual ensureBrowser', async () => {
    const h = fixture();
    h.api.schedule();
    const timer = h.api.timer;
    await pendingAcquisition(h, 'ordinary', async () => {
      assert.deepEqual(h.cleared, [timer]);
      assert.equal(h.api.timer, null);
      assert.equal(await h.fire(timer), false);
      assert.deepEqual(h.closes, []);
    });
  });

  it('an old timer cannot close a pending shared acquisition that bypasses ensureBrowser', async () => {
    const h = fixture();
    h.api.schedule();
    const timer = h.api.timer;
    await pendingAcquisition(h, 'shared', async () => {
      assert.deepEqual(h.cleared, [], 'shared acquisition intentionally bypasses ensureBrowser');
      assert.equal(await h.fire(timer), true);
      assert.deepEqual(h.closes, [], 'idle callback must protect a pending shared acquisition');
      assert.ok(h.api.browser);
    });
    h.sessions.clear();
    h.api.schedule();
    await h.fire();
    assert.deepEqual(h.closes, ['idle_shutdown'], 'settled acquisition does not poison later idle reclamation');
  });

  for (const kind of ['shared', 'ordinary']) {
    it(`cannot arm a new idle timer during pending ${kind} acquisition`, async () => {
      const h = fixture();
      if (kind === 'ordinary') h.api.schedule();
      await pendingAcquisition(h, kind, async () => {
        if (kind === 'ordinary') assert.equal(h.cleared.length, 1, 'old timer was cancelled before rearming');
        h.api.schedule();
        h.api.schedule();
        assert.equal(h.timers.size, 0, `scheduler must protect a pending ${kind} acquisition`);
        assert.equal(h.api.timer, null);
        assert.deepEqual(h.closes, []);
      });
      h.sessions.clear();
      h.api.schedule();
      await h.fire();
      assert.deepEqual(h.closes, ['idle_shutdown']);
    });

    it(`a rejected ${kind} acquisition releases its marker and permits idle reclamation`, async () => {
      const h = fixture();
      await pendingAcquisition(h, kind, async () => {}, { reject: true });
      h.api.schedule();
      assert.equal(h.timers.size, 1);
      await h.fire();
      assert.deepEqual(h.closes, ['idle_shutdown']);
    });
  }

  it('cancelling a timer permits the next truly-idle period to schedule again', () => {
    const h = fixture();
    h.api.schedule();
    const first = h.api.timer;
    h.api.cancel();
    assert.equal(h.timers.size, 0);
    h.api.schedule();
    assert.notEqual(h.api.timer, first);
    assert.equal(h.timers.size, 1);
    assert.deepEqual(h.cleared, [first]);
  });
});

describe('actual server common idle memory guard', () => {
  for (const cause of ['browser_rss_pressure', 'memory_pressure']) {
    it(`still reclaims a truly-idle browser at the ${cause} threshold`, () => {
      const h = fixture();
      applyPressure(h, cause);
      h.tickMemory();
      assert.deepEqual(h.closes, [cause]);
      assert.deepEqual(h.restarts, [cause]);
    });

    for (const kind of ['ordinary', 'shared']) {
      it(`${cause} cannot close pending ${kind} acquisition`, async () => {
        const h = fixture();
        applyPressure(h, cause);
        await pendingAcquisition(h, kind, async () => {
          h.tickMemory();
          assert.deepEqual(h.closes, [], `${cause} guard must protect pending ${kind} acquisition`);
          assert.deepEqual(h.restarts, []);
          assert.ok(h.api.browser);
        });
        h.tickMemory();
        assert.deepEqual(h.closes, [], 'published session remains protected after settlement');
        h.sessions.clear();
        h.tickMemory();
        assert.deepEqual(h.closes, [cause], 'settlement must permit later truly-idle pressure reclamation');
      });
    }

    it(`${cause} preserves a published shared session`, async () => {
      const h = fixture();
      applyPressure(h, cause);
      await pendingAcquisition(h, 'shared', async () => {});
      h.tickMemory();
      assert.deepEqual(h.closes, []);
      assert.deepEqual(h.restarts, []);
    });
  }

  it('does not restart below either pressure threshold', () => {
    const h = fixture();
    h.tickMemory();
    assert.equal(h.api.baseline, 100);
    h.setNativeMb(199);
    h.setBrowserRssMb(999);
    h.tickMemory();
    assert.deepEqual(h.closes, []);
    assert.deepEqual(h.restarts, []);
  });

  it('does not restart without a browser', () => {
    const h = fixture({ hasBrowser: false });
    h.setNativeMb(1000);
    h.setBrowserRssMb(2000);
    h.tickMemory();
    assert.deepEqual(h.closes, []);
    assert.deepEqual(h.restarts, []);
  });
});

describe('actual server non-idle close authority and passive health', () => {
  for (const reason of ['admin_stop', 'browser_disconnected', 'shutdown:SIGTERM']) {
    it(`${reason} retains explicit close authority during acquisition`, async () => {
      const h = fixture();
      await pendingAcquisition(h, 'shared', async () => {
        await h.api.closeBrowserFully(reason);
        assert.deepEqual(h.closes, [reason], 'protection belongs to idle callers, not the global closer');
      });
    });
  }

  it('intentional idle shutdown still passes health without warming a browser', async () => {
    const h = fixture({ machineId: 'machine-1' });
    h.api.schedule();
    await h.fire();
    const { status, body, warmRetries } = await h.health();
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.engine, 'camoufox');
    assert.equal(body.machineId, 'machine-1');
    assert.equal(body.browserRunning, false);
    assert.equal(body.browserConnected, false);
    assert.equal(warmRetries, 0);
  });

  it('recovery still fails health', async () => {
    const h = fixture({ hasBrowser: false });
    const { status, body } = await h.health({ recovering: true });
    assert.equal(status, 503);
    assert.equal(body.ok, false);
    assert.equal(body.recovering, true);
  });
});
