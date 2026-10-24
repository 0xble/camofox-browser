import { jest } from '@jest/globals';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import express from 'express';
import { accessKeyMiddleware } from '../../lib/auth.js';
import { resolveUploadPaths } from '../../lib/upload-paths.js';
import { createSharedIdentityRequestTracker } from '../../lib/shared-identity-requests.js';

const source = await fs.readFile(new URL('../../server.js', import.meta.url), 'utf8');
const inlineFile = (name = 'résumé.txt', bytes = Buffer.from([0, 255, 42, 10])) => ({
  name, mimeType: 'application/octet-stream', dataBase64: bytes.toString('base64'),
});
let uploadsDir;
beforeAll(async () => { uploadsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'camofox-upload-route-')); });
afterAll(async () => { await fs.rm(uploadsDir, { recursive: true, force: true }); });

async function fixture({ mode = 'direct', busy = false, attachError } = {}) {
  const app = express();
  const attachments = [];
  const logs = [];
  const events = [];
  const requests = new Map();
  let activated = false;
  const setFiles = async files => {
    attachments.push(files);
    if (attachError) throw attachError;
  };
  const input = {
    first() { return this; },
    count: async () => mode === 'direct' || (activated && mode === 'panel') ? 1 : 0,
    setInputFiles: jest.fn(setFiles),
  };
  const trigger = { focus: async () => {}, click: async () => { activated = true; } };
  const chooser = { setFiles: jest.fn(setFiles) };
  const page = {
    locator: selector => selector === 'input[type="file"]' ? input : trigger,
    keyboard: { press: async () => { activated = true; } },
    waitForEvent: async () => chooser,
    waitForTimeout: async () => {},
  };
  const tabState = { page, refs: new Map(), toolCalls: 0, consecutiveFailures: 0 };
  const session = { tabState };
  const sessions = new Map([['owner', session]]);
  const findTab = (s, id) => s === session && id === 'tab' ? { tabState } : null;
  const dependencies = {
    app, express, Buffer, resolveUploadPaths, CONFIG: { uploadsDir }, sessions, findTab,
    normalizeUserId: String, log: (...args) => logs.push(args),
    pluginEvents: { emit: (...args) => events.push(args) },
    withUserLimit: jest.fn(async (_user, fn) => fn()),
    withTabLock: jest.fn(async (_tab, fn) => fn()),
    refToLocator: () => trigger, refreshTabRefs: async () => new Map([['e1', {}]]),
    tabNotFoundResponse: res => res.status(404).json({ error: 'Tab not found' }),
    handleRouteError: (err, _req, res) => res.status(err.statusCode || 500).json({ error: err.message, code: err.code }),
    StaleRefsError: Error,
    Date: { now: (() => { let now = 0; return () => ++now; })() },
  };
  try { Object.assign(dependencies, await import('../../lib/upload-files.js')); }
  catch (err) { if (err.code !== 'MODULE_NOT_FOUND' && err.code !== 'ERR_MODULE_NOT_FOUND') throw err; }
  const context = vm.createContext(dependencies);
  const parserStart = source.indexOf('const globalJsonParser');
  vm.runInContext(source.slice(parserStart, source.indexOf('\n// Request logging', parserStart)), context);
  app.use(accessKeyMiddleware({ accessKey: 'test-only-access-key' }));
  app.use(createSharedIdentityRequestTracker({
    getSessions: () => sessions, manager: { owns: id => id === 'owner', closings: new Map() },
    normalizeUserId: String, findTab, transitioning: () => busy, requests,
  }));
  const start = source.indexOf('const UPLOAD_UI_TIMEOUT_MS');
  vm.runInContext(source.slice(start, source.indexOf('\n// Type', start)), context);
  app.post('/unrelated', (_req, res) => res.json({ ok: true }));
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.type }));
  const server = await new Promise(resolve => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  const url = `http://127.0.0.1:${server.address().port}`;
  const request = async (body, { route = '/tabs/tab/upload', auth = true, rawBody } = {}) => {
    const response = await fetch(url + route, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: 'Bearer test-only-access-key' } : {}) },
      body: rawBody ?? JSON.stringify({ userId: 'owner', ...body }),
    });
    return { status: response.status, body: await response.json() };
  };
  return {
    request, attachments, logs, events, requests, input, chooser, dependencies,
    close: () => new Promise(resolve => server.close(resolve)),
  };
}

test('real HTTP upload accepts inline bytes and returns filenames', async () => {
  const f = await fixture();
  try {
    const file = inlineFile();
    const result = await f.request({ files: [file] });
    expect(result).toEqual({ status: 200, body: { ok: true, attached: [file.name], via: 'direct_input', refsAvailable: true } });
    expect(f.attachments).toHaveLength(1);
    expect(f.attachments[0][0]).toEqual({ name: file.name, mimeType: file.mimeType, buffer: Buffer.from(file.dataBase64, 'base64') });
    expect(f.events).toEqual([['tab:upload', { userId: 'owner', tabId: 'tab', files: [{ name: file.name, size: 4, mimeType: file.mimeType }] }]]);
    const recorded = JSON.stringify([f.events, f.logs]);
    expect(recorded).not.toContain(file.dataBase64);
    expect(recorded).not.toContain('buffer');
    expect(recorded).not.toContain(uploadsDir);
    expect(f.dependencies.withUserLimit).toHaveBeenCalledTimes(1);
    expect(f.dependencies.withTabLock).toHaveBeenCalledTimes(1);
  } finally { await f.close(); }
});

test.each(['panel', 'chooser'])('one attachment through %s receives the same payload array', async mode => {
  const f = await fixture({ mode });
  try {
    const files = [inlineFile('empty.txt', Buffer.alloc(0)), inlineFile('東京.bin')];
    const result = await f.request({ files, selector: 'iframe >> button', timeout: 1 });
    expect(result).toMatchObject({ status: 200, body: { attached: files.map(file => file.name), via: mode === 'panel' ? 'panel_input' : 'filechooser' } });
    expect(f.attachments).toHaveLength(1);
    expect(f.attachments[0].map(file => file.buffer)).toEqual(files.map(file => Buffer.from(file.dataBase64, 'base64')));
    expect(f.input.setInputFiles.mock.calls.length + f.chooser.setFiles.mock.calls.length).toBe(1);
  } finally { await f.close(); }
});

test('route-specific parser accepts more than 100kb without widening other routes', async () => {
  const f = await fixture();
  try {
    const files = [inlineFile('large.bin', Buffer.alloc(160 * 1024, 0xff))];
    expect((await f.request({ files })).status).toBe(200);
    expect(f.attachments[0][0].buffer).toEqual(Buffer.alloc(160 * 1024, 0xff));
    expect((await f.request({ files }, { route: '/unrelated' })).status).toBe(413);
    expect((await f.request({ files }, { auth: false })).status).toBe(401);
  } finally { await f.close(); }
});

test('malformed upload JSON is sanitized, with authentication before parsing', async () => {
  const f = await fixture();
  try {
    const rawBody = '{"files":[{"dataBase64":"cHJpdmF0ZS1ieXRlcw=="}';
    expect(await f.request({}, { rawBody })).toEqual({ status: 400, body: { error: 'Invalid upload JSON' } });
    expect((await f.request({}, { rawBody, auth: false })).status).toBe(401);
    expect(JSON.stringify(f.logs)).not.toContain('cHJpdmF0ZS1ieXRlcw==');
    expect(f.attachments).toHaveLength(0);
  } finally { await f.close(); }
});

test('legacy path string/array, response and event remain unchanged, including files above the inline cap', async () => {
  const file = path.join(uploadsDir, 'legacy.bin');
  await fs.writeFile(file, Buffer.alloc(20 * 1024 * 1024 + 1));
  const canonical = await fs.realpath(file);
  for (const value of [file, [file]]) {
    const f = await fixture();
    try {
      expect(await f.request({ path: value })).toMatchObject({ status: 200, body: { attached: [canonical], via: 'direct_input' } });
      expect(f.attachments).toEqual([[canonical]]);
      expect(f.events).toEqual([['tab:upload', { userId: 'owner', tabId: 'tab', paths: [canonical] }]]);
    } finally { await f.close(); }
  }
});

test.each([
  {}, { files: [] }, { files: null }, { files: 'bad' },
  { files: [inlineFile()], path: '/not-used' },
  ...['', '.', '..', '../a', 'a/b', 'a\\b', 'bad\nname', 'bad\u007fname'].map(name => ({ files: [inlineFile(name)] })),
  ...['Zg', 'Zg=', 'Zh==', 'Zm9=', ' Zg==', 'Zg==\n', 'Zg-_', 'a===', '====', 'data:text/plain;base64,Zg=='].map(dataBase64 => ({ files: [{ ...inlineFile(), dataBase64 }] })),
  { files: [null] }, { files: [{}] }, { files: [{ ...inlineFile(), mimeType: 1 }] },
])('invalid request returns 400 without attaching: %j', async body => {
  const f = await fixture();
  try {
    expect((await f.request(body)).status).toBe(400);
    expect(f.attachments).toHaveLength(0);
  } finally { await f.close(); }
});

test('aggregate decoded limit accepts exactly 20MiB and rejects one extra byte', async () => {
  const f = await fixture();
  try {
    const half = Buffer.alloc(10 * 1024 * 1024, 0x7f);
    const files = [inlineFile('a', half), inlineFile('b', half)];
    expect((await f.request({ files })).status).toBe(200);
    expect(f.attachments[0].reduce((sum, file) => sum + file.buffer.length, 0)).toBe(20 * 1024 * 1024);
    files.push(inlineFile('extra', Buffer.from([1])));
    expect((await f.request({ files })).status).toBe(413);
    expect(f.attachments).toHaveLength(1);
    expect((await f.request({ files: [inlineFile('too-large', Buffer.alloc(22 * 1024 * 1024))] })).status).toBe(413);
  } finally { await f.close(); }
});

test('tab ownership and shared-identity busy refusal precede route-local parsing', async () => {
  const f = await fixture({ busy: true });
  try {
    const result = await f.request({ userId: 'other', files: [inlineFile('large', Buffer.alloc(160 * 1024))] });
    expect(result.status).toBe(409);
    expect(f.attachments).toHaveLength(0);
  } finally { await f.close(); }
  const available = await fixture();
  try {
    expect((await available.request({ userId: 'other', files: [inlineFile()] })).status).toBe(404);
    expect((await available.request({ files: [inlineFile()] }, { route: '/tabs/unknown/upload' })).status).toBe(404);
    expect(available.attachments).toHaveLength(0);
  } finally { await available.close(); }
});

test('inline named trigger cannot be hijacked by an existing top-level input', async () => {
  const f = await fixture();
  try {
    expect((await f.request({ files: [inlineFile()], selector: 'iframe >> button' })).status).toBe(400);
    expect(f.attachments).toHaveLength(0);
  } finally { await f.close(); }
});

test.each(['direct', 'panel', 'chooser'])('ambiguous inline %s failure is not retried through another strategy', async mode => {
  const f = await fixture({ mode, attachError: Object.assign(new Error('Operation timed out'), { statusCode: 504 }) });
  try {
    expect((await f.request({ files: [inlineFile()], ...(mode === 'direct' ? {} : { selector: '#trigger' }) })).status).toBe(504);
    expect(f.attachments).toHaveLength(1);
    expect(f.input.setInputFiles.mock.calls.length + f.chooser.setFiles.mock.calls.length).toBe(1);
    expect(f.events).toHaveLength(0);
  } finally { await f.close(); }
});
