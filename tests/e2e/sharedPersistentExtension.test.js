import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { firefox } from 'playwright-core';
import { launchOptions } from 'camoufox-js';

const extensionId = 'shared-persistence-fixture@example.test';

async function makeFixture(root) {
  const addon = path.join(root, 'addon');
  await fs.mkdir(addon, { recursive: true });
  await fs.writeFile(path.join(addon, 'manifest.json'), JSON.stringify({
    manifest_version: 2,
    name: 'Shared persistent profile fixture',
    version: '1.0.0',
    permissions: ['storage', 'http://127.0.0.1/*'],
    background: { scripts: ['background.js'] },
    content_scripts: [{
      matches: ['http://127.0.0.1/*'],
      js: ['content.js'],
      run_at: 'document_start',
    }],
    browser_specific_settings: { gecko: { id: extensionId } },
  }));
  await fs.writeFile(path.join(addon, 'background.js'), `
    browser.storage.local.get('fixtureExtensionSetting').then(({ fixtureExtensionSetting }) => {
      if (!fixtureExtensionSetting) browser.storage.local.set({ fixtureExtensionSetting: 'retained-v1' });
    });
  `);
  await fs.writeFile(path.join(addon, 'content.js'), `
    (async () => {
      let { fixtureExtensionSetting } = await browser.storage.local.get('fixtureExtensionSetting');
      if (!fixtureExtensionSetting) {
        fixtureExtensionSetting = 'retained-v1';
        await browser.storage.local.set({ fixtureExtensionSetting });
      }
      document.documentElement.dataset.fixtureExtensionSetting = fixtureExtensionSetting;
      document.documentElement.dataset.fixtureExtensionId = browser.runtime.id;
    })();
  `);
  return addon;
}

async function startSite() {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<!doctype html><title>fixture</title><main>extension fixture</main>');
  });
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', error => error ? reject(error) : resolve()));
  return { server, url: `http://127.0.0.1:${server.address().port}/` };
}

async function persistentOptions(addons = []) {
  return launchOptions({
    headless: false,
    os: process.platform === 'darwin' ? 'macos' : 'linux',
    humanize: true,
    addons,
    exclude_addons: ['UBO'],
    enable_cache: true,
  });
}

async function extensionState(page) {
  let last;
  for (let attempt = 0; attempt < 40; attempt++) {
    last = await page.evaluate(() => ({
      setting: document.documentElement.dataset.fixtureExtensionSetting,
      id: document.documentElement.dataset.fixtureExtensionId,
    }));
    if (last.setting === 'retained-v1' && last.id === extensionId) return last;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  return last;
}

describe('shared persistent profile extension retention', () => {
  let root;
  let profile;
  let site;

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'camofox-shared-extension-'));
    profile = path.join(root, 'profile');
    site = await startSite();
  });

  afterAll(async () => {
    await new Promise(resolve => site?.server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  });

  test('a locally installed WebExtension keeps browser.storage.local settings after a full persistent-profile close and reopen', async () => {
    const addon = await makeFixture(root);
    let first;
    let second;
    try {
      first = await firefox.launchPersistentContext(profile, await persistentOptions([addon]));
      const firstPage = await first.newPage();
      await firstPage.goto(site.url);
      await expect(extensionState(firstPage)).resolves.toEqual({ setting: 'retained-v1', id: extensionId });
      await first.close();
      first = null;

      // Camoufox's supported extracted-addon launch option is supplied to both
      // real browser processes; the retained value must come from Firefox's
      // persistent profile rather than the fixture source directory.
      second = await firefox.launchPersistentContext(profile, await persistentOptions([addon]));
      const secondPage = await second.newPage();
      await secondPage.goto(site.url);
      await expect(extensionState(secondPage)).resolves.toEqual({ setting: 'retained-v1', id: extensionId });
    } finally {
      await first?.close().catch(() => {});
      await second?.close().catch(() => {});
    }
  }, 90_000);
});
