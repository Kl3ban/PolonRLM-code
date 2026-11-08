import { spawnSync } from 'node:child_process';

const API = String.raw`
$source = @'
using System;
using System.Runtime.InteropServices;
public static class PolonRLMConsoleMode {
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern IntPtr CreateFile(string name, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool GetConsoleMode(IntPtr handle, out uint mode);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool SetConsoleMode(IntPtr handle, uint mode);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool FreeConsole();
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool AttachConsole(uint processId);
}
'@
Add-Type -TypeDefinition $source
`;

function invokePowerShell(body: string): string {
  const attach = String.raw`
[void][PolonRLMConsoleMode]::FreeConsole()
if (-not [PolonRLMConsoleMode]::AttachConsole([uint32]${process.pid})) { exit 2 }
$handle = [PolonRLMConsoleMode]::CreateFile('CONIN$', [uint32]3221225472, [uint32]3, [IntPtr]::Zero, [uint32]3, [uint32]0, [IntPtr]::Zero)
`;
  const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', `${API}\n${attach}\n${body}`], {
    windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000,
  });
  return result.status === 0 ? (result.stdout ?? '').trim() : '';
}

/** Let the app handle dragging without classic Console QuickEdit pausing the process. */
export function disableQuickEdit(): () => void {
  if (process.platform !== 'win32' || !process.stdin.isTTY) return () => {};
  const output = invokePowerShell(String.raw`
[uint32]$mode = 0
if ($handle -ne [IntPtr]::Zero -and [PolonRLMConsoleMode]::GetConsoleMode($handle, [ref]$mode)) {
  $next = [uint32](([uint64]$mode -bor 128) -band 4294967231)
  if ([PolonRLMConsoleMode]::SetConsoleMode($handle, $next)) { [Console]::Write([string]$mode) }
}
if ($handle -ne [IntPtr]::Zero) { [PolonRLMConsoleMode]::CloseHandle($handle) | Out-Null }
`);
  const original = /^\d+$/.test(output) ? Number(output) : undefined;
  if (original === undefined) return () => {};

  let restored = false;
  const restore = () => {
    if (restored) return;
    restored = true;
    invokePowerShell(String.raw`
[uint32]$mode = ${original}
if ($handle -ne [IntPtr]::Zero) { [PolonRLMConsoleMode]::SetConsoleMode($handle, $mode) | Out-Null; [PolonRLMConsoleMode]::CloseHandle($handle) | Out-Null }
`);
  };
  process.once('exit', restore);
  return () => { process.off('exit', restore); restore(); };
}
