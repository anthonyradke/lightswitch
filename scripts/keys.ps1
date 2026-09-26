# Dev helper: press a key chord like a real keyboard (with scan codes).
# Virtual-key codes in hex, e.g. Ctrl+Alt+2:  -Keys 11,12,32
param([string]$Keys)
Add-Type @"
using System; using System.Runtime.InteropServices;
public class K {
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll")] public static extern uint MapVirtualKey(uint code, uint type);
}
"@
$codes = @($Keys -split "," | ForEach-Object { [byte][Convert]::ToInt32($_.Trim(), 16) })
foreach ($k in $codes) { [K]::keybd_event($k, [byte][K]::MapVirtualKey($k, 0), 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 30 }
[array]::Reverse($codes)
foreach ($k in $codes) { [K]::keybd_event($k, [byte][K]::MapVirtualKey($k, 0), 2, [UIntPtr]::Zero); Start-Sleep -Milliseconds 30 }
