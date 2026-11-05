// Run explicitly on macOS: node --test tests/native/mainDisplayHandoff.mjs
// CAMOFOX_NATIVE_TEST_APP=/path/to/signed/Camoufox.app node --test tests/native/mainDisplayHandoff.mjs
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
import { launchWithVisibilityFallback, createSharedIdentityVisibility, createNativeWindowReadback, nativelyOnMain, prepareParkedProfile } from '../../lib/shared-identity-visibility.js';
import { findMainDisplay, findParkDisplay, listNativeWindows, windowBounds } from '../../lib/park-display-launcher.js';
import { findBrowserPid, snapshotDarwinProcesses } from '../../lib/darwin-processes.js';

for (const offMain of [false, true]) test(`app-hidden handoff preserves inputs and PID (start off-main=${offMain})`, {
  skip: os.platform() !== 'darwin' || !process.env.CAMOFOX_NATIVE_TEST_APP, timeout: 60000,
}, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'camofox-native-handoff-'));
  const profilePath = path.join(root, 'profile');
  const appPath = path.join(root, 'Camoufox.app');
  await fs.cp(process.env.CAMOFOX_NATIVE_TEST_APP, appPath, { recursive: true, verbatimSymlinks: true });
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', appPath]);
  await fs.mkdir(profilePath);
  let context, visibility, firstNative, nativeProof;
  try {
    const parking = await findParkDisplay();
    if (offMain && parking) await prepareParkedProfile(profilePath, windowBounds(parking.park));
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
        firefox, launchOptions, os, getHostOS: () => 'macos', config: { disableDefaultAddons: true, directIdentity: {
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
