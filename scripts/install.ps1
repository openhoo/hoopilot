# hoopilot installer for Windows (PowerShell).
#
#   irm https://raw.githubusercontent.com/openhoo/hoopilot/main/scripts/install.ps1 | iex
#
# With arguments (iex cannot pass params, so wrap in a scriptblock):
#   & ([scriptblock]::Create((irm https://raw.githubusercontent.com/openhoo/hoopilot/main/scripts/install.ps1))) -Version 0.2.5
param(
  [string]$Version = $(if ($env:HOOPILOT_VERSION) { $env:HOOPILOT_VERSION } else { 'latest' }),
  [string]$InstallDir = $(if ($env:HOOPILOT_INSTALL_DIR) { $env:HOOPILOT_INSTALL_DIR } else { "$env:LOCALAPPDATA\Programs\hoopilot" }),
  [switch]$NoPathUpdate
)
$ErrorActionPreference = 'Stop'

# Windows PowerShell 5.1 may negotiate TLS 1.0 by default; GitHub requires 1.2+.
if ($PSVersionTable.PSVersion.Major -lt 6) {
  [Net.ServicePointManager]::SecurityProtocol =
    [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
}

$Repo = 'openhoo/hoopilot'
$Bin = 'hoopilot'

# --- detect arch (registry value is correct even under x64 emulation on ARM64) ---
$procArch = (Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager\Environment').PROCESSOR_ARCHITECTURE
switch ($procArch) {
  'AMD64' { $target = 'windows-x64' }
  'ARM64' { $target = 'windows-arm64' }
  'x86'   { $target = 'windows-x64' } # 32-bit shell on a 64-bit OS
  default { throw "unsupported architecture: $procArch" }
}
$asset = "$Bin-$target.exe"

# --- resolve release base URL ---
if ($Version -eq 'latest') {
  $base = "https://github.com/$Repo/releases/latest/download"
} else {
  $tag = if ($Version.StartsWith('v')) { $Version } else { "v$Version" }
  $base = "https://github.com/$Repo/releases/download/$tag"
}

New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
$exe = Join-Path $InstallDir "$Bin.exe"
$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("hoopilot-" + [System.Guid]::NewGuid().ToString('N') + '.exe')

Write-Host "Downloading $asset ($Version)..."
try {
  Invoke-WebRequest -UseBasicParsing -Uri "$base/$asset" -OutFile $tmp
} catch {
  throw "download failed: $base/$asset`n$($_.Exception.Message)"
}

# --- verify checksum ---
try {
  $sums = (Invoke-WebRequest -UseBasicParsing -Uri "$base/SHA256SUMS").Content
  $line = ($sums -split "`n") | Where-Object { $_ -match "\s\*?$([regex]::Escape($asset))\s*$" } | Select-Object -First 1
  if (-not $line) { throw "no checksum for $asset in SHA256SUMS" }
  $expected = ($line -split '\s+')[0].ToLower()
  $actual = (Get-FileHash -Algorithm SHA256 -Path $tmp).Hash.ToLower()
  if ($expected -ne $actual) {
    throw "checksum mismatch for $asset (expected $expected, got $actual)"
  }
  Write-Host "Checksum verified."
} catch {
  Remove-Item -Force $tmp -ErrorAction SilentlyContinue
  throw "could not verify checksum: $($_.Exception.Message)"
}

Move-Item -Force -Path $tmp -Destination $exe
Write-Host "Installed $Bin to $exe"

# --- add InstallDir to the user PATH (writing the registry directly so an
#     existing REG_EXPAND_SZ value keeps its %VAR% tokens instead of being
#     flattened to REG_SZ, which [Environment]::SetEnvironmentVariable would do) ---
if (-not $NoPathUpdate) {
  $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
  if (-not $key) { $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment') }
  try {
    $rawPath = [string]$key.GetValue(
      'Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
    $kind = try { $key.GetValueKind('Path') } catch { [Microsoft.Win32.RegistryValueKind]::ExpandString }
    if (($rawPath -split ';') -notcontains $InstallDir) {
      $newPath = if ([string]::IsNullOrEmpty($rawPath)) { $InstallDir } else { "$rawPath;$InstallDir" }
      $useKind = if ($kind -eq [Microsoft.Win32.RegistryValueKind]::String) {
        [Microsoft.Win32.RegistryValueKind]::String
      } else {
        [Microsoft.Win32.RegistryValueKind]::ExpandString
      }
      $key.SetValue('Path', $newPath, $useKind)
      $env:Path = "$env:Path;$InstallDir"
      # Best-effort broadcast so new processes pick up the change without re-login.
      try {
        if (-not ('Win32.NativeMethods' -as [type])) {
          Add-Type -Namespace Win32 -Name NativeMethods -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("user32.dll", SetLastError=true, CharSet=System.Runtime.InteropServices.CharSet.Auto)]
public static extern System.IntPtr SendMessageTimeout(System.IntPtr hWnd, uint Msg, System.UIntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out System.UIntPtr lpdwResult);
'@
        }
        $result = [System.UIntPtr]::Zero
        [void][Win32.NativeMethods]::SendMessageTimeout([System.IntPtr]0xffff, 0x1a, [System.UIntPtr]::Zero, 'Environment', 2, 5000, [ref]$result)
      } catch { }
      Write-Host "Added $InstallDir to your user PATH (restart your terminal to pick it up)."
    }
  } finally {
    $key.Close()
  }
}

# Post-install smoke test: never let a launch hiccup make a good install look failed.
try {
  & $exe --version | Out-Null
} catch {
  Write-Warning "Installed, but '$Bin --version' did not run cleanly: $($_.Exception.Message)"
}
Write-Host "Run: $Bin --help    (update later with: $Bin update)"
