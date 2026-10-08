import { createClient } from '../helpers/client.js';
import { getSharedEnv } from './sharedEnv.js';

// Regression for stale refs after a same-URL SPA re-render (GoHighLevel).
// The old refresh returned the previous refs whenever a same-URL rebuild came
// back empty, so a snapshot after the controls were replaced still reported
// them, and clicks went to detached nodes ("no bounding box").
describe('snapshot refs after a same-URL re-render', () => {
  let serverUrl;
  let testSiteUrl;

  beforeAll(() => {
    ({ serverUrl, testSiteUrl } = getSharedEnv());
  });

  test('refs that no longer resolve are not reported or clickable', async () => {
    const client = createClient(serverUrl);
    try {
      const { tabId } = await client.createTab(`${testSiteUrl}/click`);
      const before = await client.getSnapshot(tabId);
      expect(before.refsCount).toBeGreaterThan(0);

      // Re-render in place (fixed test markup): same URL, every control replaced by text.
      await client.evaluate(tabId, "document.body.innerHTML = '<h1>Saving…</h1><p>Rendering</p>'; true");

      const after = await client.getSnapshot(tabId);
      expect(after.url).toBe(before.url);
      expect(after.refsCount).toBe(0);
      await expect(client.click(tabId, { ref: 'e1' })).rejects.toMatchObject({
        status: 422,
        data: expect.objectContaining({ code: 'stale_refs' }),
      });
    } finally {
      await client.cleanup();
    }
  });

  test('refs that still resolve keep working after an unchanged rebuild', async () => {
    const client = createClient(serverUrl);
    try {
      const { tabId } = await client.createTab(`${testSiteUrl}/click`);
      const snapshot = await client.getSnapshot(tabId);
      const ref = snapshot.snapshot.match(/button "Click Me" \[(e\d+)\]/)?.[1];
      expect(ref).toBeDefined();
      await expect(client.click(tabId, { ref })).resolves.toMatchObject({ ok: true });
      await client.waitForSnapshotContains(tabId, 'Button was clicked!');
    } finally {
      await client.cleanup();
    }
  });
});
