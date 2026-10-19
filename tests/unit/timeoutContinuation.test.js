import { readFileSync } from 'fs';
import { browserErrorCode, browserErrorRecovery, browserErrorStatus } from '../../lib/browser-errors.js';
import { startServer, stopServer, getServerUrl } from '../helpers/startServer.js';
import { createClient } from '../helpers/client.js';
import { startTestSite, stopTestSite, getTestSiteUrl } from '../helpers/testSite.js';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

describe('timed-out tab operations', () => {
  let serverUrl;
  let testSiteUrl;

  beforeAll(async () => {
    await startServer(0, { HANDLER_TIMEOUT_MS: '5000' });
    serverUrl = getServerUrl();
    await startTestSite();
    testSiteUrl = getTestSiteUrl();
  }, 120000);

  afterAll(async () => {
    await stopTestSite();
    await stopServer();
  }, 30000);

  test('routes slow clicks through the shared recoverable timeout path', () => {
    const source = readFileSync(new URL('../../server.js', import.meta.url), 'utf8');
    const clickStart = source.indexOf("app.post('/tabs/:tabId/click'");
    const clickRoute = source.slice(clickStart, source.indexOf("app.post('/tabs/:tabId/upload'", clickStart));

    for (const action of ['move', 'down', 'up']) {
      expect(clickRoute).toContain(`withTimeout(tabState.page.mouse.${action}`);
    }
    expect(clickRoute).toContain('withTabLock(tabId');
    expect(clickRoute).not.toContain('destroyTimedOutTab');
  });

  test('returns a stable recoverable error after a timeout', () => {
    const error = Object.assign(new Error('action timed out after 5000ms'), { code: 'tab_timeout' });

    expect(browserErrorStatus(error)).toBe(410);
    expect(browserErrorCode(error)).toBe('tab_timeout');
    expect(browserErrorRecovery(error)).toBe('retry');
  });

  test('keeps a tab when a slow click becomes non-actionable', async () => {
    const client = createClient(serverUrl);
    try {
      const { tabId } = await client.createTab(`${testSiteUrl}/slow-click?ms=8000`);
      await expect(client.click(tabId, { selector: '#slow' })).rejects.toMatchObject({
        status: 422,
        data: expect.objectContaining({ code: 'element_not_actionable', recovery: 'snapshot_then_retry' }),
      });
      const stats = await client.getStats(tabId);
      expect(stats.tabId).toBe(tabId);
    } finally {
      await client.cleanup();
    }
  }, 30000);
  test('keeps the tab available for queued evaluate work after an evaluate timeout', async () => {
    const client = createClient(serverUrl);
    const { tabId } = await client.createTab();

    try {
      const baselineCalls = (await client.getStats(tabId)).toolCalls;
      const first = client.evaluate(tabId, 'new Promise(() => {})').catch(error => error);
      // The queued request must arrive after the hung one holds the tab lock.
      // A fixed sleep raced under host load: the queued evaluate could win the
      // lock, return 42, and fail the test. The evaluate route counts the call
      // synchronously before acquiring the lock, so wait for that counter.
      const deadline = Date.now() + 4000;
      while ((await client.getStats(tabId)).toolCalls <= baselineCalls) {
        if (Date.now() > deadline) throw new Error('first evaluate never reached the tab lock');
        await wait(20);
      }
      const queued = client.evaluate(tabId, '42').catch(error => error);
      const [firstError, queuedError] = await Promise.all([first, queued]);

      expect(firstError.status).toBe(410);
      expect(firstError.data.code).toBe('tab_timeout');
      expect(firstError.data.recovery).toBe('retry');
      expect(queuedError.status).toBeUndefined();
      expect(queuedError.result).toBe(42);

      const stats = await client.getStats(tabId);
      expect(stats.tabId).toBe(tabId);
    } finally {
      await client.cleanup();
    }
  }, 30000);
});
