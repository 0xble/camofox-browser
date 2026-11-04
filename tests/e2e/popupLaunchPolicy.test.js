import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { firefox } from 'playwright-core';
import { launchOptions } from 'camoufox-js';
import { createPluginEvents } from '../../lib/plugins.js';
import { launchSharedIdentityContext } from '../../lib/shared-identity-launch.js';
import registerHardening from '../../plugins/local-hardening/index.js';

let site;
let url;
let root;

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'camofox-popup-policy-'));
  site = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(req.url === '/target' ? '<title>Popup Target</title>' : `<!doctype html>
      <a id="blankLink" href="/target" target="_blank">Open link</a>
      <button id="oauth" onclick="window.open('/target', '_blank', 'width=500,height=600')">Sign in</button>`);
  });
  await new Promise((resolve, reject) => {
    site.once('error', reject);
    site.listen(0, '127.0.0.1', resolve);
  });
  url = `http://127.0.0.1:${site.address().port}`;
});

afterAll(async () => {
  site?.closeAllConnections();
  if (site) await new Promise(resolve => site.close(resolve));
  if (root) await fs.rm(root, { recursive: true, force: true });
});

test.each(['ephemeral', 'persistent identity'])(
  '%s launch preserves synthetic links and trusted OAuth popups',
  async kind => {
    const events = createPluginEvents();
    registerHardening({}, { events, log: () => {} });
    let browser;
    let context;
    try {
      if (kind === 'persistent identity') {
        context = await launchSharedIdentityContext(path.join(root, 'identity'), {
          launchOptions, firefox, os,
          getHostOS: () => os.platform() === 'darwin' ? 'macos' : os.platform() === 'win32' ? 'windows' : 'linux',
          config: { disableDefaultAddons: true }, events,
        });
      } else {
        const options = await launchOptions({ headless: true, humanize: false, geoip: false, exclude_addons: ['UBO'] });
        await events.emitAsync('browser:launching', { options });
        browser = await firefox.launch(options);
        context = await browser.newContext();
      }
      const page = await context.newPage();
      await page.goto(url);
      for (const trigger of ['synthetic link', 'trusted OAuth button']) {
        const seenPages = [];
        const onPage = popup => seenPages.push(popup);
        context.on('page', onPage);
        try {
          const [reportedPage, popup] = await Promise.all([
            context.waitForEvent('page', { timeout: 5000 }),
            page.waitForEvent('popup', { timeout: 5000 }),
            trigger === 'synthetic link'
              ? page.evaluate(() => document.querySelector('#blankLink').click())
              : page.locator('#oauth').click({ timeout: 8000 }),
          ]);
          await popup.waitForLoadState();
          expect(reportedPage).toBe(popup);
          expect(seenPages).toEqual([popup]);
          expect(popup.url()).toBe(`${url}/target`);
          expect(await popup.title()).toBe('Popup Target');
          await popup.close();
        } finally {
          context.off('page', onPage);
        }
      }
    } finally {
      await context?.close();
      await browser?.close();
    }
  },
  30000,
);
