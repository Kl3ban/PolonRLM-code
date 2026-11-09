import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execa } from 'execa';
import { ComputerSession } from '../src/tools/computer.js';

// Opt-in only: creates and controls its own disposable WinForms window, never an existing user app.
test('native Windows computer_use observes, clicks, types Unicode and presses keys in its own test window', { skip: process.platform !== 'win32' || process.env.POLONRLM_DESKTOP_TEST !== '1', timeout: 90000 }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'polon-desktop-fixture-'));
  const ready = path.join(directory, 'ready.json'), stop = path.join(directory, 'stop');
  const executable = path.join(directory, 'fixture.exe');
  const source = String.raw`
$ErrorActionPreference='Stop'
$code=@'
using System;using System.IO;using System.Drawing;using System.Windows.Forms;using System.Runtime.InteropServices;
public static class Fixture {
 [StructLayout(LayoutKind.Sequential)] public struct PointNative{public int X,Y;}
 [DllImport("user32.dll")]public static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")]public static extern bool SetForegroundWindow(IntPtr h);
 [DllImport("user32.dll")]public static extern bool GetCursorPos(out PointNative p);
 [DllImport("user32.dll")]public static extern bool SetCursorPos(int x,int y);
 [STAThread]public static void Main(){
  var previous=GetForegroundWindow();PointNative point;GetCursorPos(out point);
  var form=new Form{Text="PolonRLM Desktop Test",Width=520,Height=240,StartPosition=FormStartPosition.CenterScreen,TopMost=true};
  var editor=new TextBox{AccessibleName="Fixture editor",Location=new Point(20,20),Width=440};
  var button=new Button{Text="Save fixture",Location=new Point(20,65),Width=140};
  var label=new Label{Text="Not saved",Location=new Point(20,110),Width=440};
  button.Click+=(s,e)=>{label.Text="Saved: "+editor.Text;};form.Controls.AddRange(new Control[]{editor,button,label});
  form.Shown+=(s,e)=>{editor.Focus();File.WriteAllText(Environment.GetEnvironmentVariable("POLON_DESKTOP_READY"),"{\"id\":\""+form.Handle.ToInt64()+"\"}");};
  var timer=new Timer{Interval=100};timer.Tick+=(s,e)=>{if(File.Exists(Environment.GetEnvironmentVariable("POLON_DESKTOP_STOP")))form.Close();};timer.Start();
  try{Application.Run(form);}finally{timer.Dispose();form.Dispose();SetCursorPos(point.X,point.Y);SetForegroundWindow(previous);}
 }
}
'@
Add-Type -TypeDefinition $code -ReferencedAssemblies System.Windows.Forms,System.Drawing -OutputAssembly $env:POLON_DESKTOP_EXE -OutputType WindowsApplication
`;
  await execa('powershell.exe', ['-NoLogo', '-NoProfile', '-STA', '-EncodedCommand', Buffer.from(source, 'utf16le').toString('base64')], { windowsHide: true, env: { POLON_DESKTOP_EXE: executable } });
  const abort = new AbortController();
  const child = execa(executable, [], { windowsHide: false, env: { POLON_DESKTOP_READY: ready, POLON_DESKTOP_STOP: stop }, cancelSignal: abort.signal, reject: false });
  // Observe process errors even when startup does not produce the ready file.
  const outcome = child.catch(error => ({ exitCode: -1, stderr: String(error) }));
  try {
    let windowId: string | undefined;
    for (let i = 0; i < 100; i++) {
      try { windowId = JSON.parse(await readFile(ready, 'utf8')).id; break; } catch { await new Promise(resolve => setTimeout(resolve, 100)); }
    }
    assert.ok(windowId, 'Fixture window did not start');
    const session = new ComputerSession(); const images: string[] = [];
    const context = { mode: 'BUILD' as const, signal: AbortSignal.timeout(60000), onImage: (image: { data: string }) => images.push(image.data) };
    const listed = await session.execute({ action: 'list' }, context) as any;
    assert.ok(listed.windows.some((window: any) => window.id === windowId && window.pid === child.pid));
    const taskbar = listed.windows.find((window: any) => window.title === 'Windows taskbar');
    assert.ok(taskbar, 'Taskbar should be available as a separate click target');
    const taskbarScreen = await session.execute({ action: 'observe', windowId: taskbar.id }, context) as any;
    assert.equal(taskbarScreen.windowId, taskbar.id);
    assert.equal(taskbarScreen.grid.rows, 1, 'Taskbar coordinates should use a one-row grid');
    assert.ok(taskbarScreen.grid.columns >= 10, 'Taskbar grid should retain useful horizontal precision');
    assert.ok(images[0]!.length > 100, 'Taskbar-only screenshot should be attached');
    let screen = await session.execute({ action: 'observe', windowId }, context) as any;
    assert.ok(images[1]!.length > 100);
    const editor = screen.elements.find((element: any) => element.name === 'Fixture editor') ?? screen.elements.find((element: any) => /ControlType\.(?:Edit|ComboBox)/.test(element.type)); assert.ok(editor, JSON.stringify(screen.elements));
    const unicode = 'Zażółć 123';
    screen = await session.execute({ action: 'fill', snapshotId: screen.snapshotId, element: editor.index, text: unicode }, context) as any;
    let button = screen.elements.find((element: any) => element.name === 'Save fixture'); assert.ok(button, JSON.stringify(screen.elements));
    screen = await session.execute({ action: 'click', snapshotId: screen.snapshotId, element: button.index }, context) as any;
    assert.ok(screen.elements.some((element: any) => element.name === `Saved: ${unicode}`), JSON.stringify(screen.elements));
    screen = await session.execute({ action: 'observe', windowId }, context) as any;
    const updatedEditor = screen.elements.find((element: any) => element.name === 'Fixture editor') ?? screen.elements.find((element: any) => /ControlType\.(?:Edit|ComboBox)/.test(element.type)); assert.ok(updatedEditor, JSON.stringify(screen.elements));
    screen = await session.execute({ action: 'key', snapshotId: screen.snapshotId, keys: ['CTRL', 'A'], element: updatedEditor.index }, context) as any;
    const typed = 'Replaced 世界';
    screen = await session.execute({ action: 'type', snapshotId: screen.snapshotId, text: typed }, context) as any;
    button = screen.elements.find((element: any) => element.name === 'Save fixture'); assert.ok(button, JSON.stringify(screen.elements));
    screen = await session.execute({ action: 'click', snapshotId: screen.snapshotId, element: button.index }, context) as any;
    assert.ok(screen.elements.some((element: any) => element.name === `Saved: ${typed}`), JSON.stringify(screen.elements));
  } finally {
    await writeFile(stop, 'stop');
    await Promise.race([outcome, new Promise(resolve => setTimeout(resolve, 3000))]);
    if (child.exitCode === undefined) abort.abort();
    await outcome;
    const target = path.resolve(directory);
    assert.equal(path.dirname(target), path.resolve(os.tmpdir())); assert.ok(path.basename(target).startsWith('polon-desktop-fixture-'));
    await rm(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});
