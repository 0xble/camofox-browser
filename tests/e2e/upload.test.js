import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createClient } from '../helpers/client.js';
import { getSharedEnv } from './sharedEnv.js';

// File.arrayBuffer() and cross-frame postMessage complete asynchronously.
// Read the shared DOM, not page globals hidden by Camoufox's isolated world.
async function readSelection(client, tabId) {
  const deadline = Date.now() + 5000;
  do {
    const { result } = await client.evaluate(tabId, `(() => {
      const output = document.getElementById('uploaded-files');
      return output.textContent ? { files: JSON.parse(output.textContent), changes: Number(output.dataset.changes) } : null;
    })()`);
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  throw new Error('The page did not finish reading its selected Files');
}

describe('Upload', () => {
  let serverUrl;
  let testSiteUrl;
  let uploadFixture;
  let outsideUploadFixture;

  beforeAll(() => {
    const env = getSharedEnv();
    serverUrl = env.serverUrl;
    testSiteUrl = env.testSiteUrl;
    uploadFixture = env.uploadFixture;
    outsideUploadFixture = env.outsideUploadFixture;
  });

  test('POST /tabs/:tabId/upload attaches an in-root file to an existing input', async () => {
    const client = createClient(serverUrl);

    try {
      const { tabId } = await client.createTab(`${testSiteUrl}/upload`);
      const result = await client.upload(tabId, { path: uploadFixture });

      expect(result).toMatchObject({
        ok: true,
        via: 'direct_input',
        attached: [await fs.realpath(uploadFixture)],
      });

      const selected = await client.evaluate(tabId, "document.getElementById('selected').textContent");
      expect(selected).toMatchObject({ ok: true, result: 'upload.txt' });
    } finally {
      await client.cleanup();
    }
  });

  test.each([
    ['/upload', undefined, 'direct_input'],
    ['/upload/panel', '#trigger', 'panel_input'],
    ['/upload/iframe', 'iframe >> internal:control=enter-frame >> #trigger', 'filechooser'],
  ])('inline bytes reach %s exactly once', async (route, selector, via) => {
    const client = createClient(serverUrl);
    const bytes = Buffer.from([0, 1, 127, 255, 10]);
    const files = [
      { name: 'résumé 東京.bin', mimeType: 'application/octet-stream', dataBase64: bytes.toString('base64') },
      { name: 'empty.txt', mimeType: 'text/plain', dataBase64: '' },
    ];
    try {
      const { tabId } = await client.createTab(`${testSiteUrl}${route}`);
      if (via === 'filechooser') {
        expect((await client.evaluate(tabId, 'new URL(document.querySelector("iframe").src).origin !== location.origin')).result).toBe(true);
      }
      const result = await client.upload(tabId, { files, ...(selector ? { selector } : {}) });
      expect(result).toMatchObject({ ok: true, via, attached: files.map(file => file.name) });
      const selected = await readSelection(client, tabId);
      expect(selected.files).toEqual([
        { name: files[0].name, type: files[0].mimeType, bytes: [...bytes] },
        { name: files[1].name, type: files[1].mimeType, bytes: [] },
      ]);
      expect(selected.changes).toBe(1);
    } finally { await client.cleanup(); }
  });

  test('inline request above 100kb crosses the actual server parser and browser protocol', async () => {
    const client = createClient(serverUrl);
    const bytes = Buffer.alloc(160 * 1024, 0xab);
    try {
      const { tabId } = await client.createTab(`${testSiteUrl}/upload`);
      expect(await client.upload(tabId, { files: [{ name: 'large.bin', mimeType: 'application/octet-stream', dataBase64: bytes.toString('base64') }] }))
        .toMatchObject({ ok: true, via: 'direct_input', attached: ['large.bin'] });
      const selected = await readSelection(client, tabId);
      expect(selected.changes).toBe(1);
      expect(selected.files).toHaveLength(1);
      expect(selected.files[0]).toMatchObject({ name: 'large.bin', type: 'application/octet-stream' });
      const actual = Buffer.from(selected.files[0].bytes);
      expect(actual.length).toBe(bytes.length);
      expect(createHash('sha256').update(actual).digest('hex'))
        .toBe(createHash('sha256').update(bytes).digest('hex'));
    } finally { await client.cleanup(); }
  });

  test('named triggers and unknown tabs cannot select inline files', async () => {
    const client = createClient(serverUrl);
    const files = [{ name: 'guarded.txt', mimeType: 'text/plain', dataBase64: 'YQ==' }];
    try {
      const { tabId } = await client.createTab(`${testSiteUrl}/upload`);
      await expect(client.upload(tabId, { files, selector: '#fileInput' })).rejects.toMatchObject({ status: 400 });
      await expect(client.upload('unknown-upload-tab', { files })).rejects.toMatchObject({ status: 404, data: { error: 'Tab not found' } });
      expect((await client.evaluate(tabId, 'Number(document.getElementById("uploaded-files").dataset.changes)')).result).toBe(0);
    } finally { await client.cleanup(); }
  });

  test('POST /tabs/:tabId/upload rejects a path outside the upload root', async () => {
    const client = createClient(serverUrl);

    try {
      const { tabId } = await client.createTab(`${testSiteUrl}/upload`);

      await expect(client.upload(tabId, { path: outsideUploadFixture }))
        .rejects.toMatchObject({ status: 400, data: { code: 'upload_path_outside_root' } });
    } finally {
      await client.cleanup();
    }
  });
});
