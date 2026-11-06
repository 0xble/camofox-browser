// Run explicitly on macOS: node --test tests/native/mainDisplayHandoff.mjs
// CAMOFOX_NATIVE_TEST_APP=/path/to/signed/Camoufox.app node --test tests/native/mainDisplayHandoff.mjs
// CAMOFOX_NATIVE_TEST_PARK=1 also exercises the existing virtual display (never creates one).
// Copies that app to scratch; never connects to the running server or live profile.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { firefox } from 'playwright-core';
import { launchOptions } from 'camoufox-js';
import { createDarwinIdentityVisibility, setDarwinAppHidden } from '../../lib/darwin-identity-visibility.js';
import { launchSharedIdentityContext } from '../../lib/shared-identity-launch.js';
import { fingerprintWindowSize } from '../../lib/shared-identity-geometry.js';
import { launchWithVisibilityFallback, createSharedIdentityVisibility, createNativeWindowReadback, nativelyOnMain, nativelyParked, prepareParkedProfile } from '../../lib/shared-identity-visibility.js';
import { findMainDisplay, findParkDisplay, listNativeWindows, windowBounds } from '../../lib/park-display-launcher.js';
import { findBrowserPid, snapshotDarwinProcesses } from '../../lib/darwin-processes.js';

for (const offMain of [false, true]) test(`app-hidden handoff preserves inputs and PID (start off-main=${offMain})`, {
  skip: os.platform() !== 'darwin' || !process.env.CAMOFOX_NATIVE_TEST_APP, timeout: 60000,
}, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'camofox-native-handoff-'));
  const profilePath = path.join(root, 'profile');
  const appPath = path.join(root, 'Camoufox.app');
  await fs.cp(await fs.realpath(process.env.CAMOFOX_NATIVE_TEST_APP), appPath, { recursive: true, verbatimSymlinks: true });
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', appPath]);
  await fs.mkdir(profilePath);
  let context, visibility, firstNative, nativeProof;
  try {
    const parking = await findParkDisplay();
    context = await launchWithVisibilityFallback({ display: null, profilePath,
      createBackgroundVisibility: profile => (visibility = createDarwinIdentityVisibility(profile, {
        createWindowControl: async () => {
          const discoverDisplay = async () => ({ main: await findMainDisplay(), park: null });
          const read = createNativeWindowReadback(profile);
          const control = await createSharedIdentityVisibility(await discoverDisplay(), { profilePath: profile, showOnly: true,
            discoverDisplay, nativeReadback: async () => { const windows = await read(); firstNative ??= windows; return windows; } });
          const open = control.open.bind(control);
          control.open = async (page, options) => (nativeProof = await open(page, options));
          return control;
        },
      })),
      launch: ({ headed, visibility }) => launchSharedIdentityContext(profilePath, { headed, visibility,
        firefox: { launchPersistentContext: async (profile, options) => {
          const size = fingerprintWindowSize(options);
          const stored = JSON.parse(await fs.readFile(path.join(profile, 'xulstore.json'), 'utf8'))
            ['chrome://browser/content/browser.xhtml']['main-window'];
          assert.deepEqual([Number(stored.width), Number(stored.height)], [size.width, size.height]);
          // Deliberately start off-main without changing the launch fingerprint.
          if (offMain && parking) await prepareParkedProfile(profile, windowBounds(parking.park, false, size));
          return firefox.launchPersistentContext(profile, options);
        } }, launchOptions, os, getHostOS: () => 'macos', config: { disableDefaultAddons: true, directIdentity: {
          locale: process.env.CAMOFOX_LOCALE || 'en-US', timezoneId: process.env.CAMOFOX_TIMEZONE || 'America/Los_Angeles',
        } },
        events: { emitAsync: async (_event, { options }) => {
          options.executablePath = path.join(appPath, 'Contents/MacOS/camoufox');
          const fingerprint = JSON.parse(Object.entries(options.env).filter(([k]) => k.startsWith('CAMOU_CONFIG_'))
            .sort(([a], [b]) => Number(a.split('_').at(-1)) - Number(b.split('_').at(-1))).map(([, v]) => v).join(''));
          console.log(JSON.stringify({ launch: { locale: options.locale, timezoneId: options.timezoneId, viewport: options.viewport,
            fingerprint: Object.fromEntries(Object.entries(fingerprint).filter(([k]) => /^(window\.|screen\.|locale:|timezone)/.test(k))) } }));
        } } }),
    });
    const pid = findBrowserPid(process.pid, snapshotDarwinProcesses(), profilePath);
    assert.ok(pid);
    const page = await visibility.newPage(context), sibling = await visibility.newPage(context);
    await page.setContent('<title>Native handoff target</title><input value="unsaved target">');
    await sibling.setContent('<title>Native handoff sibling</title><input value="unsaved sibling">');
    for (let attempt = 0; attempt < 2; attempt++) {
      const shown = await visibility.open(page);
      const windows = await listNativeWindows(pid), main = await findMainDisplay();
      assert.equal(shown.visible, true);
      assert.equal(typeof shown.focused, 'boolean');
      assert.equal(nativeProof.frontmost, true, 'exact target is first in its PID-owned native window list');
      assert.ok(windows.length > 0, 'zero windows cannot prove handoff');
      const target = windows.find(window => window.number === nativeProof.number);
      assert.ok(target && nativelyOnMain(target, { main }), 'exact bound target is on main');
      const size = await page.evaluate(() => ({ width: outerWidth, height: outerHeight }));
      assert.deepEqual({ width: target.width, height: target.height }, size, 'native outer size equals the applied Camoufox fingerprint');
      for (const before of firstNative.filter(window => window.number !== target.number)) {
        const siblingWindow = windows.find(window => window.number === before.number);
        assert.ok(siblingWindow, 'sibling native window is retained');
        if (!nativelyOnMain(before, { main })) assert.equal(nativelyOnMain(siblingWindow, { main }), false, 'off-main siblings are not moved onto main');
      }
      assert.equal(findBrowserPid(process.pid, snapshotDarwinProcesses(), profilePath), pid);
      assert.equal(await page.locator('input').inputValue(), 'unsaved target');
      assert.equal(await sibling.locator('input').inputValue(), 'unsaved sibling');
      assert.ok(context.pages().includes(page) && context.pages().includes(sibling));
      console.log(JSON.stringify({ pid, attempt, shown, nativeProof, main, windows, css: await page.evaluate(() => ({ outerWidth, outerHeight, screenX, screenY, devicePixelRatio })), offMainFixture: Boolean(offMain && parking) }));
      await visibility.release({ all: true });
      const released = await setDarwinAppHidden(pid, false, { readOnly: true });
      assert.equal(released.hidden, true, 'release is independently confirmed hidden by AppKit');
      console.log(JSON.stringify({ pid, attempt, released }));
    }
  } finally {
    await context?.close();
    await visibility?.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('parking handoff uses fingerprint outer size and exact native bindings', {
  skip: os.platform() !== 'darwin' || !process.env.CAMOFOX_NATIVE_TEST_APP || !process.env.CAMOFOX_NATIVE_TEST_PARK, timeout: 60000,
}, async t => {
  const display = await findParkDisplay();
  if (!display) return t.skip('no existing virtual parking display');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'camofox-native-fingerprint-'));
  const profilePath = path.join(root, 'profile'), appPath = path.join(root, 'Camoufox.app');
  await fs.cp(await fs.realpath(process.env.CAMOFOX_NATIVE_TEST_APP), appPath, { recursive: true, verbatimSymlinks: true });
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', appPath]);
  await fs.mkdir(profilePath);
  let context, visibility;
  try {
    visibility = await createSharedIdentityVisibility(display, { profilePath, rootDir: path.join(root, 'addons'), discoverDisplay: findParkDisplay });
    await prepareParkedProfile(profilePath, visibility.park);
    context = await launchSharedIdentityContext(profilePath, { headed: true, visibility, firefox,
      launchOptions, os, getHostOS: () => 'macos', config: { disableDefaultAddons: true },
      events: { emitAsync: async (_event, { options }) => { options.executablePath = path.join(appPath, 'Contents/MacOS/camoufox'); } },
    });
    await visibility.attach(context);
    const [page, sibling] = await Promise.all([visibility.newPage(context), visibility.newPage(context)]);
    const extra = await Promise.all(Array.from({ length: 3 }, () => visibility.newPage(context)));
    await page.setContent('<input value="target unsaved">');
    await sibling.setContent('<input value="sibling unsaved">');
    const pid = findBrowserPid(process.pid, snapshotDarwinProcesses(), profilePath);
    const codes = new Set();
    for (const [index, p] of [page, sibling, ...extra].entries()) {
      await visibility.open(p);
      const opened = [...visibility.visible.values()].at(-1);
      const script = await fs.readFile(path.join(visibility.addon, 'background.js'), 'utf8');
      const endpoint = script.match(/const endpoint="([^"]+)"/)[1];
      const proof = await (await fetch(endpoint + '/geometry', { method: 'POST', body: JSON.stringify({ windowId: opened.windowId, action: 'show' }) })).json();
      assert.equal(proof.onMain, true);
      assert.ok(Number.isSafeInteger(proof.number));
      codes.add(proof.number);
      await visibility.release({ page: p });
      console.log(JSON.stringify({ concurrentBinding: { index, number: proof.number } }));
    }
    assert.equal(codes.size, 5, '2- and 3-way concurrent creates have distinct native bindings');
    await visibility.open(page);
    const opened = [...visibility.visible.values()].at(-1);
    const script = await fs.readFile(path.join(visibility.addon, 'background.js'), 'utf8');
    const endpoint = script.match(/const endpoint="([^"]+)"/)[1];
    const shown = await (await fetch(endpoint + '/geometry', { method: 'POST', body: JSON.stringify({ windowId: opened.windowId, action: 'show' }) })).json();
    assert.equal(shown.onMain, true);
    const size = await page.evaluate(() => ({ width: outerWidth, height: outerHeight }));
    assert.deepEqual({ width: shown.actual.width, height: shown.actual.height }, size);
    assert.ok(size.width <= display.main.width && size.width <= display.park.width);
    assert.ok(size.height <= display.main.height && size.height <= display.park.height);
    await visibility.release({ page });
    const target = (await listNativeWindows(pid)).find(window => window.number === shown.number);
    assert.ok(target && nativelyParked(target, display));
    assert.deepEqual({ width: target.width, height: target.height }, size);
    assert.equal(await page.locator('input').inputValue(), 'target unsaved');
    assert.equal(await sibling.locator('input').inputValue(), 'sibling unsaved');
    console.log(JSON.stringify({ pid, shown, parked: target, fingerprint: size }));
  } catch (error) {
    const pid = findBrowserPid(process.pid, snapshotDarwinProcesses(), profilePath);
    console.log(JSON.stringify({ failure: error.message, display, parkBounds: visibility?.park, windows: pid ? await listNativeWindows(pid) : [] }));
    throw error;
  } finally {
    await context?.close();
    await visibility?.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});
