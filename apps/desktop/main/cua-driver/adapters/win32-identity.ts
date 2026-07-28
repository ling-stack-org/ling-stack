import { win32 } from "node:path";
import type {
  WindowsBundledProviderSealV2,
  WindowsDistributionChannel,
  WindowsSigningTier,
} from "@ling-stack/contracts";
import { cuaDriverArtifactLayoutFor } from "../../../shared/cua-driver-artifact-layout.mjs";
import {
  CuaDriverPlatformIdentityVerificationError,
  type CuaDriverPlatformIdentityVerificationInput,
  type CuaDriverPlatformIdentityVerifier,
} from "../provider-seal.js";
import {
  createBoundedWin32CommandRunner,
  createWin32VerifierEnvironment,
  encodeWin32PowerShell,
  isWin32CommandResult,
  resolveWin32SystemExecutables,
  WIN32_CUA_DRIVER_COMMAND_TIMEOUT_MS,
  WIN32_CUA_DRIVER_STDERR_MAX_BYTES,
  WIN32_CUA_DRIVER_STDOUT_MAX_BYTES,
  type Win32CommandRunner,
} from "./win32-command.js";

export interface Win32PinnedSignerIdentity {
  readonly subject: string;
  readonly certificateSha256: string;
}

export type Win32CuaDriverSigningPolicy =
  | Readonly<{
      readonly signingTier: "unsigned_dev";
      readonly distributionChannel: "development";
    }>
  | Readonly<{
      readonly signingTier: "test_signed_internal";
      readonly distributionChannel: "internal";
      readonly providerSigner: Win32PinnedSignerIdentity;
      readonly catalogSigner: Win32PinnedSignerIdentity;
      readonly catalogTimestampStatus: "NotRequired" | "Valid";
    }>
  | Readonly<{
      readonly signingTier: "production_signed";
      readonly distributionChannel: "production";
      readonly providerSigner: Win32PinnedSignerIdentity;
      readonly catalogSigner: Win32PinnedSignerIdentity;
      readonly catalogTimestampStatus: "Valid";
    }>;

export interface Win32CuaDriverIdentityVerifierOptions {
  readonly policy: Win32CuaDriverSigningPolicy;
  /**
   * Trusted Windows system-directory fact supplied by the platform layer.
   * Environment variables are intentionally never accepted as a fallback.
   */
  readonly systemRoot: string;
  readonly baseEnvironment?: NodeJS.ProcessEnv;
  readonly commandRunner?: Win32CommandRunner;
  readonly timeoutMs?: number;
  readonly maxStdoutBytes?: number;
  readonly maxStderrBytes?: number;
}

interface Win32ObservedFileIdentity {
  readonly path: string;
  readonly sha256: string;
  readonly authenticodeStatus: "NotSigned" | "Valid" | string;
  readonly signerSubject: string | null;
  readonly certificateSha256: string | null;
  readonly timestampStatus: "NotRequired" | "Valid" | string;
}

interface Win32ProviderIdentityEvidence extends Win32ObservedFileIdentity {
  readonly peMachine: string;
  readonly peMagic: string;
}

interface Win32CatalogIdentityEvidence extends Win32ObservedFileIdentity {
  readonly validationStatus: string;
  readonly members: readonly {
    readonly relativePath: string;
    readonly sha256: string;
  }[];
}

interface Win32IdentityEvidence {
  readonly schemaVersion: 1;
  readonly verdict: "observed" | "invalid" | "unavailable";
  readonly reason?: string;
  readonly provider?: Win32ProviderIdentityEvidence;
  readonly catalog?: Win32CatalogIdentityEvidence | null;
}

const POWERSHELL_ARGS_PREFIX = ["-NoLogo", "-NoProfile", "-NonInteractive"] as const;

/**
 * Runtime identity is derived from final installed bytes and Windows trust
 * APIs. Candidate/release manifests are intentionally absent from this API.
 */
export class Win32CuaDriverIdentityVerifier implements CuaDriverPlatformIdentityVerifier {
  private readonly options: Win32CuaDriverIdentityVerifierOptions;
  private readonly runner: Win32CommandRunner;
  private readonly baseEnvironment: NodeJS.ProcessEnv;
  private readonly policy: Win32CuaDriverSigningPolicy;

  constructor(options: Win32CuaDriverIdentityVerifierOptions) {
    this.policy = cloneSigningPolicy(options.policy);
    this.options = Object.freeze({ ...options, policy: this.policy });
    this.runner = options.commandRunner ?? createBoundedWin32CommandRunner();
    this.baseEnvironment = Object.freeze(createWin32VerifierEnvironment(
      options.baseEnvironment ?? process.env,
      {},
    ));
  }

  async verify(input: CuaDriverPlatformIdentityVerificationInput): Promise<void> {
    const seal = windowsSeal(input);
    if (!matchesPolicyTuple(seal.signingTier, seal.distributionChannel, this.policy)) {
      throw invalidIdentity();
    }
    assertSealSignerPolicy(seal, this.policy);

    let executables: ReturnType<typeof resolveWin32SystemExecutables>;
    try {
      executables = resolveWin32SystemExecutables(this.options.systemRoot);
    } catch {
      throw unavailableIdentity();
    }

    const requiresCatalog = seal.signingTier !== "unsigned_dev";
    if (requiresCatalog && (!input.paths.catalogPath || !input.catalogDigest)) {
      throw invalidIdentity();
    }
    if (!requiresCatalog && input.catalogDigest !== undefined) {
      throw invalidIdentity();
    }

    let result: unknown;
    try {
      result = await this.runner.run({
        executablePath: executables.powershellPath,
        args: [
          ...POWERSHELL_ARGS_PREFIX,
          "-EncodedCommand",
          encodeWin32PowerShell(WIN32_IDENTITY_SCRIPT),
        ],
        environment: createWin32VerifierEnvironment(this.baseEnvironment, {
          SystemRoot: executables.systemRoot,
          WINDIR: executables.systemRoot,
          LING_CUA_PROVIDER_PATH: input.paths.executablePath,
          LING_CUA_SEAL_PATH: input.paths.sealPath,
          LING_CUA_CATALOG_PATH: input.paths.catalogPath ?? "",
          LING_CUA_REQUIRE_CATALOG: requiresCatalog ? "1" : "0",
        }),
        timeoutMs: this.options.timeoutMs ?? WIN32_CUA_DRIVER_COMMAND_TIMEOUT_MS,
        maxStdoutBytes: this.options.maxStdoutBytes ?? WIN32_CUA_DRIVER_STDOUT_MAX_BYTES,
        maxStderrBytes: this.options.maxStderrBytes ?? WIN32_CUA_DRIVER_STDERR_MAX_BYTES,
      });
    } catch {
      throw unavailableIdentity();
    }
    const evidence = parseIdentityEvidence(result);
    if (evidence.verdict === "unavailable") {
      throw unavailableIdentity();
    }
    if (evidence.verdict === "invalid") {
      throw invalidIdentity();
    }
    assertObservedIdentity(input, seal, this.policy, evidence);
  }
}

export function createWin32CuaDriverIdentityVerifier(
  options: Win32CuaDriverIdentityVerifierOptions,
): CuaDriverPlatformIdentityVerifier {
  return new Win32CuaDriverIdentityVerifier(options);
}

function parseIdentityEvidence(result: unknown): Win32IdentityEvidence {
  if (!isWin32CommandResult(result)
    || result.spawnFailed
    || result.timedOut
    || result.stdoutOverflow
    || result.stderrOverflow
    || result.exitCode !== 0
    || result.signal !== null) {
    throw unavailableIdentity();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout.trim()) as unknown;
  } catch {
    throw unavailableIdentity();
  }
  if (!isRecord(parsed)
    || parsed.schemaVersion !== 1
    || (parsed.verdict !== "observed"
      && parsed.verdict !== "invalid"
      && parsed.verdict !== "unavailable")
    || (parsed.reason !== undefined && !hasText(parsed.reason))) {
    throw unavailableIdentity();
  }
  if (parsed.verdict !== "observed") {
    return {
      schemaVersion: 1,
      verdict: parsed.verdict,
      ...(typeof parsed.reason === "string" ? { reason: parsed.reason } : {}),
    };
  }
  const provider = parseProviderEvidence(parsed.provider);
  const catalog = parsed.catalog === null ? null : parseCatalogEvidence(parsed.catalog);
  return { schemaVersion: 1, verdict: "observed", provider, catalog };
}

function parseProviderEvidence(value: unknown): Win32ProviderIdentityEvidence {
  if (!isRecord(value)
    || !hasText(value.path)
    || !isSha256(value.sha256)
    || !hasText(value.peMachine)
    || !hasText(value.peMagic)
    || !hasText(value.authenticodeStatus)
    || (value.signerSubject !== null && !hasText(value.signerSubject))
    || (value.certificateSha256 !== null && !isSha256(value.certificateSha256))
    || !hasText(value.timestampStatus)) {
    throw unavailableIdentity();
  }
  return value as unknown as Win32ProviderIdentityEvidence;
}

function parseCatalogEvidence(value: unknown): Win32CatalogIdentityEvidence {
  if (!isRecord(value)
    || !hasText(value.path)
    || !isSha256(value.sha256)
    || !hasText(value.authenticodeStatus)
    || (value.signerSubject !== null && !hasText(value.signerSubject))
    || (value.certificateSha256 !== null && !isSha256(value.certificateSha256))
    || !hasText(value.timestampStatus)
    || !hasText(value.validationStatus)
    || !Array.isArray(value.members)) {
    throw unavailableIdentity();
  }
  const members = value.members.map((member) => {
    if (!isRecord(member) || !hasText(member.relativePath) || !isSha256(member.sha256)) {
      throw unavailableIdentity();
    }
    return { relativePath: member.relativePath, sha256: member.sha256 };
  });
  return { ...(value as unknown as Omit<Win32CatalogIdentityEvidence, "members">), members };
}

function assertObservedIdentity(
  input: CuaDriverPlatformIdentityVerificationInput,
  seal: WindowsBundledProviderSealV2,
  policy: Win32CuaDriverSigningPolicy,
  evidence: Win32IdentityEvidence,
): void {
  const provider = evidence.provider;
  if (!provider
    || !sameWindowsPath(provider.path, input.paths.executablePath)
    || provider.sha256 !== input.executableDigest
    || provider.peMachine.toLowerCase() !== "0x8664"
    || provider.peMagic.toLowerCase() !== "0x020b") {
    throw invalidIdentity();
  }

  if (policy.signingTier === "unsigned_dev") {
    if (provider.authenticodeStatus !== "NotSigned"
      || provider.signerSubject !== null
      || provider.certificateSha256 !== null
      || provider.timestampStatus !== "NotRequired"
      || evidence.catalog !== null
      || seal.integrityCatalogRelativePath !== null) {
      throw invalidIdentity();
    }
    return;
  }

  if (seal.signingTier === "unsigned_dev") {
    throw invalidIdentity();
  }

  if (provider.authenticodeStatus !== "Valid"
    || provider.signerSubject !== policy.providerSigner.subject
    || provider.certificateSha256 !== policy.providerSigner.certificateSha256
    || provider.signerSubject !== seal.main.signerSubject
    || provider.certificateSha256 !== seal.main.certificateSha256
    || provider.timestampStatus !== seal.main.timestampStatus) {
    throw invalidIdentity();
  }
  const catalog = evidence.catalog;
  if (!catalog
    || !input.paths.catalogPath
    || !input.catalogDigest
    || !sameWindowsPath(catalog.path, input.paths.catalogPath)
    || catalog.sha256 !== input.catalogDigest
    || catalog.authenticodeStatus !== "Valid"
    || catalog.signerSubject !== policy.catalogSigner.subject
    || catalog.certificateSha256 !== policy.catalogSigner.certificateSha256
    || catalog.timestampStatus !== policy.catalogTimestampStatus
    || catalog.validationStatus !== "Valid") {
    throw invalidIdentity();
  }
  const expectedMembers = [
    {
      relativePath: `payload/${cuaDriverArtifactLayoutFor("win32-x64").packagedExecutableName}`,
      sha256: input.executableDigest,
    },
    { relativePath: "payload/provider-seal.json", sha256: input.sealDigest },
  ];
  const actualMembers = [...catalog.members]
    .map((member) => ({ relativePath: normalizeRelativePath(member.relativePath), sha256: member.sha256 }))
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  if (JSON.stringify(actualMembers) !== JSON.stringify(expectedMembers)) {
    throw invalidIdentity();
  }
}

function windowsSeal(input: CuaDriverPlatformIdentityVerificationInput): WindowsBundledProviderSealV2 {
  if (input.platform !== "win32"
    || input.architecture !== "x86_64"
    || !isRecord(input.seal)
    || input.seal.componentId !== "cua-driver-win32-x64") {
    throw invalidIdentity();
  }
  return input.seal as WindowsBundledProviderSealV2;
}

function assertSealSignerPolicy(
  seal: WindowsBundledProviderSealV2,
  policy: Win32CuaDriverSigningPolicy,
): void {
  if (policy.signingTier === "unsigned_dev") {
    if (seal.main.authenticodeStatus !== "NotSigned"
      || seal.integrityCatalogRelativePath !== null
      || Object.hasOwn(seal.main, "signerSubject")
      || Object.hasOwn(seal.main, "certificateSha256")
      || Object.hasOwn(seal.main, "timestampPolicy")
      || Object.hasOwn(seal.main, "timestampStatus")) {
      throw invalidIdentity();
    }
    return;
  }
  const expectedTimestampPolicy = policy.signingTier === "production_signed"
    ? "rfc3161-required"
    : "internal-policy";
  if (seal.main.authenticodeStatus !== "Valid"
    || seal.main.signerSubject !== policy.providerSigner.subject
    || seal.main.certificateSha256 !== policy.providerSigner.certificateSha256
    || seal.main.timestampPolicy !== expectedTimestampPolicy
    || (seal.main.timestampStatus !== "NotRequired" && seal.main.timestampStatus !== "Valid")
    || (policy.signingTier === "production_signed" && seal.main.timestampStatus !== "Valid")
    || seal.integrityCatalogRelativePath !== "provider-integrity.cat") {
    throw invalidIdentity();
  }
}

function assertSigningPolicy(policy: Win32CuaDriverSigningPolicy): void {
  if (!policy
    || typeof policy !== "object"
    || !matchesPolicyTuple(policy.signingTier, policy.distributionChannel, policy)) {
    throw new Error("win32_cua_driver_signing_policy_invalid");
  }
  if (policy.signingTier !== "unsigned_dev") {
    for (const signer of [policy.providerSigner, policy.catalogSigner]) {
      if (!signer || !hasText(signer.subject) || !isSha256(signer.certificateSha256)) {
        throw new Error("win32_cua_driver_signing_policy_invalid");
      }
    }
    if ((policy.catalogTimestampStatus !== "NotRequired" && policy.catalogTimestampStatus !== "Valid")
      || (policy.signingTier === "production_signed" && policy.catalogTimestampStatus !== "Valid")) {
      throw new Error("win32_cua_driver_signing_policy_invalid");
    }
  }
}

function cloneSigningPolicy(policy: Win32CuaDriverSigningPolicy): Win32CuaDriverSigningPolicy {
  assertSigningPolicy(policy);
  if (policy.signingTier === "unsigned_dev") {
    return Object.freeze({
      signingTier: policy.signingTier,
      distributionChannel: policy.distributionChannel,
    });
  }
  if (policy.signingTier === "test_signed_internal") {
    return Object.freeze({
      signingTier: policy.signingTier,
      distributionChannel: policy.distributionChannel,
      providerSigner: Object.freeze({ ...policy.providerSigner }),
      catalogSigner: Object.freeze({ ...policy.catalogSigner }),
      catalogTimestampStatus: policy.catalogTimestampStatus,
    });
  }
  return Object.freeze({
    signingTier: policy.signingTier,
    distributionChannel: policy.distributionChannel,
    providerSigner: Object.freeze({ ...policy.providerSigner }),
    catalogSigner: Object.freeze({ ...policy.catalogSigner }),
    catalogTimestampStatus: policy.catalogTimestampStatus,
  });
}

function matchesPolicyTuple(
  signingTier: WindowsSigningTier,
  distributionChannel: WindowsDistributionChannel,
  policy: Win32CuaDriverSigningPolicy,
): boolean {
  return signingTier === policy.signingTier
    && distributionChannel === policy.distributionChannel
    && (
      (signingTier === "unsigned_dev" && distributionChannel === "development")
      || (signingTier === "test_signed_internal" && distributionChannel === "internal")
      || (signingTier === "production_signed" && distributionChannel === "production")
    );
}

function sameWindowsPath(left: string, right: string): boolean {
  if (win32.isAbsolute(left) && win32.isAbsolute(right)) {
    return win32.resolve(left).toLowerCase() === win32.resolve(right).toLowerCase();
  }
  return left === right;
}

function normalizeRelativePath(value: string): string {
  return value.replaceAll("\\", "/");
}

function isRecord(value: unknown): value is Readonly<Record<string, any>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value === value.trim();
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value) && !/^0{64}$/u.test(value);
}

function invalidIdentity(): CuaDriverPlatformIdentityVerificationError {
  return new CuaDriverPlatformIdentityVerificationError("invalid");
}

function unavailableIdentity(): CuaDriverPlatformIdentityVerificationError {
  return new CuaDriverPlatformIdentityVerificationError("unavailable");
}

const WIN32_IDENTITY_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$utf8 = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = $utf8
$OutputEncoding = $utf8

function Write-LingJson([object]$Value) {
  [Console]::Out.WriteLine(($Value | Microsoft.PowerShell.Utility\ConvertTo-Json -Compress -Depth 8))
}

function Get-LingCertificateSha256([object]$Certificate) {
  if ($null -eq $Certificate) { return $null }
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try { return ([BitConverter]::ToString($sha.ComputeHash($Certificate.RawData))).Replace('-', '').ToLowerInvariant() }
  finally { $sha.Dispose() }
}

function Get-LingSignature([string]$Path) {
  $signature = Microsoft.PowerShell.Security\Get-AuthenticodeSignature -LiteralPath $Path
  return [ordered]@{
    authenticodeStatus = [string]$signature.Status
    signerSubject = if ($signature.SignerCertificate) { [string]$signature.SignerCertificate.Subject } else { $null }
    certificateSha256 = Get-LingCertificateSha256 $signature.SignerCertificate
    timestampStatus = if ($signature.TimeStamperCertificate) { 'Valid' } else { 'NotRequired' }
  }
}

function Get-LingSha256([string]$Path) {
  return ([string](Microsoft.PowerShell.Utility\Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash).ToLowerInvariant()
}

try {
  $securityModule = [IO.Path]::Combine($PSHOME, 'Modules', 'Microsoft.PowerShell.Security', 'Microsoft.PowerShell.Security.psd1')
  $utilityModule = [IO.Path]::Combine($PSHOME, 'Modules', 'Microsoft.PowerShell.Utility', 'Microsoft.PowerShell.Utility.psd1')
  $managementModule = [IO.Path]::Combine($PSHOME, 'Modules', 'Microsoft.PowerShell.Management', 'Microsoft.PowerShell.Management.psd1')
  if (![IO.File]::Exists($securityModule) -or ![IO.File]::Exists($utilityModule) -or ![IO.File]::Exists($managementModule)) {
    exit 2
  }
  Microsoft.PowerShell.Core\Import-Module -Name $securityModule -Force -ErrorAction Stop
  Microsoft.PowerShell.Core\Import-Module -Name $utilityModule -Force -ErrorAction Stop
  Microsoft.PowerShell.Core\Import-Module -Name $managementModule -Force -ErrorAction Stop

  $providerPath = $env:LING_CUA_PROVIDER_PATH
  $sealPath = $env:LING_CUA_SEAL_PATH
  $requiresCatalog = $env:LING_CUA_REQUIRE_CATALOG -eq '1'
  $catalogPath = $env:LING_CUA_CATALOG_PATH
  if (!(Microsoft.PowerShell.Management\Test-Path -LiteralPath $providerPath -PathType Leaf) -or !(Microsoft.PowerShell.Management\Test-Path -LiteralPath $sealPath -PathType Leaf)) {
    Write-LingJson ([ordered]@{ schemaVersion = 1; verdict = 'invalid'; reason = 'payload_missing' })
    exit 0
  }

  $bytes = [IO.File]::ReadAllBytes($providerPath)
  if ($bytes.Length -lt 256 -or $bytes[0] -ne 0x4d -or $bytes[1] -ne 0x5a) {
    Write-LingJson ([ordered]@{ schemaVersion = 1; verdict = 'invalid'; reason = 'pe_invalid' })
    exit 0
  }
  $peOffset = [BitConverter]::ToUInt32($bytes, 0x3c)
  if ($peOffset -lt 0x40 -or ($peOffset + 26) -gt $bytes.Length
      -or $bytes[$peOffset] -ne 0x50 -or $bytes[$peOffset + 1] -ne 0x45
      -or $bytes[$peOffset + 2] -ne 0 -or $bytes[$peOffset + 3] -ne 0) {
    Write-LingJson ([ordered]@{ schemaVersion = 1; verdict = 'invalid'; reason = 'pe_invalid' })
    exit 0
  }
  $machine = [BitConverter]::ToUInt16($bytes, $peOffset + 4)
  $magic = [BitConverter]::ToUInt16($bytes, $peOffset + 24)
  $providerSignature = Get-LingSignature $providerPath
  $provider = [ordered]@{
    path = [IO.Path]::GetFullPath($providerPath)
    sha256 = Get-LingSha256 $providerPath
    peMachine = ('0x{0:x4}' -f $machine)
    peMagic = ('0x{0:x4}' -f $magic)
    authenticodeStatus = $providerSignature.authenticodeStatus
    signerSubject = $providerSignature.signerSubject
    certificateSha256 = $providerSignature.certificateSha256
    timestampStatus = $providerSignature.timestampStatus
  }

  $catalog = $null
  if ($requiresCatalog) {
    if (!(Microsoft.PowerShell.Management\Test-Path -LiteralPath $catalogPath -PathType Leaf)) {
      Write-LingJson ([ordered]@{ schemaVersion = 1; verdict = 'invalid'; reason = 'catalog_missing' })
      exit 0
    }
    $payloadPath = [IO.Path]::GetDirectoryName($providerPath)
    try {
      $catalogResult = Microsoft.PowerShell.Security\Test-FileCatalog -CatalogFilePath $catalogPath -Path $payloadPath -Detailed -ErrorAction Stop
    } catch {
      Write-LingJson ([ordered]@{ schemaVersion = 1; verdict = 'unavailable'; reason = 'catalog_verdict_unavailable' })
      exit 0
    }
    $catalogSignature = Get-LingSignature $catalogPath
    $members = @(
      Microsoft.PowerShell.Management\Get-ChildItem -LiteralPath $payloadPath -File -Force |
        Microsoft.PowerShell.Core\ForEach-Object {
          [ordered]@{
            relativePath = ('payload/' + $_.Name)
            sha256 = Get-LingSha256 $_.FullName
          }
        } |
        Microsoft.PowerShell.Utility\Sort-Object -Property relativePath
    )
    $catalog = [ordered]@{
      path = [IO.Path]::GetFullPath($catalogPath)
      sha256 = Get-LingSha256 $catalogPath
      authenticodeStatus = $catalogSignature.authenticodeStatus
      signerSubject = $catalogSignature.signerSubject
      certificateSha256 = $catalogSignature.certificateSha256
      timestampStatus = $catalogSignature.timestampStatus
      validationStatus = [string]$catalogResult.Status
      members = $members
    }
  } elseif (![string]::IsNullOrWhiteSpace($catalogPath) -and (Microsoft.PowerShell.Management\Test-Path -LiteralPath $catalogPath -PathType Leaf)) {
    Write-LingJson ([ordered]@{ schemaVersion = 1; verdict = 'invalid'; reason = 'unsigned_catalog_present' })
    exit 0
  }

  Write-LingJson ([ordered]@{ schemaVersion = 1; verdict = 'observed'; provider = $provider; catalog = $catalog })
} catch {
  Write-LingJson ([ordered]@{ schemaVersion = 1; verdict = 'unavailable'; reason = 'verifier_exception' })
}
`;
