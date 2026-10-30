import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import { findBrowserPid, snapshotDarwinProcesses } from './darwin-processes.js';

const run = promisify(execFile);
const SCRIPT = `ObjC.import('AppKit');function run(argv){
  const app=$.NSRunningApplication.runningApplicationWithProcessIdentifier(Number(argv[0]));
  if(!app||app.isNil()||app.terminated)throw Error('identity application is not running');
  const hidden=argv[1]==='hide';
  if(hidden)app.hide;else{app.unhide;app.activateWithOptions(0);}
  // AppKit updates NSRunningApplication state on the run loop, not during sleep.
  for(let attempt=0;attempt<10&&Boolean(app.hidden)!==hidden;attempt++)$.NSRunLoop.currentRunLoop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(0.05));
  return JSON.stringify({hidden:Boolean(app.hidden)});
}`;

export async function setDarwinAppHidden(pid, hidden, { execute = run } = {}) {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('invalid identity browser pid');
  const { stdout } = await execute('/usr/bin/osascript', ['-l', 'JavaScript', '-e', SCRIPT, String(pid), hidden ? 'hide' : 'show'], {
    timeout: 3000, maxBuffer: 65536, env: { PATH: '/usr/bin:/bin', HOME: os.homedir() },
  });
  const result = JSON.parse(stdout);
  if (typeof result.hidden !== 'boolean') throw new Error('invalid identity visibility readback');
  return result;
}

// Each persistent identity has its own application process. AppKit hide/unhide
// needs neither Accessibility nor Screen Recording, and never closes a window.
// Unlike parking, its scope is the whole identity, not an individual window.
export function createDarwinIdentityVisibility(profilePath, { rootPid = process.pid,
  snapshot = snapshotDarwinProcesses, setHidden = setDarwinAppHidden } = {}) {
  const visible = new Map([[0, { windowId: 0 }]]);
  async function change(hidden) {
    // Resolve ownership afresh, so a stale/reused PID cannot affect another app.
    const processes = snapshot();
    const pid = processes && findBrowserPid(rootPid, processes, profilePath);
    if (!pid) throw new Error('no single owned identity browser process for visibility change');
    const result = await setHidden(pid, hidden);
    if (result.hidden) visible.clear();
    else visible.set(0, { windowId: 0 });
    if (result.hidden !== hidden) throw new Error('identity application visibility change was not confirmed');
  }
  return {
    visible,
    capability: () => ({ parking: false, sameContextHandoff: true, mode: 'app-hidden', scope: 'identity', failedWindows: 0 }),
    updateDisplay() {},
    async attach() { await change(true); },
    async newPage(context) {
      let page;
      try { page = await context.newPage(); }
      catch (error) { visible.set(0, { windowId: 0 }); throw error; }
      if (!visible.size) {
        visible.set(0, { windowId: 0 });
        await change(true);
      }
      return page;
    },
    async open(page) {
      // A failed native readback after focus must not mark a possibly visible
      // application hidden and make it eligible for hidden-session expiry.
      visible.set(0, { windowId: 0 });
      await page.bringToFront();
      await change(false);
    },
    async release({ keep = [] } = {}) {
      // Hiding this process hides every window. Preserve any protected handoff,
      // even when the caller requested a different tab or all idle windows.
      if (keep.some(page => !page.isClosed())) return false;
      const wasVisible = visible.size > 0;
      await change(true);
      return wasVisible;
    },
    async close() {},
  };
}
