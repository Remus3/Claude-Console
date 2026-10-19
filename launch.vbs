' Claude Console launcher: starts the server hidden (no console window) and opens
' the app window. A second launch only opens another window on the running server.
' Node comes from PATH, else the standard Node.js install location.
Option Explicit
Dim sh, fso, here, node, dir, fallback
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
here = fso.GetParentFolderName(WScript.ScriptFullName)
node = ""
For Each dir In Split(sh.ExpandEnvironmentStrings("%PATH%"), ";")
  dir = Replace(Trim(dir), """", "")
  If node = "" And dir <> "" Then
    If fso.FileExists(fso.BuildPath(dir, "node.exe")) Then node = fso.BuildPath(dir, "node.exe")
  End If
Next
fallback = sh.ExpandEnvironmentStrings("%ProgramFiles%\nodejs\node.exe")
If node = "" And fso.FileExists(fallback) Then node = fallback
If node = "" Then
  MsgBox "Node.js was not found. Install the LTS from https://nodejs.org or run install.ps1, then try again.", 16, "Claude Console"
  WScript.Quit 1
End If
sh.CurrentDirectory = here
sh.Run """" & node & """ """ & here & "\server\server.js"" --open", 0, False
