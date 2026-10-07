import cp from 'child_process';
import path from 'path';

// macOS has no /proc, so process-ownership.js could never see the browser's
// command line there. Periodic temp-profile cleanup then skipped (and warned)
// on every tick. `ps` exposes the same pid/ppid/argument data.
const PS_PATH = '/bin/ps';
const PS_ARGS = ['-axww', '-o', 'pid=,ppid=,args='];
// Only the browser's main process is read: Firefox content processes
// (plugin-container) repeat -profile followed by positional arguments. In the
// main process the value runs until the next flag, so it may contain spaces.
const BROWSER_MAIN = /\/(?:camoufox|camoufox-bin|firefox)(?:\s|$)/;
const CONTENT_PROCESS = /plugin-container/;
const PROFILE_ARG = /(?:^|\s)--?profile(?:=|\s+)(.+?)(?=\s+-\S|$)/;

export function parseDarwinProcesses(output) {
  const processes = [];
  for (const line of String(output).split('\n')) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
    if (match) processes.push({ pid: Number(match[1]), ppid: Number(match[2]), args: match[3] });
  }
  return processes;
}

/** Profile directories passed to browser processes descended from rootPid. */
export function darwinDescendantProfilePaths(rootPid, processes) {
  const descendants = new Set([Number(rootPid)]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const proc of processes) {
      if (!descendants.has(proc.pid) && descendants.has(proc.ppid)) {
        descendants.add(proc.pid);
        changed = true;
      }
    }
  }
  const profiles = [];
  for (const proc of processes) {
    if (proc.pid === Number(rootPid) || !descendants.has(proc.pid) || !BROWSER_MAIN.test(proc.args) || CONTENT_PROCESS.test(proc.args)) continue;
    const profile = proc.args.match(PROFILE_ARG)?.[1];
    if (profile) profiles.push(path.resolve(profile));
  }
  return profiles;
}

/** Snapshot macOS processes, or null when ps is unavailable. */
export function snapshotDarwinProcesses({ execFile = cp.execFileSync } = {}) {
  try {
    // execFile with a fixed argument array: no shell, no interpolated input.
    return parseDarwinProcesses(execFile(PS_PATH, PS_ARGS, {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000, maxBuffer: 16 * 1024 * 1024,
    }));
  } catch {
    return null;
  }
}
