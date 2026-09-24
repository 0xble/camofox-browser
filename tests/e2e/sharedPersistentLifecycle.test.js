import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startServer, stopServer, getServerUrl } from '../helpers/startServer.js';
import { startTestSite, stopTestSite, getTestSiteUrl } from '../helpers/testSite.js';
import { cookieCheckpointPath } from '../../lib/shared-identity.js';

async function request(method, route, body) {
  const response = await fetch(`${getServerUrl()}${route}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json();
  return { response, data };
}

describe('shared persistent identity lifecycle over HTTP', () => {
  const userId = 'shared-lifecycle-e2e';
  const group = 'agent-work';
  let profileDir;
  let testSiteUrl;

  beforeAll(async () => {
    profileDir = await fs.mkdtemp(path.join(os.tmpdir(), 'camofox-shared-lifecycle-'));
    await startServer(0, {
      CAMOFOX_SHARED_IDENTITIES: userId,
      CAMOFOX_SHARED_PROFILE_DIR: profileDir,
      MAX_TABS_PER_SESSION: '3',
      CAMOFOX_HIDDEN_TAB_IDLE_MIN: '0',
    });
    await startTestSite();
    testSiteUrl = getTestSiteUrl();
  }, 120000);

  afterAll(async () => {
    await request('DELETE', `/sessions/${userId}`).catch(() => {});
    await stopTestSite();
    await stopServer();
    await fs.rm(profileDir, { recursive: true, force: true });
  }, 30000);

  test('page events and task creation share one tab ID, serialize handoff, and group cleanup removes that exact page', async () => {
    const opened = await request('POST', `/browser/identities/${userId}/open`);
    expect(opened.response.status).toBe(200);
    expect(opened.data.tabId).toBeDefined();

    const created = await request('POST', '/tabs', {
      userId,
      sessionKey: group,
      url: `${testSiteUrl}/pageA`,
    });
    expect(created.response.status).toBe(200);
    expect(created.data.tabId).toBeDefined();
    expect(created.data.tabId).not.toBe(opened.data.tabId);

    // context.on('page') registered the task page before POST /tabs returned;
    // it must be moved, not duplicated under a second ID.
    const listed = await request('GET', `/tabs?userId=${encodeURIComponent(userId)}`);
    expect(listed.response.status).toBe(200);
    expect(listed.data.tabs).toHaveLength(2);
    expect(new Set(listed.data.tabs.map(tab => tab.tabId)).size).toBe(2);
    expect(listed.data.tabs.filter(tab => tab.tabId === created.data.tabId)).toHaveLength(1);

    const human = await request('POST', `/tabs/${created.data.tabId}/handoff`, { userId, handoff: 'human' });
    expect(human.response.status).toBe(200);
    expect(human.data).toMatchObject({ ok: true, handoff: 'human', focused: true });

    const blocked = await request('POST', `/tabs/${created.data.tabId}/navigate`, { userId, url: `${testSiteUrl}/pageB` });
    expect(blocked.response.status).toBe(409);
    expect(blocked.data.code).toBe('tab_handed_off');

    const agent = await request('POST', `/tabs/${created.data.tabId}/handoff`, { userId, handoff: 'agent' });
    expect(agent.response.status).toBe(200);
    expect(agent.data).toMatchObject({ ok: true, handoff: 'agent', focused: false });

    const closed = await request('DELETE', `/tabs/group/${group}`, { userId });
    expect(closed.response.status).toBe(200);
    const afterCleanup = await request('GET', `/tabs?userId=${encodeURIComponent(userId)}`);
    expect(afterCleanup.response.status).toBe(200);
    expect(afterCleanup.data.tabs).toHaveLength(1);
    expect(afterCleanup.data.tabs[0].tabId).toBe(opened.data.tabId);

    // Exercise the actual persistence-plugin reset route. Its close path must
    // leave the shared recovery marker dirty rather than checkpointing session
    // credentials that a later reopen could replay.
    const reset = await request('DELETE', `/sessions/${userId}/storage_state`);
    expect(reset.response.status).toBe(200);
    expect(reset.data).toMatchObject({ ok: true, userId, clearedLive: true });
    const checkpoint = JSON.parse(await fs.readFile(cookieCheckpointPath(profileDir, userId), 'utf8'));
    expect(checkpoint).toEqual(expect.objectContaining({ cleanShutdown: false }));
  }, 90000);

  test('release rejects human control, then checkpoints and discards headed tab IDs', async () => {
    const absent = await request('POST', '/browser/identities/unconfigured/release');
    expect(absent.response.status).toBe(404);
    const empty = await request('POST', `/browser/identities/${userId}/release`);
    expect(empty.response.status).toBe(200);
    expect(empty.data).toEqual({ ok: true, released: false });

    const opened = await request('POST', `/browser/identities/${userId}/open`);
    expect(opened.response.status).toBe(200);
    const human = await request('POST', `/tabs/${opened.data.tabId}/handoff`, { userId, handoff: 'human' });
    expect(human.response.status).toBe(200);
    const busy = await request('POST', `/browser/identities/${userId}/release`);
    expect(busy.response.status).toBe(409);
    expect(busy.data).toEqual({ error: 'identity busy' });
    const stillOpen = await request('GET', `/tabs?userId=${userId}`);
    expect(stillOpen.data.tabs.some(tab => tab.tabId === opened.data.tabId)).toBe(true);

    const agent = await request('POST', `/tabs/${opened.data.tabId}/handoff`, { userId, handoff: 'agent' });
    expect(agent.response.status).toBe(200);
    const navigated = await request('POST', `/tabs/${opened.data.tabId}/navigate`, { userId, url: `${testSiteUrl}/pageA` });
    expect(navigated.response.status).toBe(200);
    const released = await request('POST', `/browser/identities/${userId}/release`);
    expect(released.response.status).toBe(200);
    expect(released.data).toEqual({ ok: true, released: true });
    const checkpoint = JSON.parse(await fs.readFile(cookieCheckpointPath(profileDir, userId), 'utf8'));
    expect(checkpoint.cleanShutdown).toBe(true);
    const listed = await request('GET', `/tabs?userId=${userId}`);
    expect(listed.data.tabs).toEqual([]);
    const created = await request('POST', '/tabs', { userId, sessionKey: 'post-release' });
    expect(created.response.status).toBe(200);
    expect(created.data.tabId).not.toBe(opened.data.tabId);
    const restored = await request('GET', `/tabs?userId=${userId}`);
    expect(restored.data.tabs.some(tab => tab.url === `${testSiteUrl}/pageA`)).toBe(true);
    const focus = await request('POST', `/browser/identities/${userId}/focus`);
    expect(focus.response.status).toBe(409);
    await request('DELETE', `/sessions/${userId}`);
  }, 90000);

  test('release followed by open serializes opposite actions and starts a fresh headed session', async () => {
    const first = await request('POST', `/browser/identities/${userId}/open`);
    expect(first.response.status).toBe(200);
    const release = request('POST', `/browser/identities/${userId}/release`);
    const reopen = request('POST', `/browser/identities/${userId}/open`);
    const [released, opened] = await Promise.all([release, reopen]);
    expect(released.response.status).toBe(200);
    expect(released.data).toEqual({ ok: true, released: true });
    expect(opened.response.status).toBe(200);
    expect(opened.data.tabId).not.toBe(first.data.tabId);
    await request('DELETE', `/sessions/${userId}`);
  }, 90000);

  test('explicit release closes a headless session and is idempotent', async () => {
    const tab = await request('POST', '/tabs', { userId, sessionKey: 'headless-release', url: `${testSiteUrl}/pageA` });
    expect(tab.response.status).toBe(200);
    const released = await request('POST', `/browser/identities/${userId}/release`);
    expect(released.data).toEqual({ ok: true, released: true });
    const gone = await request('GET', `/tabs?userId=${userId}`);
    expect(gone.data.tabs).toEqual([]);
    const again = await request('POST', `/browser/identities/${userId}/release`);
    expect(again.data).toEqual({ ok: true, released: false });
  }, 90000);

  test('release refuses a request still in flight without destroying its tab', async () => {
    const created = await request('POST', '/tabs', { userId, sessionKey: 'busy-release' });
    expect(created.response.status).toBe(200);
    const pending = request('POST', `/tabs/${created.data.tabId}/evaluate`, {
      userId, expression: 'new Promise(resolve => setTimeout(() => resolve(42), 5000))',
    });
    await new Promise(resolve => setTimeout(resolve, 250));
    const blocked = await request('POST', `/browser/identities/${userId}/release`);
    expect(blocked.response.status).toBe(409);
    expect(blocked.data).toEqual({ error: 'identity busy' });
    expect((await pending).response.status).toBe(200);
    const listed = await request('GET', `/tabs?userId=${userId}`);
    expect(listed.data.tabs.some(tab => tab.tabId === created.data.tabId)).toBe(true);
    await request('DELETE', `/sessions/${userId}`);
  }, 90000);

  test('headless cap evicts the oldest idle tab but preserves the most recent', async () => {
    const ids = [];
    for (let index = 0; index < 4; index++) {
      const tab = await request('POST', '/tabs', { userId, sessionKey: 'cap-test' });
      expect(tab.response.status).toBe(200);
      ids.push(tab.data.tabId);
    }
    const listed = await request('GET', `/tabs?userId=${userId}`);
    expect(listed.data.tabs.map(tab => tab.tabId)).not.toContain(ids[0]);
    expect(listed.data.tabs.map(tab => tab.tabId)).toContain(ids[2]);
    expect(listed.data.tabs.map(tab => tab.tabId)).toContain(ids[3]);
    await request('DELETE', `/sessions/${userId}`);
  }, 90000);

  test('normal use launches headless, and /focus refuses a headless identity', async () => {
    const created = await request('POST', '/tabs', { userId, sessionKey: 'headless-focus', url: `${testSiteUrl}/pageA` });
    expect(created.response.status).toBe(200);
    const focus = await request('POST', `/browser/identities/${userId}/focus`);
    expect(focus.response.status).toBe(409);
    expect(focus.data).toEqual({ error: 'identity is headless; use open' });
    await request('DELETE', `/sessions/${userId}`);
  }, 90000);
});
