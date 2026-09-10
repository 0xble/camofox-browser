import http from 'node:http';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { main } from '../../bin/camofox-browser.js';

const require = createRequire(import.meta.url);

function streams() {
  let stdout = '';
  let stderr = '';
  return {
    value: {
      stdout: { write: text => { stdout += text; } },
      stderr: { write: text => { stderr += text; } },
    },
    output: () => ({ stdout, stderr }),
  };
}

function config(url, key = 'test-secret') {
  return {
    CAMOFOX_SERVICE_URL: url,
    CAMOFOX_SERVICE_KEY: key,
    CAMOFOX_IDENTITY_MAP: JSON.stringify({
      personal: 'native-personal',
      lpg: 'native-lpg',
      meridian: 'native-meridian',
    }),
  };
}

function runCli(args, env) {
  return new Promise((resolve, reject) => {
    const executable = fileURLToPath(new URL('../../bin/camofox-browser.js', import.meta.url));
    const child = spawn(process.execPath, [executable, ...args], { env: { ...process.env, ...env } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', code => resolve({ code, stdout, stderr }));
  });
}

describe('camofox-browser executable', () => {
  test('zero arguments preserve server startup without importing it for identity commands', async () => {
    let startCalls = 0;
    const startServer = async () => { startCalls += 1; };
    const zero = await main([], { startServer });
    expect(zero).toBe(0);
    expect(startCalls).toBe(1);

    const io = streams();
    const help = await main(['--help'], { streams: io.value, startServer });
    expect(help).toBe(0);
    expect(io.output().stdout).toContain('identity handoff');
    expect(startCalls).toBe(1);
  });

  test('package keeps the legacy MCP executable', () => {
    const pkg = require('../../package.json');
    expect(pkg.bin).toMatchObject({
      'camofox-browser': './bin/camofox-browser.js',
      'camofox-browser-mcp': './mcp/server.mjs',
    });
  });

  test('open and focus use every configured alias without leaking the credential', async () => {
    const received = [];
    const server = http.createServer(async (req, res) => {
      let body = '';
      for await (const chunk of req) body += chunk;
      received.push({ url: req.url, authorization: req.headers.authorization, body });
      const match = req.url.match(/^\/browser\/identities\/(native-(?:personal|lpg|meridian))\/(open|focus)$/);
      res.writeHead(match ? 200 : 404, { 'content-type': 'application/json' });
      res.end(JSON.stringify(match ? { ok: true, tabId: `${match[1]}-${match[2]}` } : { error: 'not found' }));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    const env = config(`http://127.0.0.1:${port}`);

    try {
      for (const alias of ['personal', 'lpg', 'meridian']) {
        for (const action of ['open', 'focus']) {
          const io = streams();
          const code = await main(['identity', action, alias], { env, streams: io.value });
          expect(code).toBe(0);
          expect(io.output().stdout).toContain(`${alias}: ${action}ed`);
          expect(io.output().stdout).not.toContain('test-secret');
          expect(io.output().stderr).not.toContain('test-secret');
        }
      }
      expect(received).toHaveLength(6);
      expect(received.every(call => call.authorization === 'Bearer test-secret' && call.body === '{}')).toBe(true);
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  });

  test('the executable E2E calls all configured aliases without account operations', async () => {
    const received = [];
    const server = http.createServer((req, res) => {
      received.push({ url: req.url, authorization: req.headers.authorization });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, tabId: 'mock-tab' }));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    const env = config(`http://127.0.0.1:${port}`);

    try {
      for (const alias of ['personal', 'lpg', 'meridian']) {
        for (const action of ['open', 'focus']) {
          const result = await runCli(['identity', action, alias], env);
          expect(result).toMatchObject({ code: 0, stderr: '' });
          expect(result.stdout).toContain(`${alias}: ${action}ed`);
          expect(result.stdout).not.toContain('test-secret');
        }
      }
      expect(received).toHaveLength(6);
      expect(received.every(call => call.authorization === 'Bearer test-secret')).toBe(true);
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  });

  test('handoff treats a 409 as conflict and can resume agent control', async () => {
    const bodies = [];
    let attempt = 0;
    const server = http.createServer(async (req, res) => {
      let body = '';
      for await (const chunk of req) body += chunk;
      bodies.push(JSON.parse(body));
      attempt += 1;
      if (attempt === 1) {
        res.writeHead(409, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'Handoff is available only for shared identity tabs' }));
      } else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, handoff: 'agent', focused: false }));
      }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    const env = config(`http://127.0.0.1:${port}`);

    try {
      const rejected = streams();
      expect(await main(['identity', 'handoff', 'personal', 'stale-tab', 'human'], { env, streams: rejected.value })).toBe(6);
      expect(rejected.output().stderr).toContain('409');
      expect(rejected.output().stderr).not.toContain('test-secret');

      const resumed = streams();
      expect(await main(['identity', 'handoff', 'personal', 'live-tab', 'agent'], { env, streams: resumed.value })).toBe(0);
      expect(resumed.output().stdout).toContain('handed off to agent');
      expect(bodies).toEqual([
        { userId: 'native-personal', handoff: 'human' },
        { userId: 'native-personal', handoff: 'agent' },
      ]);
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  });

  test('authentication failure is secret-safe and has the auth exit category', async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid token test-secret' }));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    const io = streams();
    try {
      expect(await main(['identity', 'open', 'personal'], {
        env: config(`http://127.0.0.1:${port}`), streams: io.value,
      })).toBe(3);
      expect(io.output().stderr).toContain('401');
      expect(io.output().stdout).not.toContain('test-secret');
      expect(io.output().stderr).not.toContain('test-secret');
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  });
});
