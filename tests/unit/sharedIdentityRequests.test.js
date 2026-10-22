import { jest } from '@jest/globals';
import express from 'express';
import { EventEmitter } from 'node:events';
import { createSharedIdentityRequestTracker } from '../../lib/shared-identity-requests.js';

async function fixture() {
  const requests = new Map();
  const page = { id: 'page' };
  const session = { lastUsedPage: null };
  const sessions = new Map([['personal', session]]);
  const manager = { owns: key => key === 'personal', closings: new Set() };
  let busy = false, parked = false;
  const app = express();
  // Match server.js: evaluate bypasses the global parser, but parses in its route.
  const globalJson = express.json();
  app.use((req, res, next) => req.path.endsWith('/evaluate') ? next() : globalJson(req, res, next));
  app.use(createSharedIdentityRequestTracker({ getSessions: () => sessions, manager,
    normalizeUserId: value => value === 'alias' ? 'personal' : value,
    findTab: (_session, id) => id === 'tab-1' ? { tabState: { page } } : null,
    transitioning: () => busy, requests, parkedVisibility: key => parked && key === 'personal' }));
  app.post('/tabs/:tabId/evaluate', express.json(), (req, res) => res.json({ body: req.body, tracked: requests.get('personal') || 0 }));
  app.post('/tabs/:tabId/navigate', (req, res) => res.json({ tracked: requests.get('personal') || 0 }));
  app.post('/browser/identities/:userId/focus', (req, res) => res.status(409).json({ error: 'identity is headless; use open' }));
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const post = (url, body) => fetch(`http://127.0.0.1:${server.address().port}${url}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { requests, session, manager, page, setBusy: value => { busy = value; }, setParked: value => { parked = value; }, server, post };
}

describe('shared identity HTTP tracking and transition gate', () => {
  let f;
  beforeEach(async () => { f = await fixture(); });
  afterEach(async () => { await new Promise(resolve => f.server.close(resolve)); });

  test('normalizes aliases before gating and tracks the HTTP lifetime', async () => {
    const response = await f.post('/tabs/tab-1/navigate', { userId: 'alias' });
    expect(await response.json()).toEqual({ tracked: 1 });
    expect(f.session.lastUsedPage).toBe(f.page);
    f.setBusy(true);
    expect((await f.post('/tabs/tab-1/navigate', { userId: 'alias' })).status).toBe(409);
  });

  test('legacy focus keeps the transition gate; parked focus bypasses it', async () => {
    f.setBusy(true);
    const gated = await f.post('/browser/identities/alias/focus', {});
    expect(gated.status).toBe(409); expect(await gated.json()).toEqual({ error: 'identity busy' });
    f.setBusy(false);
    await f.post('/browser/identities/alias/focus', {});
    expect(f.requests.get('personal') || 0).toBe(0); // counted for the request lifetime, then released
    f.setBusy(true); f.setParked(true);
    const response = await f.post('/browser/identities/alias/focus', {});
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'identity is headless; use open' });
    expect(f.requests.size).toBe(0);
  });

  test('evaluate resolves tab owner without reading its unparsed body, and is gated', async () => {
    const response = await f.post('/tabs/tab-1/evaluate', { userId: 'other', expression: '1+1' });
    expect(await response.json()).toEqual({ body: { userId: 'other', expression: '1+1' }, tracked: 1 });
    f.setBusy(true);
    expect((await f.post('/tabs/tab-1/evaluate', { userId: 'other' })).status).toBe(409);
  });
});

test.each(['open', 'focus'])('parked %s is active work without a transition gate or wait', action => {
  const requests = new Map();
  const manager = { owns: key => key === 'fixture', closings: new Set() };
  const tracker = createSharedIdentityRequestTracker({ getSessions: () => new Map(), manager,
    normalizeUserId: String, findTab: () => null, transitioning: () => true, requests,
    parkedVisibility: () => true });
  const response = Object.assign(new EventEmitter(), { status: jest.fn().mockReturnThis(), json: jest.fn() });
  const next = jest.fn();
  tracker({ path: `/browser/identities/fixture/${action}` }, response, next);
  expect(next).toHaveBeenCalledTimes(1);
  expect(requests.get('fixture')).toBe(1);
  response.emit('close');
  expect(requests.size).toBe(0);
  manager.closings.add('fixture');
  tracker({ path: `/browser/identities/fixture/${action}` }, response, next);
  expect(next).toHaveBeenCalledTimes(1);
  expect(response.status).toHaveBeenCalledWith(409);
  expect(requests.size).toBe(0);
});
