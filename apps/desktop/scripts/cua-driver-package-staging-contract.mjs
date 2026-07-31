import { isAbsolute, relative, resolve, sep } from "node:path";
import {
  cuaDriverArtifactLayoutFor,
  normalizeCuaDriverArtifactPlatform,
} from "../shared/cua-driver-artifact-layout.mjs";

export const CUA_DRIVER_PACKAGE_REVISION = "0.8.3-ling.1";
export const CUA_DRIVER_PACKAGE_DESTINATION =
  `providers/cua-driver/${CUA_DRIVER_PACKAGE_REVISION}`;
// Independent review anchor for the checked-in provider-lock.json. Opening a
// platform requires updating both the lock and this digest in the same change.
export const CUA_DRIVER_COMMITTED_LOCK_SHA256 =
  "0fae16f8357a81986ec915a544e0aea3bbbd2f8ab56aec22d770478b03146a98";
// The non-promoting source-build contract is a second independent input to
// promotion. A custom --resource-root must carry these exact reviewed bytes;
// self-consistent replacement inputs cannot authorize their own lock record.
export const CUA_DRIVER_COMMITTED_SOURCE_BUILD_INPUTS_SHA256 =
  "8c79529ead435287f08a483e3b2ef93d2fddd898ad4107401b9a720ef354ce2b";

const SUPPORTED_PLATFORMS = new Set(["darwin", "win32-x64"]);

export class CuaDriverPackageStagingError extends Error {
  constructor(code, message, path) {
    super(`${code}:${message}`);
    this.name = "CuaDriverPackageStagingError";
    this.code = code;
    this.path = path;
  }
}

export function normalizePackagePlatform(value) {
  const platform = String(value ?? "").trim();
  if (!SUPPORTED_PLATFORMS.has(platform)) {
    fail("provider_platform_unsupported", `unsupported provider package platform: ${platform}`);
  }
  return normalizeCuaDriverArtifactPlatform(platform);
}

export function requireAbsoluteRoot(value, code) {
  if (typeof value !== "string" || value.trim() !== value || !isAbsolute(value)) {
    fail(code, "path must be a non-empty absolute path", String(value ?? ""));
  }
  return resolve(value);
}

export function providerRootFor(resourcesRoot) {
  return resolve(
    resourcesRoot,
    "providers",
    "cua-driver",
    CUA_DRIVER_PACKAGE_REVISION,
  );
}

export function providerRelativePath(platform) {
  return cuaDriverArtifactLayoutFor(
    normalizePackagePlatform(platform),
  ).packagedExecutableRelativePath;
}

export function preSignProviderFiles(platform) {
  return [
    "LICENSE.md",
    "THIRD_PARTY_NOTICES.md",
    "provider-lock.json",
    providerRelativePath(platform),
  ].sort();
}

export function resolveRelative(root, relativePath) {
  const destination = resolve(root, ...relativePath.split("/"));
  if (!isWithin(destination, root) || destination === resolve(root)) {
    fail("provider_path_escape", `provider path escapes its root: ${relativePath}`, destination);
  }
  return destination;
}

export function isWithin(candidate, root) {
  const value = relative(resolve(root), resolve(candidate));
  return value === "" || (!isAbsolute(value) && value !== ".." && !value.startsWith(`..${sep}`));
}

export function assertDisjointRoots(
  leftRoot,
  rightRoot,
  code = "staging_roots_overlap",
  message = "source and output roots must not contain each other",
) {
  if (isWithin(leftRoot, rightRoot) || isWithin(rightRoot, leftRoot)) {
    fail(
      code,
      message,
      rightRoot,
    );
  }
}

export function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isSha256(value) {
  return typeof value === "string"
    && /^[0-9a-f]{64}$/u.test(value)
    && !/^0{64}$/u.test(value);
}

export function fail(code, message, path) {
  throw new CuaDriverPackageStagingError(code, message, path);
}
