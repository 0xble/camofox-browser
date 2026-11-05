import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from '@jest/globals';
import { createServer } from 'node:http';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import express from 'express';
import { Camoufox } from 'camoufox-js';
import { createEvaluateOperation } from '../../lib/evaluate-operation.js';
import { createPaymentFrames } from '../../lib/payment-frames.js';
import { trackContextTracing } from '../../lib/context-tracing.js';

const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
const close = server => new Promise(resolve => server.close(resolve));

describe('payment-frame evaluate transport (synthetic cross-origin Camoufox fixtures)', () => {
  let processor, merchant, browser, context, page, other, merchantOrigin, processorOrigin, api, apiOrigin;
  let events, operation;
  const tabs = new Map();
  const captured = [];
  const logs = [];

  beforeAll(async () => {
    processor = createServer((req, res) => {
      res.setHeader('Content-Type', 'text/html');
      res.end(`<input autocomplete="cc-number" id="card"><script>window.fixture = true</script>`);
    });
    processorOrigin = await listen(processor);
    merchant = createServer((req, res) => {
      res.setHeader('Content-Type', 'text/html');
      if (req.url === '/nested') return res.end(`<iframe src="${processorOrigin}/field"></iframe>`);
      res.end(`<input id="merchant"><iframe id="direct" src="${processorOrigin}/field"></iframe><iframe id="nested" src="/nested"></iframe><iframe id="unapproved" src="http://localhost:${processor.address().port}/field"></iframe><iframe sandbox="allow-scripts" src="${processorOrigin}/field"></iframe>`);
    });
    merchantOrigin = await listen(merchant);
    events = new EventEmitter();
    events.on('tab:evaluate', payload => captured.push(payload));
    events.on('tab:evaluated', payload => captured.push(payload));
    operation = createEvaluateOperation({ events, paymentFrames: createPaymentFrames({ allowedOrigins: [processorOrigin] }) });
    const app = express();
    app.use(express.json());
    const source = readFileSync(new URL('../../server.js', import.meta.url), 'utf8');
    const start = source.indexOf("app.post('/tabs/:tabId/evaluate'");
    const end = source.indexOf('\n});', start) + 5;
    vm.runInNewContext(source.slice(start, end), {
      app, express, CONFIG: { evaluateMaxBodySize: '1mb' },
      sessions: new Map([['fixture-owner', {}]]), normalizeUserId: String,
      findTab: (_session, id) => tabs.has(id) ? { tabState: { page: tabs.get(id), toolCalls: 0 } } : null,
      tabNotFoundResponse: res => res.status(404).json({ error: 'Tab not found' }),
      withUserLimit: (_id, work) => work(), withTabLock: (_id, work) => work(),
      requestTimeoutMs: () => 30000, evaluateOperation: operation,
      log: (_level, _event, payload) => logs.push(payload),
      handleRouteError: (_err, _req, res) => res.status(500).json({ error: 'evaluation failed' }),
    });
    api = createServer(app);
    apiOrigin = await listen(api);
    browser = await Camoufox({ headless: true });
  }, 120000);

  afterAll(async () => {
    await browser?.close();
    await Promise.all([api, merchant, processor].filter(Boolean).map(close));
  });
  beforeEach(async () => {
    captured.length = 0;
    logs.length = 0;
    context = await browser.newContext();
    trackContextTracing(context);
    page = await context.newPage();
    tabs.set('one', page);
    await page.goto(merchantOrigin);
    await page.frames().find(frame => frame.url() === `${processorOrigin}/field`).waitForSelector('#card');
  });
  afterEach(async () => { tabs.clear(); await context?.close(); });

  async function request(body, tab = 'one') {
    const response = await fetch(`${apiOrigin}/tabs/${tab}/evaluate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: 'fixture-owner', ...body }),
    });
    return { status: response.status, ...await response.json() };
  }
  async function discover() {
    const reply = await request({ paymentOperation: 'discover', merchantOrigin });
    expect(reply.status).toBe(200);
    return reply.result;
  }
  const evaluate = (binding, extra = {}, tab) => request({
    paymentOperation: 'evaluate', frameId: binding.frame_id, merchantOrigin,
    frameOrigin: binding.origin, expression: 'document.querySelector("#card").value', ...extra,
  }, tab);

  test('only direct allowlisted non-opaque children; read/write without merchant pollution or plugin leaks', async () => {
    const found = await discover();
    expect(found).toHaveLength(1);
    expect(found[0].origin).toBe(processorOrigin);
    const write = await evaluate(found[0], { expression: 'document.querySelector("#card").value = "synthetic-vault-fixture"', secret: true });
    expect(write).toMatchObject({ status: 200, ok: true, result: 'synthetic-vault-fixture' });
    expect((await evaluate(found[0])).result).toBe('synthetic-vault-fixture');
    expect(await page.locator('#merchant').inputValue()).toBe('');
    expect(captured).toEqual([]);
  });

  test('unmodified production allowlist rejects localhost even if request invents an allowlist', async () => {
    const production = createEvaluateOperation({ events });
    const found = await production(page, { paymentOperation: 'discover', merchantOrigin, allowedOrigins: [processorOrigin] }, {});
    expect(found).toEqual([]);
  });

  test('traced contexts refuse frame and secret page calls; saved trace has no dummy secret', async () => {
    const [binding] = await discover();
    const directory = mkdtempSync(join(tmpdir(), 'camofox-frame-trace-'));
    const path = join(directory, 'fixture.zip');
    try {
      await context.tracing.start({ screenshots: true, snapshots: true, sources: false });
      const expression = 'document.querySelector("input").value = "dummy-secret-must-not-be-traced"';
      expect((await evaluate(binding, { expression, secret: true })).status).toBe(409);
      expect((await request({ expression, secret: true })).status).toBe(409);
      // Ordinary evaluation remains available; trace redaction is not claimed.
      expect((await request({ expression: '2 + 3' })).result).toBe(5);
      await context.tracing.stop({ path });
      const trace = execFileSync('unzip', ['-p', path, '*.trace'], { maxBuffer: 20 * 1024 * 1024 }).toString();
      expect(trace).not.toContain('dummy-secret-must-not-be-traced');
      expect(await page.locator('#merchant').inputValue()).toBe('');
      expect((await evaluate(binding)).result).toBe('');
      // A protected call can leave values in the DOM or await an async result;
      // subsequent tracing starts must also be blocked for that context.
      await expect(context.tracing.start({ snapshots: true })).rejects.toThrow('protected context');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('cross-tab and unknown binding are rejected', async () => {
    const [binding] = await discover();
    other = await context.newPage();
    tabs.set('two', other);
    await other.goto(merchantOrigin);
    expect((await evaluate(binding, {}, 'two')).status).toBe(409);
    expect((await evaluate({ ...binding, frame_id: 'invented' })).status).toBe(409);
  });

  test('exact merchant/frame origin mismatch and malformed operation never run page JS', async () => {
    const [binding] = await discover();
    for (const extra of [{ merchantOrigin: `${merchantOrigin}/` }, { merchantOrigin: processorOrigin }, { frameOrigin: merchantOrigin }, { paymentOperation: 'evalute' }]) {
      expect((await evaluate(binding, { expression: 'window.unsafeWrite = true', ...extra })).status).toBe(409);
    }
    expect(await page.evaluate(() => window.unsafeWrite)).toBeUndefined();
    expect((await request({ frameId: binding.frame_id, expression: 'window.unsafeWrite = true' })).status).toBe(409);
  });

  test('same-URL frame reload invalidates document binding', async () => {
    const [binding] = await discover();
    const frame = page.frames().find(f => f.url() === `${processorOrigin}/field`);
    await frame.goto(`${processorOrigin}/field`);
    expect((await evaluate(binding, { expression: 'window.unsafeWrite = true' })).status).toBe(409);
    expect(await frame.evaluate(() => window.unsafeWrite)).toBeUndefined();
  });

  test('merchant same-URL reload invalidates binding', async () => {
    const [binding] = await discover();
    await page.reload();
    expect((await evaluate(binding)).status).toBe(409);
  });

  test('detached/replaced frames and rediscovered IDs fail closed', async () => {
    const [binding] = await discover();
    await page.locator('#direct').evaluate(el => el.remove());
    expect((await evaluate(binding)).status).toBe(409);
    await page.reload();
    const [fresh] = await discover();
    await discover();
    expect((await evaluate(fresh)).status).toBe(409);
  });

  test('frame navigation to unapproved merchant origin invalidates binding', async () => {
    const [binding] = await discover();
    await page.frames().find(f => f.url() === `${processorOrigin}/field`).goto(`${merchantOrigin}/nested`);
    expect((await evaluate(binding)).status).toBe(409);
  });

  test('exception text and result cannot leak to plugin observers', async () => {
    const [binding] = await discover();
    const reply = await evaluate(binding, { expression: 'throw new Error("synthetic-secret")', secret: true });
    expect(reply.status).toBe(409);
    expect(JSON.stringify(reply)).not.toContain('synthetic-secret');
    expect(JSON.stringify(logs)).not.toContain('synthetic-secret');
    expect(captured).toEqual([]);
  });

  test('ordinary page evaluations retain their events; secret page evaluations suppress them', async () => {
    expect((await request({ expression: 'document.title' })).ok).toBe(true);
    expect(captured).toHaveLength(2);
    captured.length = 0;
    expect((await request({ expression: '"synthetic-secret"', secret: true })).ok).toBe(true);
    expect(captured).toEqual([]);
  });
});
