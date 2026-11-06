import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startServer, stopServer, getServerUrl } from '../helpers/startServer.js';
import { startTestSite, stopTestSite, getTestSiteUrl } from '../helpers/testSite.js';

// This suite owns a disposable server/profile. Never targets the managed API.
describe('shared identity idle tabs over HTTP', () => {
  const userId = 'shared-idle-e2e';
  let root, site;
  async function request(method, route, body) {
    const response = await fetch(`${getServerUrl()}${route}`, {
      method, headers: { 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: response.status, data: await response.json() };
  }
  async function tabs() {
    const listed = await request('GET', `/tabs?userId=${userId}`);
    expect(listed.status).toBe(200);
    return listed.data.tabs;
  }
  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'camofox-shared-idle-'));
    await startServer(0, {
      CAMOFOX_PARK_DISPLAY: 'off', CAMOFOX_SHARED_IDENTITIES: userId,
      CAMOFOX_SHARED_PROFILE_DIR: root,
      CAMOFOX_PROFILE_DIR: path.join(root, 'ephemeral'),
      CAMOFOX_COOKIES_DIR: path.join(root, 'cookies'),
      CAMOFOX_TRACES_DIR: path.join(root, 'traces'),
      CAMOFOX_UPLOADS_DIR: path.join(root, 'uploads'),
      // Smallest supported timeout: exercise the real 60-second sweep, not a
      // test-only route or a production timer override. Headed release stays off.
      CAMOFOX_HIDDEN_TAB_IDLE_MIN: '1', CAMOFOX_HEADED_IDLE_RELEASE_MIN: '0',
      MAX_TABS_PER_SESSION: '6',
    });
    await startTestSite();
    site = getTestSiteUrl();
  }, 120000);
  afterAll(async () => {
    await request('DELETE', `/sessions/${userId}`).catch(() => {});
    await stopTestSite();
    await stopServer();
    if (root) await fs.rm(root, { recursive: true, force: true });
  }, 30000);

  test('reclaims an abandoned managed popup and tabs while preserving another task\'s live form', async () => {
    const opener = await request('POST', '/tabs', { userId, sessionKey: 'abandoned', url: `${site}/popup-source` });
    expect(opener.status).toBe(200);
    const opened = await request('POST', `/tabs/${opener.data.tabId}/evaluate`, {
      userId, expression: `new Promise(resolve => {
        let popup;
        const ready = event => {
          if (event.source !== popup || event.origin !== location.origin || event.data !== 'popup-target-ready') return;
          removeEventListener('message', ready); resolve(true);
        };
        addEventListener('message', ready);
        popup = window.open('/popup-target', '_blank');
        if (!popup) { removeEventListener('message', ready); resolve(false); }
      })`,
    });
    expect(opened).toMatchObject({ status: 200, data: { result: true } });
    const popup = (await tabs()).find(tab => tab.openerTabId === opener.data.tabId);
    expect(popup).toBeDefined();
    expect(popup.listItemId).toBe('abandoned');

    const active = await request('POST', '/tabs', { userId, sessionKey: 'other-agent', url: `${site}/pageA` });
    expect(active.status).toBe(200);
    const evaluateActive = expression => request('POST', `/tabs/${active.data.tabId}/evaluate`, { userId, expression });
    expect((await evaluateActive(`const input = document.createElement('input'); input.id = 'unsaved'; input.value = 'keep this form'; document.body.append(input); true`)).status).toBe(200);
    for (let attempt = 0; attempt < 6 && (await tabs()).length < 6; attempt++) {
      expect((await request('POST', '/tabs', { userId, sessionKey: 'abandoned' })).status).toBe(200);
    }
    expect(await tabs()).toHaveLength(6);
    const refused = await request('POST', '/tabs', { userId, sessionKey: 'new-task' });
    expect(refused).toMatchObject({ status: 429, data: { code: 'tab_limit_reached' } });

    // Keep the other agent genuinely active. Listing tabs is passive and must
    // not refresh the abandoned tabs' or popup's agent-idle timestamps.
    const idleDeadline = Date.now() + 61000;
    while (Date.now() < idleDeadline) {
      expect((await evaluateActive('document.querySelector("#unsaved").value')).data.result).toBe('keep this form');
      await new Promise(resolve => setTimeout(resolve, Math.min(10000, Math.max(0, idleDeadline - Date.now()))));
    }
    const admitted = await request('POST', '/tabs', { userId, sessionKey: 'new-task' });
    expect(admitted.status).toBe(200);
    // The cap path can now reclaim an idle tab; the periodic sweep must also
    // reclaim the managed popup and other abandoned tabs within its next pass.
    const sweepDeadline = Date.now() + 70000;
    let listed;
    do {
      expect((await evaluateActive('document.querySelector("#unsaved").value')).data.result).toBe('keep this form');
      listed = await tabs();
      if (!listed.some(tab => tab.tabId === popup.tabId || tab.tabId === opener.data.tabId)) break;
      await new Promise(resolve => setTimeout(resolve, 1000));
    } while (Date.now() < sweepDeadline);
    expect(listed.some(tab => tab.tabId === popup.tabId)).toBe(false);
    expect(listed.some(tab => tab.tabId === opener.data.tabId)).toBe(false);
    expect(listed.some(tab => tab.tabId === active.data.tabId)).toBe(true);
  }, 180000);
});
