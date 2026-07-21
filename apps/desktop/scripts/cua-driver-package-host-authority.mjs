import { createRequire } from "node:module";
import { join, resolve } from "node:path";

import { extractFile } from "@electron/asar";

import {
  CUA_DRIVER_PACKAGE_AUTHORITY_METADATA_KEY,
  validateCuaDriverPackageAuthority,
} from "../shared/cua-driver-package-authority-contract.mjs";
import {
  SigningContractError,
  canonicalJson,
} from "./cua-driver-signing/signing-contract.mjs";

const require = createRequire(import.meta.url);
let fuseLibrary;

export async function verifyCuaDriverPackagedHostAuthority(input) {
  const platform = input?.platform;
  const appOutDir = resolve(String(input?.appOutDir ?? ""));
  const productFilename = requireProductFilename(input?.productFilename);
  const expectedAuthority = validateCuaDriverPackageAuthority(input?.expectedAuthority);
  if (!expectedAuthority.providerExpected) {
    throw new SigningContractError(
      "package_host_authority_provider_not_expected",
      "Provider-bearing signing requires a providerExpected host authority",
    );
  }
  const asarPath = platform === "darwin"
    ? join(appOutDir, `${productFilename}.app`, "Contents", "Resources", "app.asar")
    : platform === "win32"
      ? join(appOutDir, "resources", "app.asar")
      : undefined;
  if (!asarPath) {
    throw new SigningContractError(
      "package_host_authority_platform_invalid",
      `Unsupported packaged authority platform: ${String(platform)}`,
    );
  }
  let packageJson;
  try {
    packageJson = JSON.parse(extractFile(asarPath, "package.json").toString("utf8"));
  } catch (error) {
    throw new SigningContractError(
      "package_host_authority_unavailable",
      `Unable to read package authority from ${asarPath}`,
      { cause: error },
    );
  }
  let authority;
  try {
    authority = validateCuaDriverPackageAuthority(
      packageJson?.[CUA_DRIVER_PACKAGE_AUTHORITY_METADATA_KEY],
    );
  } catch (error) {
    throw new SigningContractError(
      "package_host_authority_invalid",
      `Packaged metadata does not contain the governed Cua Driver authority: ${asarPath}`,
      { cause: error },
    );
  }
  if (canonicalJson(authority) !== canonicalJson(expectedAuthority)) {
    throw new SigningContractError(
      "package_host_authority_mismatch",
      "Packaged host authority differs from the build-authorized policy digests",
    );
  }
  if (input?.requireFuses !== false) {
    await verifyAuthorityFuses({ appOutDir, platform, productFilename });
  }
  return Object.freeze({ authority, asarPath });
}

async function verifyAuthorityFuses({ appOutDir, platform, productFilename }) {
  const { getCurrentFuseWire, FuseV1Options } = loadFuseLibrary();
  const electronPath = platform === "darwin"
    ? join(appOutDir, `${productFilename}.app`)
    : join(appOutDir, `${productFilename}.exe`);
  let wire;
  try {
    wire = await getCurrentFuseWire(electronPath);
  } catch (error) {
    throw new SigningContractError(
      "package_host_authority_fuses_unavailable",
      `Unable to inspect Electron fuses at ${electronPath}`,
      { cause: error },
    );
  }
  const enabled = 49;
  if (
    wire[FuseV1Options.EnableEmbeddedAsarIntegrityValidation] !== enabled
    || wire[FuseV1Options.OnlyLoadAppFromAsar] !== enabled
  ) {
    throw new SigningContractError(
      "package_host_authority_fuses_disabled",
      "Provider-bearing packages require ASAR integrity and onlyLoadAppFromAsar",
    );
  }
}

function loadFuseLibrary() {
  if (fuseLibrary) return fuseLibrary;
  const electronBuilderPackage = require.resolve("electron-builder/package.json");
  const electronBuilderRequire = createRequire(electronBuilderPackage);
  const appBuilderPackage = electronBuilderRequire.resolve("app-builder-lib/package.json");
  fuseLibrary = createRequire(appBuilderPackage)("@electron/fuses");
  return fuseLibrary;
}

function requireProductFilename(value) {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > 255
    || /[\\/\0]/u.test(value)
  ) {
    throw new SigningContractError(
      "package_product_filename_invalid",
      "Electron Builder product filename is required for host-authority verification",
    );
  }
  return value;
}
