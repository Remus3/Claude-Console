# Claude Console setup profile: user-scope environment variable adapter.
# Target: HKCU\Environment only (never the machine scope). Called by
# installer/profile-env.js through an injected runner; tests never run this file.
#
# Arguments arrive in environment variables, never on the command line:
#   CC_ENV_OP    read | capture | set | set-secret | restore | remove
#   CC_ENV_NAME  the variable name (upper case, digits, underscore)
#   CC_ENV_KIND  String | ExpandString (set, set-secret, restore)
#   CC_ENV_FILE  a DPAPI file: capture writes the prior value into it,
#                set-secret and restore read the value from it
# A plain value (op set) arrives on STDIN only. Output is ONE JSON line holding
# presence, kind, sha256 and length - never a value.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2

function Write-Result($o) {
    [Console]::Out.WriteLine((ConvertTo-Json -InputObject $o -Compress))
}

$op = [string]$env:CC_ENV_OP
$name = [string]$env:CC_ENV_NAME
if ($name -cnotmatch '^[A-Z][A-Z0-9_]{0,63}$') { Write-Result @{ error = 'bad name' }; exit 2 }

function Get-Sha([string]$s) {
    $h = [System.Security.Cryptography.SHA256]::Create()
    $bytes = $h.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($s))
    return (($bytes | ForEach-Object { $_.ToString('x2') }) -join '')
}

function Get-Raw($key) {
    return $key.GetValue($name, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
}

function Get-State {
    $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $false)
    try {
        $v = Get-Raw $key
        if ($null -eq $v) { return @{ present = $false } }
        $s = [string]$v
        return @{ present = $true; kind = [string]$key.GetValueKind($name); sha256 = (Get-Sha $s); length = $s.Length }
    } finally { $key.Close() }
}

function Get-Kind([string]$k) {
    if ($k -eq 'ExpandString') { return [Microsoft.Win32.RegistryValueKind]::ExpandString }
    if ($k -eq 'String') { return [Microsoft.Win32.RegistryValueKind]::String }
    throw 'bad kind'
}

function Protect-ToFile([string]$s, [string]$file) {
    $tmp = $file + '.tmp'
    if ($s.Length -eq 0) {
        $text = 'EMPTY'
    } else {
        $ss = ConvertTo-SecureString -String $s -AsPlainText -Force
        $text = ConvertFrom-SecureString -SecureString $ss
    }
    [System.IO.File]::WriteAllText($tmp, $text, [System.Text.Encoding]::ASCII)
    Move-Item -LiteralPath $tmp -Destination $file -Force
}

function Unprotect-File([string]$file) {
    $text = ([System.IO.File]::ReadAllText($file)).Trim()
    if ($text -eq 'EMPTY') { return '' }
    $ss = ConvertTo-SecureString -String $text
    $b = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($ss)
    try { return [System.Runtime.InteropServices.Marshal]::PtrToStringBSTR($b) }
    finally { [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b) }
}

function Send-SettingChange {
    # WM_SETTINGCHANGE "Environment" so new terminals and Explorer see the change.
    if (-not ('CcEnvBroadcast' -as [type])) {
        Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class CcEnvBroadcast {
    [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);
}
'@
    }
    $r = [UIntPtr]::Zero
    [void][CcEnvBroadcast]::SendMessageTimeout([IntPtr]0xffff, 0x1A, [UIntPtr]::Zero, 'Environment', 2, 5000, [ref]$r)
}

function Set-Value([string]$v) {
    $kind = Get-Kind ([string]$env:CC_ENV_KIND)
    $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
    try { $key.SetValue($name, $v, $kind) } finally { $key.Close() }
    Send-SettingChange
}

switch ($op) {
    'read' { Write-Result (Get-State) }
    'capture' {
        $s = Get-State
        if ($s.present) {
            $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $false)
            try { $raw = [string](Get-Raw $key) } finally { $key.Close() }
            Protect-ToFile $raw ([string]$env:CC_ENV_FILE)
        }
        Write-Result $s
    }
    'set' {
        $reader = New-Object System.IO.StreamReader([Console]::OpenStandardInput(), (New-Object System.Text.UTF8Encoding $false))
        $v = $reader.ReadToEnd()
        if ($v.Length -eq 0) { Write-Result @{ error = 'empty value' }; exit 2 }
        Set-Value $v
        Write-Result (Get-State)
    }
    { $_ -eq 'set-secret' -or $_ -eq 'restore' } {
        Set-Value (Unprotect-File ([string]$env:CC_ENV_FILE))
        Write-Result (Get-State)
    }
    'remove' {
        $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
        try { $key.DeleteValue($name, $false) } finally { $key.Close() }
        Send-SettingChange
        Write-Result (Get-State)
    }
    default { Write-Result @{ error = 'bad op' }; exit 2 }
}
