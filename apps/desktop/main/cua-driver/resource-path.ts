import { lstat, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { CuaDriverArchitecture, CuaDriverPlatform } from "@ling-stack/contracts";

export const CUA_DRIVER_DISTRIBUTION_REVISION = "0.8.3-ling.1" as const;
export const CUA_DRIVER_RESOURCE_ROOT_SEGMENTS = [
  "providers",
  "cua-driver",
  CUA_DRIVER_DISTRIBUTION_REVISION,
] as const;

export class CuaDriverResourcePathError extends Error {
  readonly code = "cua_driver_resource_path_invalid" as const;

  constructor(message: string, readonly path?: string) {
    super(message);
    this.name = "CuaDriverResourcePathError";
  }
}

export interface CuaDriverResourcePaths {
  readonly resourcesPath: string;
  readonly providerRoot: string;
  readonly lockPath: string;
  readonly licensePath: string;
  readonly noticesPath: string;
  readonly platformRoot: string;
  readonly executablePath: string;
  readonly sealPath: string;
  readonly catalogPath?: string;
}

export interface ResolveCuaDriverResourcePathsInput {
  readonly resourcesPath: string;
  readonly platform: CuaDriverPlatform;
  readonly architecture: CuaDriverArchitecture;
  readonly signingTier?: "unsigned_dev" | "test_signed_internal" | "production_signed";
}

/**
 * Resolve the only path a bundled provider is allowed to use. No PATH lookup,
 * home-directory fallback or user-provided executable path is accepted here.
 */
export function resolveCuaDriverResourcePaths(
  input: ResolveCuaDriverResourcePathsInput,
): CuaDriverResourcePaths {
  if (!isAbsolute(input.resourcesPath)) {
    throw new CuaDriverResourcePathError("resources_path_must_be_absolute", input.resourcesPath);
  }
  if (input.platform !== "darwin" && input.platform !== "win32") {
    throw new CuaDriverResourcePathError("platform_unsupported");
  }
  if (input.platform === "win32" && input.architecture !== "x86_64") {
    throw new CuaDriverResourcePathError("windows_architecture_unsupported");
  }
  if (input.platform === "darwin" && input.architecture !== "arm64" && input.architecture !== "x86_64") {
    throw new CuaDriverResourcePathError("darwin_architecture_unsupported");
  }

  const resourcesPath = resolve(input.resourcesPath);
  const providerRoot = join(resourcesPath, ...CUA_DRIVER_RESOURCE_ROOT_SEGMENTS);
  const platformRoot = join(providerRoot, input.platform === "darwin" ? "darwin" : "win32-x64");
  const isWindows = input.platform === "win32";
  const payloadRoot = isWindows ? join(platformRoot, "payload") : platformRoot;
  const executablePath = join(payloadRoot, isWindows ? "cua-driver.exe" : "cua-driver");
  const sealPath = join(payloadRoot, "provider-seal.json");
  const catalogPath = isWindows ? join(platformRoot, "provider-integrity.cat") : undefined;
  return {
    resourcesPath,
    providerRoot,
    lockPath: join(providerRoot, "provider-lock.json"),
    licensePath: join(providerRoot, "LICENSE.md"),
    noticesPath: join(providerRoot, "THIRD_PARTY_NOTICES.md"),
    platformRoot,
    executablePath,
    sealPath,
    ...(catalogPath ? { catalogPath } : {}),
  };
}

/** Assert a candidate path is inside the deterministic provider root. */
export function assertCuaDriverPathInsideRoot(
  candidatePath: string,
  rootPath: string,
  label = "provider_path",
): string {
  if (!isAbsolute(candidatePath) || !isAbsolute(rootPath)) {
    throw new CuaDriverResourcePathError(`${label}_must_be_absolute`, candidatePath);
  }
  const candidate = resolve(candidatePath);
  const root = resolve(rootPath);
  const rel = relative(root, candidate);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new CuaDriverResourcePathError(`${label}_outside_provider_root`, candidatePath);
  }
  return candidate;
}

export async function assertCuaDriverResourceTree(
  paths: CuaDriverResourcePaths,
  options: { readonly requireCatalog?: boolean } = {},
): Promise<void> {
  const expected: Array<[string, string]> = [
    [paths.providerRoot, "provider_root"],
    [paths.platformRoot, "platform_root"],
    [paths.lockPath, "provider_lock"],
    [paths.licensePath, "provider_license"],
    [paths.noticesPath, "provider_notices"],
    [paths.executablePath, "provider_executable"],
    [paths.sealPath, "provider_seal"],
  ];
  if (paths.platformRoot.endsWith("win32-x64")) {
    expected.push([join(paths.platformRoot, "payload"), "provider_payload"]);
    if (options.requireCatalog) {
      if (!paths.catalogPath) {
        throw new CuaDriverResourcePathError("provider_catalog_path_missing");
      }
      expected.push([paths.catalogPath, "provider_catalog"]);
    }
  }
  for (const [path, label] of expected) {
    await assertRegularNonSymlinkPath(path, label);
  }
  await assertExactProviderLayout(paths, options.requireCatalog === true);
  await assertCanonicalInside(paths.providerRoot, paths.resourcesPath, "provider_root");
  await assertCanonicalInside(paths.platformRoot, paths.providerRoot, "platform_root");
  await assertCanonicalInside(paths.executablePath, paths.providerRoot, "provider_executable");
  await assertCanonicalInside(paths.sealPath, paths.providerRoot, "provider_seal");
}

/** Reject extra helpers, downloaders, UIAccess binaries and payload files. */
async function assertExactProviderLayout(paths: CuaDriverResourcePaths, requireCatalog: boolean): Promise<void> {
  const rootEntries = await readDirectoryNames(paths.providerRoot, "provider_root");
  const allowedRoot = new Set(["provider-lock.json", "LICENSE.md", "THIRD_PARTY_NOTICES.md", paths.platformRoot.split(sep).at(-1)!]);
  for (const name of rootEntries) {
    if (!allowedRoot.has(name)) {
      throw new CuaDriverResourcePathError("provider_root_extra_entry", join(paths.providerRoot, name));
    }
  }
  const platformEntries = await readDirectoryNames(paths.platformRoot, "platform_root");
  const platformName = paths.platformRoot.split(sep).at(-1);
  if (platformName === "darwin") {
    const allowed = new Set(["cua-driver", "provider-seal.json"]);
    for (const name of platformEntries) {
      if (!allowed.has(name)) {
        throw new CuaDriverResourcePathError("darwin_provider_extra_entry", join(paths.platformRoot, name));
      }
    }
    return;
  }
  const allowedWindows = new Set(["payload", ...(requireCatalog ? ["provider-integrity.cat"] : [])]);
  for (const name of platformEntries) {
    if (!allowedWindows.has(name)) {
      throw new CuaDriverResourcePathError(
        name === "provider-integrity.cat" ? "unsigned_provider_catalog_forbidden" : "windows_provider_extra_entry",
        join(paths.platformRoot, name),
      );
    }
  }
  const payloadRoot = join(paths.platformRoot, "payload");
  const payloadEntries = await readDirectoryNames(payloadRoot, "provider_payload");
  const allowedPayload = new Set(["cua-driver.exe", "provider-seal.json"]);
  for (const name of payloadEntries) {
    if (!allowedPayload.has(name)) {
      throw new CuaDriverResourcePathError("windows_provider_payload_extra_entry", join(payloadRoot, name));
    }
  }
}

async function readDirectoryNames(path: string, label: string): Promise<readonly string[]> {
  let entries;
  try {
    entries = await readdir(path, { withFileTypes: true });
  } catch {
    throw new CuaDriverResourcePathError(`${label}_read_failed`, path);
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) {
      throw new CuaDriverResourcePathError(`${label}_symlink_forbidden`, join(path, entry.name));
    }
  }
  return entries.map((entry) => entry.name);
}

async function assertRegularNonSymlinkPath(path: string, label: string): Promise<void> {
  let stat;
  try {
    stat = await lstat(path);
  } catch {
    throw new CuaDriverResourcePathError(`${label}_missing`, path);
  }
  if (stat.isSymbolicLink()) {
    throw new CuaDriverResourcePathError(`${label}_symlink_forbidden`, path);
  }
  if (stat.isDirectory()) {
    if (label === "provider_root" || label === "platform_root" || label === "provider_payload") {
      return;
    }
    throw new CuaDriverResourcePathError(`${label}_directory_unexpected`, path);
  }
  if (!stat.isFile()) {
    throw new CuaDriverResourcePathError(`${label}_not_regular`, path);
  }
}

async function assertCanonicalInside(candidate: string, root: string, label: string): Promise<void> {
  let candidateReal: string;
  let rootReal: string;
  try {
    [candidateReal, rootReal] = await Promise.all([realpath(candidate), realpath(root)]);
  } catch {
    throw new CuaDriverResourcePathError(`${label}_realpath_unavailable`, candidate);
  }
  const rel = relative(rootReal, candidateReal);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new CuaDriverResourcePathError(`${label}_canonical_escape`, candidate);
  }
}
