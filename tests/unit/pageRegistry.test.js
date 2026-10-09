import { jest } from '@jest/globals';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { createPageRegistry, findTabByPage, tabIdsForPage, SHARED_IDENTITY_GROUP } from '../../lib/page-registry.js';

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
  return { userId, session, registry, context, newPage, released, logged, created, downloadListeners, allEntries, expectOneIdPerPage };
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

describe('GET /tabs lists each page once', () => {
  const source = readFileSync(new URL('../../server.js', import.meta.url), 'utf8');
  const start = source.indexOf("app.get('/tabs', async");
  const route = source.slice(start, source.indexOf('// POST /tabs/open', start));

  test('after both registration events fire for a popup', async () => {
    const f = fixture();
    let handler;
    runInNewContext(route, {
      app: { get: (_path, callback) => { handler = callback; } },
      sessions: new Map([[f.userId, f.session]]), normalizeUserId: value => value,
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
  });
});

describe('shared idle close guard', () => {
  const source = readFileSync(new URL('../../server.js', import.meta.url), 'utf8');
  const start = source.indexOf('function sharedTabClosable(');
  const fn = source.slice(start, source.indexOf('\n}\n', start) + 3);

  test('refuses to close a page that another tab ID still references', () => {
    const page = fakePage();
    const tab = { page };
    const session = { tabGroups: new Map([['a', new Map([['one', tab]])], ['b', new Map([['two', { page }]])]]) };
    const scope = {
      tabLocks: new Map(), humanControlledTabs: new Set(), isPageLeased: () => false, tabIdsForPage,
      findTab: (current, tabId) => {
        for (const group of current.tabGroups.values()) if (group.has(tabId)) return { tabState: group.get(tabId) };
        return null;
      },
    };
    runInNewContext(`${fn}\nthis.sharedTabClosable = sharedTabClosable;`, scope);
    expect(scope.sharedTabClosable(session, 'one', tab, 'latest')).toBe(false);
    session.tabGroups.delete('b');
    expect(scope.sharedTabClosable(session, 'one', tab, 'latest')).toBe(true);
  });
});
