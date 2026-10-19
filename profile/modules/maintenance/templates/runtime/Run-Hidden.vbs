' Run-Hidden.vbs <script.ps1> [args...]
'
' Windows PowerShell 5.1 is a console program, so a scheduled task that starts it
' directly flashes a console window before -WindowStyle Hidden takes effect.
' wscript.exe is a GUI program: WScript.Shell.Run with window style 0 starts the
' console already hidden. Waits for the script and exits with its exit code.
Option Explicit

Function QuoteArg(s)
  If Len(s) > 0 And InStr(s, " ") = 0 And InStr(s, Chr(34)) = 0 Then
    QuoteArg = s
  Else
    QuoteArg = Chr(34) & Replace(s, Chr(34), "\" & Chr(34)) & Chr(34)
  End If
End Function

Dim a, i, cmd
Set a = WScript.Arguments
If a.Count < 1 Then WScript.Quit 87
cmd = "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File " & QuoteArg(a(0))
For i = 1 To a.Count - 1
  cmd = cmd & " " & QuoteArg(a(i))
Next
WScript.Quit CreateObject("WScript.Shell").Run(cmd, 0, True)
