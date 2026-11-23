import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, isAbsolute, resolve } from "node:path";

import {
  CUA_DRIVER_PACKAGE_AUTHORITY_METADATA_KEY,
  createExternalOnlyCuaDriverPackageAuthority,
  validateCuaDriverPackageAuthority,
} from "../shared/cua-driver-package-authority-contract.mjs";
import { resolveSigningProfile } from "./cua-driver-signing/signing-contract.mjs";
import { preparePackagedGstackBuild, packagedGstackBuilderConfig } from "./packaged-gstack-resources.mjs";
import { lockedUseReleaseBuilderConfig } from "./locked-use-release-build.ts";
import { lockedUseValidationBuilderConfig } from "./locked-use-validation-build.ts";
import { lockedUseLocalBuilderConfig } from "./locked-use-local-build.ts";

const packageJson = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);
const localElectronDist = process.env.LING_E6_QA_ELECTRON_DIST;
if (localElectronDist) {
  const require = createRequire(import.meta.url);
  const electronRoot = dirname(require.resolve("electron/package.json"));
  const electronVersion = JSON.parse(readFileSync(resolve(electronRoot, "package.json"), "utf8")).version;
  const expectedName = `electron-v${electronVersion}-darwin-arm64.zip`;
  const expectedSha256 = JSON.parse(readFileSync(resolve(electronRoot, "checksums.json"), "utf8"))[expectedName];
  if (!isAbsolute(localElectronDist) || basename(localElectronDist) !== expectedName || !expectedSha256
    || createHash("sha256").update(readFileSync(localElectronDist)).digest("hex") !== expectedSha256) {
    throw new Error("ling_e6_qa_electron_dist_invalid");
  }
}
const baseBuild = packageJson.build;
await preparePackagedGstackBuild();
const gstackBuild = packagedGstackBuilderConfig();
const packageProvider = process.env.LING_CUA_DRIVER_PACKAGE_PROVIDER === "1";
const externalPluginsOnly = process.env.LING_PLUGIN_EXTERNAL_ONLY === "1";
const catalogManaged = process.env.LING_CUA_DRIVER_CATALOG_MANAGED === "1";
if (catalogManaged && (!externalPluginsOnly || packageProvider)) {
  throw new Error("cua_driver_catalog_managed_resource_mode_invalid");
}
if (externalPluginsOnly && packageProvider) {
  throw new Error("The embedded Cua Driver signing lane requires the provider payload in Desktop resources.");
}
const packageResourcesRoot = process.env.LING_CUA_PACKAGE_RESOURCES_ROOT;
const packageHostAuthorityJson = process.env.LING_CUA_PACKAGE_HOST_AUTHORITY_JSON;
const packageAuthority = packageProvider || catalogManaged;
if (packageAuthority && (!packageResourcesRoot || !isAbsolute(packageResourcesRoot))) {
  throw new Error("cua_driver_package_resources_root_invalid");
}
if (!packageAuthority && packageResourcesRoot) {
  throw new Error("cua_driver_package_resources_without_authority");
}
if (!packageAuthority && packageHostAuthorityJson) {
  throw new Error("cua_driver_package_host_authority_without_package_authority");
}
const packageHostAuthority = packageAuthority
  ? parsePackageHostAuthority(packageHostAuthorityJson)
  : createExternalOnlyCuaDriverPackageAuthority();
if (catalogManaged !== (packageHostAuthority.providerSource === "official-cache")) {
  throw new Error("cua_driver_package_authority_source_mismatch");
}
const signingProfile = resolveSigningProfile();
const lockedUseBuild = await lockedUseReleaseBuilderConfig({
  releaseRoot: process.env.LING_LOCKED_USE_RELEASE_ROOT,
  signingTier: signingProfile.signingTier,
  providerExpected: packageProvider && packageHostAuthority.platform === "darwin",
});
const lockedUseValidationBuild = await lockedUseValidationBuilderConfig({
  candidateRoot: process.env.LING_LOCKED_USE_VALIDATION_ROOT,
  releaseRoot: process.env.LING_LOCKED_USE_RELEASE_ROOT,
  signingTier: signingProfile.signingTier,
  providerExpected: packageProvider && packageHostAuthority.platform === "darwin",
});
const lockedUseLocalBuild = await lockedUseLocalBuilderConfig({
  localRoot: process.env.LING_LOCKED_USE_LOCAL_ROOT,
  releaseRoot: process.env.LING_LOCKED_USE_RELEASE_ROOT,
  validationRoot: process.env.LING_LOCKED_USE_VALIDATION_ROOT,
  signingTier: signingProfile.signingTier,
  providerExpected: packageProvider && packageHostAuthority.platform === "darwin",
});
if (
  packageProvider
  && (
    packageHostAuthority.signingTier !== signingProfile.signingTier
    || packageHostAuthority.distributionChannel !== signingProfile.distributionChannel
  )
) {
  throw new Error("cua_driver_package_host_authority_signing_profile_mismatch");
}

export default {
  ...baseBuild,
  files: [
    ...baseBuild.files,
    ...(externalPluginsOnly ? ["!dist/office-driver{,/**/*}"] : []),
  ],
  ...(localElectronDist ? { electronDist: localElectronDist } : {}),
  asar: true,
  extraMetadata: {
    ...(baseBuild.extraMetadata ?? {}),
    ...(gstackBuild.extraMetadata ?? {}),
    ...(lockedUseBuild.extraMetadata ?? {}),
    ...(lockedUseValidationBuild.extraMetadata ?? {}),
    ...(lockedUseLocalBuild.extraMetadata ?? {}),
    lingPluginResourceMode: externalPluginsOnly ? "on-demand" : "bundled",
    [CUA_DRIVER_PACKAGE_AUTHORITY_METADATA_KEY]: packageHostAuthority,
  },
  electronFuses: {
    ...(baseBuild.electronFuses ?? {}),
    enableEmbeddedAsarIntegrityValidation: true,
    onlyLoadAppFromAsar: true,
  },
  directories: {
    ...baseBuild.directories,
    ...(process.env.LING_CUA_PACKAGE_OUTPUT_ROOT
      ? { output: process.env.LING_CUA_PACKAGE_OUTPUT_ROOT }
      : {}),
  },
  extraResources: [
    ...(baseBuild.extraResources ?? []),
    // Builder merges package.json arrays with the in-process macOS config.
    ...(!externalPluginsOnly ? packageJson.lingBundledPluginResources : []),
    ...(gstackBuild.extraResources ?? []),
    ...(lockedUseBuild.extraResources ?? []),
    ...(lockedUseValidationBuild.extraResources ?? []),
    ...(lockedUseLocalBuild.extraResources ?? []),
    ...(!externalPluginsOnly && packageProvider
      ? [{ from: resolve(packageResourcesRoot), to: "providers/cua-driver" }]
      : []),
    ...(catalogManaged ? [{
      from: resolve(packageResourcesRoot),
      to: "providers/cua-driver",
      filter: ["packaged-provider-capabilities.json", "runtime-trust-policy.json"],
    }] : []),
  ],
  mac: {
    ...baseBuild.mac,
    ...(gstackBuild.mac ?? {}),
    ...(signingProfile.signingTier === "unsigned_dev"
      ? {
          identity: "-",
          hardenedRuntime: false,
        }
      : {}),
    ...(packageProvider
      ? {
          sign: "./scripts/cua-driver-signing/electron-builder-mac-sign.mjs",
          identity: process.env.LING_CUA_DARWIN_SIGNING_IDENTITY ?? "-",
          ...(signingProfile.signingTier === "test_signed_internal"
            ? { type: "development" }
            : {}),
          hardenedRuntime: signingProfile.signingTier !== "unsigned_dev",
        }
      : {}),
  },
  win: {
    ...baseBuild.win,
    ...(packageProvider
      ? {
          signtoolOptions: {
            sign: "./scripts/cua-driver-signing/electron-builder-win-sign.mjs",
            signingHashAlgorithms: ["sha256"],
          },
          signExts: [
            "!resources/providers/cua-driver/0.8.3-ling.1/win32-x64/payload/ling-cua-driver.exe",
            "!resources\\providers\\cua-driver\\0.8.3-ling.1\\win32-x64\\payload\\ling-cua-driver.exe",
          ],
        }
      : {}),
  },
  // Keep every Windows resource in the single archive that the release
  // verifier extracts and compares. electron-builder otherwise moves
  // pre-compressed media (.mp4/.webm) into NSIS-only File entries; those
  // entries are installed at runtime but are absent from app-64.7z, making
  // the immutable archive comparison report a false missing-resource failure.
  nsis: {
    ...baseBuild.nsis,
    preCompressedFileExtensions: [],
  },
};

function parsePackageHostAuthority(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 16 * 1024) {
    throw new Error("cua_driver_package_host_authority_invalid");
  }
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("cua_driver_package_host_authority_invalid");
  }
  const authority = validateCuaDriverPackageAuthority(parsed);
  if (!authority.providerExpected) {
    throw new Error("cua_driver_package_host_authority_provider_not_expected");
  }
  return authority;
}
