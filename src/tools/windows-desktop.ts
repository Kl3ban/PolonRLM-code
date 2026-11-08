/** Fixed helper program. Untrusted arguments arrive only as JSON on stdin. */
export const WINDOWS_DESKTOP_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$request = [Console]::In.ReadToEnd() | ConvertFrom-Json
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, WindowsBase, System.Drawing, System.Windows.Forms
$source = @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class PolonDesktop {
 public delegate bool EnumProc(IntPtr h, IntPtr p);
 [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left,Top,Right,Bottom; }
 [StructLayout(LayoutKind.Sequential)] public struct Point { public int X,Y; }
 [StructLayout(LayoutKind.Sequential)] public struct Mouse { public int X,Y; public uint Data,Flags,Time; public UIntPtr Extra; }
 [StructLayout(LayoutKind.Sequential)] public struct Key { public ushort Vk,Scan; public uint Flags,Time; public UIntPtr Extra; }
 [StructLayout(LayoutKind.Explicit)] public struct Union { [FieldOffset(0)] public Mouse Mouse; [FieldOffset(0)] public Key Key; }
 [StructLayout(LayoutKind.Sequential)] public struct Input { public uint Type; public Union Value; }
 [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc callback,IntPtr p);
 [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr parent,EnumProc callback,IntPtr p);
 [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
 [DllImport("user32.dll")] public static extern bool IsWindowEnabled(IntPtr h);
 [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
 [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
 [DllImport("user32.dll")] public static extern bool IsChild(IntPtr parent,IntPtr child);
 [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(Point p);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h,StringBuilder s,int n);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h,StringBuilder s,int n);
 [DllImport("user32.dll",EntryPoint="GetWindowLongW")] public static extern int GetWindowStyle(IntPtr h,int index);
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h,out uint pid);
 [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h,out Rect r);
 [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
 [DllImport("user32.dll")] public static extern IntPtr SetActiveWindow(IntPtr h);
 [DllImport("user32.dll")] public static extern IntPtr SetFocus(IntPtr h);
 [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
 [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint from,uint to,bool attach);
 [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
 [DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y);
 [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int key);
 [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
 [DllImport("user32.dll",SetLastError=true)] public static extern bool PrintWindow(IntPtr h,IntPtr dc,uint flags);
 [DllImport("user32.dll",SetLastError=true)] public static extern uint SendInput(uint n,Input[] inputs,int size);
 [DllImport("user32.dll")] public static extern void keybd_event(byte vk,byte scan,uint flags,UIntPtr extra);
 [DllImport("user32.dll",CharSet=CharSet.Unicode,EntryPoint="SendMessageW")] public static extern IntPtr SendMessageText(IntPtr h,uint message,IntPtr w,string text);
 [DllImport("user32.dll",EntryPoint="SendMessageW")] public static extern IntPtr SendMessage(IntPtr h,uint message,IntPtr w,IntPtr l);
 public static uint Pid(IntPtr h) { uint p; GetWindowThreadProcessId(h,out p); return p; }
 public static bool Focus(IntPtr h) {
  var foreground=GetForegroundWindow();uint targetPid=0,foregroundPid=0;uint targetThread=GetWindowThreadProcessId(h,out targetPid);uint current=GetCurrentThreadId();uint foregroundThread=foreground==IntPtr.Zero?0:GetWindowThreadProcessId(foreground,out foregroundPid);
  bool attachedForeground=false,attachedTarget=false;
  try {
   if(foregroundThread!=0&&foregroundThread!=current)attachedForeground=AttachThreadInput(current,foregroundThread,true);
   if(targetThread!=0&&targetThread!=current)attachedTarget=AttachThreadInput(current,targetThread,true);
   BringWindowToTop(h);SetForegroundWindow(h);SetActiveWindow(h);SetFocus(h);System.Threading.Thread.Sleep(100);
   return GetForegroundWindow()==h;
  } finally {
   if(attachedTarget)AttachThreadInput(current,targetThread,false);
   if(attachedForeground)AttachThreadInput(current,foregroundThread,false);
  }
 }
 public static int[] Bounds(IntPtr h) { Rect r; if(!GetWindowRect(h,out r))throw new Exception("Window bounds unavailable");return new int[]{r.Left,r.Top,r.Right-r.Left,r.Bottom-r.Top}; }
 public static string Title(IntPtr h) { var s=new StringBuilder(2048);GetWindowText(h,s,s.Capacity);return s.ToString(); }
 public static string ClassName(IntPtr h) { var s=new StringBuilder(256);GetClassName(h,s,s.Capacity);return s.ToString(); }
 public static long[] ChildWindows(IntPtr h) {var list=new List<long>();EnumChildWindows(h,(child,p)=>{list.Add(child.ToInt64());return true;},IntPtr.Zero);return list.ToArray();}
 public static IntPtr EditAt(IntPtr parent,int x,int y) {
  var origin=Bounds(parent);
  foreach(long id in ChildWindows(parent)){var child=new IntPtr(id);if(ClassName(child).IndexOf("EDIT",StringComparison.OrdinalIgnoreCase)<0)continue;var r=Bounds(child);if(x>=r[0]-origin[0]&&y>=r[1]-origin[1]&&x<r[0]-origin[0]+r[2]&&y<r[1]-origin[1]+r[3])return child;}
  return IntPtr.Zero;
 }
 public static bool SetEditTextAt(IntPtr parent,int x,int y,string text) {var edit=EditAt(parent,x,y);if(edit==IntPtr.Zero)return false;if((GetWindowStyle(edit,-16)&0x20)!=0)throw new Exception("Password fields require the user to type directly.");return SendMessageText(edit,0x000C,IntPtr.Zero,text)!=IntPtr.Zero;}
 public static bool SelectAllAt(IntPtr parent,int x,int y) {var edit=EditAt(parent,x,y);if(edit==IntPtr.Zero)return false;if((GetWindowStyle(edit,-16)&0x20)!=0)throw new Exception("Password fields require the user to type directly.");SendMessage(edit,0x00B1,IntPtr.Zero,new IntPtr(-1));return true;}
 public static bool IsTaskbar(IntPtr h) {var name=ClassName(h);return name=="Shell_TrayWnd"||name=="Shell_SecondaryTrayWnd";}
 public static long[] Windows() {var list=new List<long>();EnumWindows((h,p)=>{if(IsWindowVisible(h)&&(Title(h).Length>0||IsTaskbar(h)))list.Add(h.ToInt64());return true;},IntPtr.Zero);return list.ToArray();}
 public static void Guard(IntPtr h,uint pid,int[] bounds,bool input) {
  if(!IsWindow(h)||Pid(h)!=pid)throw new Exception("Window no longer matches observation");
  var r=Bounds(h);if(bounds!=null)for(int i=0;i<4;i++)if(r[i]!=bounds[i])throw new Exception("Window moved or resized; expected ["+String.Join(",",bounds)+"], got ["+String.Join(",",r)+"]");
  if(input) {
   if((GetAsyncKeyState(0x13)&0x8000)!=0)throw new Exception("Pause emergency stop is held");
   if(IsIconic(h))throw new Exception("Restore minimized window before input");
   if(!IsTaskbar(h)&&GetForegroundWindow()!=h&&!Focus(h))throw new Exception("Cannot focus target window; input cancelled");
   if(bounds!=null){r=Bounds(h);for(int i=0;i<4;i++)if(r[i]!=bounds[i])throw new Exception("Window changed during activation; expected ["+String.Join(",",bounds)+"], got ["+String.Join(",",r)+"]");}
   foreach(int k in new int[]{0x10,0x11,0x12,0x5B,0x5C})if((GetAsyncKeyState(k)&0x8000)!=0)throw new Exception("Release modifier keys before automation");
  }
 }
 static Input KeyInput(ushort vk,ushort scan,uint flags) {return new Input{Type=1,Value=new Union{Key=new Key{Vk=vk,Scan=scan,Flags=flags}}};}
 static void Send(Input[] inputs) { if(SendInput((uint)inputs.Length,inputs,Marshal.SizeOf(typeof(Input)))!=inputs.Length)throw new Exception("Input blocked, possibly by Windows integrity restrictions"); }
 public static void Text(string text) {var a=new List<Input>();foreach(char c in text){a.Add(KeyInput(0,c,4));a.Add(KeyInput(0,c,6));}Send(a.ToArray());}
 public static void Keys(ushort[] keys) {foreach(var k in keys)keybd_event((byte)k,0,0,UIntPtr.Zero);System.Threading.Thread.Sleep(30);for(int i=keys.Length-1;i>=0;i--)keybd_event((byte)keys[i],0,2,UIntPtr.Zero);}
 public static void Pointer(IntPtr h,int x,int y,string button,int wheel) {
  var r=Bounds(h);if(x<0||y<0||x>=r[2]||y>=r[3])throw new Exception("Point outside window");
  var pt=new Point{X=r[0]+x,Y=r[1]+y};var under=WindowFromPoint(pt);
  if(under!=h&&!IsChild(h,under))throw new Exception("Point is covered by another window");
  if(!SetCursorPos(pt.X,pt.Y))throw new Exception("Cannot position pointer");
  if(wheel!=0){Send(new[]{new Input{Type=0,Value=new Union{Mouse=new Mouse{Data=unchecked((uint)wheel),Flags=0x800}}}});return;}
  uint down=button=="right"?8u:2u,up=button=="right"?16u:4u;
  Send(new[]{new Input{Type=0,Value=new Union{Mouse=new Mouse{Flags=down}}},new Input{Type=0,Value=new Union{Mouse=new Mouse{Flags=up}}}});
 }
}
'@
Add-Type -TypeDefinition $source
[void][PolonDesktop]::SetProcessDPIAware()
try {
 if ($request.action -eq 'list') {
  $windows = @([PolonDesktop]::Windows() | ForEach-Object {
   $h=[IntPtr]$_; $processId=[PolonDesktop]::Pid($h)
   try { $process=Get-Process -Id $processId -ErrorAction Stop; $title=[PolonDesktop]::Title($h); if ([PolonDesktop]::IsTaskbar($h)) {$title='Windows taskbar'}; @{id=[string]$_;pid=$processId;title=$title;process=$process.ProcessName;bounds=[PolonDesktop]::Bounds($h)} } catch {}
  })
  [Console]::Write((@{windows=$windows} | ConvertTo-Json -Depth 8 -Compress)); exit 0
 }
 $h=[IntPtr]::new([long]$request.windowId)
 [PolonDesktop]::Guard($h,[uint32]$request.pid,$request.bounds,($request.action -ne 'observe'))
 $root=[Windows.Automation.AutomationElement]::FromHandle($h)
 $directSet=$false
 if ($request.action -eq 'type' -or $request.action -eq 'key' -or $request.action -eq 'fill') {
  if (($request.action -eq 'fill') -or ($request.action -eq 'key' -and $null -ne $request.x -and $null -ne $request.y)) { [PolonDesktop]::Pointer($h,[int]$request.x,[int]$request.y,'left',0); Start-Sleep -Milliseconds 40 }
  if ($request.action -eq 'fill') { $directSet=[PolonDesktop]::SetEditTextAt($h,[int]$request.x,[int]$request.y,[string]$request.text) }
  $focused=[Windows.Automation.AutomationElement]::FocusedElement
  if ($null -eq $focused -or $focused.Current.ProcessId -ne $request.pid) { throw 'Focus is outside the target process.' }
  if ($focused.Current.IsPassword) { throw 'Password fields require the user to type directly.' }
  if ($request.action -eq 'type' -or ($request.action -eq 'fill' -and -not $directSet)) { [PolonDesktop]::Text([string]$request.text) } elseif ($request.action -eq 'key') {
   $codes=@($request.keys | ForEach-Object {[int]$_});$chord=''
   if($codes -contains 17){$chord+='^'};if($codes -contains 18){$chord+='%'};if($codes -contains 16){$chord+='+'}
   $main=@($codes | Where-Object {$_ -notin 16,17,18})
   if($main.Count -ne 1){throw 'A key chord requires exactly one non-modifier key.'}
   $code=$main[0];$name=switch($code){13{'{ENTER}'}9{'{TAB}'}27{'{ESC}'}8{'{BACKSPACE}'}46{'{DELETE}'}32{' ' }36{'{HOME}'}35{'{END}'}33{'{PGUP}'}34{'{PGDN}'}37{'{LEFT}'}38{'{UP}'}39{'{RIGHT}'}40{'{DOWN}'}default{if($code -ge 65 -and $code -le 90){([char]($code+32)).ToString()}elseif($code -ge 48 -and $code -le 57){([char]$code).ToString()}elseif($code -ge 112 -and $code -le 123){'{F'+($code-111)+'}'}else{throw 'Unsupported key.'}}}
   if ($chord -eq '^' -and $code -eq 65 -and $null -ne $request.x -and $null -ne $request.y -and [PolonDesktop]::SelectAllAt($h,[int]$request.x,[int]$request.y)) { }
   else { [System.Windows.Forms.SendKeys]::SendWait($chord+$name) }
  }
 }
if ($request.action -eq 'click' -or $request.action -eq 'scroll') {
  [PolonDesktop]::Pointer($h,[int]$request.x,[int]$request.y,[string]$request.button,[int]$request.wheel)
  if ($request.action -eq 'click' -and $request.clicks -eq 2) { [PolonDesktop]::Guard($h,[uint32]$request.pid,$request.bounds,$true); [PolonDesktop]::Pointer($h,[int]$request.x,[int]$request.y,[string]$request.button,0) }
 }
 if ($request.action -ne 'observe') { Start-Sleep -Milliseconds 100 }
 $bounds=[PolonDesktop]::Bounds($h)
 if ($bounds[2] -lt 1 -or $bounds[3] -lt 1 -or $bounds[2] -gt 7680 -or $bounds[3] -gt 4320) { throw 'Window dimensions outside supported range.' }
 $elements=New-Object System.Collections.Generic.List[object]
 # RawView retains native WinForms controls (ControlView often collapses TextBox/Button to unnamed Pane nodes).
 $walker=[Windows.Automation.TreeWalker]::RawViewWalker
 $queue=New-Object System.Collections.Queue
 $queue.Enqueue(@{node=$root;depth=0})
 while ($queue.Count -gt 0 -and $elements.Count -lt 120) {
  $entry=$queue.Dequeue();$node=$entry.node
  try {
   $info=$node.Current;$rect=$info.BoundingRectangle
   if (-not $info.IsOffscreen -and $rect.Width -gt 0 -and $rect.Height -gt 0) {
    $name=if($info.IsPassword){'[password]'}else{$info.Name}
    if ($name.Length -gt 240) {$name=$name.Substring(0,240)}
    $value=''
    if (-not $info.IsPassword) {
     try {
      $pattern=$null
      if ($node.TryGetCurrentPattern([Windows.Automation.ValuePattern]::Pattern,[ref]$pattern)) { $value=$pattern.Current.Value }
      elseif ($node.TryGetCurrentPattern([Windows.Automation.TextPattern]::Pattern,[ref]$pattern)) { $value=$pattern.DocumentRange.GetText(600) }
      if ($value.Length -gt 600) { $value=$value.Substring(0,600) }
     } catch { $value='' }
    }
    $elements.Add(@{name=$name;value=$value;type=$info.ControlType.ProgrammaticName;password=$info.IsPassword;enabled=$info.IsEnabled;x=$rect.X-$bounds[0];y=$rect.Y-$bounds[1];width=$rect.Width;height=$rect.Height})
   }
   if($entry.depth -lt 8) {$child=$walker.GetFirstChild($node);while($null -ne $child -and $queue.Count -lt 180){$queue.Enqueue(@{node=$child;depth=$entry.depth+1});$child=$walker.GetNextSibling($child)}}
  } catch {}
 }
 # UI Automation can collapse classic WinForms controls into unnamed Pane nodes.
 # Supplement it with child HWND metadata; never read Edit text, and flag ES_PASSWORD fields.
 foreach($childId in [PolonDesktop]::ChildWindows($h)) {
  if ($elements.Count -ge 120) { break }
  $child=[IntPtr]::new([long]$childId)
  if (-not [PolonDesktop]::IsWindowVisible($child)) { continue }
  $class=[PolonDesktop]::ClassName($child)
  $type=if($class -match 'EDIT'){'ControlType.Edit'}elseif($class -match 'BUTTON'){'ControlType.Button'}elseif($class -match 'COMBOBOX'){'ControlType.ComboBox'}else{''}
  if (-not $type) { continue }
  $childBounds=[PolonDesktop]::Bounds($child)
  $password=$type -eq 'ControlType.Edit' -and (([PolonDesktop]::GetWindowStyle($child,-16) -band 0x20) -ne 0)
  $name=if($password){'[password]'}elseif($type -eq 'ControlType.Edit'){'Text field'}else{[PolonDesktop]::Title($child)}
  if ($type -eq 'ControlType.Button' -and -not $name) { $name='Button' }
  $duplicate=$false
  foreach($existing in $elements) { if ([Math]::Abs([double]$existing.x - ($childBounds[0]-$bounds[0])) -lt 3 -and [Math]::Abs([double]$existing.y - ($childBounds[1]-$bounds[1])) -lt 3 -and $existing.type -eq $type) { $duplicate=$true; break } }
  if (-not $duplicate) { $elements.Add(@{name=$name;value='';type=$type;password=$password;enabled=[PolonDesktop]::IsWindowEnabled($child);x=$childBounds[0]-$bounds[0];y=$childBounds[1]-$bounds[1];width=$childBounds[2];height=$childBounds[3]}) }
 }
 $scale=1.0
 if ($bounds[2] -gt 1280) {$scale=1280.0/$bounds[2]}
 if ($bounds[3] -gt 960 -and 960.0/$bounds[3] -lt $scale) {$scale=960.0/$bounds[3]}
 $iw=[Math]::Max(1,[int][Math]::Round($bounds[2]*$scale));$ih=[Math]::Max(1,[int][Math]::Round($bounds[3]*$scale))
  $png=$null
  if ($request.captureImage -ne $false) {
   $bitmap=New-Object Drawing.Bitmap($bounds[2],$bounds[3])
   $graphics=[Drawing.Graphics]::FromImage($bitmap)
   try {
    if ([PolonDesktop]::IsTaskbar($h)) {$graphics.CopyFromScreen($bounds[0],$bounds[1],0,0,(New-Object Drawing.Size($bounds[2],$bounds[3])),[Drawing.CopyPixelOperation]::SourceCopy)}
    else {$dc=$graphics.GetHdc();try {if(-not [PolonDesktop]::PrintWindow($h,$dc,2) -and -not [PolonDesktop]::PrintWindow($h,$dc,0)){throw ('Window capture failed: '+[Runtime.InteropServices.Marshal]::GetLastWin32Error()+'. No desktop fallback is used.')}}finally{$graphics.ReleaseHdc($dc)}}
   } finally {$graphics.Dispose()}
   $small=New-Object Drawing.Bitmap($iw,$ih);$g=[Drawing.Graphics]::FromImage($small)
   try {$g.DrawImage($bitmap,0,0,$iw,$ih)} finally {$g.Dispose();$bitmap.Dispose()}
   $stream=New-Object IO.MemoryStream
   try {$small.Save($stream,[Drawing.Imaging.ImageFormat]::Png);$png=[Convert]::ToBase64String($stream.ToArray())}finally{$stream.Dispose();$small.Dispose()}
  }
 $captureTitle=[PolonDesktop]::Title($h);if([PolonDesktop]::IsTaskbar($h)){$captureTitle='Windows taskbar'}
  $payload=@{windowId=[string]$request.windowId;pid=[PolonDesktop]::Pid($h);title=$captureTitle;bounds=$bounds;imageWidth=$iw;imageHeight=$ih;elements=@($elements.ToArray())}
  if ($null -ne $png) {$payload.png=$png}
  [Console]::Write(($payload | ConvertTo-Json -Depth 8 -Compress))
} catch { [Console]::Error.Write($_.Exception.Message); exit 1 }
`;
