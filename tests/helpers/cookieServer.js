import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { once } from 'node:events';
import { launchServer } from '../../lib/launcher.js';
import { loadConfig } from '../../lib/config.js';

// Port 3659 is in the old random 3100..3999 range but Fetch forbids it.
// Let the listener allocate a port atomically instead of probing then releasing.
export async function startCookieServer(apiKey) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'camofox-cookie-test-'));
  const env = { ...loadConfig().serverEnv, TMPDIR: directory,
    CAMOFOX_UPLOADS_DIR: path.join(directory, 'uploads'),
    CAMOFOX_PROFILE_DIR: path.join(directory, 'profiles'), CAMOFOX_TRACES_DIR: path.join(directory, 'traces'),
    CAMOFOX_COOKIES_DIR: path.join(directory, 'cookies'),
    CAMOFOX_SHARED_IDENTITY_MAP: '{}', CAMOFOX_SHARED_IDENTITY_EXTENSIONS: '{}',
    CAMOFOX_SHARED_IDENTITIES: '', FLY_MACHINE_ID: '',
    CAMOFOX_BIND_HOST: '127.0.0.1', CAMOFOX_CRASH_REPORT_ENABLED: 'false', DEBUG_RESPONSES: 'false' };
  if (apiKey === undefined) delete env.CAMOFOX_API_KEY;
  else env.CAMOFOX_API_KEY = apiKey;
  let proc, timer, output = '', lineBuffer = '', stopping;
  const stop = () => stopping ||= (async () => {
    if (proc && proc.exitCode === null && proc.signalCode === null) {
      const closed = once(proc, 'close');
      const kill = setTimeout(() => proc.kill('SIGKILL'), 5000);
      proc.kill('SIGTERM');
      try { await closed; } finally { clearTimeout(kill); }
    }
    await fs.rm(directory, { recursive: true, force: true });
  })();
  try {
    const deadline = Date.now() + 15000;
    const url = await new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(Error(`Cookie server listen deadline exceeded: ${output}`)), 15000);
      const inspect = message => {
        output = (output + message + '\n').slice(-16000);
        lineBuffer += message;
        const lines = lineBuffer.split('\n');
        lineBuffer = lines.pop();
        for (const line of lines) {
          let event;
          try { event = JSON.parse(line); } catch { continue; }
          if (event.msg === 'server started' && Number.isInteger(event.port) && event.port > 0)
            resolve(`http://127.0.0.1:${event.port}`);
        }
      };
      proc = launchServer({ pluginDir: path.resolve(import.meta.dirname, '../..'), port: 0, env,
        log: { error: message => { output = (output + message).slice(-16000); } } });
      proc.stdout.on('data', data => inspect(String(data)));
      proc.once('error', reject);
      proc.once('exit', (code, signal) => reject(Error(`Cookie server exited before listening (${code ?? signal}): ${output}`)));
    });
    clearTimeout(timer);
    const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())) });
    if (!response.ok) throw Error(`Cookie server health returned ${response.status}: ${output}`);
    await response.arrayBuffer();
    return { url, stop };
  } catch (error) {
    clearTimeout(timer);
    await stop();
    throw error;
  }
}
