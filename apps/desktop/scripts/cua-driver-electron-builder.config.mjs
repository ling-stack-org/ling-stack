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
const packageResourcesRoot = process.env.LING_CUA_PACKAGE_RESOURCES_ROOT;
const packageHostAuthorityJson = process.env.LING_CUA_PACKAGE_HOST_AUTHORITY_JSON;
if (packageProvider && (!packageResourcesRoot || !isAbsolute(packageResourcesRoot))) {
  throw new Error("cua_driver_package_resources_root_invalid");
}
if (!packageProvider && packageResourcesRoot) {
  throw new Error("cua_driver_package_resources_without_authority");
}
if (!packageProvider && packageHostAuthorityJson) {
  throw new Error("cua_driver_package_host_authority_without_package_authority");
}
const packageHostAuthority = packageProvider
  ? parsePackageHostAuthority(packageHostAuthorityJson)
  : createExternalOnlyCuaDriverPackageAuthority();
const signingProfile = resolveSigningProfile();
if (
  packageHostAuthority.providerExpected
  && (
    packageHostAuthority.signingTier !== signingProfile.signingTier
    || packageHostAuthority.distributionChannel !== signingProfile.distributionChannel
  )
) {
  throw new Error("cua_driver_package_host_authority_signing_profile_mismatch");
}

export default {
  ...baseBuild,
  ...(localElectronDist ? { electronDist: localElectronDist } : {}),
  asar: true,
  extraMetadata: {
    ...(baseBuild.extraMetadata ?? {}),
    ...(gstackBuild.extraMetadata ?? {}),
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
    ...(gstackBuild.extraResources ?? []),
    ...(packageProvider
      ? [{ from: resolve(packageResourcesRoot), to: "providers/cua-driver" }]
      : []),
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
