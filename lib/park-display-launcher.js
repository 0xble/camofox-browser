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

export function windowBounds(display, focused = false) {
  const width = Math.min(1280, display.width);
  const height = Math.min(900, display.height);
  return { left: display.left + Math.min(40, display.width - width),
    top: display.top + Math.min(40, display.height - height), width, height, focused, state: 'normal' };
}
