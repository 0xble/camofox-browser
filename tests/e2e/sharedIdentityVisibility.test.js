import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { findParkDisplay } from '../../lib/park-display-launcher.js';
import { startServer, stopServer, getServerUrl } from '../helpers/startServer.js';
import { startTestSite, stopTestSite, getTestSiteUrl } from '../helpers/testSite.js';

const display = await findParkDisplay({ name: 'DeskPad Display' }).catch(() => null);
const parkedDescribe = display ? describe : describe.skip;

parkedDescribe('parked shared identity visibility over HTTP', () => {
  const userId = 'parked-visibility-e2e';
  let root, url;
  async function request(method, route, body) {
    const response = await fetch(`${getServerUrl()}${route}`, { method, headers: { 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined });
    const data = await response.json();
    if (response.status !== 200) throw new Error(`${route}: ${response.status}: ${JSON.stringify(data)}`);
    return data;
  }
  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'parked-identity-e2e-'));
    await startServer(0, { CAMOFOX_SHARED_IDENTITIES: userId, CAMOFOX_SHARED_PROFILE_DIR: root,
      CAMOFOX_PARK_DISPLAY: 'DeskPad Display', CAMOFOX_HEADED_IDLE_RELEASE_MIN: '0',
      CAMOFOX_HIDDEN_TAB_IDLE_MIN: '0', CAMOFOX_HIDDEN_SESSION_IDLE_MIN: '0' });
    await startTestSite(); url = `${getTestSiteUrl()}/form`;
  }, 120000);
  afterAll(async () => {
    await request('DELETE', `/sessions/${userId}`).catch(() => {});
    await stopServer(); await stopTestSite(); await fs.rm(root, { recursive: true, force: true });
  }, 30000);
  test('another caller opens/releases its own duplicate-URL tab while A stays live with unsaved input and every call succeeds', async () => {
    const a = await request('POST', '/tabs', { userId, sessionKey: 'caller-a', url });
    const b = await request('POST', '/tabs', { userId, sessionKey: 'caller-b', url });
    await request('POST', `/tabs/${a.tabId}/type`, { userId, selector: '#username', text: 'retained unsaved state' });
    const before = await request('GET', `/tabs?userId=${userId}`);
    await Promise.all([
      (async () => { for (let i = 0; i < 10; i++) await request('GET', `/tabs/${a.tabId}/snapshot?userId=${userId}`); })(),
      (async () => { for (let i = 0; i < 3; i++) {
        expect(await request('POST', `/browser/identities/${userId}/open`, { tabId: b.tabId })).toMatchObject({ tabId: b.tabId, restarted: false });
        await request('POST', `/browser/identities/${userId}/release`);
      } })(),
    ]);
    const after = await request('GET', `/tabs?userId=${userId}`);
    expect(after.tabs.map(t => t.tabId).sort()).toEqual(before.tabs.map(t => t.tabId).sort());
    expect(new Set(after.tabs.map(t => t.tabId)).size).toBe(after.tabs.length);
    const state = await request('POST', `/tabs/${a.tabId}/evaluate`, { userId,
      expression: '({url:location.href,input:document.querySelector("#username").value})' });
    expect(state.result).toEqual({ url, input: 'retained unsaved state' });
  }, 120000);
});
