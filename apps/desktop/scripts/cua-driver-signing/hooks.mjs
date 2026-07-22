import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { validateCuaDriverPackageAuthority } from "../../shared/cua-driver-package-authority-contract.mjs";
import { verifyCuaDriverPackagedHostAuthority } from "../cua-driver-package-host-authority.mjs";
import {
  createDisposableFixtureSigner,
  readFixtureFileSignature,
  verifyFixtureCatalog,
} from "./fixture-signer.mjs";
import {
  listProviderPayloadFiles,
  resolveProviderLayout,
} from "./provider-layout.mjs";
import {
  createProviderSeal,
  verifyProviderTuple,
  writeProviderSeal,
} from "./provider-seal.mjs";
import {
  SigningContractError,
  canonicalJson,
  normalizeSigningPlatform,
  resolveSigningProfile,
  sha256Bytes,
  sha256File,
} from "./signing-contract.mjs";
import {
  appendSigningTrace,
  readSigningState,
  resolveSigningStateDirectory,
  signingStateFingerprint,
  writeSigningState,
} from "./signing-trace.mjs";

const PROVIDER_EXECUTABLE_SUFFIXES = Object.freeze([
  ".app",
  ".com",
  ".dll",
  ".dylib",
  ".exe",
  ".msi",
  ".node",
  ".sys",
]);
const PACKAGER_SIGNING_CONTEXTS_PROPERTY = "__lingSigningContexts";

let processRuntimeOptions = Object.freeze({});
const activeSigningOutputs = new Map();
let environmentFixtureSigner;

/** Configure an injected signer or extractor for the current Node process. */
export function configureProviderSigningHooks(options = {}) {
  processRuntimeOptions = Object.freeze({ ...options });
}

export function resetProviderSigningHooks() {
  processRuntimeOptions = Object.freeze({});
  activeSigningOutputs.clear();
  environmentFixtureSigner = undefined;
}

export async function runAfterPack(context, callOptions = {}) {
  const options = mergeOptions(callOptions);
  const appOutDir = requireAppOutDir(context, options);
  const platform = resolveContextPlatform(context, options);
  const profile = resolveSigningProfile(options.profile);
  const stateDirectory = resolveSigningStateDirectory({ appOutDir, ...options });
  const binding = Object.freeze({
    appOutDir,
    stateDirectory,
    platform,
    profile,
    arch: context?.arch ?? null,
  });
  bindPackagerSigningContext(context?.packager, binding);
  activeSigningOutputs.set(platform, binding);
  return withHookTrace(stateDirectory, "afterPack", async () => {
    const existingState = await readSigningState(stateDirectory, { optional: true });
    if (existingState) {
      throw new SigningContractError(
        "provider_double_sign",
        "afterPack was invoked twice for an already sealed provider",
      );
    }
    const layout = await resolveProviderLayout({
      appOutDir,
      platform,
      providerPath: options.providerPath,
      providerRevision: options.providerRevision,
    });
    if (!layout) {
      if (options.requireProvider === true) {
        throw new SigningContractError(
          "provider_not_staged",
          `No bundled Cua Driver was staged under ${appOutDir}`,
        );
      }
      await appendSigningTrace(stateDirectory, {
        hook: "afterPack",
        event: "provider-not-staged",
        platform,
        signingTier: profile.signingTier,
        distributionChannel: profile.distributionChannel,
      });
      return Object.freeze({ skipped: true, reason: "provider_not_staged", stateDirectory });
    }
    await assertProviderInputLayout(layout);
    const productFilename = resolveProductFilename(context, options);
    const packageAuthority = options.expectedHostAuthority
      ? await verifyPackageAuthorityAtRoot({
          appOutDir,
          expectedAuthority: options.expectedHostAuthority,
          layout,
          platform,
          productFilename,
          requireFuses: false,
        })
      : undefined;
    await assertPathDoesNotExist(layout.sealPath, "provider_seal_already_exists");
    if (layout.catalogPath) {
      await assertPathDoesNotExist(layout.catalogPath, "provider_catalog_already_exists");
    }

    const preSignPayloadSha256 = await sha256File(layout.executablePath);
    if (
      options.expectedPreSignPayloadSha256 !== undefined &&
      options.expectedPreSignPayloadSha256 !== preSignPayloadSha256
    ) {
      throw new SigningContractError(
        "pre_sign_payload_digest_mismatch",
        `Approved clean pre-sign digest ${String(options.expectedPreSignPayloadSha256)} does not match ${preSignPayloadSha256}`,
      );
    }
    if (profile.signingTier === "production_signed") {
      if (typeof options.expectedPreSignPayloadSha256 !== "string") {
        throw new SigningContractError(
          "production_pre_sign_digest_required",
          "production_signed must start from an externally approved clean pre-sign payload digest",
        );
      }
      if (readFixtureFileSignature(await readFile(layout.executablePath))) {
        throw new SigningContractError(
          "production_pre_sign_payload_not_clean",
          "production_signed cannot overwrite or promote fixture/test-signed bytes",
        );
      }
    }
    await appendSigningTrace(stateDirectory, {
      hook: "afterPack",
      event: "provider-pre-sign-digest",
      platform,
      signingTier: profile.signingTier,
      distributionChannel: profile.distributionChannel,
      providerSha256: preSignPayloadSha256,
    });

    let signerIdentity;
    if (profile.signingTier !== "unsigned_dev") {
      if (!options.signer || typeof options.signer.signFile !== "function") {
        throw new SigningContractError(
          "provider_signer_unconfigured",
          `${profile.signingTier} requires an injected platform signer`,
        );
      }
      signerIdentity = await options.signer.signFile({
        filePath: layout.executablePath,
        platform,
        role: "provider",
        profile,
      });
      assertSignerMatchesProfile(signerIdentity, profile, "provider");
      assertProviderSignerMatchesAuthority(packageAuthority?.runtimeTrustPolicy, signerIdentity, platform);
      await appendSigningTrace(stateDirectory, {
        hook: "afterPack",
        event: "provider-signed",
        platform,
        signingTier: profile.signingTier,
        distributionChannel: profile.distributionChannel,
        digestBefore: signerIdentity.beforeSha256,
        digestAfter: signerIdentity.afterSha256,
        signerSubject: signerIdentity.signerSubject,
        certificateSha256: signerIdentity.certificateSha256,
        signatureScheme: signerIdentity.scheme,
        authorityKind: signerIdentity.authorityKind,
        testOnly: signerIdentity.testOnly === true,
      });
    }

    const seal = await createProviderSeal({
      platform,
      profile,
      providerPath: layout.executablePath,
      providerRoot: layout.providerRoot,
      lockPath: layout.providerLockPath,
      signerIdentity,
    });
    const sealEvidence = await writeProviderSeal(layout.sealPath, seal);
    const sealedProviderSha256 = await sha256File(layout.executablePath);
    await appendSigningTrace(stateDirectory, {
      hook: "afterPack",
      event: "provider-sealed",
      platform,
      providerSha256: sealedProviderSha256,
      sealSha256: sealEvidence.sha256,
    });

    let catalogSha256 = null;
    if (platform === "win32" && profile.signingTier !== "unsigned_dev") {
      if (!options.signer || typeof options.signer.signCatalog !== "function") {
        throw new SigningContractError(
          "provider_catalog_signer_unconfigured",
          `${profile.signingTier} requires an injected catalog signer`,
        );
      }
      const members = [
        { relativePath: "payload/cua-driver.exe", sha256: sealedProviderSha256 },
        { relativePath: "payload/provider-seal.json", sha256: sealEvidence.sha256 },
      ];
      const catalogIdentity = await options.signer.signCatalog({
        filePath: layout.catalogPath,
        platform,
        role: "provider-catalog",
        profile,
        catalog: {
          schemaVersion: 2,
          catalogRelativePath: "provider-integrity.cat",
          signingTier: profile.signingTier,
          distributionChannel: profile.distributionChannel,
          productionEligible: profile.productionEligible,
          members,
        },
      });
      assertSignerMatchesProfile(catalogIdentity, profile, "provider-catalog");
      assertCatalogSignerMatchesAuthority(packageAuthority?.runtimeTrustPolicy, catalogIdentity);
      catalogSha256 = await sha256File(layout.catalogPath);
      await appendSigningTrace(stateDirectory, {
        hook: "afterPack",
        event: "provider-catalog-signed",
        platform,
        signingTier: profile.signingTier,
        distributionChannel: profile.distributionChannel,
        catalogSha256,
        catalogMemberSha256s: members.map((member) => member.sha256),
        signerSubject: catalogIdentity.signerSubject,
        certificateSha256: catalogIdentity.certificateSha256,
        signatureScheme: catalogIdentity.scheme,
        authorityKind: catalogIdentity.authorityKind,
        testOnly: catalogIdentity.testOnly === true,
      });
    }

    const state = {
      electronBuilderVersion: "26.15.3",
      platform,
      signingTier: profile.signingTier,
      distributionChannel: profile.distributionChannel,
      productionEligible: profile.productionEligible,
      testAuthorityKind: profile.testAuthorityKind,
      preSignPayloadSha256,
      sealedProviderSha256,
      sealSha256: sealEvidence.sha256,
      catalogSha256,
      providerRelativePath: layout.relativeExecutablePath,
      sealRelativePath: layout.relativeSealPath,
      catalogRelativePath: layout.relativeCatalogPath ?? null,
      lockRelativePath: relative(appOutDir, layout.providerLockPath).replaceAll("\\", "/"),
      appOutDirectoryName: basename(appOutDir),
      productFilename,
      packageAuthority: packageAuthority?.authority ?? null,
      capabilitiesRelativePath: packageAuthority
        ? relative(appOutDir, packageAuthority.capabilitiesPath).replaceAll("\\", "/")
        : null,
      runtimeTrustPolicyRelativePath: packageAuthority
        ? relative(appOutDir, packageAuthority.runtimeTrustPolicyPath).replaceAll("\\", "/")
        : null,
    };
    await writeSigningState(stateDirectory, state, { exclusive: true });
    await appendSigningTrace(stateDirectory, {
      hook: "afterPack",
      event: "complete",
      platform,
      stateFingerprint: signingStateFingerprint(state),
      providerSha256: sealedProviderSha256,
      sealSha256: sealEvidence.sha256,
      catalogSha256,
      capabilitiesSha256: state.packageAuthority?.capabilitiesSha256,
      runtimeTrustPolicySha256: state.packageAuthority?.runtimeTrustPolicySha256,
    });
    return Object.freeze({
      skipped: false,
      stateDirectory,
      profile,
      layout,
      state: Object.freeze(state),
    });
  });
}

export async function runAfterSign(context, callOptions = {}) {
  const options = mergeOptions(callOptions);
  const appOutDir = requireAppOutDir(context, options);
  const platform = resolveContextPlatform(context, options);
  const bound = resolvePackagerSigningContext({ context, options, platform });
  const profile = resolveSigningProfile(options.profile ?? bound?.profile);
  const stateDirectory = resolveSigningStateDirectory({
    appOutDir,
    ...options,
    stateDirectory: options.stateDirectory ?? bound?.stateDirectory,
  });
  const binding = Object.freeze({
    appOutDir,
    stateDirectory,
    platform,
    profile,
    arch: context?.arch ?? bound?.arch ?? null,
  });
  bindPackagerSigningContext(context?.packager, binding);
  activeSigningOutputs.set(platform, binding);
  return withHookTrace(stateDirectory, "afterSign", async () => {
    const state = await readSigningState(stateDirectory, { optional: true });
    if (!state) {
      await appendSigningTrace(stateDirectory, {
        hook: "afterSign",
        event: "provider-not-staged",
        platform,
      });
      return Object.freeze({ skipped: true, reason: "provider_not_staged", stateDirectory });
    }
    assertStateProfile(state, platform, profile);
    const verification = await verifyStateAtRoot({ state, appOutDir, profile, platform });
    await appendSigningTrace(stateDirectory, {
      hook: "afterSign",
      event: "verified",
      platform,
      providerSha256: verification.providerSha256,
      sealSha256: verification.sealSha256,
      catalogSha256: verification.catalogSha256,
      capabilitiesSha256: state.packageAuthority?.capabilitiesSha256,
      runtimeTrustPolicySha256: state.packageAuthority?.runtimeTrustPolicySha256,
    });
    return Object.freeze({ skipped: false, stateDirectory, verification });
  });
}

export async function runArtifactBuildCompleted(context, callOptions = {}) {
  const options = mergeOptions(callOptions);
  const platform = resolveContextPlatform(context, options);
  if (isCompanionBlockmap(context)) {
    return Object.freeze({ skipped: true, reason: "companion_blockmap" });
  }
  const artifact = classifyFinalArtifact(context, platform);
  const bound = resolvePackagerSigningContext({
    context,
    options,
    platform,
    filePath: artifact.path,
  });
  const active = activeSigningOutputs.get(platform);
  const appOutDir = requireAppOutDir(context, {
    ...options,
    appOutDir: options.appOutDir ?? context?.appOutDir ?? bound?.appOutDir ?? active?.appOutDir,
  });
  const profile = resolveSigningProfile(options.profile ?? bound?.profile);
  const stateDirectory = resolveSigningStateDirectory({
    appOutDir,
    ...options,
    stateDirectory: options.stateDirectory ?? bound?.stateDirectory ?? active?.stateDirectory,
  });
  return withHookTrace(stateDirectory, "artifactBuildCompleted", async () => {
    const state = await readSigningState(stateDirectory, { optional: true });
    if (!state) {
      await appendSigningTrace(stateDirectory, {
        hook: "artifactBuildCompleted",
        event: "provider-not-staged",
        platform,
      });
      return Object.freeze({ skipped: true, reason: "provider_not_staged", stateDirectory });
    }
    assertStateProfile(state, platform, profile);
    let artifactRoot = options.artifactRoot;
    let cleanup;
    if (!artifactRoot && typeof artifact.path === "string") {
      try {
        if ((await lstat(artifact.path)).isDirectory()) {
          // Electron Builder's `dir` target is already an unpacked final
          // artifact; re-open that exact directory rather than silently
          // substituting the staging appOutDir.
          artifactRoot = artifact.path;
        }
      } catch (error) {
        if (error?.code !== "ENOENT") {
          throw error;
        }
      }
    }
    if (!artifactRoot && typeof options.extractArtifact === "function") {
      const extracted = await options.extractArtifact(artifact.path, {
        artifactRole: artifact.role,
        platform,
        profile,
        state,
      });
      if (
        !extracted
        || typeof extracted !== "object"
        || typeof extracted.artifactRoot !== "string"
        || typeof extracted.cleanup !== "function"
      ) {
        throw new SigningContractError(
          "final_artifact_extractor_contract_invalid",
          "Final artifact extractor must return { artifactRoot, cleanup }",
        );
      }
      artifactRoot = extracted.artifactRoot;
      cleanup = extracted.cleanup;
    }
    if (!artifactRoot) {
      throw new SigningContractError(
        "final_artifact_extractor_unconfigured",
        `Final ${String(artifact.path ?? "artifact")} must be reopened before release evidence is accepted`,
      );
    }
    if (!isAbsolute(artifactRoot)) {
      throw new SigningContractError(
        "final_artifact_root_invalid",
        "Final artifact extractor root must be absolute",
      );
    }
    let verification;
    let verificationError;
    try {
      const metadata = await lstat(artifactRoot);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
        throw new SigningContractError(
          "final_artifact_root_invalid",
          `Final artifact root is not a real directory: ${artifactRoot}`,
        );
      }
      verification = await verifyStateAtRoot({
        state,
        appOutDir: resolve(artifactRoot),
        profile,
        platform,
      });
    } catch (error) {
      verificationError = error;
    }
    let cleanupError;
    if (cleanup) {
      try {
        await cleanup();
      } catch (error) {
        cleanupError = error;
      }
    }
    if (verificationError && cleanupError) {
      throw new AggregateError(
        [verificationError, cleanupError],
        "final_artifact_verification_and_cleanup_failed",
      );
    }
    if (verificationError) throw verificationError;
    if (cleanupError) {
      throw new SigningContractError(
        "final_artifact_cleanup_failed",
        cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
        { cause: cleanupError },
      );
    }
    await appendSigningTrace(stateDirectory, {
      hook: "artifactBuildCompleted",
      event: "verified",
      platform,
      artifactName: basename(String(artifact.path ?? artifactRoot)),
      artifactRole: artifact.role,
      artifactSha256:
        typeof artifact.path === "string" && artifact.role !== "outer-dir"
          ? await sha256File(artifact.path)
          : undefined,
      providerSha256: verification.providerSha256,
      sealSha256: verification.sealSha256,
      catalogSha256: verification.catalogSha256,
      capabilitiesSha256: state.packageAuthority?.capabilitiesSha256,
      runtimeTrustPolicySha256: state.packageAuthority?.runtimeTrustPolicySha256,
    });
    return Object.freeze({ skipped: false, stateDirectory, verification });
  });
}

function isCompanionBlockmap(context) {
  const path = context?.artifactPath ?? context?.file ?? context?.safeArtifactName;
  const targetName = String(context?.target?.name ?? "").toLowerCase();
  return typeof path === "string"
    && path.toLowerCase().endsWith(".blockmap")
    && context?.arch == null
    && context?.updateInfo != null
    && ["dmg", "zip", "nsis"].includes(targetName);
}

function classifyFinalArtifact(context, platform) {
  const path = context?.artifactPath ?? context?.file;
  if (typeof path !== "string" || path.length === 0) {
    throw new SigningContractError(
      "final_artifact_path_missing",
      "Electron Builder final artifact path is required",
    );
  }
  const lower = path.toLowerCase();
  const targetName = String(context?.target?.name ?? "").toLowerCase();
  const inferredRole = platform === "darwin"
    ? lower.endsWith(".dmg")
      ? "outer-dmg"
      : lower.endsWith(".zip")
        ? "outer-zip"
        : "outer-dir"
    : lower.endsWith(".exe")
      ? "outer-nsis"
      : "outer-dir";
  const expectedTarget = inferredRole === "outer-dmg"
    ? "dmg"
    : inferredRole === "outer-zip"
      ? "zip"
      : inferredRole === "outer-nsis"
        ? "nsis"
        : "dir";
  if (targetName && targetName !== expectedTarget) {
    throw new SigningContractError(
      "final_artifact_target_mismatch",
      `Target ${targetName} does not match ${basename(path)}`,
    );
  }
  if (
    (platform === "darwin" && !["outer-dmg", "outer-zip", "outer-dir"].includes(inferredRole))
    || (platform === "win32" && !["outer-nsis", "outer-dir"].includes(inferredRole))
  ) {
    throw new SigningContractError(
      "final_artifact_kind_unsupported",
      `Unsupported final artifact: ${path}`,
    );
  }
  return Object.freeze({ path, role: inferredRole });
}

/**
 * Provider-aware platform signer seam.  Electron Builder may ask its generic
 * signer to process many paths.  The exact provider/seal/catalog tuple is
 * skipped only after `afterPack` persisted the expected final digest; every
 * other eligible path is delegated to the outer signer.
 */
export async function runProviderAwareSign(context, callOptions = {}) {
  const options = mergeOptions(callOptions);
  const filePath = resolve(String(context.path ?? context.file ?? options.filePath ?? ""));
  if (!context.path && !context.file && !options.filePath) {
    throw new SigningContractError("signing_target_missing", "Platform signing target path is required");
  }
  const platform = resolveContextPlatform(context, options);
  const bound = resolvePackagerSigningContext({ context, options, platform, filePath });
  const active = activeSigningOutputs.get(platform);
  const appOutDir = requireAppOutDir(context, {
    ...options,
    appOutDir:
      options.appOutDir
      ?? context?.appOutDir
      ?? bound?.appOutDir
      ?? active?.appOutDir
      ?? dirname(filePath),
  });
  const profile = resolveSigningProfile(options.profile ?? bound?.profile);
  const stateDirectory = resolveSigningStateDirectory({
    appOutDir,
    ...options,
    stateDirectory: options.stateDirectory ?? bound?.stateDirectory ?? active?.stateDirectory,
  });
  const state = await readSigningState(stateDirectory, { optional: true });
  if (!state) {
    if (looksLikeCanonicalProviderPath(filePath, platform)) {
      throw new SigningContractError(
        "provider_signer_before_seal",
        "Generic signing cannot touch the provider before afterPack seals it",
      );
    }
    return delegateOuterSigner({ filePath, platform, profile, stateDirectory, options });
  }
  assertStateProfile(state, platform, profile);
  const governed = new Map([
    [resolve(appOutDir, state.providerRelativePath), state.sealedProviderSha256],
    [resolve(appOutDir, state.sealRelativePath), state.sealSha256],
    ...(state.catalogRelativePath
      ? [[resolve(appOutDir, state.catalogRelativePath), state.catalogSha256]]
      : []),
  ]);
  if (governed.has(filePath)) {
    await assertGovernedRegularFile(appOutDir, filePath, "sealed-provider-path");
    const expectedSha256 = governed.get(filePath);
    const actualSha256 = await sha256File(filePath);
    if (actualSha256 !== expectedSha256) {
      throw new SigningContractError(
        "provider_post_seal_mutation",
        `Generic signer observed changed sealed bytes: ${filePath}`,
      );
    }
    await appendSigningTrace(stateDirectory, {
      hook: "platformSign",
      event: "sealed-provider-path-skipped",
      platform,
      role: filePath.endsWith("provider-seal.json")
        ? "provider-seal"
        : filePath.endsWith("provider-integrity.cat")
          ? "provider-catalog"
          : "provider",
      sha256: actualSha256,
    });
    return Object.freeze({ skipped: true, reason: "sealed_provider_path", sha256: actualSha256 });
  }
  const providerPlatformRoot = dirname(resolve(appOutDir, state.providerRelativePath));
  if (isWithin(filePath, providerPlatformRoot) && looksExecutable(filePath)) {
    throw new SigningContractError(
      "unexpected_provider_executable",
      `Unexpected executable in private provider payload: ${filePath}`,
    );
  }
  return delegateOuterSigner({ filePath, platform, profile, stateDirectory, options });
}

async function verifyStateAtRoot({ state, appOutDir, profile, platform }) {
  const providerPath = resolve(appOutDir, state.providerRelativePath);
  const sealPath = resolve(appOutDir, state.sealRelativePath);
  const catalogPath = state.catalogRelativePath
    ? resolve(appOutDir, state.catalogRelativePath)
    : undefined;
  const lockPath = resolve(appOutDir, state.lockRelativePath);
  const layout = await resolveProviderLayout({ appOutDir, platform, providerPath });
  if (!layout) {
    throw new SigningContractError("provider_not_staged", `Provider missing from ${appOutDir}`);
  }
  assertGovernedPathMatches(layout.executablePath, providerPath, "provider");
  assertGovernedPathMatches(layout.sealPath, sealPath, "provider-seal");
  assertGovernedPathMatches(layout.providerLockPath, lockPath, "provider-lock");
  if (catalogPath || layout.catalogPath) {
    assertGovernedPathMatches(layout.catalogPath, catalogPath, "provider-catalog");
  }
  await Promise.all([
    assertGovernedRegularFile(appOutDir, providerPath, "provider"),
    assertGovernedRegularFile(appOutDir, sealPath, "provider-seal"),
    assertGovernedRegularFile(appOutDir, lockPath, "provider-lock"),
    ...(catalogPath && profile.signingTier !== "unsigned_dev"
      ? [assertGovernedRegularFile(appOutDir, catalogPath, "provider-catalog")]
      : []),
  ]);
  if (state.packageAuthority) {
    await verifyPackageAuthorityAtRoot({
      appOutDir,
      expectedAuthority: state.packageAuthority,
      platform,
      productFilename: state.productFilename,
      requireFuses: true,
      capabilitiesPath: resolve(appOutDir, state.capabilitiesRelativePath),
      runtimeTrustPolicyPath: resolve(appOutDir, state.runtimeTrustPolicyRelativePath),
    });
  }
  const verification = await verifyProviderTuple({
    platform,
    profile,
    providerPath,
    sealPath,
    catalogPath,
    lockPath,
    providerRoot: layout.providerRoot,
  });
  if (
    verification.providerSha256 !== state.sealedProviderSha256 ||
    verification.sealSha256 !== state.sealSha256 ||
    verification.catalogSha256 !== state.catalogSha256
  ) {
    throw new SigningContractError(
      "provider_digest_transition_mismatch",
      "Provider tuple does not match the afterPack final digests",
    );
  }
  return verification;
}

async function verifyPackageAuthorityAtRoot({
  appOutDir,
  expectedAuthority: expectedAuthorityValue,
  layout,
  platform,
  productFilename,
  requireFuses,
  capabilitiesPath: capabilitiesPathValue,
  runtimeTrustPolicyPath: runtimeTrustPolicyPathValue,
}) {
  const authority = validateCuaDriverPackageAuthority(expectedAuthorityValue);
  if (!authority.providerExpected || authority.platform !== platform) {
    throw new SigningContractError(
      "package_host_authority_platform_mismatch",
      `Package authority does not authorize ${platform}`,
    );
  }
  const authorityRoot = layout ? dirname(dirname(layout.providerRoot)) : undefined;
  const capabilitiesPath = capabilitiesPathValue
    ?? (authorityRoot ? join(authorityRoot, "packaged-provider-capabilities.json") : undefined);
  const runtimeTrustPolicyPath = runtimeTrustPolicyPathValue
    ?? (authorityRoot ? join(authorityRoot, "runtime-trust-policy.json") : undefined);
  if (!capabilitiesPath || !runtimeTrustPolicyPath) {
    throw new SigningContractError(
      "package_authority_document_path_missing",
      "Package authority document paths are required",
    );
  }
  await Promise.all([
    assertGovernedRegularFile(appOutDir, capabilitiesPath, "package-capabilities"),
    assertGovernedRegularFile(appOutDir, runtimeTrustPolicyPath, "runtime-trust-policy"),
  ]);
  const [capabilitiesBytes, runtimeTrustPolicyBytes, host] = await Promise.all([
    readFile(capabilitiesPath),
    readFile(runtimeTrustPolicyPath),
    verifyCuaDriverPackagedHostAuthority({
      appOutDir,
      expectedAuthority: authority,
      platform,
      productFilename,
      requireFuses,
    }),
  ]);
  const capabilitiesSha256 = sha256Bytes(capabilitiesBytes);
  const runtimeTrustPolicySha256 = sha256Bytes(runtimeTrustPolicyBytes);
  if (
    capabilitiesSha256 !== authority.capabilitiesSha256
    || runtimeTrustPolicySha256 !== authority.runtimeTrustPolicySha256
  ) {
    throw new SigningContractError(
      "package_authority_document_digest_mismatch",
      "External package authority documents differ from the signed-host digests",
    );
  }
  let runtimeTrustPolicy;
  try {
    runtimeTrustPolicy = JSON.parse(runtimeTrustPolicyBytes.toString("utf8"));
  } catch (error) {
    throw new SigningContractError(
      "package_runtime_trust_policy_invalid",
      `Unable to parse ${runtimeTrustPolicyPath}`,
      { cause: error },
    );
  }
  if (
    platform === "win32"
    && (
      runtimeTrustPolicy?.signingPolicy?.signingTier !== authority.signingTier
      || runtimeTrustPolicy?.signingPolicy?.distributionChannel !== authority.distributionChannel
    )
  ) {
    throw new SigningContractError(
      "package_runtime_trust_policy_signing_pair_mismatch",
      "Runtime policy signing pair differs from the signed-host authority",
    );
  }
  return Object.freeze({
    authority: host.authority,
    capabilitiesPath,
    runtimeTrustPolicy,
    runtimeTrustPolicyPath,
  });
}

function assertProviderSignerMatchesAuthority(policy, identity, platform) {
  if (!policy) return;
  if (platform === "darwin") {
    if (identity?.teamId !== policy.expectedTeamId) {
      throw new SigningContractError(
        "provider_signer_authority_mismatch",
        "Darwin provider signer Team ID differs from runtime policy",
      );
    }
    return;
  }
  const expected = policy?.signingPolicy?.providerSigner;
  if (
    expected
    && (
      identity?.signerSubject !== expected.subject
      || identity?.certificateSha256 !== expected.certificateSha256
    )
  ) {
    throw new SigningContractError(
      "provider_signer_authority_mismatch",
      "Windows provider signer differs from runtime policy",
    );
  }
}

function assertCatalogSignerMatchesAuthority(policy, identity) {
  if (!policy) return;
  const expected = policy?.signingPolicy?.catalogSigner;
  if (
    expected
    && (
      identity?.signerSubject !== expected.subject
      || identity?.certificateSha256 !== expected.certificateSha256
    )
  ) {
    throw new SigningContractError(
      "catalog_signer_authority_mismatch",
      "Windows catalog signer differs from runtime policy",
    );
  }
}

async function assertProviderInputLayout(layout) {
  await Promise.all([
    assertGovernedRegularFile(layout.appOutDir, layout.executablePath, "provider"),
    assertGovernedRegularFile(layout.appOutDir, layout.providerLockPath, "provider-lock"),
  ]);
  const files = await listProviderPayloadFiles(layout);
  const expected = new Set([resolve(layout.executablePath)]);
  for (const filePath of files) {
    if (!expected.has(resolve(filePath)) && looksExecutable(filePath)) {
      throw new SigningContractError(
        "unexpected_provider_executable",
        `Private provider payload contains an ungoverned executable: ${filePath}`,
      );
    }
  }
  try {
    const stats = await lstat(layout.providerLockPath);
    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw new SigningContractError(
        "provider_lock_invalid",
        `Provider lock is not a regular file: ${layout.providerLockPath}`,
      );
    }
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new SigningContractError(
        "provider_lock_missing",
        `Provider lock is missing: ${layout.providerLockPath}`,
      );
    }
    throw error;
  }
}

async function delegateOuterSigner({ filePath, platform, profile, stateDirectory, options }) {
  const role = String(options.outerRole ?? inferOuterRole(filePath, platform));
  const sign = role === "outer-app-bundle"
    ? options.outerSigner?.signBundle
    : options.outerSigner?.signFile;
  if (typeof sign !== "function") {
    if (profile.signingTier !== "unsigned_dev") {
      await appendSigningTrace(stateDirectory, {
        hook: "platformSign",
        event: "outer-signing-failed",
        platform,
        targetName: basename(filePath),
        role: inferOuterRole(filePath, platform),
        errorCode: "outer_signer_unconfigured",
      });
      throw new SigningContractError(
        "outer_signer_unconfigured",
        `${profile.signingTier} cannot leave ${basename(filePath)} unsigned`,
      );
    }
    await appendSigningTrace(stateDirectory, {
      hook: "platformSign",
      event: "outer-signing-delegated",
      platform,
      targetName: basename(filePath),
    });
    return Object.freeze({ skipped: false, delegated: true, signed: false });
  }
  const identity = await sign.call(options.outerSigner, {
    filePath,
    platform,
    role,
    profile,
  });
  assertSignerMatchesProfile(identity, profile, "outer-app");
  await appendSigningTrace(stateDirectory, {
    hook: "platformSign",
    event: "outer-path-signed",
    platform,
    targetName: basename(filePath),
    role: identity.role,
    signingTier: identity.signingTier,
    distributionChannel: identity.distributionChannel,
    authorityKind: identity.authorityKind,
    signerSubject: identity.signerSubject,
    certificateSha256: identity.certificateSha256,
    digestBefore: identity.beforeSha256,
    digestAfter: identity.afterSha256,
    testOnly: identity.testOnly === true,
  });
  return Object.freeze({ skipped: false, delegated: true, signed: true, identity });
}

function assertSignerMatchesProfile(identity, profile, role) {
  if (
    !identity ||
    identity.signingTier !== profile.signingTier ||
    identity.distributionChannel !== profile.distributionChannel
  ) {
    throw new SigningContractError(
      "mixed_signing_tier",
      `${role} signer identity does not match ${profile.signingTier} + ${profile.distributionChannel}`,
    );
  }
  if (
    profile.signingTier === "test_signed_internal"
    && identity.authorityKind !== profile.testAuthorityKind
  ) {
    throw new SigningContractError(
      "mixed_signing_authority",
      `${role} signer authority ${String(identity.authorityKind)} does not match ${String(profile.testAuthorityKind)}`,
    );
  }
  if (profile.signingTier === "production_signed" && identity.testOnly === true) {
    throw new SigningContractError(
      "fixture_signer_production_forbidden",
      `${role} attempted to use fixture identity in production`,
    );
  }
}

function assertGovernedPathMatches(expectedPath, actualPath, role) {
  if (
    typeof expectedPath !== "string"
    || typeof actualPath !== "string"
    || canonicalPathKey(expectedPath) !== canonicalPathKey(actualPath)
  ) {
    throw new SigningContractError(
      "provider_governed_path_mismatch",
      `${role} state path does not match the canonical provider layout`,
    );
  }
}

async function assertGovernedRegularFile(rootValue, pathValue, role) {
  const root = resolve(rootValue);
  const path = resolve(pathValue);
  if (!isWithin(path, root)) {
    throw new SigningContractError(
      "provider_governed_path_escape",
      `${role} escapes the packaged application root: ${path}`,
    );
  }
  const chain = [];
  let cursor = path;
  while (isWithin(cursor, root)) {
    chain.push(cursor);
    if (cursor === root) break;
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  chain.reverse();
  for (const entryPath of chain) {
    let metadata;
    try {
      metadata = await lstat(entryPath, { bigint: true });
    } catch (error) {
      if (error?.code === "ENOENT") {
        throw new SigningContractError(
          "provider_governed_file_missing",
          `${role} is missing: ${entryPath}`,
          { cause: error },
        );
      }
      throw error;
    }
    const isTarget = entryPath === path;
    if (
      metadata.isSymbolicLink()
      || (isTarget && (!metadata.isFile() || metadata.nlink !== 1n))
      || (!isTarget && !metadata.isDirectory())
    ) {
      throw new SigningContractError(
        "provider_governed_file_unsafe",
        `${role} contains a symlink, reparse point, hard link, or non-regular path: ${entryPath}`,
      );
    }
  }
  const [rootRealPath, fileRealPath] = await Promise.all([realpath(root), realpath(path)]);
  const expectedRealPath = resolve(rootRealPath, relative(root, path));
  if (
    canonicalPathKey(fileRealPath) !== canonicalPathKey(expectedRealPath)
    || !isWithin(fileRealPath, rootRealPath)
  ) {
    throw new SigningContractError(
      "provider_governed_file_unsafe",
      `${role} resolves outside the packaged application root: ${path}`,
    );
  }
}

function canonicalPathKey(value) {
  const normalized = resolve(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function assertStateProfile(state, platform, profile) {
  if (
    state.platform !== platform ||
    state.signingTier !== profile.signingTier ||
    state.distributionChannel !== profile.distributionChannel ||
    state.productionEligible !== profile.productionEligible
  ) {
    throw new SigningContractError(
      "mixed_signing_tier",
      "Current hook profile does not match the sealed provider state",
    );
  }
  if (
    profile.signingTier === "test_signed_internal" &&
    state.testAuthorityKind !== profile.testAuthorityKind
  ) {
    throw new SigningContractError(
      "mixed_signing_authority",
      "Current test authority kind does not match the sealed provider state",
    );
  }
}

async function withHookTrace(stateDirectory, hook, operation) {
  await mkdir(stateDirectory, { recursive: true });
  await appendSigningTrace(stateDirectory, { hook, event: "started" });
  try {
    return await operation();
  } catch (error) {
    await appendSigningTrace(stateDirectory, {
      hook,
      event: "failed",
      errorCode: error?.code ?? "unexpected_error",
    });
    throw error;
  }
}

function resolveContextPlatform(context, options) {
  return normalizeSigningPlatform(
    options.platform ??
      context?.electronPlatformName ??
      context?.platform ??
      context?.packager?.platform?.nodeName ??
      context?.packager?.platform?.name ??
      process.platform,
  );
}

function requireAppOutDir(context, options) {
  const appOutDir = options.appOutDir ?? context?.appOutDir;
  if (typeof appOutDir !== "string" || appOutDir.trim() === "") {
    throw new SigningContractError("signing_app_output_missing", "Electron Builder appOutDir is required");
  }
  return resolve(appOutDir);
}

function resolveProductFilename(context, options) {
  const value = options.productFilename
    ?? context?.packager?.appInfo?.productFilename
    ?? "Ling Stack";
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > 255
    || /[\\/\0]/u.test(value)
  ) {
    throw new SigningContractError(
      "package_product_filename_invalid",
      "Electron Builder product filename is invalid",
    );
  }
  return value;
}

function bindPackagerSigningContext(packager, binding) {
  if (!packager || !["object", "function"].includes(typeof packager)) {
    return;
  }
  let contexts = packager[PACKAGER_SIGNING_CONTEXTS_PROPERTY];
  if (!(contexts instanceof Map)) {
    contexts = new Map();
    Object.defineProperty(packager, PACKAGER_SIGNING_CONTEXTS_PROPERTY, {
      configurable: true,
      value: contexts,
    });
  }
  contexts.set(binding.appOutDir, binding);

  // Electron Builder invokes the platform signer immediately after afterPack
  // in the normal single-job path.  Keep these scalar fields for that public
  // callback seam and for existing fixtures; concurrent/multi-arch builds are
  // resolved from the per-output map above.
  packager.__lingSigningAppOutDir = binding.appOutDir;
  packager.__lingSigningStateDirectory = binding.stateDirectory;
  packager.__lingSigningProfile = binding.profile;
}

function resolvePackagerSigningContext({ context, options, platform, filePath }) {
  const packager = options.packager ?? context?.packager;
  if (!packager || !["object", "function"].includes(typeof packager)) {
    return undefined;
  }
  const contexts = packager[PACKAGER_SIGNING_CONTEXTS_PROPERTY];
  if (contexts instanceof Map) {
    const candidates = [...contexts.values()].filter(
      (candidate) => candidate?.platform === platform,
    );
    const explicitAppOutDir = options.appOutDir ?? context?.appOutDir;
    if (typeof explicitAppOutDir === "string" && explicitAppOutDir.trim()) {
      const exact = contexts.get(resolve(explicitAppOutDir));
      if (exact?.platform === platform) {
        return exact;
      }
    }
    if (typeof filePath === "string" && filePath.trim()) {
      const resolvedFilePath = resolve(filePath);
      const pathMatches = candidates
        .filter((candidate) => isWithin(resolvedFilePath, candidate.appOutDir))
        .sort((left, right) => right.appOutDir.length - left.appOutDir.length);
      if (pathMatches.length > 0) {
        return pathMatches[0];
      }
    }
    if (context?.arch !== undefined && context?.arch !== null) {
      const archMatches = candidates.filter(
        (candidate) => String(candidate.arch) === String(context.arch),
      );
      if (archMatches.length === 1) {
        return archMatches[0];
      }
    }
    if (candidates.length === 1) {
      return candidates[0];
    }
    if (candidates.length > 1) {
      throw new SigningContractError(
        "signing_context_ambiguous",
        `Unable to select one ${platform} signing output from ${String(candidates.length)} active outputs`,
      );
    }
  }

  if (
    typeof packager.__lingSigningAppOutDir === "string"
    && typeof packager.__lingSigningStateDirectory === "string"
  ) {
    return Object.freeze({
      appOutDir: resolve(packager.__lingSigningAppOutDir),
      stateDirectory: resolve(packager.__lingSigningStateDirectory),
      platform,
      profile: packager.__lingSigningProfile,
      arch: null,
    });
  }
  return undefined;
}

function mergeOptions(callOptions) {
  const options = { ...processRuntimeOptions, ...callOptions };
  if (process.env.LING_CUA_SIGNING_FIXTURE === "1") {
    environmentFixtureSigner ??= createDisposableFixtureSigner({
      signerSubject: process.env.LING_CUA_FIXTURE_SIGNER_SUBJECT,
      teamId: process.env.LING_CUA_DARWIN_EXPECTED_TEAM_ID,
    });
    options.signer ??= environmentFixtureSigner;
    options.outerSigner ??= environmentFixtureSigner;
    options.requireProvider ??= true;
  }
  return options;
}

function looksExecutable(filePath) {
  const normalized = filePath.toLowerCase();
  return (
    basename(normalized) === "cua-driver" ||
    PROVIDER_EXECUTABLE_SUFFIXES.some((suffix) => normalized.endsWith(suffix))
  );
}

function inferOuterRole(filePath, platform) {
  const name = basename(filePath).toLowerCase();
  if (name.endsWith(".dmg")) {
    return "outer-dmg";
  }
  if (name.endsWith(".zip")) {
    return "outer-zip";
  }
  if (/unins|uninstall/u.test(name)) {
    return "outer-uninstaller";
  }
  if (/setup|installer/u.test(name)) {
    return platform === "win32" ? "outer-nsis" : "outer-installer";
  }
  return "outer-app";
}

function looksLikeCanonicalProviderPath(filePath, platform) {
  const normalized = filePath.replaceAll("\\", "/").toLowerCase();
  return platform === "win32"
    ? /\/providers\/cua-driver\/[^/]+\/win32-x64\/payload\/cua-driver\.exe$/u.test(normalized)
    : /\/providers\/cua-driver\/[^/]+\/darwin\/cua-driver$/u.test(normalized);
}

function isWithin(candidate, root) {
  const relativePath = relative(resolve(root), resolve(candidate));
  return (
    relativePath === "" ||
    (!isAbsolute(relativePath) && relativePath !== ".." && !relativePath.startsWith(`..${sep}`))
  );
}

async function assertPathDoesNotExist(path, code) {
  try {
    await lstat(path);
    throw new SigningContractError(code, `Refusing to replace existing signing material: ${path}`);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
}

export async function readSigningFixtureTrace(stateDirectory) {
  return JSON.parse(await readFile(join(stateDirectory, "provider-signing-trace.json"), "utf8"));
}

export async function writeCleanPreSignDigestEvidence(path, state) {
  await writeFile(
    path,
    `${canonicalJson({
      schemaVersion: 1,
      kind: "ling-cua-driver-clean-pre-sign-digest",
      preSignPayloadSha256: state.preSignPayloadSha256,
      signingTier: state.signingTier,
      distributionChannel: state.distributionChannel,
      productionEligible: state.productionEligible,
    })}\n`,
    { flag: "wx" },
  );
}

export { verifyFixtureCatalog };
