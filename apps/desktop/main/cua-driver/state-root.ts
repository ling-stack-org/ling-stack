import { chmod, lstat, mkdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { BundledCuaDriverPlatform } from "@ling-stack/contracts";

export const CUA_DRIVER_STATE_SCHEMA_VERSION = 1 as const;
export const CUA_DRIVER_STATE_DISTRIBUTION_ID = "0.8.3-ling.1" as const;

export class CuaDriverStateRootError extends Error {
  readonly code = "cua_driver_state_root_invalid" as const;

  constructor(message: string, readonly path?: string) {
    super(message);
    this.name = "CuaDriverStateRootError";
  }
}

export interface CuaDriverStateRoot {
  readonly userDataPath: string;
  readonly rootPath: string;
  readonly telemetryPath: string;
  readonly versionCheckPath: string;
  readonly environment: Readonly<{
    CUA_DRIVER_STATE_HOME: string;
    CUA_DRIVER_TELEMETRY_HOME: string;
  }>;
}

export interface CuaDriverStateRootPlatformProtector {
  /** Windows adapter applies a current-user-only ACL and rejects reparse points. */
  protect(input: {
    readonly userDataPath: string;
    readonly stateRootPath: string;
    readonly createdPaths: readonly string[];
    readonly signal?: AbortSignal;
  }): Promise<void>;
}

export interface CreateCuaDriverStateRootInput {
  readonly userDataPath: string;
  readonly platform: BundledCuaDriverPlatform;
  readonly platformProtector?: CuaDriverStateRootPlatformProtector;
}

export interface ReverifyCuaDriverStateRootInput {
  readonly stateRoot: CuaDriverStateRoot;
  readonly platform: BundledCuaDriverPlatform;
  readonly platformProtector?: CuaDriverStateRootPlatformProtector;
  readonly signal?: AbortSignal;
}

/**
 * Create the version-isolated driver state without changing HOME/USERPROFILE.
 * Every existing path component is lstat-checked before it is followed.
 */
export async function createCuaDriverStateRoot(
  input: CreateCuaDriverStateRootInput,
): Promise<CuaDriverStateRoot> {
  if (!isAbsolute(input.userDataPath)) {
    throw new CuaDriverStateRootError("user_data_path_must_be_absolute", input.userDataPath);
  }
  const userDataPath = resolve(input.userDataPath);
  await assertDirectoryNotLink(userDataPath, "user_data_root");
  const userDataReal = await safeRealpath(userDataPath, "user_data_root");
  const segments = [
    "providers",
    "cua-driver",
    "state",
    `v${CUA_DRIVER_STATE_SCHEMA_VERSION}`,
    CUA_DRIVER_STATE_DISTRIBUTION_ID,
  ] as const;
  const createdPaths: string[] = [];
  let current = userDataPath;
  for (const segment of segments) {
    current = join(current, segment);
    const created = await ensurePrivateDirectory(current);
    if (created) {
      createdPaths.push(current);
    }
  }
  const rootPath = current;
  const telemetryPath = join(rootPath, "telemetry");
  const versionCheckPath = join(rootPath, "version-check");
  for (const path of [telemetryPath, versionCheckPath]) {
    const created = await ensurePrivateDirectory(path);
    if (created) {
      createdPaths.push(path);
    }
  }
  const rootReal = await safeRealpath(rootPath, "state_root");
  assertInsideCanonical(rootReal, userDataReal, "state_root");
  if (input.platform === "win32") {
    if (!input.platformProtector) {
      throw new CuaDriverStateRootError("windows_state_root_protector_required", rootPath);
    }
    await input.platformProtector.protect({ userDataPath, stateRootPath: rootPath, createdPaths });
  } else {
    // Existing directories may predate this run. Reinforce the required mode;
    // provider-created files are separately constrained by the Rust patch.
    await Promise.all([rootPath, telemetryPath, versionCheckPath].map((path) => chmod(path, 0o700)));
  }
  return {
    userDataPath,
    rootPath,
    telemetryPath,
    versionCheckPath,
    environment: Object.freeze({
      CUA_DRIVER_STATE_HOME: rootPath,
      CUA_DRIVER_TELEMETRY_HOME: telemetryPath,
    }),
  };
}

/** Re-check the exact state tree immediately before a lazy provider spawn. */
export async function reverifyCuaDriverStateRoot(
  input: ReverifyCuaDriverStateRootInput,
): Promise<void> {
  input.signal?.throwIfAborted();
  const { stateRoot } = input;
  if (!isAbsolute(stateRoot.userDataPath)) {
    throw new CuaDriverStateRootError("user_data_path_must_be_absolute", stateRoot.userDataPath);
  }
  const userDataPath = resolve(stateRoot.userDataPath);
  const expectedRootPath = resolveCuaDriverStateRootPath(userDataPath);
  const expectedTelemetryPath = join(expectedRootPath, "telemetry");
  const expectedVersionCheckPath = join(expectedRootPath, "version-check");
  if (
    resolve(stateRoot.rootPath) !== expectedRootPath
    || resolve(stateRoot.telemetryPath) !== expectedTelemetryPath
    || resolve(stateRoot.versionCheckPath) !== expectedVersionCheckPath
    || stateRoot.environment.CUA_DRIVER_STATE_HOME !== expectedRootPath
    || stateRoot.environment.CUA_DRIVER_TELEMETRY_HOME !== expectedTelemetryPath
  ) {
    throw new CuaDriverStateRootError("state_root_contract_changed", stateRoot.rootPath);
  }
  const stateAncestors = [
    userDataPath,
    join(userDataPath, "providers"),
    join(userDataPath, "providers", "cua-driver"),
    join(userDataPath, "providers", "cua-driver", "state"),
    join(userDataPath, "providers", "cua-driver", "state", `v${CUA_DRIVER_STATE_SCHEMA_VERSION}`),
    expectedRootPath,
    expectedTelemetryPath,
    expectedVersionCheckPath,
  ];
  for (const path of stateAncestors) {
    input.signal?.throwIfAborted();
    await assertDirectoryNotLink(path, "state_path");
  }
  input.signal?.throwIfAborted();
  const userDataReal = await safeRealpath(userDataPath, "user_data_root");
  input.signal?.throwIfAborted();
  const rootReal = await safeRealpath(expectedRootPath, "state_root");
  input.signal?.throwIfAborted();
  const telemetryReal = await safeRealpath(expectedTelemetryPath, "state_telemetry");
  input.signal?.throwIfAborted();
  const versionCheckReal = await safeRealpath(expectedVersionCheckPath, "state_version_check");
  assertInsideCanonical(rootReal, userDataReal, "state_root");
  assertInsideCanonical(telemetryReal, rootReal, "state_telemetry");
  assertInsideCanonical(versionCheckReal, rootReal, "state_version_check");
  if (input.platform === "win32") {
    if (!input.platformProtector) {
      throw new CuaDriverStateRootError("windows_state_root_protector_required", expectedRootPath);
    }
    input.signal?.throwIfAborted();
    await input.platformProtector.protect({
      userDataPath,
      stateRootPath: expectedRootPath,
      createdPaths: [],
      ...(input.signal ? { signal: input.signal } : {}),
    });
    input.signal?.throwIfAborted();
  } else {
    for (const path of [expectedRootPath, expectedTelemetryPath, expectedVersionCheckPath]) {
      input.signal?.throwIfAborted();
      await chmod(path, 0o700);
    }
    input.signal?.throwIfAborted();
  }
}

export function resolveCuaDriverStateRootPath(userDataPath: string): string {
  if (!isAbsolute(userDataPath)) {
    throw new CuaDriverStateRootError("user_data_path_must_be_absolute", userDataPath);
  }
  return join(
    resolve(userDataPath),
    "providers",
    "cua-driver",
    "state",
    `v${CUA_DRIVER_STATE_SCHEMA_VERSION}`,
    CUA_DRIVER_STATE_DISTRIBUTION_ID,
  );
}

async function ensurePrivateDirectory(path: string): Promise<boolean> {
  let created = false;
  try {
    await lstat(path);
  } catch (error) {
    if (!isNotFound(error)) {
      throw new CuaDriverStateRootError("state_path_lstat_failed", path);
    }
    try {
      await mkdir(path, { mode: 0o700 });
      created = true;
    } catch (mkdirError) {
      if (!isAlreadyExists(mkdirError)) {
        throw new CuaDriverStateRootError("state_path_create_failed", path);
      }
    }
  }
  await assertDirectoryNotLink(path, "state_path");
  return created;
}

async function assertDirectoryNotLink(path: string, label: string): Promise<void> {
  let stat;
  try {
    stat = await lstat(path);
  } catch {
    throw new CuaDriverStateRootError(`${label}_missing`, path);
  }
  if (stat.isSymbolicLink()) {
    throw new CuaDriverStateRootError(`${label}_symlink_forbidden`, path);
  }
  if (!stat.isDirectory()) {
    throw new CuaDriverStateRootError(`${label}_not_directory`, path);
  }
}

async function safeRealpath(path: string, label: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    throw new CuaDriverStateRootError(`${label}_realpath_unavailable`, path);
  }
}

function assertInsideCanonical(candidate: string, root: string, label: string): void {
  const rel = relative(root, candidate);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new CuaDriverStateRootError(`${label}_outside_user_data`, candidate);
  }
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}
