import { EventEmitter } from 'node:events';
import { describe, expect, jest, test } from '@jest/globals';
import { readHidIdleSeconds } from '../../lib/macos-hid-idle.js';

function fakeSpawn({ output = '', code = 0, error = null } = {}) {
  return jest.fn(() => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    queueMicrotask(() => {
      if (output) child.stdout.emit('data', output);
      if (error) child.emit('error', error);
      else child.emit('close', code);
    });
    return child;
  });
}

describe('macOS HID idle reader', () => {
  test('parses HIDIdleTime nanoseconds into seconds', async () => {
    const spawn = fakeSpawn({ output: '"HIDIdleTime" = 2500000000 ns\n' });

    await expect(readHidIdleSeconds({ platform: 'darwin', spawn })).resolves.toBe(2.5);
    expect(spawn).toHaveBeenCalledWith('/usr/sbin/ioreg', ['-c', 'IOHIDSystem'], { stdio: ['ignore', 'pipe', 'ignore'] });
  });

  test('returns null on non-macOS without spawning a process', async () => {
    const spawn = jest.fn();

    await expect(readHidIdleSeconds({ platform: 'linux', spawn })).resolves.toBeNull();
    expect(spawn).not.toHaveBeenCalled();
  });

  test('fails closed for command errors and malformed output', async () => {
    const errorSpawn = fakeSpawn({ error: new Error('ioreg failed') });
    const malformedSpawn = fakeSpawn({ output: 'IOHIDSystem { }' });

    await expect(readHidIdleSeconds({ platform: 'darwin', spawn: errorSpawn })).resolves.toBeNull();
    await expect(readHidIdleSeconds({ platform: 'darwin', spawn: malformedSpawn })).resolves.toBeNull();
  });

  test('times out a hung ioreg, kills it, and fails closed', async () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.kill = jest.fn();
    const spawn = jest.fn(() => child);

    await expect(readHidIdleSeconds({ platform: 'darwin', spawn, timeoutMs: 20 })).resolves.toBeNull();
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  });

  (process.platform === 'darwin' ? test : test.skip)('real ioreg returns a finite idle duration without /usr/sbin on PATH', async () => {
    const originalPath = process.env.PATH;
    process.env.PATH = '/usr/bin:/bin';
    let seconds;
    try { seconds = await readHidIdleSeconds(); } finally { process.env.PATH = originalPath; }
    expect(Number.isFinite(seconds)).toBe(true);
    expect(seconds).toBeGreaterThanOrEqual(0);
  });
});
