import { spawn as nodeSpawn } from 'node:child_process';

// launchd services often omit /usr/sbin from PATH; resolve the system binary directly.
const IOREG_PATH = '/usr/sbin/ioreg';
const HID_IDLE_TIME_PATTERN = /"HIDIdleTime"\s*=\s*(\d+)(?:\s*ns)?\b/;

/**
 * Read macOS global input idle time. A missing/failed native reading is
 * deliberately represented as null so callers can fail closed.
 */
export function readHidIdleSeconds({ platform = process.platform, spawn = nodeSpawn, timeoutMs = 5000 } = {}) {
  if (platform !== 'darwin') return Promise.resolve(null);

  return new Promise((resolve) => {
    let output = '';
    let settled = false;
    let child;
    let timer;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };

    try {
      child = spawn(IOREG_PATH, ['-c', 'IOHIDSystem'], { stdio: ['ignore', 'pipe', 'ignore'] });
      // A hung ioreg must not stall the idle sweep; no reading fails closed.
      timer = setTimeout(() => {
        try { child.kill?.('SIGKILL'); } catch {}
        finish(null);
      }, timeoutMs);
      timer.unref?.();
      child.stdout?.setEncoding?.('utf8');
      child.stdout?.on('data', chunk => { output += chunk; });
      child.on('error', () => finish(null));
      child.on('close', code => {
        if (code !== 0) {
          finish(null);
          return;
        }
        const match = output.match(HID_IDLE_TIME_PATTERN);
        if (!match) {
          finish(null);
          return;
        }
        const nanoseconds = Number(match[1]);
        finish(Number.isFinite(nanoseconds) ? nanoseconds / 1e9 : null);
      });
    } catch {
      finish(null);
    }
  });
}

export { HID_IDLE_TIME_PATTERN };
