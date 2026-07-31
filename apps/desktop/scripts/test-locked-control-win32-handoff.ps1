param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("Baseline", "LockCycle", "WtsDisconnect", "UacDenial", "SessionZeroDenial")]
  [string]$Mode,

  [string]$HelperPath = "$PSScriptRoot\..\build\native\win32-x64\ling-locked-control-helper.exe",
  [string]$ExpectedSha256 = "",
  [switch]$RequireSigned,
  [string]$PsExecPath = "",
  [string]$Output = "",
  [int]$TimeoutSeconds = 600
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Assert-AbsoluteExistingFile {
  param([string]$Path, [string]$Label)
  if (-not [IO.Path]::IsPathRooted($Path) -or -not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    throw "$Label must be an absolute existing file."
  }
}

function Get-HelperSession {
  param([string]$Path)
  $Json = '{"command":"session","platform":"win32"}' | & $Path 2>$null
  if ($LASTEXITCODE -ne 0 -or -not $Json) {
    throw "locked_control_native_helper_session_failed"
  }
  $Value = $Json | ConvertFrom-Json
  $Names = @($Value.PSObject.Properties.Name | Sort-Object)
  $ExpectedNames = @("platform", "sessionActive", "sessionBindingDigest", "sessionLocked")
  if ((Compare-Object $Names $ExpectedNames).Count -ne 0
      -or $Value.platform -ne "win32"
      -or $Value.sessionBindingDigest -notmatch '^[a-f0-9]{64}$'
      -or $Value.sessionActive -isnot [bool]
      -or $Value.sessionLocked -isnot [bool]) {
    throw "locked_control_native_helper_session_invalid"
  }
  return $Value
}

function Get-NegativeAttestation {
  param([string]$Path, [string]$Digest)
  $Request = [ordered]@{
    command = "attest"
    platform = "win32"
    expectedSessionBindingDigest = $Digest
    lockEpoch = 1
    providerGeneration = 2
  } | ConvertTo-Json -Compress
  $Value = $Request | & $Path 2>$null | ConvertFrom-Json
  if ($LASTEXITCODE -ne 0
      -or $Value.platform -ne "win32"
      -or $Value.sessionBindingDigest -ne $Digest
      -or $Value.lockEpoch -ne 1
      -or $Value.providerGeneration -ne 2
      -or $Value.userDesktopTargeted
      -or $Value.captureReady
      -or $Value.inputReady
      -or $Value.secureSurfaceExcluded) {
    throw "locked_control_native_helper_attestation_must_remain_negative"
  }
  return $Value
}

function Test-MediumIntegrity {
  $Groups = & "$env:SystemRoot\System32\whoami.exe" /groups 2>$null | Out-String
  return $LASTEXITCODE -eq 0 -and $Groups -match 'S-1-16-8192'
}

function Wait-ForUnlockedSession {
  param([string]$Path, [datetime]$Deadline)
  do {
    $Session = Get-HelperSession -Path $Path
    if ($Session.sessionActive -and -not $Session.sessionLocked) {
      return $Session
    }
    Start-Sleep -Milliseconds 500
  } while ([DateTime]::UtcNow -lt $Deadline)
  throw "locked_control_unlock_observation_timed_out"
}

function Invoke-UacProbe {
  param([string]$Path)
  $Job = Start-Job -ScriptBlock {
    param([string]$NativeHelper)
    for ($Index = 0; $Index -lt 240; $Index += 1) {
      try {
        $Json = '{"command":"session","platform":"win32"}' | & $NativeHelper 2>$null
        if ($LASTEXITCODE -eq 0 -and $Json) {
          $Value = $Json | ConvertFrom-Json
          [pscustomobject]@{
            active = [bool]$Value.sessionActive
            locked = [bool]$Value.sessionLocked
          }
        }
      } catch {}
      Start-Sleep -Milliseconds 250
    }
  } -ArgumentList $Path
  try {
    while ($Job.State -eq "NotStarted") { Start-Sleep -Milliseconds 100 }
    try {
      Start-Process "$env:SystemRoot\System32\cmd.exe" -ArgumentList "/c exit 0" -Verb RunAs | Out-Null
    } catch {
      # Expected when the attended operator selects No on the UAC prompt.
    }
    Start-Sleep -Milliseconds 750
    $Samples = @(Receive-Job -Job $Job -Keep | Where-Object { $_ -and $_.PSObject.Properties.Name -contains "locked" })
    $Denied = @($Samples | Where-Object { $_.locked -and -not $_.active })
    if ($Denied.Count -eq 0) {
      throw "locked_control_uac_secure_desktop_denial_not_observed"
    }
    return [ordered]@{
      samples = $Samples.Count
      deniedSamples = $Denied.Count
    }
  } finally {
    Stop-Job -Job $Job -ErrorAction SilentlyContinue
    Remove-Job -Job $Job -Force -ErrorAction SilentlyContinue
  }
}

function Invoke-SessionZeroProbe {
  param([string]$Path, [string]$PsExec)
  Assert-AbsoluteExistingFile -Path $PsExec -Label "PsExecPath"
  $Lines = @('{"command":"session","platform":"win32"}' |
    & $PsExec -accepteula -nobanner -s -i 0 $Path 2>$null)
  if ($LASTEXITCODE -ne 0) {
    throw "locked_control_session_zero_probe_failed"
  }
  $Json = $Lines | Where-Object { $_ -match '^\s*\{' } | Select-Object -Last 1
  if (-not $Json) {
    throw "locked_control_session_zero_probe_missing_json"
  }
  $Value = $Json | ConvertFrom-Json
  if ($Value.platform -ne "win32" -or $Value.sessionActive -or -not $Value.sessionLocked) {
    throw "locked_control_session_zero_must_be_denied"
  }
  return [ordered]@{ sessionActive = $false; sessionLocked = $true }
}

Assert-AbsoluteExistingFile -Path $HelperPath -Label "HelperPath"
if ($TimeoutSeconds -lt 30 -or $TimeoutSeconds -gt 3600) {
  throw "TimeoutSeconds must be between 30 and 3600."
}

$HelperSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $HelperPath).Hash.ToLowerInvariant()
if ($ExpectedSha256 -and $HelperSha256 -ne $ExpectedSha256.ToLowerInvariant()) {
  throw "locked_control_native_helper_hash_mismatch"
}
$Signature = Get-AuthenticodeSignature -FilePath $HelperPath
if ($RequireSigned -and $Signature.Status -ne "Valid") {
  throw "locked_control_native_helper_signature_required"
}

$MediumIntegrity = Test-MediumIntegrity
if ($Mode -ne "SessionZeroDenial" -and -not $MediumIntegrity) {
  throw "Run the interactive handoff from a standard Medium-IL Windows user session."
}

$Baseline = Get-HelperSession -Path $HelperPath
if (-not $Baseline.sessionActive -or $Baseline.sessionLocked) {
  throw "locked_control_baseline_requires_unlocked_active_default_desktop"
}
$NegativeAttestation = Get-NegativeAttestation -Path $HelperPath -Digest $Baseline.sessionBindingDigest
$Observation = [ordered]@{}

switch ($Mode) {
  "Baseline" {
    $Observation.baselineReady = $true
  }
  "LockCycle" {
    & "$env:SystemRoot\System32\rundll32.exe" user32.dll,LockWorkStation
    if ($LASTEXITCODE -ne 0) { throw "locked_control_lock_workstation_failed" }
    Start-Sleep -Milliseconds 1500
    $DuringLock = Get-HelperSession -Path $HelperPath
    if ($DuringLock.sessionActive -or -not $DuringLock.sessionLocked) {
      throw "locked_control_winlogon_denial_not_observed"
    }
    $AfterUnlock = Wait-ForUnlockedSession -Path $HelperPath -Deadline ([DateTime]::UtcNow.AddSeconds($TimeoutSeconds))
    $Observation.winlogonDenied = $true
    $Observation.sessionContinuity = $AfterUnlock.sessionBindingDigest -eq $Baseline.sessionBindingDigest
  }
  "WtsDisconnect" {
    & "$env:SystemRoot\System32\tsdiscon.exe"
    if ($LASTEXITCODE -ne 0) { throw "locked_control_wts_disconnect_failed" }
    Start-Sleep -Milliseconds 1500
    $DuringDisconnect = Get-HelperSession -Path $HelperPath
    if ($DuringDisconnect.sessionActive -or -not $DuringDisconnect.sessionLocked) {
      throw "locked_control_wts_disconnect_denial_not_observed"
    }
    $AfterReconnect = Wait-ForUnlockedSession -Path $HelperPath -Deadline ([DateTime]::UtcNow.AddSeconds($TimeoutSeconds))
    $Observation.wtsDisconnectDenied = $true
    $Observation.sessionContinuity = $AfterReconnect.sessionBindingDigest -eq $Baseline.sessionBindingDigest
  }
  "UacDenial" {
    $Observation.uacSecureDesktop = Invoke-UacProbe -Path $HelperPath
  }
  "SessionZeroDenial" {
    if (-not $PsExecPath) { throw "PsExecPath is required for SessionZeroDenial." }
    $Observation.sessionZero = Invoke-SessionZeroProbe -Path $HelperPath -PsExec $PsExecPath
  }
}

$Report = [ordered]@{
  schemaVersion = 1
  runId = [Guid]::NewGuid().ToString("D")
  observedAt = [DateTime]::UtcNow.ToString("o")
  mode = $Mode
  platform = "win32"
  architecture = "x64"
  osVersion = [Environment]::OSVersion.Version.ToString()
  helperSha256 = $HelperSha256
  signatureStatus = $Signature.Status.ToString()
  signerThumbprint = $(if ($Signature.SignerCertificate) { $Signature.SignerCertificate.Thumbprint.ToLowerInvariant() } else { $null })
  mediumIntegrity = $MediumIntegrity
  contentFree = $true
  negativeAttestation = [ordered]@{
    userDesktopTargeted = [bool]$NegativeAttestation.userDesktopTargeted
    captureReady = [bool]$NegativeAttestation.captureReady
    inputReady = [bool]$NegativeAttestation.inputReady
    secureSurfaceExcluded = [bool]$NegativeAttestation.secureSurfaceExcluded
  }
  observation = $Observation
  productCapability = "disabled_by_build"
  acceptance = "handoff_probe_only"
}

$JsonReport = $Report | ConvertTo-Json -Depth 6
if ($Output) {
  if (-not [IO.Path]::IsPathRooted($Output)) { throw "Output must be absolute." }
  $Parent = Split-Path -Parent $Output
  New-Item -ItemType Directory -Force -Path $Parent | Out-Null
  [IO.File]::WriteAllText($Output, "$JsonReport`r`n", [Text.UTF8Encoding]::new($false))
}
$JsonReport
