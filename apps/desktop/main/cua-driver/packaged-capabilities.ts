import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import {
  DEFAULT_DESKTOP_CUA_DRIVER_PACKAGED_PROVIDER_CAPABILITIES,
  type DesktopCuaDriverPackagedProviderCapabilitiesV1,
} from "./feature-gates.js";
import { CUA_DRIVER_DISTRIBUTION_REVISION } from "./resource-path.js";
import {
  BoundedResourceFileError,
  readBoundedContainedResourceFile,
} from "./bounded-resource-file.js";
import type { DesktopCuaDriverPackageAuthorityV1 } from "./packaged-authority.js";

export const CUA_DRIVER_PACKAGED_CAPABILITIES_MAX_BYTES = 16 * 1024;
export const CUA_DRIVER_PACKAGED_CAPABILITIES_RESOURCE_SEGMENTS = Object.freeze([
  "providers",
  "cua-driver",
  "packaged-provider-capabilities.json",
] as const);

export class CuaDriverPackagedCapabilitiesError extends Error {
  readonly code = "cua_driver_packaged_capabilities_invalid" as const;

  constructor(
    readonly capabilitiesCode:
      | "json_invalid"
      | "digest_mismatch"
      | "oversized"
      | "path_escape"
      | "path_invalid"
      | "platform_mismatch"
      | "schema_invalid"
      | "unavailable",
    readonly path?: string,
  ) {
    super(`cua_driver_packaged_capabilities_${capabilitiesCode}`);
    this.name = "CuaDriverPackagedCapabilitiesError";
  }
}

/**
 * Read the build-produced gate assertion. Absence means an ordinary
 * external-only package; malformed or replaced bytes fail closed with a
 * diagnostic instead of silently becoming an absent capability.
 */
export async function loadDesktopCuaDriverPackagedProviderCapabilities(
  resourcesPathValue: string,
  options: Readonly<{ authority?: DesktopCuaDriverPackageAuthorityV1 }> = {},
): Promise<DesktopCuaDriverPackagedProviderCapabilitiesV1> {
  if (!isAbsolute(resourcesPathValue)) {
    throw new CuaDriverPackagedCapabilitiesError("path_invalid", resourcesPathValue);
  }
  if (options.authority?.providerExpected === false) {
    return DEFAULT_DESKTOP_CUA_DRIVER_PACKAGED_PROVIDER_CAPABILITIES;
  }
  let resource;
  try {
    resource = await readBoundedContainedResourceFile({
      resourcesPath: resourcesPathValue,
      segments: CUA_DRIVER_PACKAGED_CAPABILITIES_RESOURCE_SEGMENTS,
      maxBytes: CUA_DRIVER_PACKAGED_CAPABILITIES_MAX_BYTES,
      optional: options.authority === undefined,
    });
  } catch (error) {
    if (error instanceof BoundedResourceFileError) {
      throw new CuaDriverPackagedCapabilitiesError(
        mapResourceError(error.resourceCode),
        error.path,
      );
    }
    throw error;
  }
  if (!resource) {
    return DEFAULT_DESKTOP_CUA_DRIVER_PACKAGED_PROVIDER_CAPABILITIES;
  }
  if (
    options.authority?.providerExpected
    && sha256(resource.bytes) !== options.authority.capabilitiesSha256
  ) {
    throw new CuaDriverPackagedCapabilitiesError("digest_mismatch", resource.path);
  }
  let value: unknown;
  try {
    value = JSON.parse(resource.bytes.toString("utf8")) as unknown;
  } catch {
    throw new CuaDriverPackagedCapabilitiesError("json_invalid", resource.path);
  }
  try {
    const capabilities = validateDesktopCuaDriverPackagedProviderCapabilities(value);
    if (
      options.authority?.providerExpected
      && (
        capabilities.darwin !== (options.authority.platform === "darwin")
        || capabilities.win32 !== (options.authority.platform === "win32")
      )
    ) {
      throw new CuaDriverPackagedCapabilitiesError("platform_mismatch", resource.path);
    }
    return capabilities;
  } catch (error) {
    if (error instanceof CuaDriverPackagedCapabilitiesError) {
      throw new CuaDriverPackagedCapabilitiesError(error.capabilitiesCode, resource.path);
    }
    throw error;
  }
}

export function validateDesktopCuaDriverPackagedProviderCapabilities(
  value: unknown,
): DesktopCuaDriverPackagedProviderCapabilitiesV1 {
  if (!isRecord(value)) {
    throw new CuaDriverPackagedCapabilitiesError("schema_invalid");
  }
  const expectedKeys = [
    "componentId",
    "darwin",
    "distributionRevision",
    "resourcesValidated",
    "schemaVersion",
    "win32",
  ].sort();
  const actualKeys = Object.keys(value).sort();
  if (
    actualKeys.length !== expectedKeys.length
    || actualKeys.some((key, index) => key !== expectedKeys[index])
    || value.schemaVersion !== 1
    || value.componentId !== "cua-driver"
    || value.distributionRevision !== CUA_DRIVER_DISTRIBUTION_REVISION
    || value.resourcesValidated !== true
    || typeof value.darwin !== "boolean"
    || typeof value.win32 !== "boolean"
    || value.darwin === value.win32
  ) {
    throw new CuaDriverPackagedCapabilitiesError("schema_invalid");
  }
  return Object.freeze({
    schemaVersion: 1,
    resourcesValidated: true,
    darwin: value.darwin,
    win32: value.win32,
  });
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function mapResourceError(
  code: BoundedResourceFileError["resourceCode"],
): "oversized" | "path_escape" | "path_invalid" | "unavailable" {
  if (code === "oversized" || code === "path_escape" || code === "path_invalid") {
    return code;
  }
  return "unavailable";
}
