import { jest } from '@jest/globals';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { createPageRegistry, findTabByPage, getOpenerTabId, tabIdsForPage, SHARED_IDENTITY_GROUP } from '../../lib/page-registry.js';
import { tabClosable } from '../../lib/idle-tabs.js';

// A shared persistent identity sees every page twice: once from the context
// `page` event and once from the path that caused it (popup, tab creation, or
// dead-page replacement). These tests drive the real registry with
// deterministic fake pages and assert each page keeps exactly one tab ID.

function fakePage(url = 'about:blank') {
  const page = new EventEmitter();
  let closed = false;
  page.url = () => url;
  page.title = async () => '';
  page.isClosed = () => closed;
  page.close = async () => { closed = true; page.emit('close'); };
  return page;
}

function fixture() {
  let next = 0;
  const userId = 'shared-user';
  const context = new EventEmitter();
  const session = { sharedIdentity: true, tabGroups: new Map(), context };
  const sessions = new Map([[userId, session]]);
  const released = [];
  const logged = [];
  const created = [];
  const downloadListeners = [];
  const registry = createPageRegistry({
    sessions,
    makeTabId: () => `tab-${++next}`,
    createTabState: page => ({ page, visitedUrls: new Set() }),
    attachDownloadListener: (tabState, tabId) => downloadListeners.push({ tabState, tabId }),
    releaseTabId: tabId => released.push(tabId),
    log: (_level, message, fields) => logged.push({ message, ...fields }),
    emit: (event, payload) => { if (event === 'tab:created') created.push(payload.tabId); },
  });
  // Mirrors server.js: the persistent context registers every page it opens.
  context.on('page', page => registry.registerSharedIdentityPage(session, userId, page));
  const newPage = () => { const page = fakePage(); context.emit('page', page); return page; };
  const allEntries = () => [...session.tabGroups.values()].flatMap(group => [...group]);
  // The invariant: no page is referenced by more than one tab ID.
  const expectOneIdPerPage = () => {
    const pages = allEntries().map(([, tab]) => tab.page);
    expect(new Set(pages).size).toBe(pages.length);
    for (const page of pages) expect(tabIdsForPage(session, page)).toHaveLength(1);
  };
  return { userId, session, sessions, registry, context, newPage, released, logged, created, downloadListeners, allEntries, expectOneIdPerPage };
}

describe('one Playwright page, one tab ID', () => {
  test('context page event first, then the opener popup event, yields one tab ID', () => {
    const f = fixture();
    const opener = f.newPage();
    const { tabId: openerId } = f.registry.registerPage(f.session, f.userId, opener, 'task-a');

    const popup = fakePage('https://example.test/popup');
    f.context.emit('page', popup);
    opener.emit('popup', popup);

    const popupIds = tabIdsForPage(f.session, popup);
    expect(popupIds).toHaveLength(1);
    expect(f.created.filter(id => id === popupIds[0])).toHaveLength(1);
    expect(f.downloadListeners.filter(entry => entry.tabState.page === popup)).toHaveLength(1);
    // The popup belongs to the opener's task, not the unclaimed group.
    expect(findTabByPage(f.session, popup).listItemId).toBe('task-a');
    expect(popupIds[0]).not.toBe(openerId);
    f.expectOneIdPerPage();
  });

  test('opener popup event first, then the context page event, yields one tab ID', () => {
    const f = fixture();
    const opener = f.newPage();
    f.registry.registerPage(f.session, f.userId, opener, 'task-a');

    const popup = fakePage('https://example.test/popup');
    opener.emit('popup', popup);
    f.context.emit('page', popup);

    expect(tabIdsForPage(f.session, popup)).toHaveLength(1);
    expect(findTabByPage(f.session, popup).listItemId).toBe('task-a');
    expect(f.logged.filter(entry => entry.message === 'shared identity page registered'
      && entry.tabId === findTabByPage(f.session, popup).tabId)).toHaveLength(0);
    f.expectOneIdPerPage();
  });

  test('a popup of an unclaimed shared page registers once and a nested popup follows its opener', () => {
    const f = fixture();
    const opener = f.newPage();
    const popup = fakePage();
    f.context.emit('page', popup);
    opener.emit('popup', popup);
    const nested = fakePage();
    popup.emit('popup', nested);
    f.context.emit('page', nested);
    expect(f.allEntries()).toHaveLength(3);
    f.expectOneIdPerPage();
  });

  test('a page a task already holds is never moved by a later context sighting', () => {
    const f = fixture();
    const page = f.newPage();
    const { tabId } = f.registry.registerPage(f.session, f.userId, page, 'task-a');
    expect(f.registry.registerSharedIdentityPage(f.session, f.userId, page)).toBe(tabId);
    expect(findTabByPage(f.session, page).listItemId).toBe('task-a');
    expect(f.session.tabGroups.has(SHARED_IDENTITY_GROUP)).toBe(false);
  });

  test('replacing a closed page keeps the tab ID and folds the context registration into it', async () => {
    const f = fixture();
    const original = f.newPage();
    const { tabId } = f.registry.registerPage(f.session, f.userId, original, 'task-a');
    await original.close();
    // The close listener has removed the tab; navigation now replaces its page.
    expect(findTabByPage(f.session, original)).toBeNull();

    const replacement = f.newPage(); // context event registers it under a new ID first
    const contextId = findTabByPage(f.session, replacement).tabId;
    expect(contextId).not.toBe(tabId);

    const result = f.registry.registerPage(f.session, f.userId, replacement, 'task-a', { tabId });
    expect(result.tabId).toBe(tabId);
    expect(tabIdsForPage(f.session, replacement)).toEqual([tabId]);
    expect(f.released).toContain(contextId);
    expect(f.allEntries().map(([id]) => id)).toEqual([tabId]);
    expect(result.tabState.tabId).toBe(tabId);
    f.expectOneIdPerPage();
  });

  test('replacing a live page in place drops the retired state and keeps one ID', () => {
    const f = fixture();
    const original = f.newPage();
    const { tabId, tabState: before } = f.registry.registerPage(f.session, f.userId, original, 'task-a');
    const replacement = f.newPage();
    const { tabState: after } = f.registry.registerPage(f.session, f.userId, replacement, 'task-a', { tabId });
    expect(after).not.toBe(before);
    expect(findTabByPage(f.session, replacement).tabId).toBe(tabId);
    expect(findTabByPage(f.session, original)).toBeNull();
    f.expectOneIdPerPage();
  });

  test('replacement on a non-shared session creates no second registration', () => {
    const f = fixture();
    f.session.sharedIdentity = false;
    const page = fakePage();
    const { tabId } = f.registry.registerPage(f.session, f.userId, page, 'task-a');
    const replacement = fakePage();
    expect(f.registry.registerSharedIdentityPage(f.session, f.userId, replacement)).toBeNull();
    f.registry.registerPage(f.session, f.userId, replacement, 'task-a', { tabId });
    expect(f.allEntries().map(([id]) => id)).toEqual([tabId]);
  });

  test('the incident sequence ends with every page under exactly one tab ID', async () => {
    const f = fixture();
    const opener = f.newPage();
    f.registry.registerPage(f.session, f.userId, opener, 'irs-task');
    const popup = fakePage('https://irs.example/login');
    f.context.emit('page', popup);
    opener.emit('popup', popup);
    const popupId = findTabByPage(f.session, popup).tabId;

    await popup.close(); // the idle reaper closes the page
    const replacement = f.newPage(); // POST /tabs/:popupId/navigate replaces it
    f.registry.registerPage(f.session, f.userId, replacement, 'irs-task', { tabId: popupId });

    expect(tabIdsForPage(f.session, replacement)).toEqual([popupId]);
    f.expectOneIdPerPage();
  });
});

describe('observed popup lineage', () => {
  test.each([
    [true, true, 'task-a'], [true, false, 'task-a'],
    [true, true, SHARED_IDENTITY_GROUP], [true, false, SHARED_IDENTITY_GROUP],
    [false, false, 'task-a'],
  ])('shared=%s, context-first=%s, group=%s', (shared, contextFirst, group) => {
    const f = fixture();
    f.session.sharedIdentity = shared;
    const opener = fakePage();
    const { tabId: openerId } = f.registry.registerPage(f.session, f.userId, opener, group);
    const sibling = f.newPage();
    const popup = fakePage();
    if (contextFirst) f.context.emit('page', popup);
    opener.emit('popup', popup);
    if (!contextFirst) f.context.emit('page', popup);
    const child = findTabByPage(f.session, popup);
    expect(getOpenerTabId(f.session, child.tabState)).toBe(openerId);
    expect(child.listItemId).toBe(group);
    expect(getOpenerTabId(f.session, findTabByPage(f.session, opener).tabState)).toBeNull();
    if (shared) expect(getOpenerTabId(f.session, findTabByPage(f.session, sibling).tabState)).toBeNull();
    const nested = fakePage();
    popup.emit('popup', nested);
    expect(getOpenerTabId(f.session, findTabByPage(f.session, nested).tabState)).toBe(child.tabId);
    f.expectOneIdPerPage();
  });

  test.each([true, false])('folds follow the exact opener page and preserve a folded child lineage (shared=%s)', shared => {
    const f = fixture();
    f.session.sharedIdentity = shared;
    const opener = fakePage();
    f.registry.registerPage(f.session, f.userId, opener, SHARED_IDENTITY_GROUP);
    const popup = fakePage();
    opener.emit('popup', popup);
    const child = findTabByPage(f.session, popup).tabState;
    f.registry.registerPage(f.session, f.userId, opener, 'task-a', { tabId: 'folded-opener' });
    expect(getOpenerTabId(f.session, child)).toBe('folded-opener');
    f.registry.registerPage(f.session, f.userId, popup, 'task-a', { tabId: 'folded-child' });
    expect(getOpenerTabId(f.session, findTabByPage(f.session, popup).tabState)).toBe('folded-opener');
    f.expectOneIdPerPage();
  });

  test.each([true, false])('closing an opener clears only its direct children while live chains stay usable (shared=%s)', async shared => {
    const f = fixture();
    f.session.sharedIdentity = shared;
    const opener = fakePage();
    const { tabId } = f.registry.registerPage(f.session, f.userId, opener, 'task-a');
    const popup = fakePage('https://example.test/popup');
    const sibling = fakePage();
    opener.emit('popup', popup);
    opener.emit('popup', sibling);
    const child = findTabByPage(f.session, popup);
    const siblingState = findTabByPage(f.session, sibling).tabState;
    const nested = fakePage();
    popup.emit('popup', nested);
    const nestedState = findTabByPage(f.session, nested).tabState;
    expect(child.tabState.openerPage).toBe(opener);
    expect(siblingState.openerPage).toBe(opener);
    expect(getOpenerTabId(f.session, child.tabState)).toBe(tabId);

    await opener.close();

    // Inspect the reference before any lineage read can lazily clear it.
    expect(child.tabState.openerPage).toBeNull();
    expect(siblingState.openerPage).toBeNull();
    expect(popup.isClosed()).toBe(false);
    expect(sibling.isClosed()).toBe(false);
    expect(findTabByPage(f.session, popup).tabState).toBe(child.tabState);
    expect(popup.url()).toBe('https://example.test/popup');
    expect(getOpenerTabId(f.session, child.tabState)).toBeNull();
    expect(nestedState.openerPage).toBe(popup);
    expect(getOpenerTabId(f.session, nestedState)).toBe(child.tabId);
    const later = fakePage();
    popup.emit('popup', later);
    expect(getOpenerTabId(f.session, findTabByPage(f.session, later).tabState)).toBe(child.tabId);
    await popup.close();
    expect(nestedState.openerPage).toBeNull();
    expect(findTabByPage(f.session, later).tabState.openerPage).toBeNull();
    expect(nested.isClosed()).toBe(false);
    f.expectOneIdPerPage();
  });

  test.each([true, false])('a folded opener still clears its live child on close (shared=%s)', async shared => {
    const f = fixture();
    f.session.sharedIdentity = shared;
    const opener = fakePage();
    f.registry.registerPage(f.session, f.userId, opener, 'task-a');
    const popup = fakePage();
    opener.emit('popup', popup);
    const child = findTabByPage(f.session, popup).tabState;
    f.registry.registerPage(f.session, f.userId, opener, 'task-b', { tabId: 'folded-opener' });
    expect(getOpenerTabId(f.session, child)).toBe('folded-opener');
    await opener.close();
    expect(child.openerPage).toBeNull();
    expect(getOpenerTabId(f.session, child)).toBeNull();
    expect(popup.isClosed()).toBe(false);
  });

  test.each([true, false])('closed openers cannot lend their ID to replacement pages (shared=%s)', async shared => {
    const f = fixture();
    f.session.sharedIdentity = shared;
    const opener = fakePage();
    const { tabId } = f.registry.registerPage(f.session, f.userId, opener, 'task-a');
    const popup = fakePage();
    opener.emit('popup', popup);
    const child = findTabByPage(f.session, popup).tabState;
    await opener.close();
    expect(getOpenerTabId(f.session, child)).toBeNull();
    f.registry.registerPage(f.session, f.userId, fakePage(), 'task-a', { tabId });
    expect(getOpenerTabId(f.session, child)).toBeNull();
    await popup.close();
    expect(getOpenerTabId(f.session, child)).toBeNull();
  });

  test('replaced live opener and child pages do not retain stale affinity', () => {
    const f = fixture();
    const opener = f.newPage();
    const openerId = findTabByPage(f.session, opener).tabId;
    const popup = fakePage();
    opener.emit('popup', popup);
    const { tabId, tabState } = findTabByPage(f.session, popup);
    const replacement = f.newPage();
    f.registry.registerPage(f.session, f.userId, replacement, 'task-a', { tabId: openerId });
    expect(getOpenerTabId(f.session, tabState)).toBeNull();
    const replacedChild = f.registry.registerPage(f.session, f.userId, f.newPage(), 'task-a', { tabId });
    expect(getOpenerTabId(f.session, replacedChild.tabState)).toBeNull();
    const late = fakePage();
    opener.emit('popup', late);
    expect(findTabByPage(f.session, late)).toBeNull();
  });

  test.each([true, false])('a replaced live opener clears its old children only when that exact page closes (shared=%s)', async shared => {
    const f = fixture();
    f.session.sharedIdentity = shared;
    const opener = fakePage();
    const { tabId } = f.registry.registerPage(f.session, f.userId, opener, 'task-a');
    const popup = fakePage();
    opener.emit('popup', popup);
    const child = findTabByPage(f.session, popup).tabState;
    const replacement = fakePage();
    f.registry.registerPage(f.session, f.userId, replacement, 'task-a', { tabId });
    expect(getOpenerTabId(f.session, child)).toBeNull();
    const replacementPopup = fakePage();
    replacement.emit('popup', replacementPopup);
    const replacementChild = findTabByPage(f.session, replacementPopup).tabState;
    expect(getOpenerTabId(f.session, replacementChild)).toBe(tabId);

    await opener.close();

    expect(child.openerPage).toBeNull();
    expect(getOpenerTabId(f.session, child)).toBeNull();
    expect(replacementChild.openerPage).toBe(replacement);
    expect(getOpenerTabId(f.session, replacementChild)).toBe(tabId);
    expect(findTabByPage(f.session, replacement).tabId).toBe(tabId);
    expect(replacement.isClosed()).toBe(false);
    const late = fakePage();
    opener.emit('popup', late);
    expect(findTabByPage(f.session, late)).toBeNull();
    f.expectOneIdPerPage();
  });

  test.each([true, false])('a late popup or close event cannot enter a replacement session for the same user (shared=%s)', async shared => {
    const f = fixture();
    f.session.sharedIdentity = shared;
    const opener = fakePage();
    const { tabId } = f.registry.registerPage(f.session, f.userId, opener, 'task-a');
    const childPage = fakePage();
    opener.emit('popup', childPage);
    const oldChild = findTabByPage(f.session, childPage).tabState;
    const replacement = { sharedIdentity: shared, tabGroups: new Map() };
    f.sessions.set(f.userId, replacement);
    const replacementOpener = fakePage();
    f.registry.registerPage(replacement, f.userId, replacementOpener, 'task-a', { tabId });
    const replacementPopup = fakePage();
    replacementOpener.emit('popup', replacementPopup);
    const replacementChild = findTabByPage(replacement, replacementPopup).tabState;
    const popup = fakePage();
    opener.emit('popup', popup);
    expect(findTabByPage(replacement, popup)).toBeNull();
    expect(findTabByPage(f.session, popup)).toBeNull();
    expect(getOpenerTabId(replacement, { page: popup, openerPage: opener })).toBeNull();
    f.sessions.set(f.userId, f.session);
    f.session._closing = true;
    opener.emit('popup', popup);
    expect(findTabByPage(f.session, popup)).toBeNull();
    expect(getOpenerTabId(replacement, oldChild)).toBeNull();
    f.sessions.set(f.userId, replacement);
    await opener.close();
    expect(oldChild.openerPage).toBeNull();
    expect(replacementChild.openerPage).toBe(replacementOpener);
    expect(getOpenerTabId(replacement, replacementChild)).toBe(tabId);
    expect(findTabByPage(replacement, replacementOpener).tabId).toBe(tabId);
  });
});

describe('popup visibility binding at registration', () => {
  test('popup registration asks the visibility controller to locate only the popup page', () => {
    const f = fixture();
    const locatePage = jest.fn(async () => true);
    f.session.visibility = { locatePage };
    const opener = f.newPage();
    f.registry.registerPage(f.session, f.userId, opener, 'task-a');
    const popup = fakePage('https://example.test/popup');
    opener.emit('popup', popup);
    expect(locatePage).toHaveBeenCalledTimes(1);
    expect(locatePage).toHaveBeenCalledWith(popup);
    // Ordinary context pages are not located at registration.
    f.newPage();
    expect(locatePage).toHaveBeenCalledTimes(1);
    f.expectOneIdPerPage();
  });

  test('a rejecting locatePage never blocks popup registration', () => {
    const f = fixture();
    f.session.visibility = { locatePage: async () => { throw Error('locate failed'); } };
    const opener = f.newPage();
    const popup = fakePage('https://example.test/popup');
    expect(() => opener.emit('popup', popup)).not.toThrow();
    expect(findTabByPage(f.session, popup)).not.toBeNull();
    f.expectOneIdPerPage();
  });
});

describe('GET /tabs lists each page once', () => {
  const source = readFileSync(new URL('../../server.js', import.meta.url), 'utf8');
  const start = source.indexOf("app.get('/tabs', async");
  const route = source.slice(start, source.indexOf('// POST /tabs/open', start));

  test('after both registration events fire for a popup', async () => {
    const f = fixture();
    let handler;
    runInNewContext(route, {
      app: { get: (_path, callback) => { handler = callback; } },
      sessions: f.sessions, normalizeUserId: value => value, getOpenerTabId,
      log: () => {}, handleRouteError: err => { throw err; },
    });
    const opener = f.newPage();
    f.registry.registerPage(f.session, f.userId, opener, 'task-a');
    const popup = fakePage('https://example.test/popup');
    opener.emit('popup', popup);
    f.context.emit('page', popup);

    const res = { json: jest.fn() };
    await handler({ query: { userId: f.userId } }, res);
    const { tabs } = res.json.mock.calls[0][0];
    expect(tabs).toHaveLength(2);
    expect(new Set(tabs.map(tab => tab.tabId)).size).toBe(2);
    expect(tabs.filter(tab => tab.url === 'https://example.test/popup')).toHaveLength(1);
    const openerId = findTabByPage(f.session, opener).tabId;
    expect(tabs.find(tab => tab.tabId === openerId).openerTabId).toBeNull();
    expect(tabs.find(tab => tab.url === 'https://example.test/popup').openerTabId).toBe(openerId);
  });
});

describe('shared idle close guard', () => {
  test('refuses to close a page that another tab ID still references', () => {
    const page = fakePage();
    const tab = { page };
    const session = { tabGroups: new Map([['a', new Map([['one', tab]])], ['b', new Map([['two', { page }]])]]) };
    const options = { tabLocks: new Map(), humanControlledTabs: new Set() };
    expect(tabClosable({ session, tabId: 'one', tab, latestTabId: 'latest', ...options })).toBe(false);
    session.tabGroups.delete('b');
    expect(tabClosable({ session, tabId: 'one', tab, latestTabId: 'latest', ...options })).toBe(true);
  });
});
