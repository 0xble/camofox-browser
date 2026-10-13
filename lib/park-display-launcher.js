import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';

const run = promisify(execFile);
const SCREEN_SCRIPT = `ObjC.import('AppKit');var screens=$.NSScreen.screens;var a=[];for(var i=0;i<screens.count;i++){var s=screens.objectAtIndex(i);var f=s.frame;a.push({name:ObjC.unwrap(s.localizedName),x:f.origin.x,y:f.origin.y,width:f.size.width,height:f.size.height})};JSON.stringify(a)`;

export function selectParkDisplay(screens, name) {
  const main = screens[0];
  // Unconfigured parking must never appropriate a person's physical monitor.
  const parked = screens.slice(1).find(screen => name ? screen.name === name
    : /deskpad|virtual|betterdisplay.*dummy|dummy.*betterdisplay/i.test(screen.name || ''));
  if (!main || !parked) return null;
  const bounds = screen => ({
    left: Math.round(screen.x), top: Math.round(main.y + main.height - screen.y - screen.height),
    width: Math.round(screen.width), height: Math.round(screen.height),
  });
  return { name: parked.name, park: bounds(parked), main: bounds(main) };
}

export async function findParkDisplay({ name, platform = os.platform(), execute = run } = {}) {
  if (platform !== 'darwin' || name === 'off') return null;
  const { stdout } = await execute('/usr/bin/osascript', ['-l', 'JavaScript', '-e', SCREEN_SCRIPT], {
    timeout: 5000, maxBuffer: 65536, env: { PATH: '/usr/bin:/bin', HOME: os.homedir() },
  });
  return selectParkDisplay(JSON.parse(stdout), name);
}

// Native geometry readback must not depend on window titles: macOS fills
// kCGWindowName for other processes' windows only when the TCC-responsible
// process holds Screen Recording, and a launchd-started server is its own
// responsible process without that grant. Owner PID, layer, window number and
// bounds are always present, so windows are identified by those alone.
const WINDOW_SCRIPT = `ObjC.import('CoreGraphics');ObjC.bindFunction('CGWindowListCopyWindowInfo',['id',['uint32','uint32']]);function run(args){var pid=Number(args[0]);var windows=ObjC.deepUnwrap($.CGWindowListCopyWindowInfo(17,0))||[];return JSON.stringify(windows.filter(w=>w.kCGWindowOwnerPID===pid).map(w=>{var b=w.kCGWindowBounds||{};return {number:w.kCGWindowNumber,pid:w.kCGWindowOwnerPID,layer:w.kCGWindowLayer,left:b.X,top:b.Y,width:b.Width,height:b.Height}}))}`;

/** On-screen layer-0 native windows owned by pid, with top-left-origin bounds in points. */
export async function listNativeWindows(pid, { execute = run } = {}) {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('invalid browser pid');
  const { stdout } = await execute('/usr/bin/osascript', ['-l', 'JavaScript', '-e', WINDOW_SCRIPT, String(pid)], {
    timeout: 1500, maxBuffer: 1048576, env: { PATH: '/usr/bin:/bin', HOME: os.homedir() },
  });
  const windows = JSON.parse(stdout);
  if (!Array.isArray(windows)) throw new Error('invalid native window list');
  return windows.filter(w => w && w.pid === pid && w.layer === 0).map(w => {
    if (!Number.isSafeInteger(w.number) || !['left', 'top', 'width', 'height'].every(key => Number.isFinite(w[key])) || w.width <= 0 || w.height <= 0)
      throw new Error('invalid native window geometry');
    return { number: w.number, left: w.left, top: w.top, width: w.width, height: w.height };
  });
}

export function windowBounds(display, focused = false) {
  const width = Math.min(1280, display.width);
  const height = Math.min(900, display.height);
  return { left: display.left + Math.min(40, display.width - width),
    top: display.top + Math.min(40, display.height - height), width, height, focused, state: 'normal' };
}
