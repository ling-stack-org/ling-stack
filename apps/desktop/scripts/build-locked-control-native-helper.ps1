param(
  [string]$Output = "$PSScriptRoot\..\build\native\win32-x64\ling-locked-control-helper.exe",
  [string]$CertificateThumbprint = "",
  [string]$TimestampServer = "http://timestamp.digicert.com",
  [switch]$RequireSigned
)

$ErrorActionPreference = "Stop"
if (-not [Environment]::Is64BitOperatingSystem) {
  throw "locked_control_native_helper_requires_windows_x64"
}
if (-not (Get-Command cl.exe -ErrorAction SilentlyContinue)) {
  throw "Run this script from an x64 Native Tools Command Prompt for Visual Studio."
}

$Source = Join-Path $PSScriptRoot "native\locked-control-win32.cpp"
New-Item -ItemType Directory -Force -Path (Split-Path $Output) | Out-Null
& cl.exe /nologo /std:c++20 /EHsc /O2 /W4 /permissive- /utf-8 $Source /Fe:$Output
if ($LASTEXITCODE -ne 0) {
  throw "locked_control_native_helper_build_failed"
}

if ($CertificateThumbprint) {
  if (-not (Get-Command signtool.exe -ErrorAction SilentlyContinue)) {
    throw "signtool.exe is required when CertificateThumbprint is provided."
  }
  & signtool.exe sign /sha1 $CertificateThumbprint /fd SHA256 /tr $TimestampServer /td SHA256 $Output
  if ($LASTEXITCODE -ne 0) {
    throw "locked_control_native_helper_sign_failed"
  }
}

$Signature = Get-AuthenticodeSignature -FilePath $Output
if ($RequireSigned -and $Signature.Status -ne "Valid") {
  throw "locked_control_native_helper_signature_required"
}

$Request = '{"command":"session","platform":"win32"}'
$Probe = $Request | & $Output | ConvertFrom-Json
if ($LASTEXITCODE -ne 0 -or $Probe.platform -ne "win32" -or $Probe.sessionBindingDigest -notmatch '^[a-f0-9]{64}$') {
  throw "locked_control_native_helper_session_probe_invalid"
}

[ordered]@{
  built = $true
  platform = "win32"
  architecture = "x64"
  output = $Output
  sha256 = (Get-FileHash -Algorithm SHA256 -Path $Output).Hash.ToLowerInvariant()
  contentFreeSessionProbe = $true
  signed = $Signature.Status -eq "Valid"
  signatureStatus = $Signature.Status.ToString()
  signerThumbprint = $(if ($Signature.SignerCertificate) { $Signature.SignerCertificate.Thumbprint.ToLowerInvariant() } else { $null })
  acceptance = "not_run"
} | ConvertTo-Json -Compress
