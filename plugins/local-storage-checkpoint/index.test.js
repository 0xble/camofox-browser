import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const sourceDir = path.dirname(fileURLToPath(import.meta.url));
const packageDir = process.env.CAMOFOX_PACKAGE_DIR;
if (!packageDir) throw new Error('CAMOFOX_PACKAGE_DIR is required');

async function installFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'camofox-checkpoint-test-'));
  const pluginDir = path.join(root, 'plugins', 'local-storage-checkpoint');
  await fs.mkdir(pluginDir, { recursive: true });
  await fs.mkdir(path.join(root, 'lib'), { recursive: true });
  await fs.copyFile(path.join(sourceDir, 'index.js'), path.join(pluginDir, 'index.js'));
  await fs.copyFile(path.join(packageDir, 'lib', 'persistence.js'), path.join(root, 'lib', 'persistence.js'));
  return { root, register: (await import(`${pathToFileURL(path.join(pluginDir, 'index.js')).href}?${Date.now()}-${Math.random()}`)).default };
}

async function request(server, route, authorization) {
  const { port } = server.address();
  const response = await fetch(`http://127.0.0.1:${port}${route}`, {
    headers: authorization ? { authorization } : {},
  });
  return { status: response.status, body: await response.json() };
}

async function withRoute({ profileDir, authorized = true }, callback) {
  const { root, register } = await installFixture();
  const packageRequire = createRequire(path.join(packageDir, 'package.json'));
  const express = packageRequire('express');
  const app = express();
  const logs = [];
  const calls = [];
  const state = { cookies: [{ name: 'test', value: 'not-a-secret', domain: 'example.test', path: '/' }], origins: [] };
  const ctx = {
    sessions: new Map([['synthetic-user', { context: { storageState: async (options) => { calls.push(options); return state; } } }]]),
    config: { profileDir },
    auth: () => (req, res, next) => authorized && req.headers.authorization === 'Bearer test-token'
      ? next()
      : res.status(401).json({ error: 'Unauthorized' }),
    log: (level, message, fields = {}) => logs.push({ level, message, fields }),
  };
  register(app, ctx);
  // Simulate persistence registering after this plugin; the route must read
  // its storage-state option when called rather than capture startup ordering.
  ctx.persistenceStorageStateOptions = { indexedDB: true };
  const server = http.createServer(app);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    await callback({ server, calls, state, logs });
  } finally {
    await new Promise(resolve => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  }
}

test('GET checkpoint exports the active context and confirms its persisted snapshot', async () => {
  const profileDir = await fs.mkdtemp(path.join(os.tmpdir(), 'camofox-checkpoint-profile-'));
  try {
    await withRoute({ profileDir }, async ({ server, calls, state }) => {
      const response = await request(server, '/sessions/synthetic-user/storage_state', 'Bearer test-token');
      assert.equal(response.status, 200);
      assert.deepEqual(response.body, state);
      assert.deepEqual(calls, [{ indexedDB: true }]);
      const entries = await fs.readdir(profileDir);
      assert.equal(entries.length, 1);
      const persisted = JSON.parse(await fs.readFile(path.join(profileDir, entries[0], 'storage-state.json'), 'utf8'));
      assert.deepEqual(persisted, state);
    });
  } finally {
    await fs.rm(profileDir, { recursive: true, force: true });
  }
});

test('GET checkpoint fails closed when the persistence write cannot succeed', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'camofox-checkpoint-blocked-'));
  const profileDir = path.join(root, 'not-a-directory');
  await fs.writeFile(profileDir, 'blocked');
  try {
    await withRoute({ profileDir }, async ({ server }) => {
      const response = await request(server, '/sessions/synthetic-user/storage_state', 'Bearer test-token');
      assert.equal(response.status, 500);
      assert.deepEqual(response.body, { error: 'storage state checkpoint failed' });
    });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('GET checkpoint rejects an unauthorized request before exporting storage', async () => {
  const profileDir = await fs.mkdtemp(path.join(os.tmpdir(), 'camofox-checkpoint-profile-'));
  try {
    await withRoute({ profileDir }, async ({ server, calls }) => {
      const response = await request(server, '/sessions/synthetic-user/storage_state');
      assert.equal(response.status, 401);
      assert.deepEqual(response.body, { error: 'Unauthorized' });
      assert.deepEqual(calls, []);
    });
  } finally {
    await fs.rm(profileDir, { recursive: true, force: true });
  }
});
