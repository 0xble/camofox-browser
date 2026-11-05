import { jest } from '@jest/globals';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { generateFingerprint, fromBrowserforge } from 'camoufox-js/dist/fingerprints.js';
import { fingerprintScreen, fingerprintWindowSize, fittedFingerprintWindow } from '../../lib/shared-identity-geometry.js';
import { launchSharedIdentityContext, PENDING_ACTIVATION_FILE } from '../../lib/shared-identity-launch.js';
import { createSharedIdentityVisibility } from '../../lib/shared-identity-visibility.js';
import { createDarwinIdentityVisibility } from '../../lib/darwin-identity-visibility.js';

const display = { main: { left: 0, top: 0, width: 2048, height: 1152 },
  park: { left: -1920, top: -1080, width: 1920, height: 1080 } };
const key = 'chrome://browser/content/browser.xhtml';
function optionsWithSize(options, width = 1366, height = 900) {
  const text = JSON.stringify({ 'window.outerWidth': width, 'window.outerHeight': height, 'screen.width': 2048, 'screen.height': 1152 });
  return { ...options, env: { CAMOU_CONFIG_1: text.slice(0, 25), CAMOU_CONFIG_2: text.slice(25) } };
}

describe('headed shared identity fingerprint geometry', () => {
  let root, visibility;
  beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'shared-geometry-')); });
  afterEach(async () => { await visibility?.close(); visibility = null; await fs.rm(root, { recursive: true, force: true }); });

  test('bounds the random screen to both real target displays without pinning window size', () => {
    const screen = fingerprintScreen([display.main, display.park]);
    expect(screen).toEqual({ maxWidth: 1920, maxHeight: 1080 });
    for (let i = 0; i < 50; i++) {
      const fp = generateFingerprint(undefined, { screen, operatingSystems: ['macos'] });
      expect(fp.screen.width).toBeLessThanOrEqual(screen.maxWidth);
      expect(fp.screen.height).toBeLessThanOrEqual(screen.maxHeight);
      const options = { env: { CAMOU_CONFIG_1: JSON.stringify(fromBrowserforge(fp, '158')) } };
      const outer = fingerprintWindowSize(options);
      // BrowserForge bounds the screen, not necessarily the sampled outer
      // window. The launch boundary separately rejects/resamples outliers.
      expect(outer.width).toBeGreaterThan(0);
      expect(outer.height).toBeGreaterThan(0);
    }
  });

  test('Camoufox can fit sampled outer sizes even when BrowserForge has no naturally fitting small-display samples', () => {
    const screen = { maxWidth: 1280, maxHeight: 960 };
    for (let i = 0; i < 20; i++) {
      const fp = generateFingerprint(undefined, { screen, operatingSystems: ['macos'] });
      const options = { env: { CAMOU_CONFIG_1: JSON.stringify(fromBrowserforge(fp, '158')) } };
      const window = fittedFingerprintWindow(options, screen);
      const fitted = generateFingerprint(window, { screen, operatingSystems: ['macos'] });
      const size = fingerprintWindowSize({ env: { CAMOU_CONFIG_1: JSON.stringify(fromBrowserforge(fitted, '158')) } });
      expect([size.width, size.height]).toEqual(window);
      expect(size.width).toBeLessThanOrEqual(screen.maxWidth);
      expect(size.height).toBeLessThanOrEqual(screen.maxHeight);
    }
  });

  test.each([{}, { env: { CAMOU_CONFIG_1: '{broken' } }, optionsWithSize({}, 0), optionsWithSize({}, 100.5)])('rejects missing/malformed outer geometry %p', value => {
    expect(() => fingerprintWindowSize(value)).toThrow(/Camoufox/);
  });

  test('uses chunked final config after launch hooks for initial xulstore and live show/park bounds', async () => {
    visibility = await createSharedIdentityVisibility(display, { rootDir: path.join(root, 'addons'), nativeReadback: null });
    await fs.writeFile(path.join(root, 'xulstore.json'), JSON.stringify({ other: 5, [key]: { sidebar: { open: true }, 'main-window': { custom: 'retained' } } }));
    const launchOptions = jest.fn(async options => optionsWithSize(options));
    const firefox = { launchPersistentContext: jest.fn(async () => {
      const stored = JSON.parse(await fs.readFile(path.join(root, 'xulstore.json'), 'utf8'));
      expect(stored).toMatchObject({ other: 5, [key]: { sidebar: { open: true }, 'main-window': {
        width: '1440', height: '920', screenX: '-1880', screenY: '-1040', sizemode: 'normal', custom: 'retained',
      } } });
      expect(visibility.park).toMatchObject({ width: 1440, height: 920 });
      const script = await fs.readFile(path.join(visibility.addon, 'background.js'), 'utf8');
      const endpoint = script.match(/const endpoint="([^"]+)"/)[1];
      const snapshot = await (await fetch(endpoint)).json();
      expect(snapshot.display.mainBounds).toMatchObject({ width: 1440, height: 920, focused: true });
      expect(snapshot.display.parkBounds).toMatchObject({ width: 1440, height: 920, focused: false });
      return {};
    }) };
    await launchSharedIdentityContext(root, { headed: true, visibility, launchOptions, firefox,
      os: { platform: () => 'darwin' }, getHostOS: () => 'macos', config: {},
      events: { emitAsync: async (_event, value) => { value.options.env = optionsWithSize({}, 1440, 920).env; } },
    });
    expect(launchOptions.mock.calls[0][0].screen).toEqual({ maxWidth: 1920, maxHeight: 1080 });
    expect(launchOptions.mock.calls[0][0]).not.toHaveProperty('window');
    expect(firefox.launchPersistentContext).toHaveBeenCalledTimes(1);
    visibility.updateDisplay({ ...display, main: { ...display.main, left: 100 } });
    expect(visibility.initialBounds).toMatchObject({ width: 1440, height: 920 });
  });

  test('app-hidden wrapper forwards geometry to its show-only window control', async () => {
    const control = await createSharedIdentityVisibility({ main: display.main, park: null }, { rootDir: path.join(root, 'addons'), showOnly: true, nativeReadback: null });
    visibility = createDarwinIdentityVisibility(root, { createWindowControl: async () => control });
    await visibility.prepare();
    expect(visibility.launchDisplays).toEqual([display.main]);
    visibility.setWindowSize({ width: 1366, height: 900 });
    expect(visibility.initialBounds).toMatchObject({ width: 1366, height: 900 });
  });

  test('legacy headed launch discovers main; headless warm-up stays unconstrained and writes no geometry', async () => {
    await fs.writeFile(path.join(root, PENDING_ACTIVATION_FILE), '');
    const launchOptions = jest.fn(async options => optionsWithSize(options));
    const discoverMainDisplay = jest.fn(async () => display.main);
    const firefox = { launchPersistentContext: jest.fn(async (_profile, options) => {
      if (options.headless) await expect(fs.access(path.join(root, 'xulstore.json'))).rejects.toMatchObject({ code: 'ENOENT' });
      return { close: async () => {} };
    }) };
    await launchSharedIdentityContext(root, { headed: true, launchOptions, firefox, discoverMainDisplay,
      os: { platform: () => 'darwin' }, getHostOS: () => 'macos', config: {}, events: { emitAsync: async () => {} } });
    expect(discoverMainDisplay).toHaveBeenCalledTimes(1);
    expect(launchOptions.mock.calls[0][0]).not.toHaveProperty('screen');
    expect(launchOptions.mock.calls[1][0].screen).toEqual({ maxWidth: 2048, maxHeight: 1152 });
    expect(JSON.parse(await fs.readFile(path.join(root, 'xulstore.json'), 'utf8'))[key]['main-window'])
      .toMatchObject({ width: '1366', height: '900', screenX: '40', screenY: '40' });
  });

  test('regenerates oversized samples through Camoufox before selecting the applied config', async () => {
    const launchOptions = jest.fn()
      .mockImplementationOnce(async options => optionsWithSize(options, 2048, 1156))
      .mockImplementationOnce(async options => optionsWithSize(options, 1366, 900));
    const emitAsync = jest.fn(async () => {});
    const firefox = { launchPersistentContext: jest.fn(async () => ({})) };
    await launchSharedIdentityContext(root, { headed: true, firefox, launchOptions, discoverMainDisplay: async () => display.main,
      os: { platform: () => 'darwin' }, getHostOS: () => 'macos', config: {}, events: { emitAsync } });
    expect(launchOptions).toHaveBeenCalledTimes(2);
    expect(launchOptions.mock.calls[1][0].window).toEqual([2040, 1152]);
    expect(emitAsync).toHaveBeenCalledTimes(1);
    expect(fingerprintWindowSize(firefox.launchPersistentContext.mock.calls[0][1])).toEqual({ width: 1366, height: 900 });
  });

  test('an outlier outer size fails before Firefox launches, never enlarged or clamped away from its fingerprint', async () => {
    const firefox = { launchPersistentContext: jest.fn() };
    await expect(launchSharedIdentityContext(root, { headed: true, firefox,
      launchOptions: async options => optionsWithSize(options, 4000, 2000), discoverMainDisplay: async () => display.main,
      os: { platform: () => 'darwin' }, getHostOS: () => 'macos', config: {}, events: { emitAsync: async () => {} },
    })).rejects.toThrow('exceeds');
    expect(firefox.launchPersistentContext).not.toHaveBeenCalled();
    await expect(fs.access(path.join(root, 'xulstore.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
