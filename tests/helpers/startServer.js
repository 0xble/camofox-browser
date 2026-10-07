import path from 'path';
import { fileURLToPath } from 'node:url';
import { launchServer } from '../../lib/launcher.js';
import { loadConfig } from '../../lib/config.js';
import { DISPLAY, XAUTHORITY } from './test-env.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let serverProcess = null;
let serverPort = null;

async function waitForServer(port, maxRetries = 30, interval = 1000) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const response = await fetch(`http://localhost:${port}/health`);
      if (response.ok) {
        return true;
      }
    } catch (e) {
      // Server not ready yet
    }
    await new Promise(r => setTimeout(r, interval));
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
    env: { ...cfg.serverEnv, DEBUG_RESPONSES: 'false', ...(DISPLAY ? { DISPLAY } : {}), ...(XAUTHORITY ? { XAUTHORITY } : {}), ...extraEnv },
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

async function stopServer() {
  if (serverProcess) {
    return new Promise((resolve) => {
      serverProcess.on('close', () => {
        serverProcess = null;
        serverPort = null;
        resolve();
      });

      serverProcess.kill('SIGTERM');

      setTimeout(() => {
        if (serverProcess) {
          serverProcess.kill('SIGKILL');
        }
      }, 5000);
    });
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
  getServerPort
};
