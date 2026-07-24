[CmdletBinding()]
param(
  [ValidateSet("Preflight", "Full")]
  [string]$Mode = "Preflight",

  [string]$HandoffManifest,

  [string]$Output,

  [string]$LingAppPath,
  [string]$LingInstallerPath,
  [string]$ProviderBinary
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
if (Get-Variable -Name PSNativeCommandUseErrorActionPreference -ErrorAction SilentlyContinue) {
  $PSNativeCommandUseErrorActionPreference = $false
}

$Mode = if (-not [string]::IsNullOrWhiteSpace($HandoffManifest)) {
  "Full"
} elseif ($Mode -ieq "Full") {
  "Full"
} else {
  "Preflight"
}
$CandidateManifest = $null
$ReleasePolicy = $null
$ExpectedCandidateCommit = $null
$ExpectedRepositoryRoot = $null
$ExpectedReleasePolicySha256 = $null
$WindowsVersionEvidence = $null
$DisplayEvidence = $null
$NarratorEvidence = $null
$NvdaEvidence = $null
$SmartScreenEvidence = $null
$InstallLifecycleEvidence = $null
$acceptanceRunner = $MyInvocation.MyCommand.Path
$scriptDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
$desktopRoot = (Resolve-Path (Join-Path $scriptDirectory "..")).Path
$repoRoot = (Resolve-Path (Join-Path $scriptDirectory "..\..\..")).Path
$reportModule = Join-Path $scriptDirectory "windows-acceptance-report.mjs"
$handoffLoader = Join-Path $scriptDirectory "load-windows-cell-handoff.mjs"
$providerVerifier = Join-Path $scriptDirectory "verify-windows-cua-driver-provider.mjs"
$providerSmokeRunner = Join-Path $scriptDirectory "run-windows-provider-smoke.mjs"
$releaseHarnessRelativePaths = @(
  "apps/desktop/tests/finalize-windows-signed-acceptance.mjs",
  "apps/desktop/tests/load-windows-cell-handoff.mjs",
  "apps/desktop/tests/produce-windows-acceptance-handoff.mjs",
  "apps/desktop/tests/run-windows-acceptance.ps1",
  "apps/desktop/tests/run-windows-provider-smoke.mjs",
  "apps/desktop/tests/verify-windows-cua-driver-provider.mjs",
  "apps/desktop/tests/verify-windows-internal-attestations.mjs",
  "apps/desktop/tests/verify-windows-release-attestations.mjs",
  "apps/desktop/tests/windows-acceptance-report.mjs",
  "apps/desktop/tests/windows-handoff-contracts.mjs",
  "apps/desktop/tests/windows-provider-smoke-support.mjs",
  "apps/desktop/tests/windows-release-evidence-contracts.mjs"
)
$nodePath = $null
if ($Mode -eq "Full") {
  if ([string]::IsNullOrWhiteSpace($HandoffManifest)) {
    throw "Full mode accepts only -HandoffManifest <windows-cell-handoff.json>"
  }
} elseif ([string]::IsNullOrWhiteSpace($Output)) {
  throw "Preflight mode requires -Output"
}

if (-not [System.Runtime.InteropServices.RuntimeInformation]::IsOSPlatform(
  [System.Runtime.InteropServices.OSPlatform]::Windows
)) {
  throw "run-windows-acceptance.ps1 requires Windows; use a PowerShell parser for non-Windows static validation"
}

function Stop-NativeProcessTree {
  param([Parameter(Mandatory = $true)][int]$ProcessId)

  if ($ProcessId -le 0) {
    return
  }
  $taskkillPath = Join-Path $env:WINDIR "System32\taskkill.exe"
  if (-not (Test-Path -LiteralPath $taskkillPath -PathType Leaf)) {
    return
  }
  try {
    & $taskkillPath /PID $ProcessId /T /F *> $null
  } catch {
    # The timeout remains a failure even if best-effort cleanup itself fails.
  }
}

function Test-PathWithinRoot {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Root
  )

  $resolvedPath = [System.IO.Path]::GetFullPath($Path)
  $resolvedRoot = [System.IO.Path]::GetFullPath($Root).TrimEnd('\', '/') + [System.IO.Path]::DirectorySeparatorChar
  return $resolvedPath.StartsWith($resolvedRoot, [System.StringComparison]::OrdinalIgnoreCase)
}

function Resolve-TrustedToolPath {
  param([Parameter(Mandatory = $true)][string]$Name)

  $command = Get-Command $Name -CommandType Application -ErrorAction Stop |
    Select-Object -First 1
  if ($null -eq $command -or -not [System.IO.Path]::IsPathRooted($command.Source)) {
    throw "$Name executable must resolve to an absolute path"
  }
  $allowedRoots = @(
    $env:ProgramFiles,
    ${env:ProgramFiles(x86)},
    $env:RUNNER_TOOL_CACHE
  ) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
  if (-not ($allowedRoots | Where-Object { Test-PathWithinRoot -Path $command.Source -Root $_ })) {
    throw "$Name executable resolved outside a trusted tool root: $($command.Source)"
  }
  return (Resolve-Path -LiteralPath $command.Source).Path
}

$nodePath = Resolve-TrustedToolPath -Name "node"
$gitPath = Resolve-TrustedToolPath -Name "git"

function Resolve-OptionalCommandPath {
  param([AllowNull()][string]$Value)

  if ([string]::IsNullOrWhiteSpace($Value)) {
    return $null
  }
  if (Test-Path -LiteralPath $Value -PathType Leaf) {
    return (Resolve-Path -LiteralPath $Value).Path
  }
  $command = Get-Command $Value -CommandType Application -ErrorAction SilentlyContinue |
    Select-Object -First 1
  if ($command) {
    return $command.Source
  }
  return $null
}

function Find-DefaultInstallerPath {
  $releaseDirectory = Join-Path $desktopRoot "release"
  if (-not (Test-Path -LiteralPath $releaseDirectory -PathType Container)) {
    return $null
  }
  $installers = @(
    Get-ChildItem -LiteralPath $releaseDirectory -File -Filter "*.exe" -ErrorAction SilentlyContinue |
      Where-Object { $_.Name -notmatch "__uninstaller|^Uninstall" } |
      Sort-Object Name
  )
  if ($installers.Count -eq 1) {
    return $installers[0].FullName
  }
  return $null
}

function Get-CertificateSha256 {
  param([AllowNull()][System.Security.Cryptography.X509Certificates.X509Certificate2]$Certificate)

  if ($null -eq $Certificate) {
    return $null
  }
  $sha256 = [System.Security.Cryptography.SHA256]::Create()
  try {
    $digest = $sha256.ComputeHash($Certificate.RawData)
    return ([System.BitConverter]::ToString($digest)).Replace("-", "").ToLowerInvariant()
  } finally {
    $sha256.Dispose()
  }
}

function Get-SignatureEvidence {
  param([Parameter(Mandatory = $true)][string]$Path)

  try {
    $signature = Microsoft.PowerShell.Security\Get-AuthenticodeSignature -FilePath $Path
    return [ordered]@{
      checked = $true
      status = [string]$signature.Status
      signerSubject = if ($signature.SignerCertificate) {
        [string]$signature.SignerCertificate.Subject
      } else {
        $null
      }
      certificateSha256 = Get-CertificateSha256 -Certificate $signature.SignerCertificate
      error = $null
    }
  } catch {
    return [ordered]@{
      checked = $false
      status = $null
      signerSubject = $null
      certificateSha256 = $null
      error = $_.Exception.Message
    }
  }
}

function Get-ArtifactEvidence {
  param([AllowNull()][string]$Path)

  if ([string]::IsNullOrWhiteSpace($Path) -or -not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    return [ordered]@{
      path = if ([string]::IsNullOrWhiteSpace($Path)) { $null } else { $Path }
      exists = $false
      sha256 = $null
      signature = [ordered]@{
        checked = $false
        status = $null
        signerSubject = $null
        certificateSha256 = $null
        error = "file_missing"
      }
    }
  }

  $resolvedPath = (Resolve-Path -LiteralPath $Path).Path
  $hash = Microsoft.PowerShell.Utility\Get-FileHash -LiteralPath $resolvedPath -Algorithm SHA256
  return [ordered]@{
    path = $resolvedPath
    exists = $true
    sha256 = $hash.Hash.ToLowerInvariant()
    signature = Get-SignatureEvidence -Path $resolvedPath
  }
}

function Assert-FullLooseArtifactDigests {
  param(
    [Parameter(Mandatory = $true)][System.Collections.IDictionary]$Handoff,
    [Parameter(Mandatory = $true)][System.Collections.IDictionary]$Artifacts
  )

  foreach ($role in @(
    "lingInstaller",
    "lingApp",
    "provider",
    "providerSeal",
    "providerCatalog"
  )) {
    $artifact = $Artifacts[$role]
    $expectedSha256 = [string]$Handoff.expected.artifacts[$role]
    if (
      $null -eq $artifact -or
      $artifact.exists -ne $true -or
      [string]$artifact.sha256 -cne $expectedSha256
    ) {
      throw "windows_handoff_loose_artifact_digest_mismatch:$role"
    }
  }
}

function Get-EvidenceReference {
  param([AllowNull()][string]$Path)

  if ([string]::IsNullOrWhiteSpace($Path) -or -not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    return [ordered]@{ path = $null; sha256 = $null }
  }
  $resolvedPath = (Resolve-Path -LiteralPath $Path).Path
  $hash = Microsoft.PowerShell.Utility\Get-FileHash -LiteralPath $resolvedPath -Algorithm SHA256
  return [ordered]@{ path = $resolvedPath; sha256 = $hash.Hash.ToLowerInvariant() }
}

function Get-StructuredManualAcceptanceEvidence {
  param(
    [AllowNull()][string]$Path,
    [Parameter(Mandatory = $true)][string]$ExpectedKind,
    [Parameter(Mandatory = $true)][string]$MissingReason
  )

  $evidence = Get-EvidenceReference -Path $Path
  if ([string]::IsNullOrWhiteSpace($evidence.path)) {
    return [ordered]@{
      attempted = $false
      passed = $null
      operator = $null
      evidence = $evidence
      error = $MissingReason
    }
  }
  try {
    $document = Get-Content -LiteralPath $evidence.path -Raw | ConvertFrom-Json -Depth 32
    if ($document.schemaVersion -ne 3) {
      throw "manual_evidence_schema_version_invalid:$($document.schemaVersion)"
    }
    if ([string]$document.kind -ne $ExpectedKind) {
      throw "manual_evidence_kind_mismatch:$($document.kind)"
    }
    $outcome = [string]$document.case.outcome
    $passed = if ($outcome -eq "PASS") { $true } elseif ($outcome -eq "FAIL") { $false } else { $null }
    $result = [ordered]@{
      attempted = $true
      passed = $passed
      operator = if ($document.operator.id) { [string]$document.operator.id } else { $null }
      evidence = $evidence
      error = if ($outcome -eq "PASS") {
        if ($null -eq $document.case.error) { $null } else { [string]$document.case.error }
      } elseif ($outcome -eq "FAIL") {
        if ($document.case.error) { [string]$document.case.error } else { "acceptance_failed" }
      } else {
        "acceptance_outcome_invalid"
      }
    }
    if ($ExpectedKind -eq "ling.windows.full-evidence.install-lifecycle") {
      $result["cleanBaselinePassed"] = [bool]$document.details.cleanBaselinePassed
      $result["installPassed"] = [bool]$document.details.installPassed
      $result["installedSmokePassed"] = [bool]$document.details.installedSmokePassed
      $result["updatePassed"] = [bool]$document.details.updatePassed
      $result["uninstallPassed"] = [bool]$document.details.uninstallPassed
    }
    return $result
  } catch {
    return [ordered]@{
      attempted = $true
      passed = $null
      operator = $null
      evidence = $evidence
      error = "manual_evidence_invalid:$($_.Exception.Message)"
    }
  }
}

function Invoke-NativeCapture {
  param(
    [Parameter(Mandatory = $true)][string]$FilePath,
    [string[]]$ArgumentList = @(),
    [AllowNull()][string]$WorkingDirectory,
    [int]$TimeoutMilliseconds = 120000
  )

  if ($TimeoutMilliseconds -le 0) {
    throw "TimeoutMilliseconds must be positive"
  }
  $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
  $startInfo.FileName = $FilePath
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true
  if (-not [string]::IsNullOrWhiteSpace($WorkingDirectory)) {
    $startInfo.WorkingDirectory = $WorkingDirectory
  }
  $argumentListProperty = $startInfo.PSObject.Properties["ArgumentList"]
  if ($null -eq $argumentListProperty) {
    throw "PowerShell 7 or newer is required for safe native argument passing"
  }
  foreach ($argument in $ArgumentList) {
    [void]$startInfo.ArgumentList.Add([string]$argument)
  }

  $process = [System.Diagnostics.Process]::new()
  $process.StartInfo = $startInfo
  try {
    if (-not $process.Start()) {
      return [ordered]@{
        exitCode = $null
        output = $null
        error = "native_process_start_failed"
      }
    }
    $stdoutTask = $process.StandardOutput.ReadToEndAsync()
    $stderrTask = $process.StandardError.ReadToEndAsync()
    if (-not $process.WaitForExit($TimeoutMilliseconds)) {
      Stop-NativeProcessTree -ProcessId $process.Id
      [void]$process.WaitForExit(5000)
      if (-not $process.HasExited) {
        try {
          $process.Kill()
        } catch {
          # taskkill already handled the normal cleanup path.
        }
      }
      $stdout = if ($stdoutTask.IsCompleted) { $stdoutTask.Result } else { "" }
      $stderr = if ($stderrTask.IsCompleted) { $stderrTask.Result } else { "" }
      return [ordered]@{
        exitCode = $null
        output = ((@($stdout, $stderr) -join [Environment]::NewLine).Trim())
        error = "native_process_timeout:${TimeoutMilliseconds}ms"
      }
    }
    $stdout = $stdoutTask.Result
    $stderr = $stderrTask.Result
    return [ordered]@{
      exitCode = [int]$process.ExitCode
      output = ((@($stdout, $stderr) -join [Environment]::NewLine).Trim())
      error = $null
    }
  } catch {
    return [ordered]@{
      exitCode = $null
      output = $null
      error = $_.Exception.Message
    }
  } finally {
    $process.Dispose()
  }
}

function ConvertTo-ComparableToolVersion {
  param(
    [Parameter(Mandatory = $true)][string]$Value,
    [Parameter(Mandatory = $true)][string]$Label
  )

  $match = [System.Text.RegularExpressions.Regex]::Match(
    $Value,
    "(?<major>0|[1-9][0-9]*)\.(?<minor>0|[1-9][0-9]*)\.(?<patch>0|[1-9][0-9]*)"
  )
  if (-not $match.Success) {
    throw "Windows handoff $Label version is not parseable: $Value"
  }
  return [System.Version]::new(
    [int]$match.Groups["major"].Value,
    [int]$match.Groups["minor"].Value,
    [int]$match.Groups["patch"].Value
  )
}

function Assert-MinimumToolVersion {
  param(
    [Parameter(Mandatory = $true)][string]$Label,
    [Parameter(Mandatory = $true)][string]$Observed,
    [Parameter(Mandatory = $true)][string]$Requirement
  )

  $requirementMatch = [System.Text.RegularExpressions.Regex]::Match(
    $Requirement,
    "^>=(?<major>0|[1-9][0-9]*)\.(?<minor>0|[1-9][0-9]*)\.(?<patch>0|[1-9][0-9]*)$"
  )
  if (-not $requirementMatch.Success) {
    throw "Windows handoff $Label requirement is invalid: $Requirement"
  }
  $requiredVersion = [System.Version]::new(
    [int]$requirementMatch.Groups["major"].Value,
    [int]$requirementMatch.Groups["minor"].Value,
    [int]$requirementMatch.Groups["patch"].Value
  )
  $observedVersion = ConvertTo-ComparableToolVersion -Value $Observed -Label $Label
  if ($observedVersion -lt $requiredVersion) {
    throw "Windows handoff requires $Label $Requirement, observed $observedVersion"
  }
}

function Assert-RequiredToolVersions {
  param([Parameter(Mandatory = $true)][System.Collections.IDictionary]$Requirements)

  $keys = @($Requirements.Keys | ForEach-Object { [string]$_ } | Sort-Object)
  if (($keys -join ",") -ne "git,node,powershell") {
    throw "Windows handoff requiredToolVersions must contain exactly git, node, and powershell"
  }
  $nodeVersion = Invoke-NativeCapture -FilePath $nodePath `
    -ArgumentList @("--version") -WorkingDirectory $repoRoot -TimeoutMilliseconds 10000
  if ($nodeVersion.exitCode -ne 0 -or $nodeVersion.error) {
    throw "Windows handoff Node version probe failed"
  }
  $gitVersion = Invoke-NativeCapture -FilePath $gitPath `
    -ArgumentList @("--version") -WorkingDirectory $repoRoot -TimeoutMilliseconds 10000
  if ($gitVersion.exitCode -ne 0 -or $gitVersion.error) {
    throw "Windows handoff Git version probe failed"
  }
  Assert-MinimumToolVersion -Label "Node" -Observed $nodeVersion.output `
    -Requirement ([string]$Requirements["node"])
  Assert-MinimumToolVersion -Label "PowerShell" -Observed $PSVersionTable.PSVersion.ToString() `
    -Requirement ([string]$Requirements["powershell"])
  Assert-MinimumToolVersion -Label "Git" -Observed $gitVersion.output `
    -Requirement ([string]$Requirements["git"])
}

function Get-GitCommit {
  $status = Invoke-NativeCapture -FilePath $gitPath `
    -ArgumentList @("status", "--porcelain=v1", "--untracked-files=all") -WorkingDirectory $repoRoot -TimeoutMilliseconds 10000
  if ($status.exitCode -ne 0 -or $status.error) {
    throw "windows_release_harness_git_status_failed"
  }
  if (-not [string]::IsNullOrWhiteSpace($status.output)) {
    throw "windows_release_harness_worktree_dirty"
  }
  $probe = Invoke-NativeCapture -FilePath $gitPath `
    -ArgumentList @("rev-parse", "HEAD") -WorkingDirectory $repoRoot -TimeoutMilliseconds 10000
  if ($probe.exitCode -eq 0 -and $probe.output -match "^[0-9a-fA-F]{40,64}$") {
    return $probe.output.Trim().ToLowerInvariant()
  }
  throw "windows_release_harness_commit_invalid"
}

function Get-ReleaseHarnessEvidence {
  param([Parameter(Mandatory = $true)][string]$Commit)

  $paths = @($releaseHarnessRelativePaths | ForEach-Object { Join-Path $repoRoot $_ })
  $files = foreach ($path in $paths) {
    $resolved = (Resolve-Path -LiteralPath $path).Path
    if (-not (Test-PathWithinRoot -Path $resolved -Root $repoRoot)) {
      throw "windows_release_harness_script_outside_repository"
    }
    $hash = Microsoft.PowerShell.Utility\Get-FileHash -LiteralPath $resolved -Algorithm SHA256
    [ordered]@{
      name = [System.IO.Path]::GetRelativePath($repoRoot, $resolved).Replace("\", "/")
      path = $resolved
      sha256 = $hash.Hash.ToLowerInvariant()
    }
  }
  return [ordered]@{
    schemaVersion = 1
    commit = $Commit
    repositoryRoot = $repoRoot
    gitExecutable = $gitPath
    files = @($files | Sort-Object name)
  }
}

function Initialize-DisplayProbe {
  if ("Ling.WindowsAcceptance.DisplayProbe" -as [type]) {
    return
  }
  Add-Type -Language CSharp -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

namespace Ling.WindowsAcceptance {
  public sealed class DisplayRecord {
    public string Id { get; set; }
    public bool Primary { get; set; }
    public int Width { get; set; }
    public int Height { get; set; }
    public uint DpiX { get; set; }
    public uint DpiY { get; set; }
    public double ScalePercent { get; set; }
  }

  public static class DisplayProbe {
    private const uint MONITORINFOF_PRIMARY = 1;

    [StructLayout(LayoutKind.Sequential)]
    private struct RECT {
      public int Left;
      public int Top;
      public int Right;
      public int Bottom;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct MONITORINFOEX {
      public int Size;
      public RECT Monitor;
      public RECT Work;
      public uint Flags;
      [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)]
      public string DeviceName;
    }

    private delegate bool MonitorEnumProc(IntPtr monitor, IntPtr hdc, IntPtr rect, IntPtr data);

    [DllImport("user32.dll")]
    private static extern bool EnumDisplayMonitors(
      IntPtr hdc,
      IntPtr clip,
      MonitorEnumProc callback,
      IntPtr data
    );

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern bool GetMonitorInfo(IntPtr monitor, ref MONITORINFOEX info);

    [DllImport("shcore.dll")]
    private static extern int GetDpiForMonitor(
      IntPtr monitor,
      int dpiType,
      out uint dpiX,
      out uint dpiY
    );

    public static DisplayRecord[] GetDisplays() {
      var displays = new List<DisplayRecord>();
      MonitorEnumProc callback = delegate(IntPtr monitor, IntPtr hdc, IntPtr rect, IntPtr data) {
        var info = new MONITORINFOEX();
        info.Size = Marshal.SizeOf(typeof(MONITORINFOEX));
        if (!GetMonitorInfo(monitor, ref info)) {
          return true;
        }
        uint dpiX = 0;
        uint dpiY = 0;
        try {
          if (GetDpiForMonitor(monitor, 0, out dpiX, out dpiY) != 0) {
            dpiX = 0;
            dpiY = 0;
          }
        } catch (DllNotFoundException) {
          dpiX = 0;
          dpiY = 0;
        } catch (EntryPointNotFoundException) {
          dpiX = 0;
          dpiY = 0;
        }
        displays.Add(new DisplayRecord {
          Id = info.DeviceName,
          Primary = (info.Flags & MONITORINFOF_PRIMARY) != 0,
          Width = info.Monitor.Right - info.Monitor.Left,
          Height = info.Monitor.Bottom - info.Monitor.Top,
          DpiX = dpiX,
          DpiY = dpiY,
          ScalePercent = dpiX > 0 ? Math.Round(dpiX / 96.0 * 100.0, 2) : 0
        });
        return true;
      };
      if (!EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, callback, IntPtr.Zero)) {
        throw new InvalidOperationException("EnumDisplayMonitors failed");
      }
      return displays.ToArray();
    }
  }
}
"@
}

function Find-NvdaPath {
  # Never let a PATH-shadow executable satisfy the accessibility readiness gate.
  # Portable NVDA must be supplied through an explicit evidence path instead.
  $candidates = @(
    (Join-Path $env:ProgramFiles "NVDA\nvda.exe"),
    (Join-Path $env:LOCALAPPDATA "Programs\NVDA\nvda.exe")
  )
  if (${env:ProgramFiles(x86)}) {
    $candidates += Join-Path ${env:ProgramFiles(x86)} "NVDA\nvda.exe"
  }
  foreach ($candidate in $candidates) {
    if (Test-Path -LiteralPath $candidate -PathType Leaf) {
      return (Resolve-Path -LiteralPath $candidate).Path
    }
  }
  return $null
}

function Get-HostEvidence {
  $errors = [System.Collections.Generic.List[string]]::new()
  $windowsBuild = $null
  try {
    $version = Get-ItemProperty -LiteralPath "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion"
    $parts = @($version.ProductName, $version.DisplayVersion) |
      Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) }
    $build = [string]$version.CurrentBuildNumber
    if ($null -ne $version.UBR) {
      $build = "$build.$($version.UBR)"
    }
    $windowsBuild = "$(($parts -join ' ').Trim()) build $build".Trim()
  } catch {
    $errors.Add("windows_build:$($_.Exception.Message)")
    $windowsBuild = [System.Environment]::OSVersion.VersionString
  }

  $sessionId = [System.Diagnostics.Process]::GetCurrentProcess().SessionId
  $sessionName = if ($env:SESSIONNAME) { [string]$env:SESSIONNAME } else { $null }
  $locked = @(
    Get-Process -Name LogonUI -ErrorAction SilentlyContinue |
      Where-Object { $_.SessionId -eq $sessionId }
  ).Count -gt 0
  $interactive = [System.Environment]::UserInteractive -and
    $sessionId -gt 0 -and
    -not $locked -and
    $sessionName -ne "Services"

  $displays = @()
  try {
    Initialize-DisplayProbe
    $displays = @(
      [Ling.WindowsAcceptance.DisplayProbe]::GetDisplays() |
        ForEach-Object {
          [ordered]@{
            id = [string]$_.Id
            primary = [bool]$_.Primary
            width = [int]$_.Width
            height = [int]$_.Height
            dpiX = [double]$_.DpiX
            dpiY = [double]$_.DpiY
            scalePercent = [double]$_.ScalePercent
          }
        }
    )
  } catch {
    $errors.Add("display_probe:$($_.Exception.Message)")
  }

  $narratorPath = Join-Path $env:WINDIR "System32\Narrator.exe"
  $nvdaPath = Find-NvdaPath
  return [ordered]@{
    platform = "win32"
    architecture = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString().ToLowerInvariant()
    machineName = [System.Environment]::MachineName
    windowsBuild = $windowsBuild
    session = [ordered]@{
      id = $sessionId
      name = $sessionName
      interactive = $interactive
      locked = $locked
    }
    displays = $displays
    accessibility = [ordered]@{
      narrator = [ordered]@{
        available = Test-Path -LiteralPath $narratorPath -PathType Leaf
        running = $null -ne (Get-Process -Name Narrator -ErrorAction SilentlyContinue | Select-Object -First 1)
        path = if (Test-Path -LiteralPath $narratorPath -PathType Leaf) { $narratorPath } else { $null }
      }
      nvda = [ordered]@{
        available = -not [string]::IsNullOrWhiteSpace($nvdaPath)
        running = $null -ne (Get-Process -Name nvda -ErrorAction SilentlyContinue | Select-Object -First 1)
        path = $nvdaPath
      }
    }
    errors = @($errors)
  }
}

function Find-LingDesktopInstallRoots {
  $programsRoot = Join-Path $env:LOCALAPPDATA "Programs"
  if (-not (Test-Path -LiteralPath $programsRoot -PathType Container)) {
    return @()
  }
  return @(
    Get-ChildItem -LiteralPath $programsRoot -Recurse -File -Filter "Ling Stack.exe" -ErrorAction Stop |
      ForEach-Object { $_.DirectoryName } |
      Sort-Object -Unique
  )
}

function Get-InstallationResidueCount {
  param([Parameter(Mandatory = $true)][System.Collections.IDictionary]$Evidence)

  return (
    @($Evidence.lingProcesses).Count +
    @($Evidence.providerProcesses).Count +
    @($Evidence.installRoots).Count +
    @($Evidence.residualPaths).Count +
    @($Evidence.registryEntries).Count +
    @($Evidence.shortcuts).Count
  )
}

function Get-InstallationEvidence {
  $errors = [System.Collections.Generic.List[string]]::new()
  $lingProcesses = @()
  $providerProcesses = @()
  $installRoots = @()
  $residualPaths = @()
  $registryEntries = @()
  $shortcuts = @()

  try {
    $lingProcesses = @(
      Get-Process -ErrorAction Stop |
        Where-Object { $_.ProcessName -in @("Ling Stack", "LingStack") } |
        ForEach-Object { "$($_.ProcessName):$($_.Id)" }
    )
    $providerProcesses = @(
      Get-Process -ErrorAction Stop |
        Where-Object { $_.ProcessName -in @("cua-driver", "cua-driver-uia") } |
        ForEach-Object { "$($_.ProcessName):$($_.Id)" }
    )
  } catch {
    $errors.Add("process_inventory:$($_.Exception.Message)")
  }

  try {
    $installRoots = @(Find-LingDesktopInstallRoots)
  } catch {
    $errors.Add("install_root_inventory:$($_.Exception.Message)")
  }

  try {
    $knownResidualPaths = @(
      (Join-Path $env:LOCALAPPDATA "Ling Stack"),
      (Join-Path $env:APPDATA "Ling Stack"),
      (Join-Path $env:LOCALAPPDATA "ling-stack"),
      (Join-Path $env:APPDATA "ling-stack")
    )
    $residualPaths = @(
      $knownResidualPaths |
        Where-Object { Test-Path -LiteralPath $_ } |
        ForEach-Object { (Resolve-Path -LiteralPath $_).Path } |
        Sort-Object -Unique
    )
  } catch {
    $errors.Add("residual_path_inventory:$($_.Exception.Message)")
  }

  try {
    $uninstallRoots = @(
      "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*",
      "HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*",
      "HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*"
    )
    $registryEntries = @(
      @(
        foreach ($root in $uninstallRoots) {
          Get-ItemProperty -Path $root -ErrorAction Stop |
            Where-Object { [string]$_.DisplayName -like "Ling Stack*" } |
            ForEach-Object { "$($_.PSPath):$($_.DisplayName)" }
        }
      ) | Sort-Object -Unique
    )
  } catch {
    $errors.Add("registry_inventory:$($_.Exception.Message)")
  }

  try {
    $shortcutRoots = @(
      [Environment]::GetFolderPath("Desktop"),
      [Environment]::GetFolderPath("CommonDesktopDirectory"),
      [Environment]::GetFolderPath("StartMenu"),
      [Environment]::GetFolderPath("CommonStartMenu")
    ) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) -and (Test-Path -LiteralPath $_) }
    $shortcuts = @(
      @(
        foreach ($root in $shortcutRoots) {
          Get-ChildItem -LiteralPath $root -Recurse -File -Filter "*Ling Stack*.lnk" -ErrorAction Stop |
            ForEach-Object { $_.FullName }
        }
      ) | Sort-Object -Unique
    )
  } catch {
    $errors.Add("shortcut_inventory:$($_.Exception.Message)")
  }

  return [ordered]@{
    observed = $errors.Count -eq 0
    lingProcesses = $lingProcesses
    providerProcesses = $providerProcesses
    installRoots = $installRoots
    residualPaths = $residualPaths
    registryEntries = $registryEntries
    shortcuts = $shortcuts
    errors = @($errors)
  }
}

function Invoke-InstallerPayloadVerification {
  param(
    [AllowNull()][string]$InstallerPath,
    [Parameter(Mandatory = $true)][string]$ExpectedInstallerSha256,
    [Parameter(Mandatory = $true)][System.Collections.IDictionary]$ExpectedApp,
    [Parameter(Mandatory = $true)][System.Collections.IDictionary]$ExpectedProvider,
    [Parameter(Mandatory = $true)][System.Collections.IDictionary]$ExpectedProviderSeal,
    [Parameter(Mandatory = $true)][System.Collections.IDictionary]$ExpectedProviderCatalog,
    [Parameter(Mandatory = $true)][string]$ExpectedUninstallerSha256,
    [Parameter(Mandatory = $true)][System.Collections.IDictionary]$ExpectedCandidateManifest,
    [Parameter(Mandatory = $true)][System.Collections.IDictionary]$HostEvidence,
    [Parameter(Mandatory = $true)][System.Collections.IDictionary]$ReleasePolicy,
    [Parameter(Mandatory = $true)][System.Collections.IDictionary]$Baseline
  )

  if ($Mode -ne "Full") {
    return [ordered]@{
      attempted = $false
      passed = $null
      exitCode = $null
      error = "preflight_mode"
      output = $null
      report = $null
    }
  }
  if (
    [string]::IsNullOrWhiteSpace($InstallerPath) -or
    -not (Test-Path -LiteralPath $InstallerPath -PathType Leaf)
  ) {
    return [ordered]@{
      attempted = $false
      passed = $null
      exitCode = $null
      error = "ling_installer_missing"
      output = $null
      report = $null
    }
  }
  $installerEvidence = Get-ArtifactEvidence -Path $InstallerPath
  if ($installerEvidence.sha256 -cne $ExpectedInstallerSha256) {
    throw "windows_handoff_loose_artifact_digest_mismatch:lingInstaller"
  }
  foreach ($artifact in @($installerEvidence, $ExpectedApp)) {
    if (
      $artifact.exists -ne $true -or
      $artifact.signature.checked -ne $true -or
      $artifact.signature.status -ne "Valid" -or
      $artifact.signature.signerSubject -ne $ReleasePolicy.lingSignerSubject -or
      $artifact.signature.certificateSha256 -ne $ReleasePolicy.lingSignerCertificateSha256
    ) {
      return [ordered]@{
        attempted = $true
        passed = $false
        exitCode = 1
        error = "signed_installer_or_expected_app_signature_invalid"
        output = "signed installer payload roundtrip blocked before execution"
        report = $null
      }
    }
  }
  if ($Baseline.observed -ne $true -or $Baseline.errors.Count -ne 0 -or (Get-InstallationResidueCount -Evidence $Baseline) -ne 0) {
    return [ordered]@{
      attempted = $false
      passed = $null
      exitCode = $null
      error = "installer_payload_baseline_not_clean"
      output = $null
      report = $null
    }
  }

  $installRoots = @()
  $installedApp = $null
  $uninstallerEvidence = $null
  $installedProviderEvidence = $null
  $installedProviderSealEvidence = $null
  $installedProviderCatalogEvidence = $null
  $installedVendorNativeInventory = @()
  $providerVerificationEvidence = $null
  $providerSmokeEvidence = $null
  $primaryError = $null
  $cleanupError = $null
  try {
    # Residual TOCTOU: PowerShell cannot launch an EXE from a previously hashed,
    # held file handle. Rehash immediately before Process.Start and fail closed;
    # Windows VM acceptance must still run on an isolated, trusted candidate host.
    if ((Get-ArtifactEvidence -Path $InstallerPath).sha256 -cne $ExpectedInstallerSha256) {
      throw "windows_handoff_loose_artifact_digest_mismatch:lingInstaller"
    }
    $install = Invoke-NativeCapture -FilePath $InstallerPath -ArgumentList @("/S") -TimeoutMilliseconds 120000
    if ($install.exitCode -ne 0 -or $install.error) {
      throw ("signed_installer_failed:{0}" -f $(if ($install.error) { $install.error } else { $install.exitCode }))
    }
    $installRoots = @(Find-LingDesktopInstallRoots)
    if ($installRoots.Count -ne 1) {
      throw ("signed_installer_root_count_invalid:{0}" -f $installRoots.Count)
    }
    $installedAppPath = Join-Path $installRoots[0] "Ling Stack.exe"
    $uninstallers = @(
      Get-ChildItem -LiteralPath $installRoots[0] -File -Filter "Uninstall*.exe" -ErrorAction Stop |
        Sort-Object Name
    )
    if ($uninstallers.Count -ne 1) {
      throw ("signed_uninstaller_count_invalid:{0}" -f $uninstallers.Count)
    }
    $installedApp = Get-ArtifactEvidence -Path $installedAppPath
    $uninstallerEvidence = Get-ArtifactEvidence -Path $uninstallers[0].FullName
    foreach ($artifact in @($installedApp, $uninstallerEvidence)) {
      if (
        $artifact.exists -ne $true -or
        $artifact.signature.checked -ne $true -or
        $artifact.signature.status -ne "Valid" -or
        $artifact.signature.signerSubject -ne $ReleasePolicy.lingSignerSubject -or
        $artifact.signature.certificateSha256 -ne $ReleasePolicy.lingSignerCertificateSha256
      ) {
        throw "signed_installer_payload_signature_invalid"
      }
    }
    if ($installedApp.sha256 -ne $ExpectedApp.sha256) {
      throw "signed_installer_payload_app_hash_mismatch"
    }
    if ($uninstallerEvidence.sha256 -ne $ExpectedUninstallerSha256) {
      throw "signed_installer_payload_uninstaller_hash_mismatch"
    }
    $installedProviderPath = Join-Path $installRoots[0] "resources\providers\cua-driver\0.8.3-ling.1\win32-x64\payload\ling-cua-driver.exe"
    $installedProviderSealPath = Join-Path $installRoots[0] "resources\providers\cua-driver\0.8.3-ling.1\win32-x64\payload\provider-seal.json"
    $installedProviderCatalogPath = Join-Path $installRoots[0] "resources\providers\cua-driver\0.8.3-ling.1\win32-x64\provider-integrity.cat"
    $unexpectedUiAccessPath = Join-Path $installRoots[0] "resources\providers\cua-driver\0.8.3-ling.1\win32-x64\payload\cua-driver-uia.exe"
    if (Test-Path -LiteralPath $unexpectedUiAccessPath) {
      throw "signed_installer_standard_payload_contains_uiaccess"
    }
    $installedProviderEvidence = Get-ArtifactEvidence -Path $installedProviderPath
    $installedProviderSealEvidence = Get-ArtifactEvidence -Path $installedProviderSealPath
    $installedProviderCatalogEvidence = Get-ArtifactEvidence -Path $installedProviderCatalogPath
    if (
      $installedProviderEvidence.sha256 -ne $ExpectedProvider.sha256 -or
      $installedProviderSealEvidence.sha256 -ne $ExpectedProviderSeal.sha256 -or
      $installedProviderCatalogEvidence.sha256 -ne $ExpectedProviderCatalog.sha256
    ) {
      throw "signed_installer_private_provider_hash_mismatch"
    }
    if (
      $installedProviderEvidence.signature.checked -ne $true -or
      $installedProviderEvidence.signature.status -ne "Valid" -or
      $installedProviderEvidence.signature.signerSubject -ne $ReleasePolicy.providerSignerSubject -or
      $installedProviderEvidence.signature.certificateSha256 -ne $ReleasePolicy.providerSignerCertificateSha256
    ) {
      throw "signed_installer_private_provider_signature_invalid"
    }
    if (
      $installedProviderCatalogEvidence.signature.checked -ne $true -or
      $installedProviderCatalogEvidence.signature.status -ne "Valid" -or
      $installedProviderCatalogEvidence.signature.signerSubject -ne $ReleasePolicy.catalogSignerSubject -or
      $installedProviderCatalogEvidence.signature.certificateSha256 -ne $ReleasePolicy.catalogSignerCertificateSha256
    ) {
      throw "signed_installer_private_catalog_signature_invalid"
    }
    foreach ($nativeArtifact in @($ExpectedCandidateManifest.vendorNativeInventory)) {
      $relativePath = [string]$nativeArtifact.relativePath
      $installedNativePath = [System.IO.Path]::GetFullPath(
        (Join-Path $installRoots[0] $relativePath)
      )
      if (-not (Test-PathWithinRoot -Path $installedNativePath -Root $installRoots[0])) {
        throw "signed_installer_vendor_native_path_escape"
      }
      $nativeEvidence = Get-ArtifactEvidence -Path $installedNativePath
      if (
        $nativeEvidence.exists -ne $true -or
        $nativeEvidence.sha256 -ne [string]$nativeArtifact.sha256 -or
        $nativeEvidence.signature.checked -ne $true -or
        $nativeEvidence.signature.status -ne [string]$nativeArtifact.authenticodeStatus -or
        $nativeEvidence.signature.signerSubject -ne $nativeArtifact.signerSubject -or
        $nativeEvidence.signature.certificateSha256 -ne $nativeArtifact.certificateSha256
      ) {
        throw "signed_installer_vendor_native_inventory_mismatch"
      }
      $installedVendorNativeInventory += [ordered]@{
        relativePath = $relativePath.Replace("\", "/")
        path = $nativeEvidence.path
        exists = $nativeEvidence.exists
        sha256 = $nativeEvidence.sha256
        signature = $nativeEvidence.signature
      }
    }
    $providerVerificationEvidence = Invoke-ProviderVerification -Path $installedProviderPath
    if ($providerVerificationEvidence.passed -ne $true) {
      throw "signed_installer_private_provider_verification_failed"
    }
    $providerSmokeEvidence = Invoke-ProviderSmoke `
      -HostEvidence $HostEvidence `
      -ProviderPath $installedProviderPath `
      -AppPath $installedAppPath
    if ($providerSmokeEvidence.passed -ne $true) {
      throw "signed_installer_private_provider_smoke_failed"
    }
  } catch {
    $primaryError = $_.Exception.Message
  } finally {
    try {
      if ($installRoots.Count -eq 0) {
        $installRoots = @(Find-LingDesktopInstallRoots)
      }
      foreach ($installRoot in $installRoots) {
        if (-not (Test-Path -LiteralPath $installRoot -PathType Container)) {
          continue
        }
        $uninstaller = Get-ChildItem -LiteralPath $installRoot -File -Filter "Uninstall*.exe" -ErrorAction Stop |
          Sort-Object Name |
          Select-Object -First 1
        if (-not $uninstaller) {
          throw "signed_installer_cleanup_uninstaller_missing"
        }
        $cleanupUninstallerEvidence = Get-ArtifactEvidence -Path $uninstaller.FullName
        if (
          $cleanupUninstallerEvidence.exists -ne $true -or
          $cleanupUninstallerEvidence.signature.checked -ne $true -or
          $cleanupUninstallerEvidence.signature.status -ne "Valid" -or
          $cleanupUninstallerEvidence.signature.signerSubject -ne $ReleasePolicy.lingSignerSubject -or
          $cleanupUninstallerEvidence.signature.certificateSha256 -ne $ReleasePolicy.lingSignerCertificateSha256
        ) {
          throw "signed_installer_cleanup_uninstaller_signature_invalid"
        }
        if ($cleanupUninstallerEvidence.sha256 -ne $ExpectedUninstallerSha256) {
          throw "signed_installer_cleanup_uninstaller_hash_invalid"
        }
        $uninstall = Invoke-NativeCapture -FilePath $uninstaller.FullName -ArgumentList @("/S") -TimeoutMilliseconds 120000
        if ($uninstall.exitCode -ne 0 -or $uninstall.error) {
          throw ("signed_uninstaller_failed:{0}" -f $(if ($uninstall.error) { $uninstall.error } else { $uninstall.exitCode }))
        }
        for ($attempt = 0; $attempt -lt 40 -and (Test-Path -LiteralPath $installRoot); $attempt += 1) {
          Start-Sleep -Milliseconds 250
        }
        if (Test-Path -LiteralPath $installRoot) {
          throw "signed_uninstaller_left_install_root"
        }
      }
      $cleanupEvidence = Get-InstallationEvidence
      if (
        $cleanupEvidence.observed -ne $true -or
        $cleanupEvidence.errors.Count -ne 0 -or
        (Get-InstallationResidueCount -Evidence $cleanupEvidence) -ne 0
      ) {
        throw "signed_installer_cleanup_residue"
      }
    } catch {
      $cleanupError = $_.Exception.Message
    }
  }

  $passed = $null -eq $primaryError -and $null -eq $cleanupError
  return [ordered]@{
    attempted = $true
    passed = $passed
    exitCode = if ($passed) { 0 } else { 1 }
    error = if ($primaryError -and $cleanupError) {
      "$primaryError;cleanup:$cleanupError"
    } elseif ($primaryError) {
      $primaryError
    } else {
      $cleanupError
    }
    output = if ($passed) { "signed installer payload roundtrip passed" } else { "signed installer payload roundtrip failed" }
    report = [ordered]@{
      schemaVersion = 1
      mode = "signed_installer_payload_roundtrip"
      cleanBaselinePassed = $true
      cleanupPassed = $null -eq $cleanupError
      installedApp = $installedApp
      uninstaller = $uninstallerEvidence
      installedProvider = $installedProviderEvidence
      installedProviderSeal = $installedProviderSealEvidence
      installedProviderCatalog = $installedProviderCatalogEvidence
      installedVendorNativeInventory = $installedVendorNativeInventory
      providerVerification = $providerVerificationEvidence
      providerSmoke = $providerSmokeEvidence
    }
  }
}

function Invoke-ProviderVerification {
  param([AllowNull()][string]$Path)

  if ([string]::IsNullOrWhiteSpace($Path) -or -not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    return [ordered]@{
      attempted = $false
      passed = $null
      exitCode = $null
      error = "provider_missing"
      output = $null
      report = $null
    }
  }
  $probe = Invoke-NativeCapture -FilePath $nodePath `
    -ArgumentList @($providerVerifier, "--installed-binary", $Path) `
    -WorkingDirectory $repoRoot -TimeoutMilliseconds 90000
  $parsedReport = $null
  $parseError = $null
  if ($probe.exitCode -eq 0 -and -not [string]::IsNullOrWhiteSpace($probe.output)) {
    try {
      $parsedReport = $probe.output | ConvertFrom-Json -Depth 32
    } catch {
      $parseError = "provider_verifier_json_invalid:$($_.Exception.Message)"
    }
  }
  $passed = $probe.exitCode -eq 0 -and $null -ne $parsedReport -and $null -eq $parseError
  return [ordered]@{
    attempted = $true
    passed = $passed
    exitCode = $probe.exitCode
    error = if ($probe.error) { $probe.error } elseif ($parseError) { $parseError } elseif (-not $passed) { "provider_verifier_failed" } else { $null }
    output = $probe.output
    report = $parsedReport
  }
}

function Invoke-ProviderSmoke {
  param(
    [Parameter(Mandatory = $true)][System.Collections.IDictionary]$HostEvidence,
    [AllowNull()][string]$ProviderPath,
    [AllowNull()][string]$AppPath
  )

  if ($Mode -ne "Full") {
    return [ordered]@{
      attempted = $false
      passed = $null
      exitCode = $null
      error = "preflight_mode"
      output = $null
      report = $null
    }
  }
  if ($HostEvidence.session.interactive -ne $true -or $HostEvidence.session.locked -ne $false) {
    return [ordered]@{
      attempted = $false
      passed = $null
      exitCode = $null
      error = "interactive_session_unavailable"
      output = $null
      report = $null
    }
  }
  if ([string]::IsNullOrWhiteSpace($ProviderPath) -or -not (Test-Path -LiteralPath $ProviderPath -PathType Leaf)) {
    return [ordered]@{
      attempted = $false
      passed = $null
      exitCode = $null
      error = "provider_missing"
      output = $null
      report = $null
    }
  }
  if ([string]::IsNullOrWhiteSpace($AppPath) -or -not (Test-Path -LiteralPath $AppPath -PathType Leaf)) {
    return [ordered]@{
      attempted = $false
      passed = $null
      exitCode = $null
      error = "ling_app_missing"
      output = $null
      report = $null
    }
  }

  $previousProviderCommand = $env:LING_CUA_DRIVER_COMMAND
  $previousExpectedProviderCommand = $env:LING_CUA_DRIVER_SMOKE_EXPECTED_COMMAND
  $previousDesktopExecutable = $env:LING_DESKTOP_SMOKE_EXECUTABLE
  $previousTimeout = $env:LING_DESKTOP_SMOKE_TIMEOUT_MS
  try {
    # The smoke helper may call the expected provider directly to obtain exact
    # PID/HWND targets, but the packaged Desktop must resolve its own bundled
    # provider. Never let the legacy command override enter the app process.
    $env:LING_CUA_DRIVER_COMMAND = $null
    $env:LING_CUA_DRIVER_SMOKE_EXPECTED_COMMAND = $ProviderPath
    $env:LING_DESKTOP_SMOKE_EXECUTABLE = $AppPath
    $env:LING_DESKTOP_SMOKE_TIMEOUT_MS = "60000"
    $probe = Invoke-NativeCapture -FilePath $nodePath `
      -ArgumentList @($providerSmokeRunner) `
      -WorkingDirectory $repoRoot -TimeoutMilliseconds 120000
    return [ordered]@{
      attempted = $true
      passed = $probe.exitCode -eq 0
      exitCode = $probe.exitCode
      error = if ($probe.error) { $probe.error } elseif ($probe.exitCode -ne 0) { "provider_smoke_failed" } else { $null }
      output = $probe.output
      report = $null
    }
  } finally {
    $env:LING_CUA_DRIVER_COMMAND = $previousProviderCommand
    $env:LING_CUA_DRIVER_SMOKE_EXPECTED_COMMAND = $previousExpectedProviderCommand
    $env:LING_DESKTOP_SMOKE_EXECUTABLE = $previousDesktopExecutable
    $env:LING_DESKTOP_SMOKE_TIMEOUT_MS = $previousTimeout
  }
}

$fullHandoff = $null
if ($Mode -eq "Full") {
  $resolvedHandoffManifest = (Resolve-Path -LiteralPath $HandoffManifest -ErrorAction Stop).Path
  $handoffLoad = Invoke-NativeCapture -FilePath $nodePath `
    -ArgumentList @($handoffLoader, "--manifest", $resolvedHandoffManifest) `
    -WorkingDirectory $repoRoot -TimeoutMilliseconds 60000
  if ($handoffLoad.exitCode -ne 0 -or [string]::IsNullOrWhiteSpace($handoffLoad.output)) {
    throw "Windows handoff manifest load failed: $($handoffLoad.output) $($handoffLoad.error)"
  }
  try {
    $fullHandoff = $handoffLoad.output | ConvertFrom-Json -AsHashtable -Depth 64
  } catch {
    throw "Windows handoff manifest loader returned invalid JSON: $($_.Exception.Message)"
  }
  $Output = [string]$fullHandoff.outputReport
  $LingAppPath = [string]$fullHandoff.inputs.lingApp
  $LingInstallerPath = [string]$fullHandoff.inputs.lingInstaller
  $ProviderBinary = [string]$fullHandoff.inputs.provider
  $CandidateManifest = [string]$fullHandoff.inputs.candidateManifest
  $ReleasePolicy = [string]$fullHandoff.inputs.releasePolicy
  $ExpectedCandidateCommit = [string]$fullHandoff.expected.candidateCommit
  $ExpectedRepositoryRoot = [string]$fullHandoff.repositoryRoot
  $ExpectedReleasePolicySha256 = [string]$fullHandoff.expected.releasePolicySha256
  $WindowsVersionEvidence = [string]$fullHandoff.manualEvidence.windowsVersion
  $DisplayEvidence = [string]$fullHandoff.manualEvidence.display
  $NarratorEvidence = [string]$fullHandoff.manualEvidence.narrator
  $NvdaEvidence = [string]$fullHandoff.manualEvidence.nvda
  $SmartScreenEvidence = if ($null -ne $fullHandoff.manualEvidence.smartScreen) {
    [string]$fullHandoff.manualEvidence.smartScreen
  } else {
    $null
  }
  $InstallLifecycleEvidence = [string]$fullHandoff.manualEvidence.installLifecycle
  if (
    -not [string]::Equals(
      [System.IO.Path]::GetFullPath($repoRoot).TrimEnd('\', '/'),
      [System.IO.Path]::GetFullPath($ExpectedRepositoryRoot).TrimEnd('\', '/'),
      [System.StringComparison]::OrdinalIgnoreCase
    )
  ) {
    throw "Handoff repositoryRoot does not match the acceptance harness repository"
  }
  Assert-RequiredToolVersions -Requirements $fullHandoff.requiredToolVersions
}

$outputPath = if ([System.IO.Path]::IsPathRooted($Output)) {
  [System.IO.Path]::GetFullPath($Output)
} else {
  [System.IO.Path]::GetFullPath((Join-Path (Get-Location).Path $Output))
}

# Preflight is a replaceable diagnostic. Full cell reports are immutable and the
# handoff loader already rejected an existing output path.
if ($Mode -eq "Preflight" -and (Test-Path -LiteralPath $outputPath -PathType Leaf)) {
  Remove-Item -LiteralPath $outputPath -Force
}

$providerInputExplicit = -not [string]::IsNullOrWhiteSpace($ProviderBinary) -or
  -not [string]::IsNullOrWhiteSpace($env:LING_CUA_DRIVER_COMMAND)

if ([string]::IsNullOrWhiteSpace($LingAppPath)) {
  $LingAppPath = if ($env:LING_DESKTOP_ACCEPTANCE_APP) {
    $env:LING_DESKTOP_ACCEPTANCE_APP
  } else {
    Join-Path $desktopRoot "release\win-unpacked\Ling Stack.exe"
  }
}
if ([string]::IsNullOrWhiteSpace($LingInstallerPath)) {
  $LingInstallerPath = if ($env:LING_DESKTOP_ACCEPTANCE_INSTALLER) {
    $env:LING_DESKTOP_ACCEPTANCE_INSTALLER
  } else {
    Find-DefaultInstallerPath
  }
}
if ([string]::IsNullOrWhiteSpace($ProviderBinary)) {
  $ProviderBinary = if ($env:LING_CUA_DRIVER_COMMAND) {
    $env:LING_CUA_DRIVER_COMMAND
  } else {
    $null
  }
}

$resolvedLingApp = Resolve-OptionalCommandPath -Value $LingAppPath
$resolvedLingInstaller = Resolve-OptionalCommandPath -Value $LingInstallerPath
$resolvedProvider = if (
  $providerInputExplicit -and
  [System.IO.Path]::IsPathRooted($ProviderBinary) -and
  (Test-Path -LiteralPath $ProviderBinary -PathType Leaf)
) {
  (Resolve-Path -LiteralPath $ProviderBinary).Path
} else {
  $null
}
$lingApp = Get-ArtifactEvidence -Path $(if ($resolvedLingApp) { $resolvedLingApp } else { $LingAppPath })
$lingInstaller = Get-ArtifactEvidence -Path $(if ($resolvedLingInstaller) { $resolvedLingInstaller } else { $LingInstallerPath })
$provider = Get-ArtifactEvidence -Path $(if ($resolvedProvider) { $resolvedProvider } else { $ProviderBinary })
$providerSeal = if ($Mode -eq "Full") {
  Get-ArtifactEvidence -Path ([string]$fullHandoff.inputs.providerSeal)
} else {
  Get-ArtifactEvidence -Path $null
}
$providerCatalog = if ($Mode -eq "Full") {
  Get-ArtifactEvidence -Path ([string]$fullHandoff.inputs.providerCatalog)
} else {
  Get-ArtifactEvidence -Path $null
}
$looseArtifacts = [ordered]@{
  lingInstaller = $lingInstaller
  lingApp = $lingApp
  provider = $provider
  providerSeal = $providerSeal
  providerCatalog = $providerCatalog
}
if ($Mode -eq "Full") {
  Assert-FullLooseArtifactDigests -Handoff $fullHandoff -Artifacts $looseArtifacts
}
$commit = Get-GitCommit
if ($Mode -eq "Full" -and $commit -ne $ExpectedCandidateCommit) {
  throw "ExpectedCandidateCommit does not match the clean acceptance harness commit"
}
$releaseHarnessEvidence = Get-ReleaseHarnessEvidence -Commit $commit
$releasePolicyEvidence = if ($Mode -eq "Full") {
  $fullHandoff.releasePolicy
} else {
  [ordered]@{ path = $null; sha256 = $null; verified = $false; error = "preflight_mode" }
}
if ($Mode -eq "Full" -and $releasePolicyEvidence.sha256 -ne $ExpectedReleasePolicySha256) {
  throw "ExpectedReleasePolicySha256 does not match the supplied release policy"
}
$candidateManifestEvidence = if ($Mode -eq "Full") {
  $fullHandoff.candidateManifest
} else {
  [ordered]@{ path = $null; sha256 = $null; verified = $false; error = "preflight_mode" }
}

$providerMayVerify = $providerInputExplicit -and (
  $Mode -eq "Preflight" -or (
    $candidateManifestEvidence.verified -eq $true -and
    $releasePolicyEvidence.verified -eq $true
  )
)
$hostEvidence = Get-HostEvidence
$providerVerification = if ($providerMayVerify -and $Mode -eq "Preflight") {
  Invoke-ProviderVerification -Path $resolvedProvider
} else {
  [ordered]@{
    attempted = $false
    passed = $null
    exitCode = $null
    error = if ($providerInputExplicit) { "provider_not_manifest_and_policy_bound" } else { "explicit_provider_path_required" }
    output = $null
    report = $null
  }
}
$provider["version"] = "0.8.3"
$installationBaseline = Get-InstallationEvidence
$installerPayloadMayVerify = $Mode -eq "Full" -and
  $candidateManifestEvidence.verified -eq $true -and
  $releasePolicyEvidence.verified -eq $true
$installerPayloadVerification = if ($installerPayloadMayVerify) {
  # Close as much of the loader-to-execution replacement window as PowerShell
  # permits by refreshing every loose-file digest immediately before the call.
  $lingApp = Get-ArtifactEvidence -Path $resolvedLingApp
  $lingInstaller = Get-ArtifactEvidence -Path $resolvedLingInstaller
  $provider = Get-ArtifactEvidence -Path $resolvedProvider
  $provider["version"] = "0.8.3"
  $providerSeal = Get-ArtifactEvidence -Path ([string]$fullHandoff.inputs.providerSeal)
  $providerCatalog = Get-ArtifactEvidence -Path ([string]$fullHandoff.inputs.providerCatalog)
  $looseArtifacts = [ordered]@{
    lingInstaller = $lingInstaller
    lingApp = $lingApp
    provider = $provider
    providerSeal = $providerSeal
    providerCatalog = $providerCatalog
  }
  Assert-FullLooseArtifactDigests -Handoff $fullHandoff -Artifacts $looseArtifacts
  Invoke-InstallerPayloadVerification `
    -InstallerPath $resolvedLingInstaller `
    -ExpectedInstallerSha256 ([string]$fullHandoff.expected.artifacts.lingInstaller) `
    -ExpectedApp $lingApp `
    -ExpectedProvider $provider `
    -ExpectedProviderSeal $providerSeal `
    -ExpectedProviderCatalog $providerCatalog `
    -ExpectedUninstallerSha256 ([string]$fullHandoff.expected.artifacts.lingUninstaller) `
    -ExpectedCandidateManifest $fullHandoff.candidateManifest `
    -HostEvidence $hostEvidence `
    -ReleasePolicy $releasePolicyEvidence `
    -Baseline $installationBaseline
} else {
  [ordered]@{
    attempted = $false
    passed = $null
    exitCode = $null
    error = if ($Mode -eq "Preflight") { "preflight_mode" } else { "installer_not_manifest_and_policy_bound" }
    output = $null
    report = $null
  }
}
$providerVerification = if ($Mode -eq "Full" -and $null -ne $installerPayloadVerification.report) {
  $installerPayloadVerification.report.providerVerification
} elseif ($Mode -eq "Preflight") {
  $providerVerification
} else {
  [ordered]@{
    attempted = $false
    passed = $null
    exitCode = $null
    error = "provider_not_verified_or_manifest_bound"
    output = $null
    report = $null
  }
}
$providerSmoke = if ($Mode -eq "Full" -and $null -ne $installerPayloadVerification.report) {
  $installerPayloadVerification.report.providerSmoke
} elseif ($Mode -eq "Preflight") {
  [ordered]@{
    attempted = $false
    passed = $null
    exitCode = $null
    error = "preflight_mode"
    output = $null
    report = $null
  }
} else {
  [ordered]@{
    attempted = $false
    passed = $null
    exitCode = $null
    error = "provider_not_verified_or_manifest_bound"
    output = $null
    report = $null
  }
}
$installationEvidence = Get-InstallationEvidence
$windowsVersionAcceptance = Get-StructuredManualAcceptanceEvidence `
  -Path $WindowsVersionEvidence -ExpectedKind "ling.windows.full-evidence.windows-version" -MissingReason "supported_windows_version_evidence_missing"
$displayAcceptance = Get-StructuredManualAcceptanceEvidence `
  -Path $DisplayEvidence -ExpectedKind "ling.windows.full-evidence.display" -MissingReason "cross_display_visual_evidence_missing"
$narratorAcceptance = Get-StructuredManualAcceptanceEvidence `
  -Path $NarratorEvidence -ExpectedKind "ling.windows.full-evidence.narrator" -MissingReason "narrator_acceptance_missing"
$nvdaAcceptance = Get-StructuredManualAcceptanceEvidence `
  -Path $NvdaEvidence -ExpectedKind "ling.windows.full-evidence.nvda" -MissingReason "nvda_acceptance_missing"
$smartScreenAcceptance = Get-StructuredManualAcceptanceEvidence `
  -Path $SmartScreenEvidence -ExpectedKind "ling.windows.full-evidence.smartscreen" -MissingReason "smartscreen_evidence_missing"
$installLifecycleAcceptance = Get-StructuredManualAcceptanceEvidence `
  -Path $InstallLifecycleEvidence -ExpectedKind "ling.windows.full-evidence.install-lifecycle" -MissingReason "install_lifecycle_evidence_missing"

$rawEvidence = [ordered]@{
  mode = $Mode
  generatedAt = [DateTimeOffset]::UtcNow.ToString("o")
  handoff = if ($Mode -eq "Full") {
    [ordered]@{
      runId = [string]$fullHandoff.runId
      handoffIndexSha256 = [string]$fullHandoff.indexSha256
      cellManifestSha256 = [string]$fullHandoff.manifestSha256
    }
  } else {
    $null
  }
  cell = if ($Mode -eq "Full") { $fullHandoff.cell } else { $null }
  bindings = [ordered]@{
    commit = $commit
    harness = $releaseHarnessEvidence
    lingApp = $lingApp
    lingInstaller = $lingInstaller
    provider = $provider
    providerSeal = $providerSeal
    providerCatalog = $providerCatalog
    releasePolicy = $releasePolicyEvidence
    candidateManifest = $candidateManifestEvidence
  }
  host = $hostEvidence
  installation = $installationEvidence
  probes = [ordered]@{
    providerVerification = $providerVerification
    providerSmoke = $providerSmoke
    installerPayload = $installerPayloadVerification
  }
  acceptance = [ordered]@{
    windowsVersion = $windowsVersionAcceptance
    display = $displayAcceptance
    narrator = $narratorAcceptance
    nvda = $nvdaAcceptance
    smartScreen = $smartScreenAcceptance
    installLifecycle = $installLifecycleAcceptance
  }
}

$temporaryInput = Join-Path ([System.IO.Path]::GetTempPath()) ("ling-windows-acceptance-{0}.json" -f [Guid]::NewGuid())
try {
  $rawEvidence | ConvertTo-Json -Depth 32 | Set-Content -LiteralPath $temporaryInput -Encoding utf8
  $reportArguments = @(
    $reportModule,
    "--input", $temporaryInput,
    "--output", $outputPath,
    "--git-executable", $gitPath
  )
  if ($Mode -eq "Full") {
    $reportArguments += @(
      "--expected-candidate-commit", $ExpectedCandidateCommit,
      "--expected-repository-root", $ExpectedRepositoryRoot,
      "--expected-release-policy-sha256", $ExpectedReleasePolicySha256
    )
  }
  $reportBuild = Invoke-NativeCapture -FilePath $nodePath `
    -ArgumentList $reportArguments `
    -WorkingDirectory $repoRoot -TimeoutMilliseconds 60000
  if ($reportBuild.exitCode -ne 0) {
    $reportFailure = if ($reportBuild.output) { $reportBuild.output } else { $reportBuild.error }
    throw "Windows acceptance report builder failed: $reportFailure"
  }
} finally {
  Remove-Item -LiteralPath $temporaryInput -Force -ErrorAction SilentlyContinue
}

$finalReport = Get-Content -LiteralPath $outputPath -Raw | ConvertFrom-Json -Depth 32
Write-Output ("Windows acceptance {0}: {1}; full={2}; report={3}" -f `
  $Mode,
  $finalReport.summary.status,
  $finalReport.summary.fullAcceptanceStatus,
  (Resolve-Path -LiteralPath $outputPath).Path
)

if ($finalReport.summary.status -eq "FAIL") {
  exit 1
}
if ($Mode -eq "Full") {
  if (
    $finalReport.summary.fullAcceptanceStatus -ne "PASS" -or
    $finalReport.summary.releaseStatus -ne "MANUAL_REVIEW_REQUIRED" -or
    $finalReport.summary.releaseReady -ne $false
  ) {
    exit 2
  }
}
