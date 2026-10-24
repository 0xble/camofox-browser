import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { browserErrorCode, browserErrorRecovery, browserErrorStatus } from '../../lib/browser-errors.js';
import { startServer, stopServer, getServerUrl } from '../helpers/startServer.js';
import { createClient } from '../helpers/client.js';
import { startTestSite, stopTestSite, getTestSiteUrl } from '../helpers/testSite.js';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

describe('timed-out tab operations', () => {
  let serverUrl;
  let testSiteUrl;
  let stateDir;
  let gateServer, gateUrl, gateResponse;

  beforeAll(async () => {
    stateDir = mkdtempSync(join(tmpdir(), 'camofox-timeout-'));
    await startServer(0, {
      HANDLER_TIMEOUT_MS: '5000', CAMOFOX_SHARED_IDENTITIES: 'timeout-probe',
      CAMOFOX_SHARED_IDENTITY_MAP: '', CAMOFOX_SHARED_IDENTITY_EXTENSIONS: '',
      CAMOFOX_SHARED_PROFILE_DIR: join(stateDir, 'shared'), CAMOFOX_PROFILE_DIR: join(stateDir, 'profiles'),
      CAMOFOX_COOKIES_DIR: join(stateDir, 'cookies'), CAMOFOX_UPLOADS_DIR: join(stateDir, 'uploads'),
      CAMOFOX_TRACES_DIR: join(stateDir, 'traces'), CAMOFOX_CRASH_REPORT_ENABLED: 'false',
    });
    serverUrl = getServerUrl();
    // HTTP liveness precedes browser prewarming. Do not spend the fixture's
    // deliberately short handler budget on the browser cold start.
    const readyStart = Date.now();
    const readyClient = createClient(serverUrl);
    let health = await readyClient.request('GET', '/health', null, { timeout: 1000 });
    console.log('timeout fixture initial browser readiness', { browserConnected: health.browserConnected });
    while (health.browserConnected !== true) {
      if (Date.now() - readyStart >= 60000) {
        throw new Error('Browser did not become connected before fixture setup');
      }
      await wait(100);
      health = await readyClient.request('GET', '/health', null, { timeout: 1000 });
    }
    console.log('timeout fixture browser ready', { ms: Date.now() - readyStart });
    await startTestSite();
    testSiteUrl = getTestSiteUrl();
    gateServer = createServer((req, res) => {
      if (req.url === '/hold') gateResponse = res;
      else res.end('<html><body>Timeout settling fixture</body></html>');
    });
    await new Promise(resolve => gateServer.listen(0, '127.0.0.1', resolve));
    gateUrl = `http://127.0.0.1:${gateServer.address().port}`;
  }, 120000);

  afterAll(async () => {
    await stopTestSite();
    await stopServer();
    if (gateServer) await new Promise(resolve => gateServer.close(resolve));
    if (stateDir) rmSync(stateDir, { recursive: true, force: true });
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

  test('explicit tab_destroyed code wins over generic timeout classification', () => {
    const error = Object.assign(new Error('action timed out after 5000ms'), {
      code: 'tab_destroyed', statusCode: 410,
    });

    expect(browserErrorStatus(error)).toBe(410);
    expect(browserErrorCode(error)).toBe('tab_destroyed');
    expect(browserErrorRecovery(error)).toBe('create_new_tab');
  });

  test('returns a stable recoverable error after a timeout', () => {
    const error = Object.assign(new Error('action timed out after 5000ms'), { code: 'operation_timeout' });

    expect(browserErrorStatus(error)).toBe(503);
    expect(browserErrorCode(error)).toBe('operation_timeout');
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
  test('reports a Playwright call timeout inside the tab lock as its own error', async () => {
    const client = createClient(serverUrl);
    try {
      const { tabId } = await client.createTab(`${testSiteUrl}/slow-click?ms=10`);
      // /act click uses a 3s Playwright timeout, well inside the 5s lock budget.
      await expect(client.request('POST', '/act', {
        userId: client.userId, targetId: tabId, kind: 'click', selector: '#does-not-exist',
      })).rejects.toMatchObject({
        status: 422,
        data: expect.objectContaining({ code: 'element_not_actionable', recovery: 'snapshot_then_retry' }),
      });
      const stats = await client.getStats(tabId);
      expect(stats.tabId).toBe(tabId);
    } finally {
      await client.cleanup();
    }
  }, 30000);

  test('blocked main thread reaches bounded tab_destroyed recovery while siblings remain usable', async () => {
    const client = createClient(serverUrl);
    const { tabId } = await client.createTab();
    const { tabId: sibling } = await client.createTab();
    const start = Date.now();
    try {
      // Bounded busy loop, unlike a never-resolving promise this blocks liveness.
      await expect(client.evaluate(tabId,
        '(() => { const end = Date.now() + 20000; while (Date.now() < end) {} })()',
      )).rejects.toMatchObject({ status: 503, data: expect.objectContaining({ code: 'operation_timeout' }) });
      await expect(client.evaluate(tabId, 'window.mustNotRun = true')).rejects.toMatchObject({
        status: 503, data: expect.objectContaining({ code: 'tab_busy', recovery: 'retry' }),
      });
      await expect(client.evaluate(tabId, 'window.mustNotRun = true')).rejects.toMatchObject({
        status: 410, data: expect.objectContaining({ code: 'tab_destroyed', recovery: 'create_new_tab', retryable: true }),
      });
      expect(Date.now() - start).toBeLessThan(15000);
      await expect(client.getStats(tabId)).rejects.toMatchObject({ status: 410 });
      expect((await client.evaluate(sibling, '42')).result).toBe(42);
      const replacement = await client.createTab();
      expect((await client.evaluate(replacement.tabId, '43')).result).toBe(43);
    } finally {
      await client.cleanup();
    }
  }, 45000);

  test('never-settling work refuses new actions while sibling tabs and explicit close remain available', async () => {
    const client = createClient(serverUrl);
    const { tabId } = await client.createTab();
    const { tabId: sibling } = await client.createTab();
    try {
      await expect(client.evaluate(tabId, 'new Promise(() => {})')).rejects.toMatchObject({
        status: 503, data: expect.objectContaining({ code: 'operation_timeout', recovery: 'retry' }),
      });
      await expect(client.evaluate(tabId, 'window.newerMutation = true')).rejects.toMatchObject({
        status: 503, data: expect.objectContaining({ code: 'tab_busy', recovery: 'retry', retryable: true }),
      });
      // Free main thread passes liveness, but must never unlock pending work.
      for (let retry = 0; retry < 4; retry++) {
        await expect(client.evaluate(tabId, 'window.newerMutation = true')).rejects.toMatchObject({
          status: 503, data: expect.objectContaining({ code: 'tab_busy', recovery: 'retry' }),
        });
      }
      expect((await client.evaluate(sibling, '42')).result).toBe(42);
      await client.request('DELETE', `/tabs/${tabId}?userId=${client.userId}`);
      await expect(client.getStats(tabId)).rejects.toMatchObject({ status: 410 });
    } finally {
      await client.cleanup();
    }
  }, 30000);

  test('delayed page mutation settles before newer actions or a completed human handoff', async () => {
    const client = createClient(serverUrl);
    client.userId = 'timeout-probe';
    const { tabId } = await client.createTab(gateUrl);
    try {
      await expect(client.evaluate(tabId,
        'fetch("/hold").then(() => { window.actionOrder = ["old"]; })',
      )).rejects.toMatchObject({ status: 503, data: expect.objectContaining({ code: 'operation_timeout' }) });
      await expect(client.evaluate(tabId, 'window.actionOrder = ["new"]')).rejects.toMatchObject({
        status: 503, data: expect.objectContaining({ code: 'tab_busy', recovery: 'retry' }),
      });
      const handoff = value => client.request('POST', `/tabs/${tabId}/handoff`, { userId: client.userId, handoff: value });
      await expect(handoff('human')).rejects.toMatchObject({
        status: 503, data: expect.objectContaining({ code: 'tab_busy', recovery: 'retry' }),
      });
      expect(gateResponse).toBeDefined();
      gateResponse.end('settled');
      // Poll only this operation's settling state, without replaying a mutation.
      const deadline = Date.now() + 5000;
      for (;;) {
        try {
          expect((await client.evaluate(tabId, 'window.actionOrder')).result).toEqual(['old']);
          break;
        } catch (error) {
          if (error.data?.code !== 'tab_busy' || Date.now() >= deadline) throw error;
          await wait(50);
        }
      }
      expect((await client.evaluate(tabId, 'window.actionOrder.push("new"); window.actionOrder')).result).toEqual(['old', 'new']);
      await expect(handoff('human')).resolves.toMatchObject({ handoff: 'human', focused: true });
      await expect(client.evaluate(tabId, 'window.actionOrder.push("stale")')).rejects.toMatchObject({ status: 409 });
      await expect(client.getSnapshot(tabId)).rejects.toMatchObject({
        status: 409, data: expect.objectContaining({ code: 'tab_handed_off' }),
      });
      await wait(100);
      await handoff('agent');
      expect((await client.evaluate(tabId, 'window.actionOrder')).result).toEqual(['old', 'new']);
    } finally {
      await client.cleanup();
    }
  }, 30000);

  test('refuses queued evaluate work after an evaluate timeout until the old work settles', async () => {
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

      expect(firstError.status).toBe(503);
      expect(firstError.data.code).toBe('operation_timeout');
      expect(firstError.data.recovery).toBe('retry');
      expect(queuedError.status).toBe(503);
      expect(queuedError.data).toMatchObject({ code: 'tab_busy', recovery: 'retry', retryable: true });

      const stats = await client.getStats(tabId);
      expect(stats.tabId).toBe(tabId);
    } finally {
      await client.cleanup();
    }
  }, 30000);
});
