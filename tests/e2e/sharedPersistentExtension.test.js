import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { firefox } from 'playwright-core';
import { launchOptions } from 'camoufox-js';

const extensionId = 'shared-persistence-fixture@example.test';

async function makeFixture(root, { initialValue = null } = {}) {
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
  await fs.writeFile(path.join(addon, 'background.js'), '// Deliberately read-only: this fixture must not seed storage on startup.\n');
  await fs.writeFile(path.join(addon, 'content.js'), `
    (async () => {
      let { fixtureExtensionSetting } = await browser.storage.local.get('fixtureExtensionSetting');
      const firstOnlyValue = ${JSON.stringify(initialValue)};
      if (firstOnlyValue && !fixtureExtensionSetting) {
        fixtureExtensionSetting = firstOnlyValue;
        await browser.storage.local.set({ fixtureExtensionSetting });
      }
      document.documentElement.dataset.fixtureExtensionSetting = fixtureExtensionSetting || '';
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

async function extensionState(page, expectedSetting) {
  let last;
  for (let attempt = 0; attempt < 40; attempt++) {
    last = await page.evaluate(() => ({
      setting: document.documentElement.dataset.fixtureExtensionSetting || null,
      id: document.documentElement.dataset.fixtureExtensionId,
    }));
    if (last.setting === expectedSetting && last.id === extensionId) return last;
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

  test('a locally installed WebExtension retains a first-run-only random storage value across a full persistent-profile close and read-only reopen', async () => {
    const firstOnlyValue = `retained-${crypto.randomUUID()}`;
    const emptyProfile = path.join(root, 'empty-profile');
    let first;
    let second;
    let empty;
    try {
      const writerAddon = await makeFixture(root, { initialValue: firstOnlyValue });
      first = await firefox.launchPersistentContext(profile, await persistentOptions([writerAddon]));
      const firstPage = await first.newPage();
      await firstPage.goto(site.url);
      await expect(extensionState(firstPage, firstOnlyValue)).resolves.toEqual({ setting: firstOnlyValue, id: extensionId });
      await first.close();
      first = null;

      // The reopen fixture cannot write a value. Success therefore proves the
      // random first-run value came from Firefox's persistent profile.
      const readOnlyAddon = await makeFixture(root);
      second = await firefox.launchPersistentContext(profile, await persistentOptions([readOnlyAddon]));
      const secondPage = await second.newPage();
      await secondPage.goto(site.url);
      await expect(extensionState(secondPage, firstOnlyValue)).resolves.toEqual({ setting: firstOnlyValue, id: extensionId });

      // The same read-only extension sees no value in a distinct empty profile;
      // it is a negative control against fixture-source self-seeding.
      empty = await firefox.launchPersistentContext(emptyProfile, await persistentOptions([readOnlyAddon]));
      const emptyPage = await empty.newPage();
      await emptyPage.goto(site.url);
      await expect(extensionState(emptyPage, null)).resolves.toEqual({ setting: null, id: extensionId });
    } finally {
      await first?.close().catch(() => {});
      await second?.close().catch(() => {});
      await empty?.close().catch(() => {});
    }
  }, 90_000);
});
