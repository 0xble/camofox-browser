// Run explicitly on macOS: node --test tests/native/mainDisplayHandoff.mjs
// Owns a disposable browser/profile only; never connects to the running server.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { firefox } from 'playwright-core';
import { launchOptions } from 'camoufox-js';
import { createDarwinIdentityVisibility } from '../../lib/darwin-identity-visibility.js';
import { launchSharedIdentityContext } from '../../lib/shared-identity-launch.js';
import { launchWithVisibilityFallback, createSharedIdentityVisibility, createNativeWindowReadback, nativelyOnMain, prepareParkedProfile } from '../../lib/shared-identity-visibility.js';
import { findMainDisplay, findParkDisplay, listNativeWindows, windowBounds } from '../../lib/park-display-launcher.js';
import { findBrowserPid, snapshotDarwinProcesses } from '../../lib/darwin-processes.js';

for (const offMain of [false, true]) test(`app-hidden handoff preserves inputs and PID (start off-main=${offMain})`, {
  skip: os.platform() !== 'darwin', timeout: 60000,
}, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'camofox-native-handoff-'));
  const profilePath = path.join(root, 'profile');
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
          control.open = async page => (nativeProof = await open(page));
          return control;
        },
      })),
      launch: ({ headed, visibility }) => launchSharedIdentityContext(profilePath, { headed, visibility,
        firefox, launchOptions, os, getHostOS: () => 'macos', config: { disableDefaultAddons: true },
        events: { emitAsync: async () => {} } }),
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
      console.log(JSON.stringify({ pid, attempt, shown, nativeProof, main, windows, offMainFixture: Boolean(offMain && parking) }));
      await visibility.release({ all: true });
    }
  } finally {
    await context?.close();
    await visibility?.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});
