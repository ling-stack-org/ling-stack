import { readFile, stat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import {
  CUA_DRIVER_PACKAGE_AUTHORITY_METADATA_KEY,
  createExternalOnlyCuaDriverPackageAuthority,
  validateCuaDriverPackageAuthority,
} from "../../shared/cua-driver-package-authority-contract.mjs";
import type { DesktopCuaDriverPackagedProviderCapabilitiesV1 } from "./feature-gates.js";

export const CUA_DRIVER_PACKAGED_APP_METADATA_MAX_BYTES = 1024 * 1024;

export type DesktopCuaDriverPackageAuthorityV1 =
  | Readonly<{
      schemaVersion: 1;
      componentId: "cua-driver";
      distributionRevision: "0.8.3-ling.1";
      providerExpected: false;
    }>
  | Readonly<{
      schemaVersion: 1;
      componentId: "cua-driver";
      distributionRevision: "0.8.3-ling.1";
      providerExpected: true;
      platform: "darwin" | "win32";
      signingTier: "unsigned_dev" | "test_signed_internal" | "production_signed";
      distributionChannel: "development" | "internal" | "production";
      capabilitiesSha256: string;
      runtimeTrustPolicySha256: string;
    }>;

export class CuaDriverPackagedAuthorityError extends Error {
  readonly code = "cua_driver_packaged_authority_invalid" as const;

  constructor(
    readonly authorityCode: "json_invalid" | "oversized" | "path_invalid" | "schema_invalid" | "unavailable",
    readonly path?: string,
  ) {
    super(`cua_driver_packaged_authority_${authorityCode}`);
    this.name = "CuaDriverPackagedAuthorityError";
  }
}

/**
 * Read package intent from packaged package.json inside app.asar. Electron's
 * ASAR-integrity fuses bind these bytes to the signed host executable.
 * Legacy packages without this field are external-only.
 */
export async function loadDesktopCuaDriverPackageAuthority(
  appPathValue: string,
): Promise<DesktopCuaDriverPackageAuthorityV1> {
  if (!isAbsolute(appPathValue)) {
    throw new CuaDriverPackagedAuthorityError("path_invalid", appPathValue);
  }
  const packageJsonPath = join(resolve(appPathValue), "package.json");
  let bytes: Buffer;
  try {
    const metadata = await stat(packageJsonPath);
    if (!metadata.isFile()) {
      throw new CuaDriverPackagedAuthorityError("path_invalid", packageJsonPath);
    }
    if (metadata.size > CUA_DRIVER_PACKAGED_APP_METADATA_MAX_BYTES) {
      throw new CuaDriverPackagedAuthorityError("oversized", packageJsonPath);
    }
    bytes = await readFile(packageJsonPath);
  } catch (error) {
    if (error instanceof CuaDriverPackagedAuthorityError) throw error;
    throw new CuaDriverPackagedAuthorityError("unavailable", packageJsonPath);
  }
  if (bytes.byteLength > CUA_DRIVER_PACKAGED_APP_METADATA_MAX_BYTES) {
    throw new CuaDriverPackagedAuthorityError("oversized", packageJsonPath);
  }
  let packageJson: unknown;
  try {
    packageJson = JSON.parse(bytes.toString("utf8")) as unknown;
  } catch {
    throw new CuaDriverPackagedAuthorityError("json_invalid", packageJsonPath);
  }
  if (!isRecord(packageJson)) {
    throw new CuaDriverPackagedAuthorityError("schema_invalid", packageJsonPath);
  }
  const metadata = packageJson[CUA_DRIVER_PACKAGE_AUTHORITY_METADATA_KEY];
  if (metadata === undefined) {
    return createExternalOnlyCuaDriverPackageAuthority() as DesktopCuaDriverPackageAuthorityV1;
  }
  try {
    return validateCuaDriverPackageAuthority(metadata) as DesktopCuaDriverPackageAuthorityV1;
  } catch {
    throw new CuaDriverPackagedAuthorityError("schema_invalid", packageJsonPath);
  }
}

export function packagedProviderIntentCapabilities(
  authority: DesktopCuaDriverPackageAuthorityV1,
): DesktopCuaDriverPackagedProviderCapabilitiesV1 {
  return Object.freeze({
    schemaVersion: 1,
    resourcesValidated: true,
    darwin: authority.providerExpected && authority.platform === "darwin",
    win32: authority.providerExpected && authority.platform === "win32",
  });
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
