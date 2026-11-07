import path from 'path';
import fs from 'node:fs';
import os from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { launchServer } from '../../lib/launcher.js';
import { loadConfig } from '../../lib/config.js';
import { DISPLAY, XAUTHORITY } from './test-env.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let serverProcess = null;
let serverPort = null;

async function waitForServer(port, maxRetries = 30, interval = 1000, { signal, requireBrowser = false, host = 'localhost' } = {}) {
  for (let i = 0; i < maxRetries; i++) {
    signal?.throwIfAborted();
    try {
      const response = await fetch(`http://${host}:${port}/health`, signal ? {
        signal: AbortSignal.any([signal, AbortSignal.timeout(1000)]),
      } : undefined);
      if (response.ok && (!requireBrowser || (await response.json()).browserRunning === true)) {
        signal?.throwIfAborted();
        return true;
      }
    } catch (e) {
      signal?.throwIfAborted();
      // Server not ready yet
    }
    try {
      await delay(interval, undefined, { signal });
    } catch (err) {
      signal?.throwIfAborted();
      throw err;
    }
  }
  throw new Error(`Server failed to start on port ${port} after ${maxRetries} attempts`);
}

async function startServer(port = 0, extraEnv = {}) {
  const usePort = port || Math.floor(3100 + Math.random() * 900);
  const cfg = loadConfig();
  const pluginDir = path.join(__dirname, '../..');

  const log = {
    // Always surface server warnings and errors so a failing request in CI
    // shows its cause; everything else only with DEBUG_SERVER.
    info: (msg) => { if (cfg.serverEnv.DEBUG_SERVER || /"level":"(warn|error)"/.test(msg)) console.log(msg); },
    error: (msg) => { if (cfg.serverEnv.DEBUG_SERVER || /"level":"(warn|error)"|Error/.test(msg)) console.error(msg); },
  };

  serverProcess = launchServer({
    pluginDir,
    port: usePort,
    // Forward the X display and its authority cookie. Without them, a headed
    // launch on Linux (xvfb-run in CI) only works after the browser pre-warm
    // has started its own Xvfb and mutated the server's process.env, which is
    // a startup race; DISPLAY alone fails X authorization.
    env: { ...cfg.serverEnv, TMPDIR: process.env.TMPDIR, CAMOFOX_CRASH_REPORT_ENABLED: 'false', DEBUG_RESPONSES: 'false', ...(DISPLAY ? { DISPLAY } : {}), ...(XAUTHORITY ? { XAUTHORITY } : {}), ...extraEnv },
    log,
  });

  serverProcess.on('error', (err) => {
    console.error('Failed to start server:', err);
  });

  serverPort = usePort;

  await waitForServer(usePort);

  console.log(`camofox-browser server started on port ${usePort}`);
  return usePort;
}

async function stopProcess(proc) {
  if (proc) {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(killTimer);
        resolve();
      };
      if (proc.exitCode !== null || proc.signalCode !== null) return resolve();
      proc.once('close', done);
      const killTimer = setTimeout(() => {
        if (proc.exitCode === null && proc.signalCode === null) {
          proc.kill('SIGKILL');
        }
      }, 5000);
      proc.kill('SIGTERM');
    });
  }
}

async function stopServer() {
  const proc = serverProcess;
  await stopProcess(proc);
  // Sequential suites reuse this singleton. A newer server may have replaced it.
  if (serverProcess === proc) {
    serverProcess = null;
    serverPort = null;
  }
}

async function withFreshServer(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'camofox-fresh-server-'));
  const controller = new AbortController();
  let proc;
  try {
    const cfg = loadConfig();
    const port = Math.floor(41000 + Math.random() * 9000);
    // Match globalSetup's isolation: reuse only the installed engine and display.
    proc = launchServer({
      pluginDir: path.join(__dirname, '../..'),
      port,
      env: {
        PATH: cfg.serverEnv.PATH,
        HOME: root,
        TMPDIR: root,
        CAMOUFOX_INSTALL_DIR: process.env.CAMOUFOX_INSTALL_DIR || cfg.camoufoxCacheDir,
        ...(cfg.camoufoxExecutablePath ? { CAMOUFOX_EXECUTABLE_PATH: cfg.camoufoxExecutablePath } : {}),
        CAMOFOX_PROFILE_DIR: path.join(root, 'profiles'),
        CAMOFOX_SHARED_PROFILE_DIR: path.join(root, 'shared-profiles'),
        CAMOFOX_COOKIES_DIR: path.join(root, 'cookies'),
        CAMOFOX_TRACES_DIR: path.join(root, 'traces'),
        CAMOFOX_UPLOADS_DIR: path.join(root, 'uploads'),
        CAMOFOX_BIND_HOST: '127.0.0.1',
        CAMOFOX_CRASH_REPORT_ENABLED: 'false',
        DEBUG_RESPONSES: 'false', DISPLAY, ...(XAUTHORITY ? { XAUTHORITY } : {}),
      },
      log: { info: msg => console.log(msg), error: msg => console.error(msg) },
    });
    proc.on('error', err => controller.abort(err));
    proc.once('exit', code => controller.abort(new Error(`Fresh server exited with code ${code}`)));
    await waitForServer(port, 30, 1000, {
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30000)]),
      requireBrowser: true, host: '127.0.0.1',
    });
    return await run(`http://127.0.0.1:${port}`);
  } finally {
    await stopProcess(proc);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function getServerUrl() {
  if (!serverPort) throw new Error('Server not started');
  return `http://localhost:${serverPort}`;
}

function getServerPort() {
  return serverPort;
}

export {
  startServer,
  stopServer,
  getServerUrl,
  getServerPort,
  withFreshServer
};
