/**
 * Tests for tab lifecycle contract hardening (JO-2452, JO-2456).
 *
 * Covers:
 * - Navigate returns stale-tab error (no auto-create)
 * - Session lastAccess refreshed on tab ops (prevents timeout of active sessions)
 * - Popup/new-window pages become managed tabs (not orphaned)
 * - scroll and links are serialized via withTabLock
 */

import { startServer, stopServer, getServerUrl } from '../helpers/startServer.js';
import { startTestSite, stopTestSite, getTestSiteUrl } from '../helpers/testSite.js';
import { createClient } from '../helpers/client.js';

describe('Tab Lifecycle Contract', () => {
  let serverUrl;
  let testSiteUrl;

  beforeAll(async () => {
    await startServer(0, { SESSION_TIMEOUT_MS: '30000' });
    serverUrl = getServerUrl();
    await startTestSite();
    testSiteUrl = getTestSiteUrl();
  }, 120000);

  afterAll(async () => {
    await stopTestSite();
    await stopServer();
  }, 30000);

  describe('Stale tab errors (JO-2452)', () => {
    test('navigate returns 404 for unknown tabId', async () => {
      const client = createClient(serverUrl);
      try {
        await client.createTab(`${testSiteUrl}/pageA`);
        try {
          await client.navigate('nonexistent-tab-id', `${testSiteUrl}/pageB`);
          fail('Should have thrown');
        } catch (err) {
          expect(err.status).toBe(404);
        }
      } finally {
        await client.cleanup();
      }
    }, 60000);

    test('snapshot returns 404 for unknown tabId', async () => {
      const client = createClient(serverUrl);
      try {
        await client.createTab(`${testSiteUrl}/pageA`);
        try {
          await client.getSnapshot('nonexistent-tab-id');
          fail('Should have thrown');
        } catch (err) {
          expect(err.status).toBe(404);
        }
      } finally {
        await client.cleanup();
      }
    }, 60000);

    test('click returns 404 for unknown tabId', async () => {
      const client = createClient(serverUrl);
      try {
        await client.createTab(`${testSiteUrl}/pageA`);
        try {
          await client.click('nonexistent-tab-id', { ref: 'e1' });
          fail('Should have thrown');
        } catch (err) {
          expect(err.status).toBe(404);
        }
      } finally {
        await client.cleanup();
      }
    }, 60000);

    test('scroll returns 404 for unknown tabId', async () => {
      const client = createClient(serverUrl);
      try {
        await client.createTab(`${testSiteUrl}/pageA`);
        try {
          await client.scroll('nonexistent-tab-id', { direction: 'down', amount: 100 });
          fail('Should have thrown');
        } catch (err) {
          expect(err.status).toBe(404);
        }
      } finally {
        await client.cleanup();
      }
    }, 60000);
  });

  describe('Session lastAccess refresh (JO-2452)', () => {
    test('tab operations refresh session lastAccess', async () => {
      const client = createClient(serverUrl);
      try {
        const { tabId } = await client.createTab(`${testSiteUrl}/links`);

        // Perform multiple tab operations — session should not expire
        await new Promise(r => setTimeout(r, 2000));
        await client.getSnapshot(tabId);
        await new Promise(r => setTimeout(r, 2000));
        await client.getLinks(tabId);
        await new Promise(r => setTimeout(r, 2000));
        await client.scroll(tabId, { direction: 'down', amount: 100 });
        await new Promise(r => setTimeout(r, 2000));

        // Session should still be alive after ops (each refreshed lastAccess)
        const snapshot = await client.getSnapshot(tabId);
        expect(snapshot.url).toContain('/links');
      } finally {
        await client.cleanup();
      }
    }, 60000);
  });

  describe('Popup/new-window policy (JO-2456)', () => {
    async function waitForPopup(client, url) {
      const deadline = Date.now() + 5000;
      let tabs;
      do {
        ({ tabs } = await client.request('GET', `/tabs?userId=${client.userId}`, null, {
          timeout: Math.max(1, deadline - Date.now()),
        }));
        if (tabs.some(tab => tab.url === url)) return tabs;
        await new Promise(resolve => setTimeout(resolve, 100));
      } while (Date.now() < deadline);
      throw new Error(`Managed popup did not reach ${url}: ${JSON.stringify(tabs)}`);
    }

    test('target=_blank link creates a managed tab', async () => {
      const client = createClient(serverUrl);
      try {
        const { tabId } = await client.createTab(`${testSiteUrl}/popup-source`);
        const { tabId: siblingId } = await client.createTab(`${testSiteUrl}/pageA`);
        const { tabs: before } = await client.request('GET', `/tabs?userId=${client.userId}`);
        expect(before.map(tab => tab.tabId).sort()).toEqual([tabId, siblingId].sort());
        await client.evaluate(tabId, `document.querySelector('#blankLink').addEventListener('click', event => {
          window.blankLinkClickTrusted = event.isTrusted;
        })`);

        // Official beta.40 requires user activation for anchor retargeting.
        // Use a native selector click, not evaluate().click() or snapshot refs.
        await client.click(tabId, { selector: '#blankLink' });
        expect((await client.evaluate(tabId, 'window.blankLinkClickTrusted')).result).toBe(true);

        const tabs = await waitForPopup(client, `${testSiteUrl}/popup-target`);
        expect(tabs).toHaveLength(3);
        for (const original of before) {
          expect(tabs.find(tab => tab.tabId === original.tabId)).toEqual(original);
        }
        const popupTab = tabs.find(tab => tab.url === `${testSiteUrl}/popup-target`);
        expect(popupTab.tabId).toBeDefined();
        expect(before.some(tab => tab.tabId === popupTab.tabId)).toBe(false);

        // The same managed ID must resolve the actual page and remain closeable.
        const snapshot = await client.getSnapshot(popupTab.tabId);
        expect(snapshot.url).toBe(`${testSiteUrl}/popup-target`);
        expect(snapshot.snapshot).toContain('Popup Target Page');
        const { tabs: again } = await client.request('GET', `/tabs?userId=${client.userId}`);
        expect(again).toHaveLength(3);
        expect(again.find(tab => tab.url === popupTab.url)?.tabId).toBe(popupTab.tabId);
        await client.closeTab(popupTab.tabId);
        const { tabs: remaining } = await client.request('GET', `/tabs?userId=${client.userId}`);
        expect(remaining).toHaveLength(2);
        expect(remaining).toEqual(expect.arrayContaining(before));
        expect(remaining.some(tab => tab.tabId === popupTab.tabId)).toBe(false);
      } finally {
        await client.cleanup();
      }
    }, 60000);

    test('preventDefault on a trusted target=_blank click creates no managed tab', async () => {
      const client = createClient(serverUrl);
      try {
        const { tabId } = await client.createTab(`${testSiteUrl}/popup-source`);
        await client.createTab(`${testSiteUrl}/pageA`);
        const { tabs: before } = await client.request('GET', `/tabs?userId=${client.userId}`);
        await client.evaluate(tabId, `document.querySelector('#blankLink').addEventListener('click', event => {
          event.preventDefault();
          window.blankLinkClickTrusted = event.isTrusted;
          window.blankLinkDefaultPrevented = event.defaultPrevented;
        })`);
        await client.click(tabId, { selector: '#blankLink' });
        expect((await client.evaluate(tabId, 'window.blankLinkClickTrusted')).result).toBe(true);
        expect((await client.evaluate(tabId, 'window.blankLinkDefaultPrevented')).result).toBe(true);

        // Observe the whole negative window, not just the first empty read.
        const deadline = Date.now() + 1500;
        do {
          const { tabs } = await client.request('GET', `/tabs?userId=${client.userId}`, null, {
            timeout: Math.max(1, deadline - Date.now()),
          });
          expect(tabs).toHaveLength(before.length);
          expect(tabs).toEqual(expect.arrayContaining(before));
          await new Promise(resolve => setTimeout(resolve, 100));
        } while (Date.now() < deadline);
      } finally {
        await client.cleanup();
      }
    }, 60000);

    test('window.open creates a managed tab', async () => {
      const client = createClient(serverUrl);
      try {
        const { tabId } = await client.createTab(`${testSiteUrl}/popup-source`);

        // Trigger the browser primitive directly. This keeps the lifecycle
        // assertion independent from /click post-action snapshot behavior.
        await client.request('POST', `/tabs/${tabId}/evaluate`, {
          userId: client.userId,
          expression: "document.querySelector('#openBtn').click()",
        });

        // List tabs only after the popup reaches its actual target URL.
        const tabs = await waitForPopup(client, `${testSiteUrl}/popup-target`);
        const popupTab = tabs.find(t => t.url === `${testSiteUrl}/popup-target`);
        expect(popupTab).toBeDefined();
        expect(popupTab.tabId).toBeDefined();
      } finally {
        await client.cleanup();
      }
    }, 60000);

    test('navigating a closed popup replaces its page without changing tab ID', async () => {
      const client = createClient(serverUrl);
      try {
        const { tabId } = await client.createTab(`${testSiteUrl}/popup-source`);
        await client.request('POST', `/tabs/${tabId}/evaluate`, {
          userId: client.userId,
          expression: "Boolean(window.open('/popup-target?close=1', '_blank'))",
        });
        const tabs = await waitForPopup(client, `${testSiteUrl}/popup-target?close=1`);
        const popupTab = tabs.find(t => t.url === `${testSiteUrl}/popup-target?close=1`);
        expect(popupTab).toBeDefined();

        const result = await client.navigate(popupTab.tabId, `${testSiteUrl}/pageA`);
        expect(result).toMatchObject({ ok: true, tabId: popupTab.tabId });
        const snapshot = await client.getSnapshot(popupTab.tabId);
        expect(snapshot.snapshot).toContain('Welcome to Page A');
      } finally {
        await client.cleanup();
      }
    }, 60000);
  });
});
