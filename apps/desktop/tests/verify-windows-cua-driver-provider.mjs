import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
  win32 as windowsPath,
} from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

import {
  validateCuaDriverProviderLockContract,
} from "../shared/cua-driver-provider-lock-contract.mjs";

export const WINDOWS_CUA_DRIVER_RELEASE = Object.freeze({
  repository: "trycua/cua",
  component: "cua-driver-rs",
  version: "0.8.3",
  tag: "cua-driver-rs-v0.8.3",
  assetName: "cua-driver-rs-0.8.3-windows-x86_64.zip",
  assetRoot: "cua-driver-rs-0.8.3-windows-x86_64",
  assetBytes: 10_585_087,
  sha256: "6acdc84b98629fcd0be2368cc16565c18d5f21d9dedd4e10fdb6f58547fce9d0",
  binaries: Object.freeze({
    "cua-driver.exe": Object.freeze({
      sha256: "3cc33572defac29e23bc07e211c20245da9f6ebe8e6481f865b31534b1de8cee",
    }),
    "cua-driver-uia.exe": Object.freeze({
      sha256: "1b35a27d41008507d66f819248751b9e79a15c9e6e03390c56749c6fe5daca1c",
    }),
  }),
  url: "https://github.com/trycua/cua/releases/download/cua-driver-rs-v0.8.3/cua-driver-rs-0.8.3-windows-x86_64.zip",
});

const EXPECTED_PE_MACHINE = 0x8664;
const EXPECTED_OPTIONAL_HEADER_MAGIC = 0x20b;
const DOWNLOAD_ATTEMPTS = 3;
const CHILD_OUTPUT_LIMIT = 32_768;
const PROVIDER_SEAL_MAX_BYTES = 256 * 1024;

export function resolveWindowsSystemExecutable(name, environment = process.env) {
  const systemRoot = environment.SystemRoot ?? environment.windir;
  if (typeof systemRoot !== "string" || systemRoot.trim().length === 0) {
    throw new Error("Windows SystemRoot is unavailable");
  }
  const executable = windowsPath.join(systemRoot, "System32", name);
  return executable;
}

export function resolveUnzipExecutable(platform = process.platform) {
  if (platform === "win32") {
    throw new Error("unzip is not used on Windows");
  }
  // Do not resolve archive tooling through PATH. The verifier runs before any
  // provider code and must not let a repository-local unzip shadow the system
  // utility. Both hosted macOS and Linux images provide this absolute path.
  return "/usr/bin/unzip";
}

export async function sha256File(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

export function matchesPinnedProviderVersionOutput(output) {
  const escapedVersion = WINDOWS_CUA_DRIVER_RELEASE.version.replaceAll(".", "\\.");
  const exactVersionPattern = new RegExp(
    `(^|[^0-9A-Za-z.+-])v?${escapedVersion}($|[^0-9A-Za-z.+-])`,
    "u",
  );
  return exactVersionPattern.test(output);
}

export function inspectWindowsX64Pe(buffer, label = "Windows provider binary") {
  if (!Buffer.isBuffer(buffer) || buffer.length < 0x100) {
    throw new Error(`${label} is too small to be a PE executable`);
  }
  if (buffer[0] !== 0x4d || buffer[1] !== 0x5a) {
    throw new Error(`${label} is missing the DOS MZ header`);
  }

  const peOffset = buffer.readUInt32LE(0x3c);
  if (peOffset < 0x40 || peOffset + 24 > buffer.length) {
    throw new Error(`${label} has an invalid PE header offset`);
  }
  if (!buffer.subarray(peOffset, peOffset + 4).equals(Buffer.from([0x50, 0x45, 0, 0]))) {
    throw new Error(`${label} is missing the PE signature`);
  }

  const machine = buffer.readUInt16LE(peOffset + 4);
  if (machine !== EXPECTED_PE_MACHINE) {
    throw new Error(
      `${label} must target Windows x86_64 (PE machine 0x8664), found 0x${machine.toString(16).padStart(4, "0")}`,
    );
  }

  const optionalHeaderSize = buffer.readUInt16LE(peOffset + 20);
  const optionalHeaderOffset = peOffset + 24;
  if (optionalHeaderSize < 112 || optionalHeaderOffset + optionalHeaderSize > buffer.length) {
    throw new Error(`${label} has an invalid PE32+ optional header`);
  }
  const optionalHeaderMagic = buffer.readUInt16LE(optionalHeaderOffset);
  if (optionalHeaderMagic !== EXPECTED_OPTIONAL_HEADER_MAGIC) {
    throw new Error(
      `${label} must be PE32+ (magic 0x20b), found 0x${optionalHeaderMagic.toString(16)}`,
    );
  }

  // The certificate-table directory says whether a signature blob is embedded. It does
  // not establish signer trust; only Get-AuthenticodeSignature on Windows does that.
  const certificateDirectoryOffset = optionalHeaderOffset + 112 + 4 * 8;
  const certificateDirectoryAvailable = optionalHeaderSize >= 112 + 5 * 8;
  const certificateTableOffset = certificateDirectoryAvailable
    ? buffer.readUInt32LE(certificateDirectoryOffset)
    : 0;
  const certificateTableSize = certificateDirectoryAvailable
    ? buffer.readUInt32LE(certificateDirectoryOffset + 4)
    : 0;

  return {
    format: "PE32+",
    machine: "0x8664",
    architecture: "x86_64",
    embeddedCertificateTablePresent: certificateTableOffset > 0 && certificateTableSize > 0,
  };
}

export async function verifyPinnedWindowsProviderArchive(archivePath) {
  const archiveStat = await stat(archivePath);
  if (!archiveStat.isFile()) {
    throw new Error(`Pinned provider archive is not a file: ${archivePath}`);
  }
  if (archiveStat.size !== WINDOWS_CUA_DRIVER_RELEASE.assetBytes) {
    throw new Error(
      `Pinned provider archive size mismatch: expected ${WINDOWS_CUA_DRIVER_RELEASE.assetBytes}, found ${archiveStat.size}`,
    );
  }
  const sha256 = await sha256File(archivePath);
  if (sha256 !== WINDOWS_CUA_DRIVER_RELEASE.sha256) {
    throw new Error(
      `Pinned provider archive SHA-256 mismatch: expected ${WINDOWS_CUA_DRIVER_RELEASE.sha256}, found ${sha256}`,
    );
  }
  return {
    bytes: archiveStat.size,
    sha256,
  };
}

export async function verifyWindowsProviderBinary(binaryPath, label) {
  const bytes = await readFile(binaryPath);
  const expectedSha256 = WINDOWS_CUA_DRIVER_RELEASE.binaries[label]?.sha256;
  if (!expectedSha256) {
    throw new Error(`Unexpected Windows provider binary: ${label}`);
  }
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (sha256 !== expectedSha256) {
    throw new Error(
      `${label} SHA-256 mismatch: expected ${expectedSha256}, found ${sha256}`,
    );
  }
  return {
    name: label,
    path: resolve(binaryPath),
    bytes: bytes.length,
    sha256,
    ...inspectWindowsX64Pe(bytes, label),
  };
}

export function isPathWithin(candidatePath, rootPath) {
  const normalizedCandidate = normalizeForComparison(resolve(candidatePath));
  const normalizedRoot = normalizeForComparison(resolve(rootPath));
  const pathFromRoot = relative(normalizedRoot, normalizedCandidate);
  return pathFromRoot.length > 0 && pathFromRoot !== ".." && !pathFromRoot.startsWith(`..${sep}`) && !isAbsolute(pathFromRoot);
}

export async function acquirePinnedWindowsProvider({
  outputDirectory,
  archivePath,
  keep = false,
  fetchImpl = globalThis.fetch,
} = {}) {
  const ownsTemporaryDirectory = !outputDirectory;
  const rootDirectory = outputDirectory
    ? await createExplicitTemporaryDirectory(outputDirectory)
    : await mkdtemp(join(tmpdir(), "ling-cua-driver-rs-v0.8.3-"));
  const retain = Boolean(outputDirectory || keep);

  try {
    const resolvedArchivePath = archivePath
      ? resolve(archivePath)
      : join(rootDirectory, WINDOWS_CUA_DRIVER_RELEASE.assetName);
    if (!archivePath) {
      await downloadPinnedArchive(resolvedArchivePath, fetchImpl);
    }

    const archive = await verifyPinnedWindowsProviderArchive(resolvedArchivePath);
    const extractionDirectory = join(rootDirectory, "provider");
    await mkdir(extractionDirectory);
    await extractZip(resolvedArchivePath, extractionDirectory);

    const providerDirectory = join(extractionDirectory, WINDOWS_CUA_DRIVER_RELEASE.assetRoot);
    const mainBinaryPath = join(providerDirectory, "cua-driver.exe");
    const uiaBinaryPath = join(providerDirectory, "cua-driver-uia.exe");
    const binaries = await Promise.all([
      verifyWindowsProviderBinary(mainBinaryPath, "cua-driver.exe"),
      verifyWindowsProviderBinary(uiaBinaryPath, "cua-driver-uia.exe"),
    ]);
    const versionProbe = await probePinnedProviderVersion(mainBinaryPath);
    const authenticode = await inspectAuthenticode([mainBinaryPath, uiaBinaryPath]);

    return {
      report: {
        schemaVersion: 1,
        mode: archivePath ? "local_pinned_archive" : "downloaded_pinned_release",
        release: WINDOWS_CUA_DRIVER_RELEASE,
        archive: {
          path: resolvedArchivePath,
          checksumVerified: true,
          ...archive,
        },
        binaries,
        versionProbe,
        authenticode,
        installation: {
          globalStateModified: false,
          upstreamInstallerExecuted: false,
          outputDirectory: rootDirectory,
          retained: retain,
        },
        signingClaim: authenticode.checked
          ? "Reported from Windows Get-AuthenticodeSignature; no signature status is assumed."
          : "Not checked on this host; archive checksum and PE architecture do not prove Authenticode trust.",
      },
      cleanup: retain ? async () => {} : async () => rm(rootDirectory, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(rootDirectory, { recursive: true, force: true });
    throw error;
  }
}

export async function verifyInstalledWindowsProvider(mainBinaryPath, options = {}) {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") {
    throw new Error("--installed-binary is supported only on Windows because version and Authenticode checks must run there");
  }
  const resolvedMainBinaryPath = resolve(mainBinaryPath);
  const payloadDirectory = dirname(resolvedMainBinaryPath);
  const platformRoot = dirname(payloadDirectory);
  const distributionRoot = dirname(platformRoot);
  const uiaBinaryPath = join(dirname(resolvedMainBinaryPath), "cua-driver-uia.exe");
  const providerSealPath = join(payloadDirectory, "provider-seal.json");
  const providerCatalogPath = join(platformRoot, "provider-integrity.cat");
  const providerLockPath = join(distributionRoot, "provider-lock.json");
  const [distributionEntries, platformEntries, payloadEntries] = await Promise.all([
    readdir(distributionRoot, { withFileTypes: true }),
    readdir(platformRoot, { withFileTypes: true }),
    readdir(payloadDirectory, { withFileTypes: true }),
  ]);
  assertExactProviderDirectory(
    distributionEntries,
    {
      "provider-lock.json": "file",
      "win32-x64": "directory",
    },
    "Standard bundled provider distribution root",
  );
  assertExactProviderDirectory(
    platformEntries,
    {
      "payload": "directory",
      "provider-integrity.cat": "file",
    },
    "Standard bundled provider platform root",
  );
  const expectedPayloadFileNames = ["ling-cua-driver.exe", "provider-seal.json"];
  const payloadFileNames = payloadEntries
    .map((entry) => entry.name)
    .sort();
  const payloadLayoutValid =
    payloadEntries.length === expectedPayloadFileNames.length &&
    payloadEntries.every((entry) => entry.isFile()) &&
    JSON.stringify(payloadFileNames) === JSON.stringify(expectedPayloadFileNames);
  if (!payloadLayoutValid) {
    throw new Error(
      `Standard bundled provider payload must contain exactly two ordinary files: ${expectedPayloadFileNames.join(", ")}; observed: ${payloadFileNames.join(", ") || "empty"}`,
    );
  }
  const [providerBytes, providerSealBytes, providerCatalogBytes, providerLockBytes] =
    await Promise.all([
      readFile(resolvedMainBinaryPath),
      readFile(providerSealPath),
      readFile(providerCatalogPath),
      readFile(providerLockPath),
    ]);
  const provider = {
    name: "ling-cua-driver.exe",
    path: resolvedMainBinaryPath,
    bytes: providerBytes.length,
    sha256: createHash("sha256").update(providerBytes).digest("hex"),
    ...inspectWindowsX64Pe(providerBytes, "ling-cua-driver.exe"),
  };
  const providerSeal = {
    path: resolve(providerSealPath),
    bytes: providerSealBytes.length,
    sha256: createHash("sha256").update(providerSealBytes).digest("hex"),
  };
  const providerLock = {
    path: resolve(providerLockPath),
    bytes: providerLockBytes.length,
    sha256: createHash("sha256").update(providerLockBytes).digest("hex"),
  };
  const providerCatalog = {
    path: resolve(providerCatalogPath),
    bytes: providerCatalogBytes.length,
    sha256: createHash("sha256").update(providerCatalogBytes).digest("hex"),
  };
  const lock = validateInstalledProviderLock(providerLockBytes);
  const seal = validateInstalledProviderSeal(providerSealBytes, {
    providerSha256: provider.sha256,
    providerLockSha256: providerLock.sha256,
    lock,
  });
  const identityInspector =
    options.identityInspector ?? inspectInstalledWindowsProviderIdentity;
  const identity = validateInstalledWindowsProviderIdentity(
    await identityInspector({
      providerPath: resolvedMainBinaryPath,
      sealPath: providerSealPath,
      catalogPath: providerCatalogPath,
      payloadDirectory,
    }),
    {
      providerPath: resolvedMainBinaryPath,
      catalogPath: providerCatalogPath,
      providerSha256: provider.sha256,
      providerSealSha256: providerSeal.sha256,
      seal,
    },
  );
  const versionProbe = await (
    options.versionProbe ?? probePinnedProviderVersion
  )(resolvedMainBinaryPath);
  return {
    schemaVersion: 2,
    mode: "installed_bundled_provider_read_only",
    provider,
    providerLock: {
      ...providerLock,
      componentId: lock.platforms.win32X64.componentId,
      sourceTarget: lock.platforms.win32X64.sourceBuild.target,
      sourceBuild: {
        target: lock.platforms.win32X64.sourceBuild.target,
        binariesSha256BeforeSigning: {
          main:
            lock.platforms.win32X64.sourceBuild.binariesSha256BeforeSigning.main,
        },
      },
    },
    providerSeal: {
      ...providerSeal,
      schemaVersion: seal.schemaVersion,
      componentId: seal.componentId,
      lockSha256: seal.lockSha256,
      signingTier: seal.signingTier,
      distributionChannel: seal.distributionChannel,
      productionEligible: seal.productionEligible,
      ...(Object.hasOwn(seal, "testAuthorityKind")
        ? { testAuthorityKind: seal.testAuthorityKind }
        : {}),
      main: { ...seal.main },
    },
    providerCatalog: {
      ...providerCatalog,
      membership: identity.catalogMembership,
    },
    uiAccessHelper: {
      path: resolve(uiaBinaryPath),
      packaged: false,
      exists: false,
    },
    packageLayout: {
      distributionRootEntryNames: distributionEntries.map((entry) => entry.name).sort(),
      platformRootEntryNames: platformEntries.map((entry) => entry.name).sort(),
      payloadFileNames,
      unexpectedPaths: [],
    },
    versionProbe,
    authenticode: identity.authenticode,
    installation: {
      globalStateModified: false,
      upstreamInstallerExecuted: false,
      outputDirectory: null,
      retained: true,
    },
    signingClaim:
      "Observed with Windows Get-AuthenticodeSignature and Test-FileCatalog; the catalog must cover exactly the installed provider and provider seal.",
  };
}

function assertExactProviderDirectory(entries, expectedEntries, label) {
  const observedNames = entries.map((entry) => entry.name).sort();
  const expectedNames = Object.keys(expectedEntries).sort();
  const valid =
    JSON.stringify(observedNames) === JSON.stringify(expectedNames)
    && entries.every((entry) => (
      expectedEntries[entry.name] === "file"
        ? entry.isFile()
        : entry.isDirectory()
    ));
  if (!valid) {
    throw new Error(
      `${label} must contain exactly ${expectedNames.join(", ")}; observed: ${observedNames.join(", ") || "empty"}`,
    );
  }
}

function validateInstalledProviderLock(bytes) {
  const value = parseBoundedJson(
    bytes,
    PROVIDER_SEAL_MAX_BYTES,
    "Installed provider lock",
  );
  try {
    return validateCuaDriverProviderLockContract(value, {
      platform: "win32",
      architecture: "x86_64",
      requireReleaseEvidence: true,
    });
  } catch (error) {
    throw new Error(
      `Installed provider lock is invalid: ${error?.code ?? error?.message ?? error}`,
    );
  }
}

export function validateInstalledProviderSeal(bytes, {
  providerSha256,
  providerLockSha256,
  lock,
}) {
  const value = parseBoundedJson(
    bytes,
    PROVIDER_SEAL_MAX_BYTES,
    "Installed provider seal",
  );
  const platformLock = lock?.platforms?.win32X64;
  if (
    !isRecord(value) ||
    value.schemaVersion !== 2 ||
    value.componentId !== "cua-driver-win32-x64" ||
    value.distributionRevision !== "ling.1" ||
    value.providerVersion !== "0.8.3" ||
    value.serverInitializeProtocolVersion !== "2025-06-18" ||
    value.healthSchemaVersion !== "1" ||
    value.stateSchemaVersion !== 1 ||
    !isSha256(value.lockSha256) ||
    value.lockSha256 !== providerLockSha256 ||
    !isSha256(value.toolsListCanonicalSha256) ||
    !Array.isArray(value.limitations) ||
    value.limitations.join(",") !== "elevated_pixel_input,uwp_send_input" ||
    !isRecord(value.main) ||
    value.main.relativePath !== "payload/ling-cua-driver.exe" ||
    value.main.architecture !== "x86_64" ||
    !isSha256(value.main.sha256) ||
    value.main.sha256 !== providerSha256 ||
    !isSha256(value.main.peManifestCanonicalSha256) ||
    value.main.authenticodeStatus !== "Valid" ||
    !hasText(value.main.signerSubject) ||
    !isSha256(value.main.certificateSha256) ||
    value.integrityCatalogRelativePath !== "provider-integrity.cat" ||
    !isRecord(platformLock) ||
    platformLock.componentId !== value.componentId ||
    platformLock.binary?.architecture !== value.main.architecture ||
    platformLock.binary?.mainRelativePath !== value.main.relativePath ||
    platformLock.binary?.providerSealRelativePath !== "payload/provider-seal.json" ||
    platformLock.binary?.mainManifestCanonicalSha256 !==
      value.main.peManifestCanonicalSha256 ||
    platformLock.compatibility?.toolsListSha256 !==
      value.toolsListCanonicalSha256 ||
    platformLock.compatibility?.serverInitializeProtocolVersion !==
      value.serverInitializeProtocolVersion ||
    platformLock.compatibility?.healthSchemaVersion !== value.healthSchemaVersion ||
    platformLock.runtime?.stateSchemaVersion !== value.stateSchemaVersion ||
    platformLock.runtime?.limitations?.join(",") !== value.limitations.join(",")
  ) {
    throw new Error("Installed provider seal does not match the provider/source-lock tuple");
  }
  const tuple = value.signingTier === "test_signed_internal"
    ? {
        distributionChannel: "internal",
        productionEligible: false,
        timestampPolicy: "internal-policy",
      }
    : value.signingTier === "production_signed"
      ? {
          distributionChannel: "production",
          productionEligible: true,
          timestampPolicy: "rfc3161-required",
        }
      : null;
  if (
    !tuple ||
    value.distributionChannel !== tuple.distributionChannel ||
    value.productionEligible !== tuple.productionEligible ||
    value.main.timestampPolicy !== tuple.timestampPolicy ||
    !["NotRequired", "Valid"].includes(value.main.timestampStatus) ||
    (value.signingTier === "production_signed" &&
      value.main.timestampStatus !== "Valid") ||
    platformLock.binary.integrityCatalogRelativePathBySigningTier?.[
      value.signingTier
    ] !== value.integrityCatalogRelativePath ||
    platformLock.binary.packagedFilesBySigningTier?.[value.signingTier]?.join(",") !==
      "provider-integrity.cat,payload/ling-cua-driver.exe,payload/provider-seal.json" ||
    (value.signingTier === "test_signed_internal" &&
      !["ephemeral-ci", "managed-internal"].includes(value.testAuthorityKind)) ||
    (value.signingTier === "production_signed" &&
      Object.hasOwn(value, "testAuthorityKind"))
  ) {
    throw new Error("Installed provider seal signing tier/channel tuple is invalid");
  }
  return structuredClone(value);
}

export function validateInstalledWindowsProviderIdentity(value, expected) {
  if (
    !isRecord(value) ||
    !isRecord(value.authenticode) ||
    value.authenticode.checked !== true ||
    !Array.isArray(value.authenticode.files) ||
    !isRecord(value.catalogMembership) ||
    value.catalogMembership.checked !== true ||
    value.catalogMembership.validationStatus !== "Valid" ||
    !Array.isArray(value.catalogMembership.members)
  ) {
    throw new Error("Installed provider Windows identity evidence is invalid");
  }
  const signatures = new Map(
    value.authenticode.files.map((entry) => [
      normalizeForComparison(resolve(entry?.path ?? "")),
      entry,
    ]),
  );
  const providerSignature = signatures.get(
    normalizeForComparison(resolve(expected.providerPath)),
  );
  const catalogSignature = signatures.get(
    normalizeForComparison(resolve(expected.catalogPath)),
  );
  if (
    providerSignature?.status !== "Valid" ||
    providerSignature.signerSubject !== expected.seal.main.signerSubject ||
    providerSignature.certificateSha256 !==
      expected.seal.main.certificateSha256 ||
    providerSignature.timestampStatus !== expected.seal.main.timestampStatus ||
    catalogSignature?.status !== "Valid" ||
    !hasText(catalogSignature.signerSubject) ||
    !isSha256(catalogSignature.certificateSha256) ||
    !["NotRequired", "Valid"].includes(catalogSignature.timestampStatus) ||
    (expected.seal.signingTier === "production_signed" &&
      catalogSignature.timestampStatus !== "Valid")
  ) {
    throw new Error("Installed provider Authenticode identity does not match its seal");
  }
  const actualMembers = value.catalogMembership.members
    .map((member) => ({
      relativePath: String(member?.relativePath ?? "").replaceAll("\\", "/"),
      sha256: member?.sha256,
    }))
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  const expectedMembers = [
    {
      relativePath: "payload/ling-cua-driver.exe",
      sha256: expected.providerSha256,
    },
    {
      relativePath: "payload/provider-seal.json",
      sha256: expected.providerSealSha256,
    },
  ];
  if (JSON.stringify(actualMembers) !== JSON.stringify(expectedMembers)) {
    throw new Error(
      "Installed provider catalog does not cover exactly the provider and seal",
    );
  }
  return {
    authenticode: {
      checked: true,
      trustRequired: true,
      files: value.authenticode.files.map((entry) => ({ ...entry })),
    },
    catalogMembership: {
      checked: true,
      validationStatus: "Valid",
      members: actualMembers,
    },
  };
}

export async function inspectInstalledWindowsProviderIdentity({
  providerPath,
  sealPath,
  catalogPath,
  payloadDirectory,
}) {
  const result = await runChild(
    resolveWindowsSystemExecutable("WindowsPowerShell\\v1.0\\powershell.exe"),
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", WINDOWS_INSTALLED_PROVIDER_IDENTITY_SCRIPT],
    {
      env: {
        ...process.env,
        LING_CUA_PROVIDER_BINARY: providerPath,
        LING_CUA_PROVIDER_SEAL: sealPath,
        LING_CUA_PROVIDER_CATALOG: catalogPath,
        LING_CUA_PROVIDER_PAYLOAD: payloadDirectory,
      },
      timeoutMs: 30_000,
    },
  );
  try {
    return JSON.parse(result.stdout.trim());
  } catch (error) {
    throw new Error(
      `Installed provider Windows identity output is invalid: ${error?.message ?? error}`,
    );
  }
}

export const WINDOWS_INSTALLED_PROVIDER_IDENTITY_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$securityModule = [IO.Path]::Combine($PSHOME, 'Modules', 'Microsoft.PowerShell.Security', 'Microsoft.PowerShell.Security.psd1')
$utilityModule = [IO.Path]::Combine($PSHOME, 'Modules', 'Microsoft.PowerShell.Utility', 'Microsoft.PowerShell.Utility.psd1')
$managementModule = [IO.Path]::Combine($PSHOME, 'Modules', 'Microsoft.PowerShell.Management', 'Microsoft.PowerShell.Management.psd1')
if (![IO.File]::Exists($securityModule) -or ![IO.File]::Exists($utilityModule) -or ![IO.File]::Exists($managementModule)) { throw 'Trusted Windows PowerShell modules are missing' }
Microsoft.PowerShell.Core\Import-Module -Name $securityModule -Force -ErrorAction Stop
Microsoft.PowerShell.Core\Import-Module -Name $utilityModule -Force -ErrorAction Stop
Microsoft.PowerShell.Core\Import-Module -Name $managementModule -Force -ErrorAction Stop
function Get-LingCertificateSha256([object]$Certificate) {
  if ($null -eq $Certificate) { return $null }
  $sha = [Security.Cryptography.SHA256]::Create()
  try { return ([BitConverter]::ToString($sha.ComputeHash($Certificate.RawData))).Replace('-', '').ToLowerInvariant() }
  finally { $sha.Dispose() }
}
function Get-LingSignature([string]$Path) {
  $signature = Microsoft.PowerShell.Security\Get-AuthenticodeSignature -LiteralPath $Path
  return [ordered]@{
    path = [IO.Path]::GetFullPath($Path)
    status = [string]$signature.Status
    statusMessage = [string]$signature.StatusMessage
    signerSubject = if ($signature.SignerCertificate) { [string]$signature.SignerCertificate.Subject } else { $null }
    certificateSha256 = Get-LingCertificateSha256 $signature.SignerCertificate
    timestampStatus = if ($signature.TimeStamperCertificate) { 'Valid' } else { 'NotRequired' }
  }
}
function Get-LingSha256([string]$Path) {
  return ([string](Microsoft.PowerShell.Utility\Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash).ToLowerInvariant()
}
$catalogResult = Microsoft.PowerShell.Security\Test-FileCatalog -CatalogFilePath $env:LING_CUA_PROVIDER_CATALOG -Path $env:LING_CUA_PROVIDER_PAYLOAD -Detailed -ErrorAction Stop
$payloadRoot = [IO.Path]::GetFullPath($env:LING_CUA_PROVIDER_PAYLOAD)
$members = @(
  Microsoft.PowerShell.Management\Get-ChildItem -LiteralPath $payloadRoot -File -Force -Recurse |
    Microsoft.PowerShell.Core\ForEach-Object {
      $relativePath = $_.FullName.Substring($payloadRoot.Length).TrimStart([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar).Replace('\', '/')
      [ordered]@{ relativePath = ('payload/' + $relativePath); sha256 = Get-LingSha256 $_.FullName }
    } |
    Microsoft.PowerShell.Utility\Sort-Object -Property relativePath
)
[ordered]@{
  authenticode = [ordered]@{
    checked = $true
    files = @(
      Get-LingSignature $env:LING_CUA_PROVIDER_BINARY
      Get-LingSignature $env:LING_CUA_PROVIDER_CATALOG
    )
  }
  catalogMembership = [ordered]@{
    checked = $true
    validationStatus = [string]$catalogResult.Status
    members = $members
  }
} | Microsoft.PowerShell.Utility\ConvertTo-Json -Compress -Depth 8
`;

function parseBoundedJson(bytes, maxBytes, label) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > maxBytes) {
    throw new Error(`${label} is missing or oversized`);
  }
  try {
    return JSON.parse(bytes.toString("utf8").replace(/^\uFEFF/u, ""));
  } catch (error) {
    throw new Error(`${label} JSON is invalid: ${error?.message ?? error}`);
  }
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasText(value) {
  return typeof value === "string" && value.length > 0 && value === value.trim();
}

function isSha256(value) {
  return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value) && !/^0{64}$/u.test(value);
}

async function createExplicitTemporaryDirectory(outputDirectory) {
  const candidate = resolve(outputDirectory);
  const allowedRoots = [tmpdir(), process.env.RUNNER_TEMP]
    .filter((value) => typeof value === "string" && value.trim().length > 0)
    .map((value) => resolve(value));
  const resolvedRoots = await Promise.all(
    allowedRoots.map(async (root) => {
      try {
        return await realpath(root);
      } catch {
        return root;
      }
    }),
  );
  const parentDirectory = dirname(candidate);
  let resolvedParentDirectory;
  try {
    resolvedParentDirectory = await realpath(parentDirectory);
  } catch (error) {
    throw new Error(`--output-dir parent does not exist: ${parentDirectory} (${error?.message ?? error})`);
  }
  if (
    !resolvedRoots.some(
      (root) => samePath(resolvedParentDirectory, root) || isPathWithin(resolvedParentDirectory, root),
    )
  ) {
    throw new Error(
      `--output-dir must be a new child of the OS temp directory${process.env.RUNNER_TEMP ? " or RUNNER_TEMP" : ""}`,
    );
  }
  // Resolve the parent before creating the final component. This prevents a
  // symlink under /tmp from redirecting the verifier into a user directory.
  const safeCandidate = join(resolvedParentDirectory, candidate.slice(parentDirectory.length + 1));
  await access(resolvedParentDirectory);
  await mkdir(safeCandidate);
  return safeCandidate;
}

async function downloadPinnedArchive(destinationPath, fetchImpl) {
  if (typeof fetchImpl !== "function") {
    throw new Error("A Fetch-compatible implementation is required to download the pinned provider archive");
  }
  let lastError;
  for (let attempt = 1; attempt <= DOWNLOAD_ATTEMPTS; attempt += 1) {
    const partialPath = `${destinationPath}.partial`;
    try {
      await rm(partialPath, { force: true });
      const response = await fetchImpl(WINDOWS_CUA_DRIVER_RELEASE.url, {
        redirect: "follow",
        headers: {
          "User-Agent": "ling-stack-desktop-provider-verifier/1",
        },
      });
      if (!response.ok || !response.body) {
        throw new Error(`Provider download returned HTTP ${response.status}`);
      }
      await pipeline(Readable.fromWeb(response.body), createWriteStream(partialPath, { flags: "wx" }));
      await rename(partialPath, destinationPath);
      return;
    } catch (error) {
      lastError = error;
      await rm(partialPath, { force: true });
      if (attempt < DOWNLOAD_ATTEMPTS) {
        await wait(attempt * 500);
      }
    }
  }
  throw new Error(`Unable to download the pinned Windows provider archive: ${lastError?.message ?? lastError}`);
}

async function extractZip(archivePath, destinationPath) {
  if (process.platform === "win32") {
    const command = [
      "$ErrorActionPreference = 'Stop'",
      "Expand-Archive -LiteralPath $env:LING_CUA_PROVIDER_ARCHIVE -DestinationPath $env:LING_CUA_PROVIDER_DESTINATION",
    ].join("; ");
    await runChild(
      resolveWindowsSystemExecutable("WindowsPowerShell\\v1.0\\powershell.exe"),
      ["-NoProfile", "-NonInteractive", "-Command", command],
      {
        env: {
          ...process.env,
          LING_CUA_PROVIDER_ARCHIVE: archivePath,
          LING_CUA_PROVIDER_DESTINATION: destinationPath,
        },
      },
    );
    return;
  }
  await runChild(resolveUnzipExecutable(), ["-q", archivePath, "-d", destinationPath]);
}

async function probePinnedProviderVersion(binaryPath) {
  if (process.platform !== "win32") {
    return {
      checked: false,
      expectedVersion: WINDOWS_CUA_DRIVER_RELEASE.version,
      reason: "Windows executable version probes are not run on a non-Windows host.",
    };
  }
  const result = await runChild(binaryPath, ["--version"], {
    cwd: dirname(binaryPath),
    timeoutMs: 10_000,
  });
  const output = `${result.stdout}\n${result.stderr}`.trim();
  if (!matchesPinnedProviderVersionOutput(output)) {
    throw new Error(
      `Installed provider version output does not identify ${WINDOWS_CUA_DRIVER_RELEASE.version}: ${output || "<empty>"}`,
    );
  }
  return {
    checked: true,
    expectedVersion: WINDOWS_CUA_DRIVER_RELEASE.version,
    output,
  };
}

async function inspectAuthenticode(binaryPaths) {
  if (process.platform !== "win32") {
    return {
      checked: false,
      reason: "Authenticode trust is not evaluated on a non-Windows host.",
      files: binaryPaths.map((binaryPath) => ({ path: resolve(binaryPath), status: "not_checked" })),
    };
  }
  const command = [
    "$ErrorActionPreference = 'Stop'",
    "$securityModulePath = [System.IO.Path]::Combine($PSHOME, 'Modules', 'Microsoft.PowerShell.Security', 'Microsoft.PowerShell.Security.psd1')",
    "if (![System.IO.File]::Exists($securityModulePath)) { throw \"Trusted Windows PowerShell security module is missing: $securityModulePath\" }",
    "Microsoft.PowerShell.Core\\Import-Module -Name $securityModulePath -Force -ErrorAction Stop",
    "$signature = Microsoft.PowerShell.Security\\Get-AuthenticodeSignature -FilePath $env:LING_CUA_PROVIDER_BINARY",
    "$certificateSha256 = if ($signature.SignerCertificate) { $sha256 = [System.Security.Cryptography.SHA256]::Create(); try { ([System.BitConverter]::ToString($sha256.ComputeHash($signature.SignerCertificate.RawData))).Replace('-', '').ToLowerInvariant() } finally { $sha256.Dispose() } } else { $null }",
    "[PSCustomObject]@{ Path = $env:LING_CUA_PROVIDER_BINARY; Status = [string]$signature.Status; StatusMessage = $signature.StatusMessage; SignerSubject = if ($signature.SignerCertificate) { $signature.SignerCertificate.Subject } else { $null }; CertificateSha256 = $certificateSha256 } | ConvertTo-Json -Compress",
  ].join("; ");
  const items = await Promise.all(
    binaryPaths.map(async (binaryPath) => {
      const result = await runChild(
        resolveWindowsSystemExecutable("WindowsPowerShell\\v1.0\\powershell.exe"),
        ["-NoProfile", "-NonInteractive", "-Command", command],
        {
          env: {
            ...process.env,
            LING_CUA_PROVIDER_BINARY: binaryPath,
          },
        },
      );
      return JSON.parse(result.stdout.trim());
    }),
  );
  return {
    checked: true,
    trustRequired: false,
    files: items.map((item) => ({
      path: item.Path,
      status: item.Status,
      statusMessage: item.StatusMessage,
      signerSubject: item.SignerSubject || null,
      certificateSha256: item.CertificateSha256 || null,
    })),
  };
}

export async function runChild(
  command,
  args,
  { cwd, env, timeoutMs = 30_000 } = {},
) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd,
      env,
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    let forcedSettlement;
    const timeout = setTimeout(() => {
      timedOut = true;
      void terminateChildTree(child)
        .catch(() => {})
        .finally(() => {
          if (child.exitCode === null && child.signalCode === null) {
            child.kill("SIGKILL");
          }
        });
      forcedSettlement = setTimeout(() => {
        settleReject(new Error(`${command} timed out after ${timeoutMs}ms`));
      }, 10_000);
    }, timeoutMs);
    const settleReject = (error) => {
      if (settled) return;
      settled = true;
      rejectPromise(error);
    };
    const settleResolve = (value) => {
      if (settled) return;
      settled = true;
      resolvePromise(value);
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout = appendBounded(stdout, chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr = appendBounded(stderr, chunk);
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      clearTimeout(forcedSettlement);
      settleReject(error);
    });
    child.once("close", (exitCode, signal) => {
      clearTimeout(timeout);
      clearTimeout(forcedSettlement);
      if (timedOut) {
        settleReject(new Error(`${command} timed out after ${timeoutMs}ms`));
      } else if (exitCode !== 0) {
        settleReject(
          new Error(
            `${command} exited ${exitCode ?? signal ?? "unknown"}: ${`${stdout}\n${stderr}`.trim() || "<no output>"}`,
          ),
        );
      } else {
        settleResolve({ stdout, stderr });
      }
    });
  });
}

async function terminateChildTree(child) {
  if (!child?.pid) return;
  if (process.platform === "win32") {
    await new Promise((resolvePromise) => {
      const killer = spawn(
        resolveWindowsSystemExecutable("taskkill.exe"),
        ["/PID", String(child.pid), "/T", "/F"],
        { windowsHide: true, stdio: "ignore" },
      );
      const fallback = setTimeout(() => {
        killer.kill();
        resolvePromise();
      }, 5_000);
      killer.once("error", () => {
        clearTimeout(fallback);
        resolvePromise();
      });
      killer.once("close", () => {
        clearTimeout(fallback);
        resolvePromise();
      });
    });
    return;
  }
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}

function appendBounded(current, chunk) {
  const next = `${current}${String(chunk)}`;
  return next.length <= CHILD_OUTPUT_LIMIT ? next : next.slice(-CHILD_OUTPUT_LIMIT);
}

function normalizeForComparison(pathValue) {
  return process.platform === "win32" ? pathValue.toLowerCase() : pathValue;
}

function samePath(left, right) {
  return normalizeForComparison(resolve(left)) === normalizeForComparison(resolve(right));
}

function wait(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

function printHelp() {
  process.stdout.write(`Usage:\n\n`);
  process.stdout.write(`  node apps/desktop/tests/verify-windows-cua-driver-provider.mjs [--output-dir <temp-path>] [--archive <zip>] [--keep]\n`);
  process.stdout.write(`  node apps/desktop/tests/verify-windows-cua-driver-provider.mjs --installed-binary <cua-driver.exe>\n\n`);
  process.stdout.write(`The acquisition path downloads only the pinned release asset, verifies its exact size and SHA-256, and extracts it under a test temp directory. It never runs the upstream installer or writes to an installation directory.\n`);
}

async function main() {
  const { values } = parseArgs({
    options: {
      "output-dir": { type: "string" },
      archive: { type: "string" },
      "installed-binary": { type: "string" },
      keep: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
    allowPositionals: false,
  });
  if (values.help) {
    printHelp();
    return;
  }
  if (values["installed-binary"]) {
    if (values["output-dir"] || values.archive || values.keep) {
      throw new Error("--installed-binary cannot be combined with acquisition options");
    }
    const report = await verifyInstalledWindowsProvider(values["installed-binary"]);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  const acquired = await acquirePinnedWindowsProvider({
    outputDirectory: values["output-dir"],
    archivePath: values.archive,
    keep: values.keep,
  });
  try {
    process.stdout.write(`${JSON.stringify(acquired.report, null, 2)}\n`);
  } finally {
    await acquired.cleanup();
  }
}

const entrypoint = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (entrypoint === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`Windows Cua Driver provider verification failed: ${error?.message ?? error}\n`);
    process.exitCode = 1;
  });
}
