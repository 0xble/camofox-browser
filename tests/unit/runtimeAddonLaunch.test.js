import { jest, test, expect, beforeEach, afterEach } from '@jest/globals';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { launchSharedIdentityContext, PENDING_ACTIVATION_FILE } from '../../lib/shared-identity-launch.js';
import { prepareRuntimeAddons } from '../../lib/runtime-addons.js';
import { testMainDisplay, withWindowConfig } from '../helpers/sharedLaunchGeometry.js';

let profile, listenerRoot, context, installer, prepare, firefox, launchOptions;
beforeEach(async () => {
  profile = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-launch-'));
  listenerRoot = await fs.mkdtemp('/tmp/rdp-launch-');
  context = new EventEmitter(); context.close = jest.fn(async () => context.emit('close'));
  installer = { args: ['--start-debugger-server', '/private/fixture/rdp'],
    firefoxUserPrefs: { 'devtools.debugger.remote-enabled': true },
    install: jest.fn(async () => ['helper@test']), close: jest.fn(async () => {}) };
  prepare = jest.fn(async () => installer);
  firefox = { launchPersistentContext: jest.fn(async () => context) };
  launchOptions = jest.fn(async options => {
    const generated = withWindowConfig(options);
    const config = JSON.parse(generated.env.CAMOU_CONFIG_1);
    config.addons = ['/default/ubo']; // camoufox-js's ordinary addon resolution
    return { ...generated, args: ['--existing'], firefoxUserPrefs: { 'existing.pref': true },
      env: { CAMOU_CONFIG_1: JSON.stringify(config) } };
  });
});
afterEach(async () => {
  jest.restoreAllMocks();
  await fs.rm(profile, { recursive: true, force: true });
  await fs.rm(listenerRoot, { recursive: true, force: true });
});
const useRealInstaller = () => prepare.mockImplementation(async (addons, options) => {
  const real = await prepareRuntimeAddons(addons, { ...options, tmpDir: listenerRoot });
  real.install = installer.install;
  return real;
});
const launch = (extra = {}) => launchSharedIdentityContext(profile, {
  headed: true, visibility: { addon: '/generated/visibility' },
  firefox, launchOptions, prepareRuntimeAddons: prepare, discoverMainDisplay: testMainDisplay,
  os: { platform: () => 'darwin' }, getHostOS: () => 'macos', config: {},
  events: { emitAsync: async () => {} }, ...extra,
});

test.each([false, true])('installer prefs exist before first launch and restore user.js (existing=%s)', async existing => {
  const userFile = path.join(profile, 'user.js');
  const original = Buffer.from('// unrelated user code, no final newline\r\nuser_pref("user.custom", "café"); // keep');
  let metadata;
  if (existing) {
    await fs.writeFile(userFile, original, { mode: 0o640 });
    await fs.utimes(userFile, new Date('2020-01-02'), new Date('2020-02-03'));
    metadata = await fs.stat(userFile);
  }
  useRealInstaller();
  firefox.launchPersistentContext.mockImplementation(async (_profile, options) => {
    const bytes = await fs.readFile(userFile);
    expect(bytes.subarray(0, existing ? original.length : 0)).toEqual(existing ? original : Buffer.alloc(0));
    const flags = bytes.subarray(existing ? original.length : 0).toString();
    expect(flags).not.toContain('existing.pref');
    for (const [key, value] of Object.entries(options.firefoxUserPrefs).filter(([key]) => key.startsWith('devtools.'))) {
      expect(flags.split(`user_pref(${JSON.stringify(key)}, ${JSON.stringify(value)});`)).toHaveLength(2);
    }
    expect(flags).toContain('user_pref("devtools.chrome.enabled", true);');
    expect(flags).toContain('user_pref("devtools.debugger.remote-enabled", true);');
    expect(flags).toContain('user_pref("devtools.debugger.prompt-connection", false);');
    return context;
  });
  for (let attempt = 0; attempt < 2; attempt++) {
    expect(await launch()).toBe(context);
    if (existing) {
      const after = await fs.stat(userFile);
      expect({ mode: after.mode, ino: after.ino, uid: after.uid, gid: after.gid,
        atimeMs: after.atimeMs, mtimeMs: after.mtimeMs }).toEqual({ mode: metadata.mode,
        ino: metadata.ino, uid: metadata.uid, gid: metadata.gid,
        atimeMs: metadata.atimeMs, mtimeMs: metadata.mtimeMs });
      expect(await fs.readFile(userFile)).toEqual(original);
      // Reading the restored file must not change the next launch's baseline.
      await fs.utimes(userFile, metadata.atime, metadata.mtime);
    } else await expect(fs.stat(userFile)).rejects.toMatchObject({ code: 'ENOENT' });
  }
  expect(await fs.readdir(listenerRoot)).toEqual([]);
});

test.each([false, true])('headless and warmup never mutate startup prefs (existing=%s)', async existing => {
  const userFile = path.join(profile, 'user.js');
  const original = '// user file must be untouched during warmup';
  if (existing) await fs.writeFile(userFile, original);
  const unchanged = async () => {
    if (existing) expect(await fs.readFile(userFile, 'utf8')).toBe(original);
    else await expect(fs.stat(userFile)).rejects.toMatchObject({ code: 'ENOENT' });
  };
  useRealInstaller();
  firefox.launchPersistentContext.mockImplementation(async (_profile, options) => {
    if (options.headless) await unchanged();
    else expect(await fs.readFile(userFile, 'utf8')).toContain('devtools.chrome.enabled');
    return context;
  });
  await launch({ headed: false });
  await fs.writeFile(path.join(profile, PENDING_ACTIVATION_FILE), '');
  await launch();
  expect(firefox.launchPersistentContext.mock.calls.map(([, options]) => options.headless)).toEqual([true, true, false]);
  expect(prepare).toHaveBeenCalledTimes(1);
  await unchanged();
  expect(await fs.readdir(listenerRoot)).toEqual([]);
});

test.each([false, true].flatMap(existing => ['launch', 'install'].map(stage => [existing, stage])))
('restores startup prefs after %s user.js and %s failure', async (existing, stage) => {
  const userFile = path.join(profile, 'user.js');
  const original = Buffer.from('user_pref("user.custom", false); // no final newline');
  if (existing) await fs.writeFile(userFile, original);
  useRealInstaller();
  const failure = new Error(`${stage} failed`);
  if (stage === 'launch') failure.profileOwnershipUnconfirmed = true;
  if (stage === 'launch') firefox.launchPersistentContext.mockRejectedValue(failure);
  else installer.install.mockRejectedValue(failure);
  await expect(launch()).rejects.toBe(failure);
  expect(failure.profileOwnershipUnconfirmed).toBe(stage === 'launch' ? true : undefined);
  expect(context.close).toHaveBeenCalledTimes(stage === 'install' ? 1 : 0);
  if (existing) expect(await fs.readFile(userFile)).toEqual(original);
  else await expect(fs.stat(userFile)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await fs.readdir(listenerRoot)).toEqual([]);
});

test('refuses to erase unrelated changes made to user.js during launch', async () => {
  const userFile = path.join(profile, 'user.js');
  const original = '// existing code';
  await fs.writeFile(userFile, original);
  useRealInstaller();
  let changed;
  installer.install.mockImplementation(async () => {
    await fs.appendFile(userFile, '\n// external edit');
    changed = await fs.readFile(userFile);
  });
  await expect(launch()).rejects.toThrow('user.js changed before cleanup');
  expect(context.close).toHaveBeenCalledTimes(1);
  expect(await fs.readFile(userFile)).toEqual(changed);
  expect(await fs.readdir(listenerRoot)).toEqual([]);
});

test('refuses a symlinked user.js without modifying its target or launching', async () => {
  const target = path.join(profile, 'user-prefs-source');
  await fs.writeFile(target, '// keep target');
  await fs.symlink(target, path.join(profile, 'user.js'));
  useRealInstaller();
  await expect(launch()).rejects.toMatchObject({ code: 'ELOOP' });
  expect(firefox.launchPersistentContext).not.toHaveBeenCalled();
  expect(await fs.readFile(target, 'utf8')).toBe('// keep target');
  expect(await fs.readdir(listenerRoot)).toEqual([]);
});

test.each([false, true].flatMap(existing => [false, true].map(partial => [existing, partial])))
('preparation failure restores user.js (existing=%s, partial=%s)', async (existing, partial) => {
  const userFile = path.join(profile, 'user.js');
  const original = Buffer.from('// arbitrary user bytes\r\nuser_pref("custom", 7);');
  if (existing) await fs.writeFile(userFile, original);
  const failure = new Error('startup preference write failed');
  const open = fs.open.bind(fs);
  jest.spyOn(fs, 'open').mockImplementation(async (file, ...args) => {
    const handle = await open(file, ...args);
    if (file === userFile) handle.writeFile = async bytes => {
      if (partial) await handle.write(bytes.subarray(0, 17));
      throw failure;
    };
    return handle;
  });
  useRealInstaller();
  await expect(launch()).rejects.toBe(failure);
  expect(firefox.launchPersistentContext).not.toHaveBeenCalled();
  if (existing) expect(await fs.readFile(userFile)).toEqual(original);
  else await expect(fs.stat(userFile)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await fs.readdir(listenerRoot)).toEqual([]);
});

test.each([false, true].flatMap(existing => [false, true].map(installFails => [existing, installFails])))
('startup-pref cleanup failure cannot return context (existing=%s, installFails=%s)', async (existing, installFails) => {
  const userFile = path.join(profile, 'user.js');
  if (existing) await fs.writeFile(userFile, '// retained');
  const cleanupFailure = new Error('startup prefs cleanup failed');
  const installFailure = new Error('original install failure');
  const open = fs.open.bind(fs);
  jest.spyOn(fs, 'open').mockImplementation(async (file, ...args) => {
    const handle = await open(file, ...args);
    if (file === userFile) handle.truncate = async () => { throw cleanupFailure; };
    return handle;
  });
  const unlink = fs.unlink.bind(fs);
  jest.spyOn(fs, 'unlink').mockImplementation(file => file === userFile ? Promise.reject(cleanupFailure) : unlink(file));
  if (installFails) installer.install.mockRejectedValue(installFailure);
  useRealInstaller();
  await expect(launch()).rejects.toBe(installFails ? installFailure : cleanupFailure);
  if (installFails) expect(installFailure.cleanupError).toBe(cleanupFailure);
  expect(context.close).toHaveBeenCalledTimes(1);
  expect(await fs.readdir(listenerRoot)).toEqual([]);
});

test('preparation keeps its original error when restoring a partial write also fails', async () => {
  const userFile = path.join(profile, 'user.js');
  await fs.writeFile(userFile, '// retained');
  const failure = new Error('partial startup preference write failed');
  const cleanupFailure = new Error('restore failed');
  const open = fs.open.bind(fs);
  jest.spyOn(fs, 'open').mockImplementation(async (file, ...args) => {
    const handle = await open(file, ...args);
    if (file === userFile) {
      handle.writeFile = async bytes => { await handle.write(bytes.subarray(0, 17)); throw failure; };
      handle.truncate = async () => { throw cleanupFailure; };
    }
    return handle;
  });
  useRealInstaller();
  await expect(launch()).rejects.toBe(failure);
  expect(failure.cleanupError).toBe(cleanupFailure);
  expect(firefox.launchPersistentContext).not.toHaveBeenCalled();
  expect(await fs.readdir(listenerRoot)).toEqual([]);
});

test('excludes generated helpers at input, preserving default addons and launch options', async () => {
  await launch();
  expect(launchOptions.mock.calls[0][0].addons).toBeUndefined();
  expect(launchOptions.mock.calls[0][0].exclude_addons).toBeUndefined();
  expect(prepare).toHaveBeenCalledWith(['/generated/visibility'], { platform: 'darwin', profilePath: profile });
  expect(installer.install).toHaveBeenCalledWith(context);
  expect(installer.close).toHaveBeenCalledTimes(1);
  expect(firefox.launchPersistentContext.mock.calls[0][1]).toMatchObject({
    args: ['--existing', '--start-debugger-server', '/private/fixture/rdp'],
    firefoxUserPrefs: { 'existing.pref': true, 'devtools.debugger.remote-enabled': true },
  });
  expect(JSON.parse(firefox.launchPersistentContext.mock.calls[0][1].env.CAMOU_CONFIG_1).addons).toEqual(['/default/ubo']);
  expect(context.close).not.toHaveBeenCalled();
});

test('does not return a context until install and listener cleanup complete', async () => {
  let installDone, cleanupDone, returned = false;
  installer.install.mockImplementation(() => new Promise(resolve => { installDone = resolve; }));
  installer.close.mockImplementation(() => new Promise(resolve => { cleanupDone = resolve; }));
  const pending = launch().then(value => { returned = true; return value; });
  while (!installDone) await new Promise(resolve => setImmediate(resolve));
  expect(returned).toBe(false);
  installDone([]);
  while (!cleanupDone) await new Promise(resolve => setImmediate(resolve));
  expect(returned).toBe(false);
  cleanupDone();
  expect(await pending).toBe(context);
});

test('warmup and headless contexts never install runtime helpers', async () => {
  await fs.writeFile(path.join(profile, PENDING_ACTIVATION_FILE), '');
  const warmup = new EventEmitter(); warmup.close = jest.fn(async () => warmup.emit('close'));
  firefox.launchPersistentContext.mockImplementationOnce(async () => warmup);
  await launch();
  expect(firefox.launchPersistentContext).toHaveBeenCalledTimes(2);
  expect(launchOptions.mock.calls.map(([o]) => o.headless)).toEqual([true, false]);
  expect(prepare).toHaveBeenCalledTimes(1);
  expect(installer.install).toHaveBeenCalledTimes(1);
  expect(installer.install).toHaveBeenCalledWith(context);
  expect(warmup.close).toHaveBeenCalledTimes(1);
  prepare.mockClear();
  await launch({ headed: false });
  expect(prepare).not.toHaveBeenCalled();
});

test('visibility and indicator use the same once-per-context installer', async () => {
  await launch({ indicator: { alias: 'rdp-fixture-' + path.basename(profile), toolbar: '#222222', frame: '#111111' } });
  expect(prepare).toHaveBeenCalledTimes(1);
  const addons = prepare.mock.calls[0][0];
  expect(addons).toHaveLength(2);
  expect(addons[1]).toBe('/generated/visibility');
  const manifest = JSON.parse(await fs.readFile(path.join(addons[0], 'manifest.json'), 'utf8'));
  expect(manifest.browser_specific_settings.gecko.id).toBe('camofox-identity-indicator@camofox.local');
  expect(installer.install).toHaveBeenCalledTimes(1);
  expect(launchOptions.mock.calls[0][0].addons).toBeUndefined();
  await fs.rm(addons[0], { recursive: true, force: true });
});

test('disabled defaults stay excluded without disabling generated helpers', async () => {
  await launch({ config: { disableDefaultAddons: true } });
  expect(launchOptions.mock.calls[0][0].exclude_addons).toEqual(['UBO']);
  expect(installer.install).toHaveBeenCalledTimes(1);
});

test.each([false, true])('install failure closes the created context, preserving close ownership (confirmed=%s)', async confirmed => {
  const failure = new Error('addon actor refused install');
  installer.install.mockRejectedValue(failure);
  context.close.mockImplementation(async () => { if (confirmed) context.emit('close'); throw Error('close failed'); });
  await expect(launch()).rejects.toBe(failure);
  expect(context.close).toHaveBeenCalledTimes(1);
  expect(failure.profileOwnershipUnconfirmed).toBe(confirmed ? undefined : true);
  expect(failure.closeError.message).toBe('close failed');
  expect(installer.close).toHaveBeenCalledTimes(1);
});

test('launch failure cleans only installer resources and preserves the original error', async () => {
  const failure = new Error('Firefox startup failed');
  firefox.launchPersistentContext.mockRejectedValue(failure);
  installer.close.mockRejectedValue(new Error('cleanup failed'));
  await expect(launch()).rejects.toBe(failure);
  expect(failure.cleanupError.message).toBe('cleanup failed');
  expect(context.close).not.toHaveBeenCalled();
});

test('cleanup failure cannot return a usable-looking context', async () => {
  const failure = new Error('unlink failed');
  installer.close.mockRejectedValue(failure);
  await expect(launch()).rejects.toBe(failure);
  expect(context.close).toHaveBeenCalledTimes(1);
});

test('browser exit during listener cleanup cannot return a closed context', async () => {
  installer.close.mockImplementation(async () => { context.emit('close'); });
  await expect(launch()).rejects.toThrow('Browser closed');
});

test('hung context cleanup is bounded and preserves the install failure', async () => {
  const failure = new Error('install failed');
  installer.install.mockRejectedValue(failure);
  let started;
  const closing = new Promise(resolve => { started = resolve; });
  context.close.mockImplementation(() => { started(); return new Promise(() => {}); });
  const pending = launch();
  const rejected = expect(pending).rejects.toBe(failure);
  await closing;
  await rejected;
  expect(failure.profileOwnershipUnconfirmed).toBe(true);
  expect(failure.closeError.message).toContain('timed out');
  expect(installer.close).toHaveBeenCalledTimes(1);
});
