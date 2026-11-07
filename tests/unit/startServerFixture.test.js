import { jest } from '@jest/globals';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';

const config = {
  serverEnv: {
    PATH: '/test/bin', HOME: '/host/home', CAMOFOX_API_KEY: 'test-only-key',
    CAMOFOX_SHARED_IDENTITY_MAP: 'test-only-identity', CAMOFOX_PROFILE_DIR: '/host/profiles',
    PROXY_HOST: 'test-only-proxy', FLY_MACHINE_ID: 'test-only-machine',
  },
  camoufoxCacheDir: '/installed/engine',
  camoufoxExecutablePath: '/installed/engine/camoufox',
};
const launchServer = jest.fn();
jest.unstable_mockModule('../../lib/launcher.js', () => ({ launchServer }));
jest.unstable_mockModule('../../lib/config.js', () => ({ loadConfig: () => config }));
jest.unstable_mockModule('../helpers/test-env.js', () => ({ DISPLAY: ':test', XAUTHORITY: '/test/xauthority' }));
const helper = await import('../helpers/startServer.js');

let fetchMock;
let processes;
beforeEach(() => {
  processes = [];
  launchServer.mockReset().mockImplementation(options => {
    const proc = new EventEmitter();
    proc.exitCode = null;
    proc.signalCode = null;
    proc.kill = jest.fn(signal => {
      proc.signalCode = signal;
      queueMicrotask(() => proc.emit('close', null, signal));
      return true;
    });
    processes.push({ proc, options });
    return proc;
  });
  fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValue({
    ok: true, json: async () => ({ browserRunning: true }),
  });
});
afterEach(() => fetchMock.mockRestore());

test('fresh fixture whitelists engine/display inputs and owns all writable roots', async () => {
  let root;
  const result = await helper.withFreshServer(async url => {
    const { options } = processes[0];
    root = options.env.HOME;
    expect(url).toBe(`http://127.0.0.1:${options.port}`);
    expect(options.port).toBeGreaterThanOrEqual(41000);
    expect(options.env).toEqual({
      PATH: '/test/bin', HOME: root, TMPDIR: root,
      CAMOUFOX_INSTALL_DIR: process.env.CAMOUFOX_INSTALL_DIR || '/installed/engine',
      CAMOUFOX_EXECUTABLE_PATH: '/installed/engine/camoufox',
      CAMOFOX_PROFILE_DIR: path.join(root, 'profiles'),
      CAMOFOX_SHARED_PROFILE_DIR: path.join(root, 'shared-profiles'),
      CAMOFOX_COOKIES_DIR: path.join(root, 'cookies'),
      CAMOFOX_TRACES_DIR: path.join(root, 'traces'),
      CAMOFOX_UPLOADS_DIR: path.join(root, 'uploads'),
      CAMOFOX_BIND_HOST: '127.0.0.1', CAMOFOX_CRASH_REPORT_ENABLED: 'false',
      DEBUG_RESPONSES: 'false', DISPLAY: ':test', XAUTHORITY: '/test/xauthority',
    });
    expect(root).not.toBe('/host/home');
    expect(fs.existsSync(root)).toBe(true);
    fs.writeFileSync(path.join(root, 'fixture-data'), 'disposable');
    return 'result';
  });
  expect(result).toBe('result');
  expect(processes[0].proc.kill).toHaveBeenCalledWith('SIGTERM');
  expect(fs.existsSync(root)).toBe(false);
});

test('waits for a successful browser launch, not just an HTTP 200 health response', async () => {
  fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ browserRunning: false }) });
  await helper.withFreshServer(async () => {
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

test('cleans owned process and scratch when the assertion callback fails', async () => {
  const failure = new Error('assertion failed');
  await expect(helper.withFreshServer(async () => { throw failure; })).rejects.toBe(failure);
  expect(processes[0].proc.kill).toHaveBeenCalledWith('SIGTERM');
  expect(fs.existsSync(processes[0].options.env.HOME)).toBe(false);
});

test('waits for owned process closure before removing scratch, escalating a stuck shutdown', async () => {
  let root;
  await helper.withFreshServer(async () => {
    const { proc, options } = processes[0];
    root = options.env.HOME;
    proc.kill.mockImplementation(signal => {
      expect(fs.existsSync(root)).toBe(true);
      if (signal === 'SIGKILL') {
        proc.signalCode = signal;
        queueMicrotask(() => proc.emit('close', null, signal));
      }
      return true;
    });
  });
  expect(processes[0].proc.kill.mock.calls).toEqual([['SIGTERM'], ['SIGKILL']]);
  expect(fs.existsSync(root)).toBe(false);
});

test('removes scratch after an owned process that already exited', async () => {
  await helper.withFreshServer(async () => {
    processes[0].proc.exitCode = 0;
  });
  expect(processes[0].proc.kill).not.toHaveBeenCalled();
  expect(fs.existsSync(processes[0].options.env.HOME)).toBe(false);
});

test.each(['error', 'exit'])('cleans up and skips requests when startup emits %s', async event => {
  const launch = launchServer.getMockImplementation();
  launchServer.mockImplementation(options => {
    const proc = launch(options);
    queueMicrotask(() => proc.emit(event, event === 'error' ? new Error('startup failed') : 1));
    return proc;
  });
  fetchMock.mockImplementation(async (_url, { signal }) => {
    await Promise.resolve();
    signal.throwIfAborted();
    throw new Error('not ready');
  });
  const request = jest.fn();
  await expect(helper.withFreshServer(request)).rejects.toThrow(/startup failed|exited/);
  expect(request).not.toHaveBeenCalled();
  expect(processes[0].proc.kill).toHaveBeenCalledWith('SIGTERM');
  expect(fs.existsSync(processes[0].options.env.HOME)).toBe(false);
});

test('removes scratch when the launch owner throws synchronously', async () => {
  let root;
  launchServer.mockImplementation(options => {
    root = options.env.HOME;
    throw new Error('launch failed');
  });
  await expect(helper.withFreshServer(jest.fn())).rejects.toThrow('launch failed');
  expect(fs.existsSync(root)).toBe(false);
});

test('keeps the legacy singleton and its extra environment separate', async () => {
  await helper.startServer(3950, { MAX_TABS_GLOBAL: '5' });
  const singleton = processes[0].proc;
  try {
    await helper.withFreshServer(async () => {
      expect(helper.getServerUrl()).toBe('http://localhost:3950');
      expect(singleton.kill).not.toHaveBeenCalled();
      expect(processes[0].options.env.MAX_TABS_GLOBAL).toBe('5');
      expect(processes[1].options.env.MAX_TABS_GLOBAL).toBeUndefined();
    });
    expect(helper.getServerPort()).toBe(3950);
    expect(singleton.kill).not.toHaveBeenCalled();
  } finally {
    await helper.stopServer();
  }
  expect(helper.getServerPort()).toBeNull();
});
