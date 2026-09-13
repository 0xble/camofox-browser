import { spawn } from 'child_process';
import { once } from 'events';
import {
  isWindowsBrowserProcess,
  isWindowsProcessCurrent,
  killWindowsProcessTree,
  normalizeWindowsProcess,
  selectWindowsProcessTree,
  snapshotWindowsProcesses,
} from '../../lib/windows-processes.js';

const testOnWindows = process.platform === 'win32' ? test : test.skip;

test('selects only a root process and its descendants', () => {
  const processes = [
    normalizeWindowsProcess({ ProcessId: 10, ParentProcessId: 1, Name: 'node.exe', CreationDate: 'one' }),
    normalizeWindowsProcess({ ProcessId: 11, ParentProcessId: 10, Name: 'camoufox.exe', CreationDate: 'two' }),
    normalizeWindowsProcess({ ProcessId: 12, ParentProcessId: 11, Name: 'firefox.exe', CreationDate: 'three' }),
    normalizeWindowsProcess({ ProcessId: 20, ParentProcessId: 1, Name: 'camoufox.exe', CreationDate: 'four' }),
  ];
  expect(selectWindowsProcessTree(10, processes).map(({ pid }) => pid)).toEqual([10, 11, 12]);
  expect(isWindowsBrowserProcess(processes[1])).toBe(true);
  expect(isWindowsBrowserProcess({ name: 'node.exe', cmdline: 'camoufox.exe' })).toBe(false);
  expect(isWindowsProcessCurrent(processes[1], processes)).toBe(true);
  expect(isWindowsProcessCurrent({ ...processes[1], startTime: 'reused' }, processes)).toBe(false);
});

testOnWindows('taskkill removes a real owned process tree', async () => {
  const childScript = "const {spawn}=require('child_process');spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true});setInterval(()=>{},1000)";
  const root = spawn(process.execPath, ['-e', childScript], { stdio: 'ignore', windowsHide: true });
  try {
    const deadline = Date.now() + 10_000;
    let rootRecord;
    while (Date.now() < deadline) {
      rootRecord = snapshotWindowsProcesses().find((proc) => proc.pid === root.pid);
      if (rootRecord) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(rootRecord).toBeDefined();
    expect(killWindowsProcessTree(root.pid, { expectedStartTime: rootRecord.startTime })).toBe(true);
    await once(root, 'exit');
    expect(snapshotWindowsProcesses().some((proc) => proc.pid === root.pid)).toBe(false);
  } finally {
    if (root.exitCode === null) killWindowsProcessTree(root.pid);
  }
}, 20_000);
