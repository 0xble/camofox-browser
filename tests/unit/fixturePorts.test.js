import { jest } from '@jest/globals';
import { EventEmitter } from 'node:events';
import net from 'node:net';

const launchServer = jest.fn(() => {
  const child = new EventEmitter();
  child.kill = () => { child.emit('close'); };
  return child;
});
jest.unstable_mockModule('../../lib/launcher.js', () => ({ launchServer }));
jest.unstable_mockModule('../../lib/config.js', () => ({
  loadConfig: () => ({ serverEnv: {} }),
}));
jest.unstable_mockModule('../helpers/test-env.js', () => ({
  DISPLAY: undefined,
  XAUTHORITY: undefined,
}));

const { startServer, stopServer, getServerPort } = await import('../helpers/startServer.js');
const nativeFetch = globalThis.fetch;
const nativeSetTimeout = globalThis.setTimeout;
const transportTrap = new Error('fixture transport reached');
let connect;

beforeEach(() => {
  // Keep the real Fetch policy but stop before any socket can connect.
  connect = jest.spyOn(net.Socket.prototype, 'connect').mockImplementation(() => {
    throw transportTrap;
  });
  jest.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
    try {
      return await nativeFetch(url);
    } catch (error) {
      if (error.cause !== transportTrap) throw error;
      return new Response('{}', { status: 200 });
    }
  });
  jest.spyOn(globalThis, 'setTimeout').mockImplementation((fn, delay, ...args) => {
    if (delay === 1000) {
      queueMicrotask(() => fn(...args));
      return;
    }
    return nativeSetTimeout(fn, delay, ...args).unref();
  });
  jest.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(async () => {
  await stopServer();
  jest.restoreAllMocks();
  launchServer.mockClear();
});

test('random fixture readiness reaches transport even for the former bad-port draw', async () => {
  // The old 3100–3999 selector maps this draw to Fetch-prohibited port 3659.
  jest.spyOn(Math, 'random').mockReturnValue(559.5 / 900);
  const port = await startServer();
  expect(port).toBe(getServerPort());
  expect(launchServer).toHaveBeenCalledWith(expect.objectContaining({ port }));
  expect(connect).toHaveBeenCalledTimes(1);
});

test('the complete random fixture pool reaches native Fetch transport', async () => {
  const random = jest.spyOn(Math, 'random');
  const ports = new Set();
  for (let draw = 0; draw < 900; draw++) {
    random.mockReturnValue((draw + 0.5) / 900);
    const port = await startServer();
    expect(Number.isInteger(port)).toBe(true);
    expect(port).toBeGreaterThanOrEqual(11000);
    expect(port).toBeLessThanOrEqual(11899);
    ports.add(port);
    await stopServer();
  }
  expect(ports.size).toBe(900);
  expect(connect).toHaveBeenCalledTimes(900);
});

test('random fixture bounds include both ends of the pool', async () => {
  const random = jest.spyOn(Math, 'random').mockReturnValue(0);
  expect(await startServer()).toBe(11000);
  await stopServer();
  random.mockReturnValue(1 - Number.EPSILON);
  expect(await startServer()).toBe(11899);
  expect(connect).toHaveBeenCalledTimes(2);
});

test('an explicit port is preserved, including native Fetch rejection', async () => {
  expect(await startServer(3175)).toBe(3175);
  await stopServer();
  connect.mockClear();
  await expect(startServer(3659)).rejects.toThrow('Server failed to start on port 3659 after 30 attempts');
  expect(getServerPort()).toBe(3659);
  expect(launchServer).toHaveBeenLastCalledWith(expect.objectContaining({ port: 3659 }));
  expect(connect).not.toHaveBeenCalled();
});
