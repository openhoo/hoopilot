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
$ChecksumAttempts = 12
$ChecksumRetrySeconds = 5

function Find-ChecksumLine {
  param(
    [string]$Sums,
    [string]$AssetName
  )

  foreach ($candidate in ([regex]::Split($Sums, '\r?\n'))) {
    $parts = $candidate.Trim() -split '\s+', 2
    if ($parts.Count -lt 2) { continue }

    $name = $parts[1].Trim()
    if ($name.StartsWith('*')) {
      $name = $name.Substring(1)
    }
    if ($name -eq $AssetName) {
      return $candidate
    }
  }

  return $null
}

function Get-ChecksumLine {
  param(
    [string]$BaseUrl,
    [string]$AssetName
  )

  $lastError = $null
  $sumsFile = Join-Path ([System.IO.Path]::GetTempPath()) ("hoopilot-" + [System.Guid]::NewGuid().ToString('N') + '.SHA256SUMS')
  for ($attempt = 1; $attempt -le $ChecksumAttempts; $attempt++) {
    try {
      Invoke-WebRequest -UseBasicParsing -Uri "$BaseUrl/SHA256SUMS" -OutFile $sumsFile
      $sums = Get-Content -LiteralPath $sumsFile -Raw -Encoding UTF8
      $line = Find-ChecksumLine -Sums $sums -AssetName $AssetName
      if ($line) {
        Remove-Item -Force $sumsFile -ErrorAction SilentlyContinue
        return $line
      }
      $lastError = "no checksum for $AssetName in SHA256SUMS"
    } catch {
      $lastError = "could not download SHA256SUMS: $($_.Exception.Message)"
    }

    if ($attempt -lt $ChecksumAttempts) {
      Write-Host "Checksum is not ready yet; retrying in $ChecksumRetrySeconds seconds..."
      Start-Sleep -Seconds $ChecksumRetrySeconds
    }
  }

  Remove-Item -Force $sumsFile -ErrorAction SilentlyContinue
  throw $lastError
}

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
  $line = Get-ChecksumLine -BaseUrl $base -AssetName $asset
  $expected = ($line.Trim() -split '\s+', 2)[0].ToLower()
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
