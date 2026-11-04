import http from 'node:http';
import { firefox } from 'playwright-core';
import { launchOptions } from 'camoufox-js';

const CLICK_BOUND_MS = 8_000;
const COLD_PAGES = 12;

// A macOS fingerprint reproduces the fractional chrome/content boundary even
// on Linux CI. Cold pages exercise the humanizer's initial cursor at (0, 0).
// Use the real engine, not the server's JS click fallbacks or synthetic events.
describe('native humanized first click', () => {
  let site;
  let url;
  let browser;

  beforeAll(async () => {
    site = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><title>ready</title>
        <body style="margin:0">
          <button id="edge" style="position:absolute;left:480px;top:0;width:180px;height:64px">Top edge</button>
          <button id="middle" style="position:absolute;left:480px;top:320px;width:180px;height:64px">Mid page</button>
          <script>
            window.clicked = null;
            for (const button of document.querySelectorAll('button')) {
              button.addEventListener('click', event => {
                if (event.isTrusted) window.clicked = button.id;
              });
            }
          </script>
        </body>`);
    });
    await new Promise((resolve, reject) => {
      site.once('error', reject);
      site.listen(0, '127.0.0.1', resolve);
    });
    url = `http://127.0.0.1:${site.address().port}/`;
  });

  beforeEach(async () => {
    browser = await firefox.launch(await launchOptions({
      headless: true,
      os: 'macos',
      humanize: true,
      geoip: false,
      exclude_addons: ['UBO'],
    }));
  });

  afterEach(async () => {
    await browser?.close();
    browser = null;
  });

  afterAll(async () => {
    site?.closeAllConnections();
    if (site) await new Promise(resolve => site.close(resolve));
  });

  test.each(['edge', 'middle'])('%s button receives a trusted click within 8 s on every cold page', async target => {
    for (let trial = 1; trial <= COLD_PAGES; trial++) {
      const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
      let timer;
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded' });
        await Promise.race([
          (async () => {
            await page.locator(`#${target}`).click({ timeout: CLICK_BOUND_MS });
            await page.waitForFunction(id => window.clicked === id, target, { timeout: CLICK_BOUND_MS });
          })(),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(`${target} cold page ${trial}: trusted click handler did not finish within ${CLICK_BOUND_MS} ms`)), CLICK_BOUND_MS);
          }),
        ]);
      } finally {
        clearTimeout(timer);
        await page.close();
      }
    }
  }, COLD_PAGES * (CLICK_BOUND_MS + 5_000));
});
