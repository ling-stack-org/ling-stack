import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { DesktopLockedUseBackend } from "./runtime-composition.js";
import { loadInstalledDarwinLockedUseBackend } from "./packaged-darwin-backend.js";
import {
  BoundedResourceFileError,
  readBoundedContainedResourceFile,
} from "../cua-driver/bounded-resource-file.js";

const RELEASE_AUTHORITY_SEGMENTS = ["locked-use", "release-authority.json"] as const;
const LOCAL_AUTHORITY_SEGMENTS = ["locked-use", "local-authority.json"] as const;
const RELEASE_AUTHORITY_MAX_BYTES = 16 * 1024;
const PACKAGE_METADATA_MAX_BYTES = 1024 * 1024;
export const LOCKED_USE_RELEASE_AUTHORITY_METADATA_KEY = "lingLockedUseReleaseAuthoritySha256";
export const LOCKED_USE_LOCAL_AUTHORITY_METADATA_KEY = "lingLockedUseLocalAuthoritySha256";

export interface PackagedDarwinLockedUseBackendDependencies {
  readonly readResource?: typeof readBoundedContainedResourceFile;
  readonly loadBackend?: typeof loadInstalledDarwinLockedUseBackend;
}

/**
 * Load release-owned Locked Use acceptance. The file is optional in ordinary
 * builds; its digest must be pinned by package.json inside the signed app.asar.
 * Electron's ASAR-integrity fuses bind that pin to the host executable. The
 * loose resource carries an attended acceptance marker and the accepted native
 * manifest digest. Installed components cannot nominate their own authority.
 */
export async function loadPackagedDarwinLockedUseBackend(options: {
  readonly packaged: boolean;
  readonly platform: string;
  readonly appPath: string;
  readonly resourcesRoot: string;
}, dependencies: PackagedDarwinLockedUseBackendDependencies = {}): Promise<DesktopLockedUseBackend | undefined> {
  if (!options.packaged || options.platform !== "darwin"
    || !isAbsolute(options.appPath) || !isAbsolute(options.resourcesRoot)) return undefined;
  const authorityDigest = await loadReleaseAuthorityDigest(options.appPath);
  if (!authorityDigest) return undefined;
  let resource;
  try {
    resource = await (dependencies.readResource ?? readBoundedContainedResourceFile)({
      resourcesPath: options.resourcesRoot,
      segments: RELEASE_AUTHORITY_SEGMENTS,
      maxBytes: RELEASE_AUTHORITY_MAX_BYTES,
      optional: true,
    });
  } catch (error) {
    if (error instanceof BoundedResourceFileError) return undefined;
    throw error;
  }
  if (!resource) return undefined;
  if (createHash("sha256").update(resource.bytes).digest("hex") !== authorityDigest) return undefined;
  let value: unknown;
  try { value = JSON.parse(resource.bytes.toString("utf8")) as unknown; }
  catch { return undefined; }
  if (!isRecord(value)
    || !exactKeys(value, ["schemaVersion", "platform", "nativeAcceptance", "expectedTeamId", "expectedBuildManifestSha256"])
    || value.schemaVersion !== 1
    || value.platform !== "darwin"
    || value.nativeAcceptance !== "passed"
    || typeof value.expectedTeamId !== "string"
    || !/^[A-Z0-9]{10}$/u.test(value.expectedTeamId)
    || value.expectedTeamId === "0000000000"
    || typeof value.expectedBuildManifestSha256 !== "string"
    || !/^[a-f0-9]{64}$/u.test(value.expectedBuildManifestSha256)) return undefined;
  return (dependencies.loadBackend ?? loadInstalledDarwinLockedUseBackend)({
    expectedTeamId: value.expectedTeamId,
    expectedBuildManifestSha256: value.expectedBuildManifestSha256,
  });
}

/**
 * Load the explicitly opted-in Apple Development lane. It is separate from
 * release authority so a local package can never qualify for distribution.
 */
export async function loadPackagedLocalDarwinLockedUseBackend(options: {
  readonly packaged: boolean;
  readonly platform: string;
  readonly appPath: string;
  readonly resourcesRoot: string;
}, dependencies: PackagedDarwinLockedUseBackendDependencies = {}): Promise<DesktopLockedUseBackend | undefined> {
  if (!options.packaged || options.platform !== "darwin"
    || !isAbsolute(options.appPath) || !isAbsolute(options.resourcesRoot)) return undefined;
  const authorityDigest = await loadAuthorityDigest(options.appPath, LOCKED_USE_LOCAL_AUTHORITY_METADATA_KEY);
  if (!authorityDigest) return undefined;
  let resource;
  try {
    resource = await (dependencies.readResource ?? readBoundedContainedResourceFile)({
      resourcesPath: options.resourcesRoot,
      segments: LOCAL_AUTHORITY_SEGMENTS,
      maxBytes: RELEASE_AUTHORITY_MAX_BYTES,
      optional: true,
    });
  } catch (error) {
    if (error instanceof BoundedResourceFileError) return undefined;
    throw error;
  }
  if (!resource || createHash("sha256").update(resource.bytes).digest("hex") !== authorityDigest) return undefined;
  let value: unknown;
  try { value = JSON.parse(resource.bytes.toString("utf8")) as unknown; }
  catch { return undefined; }
  if (!isRecord(value)
    || !exactKeys(value, ["schemaVersion", "platform", "profile", "nativeAcceptance", "expectedTeamId", "expectedBuildManifestSha256"])
    || value.schemaVersion !== 1 || value.platform !== "darwin"
    || value.profile !== "local_development" || value.nativeAcceptance !== "local_development"
    || typeof value.expectedTeamId !== "string" || !/^[A-Z0-9]{10}$/u.test(value.expectedTeamId)
    || value.expectedTeamId === "0000000000"
    || typeof value.expectedBuildManifestSha256 !== "string"
    || !/^[a-f0-9]{64}$/u.test(value.expectedBuildManifestSha256)) return undefined;
  return (dependencies.loadBackend ?? loadInstalledDarwinLockedUseBackend)({
    expectedTeamId: value.expectedTeamId,
    expectedBuildManifestSha256: value.expectedBuildManifestSha256,
    expectedProfile: "local_development",
  });
}

async function loadReleaseAuthorityDigest(appPath: string): Promise<string | undefined> {
  return loadAuthorityDigest(appPath, LOCKED_USE_RELEASE_AUTHORITY_METADATA_KEY);
}

async function loadAuthorityDigest(appPath: string, key: string): Promise<string | undefined> {
  try {
    const path = join(appPath, "package.json");
    const metadata = await stat(path);
    if (!metadata.isFile() || metadata.size > PACKAGE_METADATA_MAX_BYTES) return undefined;
    const bytes = await readFile(path);
    if (bytes.byteLength > PACKAGE_METADATA_MAX_BYTES) return undefined;
    const value: unknown = JSON.parse(bytes.toString("utf8"));
    if (!isRecord(value)) return undefined;
    const digest = value[key];
    return typeof digest === "string" && /^[a-f0-9]{64}$/u.test(digest) ? digest : undefined;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Readonly<Record<string, unknown>>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const keys = [...expected].sort();
  return actual.length === keys.length && actual.every((key, index) => key === keys[index]);
}
