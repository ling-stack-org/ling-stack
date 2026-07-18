import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

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
  activeSigningOutputs.set(platform, Object.freeze({ appOutDir, stateDirectory }));
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
  const profile = resolveSigningProfile(options.profile);
  const stateDirectory = resolveSigningStateDirectory({ appOutDir, ...options });
  activeSigningOutputs.set(platform, Object.freeze({ appOutDir, stateDirectory }));
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
    });
    return Object.freeze({ skipped: false, stateDirectory, verification });
  });
}

export async function runArtifactBuildCompleted(context, callOptions = {}) {
  const options = mergeOptions(callOptions);
  const platform = resolveContextPlatform(context, options);
  const active = activeSigningOutputs.get(platform);
  const appOutDir = requireAppOutDir(context, {
    ...options,
    appOutDir: options.appOutDir ?? context?.appOutDir ?? active?.appOutDir,
  });
  const profile = resolveSigningProfile(options.profile);
  const stateDirectory = resolveSigningStateDirectory({
    appOutDir,
    ...options,
    stateDirectory: options.stateDirectory ?? active?.stateDirectory,
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
    const artifactPath = context.artifactPath ?? context.file;
    if (!artifactRoot && typeof artifactPath === "string") {
      try {
        if ((await lstat(artifactPath)).isDirectory()) {
          // Electron Builder's `dir` target is already an unpacked final
          // artifact; re-open that exact directory rather than silently
          // substituting the staging appOutDir.
          artifactRoot = artifactPath;
        }
      } catch (error) {
        if (error?.code !== "ENOENT") {
          throw error;
        }
      }
    }
    if (!artifactRoot && typeof options.extractArtifact === "function") {
      artifactRoot = await options.extractArtifact(artifactPath, {
        platform,
        profile,
        state,
      });
    }
    if (!artifactRoot) {
      throw new SigningContractError(
        "final_artifact_extractor_unconfigured",
        `Final ${String(context.artifactPath ?? context.file ?? "artifact")} must be reopened before release evidence is accepted`,
      );
    }
    const verification = await verifyStateAtRoot({
      state,
      appOutDir: resolve(artifactRoot),
      profile,
      platform,
    });
    await appendSigningTrace(stateDirectory, {
      hook: "artifactBuildCompleted",
      event: "verified",
      platform,
      artifactName: basename(String(context.artifactPath ?? context.file ?? artifactRoot)),
      artifactRole: inferOuterRole(String(context.artifactPath ?? context.file ?? artifactRoot), platform),
      artifactSha256:
        typeof (context.artifactPath ?? context.file) === "string"
          ? await sha256File(context.artifactPath ?? context.file)
          : undefined,
      providerSha256: verification.providerSha256,
      sealSha256: verification.sealSha256,
      catalogSha256: verification.catalogSha256,
    });
    return Object.freeze({ skipped: false, stateDirectory, verification });
  });
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
  const active = activeSigningOutputs.get(platform);
  const appOutDir = requireAppOutDir(context, {
    ...options,
    appOutDir: options.appOutDir ?? context?.appOutDir ?? active?.appOutDir ?? dirname(filePath),
  });
  const profile = resolveSigningProfile(options.profile);
  const stateDirectory = resolveSigningStateDirectory({
    appOutDir,
    ...options,
    stateDirectory: options.stateDirectory ?? active?.stateDirectory,
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

async function assertProviderInputLayout(layout) {
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
  if (!options.outerSigner || typeof options.outerSigner.signFile !== "function") {
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
  const identity = await options.outerSigner.signFile({
    filePath,
    platform,
    role: String(options.outerRole ?? inferOuterRole(filePath, platform)),
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
  if (profile.signingTier === "production_signed" && identity.testOnly === true) {
    throw new SigningContractError(
      "fixture_signer_production_forbidden",
      `${role} attempted to use fixture identity in production`,
    );
  }
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

function mergeOptions(callOptions) {
  const options = { ...processRuntimeOptions, ...callOptions };
  if (process.env.LING_CUA_SIGNING_FIXTURE === "1") {
    environmentFixtureSigner ??= createDisposableFixtureSigner({
      signerSubject: process.env.LING_CUA_FIXTURE_SIGNER_SUBJECT,
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
