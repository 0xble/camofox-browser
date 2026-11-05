import { execFile } from 'node:child_process';
import { isQuarantinedPage } from './page-registry.js';
import { findMainDisplay } from './park-display-launcher.js';
import { createSharedIdentityVisibility } from './shared-identity-visibility.js';
import { promisify } from 'node:util';
import os from 'node:os';
import { withRequestDeadline } from './request-deadline.js';
import { findBrowserPid, snapshotDarwinProcesses } from './darwin-processes.js';

// Bound browser IPC plus the 3s native readback without wedging this identity.
const VISIBILITY_OPERATION_TIMEOUT_MS = 12000;

const run = promisify(execFile);
const SCRIPT = `ObjC.import('AppKit');function run(argv){
  let app=$.NSRunningApplication.runningApplicationWithProcessIdentifier(Number(argv[0]));
  const turn=()=>$.NSRunLoop.currentRunLoop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(0.05));
  // Playwright can connect before Launch Services registers the application.
  for(let attempt=0;attempt<10&&(!app||app.isNil());attempt++){
    turn();app=$.NSRunningApplication.runningApplicationWithProcessIdentifier(Number(argv[0]));
  }
  if(!app||app.isNil()||app.terminated)throw Error('identity application is not running');
  const hidden=argv[1]==='hide';
  let activated=false;
  if(!hidden&&argv[1]!=='read'){app.unhide;try{activated=Boolean(app.activateWithOptions(0));}catch{}}
  // An early hide can be refused or overtaken by a newly created window.
  // Reissue only while unconfirmed; leave time inside the 3s subprocess bound
  // for application registration and AppKit's run-loop-delivered readback.
  for(let attempt=0;attempt<(hidden?30:10)&&(Boolean(app.hidden)!==hidden||(!hidden&&!Boolean(app.active)));attempt++){
    if(hidden&&!Boolean(app.hidden))app.hide;turn();
  }
  return JSON.stringify({hidden:Boolean(app.hidden),active:Boolean(app.active),activated});
}`;

export async function setDarwinAppHidden(pid, hidden, { execute = run, readOnly = false } = {}) {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('invalid identity browser pid');
  const { stdout } = await execute('/usr/bin/osascript', ['-l', 'JavaScript', '-e', SCRIPT, String(pid), readOnly ? 'read' : hidden ? 'hide' : 'show'], {
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
  snapshot = snapshotDarwinProcesses, setHidden = setDarwinAppHidden, timeoutMs = VISIBILITY_OPERATION_TIMEOUT_MS,
  readState = pid => setDarwinAppHidden(pid, false, { readOnly: true }),
  createWindowControl = async () => {
    const discoverDisplay = async () => ({ main: await findMainDisplay(), park: null });
    return createSharedIdentityVisibility(await discoverDisplay(), { profilePath, showOnly: true, discoverDisplay });
  } } = {}) {
  const visible = new Map([[0, { windowId: 0 }]]);
  const openingPages = new Set();
  let pending = Promise.resolve(), windowControl, preparing, windowControlError;
  async function prepare() {
    if (!preparing) preparing = Promise.resolve().then(createWindowControl)
      .then(value => { windowControl = value; return value; })
      .catch(error => { windowControlError = error; return null; });
    return preparing;
  }
  function browserPid() {
    const processes = snapshot();
    const pid = processes && findBrowserPid(rootPid, processes, profilePath);
    if (!pid) throw new Error('no single owned identity browser process for visibility change');
    return pid;
  }
  function enqueue(work) {
    const next = pending.then(() => withRequestDeadline(work, timeoutMs, 'identity visibility operation'));
    pending = next.catch(() => {});
    return next;
  }
  async function change(hidden, signal) {
    signal.throwIfAborted();
    // Resolve ownership afresh, so a stale/reused PID cannot affect another app.
    const result = await setHidden(browserPid(), hidden);
    signal.throwIfAborted();
    if (result.hidden) visible.clear();
    else visible.set(0, { windowId: 0 });
    if (result.hidden !== hidden) throw new Error('identity application visibility change was not confirmed');
    return { visible: !hidden, focused: !hidden && result.active === true };
  }
  return {
    prepare,
    get addon() { return windowControl?.addon; },
    visible,
    // Reconcile external Dock/Cmd+H actions before destructive cleanup, using
    // the existing identity visibility queue (never issue show/hide here).
    refresh() {
      return enqueue(async signal => {
        try {
          const state = await readState(browserPid());
          signal.throwIfAborted();
          if (typeof state?.hidden !== 'boolean') throw new Error('native visibility readback unavailable');
          if (state.hidden) visible.clear();
          else visible.set(0, { windowId: 0 });
        } catch (error) {
          if (!signal.aborted) visible.set(0, { windowId: 0 });
          throw error;
        }
      });
    },
    // App hiding has identity-wide scope, with no selected-tab readback. A
    // human may switch tabs directly, so every visible app page is protected.
    isPageVisible: page => openingPages.has(page) || visible.size > 0,
    capability: () => ({ parking: false, sameContextHandoff: !windowControlError, mode: 'app-hidden', scope: 'identity', failedWindows: 0 }),
    // Hiding the application creates no helper pages, so every page is a real
    // agent or user tab, including UI-opened tabs and OAuth popups.
    isManagedPage: () => false,
    async shouldRegisterUIPage(page) { return !page.isClosed(); },
    updateDisplay() {},
    async attach(context) {
      let hidden = false;
      try {
        await enqueue(async signal => {
          await change(true, signal); hidden = true;
          await prepare(); signal.throwIfAborted();
          if (windowControl) await windowControl.attach(context);
          signal.throwIfAborted();
        });
      } catch (error) {
        // Failed hiding still fails acquisition. Optional addon failure or
        // timeout degrades only human handoff, never the agent's context.
        if (!hidden) throw error;
        windowControlError = error;
      }
    },
    newPage(context) {
      return enqueue(async signal => {
        const wasVisible = visible.size > 0;
        // A timed-out create may still surface a window; preserve it, never close it.
        visible.set(0, { windowId: 0 });
        const page = await context.newPage();
        signal.throwIfAborted();
        if (!wasVisible) await change(true, signal);
        return page;
      });
    },
    open(page) {
      openingPages.add(page);
      return enqueue(async signal => {
        const check = () => {
          if (isQuarantinedPage(page)) throw Object.assign(new Error('Tab was destroyed'), { code: 'tab_destroyed', statusCode: 410 });
        };
        check();
        await prepare(); signal.throwIfAborted(); check();
        if (windowControlError) throw new Error(`native window handoff unavailable: ${windowControlError.message}`, { cause: windowControlError });
        // Failed focus/readback leaves the application protected from expiry.
        visible.set(0, { windowId: 0 });
        await page.bringToFront();
        check();
        await change(false, signal);
        check();
        const native = await windowControl.open(page, { signal }); signal.throwIfAborted();
        check();
        if (native?.onMain !== true || !Number.isSafeInteger(native.number))
          throw new Error('native target window placement on main display was not confirmed');
        const state = await readState(browserPid()); signal.throwIfAborted();
        if (state?.hidden !== false) throw new Error('native browser visibility change was not confirmed');
        return { visible: true, focused: state.active === true && native.frontmost === true };
      }).finally(() => openingPages.delete(page));
    },
    release({ keep = [] } = {}) {
      return enqueue(async signal => {
        // Application-wide hiding must preserve every protected handoff.
        if (keep.some(page => !page.isClosed() && !isQuarantinedPage(page))) return false;
        const wasVisible = visible.size > 0;
        await change(true, signal);
        return wasVisible;
      });
    },
    async close() { await windowControl?.close(); },
  };
}
