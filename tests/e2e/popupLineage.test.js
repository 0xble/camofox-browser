import { createClient } from '../helpers/client.js';
import { getSharedEnv } from './sharedEnv.js';

async function listTabs(client) {
  return (await client.request('GET', `/tabs?userId=${encodeURIComponent(client.userId)}`)).tabs;
}

async function waitForChild(client, openerTabId) {
  let tabs;
  for (let attempt = 0; attempt < 40; attempt++) {
    tabs = await listTabs(client);
    const child = tabs.find(tab => tab.openerTabId === openerTabId);
    if (child) return child;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`No popup for ${openerTabId}: ${JSON.stringify(tabs)}`);
}

test('real server preserves popup IDs, opener descent, and independent siblings over HTTP', async () => {
  const { serverUrl, testSiteUrl } = getSharedEnv();
  const client = createClient(serverUrl);
  // Sharing a group alone must not imply an opener relationship.
  client.sessionKey = '__shared_identity__';
  const outsider = createClient(serverUrl);
  try {
    const opener = await client.createTab(`${testSiteUrl}/popup-source`);
    const sibling = await client.createTab(`${testSiteUrl}/pageB`);
    await client.getSnapshot(opener.tabId);
    await client.click(opener.tabId, { selector: '#openBtn' });
    const child = await waitForChild(client, opener.tabId);
    expect((await client.getSnapshot(child.tabId)).snapshot).toContain('Popup Target Page');

    await client.navigate(child.tabId, `${testSiteUrl}/popup-source`);
    await client.getSnapshot(child.tabId);
    await client.click(child.tabId, { selector: '#openBtn' });
    const nested = await waitForChild(client, child.tabId);
    expect((await client.getSnapshot(nested.tabId)).snapshot).toContain('Popup Target Page');

    const listed = await listTabs(client);
    const ids = [opener.tabId, sibling.tabId, child.tabId, nested.tabId];
    expect(new Set(listed.map(tab => tab.tabId)).size).toBe(listed.length);
    for (const id of ids) expect(listed.filter(tab => tab.tabId === id)).toHaveLength(1);
    const byId = new Map(listed.map(tab => [tab.tabId, tab]));
    expect(byId.get(opener.tabId).openerTabId).toBeNull();
    expect(byId.get(sibling.tabId).openerTabId).toBeNull();
    expect(byId.get(child.tabId).openerTabId).toBe(opener.tabId);
    expect(byId.get(nested.tabId).openerTabId).toBe(child.tabId);
    for (const id of ids) expect(byId.get(id).listItemId).toBe(client.sessionKey);
    expect(await listTabs(outsider)).toEqual([]);

    await client.closeTab(opener.tabId);
    const afterClose = await listTabs(client);
    expect(afterClose.some(tab => tab.tabId === opener.tabId)).toBe(false);
    expect(afterClose.find(tab => tab.tabId === child.tabId).openerTabId).toBeNull();
    expect(afterClose.find(tab => tab.tabId === nested.tabId).openerTabId).toBe(child.tabId);
    expect((await client.getSnapshot(sibling.tabId)).snapshot).toContain('Welcome to Page B');
    expect((await client.getSnapshot(child.tabId)).snapshot).toContain('Popup Source Page');
    console.log('popup lineage HTTP evidence', JSON.stringify({ listed, afterClose }));
  } finally {
    await client.cleanup();
    await outsider.cleanup();
  }
}, 90000);
