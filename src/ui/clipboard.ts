import { spawn } from 'node:child_process';

/** Copy text without putting it in a command line, shell history, or log. */
export async function copyToClipboard(value: string): Promise<void> {
  if (!value) return;
  if (process.platform === 'win32') {
    const encoded = Buffer.from(value, 'utf16le').toString('base64');
    const script = "$ErrorActionPreference='Stop';$b=[Console]::In.ReadToEnd();$t=[Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($b));Set-Clipboard -Value $t";
    try { await copyWithPowerShell(script, encoded); }
    catch {
      await new Promise<void>((resolve, reject) => {
        const child = spawn('clip.exe', [], { windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'] });
        child.once('error', reject);
        child.once('close', code => code === 0 ? resolve() : reject(new Error('Windows clipboard rejected the text.')));
        child.stdin.end(value, 'utf8');
      });
    }
    return;
  }
  const encoded = Buffer.from(value, 'utf8').toString('base64');
  process.stdout.write(`\u001b]52;c;${encoded}\u0007`);
}

/** Read the Windows text clipboard for classic conhost, which may not emit bracketed paste. */
export async function readClipboardText(): Promise<string> {
  if (process.platform !== 'win32') throw new Error('Use a paste shortcut supported by your terminal.');
  const script = String.raw`
$ErrorActionPreference = 'Stop'
try {
  $text = Get-Clipboard -Raw -Format Text
  if ($null -eq $text) { $text = '' }
  [Console]::Out.Write([Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes([string]$text)))
} catch {
  [Console]::Error.Write($_.Exception.Message)
  exit 1
}`;
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-Command', script], {
      windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000,
    });
    const chunks: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer | string) => chunks.push(Buffer.from(chunk)));
    child.once('error', reject);
    child.once('close', code => {
      if (code !== 0) { reject(new Error('Could not read the Windows clipboard.')); return; }
      try {
        const encoded = Buffer.concat(chunks).toString('ascii').trim();
        resolve(encoded ? Buffer.from(encoded, 'base64').toString('utf16le') : '');
      } catch { reject(new Error('Clipboard contains invalid text.')); }
    });
  });
}

/** Read a Windows clipboard bitmap as PNG for an explicit user initiated attach action. */
export async function readClipboardImage(): Promise<string> {
  if (process.platform !== 'win32') throw new Error('Pasting an image from the clipboard is supported on Windows.');
  const script = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
$image = [Windows.Forms.Clipboard]::GetImage()
if ($null -eq $image) { [Console]::Error.Write('The clipboard does not contain an image.'); exit 2 }
$stream = New-Object IO.MemoryStream
try { $image.Save($stream, [Drawing.Imaging.ImageFormat]::Png); [Console]::Out.Write([Convert]::ToBase64String($stream.ToArray())) }
finally { $stream.Dispose(); $image.Dispose() }
`;
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-Command', script], {
      windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
    });
    const chunks: Buffer[] = []; let size = 0; let oversized = false;
    const timer = setTimeout(() => { oversized = true; child.kill(); }, 8000);
    child.stdout.on('data', (chunk: Buffer | string) => {
      const value = Buffer.from(chunk); size += value.length;
      if (size > 11_000_000) { oversized = true; child.kill(); return; }
      chunks.push(value);
    });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => {
      clearTimeout(timer);
      if (oversized) { reject(new Error('Clipboard image is too large or took too long to read.')); return; }
      if (code !== 0) { reject(new Error('Clipboard has no image or Windows denied access.')); return; }
      const data = Buffer.concat(chunks).toString('ascii').trim();
      if (!data) { reject(new Error('The clipboard does not contain an image.')); return; }
      resolve(data);
    });
  });
}

function copyWithPowerShell(script: string, value: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-Command', script], {
      windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'],
    });
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve() : reject(new Error('PowerShell could not write to the clipboard.')));
    child.stdin.end(value, 'ascii');
  });
}
