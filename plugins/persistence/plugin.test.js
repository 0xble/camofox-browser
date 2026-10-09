import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { jest } from '@jest/globals';
import { createPluginEvents } from '../../lib/plugins.js';
import { getUserPersistencePaths } from '../../lib/persistence.js';
import { register } from './index.js';

describe('persistence plugin', () => {
  let tmpDir, events, ctx, mockApp;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'camofox-persist-plugin-'));
    events = createPluginEvents();
    mockApp = { delete: jest.fn() };
    ctx = {
      events,
      config: { cookiesDir: path.join(tmpDir, 'cookies') },
      log: jest.fn(),
      auth: () => (req, res, next) => next(),
      normalizeUserId: (u) => String(u),
      safeError: (err) => err.message,
      destroySession: jest.fn(async (userId, { reason } = {}) => {
        await events.emitAsync('session:destroying', { userId: String(userId), reason });
        await events.emitAsync('session:destroyed', { userId: String(userId), reason });
        return true;
      }),
    };
  });

  afterEach(async () => {
    if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test('skips registration when no profileDir configured', async () => {
    await register(mockApp, ctx, {});
    expect(ctx.log).toHaveBeenCalledWith('warn', expect.stringContaining('no profileDir'));
  });

  test('restores persisted state on session:creating', async () => {
    await register(mockApp, ctx, { profileDir: tmpDir });

    // Simulate a prior persisted state
    const { getUserPersistencePaths } = await import('../../lib/persistence.js');
    const { userDir, storageStatePath } = getUserPersistencePaths(tmpDir, 'user-1');
    await fs.mkdir(userDir, { recursive: true });
    await fs.writeFile(storageStatePath, JSON.stringify({
      cookies: [{ name: 'sid', value: 'abc', domain: '.example.com', path: '/' }],
      origins: [],
    }));

    const contextOptions = { viewport: { width: 1280, height: 720 } };
    await events.emitAsync('session:creating', { userId: 'user-1', contextOptions });

    expect(contextOptions.storageState).toBe(storageStatePath);
  });

  test('checkpoints on session:cookies:import', async () => {
    await register(mockApp, ctx, { profileDir: tmpDir });

    const mockContext = {
      storageState: jest.fn(async ({ path: p }) => {
        await fs.writeFile(p, JSON.stringify({ cookies: [{ name: 'x', value: 'y', domain: '.test.com', path: '/' }] }));
      }),
    };

    // Simulate session created then cookie import
    await events.emitAsync('session:created', { userId: 'user-2', context: mockContext });
    await events.emitAsync('session:cookies:import', { userId: 'user-2' });

    expect(mockContext.storageState).toHaveBeenCalled();

    // Verify file was written
    const { getUserPersistencePaths } = await import('../../lib/persistence.js');
    const { storageStatePath } = getUserPersistencePaths(tmpDir, 'user-2');
    const saved = JSON.parse(await fs.readFile(storageStatePath, 'utf8'));
    expect(saved.cookies[0].name).toBe('x');
  });

  test('persists the exact state supplied by session:storage:export', async () => {
    await register(mockApp, ctx, { profileDir: tmpDir, indexedDB: true });

    const storageState = {
      cookies: [],
      origins: [{
        origin: 'https://example.test',
        localStorage: [],
        indexedDB: [{ name: 'auth', version: 1, stores: [] }],
      }],
    };
    await events.emitAsync('session:storage:export', { userId: 'user-export', storageState });

    const { getUserPersistencePaths } = await import('../../lib/persistence.js');
    const { storageStatePath } = getUserPersistencePaths(tmpDir, 'user-export');
    expect(JSON.parse(await fs.readFile(storageStatePath, 'utf8'))).toEqual(storageState);
  });

  test('checkpoints on session:destroying', async () => {
    await register(mockApp, ctx, { profileDir: tmpDir });

    const mockContext = {
      storageState: jest.fn(async ({ path: p }) => {
        await fs.writeFile(p, JSON.stringify({ cookies: [], origins: [] }));
      }),
    };

    await events.emitAsync('session:created', { userId: 'user-3', context: mockContext });
    await events.emitAsync('session:destroying', { userId: 'user-3', reason: 'test' });

    expect(mockContext.storageState).toHaveBeenCalled();
  });

  test('a late checkpoint cannot remove a replacement session context', async () => {
    await register(mockApp, ctx, { profileDir: tmpDir });
    let finishOld;
    let oldStarted;
    const oldGate = new Promise(resolve => { finishOld = resolve; });
    const oldStart = new Promise(resolve => { oldStarted = resolve; });
    const oldContext = {
      storageState: jest.fn(async ({ path: targetPath }) => {
        oldStarted();
        await oldGate;
        await fs.writeFile(targetPath, JSON.stringify({ cookies: [], origins: [] }));
      }),
    };
    const replacementContext = {
      storageState: jest.fn(async ({ path: targetPath }) => {
        await fs.writeFile(targetPath, JSON.stringify({ cookies: [{ name: 'replacement' }], origins: [] }));
      }),
    };
    await events.emitAsync('session:created', { userId: 'user-replaced', context: oldContext });
    const destroying = events.emitAsync('session:destroying', { userId: 'user-replaced', reason: 'timeout' });
    await oldStarted;
    events.emit('session:created', { userId: 'user-replaced', context: replacementContext });
    finishOld();
    await destroying;

    await events.emitAsync('session:cookies:import', { userId: 'user-replaced' });
    expect(replacementContext.storageState).toHaveBeenCalled();
  });

  test('a later checkpoint proceeds after the chained wait bound', async () => {
    jest.useFakeTimers();
    try {
      await register(mockApp, ctx, { profileDir: tmpDir });
      let oldStarted;
      const oldStart = new Promise(resolve => { oldStarted = resolve; });
      const oldContext = {
        storageState: jest.fn(async () => {
          oldStarted();
          await new Promise(() => {});
        }),
      };
      let replacementStarted;
      const replacementStart = new Promise(resolve => { replacementStarted = resolve; });
      const replacementContext = {
        storageState: jest.fn(async ({ path: targetPath }) => {
          replacementStarted();
          await fs.writeFile(targetPath, JSON.stringify({ cookies: [], origins: [] }));
        }),
      };
      await events.emitAsync('session:created', { userId: 'user-chain', context: oldContext });
      const first = events.emitAsync('session:cookies:import', { userId: 'user-chain' });
      await oldStarted;
      events.emit('session:created', { userId: 'user-chain', context: replacementContext });
      const second = events.emitAsync('session:cookies:import', { userId: 'user-chain' });
      await jest.advanceTimersByTimeAsync(10_001);
      await replacementStart;
      await second;
      expect(replacementContext.storageState).toHaveBeenCalled();
      // The original checkpoint remains unresolved, but it no longer blocks the replacement.
      expect(first).toBeInstanceOf(Promise);
    } finally {
      jest.useRealTimers();
    }
  });

  test('a checkpoint that finishes after a newer one committed is discarded', async () => {
    jest.useFakeTimers();
    try {
      await register(mockApp, ctx, { profileDir: tmpDir });
      let releaseOld;
      let oldStarted;
      const oldStart = new Promise(resolve => { oldStarted = resolve; });
      const oldGate = new Promise(resolve => { releaseOld = resolve; });
      const oldContext = {
        storageState: jest.fn(async ({ path: targetPath }) => {
          oldStarted();
          await oldGate;
          await fs.writeFile(targetPath, JSON.stringify({ cookies: [{ name: 'stale' }], origins: [] }));
        }),
      };
      const newContext = {
        storageState: jest.fn(async ({ path: targetPath }) => {
          await fs.writeFile(targetPath, JSON.stringify({ cookies: [{ name: 'fresh' }], origins: [] }));
        }),
      };
      await events.emitAsync('session:created', { userId: 'user-race', context: oldContext });
      const first = events.emitAsync('session:cookies:import', { userId: 'user-race' });
      await oldStart;
      events.emit('session:created', { userId: 'user-race', context: newContext });
      const second = events.emitAsync('session:cookies:import', { userId: 'user-race' });
      await jest.advanceTimersByTimeAsync(10_001);
      await second;
      releaseOld();
      await first;

      const { storageStatePath, userDir } = getUserPersistencePaths(tmpDir, 'user-race');
      const saved = JSON.parse(await fs.readFile(storageStatePath, 'utf8'));
      expect(saved.cookies).toEqual([{ name: 'fresh' }]);
      const leftovers = (await fs.readdir(userDir)).filter(name => name.includes('.tmp-'));
      expect(leftovers).toEqual([]);
      expect(ctx.log).toHaveBeenCalledWith('warn', 'late storage checkpoint discarded; a newer checkpoint superseded it',
        expect.objectContaining({ userId: 'user-race' }));
    } finally {
      jest.useRealTimers();
    }
  });

  test('DELETE storage_state destroys the live session without checkpointing and removes persisted state', async () => {
    await register(mockApp, ctx, { profileDir: tmpDir });

    const call = mockApp.delete.mock.calls.find(c => c[0] === '/sessions/:userId/storage_state');
    expect(call).toBeTruthy();
    const handler = call.at(-1);

    const { getUserPersistencePaths } = await import('../../lib/persistence.js');
    const { userDir, storageStatePath, metaPath } = getUserPersistencePaths(tmpDir, 'user-4');
    await fs.mkdir(userDir, { recursive: true });
    await fs.writeFile(storageStatePath, JSON.stringify({
      cookies: [{ name: 'sid', value: 'a', domain: '.x.com', path: '/' }],
      origins: [{
        origin: 'https://x.com',
        localStorage: [{ name: 'token', value: 'secret' }],
        indexedDB: [{ name: 'auth', version: 1, stores: [] }],
      }],
    }));
    await fs.writeFile(metaPath, JSON.stringify({ userId: 'user-4' }));

    const mockContext = { storageState: jest.fn() };
    await events.emitAsync('session:created', { userId: 'user-4', context: mockContext });

    const res = { json: jest.fn(), status: jest.fn(function () { return this; }) };
    await handler({ params: { userId: 'user-4' } }, res);

    expect(ctx.destroySession).toHaveBeenCalledWith('user-4', { reason: 'storage_reset' });
    expect(mockContext.storageState).not.toHaveBeenCalled();
    await expect(fs.access(storageStatePath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.access(metaPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(res.json).toHaveBeenCalledWith({
      ok: true,
      userId: 'user-4',
      clearedLive: true,
      removedPersisted: true,
    });
  });

  test('DELETE storage_state waits for an in-flight checkpoint before deleting', async () => {
    await register(mockApp, ctx, { profileDir: tmpDir });
    const handler = mockApp.delete.mock.calls
      .find(c => c[0] === '/sessions/:userId/storage_state')
      .at(-1);

    let finishCheckpoint;
    let markCheckpointStarted;
    const checkpointBlocked = new Promise(resolve => { finishCheckpoint = resolve; });
    const checkpointStarted = new Promise(resolve => { markCheckpointStarted = resolve; });
    const mockContext = {
      storageState: jest.fn(async ({ path: targetPath }) => {
        markCheckpointStarted();
        await checkpointBlocked;
        await fs.writeFile(targetPath, JSON.stringify({ cookies: [], origins: [] }));
      }),
    };
    await events.emitAsync('session:created', { userId: 'user-race', context: mockContext });
    const checkpoint = events.emitAsync('session:cookies:import', { userId: 'user-race' });
    await checkpointStarted;

    const res = { json: jest.fn(), status: jest.fn(function () { return this; }) };
    const reset = handler({ params: { userId: 'user-race' } }, res);
    await Promise.resolve();
    expect(res.json).not.toHaveBeenCalled();

    finishCheckpoint();
    await Promise.all([checkpoint, reset]);

    const { getUserPersistencePaths } = await import('../../lib/persistence.js');
    const { storageStatePath } = getUserPersistencePaths(tmpDir, 'user-race');
    await expect(fs.access(storageStatePath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('DELETE storage_state is idempotent without a live session or persisted file', async () => {
    ctx.destroySession.mockResolvedValueOnce(false);
    await register(mockApp, ctx, { profileDir: tmpDir });
    const call = mockApp.delete.mock.calls.find(c => c[0] === '/sessions/:userId/storage_state');
    const handler = call.at(-1);

    const res = { json: jest.fn(), status: jest.fn(function () { return this; }) };
    await handler({ params: { userId: 'nobody' } }, res);

    expect(res.json).toHaveBeenCalledWith({
      ok: true,
      userId: 'nobody',
      clearedLive: false,
      removedPersisted: false,
    });
  });

  test('env var CAMOFOX_PROFILE_DIR overrides pluginConfig', async () => {
    const envDir = path.join(tmpDir, 'env-override');
    const orig = process.env.CAMOFOX_PROFILE_DIR;
    process.env.CAMOFOX_PROFILE_DIR = envDir;
    try {
      await register(mockApp, ctx, { profileDir: '/should/not/use' });
      expect(ctx.log).toHaveBeenCalledWith(
        'info',
        'persistence plugin enabled',
        expect.objectContaining({ profileDir: envDir })
      );
    } finally {
      if (orig === undefined) delete process.env.CAMOFOX_PROFILE_DIR;
      else process.env.CAMOFOX_PROFILE_DIR = orig;
    }
  });

  test('does not persist IndexedDB by default', async () => {
    await register(mockApp, ctx, { profileDir: tmpDir });

    const mockContext = {
      storageState: jest.fn(async ({ path: p }) => {
        await fs.writeFile(p, JSON.stringify({ cookies: [], origins: [] }));
      }),
    };
    await events.emitAsync('session:created', { userId: 'user-no-idb', context: mockContext });
    await events.emitAsync('session:destroying', { userId: 'user-no-idb', reason: 'test' });

    expect(ctx.log).toHaveBeenCalledWith(
      'info',
      'persistence plugin enabled',
      expect.objectContaining({ indexedDB: false })
    );
    expect(mockContext.storageState).toHaveBeenCalled();
    for (const [arg] of mockContext.storageState.mock.calls) {
      expect(arg.indexedDB).toBeUndefined();
    }
  });

  test('indexedDB: true opts in to IndexedDB persistence', async () => {
    await register(mockApp, ctx, { profileDir: tmpDir, indexedDB: true });

    const mockContext = {
      storageState: jest.fn(async ({ path: p }) => {
        await fs.writeFile(p, JSON.stringify({ cookies: [], origins: [] }));
      }),
    };
    await events.emitAsync('session:created', { userId: 'user-idb', context: mockContext });
    await events.emitAsync('session:destroying', { userId: 'user-idb', reason: 'test' });

    expect(ctx.log).toHaveBeenCalledWith(
      'info',
      'persistence plugin enabled',
      expect.objectContaining({ indexedDB: true })
    );
    expect(mockContext.storageState).toHaveBeenCalledWith(
      expect.objectContaining({ indexedDB: true })
    );
  });
});
