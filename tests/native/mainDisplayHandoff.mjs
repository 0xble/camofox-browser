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

async function bounded(work, label) {
  let timer;
  try {
    return await Promise.race([work, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(label + ' timed out')), 5000);
    })]);
  } finally { clearTimeout(timer); }
}

async function closeFixture({ context, visibility, root, profilePath }, failure) {
  const ownedPid = () => findBrowserPid(process.pid, snapshotDarwinProcesses() || [], profilePath);
  try {
    // Stop command polling before closing Firefox. Never let hung Juggler
    // cleanup replace a binding failure with the test's outer timeout.
    await bounded(Promise.resolve(visibility?.close()), 'visibility cleanup');
    const closing = Promise.resolve(context?.close());
    try { await bounded(closing, 'browser cleanup'); }
    catch (error) {
      const pid = ownedPid();
      if (!pid) throw error;
      // Only this test's descendant with this exact disposable profile.
      process.kill(pid, 'SIGKILL');
      await bounded(closing.catch(() => {}), 'killed browser cleanup');
    }
    // Launch can reject before assigning context when installer cleanup could
    // not confirm ownership. Reconcile this fixture's exact descendant before
    // removing its profile, even when no context was returned to the harness.
    const remaining = ownedPid();
    if (remaining) {
      process.kill(remaining, 'SIGKILL');
      await bounded((async () => {
        while (ownedPid() === remaining) await new Promise(resolve => setTimeout(resolve, 25));
      })(), 'disposable browser exit');
    }
    await fs.rm(root, { recursive: true, force: true });
  } catch (error) {
    console.error(JSON.stringify({ cleanupFailure: error.message, root }));
    if (!failure) throw error;
    failure.cleanupError = error;
  }
}

for (const offMain of [false, true]) test(`app-hidden handoff preserves inputs and PID (start off-main=${offMain})`, {
  skip: os.platform() !== 'darwin' || !process.env.CAMOFOX_NATIVE_TEST_APP, timeout: 60000,
}, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'camofox-native-handoff-'));
  const profilePath = path.join(root, 'profile');
  const appPath = path.join(root, 'Camoufox.app');
  let context, visibility, firstNative, nativeProof, failure;
  try {
    await fs.cp(await fs.realpath(process.env.CAMOFOX_NATIVE_TEST_APP), appPath, { recursive: true, verbatimSymlinks: true });
    execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', appPath]);
    await fs.mkdir(profilePath);
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
      assert.deepEqual({ width: nativeProof.bounds.width, height: nativeProof.bounds.height }, size,
        'AppKit move requests retain the applied outer size, independently of CGWindow visual bounds');
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
  } catch (error) { failure = error; console.error(JSON.stringify({ failure: error.message })); throw error; }
  finally { await closeFixture({ context, visibility, root, profilePath }, failure); }
});

test('parking handoff uses fingerprint outer size and exact native bindings', {
  skip: os.platform() !== 'darwin' || !process.env.CAMOFOX_NATIVE_TEST_APP || !process.env.CAMOFOX_NATIVE_TEST_PARK, timeout: 180000,
}, async () => {
  const display = await findParkDisplay();
  assert.ok(display, 'native acceptance requires an existing visible parking display');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'camofox-native-fingerprint-'));
  const profilePath = path.join(root, 'profile'), appPath = path.join(root, 'Camoufox.app');
  let context, visibility, failure, phase = 'startup', readIndex = 0;
  const diagnostics = [];
  try {
    await fs.cp(await fs.realpath(process.env.CAMOFOX_NATIVE_TEST_APP), appPath, { recursive: true, verbatimSymlinks: true });
    execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', appPath]);
    await fs.mkdir(profilePath);
    const read = createNativeWindowReadback(profilePath);
    visibility = await createSharedIdentityVisibility(display, { profilePath, rootDir: path.join(root, 'addons'), discoverDisplay: findParkDisplay,
      diagnostics: record => { diagnostics.push(record); console.log(JSON.stringify({ addonDiagnostic: record })); },
      nativeReadback: async () => {
        const windows = await read();
        console.log(JSON.stringify({ nativeReadback: { phase, index: ++readIndex, windows } }));
        return windows;
      } });
    await prepareParkedProfile(profilePath, visibility.park);
    context = await launchSharedIdentityContext(profilePath, { headed: true, visibility, firefox,
      launchOptions: options => launchOptions({ ...options,
        screen: { ...options.screen, minWidth: 860, minHeight: 540 }, window: [860, 540] }),
      os, getHostOS: () => 'macos',
      config: { disableDefaultAddons: true, directIdentity: {
        locale: process.env.CAMOFOX_LOCALE || 'en-US', timezoneId: process.env.CAMOFOX_TIMEZONE || 'America/Los_Angeles',
      } },
      events: { emitAsync: async (_event, { options }) => {
        options.executablePath = path.join(appPath, 'Contents/MacOS/camoufox');
        assert.deepEqual(fingerprintWindowSize(options), { width: 860, height: 540 });
        console.log(JSON.stringify({ launch: { locale: options.locale, timezoneId: options.timezoneId, fingerprint: fingerprintWindowSize(options) } }));
      } },
    });
    const stored = JSON.parse(await fs.readFile(path.join(profilePath, 'xulstore.json'), 'utf8'))
      ['chrome://browser/content/browser.xhtml']['main-window'];
    assert.deepEqual([Number(stored.width), Number(stored.height)], [860, 540]);
    await visibility.attach(context);
    const pid = findBrowserPid(process.pid, snapshotDarwinProcesses(), profilePath);
    assert.ok(pid);
    phase = 'serial create';
    const page = await visibility.newPage(context);
    await page.setContent('<input value="unsaved 0">');
    phase = '2 concurrent creates';
    const [sibling, second] = await Promise.all([visibility.newPage(context), visibility.newPage(context)]);
    assert.equal(await page.locator('input').inputValue(), 'unsaved 0');
    await sibling.setContent('<input value="unsaved 1">');
    await second.setContent('<input value="unsaved 2">');
    phase = '3 concurrent creates';
    const extra = await Promise.all(Array.from({ length: 3 }, () => visibility.newPage(context)));
    const pages = [page, sibling, second, ...extra];
    for (const [index, p] of extra.entries()) await p.setContent(`<input value="unsaved ${index + 3}">`);
    for (const [index, p] of pages.entries()) {
      assert.equal(await p.locator('input').inputValue(), `unsaved ${index}`);
      const screenshot = await p.screenshot();
      assert.ok(screenshot.length > 100, 'each surviving page produces real screenshot bytes');
      console.log(JSON.stringify({ screenshotBytes: screenshot.length, index }));
    }
    const script = await fs.readFile(path.join(visibility.addon, 'background.js'), 'utf8');
    const endpoint = script.match(/const endpoint="([^"]+)"/)[1];
    const geometry = async (windowId, action) => {
      const response = await fetch(endpoint + '/geometry', { method: 'POST', body: JSON.stringify({ windowId, action }) });
      assert.equal(response.ok, true);
      return response.json();
    };
    const codes = new Set();
    for (const [index, p] of pages.entries()) {
      phase = `open/release ${index}`;
      const before = await listNativeWindows(pid);
      await visibility.open(p);
      const opened = [...visibility.visible.values()].at(-1);
      const proof = await geometry(opened.windowId, 'show');
      assert.equal(proof.onMain, true);
      assert.ok(Number.isSafeInteger(proof.number));
      codes.add(proof.number);
      const after = await listNativeWindows(pid);
      for (const old of before.filter(w => w.number !== proof.number)) {
        const retained = after.find(w => w.number === old.number);
        assert.ok(retained, 'sibling native number is retained');
        if (nativelyParked(old, display)) assert.ok(nativelyParked(retained, display), 'parked sibling stays off main');
      }
      const size = await p.evaluate(() => ({ width: outerWidth, height: outerHeight }));
      assert.deepEqual(size, { width: 860, height: 540 });
      assert.deepEqual({ width: proof.bounds.width, height: proof.bounds.height }, size);
      await visibility.release({ page: p });
      const parked = await geometry(opened.windowId, 'park');
      assert.equal(parked.number, proof.number, 'release preserves the exact bound number');
      assert.equal(parked.parked, true);
      assert.ok(nativelyParked(parked.actual, display));
      assert.equal(findBrowserPid(process.pid, snapshotDarwinProcesses(), profilePath), pid);
      for (const [i, live] of pages.entries()) {
        assert.ok(context.pages().includes(live), 'all created pages survive handoff');
        assert.equal(await live.locator('input').inputValue(), `unsaved ${i}`);
      }
      console.log(JSON.stringify({ concurrentBinding: { index, number: proof.number } }));
    }
    assert.equal(codes.size, 6, 'serial, 2- and 3-way concurrent creates have distinct native bindings');
    await visibility.open(page);
    const opened = [...visibility.visible.values()].at(-1);
    const shown = await geometry(opened.windowId, 'show');
    assert.equal(shown.onMain, true);
    const size = await page.evaluate(() => ({ width: outerWidth, height: outerHeight }));
    assert.deepEqual({ width: shown.bounds.width, height: shown.bounds.height }, size);
    assert.ok(size.width <= display.main.width && size.width <= display.park.width);
    assert.ok(size.height <= display.main.height && size.height <= display.park.height);
    await visibility.release({ page });
    const target = (await listNativeWindows(pid)).find(window => window.number === shown.number);
    assert.ok(target && nativelyParked(target, display));
    assert.equal(await page.locator('input').inputValue(), 'unsaved 0');
    assert.equal(await sibling.locator('input').inputValue(), 'unsaved 1');
    const deadline = Date.now() + 1000;
    while (diagnostics.filter(record => record.event === 'ack').length < 20 && Date.now() < deadline)
      await new Promise(resolve => setTimeout(resolve, 10));
    const starts = diagnostics.filter(record => record.event === 'start');
    const creates = diagnostics.filter(record => record.event === 'create');
    assert.equal(starts.length, 1, 'one background throughout all native window creates');
    assert.equal(new Set(diagnostics.map(record => record.instance)).size, 1);
    assert.equal(creates.length, 6, 'each create command executes once');
    assert.equal(new Set(creates.map(record => record.commandId)).size, 6);
    assert.equal(diagnostics.filter(record => record.event === 'ack' && !record.accepted).length, 0);
    const acknowledgments = diagnostics.filter(record => record.event === 'ack').map(record => record.commandId);
    assert.equal(acknowledgments.length, 20, 'all create/open/release acknowledgments were observed');
    assert.equal(new Set(acknowledgments).size, acknowledgments.length, 'each command acknowledges once');
    console.log(JSON.stringify({ pid, shown, parked: target, fingerprint: size }));
  } catch (error) {
    failure = error;
    console.error(JSON.stringify({ failure: error.message }));
    try {
      const pid = findBrowserPid(process.pid, snapshotDarwinProcesses() || [], profilePath);
      console.log(JSON.stringify({ display, parkBounds: visibility?.park, windows: pid ? await listNativeWindows(pid) : [] }));
    } catch (diagnosticError) { console.error(JSON.stringify({ diagnosticFailure: diagnosticError.message })); }
    throw error;
  } finally { await closeFixture({ context, visibility, root, profilePath }, failure); }
});
