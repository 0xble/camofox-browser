import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { launchOptions } from 'camoufox-js';
import { getPath, installedVerStr } from 'camoufox-js/dist/pkgman.js';
import { firefox } from 'playwright-core';

const fixture = `<!doctype html>
<style>
  html,body { margin:0; width:100%; height:100%; }
  #interior { position:absolute; left:100px; top:100px; width:100px; height:50px; }
  #edge { position:fixed; left:200px; top:0; width:100px; height:1.6px; padding:0; border:0; }
  input { position:absolute; top:170px; }
</style>
<button id="interior">Interior</button><button id="edge">Edge</button><input>`;

async function bounded(action, timeout = 8000) {
  let timer;
  try {
    return await Promise.race([
      action(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(
          `Native input exceeded ${timeout}ms. The underlying dispatch is not cancelled.`,
        )), timeout);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function observe(page) {
  await page.setContent(fixture);
  await page.evaluate(() => {
    window.nativeEvents = [];
    for (const type of ['mousemove', 'click']) {
      document.addEventListener(type, event => window.nativeEvents.push({
        type, trusted: event.isTrusted, target: event.target.id,
        x: event.clientX, y: event.clientY,
      }));
    }
  });
}

async function clickObserved(page, selector) {
  const before = await page.evaluate(() => window.nativeEvents.length);
  await bounded(() => page.locator(selector).click({ timeout: 8000 }));
  const events = await page.evaluate(start => window.nativeEvents.slice(start), before);
  assert(events.some(event => event.type === 'click' && event.trusted &&
    event.target === selector.slice(1)), `Missing trusted ${selector} click: ${JSON.stringify(events)}`);
}

for (const headless of [true, false]) {
  test(`native viewport edges preserve sibling input, headless=${headless}`, { timeout: 45000 }, async () => {
    // This must fail, rather than skip, if CI installed a stale or unrelated engine.
    assert.equal(installedVerStr(), '158.0-beta.40');
    const app = await fs.readFile(getPath('application.ini'), 'utf8');
    assert.match(app, /^Version=158\.0-beta\.40$/m);
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'camofox-native-edge-'));
    let context;
    try {
      const options = await launchOptions({ headless, humanize: false, os: 'macos', exclude_addons: ['UBO'] });
      options.ignoreDefaultArgs = ['-foreground'];
      context = await firefox.launchPersistentContext(root, { ...options, viewport: { width: 1280, height: 720 } });
      const primary = context.pages()[0];
      const sibling = await context.newPage();
      await observe(primary);
      await observe(sibling);
      await sibling.locator('input').fill('unsaved sibling state');
      await clickObserved(sibling, '#interior');

      for (const [x, y] of [[0, 0], [100, 0], [1279, 0], [1279, 100], [1279, 719], [100, 719], [0, 719], [0, 100], [1, 1]]) {
        await bounded(() => primary.mouse.move(150, 125));
        const before = await primary.evaluate(() => window.nativeEvents.length);
        await bounded(() => primary.mouse.move(x, y));
        const events = await primary.evaluate(start => window.nativeEvents.slice(start), before);
        assert(events.some(event => event.type === 'mousemove' && event.trusted &&
          Math.abs(event.x - x) <= 1 && Math.abs(event.y - y) <= 1),
        `Missing trusted move (${x},${y}): ${JSON.stringify(events)}`);
      }
      for (const [x, y] of [[100, 100], [100, 100], [-1, -1], [1280, 100], [100, 720], [50, 50]]) {
        await bounded(() => primary.mouse.move(x, y));
      }
      await clickObserved(primary, '#edge');
      await clickObserved(sibling, '#interior');
      assert.equal(await sibling.locator('input').inputValue(), 'unsaved sibling state');

      const slowBefore = await primary.evaluate(() => window.nativeEvents.length);
      let signal;
      const busy = new Promise(resolve => { signal = resolve; });
      await primary.exposeFunction('nativeBusyStarted', () => signal());
      await primary.evaluate(() => {
        setTimeout(() => {
          window.nativeBusyStarted();
          const until = performance.now() + 2000;
          while (performance.now() < until) { /* Deliberately block the content main thread. */ }
        }, 0);
      });
      await busy;
      await bounded(() => primary.mouse.click(150, 125));
      const slowEvents = await primary.evaluate(start => window.nativeEvents.slice(start), slowBefore);
      assert(slowEvents.some(event => event.type === 'click' && event.trusted && event.target === 'interior'));
      await clickObserved(sibling, '#interior');
      assert.equal(await sibling.locator('input').inputValue(), 'unsaved sibling state');

      await primary.mouse.move(50, 50);
      const delayedBefore = await primary.evaluate(() => window.nativeEvents.length);
      await primary.evaluate(() => {
        document.addEventListener('mousemove', () => {
          const until = performance.now() + 6500;
          while (performance.now() < until) { /* Force an ack later than the engine's 5-second watchdog. */ }
        }, { once: true });
      });
      await bounded(() => primary.mouse.move(150, 125), 6000);
      await clickObserved(sibling, '#interior');
      const delayedEvents = await primary.evaluate(start => window.nativeEvents.slice(start), delayedBefore);
      assert(delayedEvents.some(event => event.type === 'mousemove' && event.trusted && event.x === 150 && event.y === 125));
      assert.equal(await sibling.locator('input').inputValue(), 'unsaved sibling state');
    } finally {
      // Closing the disposable process also terminates an underlying timed-out dispatch.
      if (context) await bounded(() => context.close(), 10000);
      await fs.rm(root, { recursive: true, force: true });
    }
  });
}
