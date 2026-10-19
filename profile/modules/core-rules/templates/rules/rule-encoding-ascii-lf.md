- ASCII AND LF ONLY. Every authored file is 7-bit ASCII with LF line endings,
  PowerShell included. Validate .ps1 files with powershell.exe 5.1 (ParseFile),
  never with pwsh: 5.1 reads a file without a byte-order mark as ANSI, so a single
  typographic dash breaks the parse.
