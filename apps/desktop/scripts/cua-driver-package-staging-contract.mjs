import { isAbsolute, relative, resolve, sep } from "node:path";

export const CUA_DRIVER_PACKAGE_REVISION = "0.8.3-ling.1";
export const CUA_DRIVER_PACKAGE_DESTINATION =
  `providers/cua-driver/${CUA_DRIVER_PACKAGE_REVISION}`;
// Independent review anchor for the checked-in provider-lock.json. Opening a
// platform requires updating both the lock and this digest in the same change.
export const CUA_DRIVER_COMMITTED_LOCK_SHA256 =
  "6bdeb8d8a8ba260c3abf3235e08c34a74395566776b320d0e5a11eea71069a7c";
// The non-promoting source-build contract is a second independent input to
// promotion. A custom --resource-root must carry these exact reviewed bytes;
// self-consistent replacement inputs cannot authorize their own lock record.
export const CUA_DRIVER_COMMITTED_SOURCE_BUILD_INPUTS_SHA256 =
  "b7f4cf9a25b2d5426de5acd0ca12310d25433ae6a4d0c52066d8e22ad3fcd767";

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
  return platform;
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
  return normalizePackagePlatform(platform) === "darwin"
    ? "darwin/cua-driver"
    : "win32-x64/payload/cua-driver.exe";
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
