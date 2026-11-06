import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { it as nodeIt } from 'node:test';
import vm from 'node:vm';
import { acquirePageLease, releasePageLease, setLeasedPage } from '../../lib/page-lease.js';
import { createPageRegistry, findTabByPage, getOpenerTabId, quarantinePage, isQuarantinedPage, SHARED_IDENTITY_GROUP } from '../../lib/page-registry.js';

const it = globalThis.it ?? nodeIt;
const source = readFileSync(new URL('../../server.js', import.meta.url), 'utf8');
const turn = () => new Promise(resolve => setImmediate(resolve));
function serverFunction(name) {
  const matches = [...source.matchAll(new RegExp(`^(?:async )?function ${name}\\([^\\n]*\\) \\{[\\s\\S]*?^\\}`, 'gm'))];
  assert.equal(matches.length, 1, `expected actual server ${name}`);
  return matches[0][0];
}
function page(opener = null) {
  const result = new EventEmitter();
  result.closed = false;
  result.isClosed = () => result.closed;
  result.url = () => 'https://popup.example.test/';
  result.opener = async () => opener?.isClosed() ? null : opener;
  result.close = async () => { result.closed = true; result.emit('close'); };
  return result;
}

// Actual session creation installs the actual context listeners; actual safe
// close/destruction drives retirement. Only browser/context IO, timers, metrics,
// plugins and downloads are fake. No browser launch or live service is used.
async function fixture(sharedIdentity, visibility = false) {
  const context = new EventEmitter();
  const contextPages = new Set();
  context.on('page', page => contextPages.add(page));
  context.pages = () => [...contextPages];
  context.close = async () => { await Promise.all([...contextPages].map(page => page.close())); };
  context.newPage = async () => { const result = page(); context.emit('page', result); return result; };
  if (visibility) context.sharedIdentityVisibility = { shouldRegisterUIPage: async () => true };
  const sessions = new Map(), timers = [], downloads = [], created = [];
  let next = 0;
  const registry = createPageRegistry({
    sessions, makeTabId: () => `tab-${++next}`,
    createTabState: page => ({ page }),
    attachDownloadListener: tab => downloads.push(tab.page),
    emit: (event, payload) => { if (event === 'tab:created') created.push(payload); },
  });
  const findTab = (session, id) => {
    for (const [listItemId, group] of session.tabGroups) {
      if (group.has(id)) return { tabState: group.get(id), group, listItemId };
    }
    return null;
  };
  const box = {
    acquirePageLease, releasePageLease, setLeasedPage,
    sessions, normalizeUserId: id => id, sessionCreations: new Map(), sessionLifecycleGeneration: 0,
    sharedIdentities: { owns: () => sharedIdentity, open: async () => context, closings: new Set(), failedClosures: new Set() },
    ensureBrowser: async () => ({ newContext: async () => context }),
    coalesceInflight: (_map, _key, operation) => operation(), MAX_SESSIONS: 10, FLY_MACHINE_ID: null,
    CONFIG: {}, proxyPool: null, browserLaunchProxy: null, sharedIdentityLastUrls: new Map(),
    contextIdentityOptions: () => ({}), trackContextTracing() {},
    pluginEvents: { emit(event, payload) { if (event === 'tab:created') created.push(payload); }, emitAsync: async () => {} },
    registerSharedIdentityPage: registry.registerSharedIdentityPage,
    registerPage: registry.registerPage, findTabByPage, isQuarantinedPage, quarantinePage,
    findTab, findTabOwner(id) {
      for (const [userId, session] of sessions) {
        const found = findTab(session, id);
        if (found) return { ...found, userId, session };
      }
      return null;
    },
    tabLocks: new Map(), humanControlledTabs: new Set(),
    refreshActiveTabsGauge() {}, refreshTabLockQueueDepth() {}, log() {}, safePageUrl: page => page.url(),
    tabsDestroyedTotal: { labels: () => ({ inc() {} }) }, clearTabDownloads: async () => {},
    PAGE_CLOSE_TIMEOUT_MS: 100, PAGE_FORCE_CLOSE_TIMEOUT_MS: 25,
    setTimeout(callback, ms) { timers.push({ callback, ms }); },
  };
  vm.runInNewContext(['getSession', 'safePageClose', 'destroyTab', 'destroyUnresponsiveTab', 'createLeasedPage', 'closeLeasedPage'].map(serverFunction).join('\n'), box);
  const session = await box.getSession('owner');
  const opener = page();
  const { tabId } = registry.registerPage(session, 'owner', opener, 'original-task');
  session.lastUsedPage = opener;
  return { context, sessions, session, opener, tabId, registry, box, downloads, created,
    async retire(mode) {
      if (mode.startsWith('delayed')) {
        let finish;
        opener.close = () => new Promise(resolve => { finish = async () => {
          opener.closed = true; opener.emit('close'); resolve();
        }; });
        assert.equal(box.destroyTab(session, tabId, 'witness', 'owner'), true);
        assert.equal(findTabByPage(session, opener), null);
        return finish;
      }
      if (mode === 'timeout') {
        opener.close = () => new Promise(() => {});
        const retiring = box.destroyUnresponsiveTab(session, tabId, 'witness', 'owner');
        timers.find(timer => timer.ms === 100).callback();
        await turn();
        timers.find(timer => timer.ms === 25).callback();
        assert.equal(await retiring, true);
      } else {
        opener.close = async () => { throw new Error('synthetic close failure'); };
        assert.equal(await box.destroyUnresponsiveTab(session, tabId, 'witness', 'owner'), true);
      }
      assert.equal(opener.listenerCount('popup'), 0, 'failed safe close removes opener listeners');
      assert.equal(findTabByPage(session, opener), null);
      return async () => {};
    },
  };
}

for (const mode of ['delayed', 'delayed-settled', 'failed', 'timeout']) {
  for (const kind of ['ordinary', 'shared', 'shared-visible']) {
    for (const contextFirst of [true, false]) {
      it(`${mode} close, ${kind}, context-first=${contextFirst}: surviving popup stays managed without stale lineage`, async () => {
        const shared = kind !== 'ordinary';
        const f = await fixture(shared, kind === 'shared-visible');
        const finish = await f.retire(mode);
        assert.equal(f.opener.isClosed(), false, 'opener is still alive after tab removal');
        if (mode === 'delayed-settled') await finish();
        assert.equal(isQuarantinedPage(f.opener), true);
        assert.equal(f.session.lastUsedPage, null);
        // Reuse the retired ID for a different page before the late event.
        const replacement = page();
        f.registry.registerPage(f.session, 'owner', replacement, 'replacement-task', { tabId: f.tabId });
        const popup = page(f.opener);
        if (mode === 'delayed-settled') assert.equal(await popup.opener(), null);
        if (contextFirst) f.context.emit('page', popup);
        f.opener.emit('popup', popup);
        if (!contextFirst) f.context.emit('page', popup);
        await turn();
        const child = findTabByPage(f.session, popup);
        assert.ok(popup.isClosed() || child, 'live popup must be accounted for or closed');
        if (child) {
          assert.equal(child.listItemId, shared ? SHARED_IDENTITY_GROUP : '__popups__');
          assert.equal(child.tabState.openerPage, undefined, 'do not invent an opener reference');
          assert.equal(getOpenerTabId(f.session, child.tabState), null);
          assert.equal(f.downloads.filter(p => p === popup).length, 1);
          assert.equal(f.created.filter(entry => entry.page === popup).length, shared ? 1 : 0);
          assert.equal([...f.session.tabGroups.values()].flatMap(g => [...g.values()]).filter(t => t.page === popup).length, 1);
        }
        assert.equal(findTabByPage(f.session, replacement).tabId, f.tabId);
        assert.equal(findTabByPage(f.session, f.opener), null);
        assert.notEqual(f.session.lastUsedPage, f.opener);
        assert.equal(f.sessions.size, 1);
        await finish();
        await turn();
        assert.equal(findTabByPage(f.session, replacement).tabId, f.tabId, 'late close cannot remove replacement');
      });
    }
  }
}

it('ordinary context sightings remain unclaimed until explicit registration, without invented lineage', async () => {
  const f = await fixture(false);
  const unrelated = page();
  f.context.emit('page', unrelated);
  await turn();
  const provisional = findTabByPage(f.session, unrelated);
  assert.equal(provisional.listItemId, '__popups__');
  assert.equal(getOpenerTabId(f.session, provisional.tabState), null);
  const claimed = f.registry.registerPage(f.session, 'owner', unrelated, 'api-task');
  assert.equal(claimed.tabId, provisional.tabId);
  assert.equal(findTabByPage(f.session, unrelated).listItemId, 'api-task');
  assert.equal(f.downloads.filter(p => p === unrelated).length, 1);
  const healthyPopup = page(f.opener);
  f.context.emit('page', healthyPopup);
  f.opener.emit('popup', healthyPopup);
  await turn();
  const child = findTabByPage(f.session, healthyPopup);
  assert.equal(child.listItemId, 'original-task');
  assert.equal(getOpenerTabId(f.session, child.tabState), f.tabId);
  assert.equal(f.created.filter(entry => entry.page === healthyPopup).length, 1);
});

for (const shared of [false, true]) {
  it(`late retired popup cannot enter replacement session (shared=${shared})`, async () => {
    const f = await fixture(shared);
    const finish = await f.retire('delayed');
    const replacement = { sharedIdentity: shared, tabGroups: new Map() };
    f.sessions.set('owner', replacement);
    const popup = page(f.opener);
    f.opener.emit('popup', popup);
    f.context.emit('page', popup);
    await turn();
    assert.equal(findTabByPage(replacement, popup), null);
    assert.equal(getOpenerTabId(replacement, { page: popup, openerPage: f.opener }), null);
    await finish();
    // Rejection does not transfer old-context pages into the new session;
    // session teardown still owns their physical cleanup.
    await f.context.close();
    assert.equal(popup.isClosed(), true);
  });
}

for (const invalidation of ['closing', 'replaced']) {
  it(`rejects context sightings for a ${invalidation} session`, async () => {
    const f = await fixture(false);
    const finish = await f.retire('delayed');
    const popup = page(f.opener);
    const replacement = { tabGroups: new Map() };
    if (invalidation === 'closing') f.session._closing = true;
    else f.sessions.set('owner', replacement);
    f.context.emit('page', popup);
    await turn();
    assert.equal(findTabByPage(f.session, popup), null);
    assert.equal(findTabByPage(replacement, popup), null);
    assert.equal(f.session.lastUsedPage, null);
    await finish();
    await f.context.close();
    assert.equal(popup.isClosed(), true);
  });
}

it('ordinary temporary leased pages lose provisional accounting when cleanup succeeds', async () => {
  const f = await fixture(false);
  const { page: temporary, lease } = await f.box.createLeasedPage(f.session);
  assert.equal(findTabByPage(f.session, temporary).listItemId, '__popups__');
  await f.box.closeLeasedPage(f.session, temporary, lease);
  assert.equal(temporary.isClosed(), true);
  assert.equal(f.session.pageLeases.size, 0);
  assert.equal(findTabByPage(f.session, temporary), null);
});

it('failed temporary-page cleanup retains provisional accounting for the surviving page', async () => {
  const f = await fixture(false);
  const { page: temporary, lease } = await f.box.createLeasedPage(f.session);
  temporary.close = async () => { throw new Error('synthetic cleanup failure'); };
  await f.box.closeLeasedPage(f.session, temporary, lease);
  assert.equal(temporary.isClosed(), false);
  assert.equal(f.session.pageLeases.size, 0);
  assert.equal(findTabByPage(f.session, temporary).listItemId, '__popups__');
});

it('ordinary POST /tabs announces one final task-owned creation, not provisional accounting', async () => {
  const f = await fixture(false);
  let handler;
  Object.assign(f.box, {
    app: { post: (_path, callback) => { handler = callback; } },
    MAX_TABS_PER_SESSION: 100, MAX_TABS_GLOBAL: 100, getTotalTabCount: () => 1, requestTimeoutMs: () => 1000,
    withRequestDeadline: callback => callback(new AbortController().signal),
    createPageWithRecoveryForUser: async () => ({ session: f.session, ...await f.box.createLeasedPage(f.session) }),
    handleRouteError: error => { throw error; },
  });
  const start = source.indexOf("app.post('/tabs', async (req, res) => {");
  const end = source.indexOf('\n});', start) + 5;
  assert.ok(start >= 0 && end > start);
  vm.runInNewContext(source.slice(start, end), f.box);
  let response;
  await handler({ body: { userId: 'owner', sessionKey: 'new-api-task' }, headers: {} }, {
    json(value) { response = value; return this; },
    status() { return this; },
  });
  assert.ok(response.tabId);
  const events = f.created.filter(event => event.tabId === response.tabId);
  assert.equal(events.length, 1);
  assert.equal(findTabByPage(f.session, events[0].page).listItemId, 'new-api-task');
  assert.equal(f.downloads.filter(page => page === events[0].page).length, 1);
});

it('ordinary provisional replacement folds to the requested ID and keeps claimed close semantics', async () => {
  const f = await fixture(false);
  const { page: replacement, lease } = await f.box.createLeasedPage(f.session);
  const provisional = findTabByPage(f.session, replacement);
  assert.equal(provisional.listItemId, '__popups__');
  const folded = f.registry.registerPage(f.session, 'owner', replacement, 'original-task', { tabId: f.tabId });
  releasePageLease(f.session, lease);
  assert.equal(folded.tabId, f.tabId);
  assert.equal(findTabByPage(f.session, f.opener), null);
  assert.equal(findTabByPage(f.session, replacement).tabId, f.tabId);
  assert.equal(f.downloads.filter(page => page === replacement).length, 1);
  assert.equal(f.created.filter(event => event.page === replacement).length, 0, 'do not publish a provisional ID');
  await replacement.close();
  assert.equal(findTabByPage(f.session, replacement).tabId, f.tabId, 'claimed ordinary tabs retain dead-page recovery semantics');
});
