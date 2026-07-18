import { lstat, readdir } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";

import { SigningContractError, normalizeSigningPlatform } from "./signing-contract.mjs";

export const DEFAULT_PROVIDER_REVISION = "0.8.3-ling.1";

/**
 * Locate only the versioned private provider layout emitted by the Desktop
 * packager.  The resolver never consults PATH, a user installation, or a
 * symlink/junction.  A test may pass `providerPath` explicitly, but the path
 * is still canonicalised and checked against the supplied app output root.
 */
export async function resolveProviderLayout(input = {}) {
  const platform = normalizeSigningPlatform(input.platform);
  if (typeof input.appOutDir !== "string" || input.appOutDir.trim() === "") {
    throw new SigningContractError("provider_app_output_root_missing", "appOutDir is required");
  }
  const appOutDir = resolve(input.appOutDir);
  const revision = String(input.providerRevision ?? DEFAULT_PROVIDER_REVISION);
  const explicit = input.providerPath ? resolve(String(input.providerPath)) : undefined;
  const appBundleResourceRoots = platform === "darwin"
    ? await findAppBundleResourceRoots(appOutDir)
    : [];
  const roots = explicit
    ? [explicit]
    : candidateExecutablePaths({ appOutDir, platform, revision, appBundleResourceRoots });

  for (const executablePath of roots) {
    if (!(await isRegularFile(executablePath))) {
      continue;
    }
    const layout = await buildLayout({ appOutDir, platform, revision, executablePath });
    await assertNoUnsafePath(layout);
    return layout;
  }
  return undefined;
}

export async function listProviderPayloadFiles(layout) {
  const files = [];
  const root = layout.payloadRoot;
  if (!(await isDirectory(root))) {
    return files;
  }
  await walkFiles(root, files);
  return files.sort((left, right) => left.localeCompare(right));
}

export function isWithinPath(candidate, root) {
  const relativePath = relative(resolve(root), resolve(candidate));
  return relativePath === "" || (relativePath !== ".." && !relativePath.startsWith(`..${pathSeparator()}`));
}

export function relativeProviderPath(layout, path) {
  return relative(layout.providerRoot, path).replaceAll("\\", "/");
}

async function buildLayout({ appOutDir, platform, revision, executablePath }) {
  const normalizedExecutablePath = resolve(executablePath);
  const isWindows = platform === "win32";
  const payloadRoot = dirname(normalizedExecutablePath);
  const platformRoot = isWindows ? dirname(payloadRoot) : payloadRoot;
  const providerRoot = platformRoot;
  const sealPath = isWindows
    ? join(payloadRoot, "provider-seal.json")
    : join(platformRoot, "provider-seal.json");
  const catalogPath = isWindows ? join(platformRoot, "provider-integrity.cat") : undefined;
  const providerLockPath = join(platformRoot, "..", "provider-lock.json");
  const expectedRoot = resolve(appOutDir);
  if (!isWithinPath(normalizedExecutablePath, expectedRoot)) {
    throw new SigningContractError(
      "provider_path_outside_app_output",
      `Provider path escapes app output: ${normalizedExecutablePath}`,
    );
  }
  const relativeExecutablePath = relative(expectedRoot, normalizedExecutablePath).replaceAll("\\", "/");
  return Object.freeze({
    platform,
    revision,
    appOutDir: expectedRoot,
    providerRoot,
    payloadRoot,
    executablePath: normalizedExecutablePath,
    sealPath,
    catalogPath,
    providerLockPath,
    relativeExecutablePath,
    relativeSealPath: relative(expectedRoot, sealPath).replaceAll("\\", "/"),
    relativeCatalogPath: catalogPath
      ? relative(expectedRoot, catalogPath).replaceAll("\\", "/")
      : undefined,
    executableName: basename(normalizedExecutablePath),
  });
}

function candidateExecutablePaths({ appOutDir, platform, revision, appBundleResourceRoots }) {
  const resourceRoots = [
    ...appBundleResourceRoots,
    join(appOutDir, "resources"),
    join(appOutDir, "Contents", "Resources"),
    appOutDir,
  ];
  if (platform === "win32") {
    return resourceRoots.map((root) =>
      join(root, "providers", "cua-driver", revision, "win32-x64", "payload", "cua-driver.exe"),
    );
  }
  return resourceRoots.map((root) =>
    join(root, "providers", "cua-driver", revision, "darwin", "cua-driver"),
  );
}

async function findAppBundleResourceRoots(appOutDir) {
  try {
    return (await readdir(appOutDir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && entry.name.endsWith(".app"))
      .map((entry) => join(appOutDir, entry.name, "Contents", "Resources"))
      .sort();
  } catch (error) {
    if (error?.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

async function assertNoUnsafePath(layout) {
  const chain = pathChain(layout.appOutDir, layout.executablePath);
  for (const path of chain) {
    let stats;
    try {
      stats = await lstat(path);
    } catch (error) {
      if (error?.code === "ENOENT") {
        continue;
      }
      throw error;
    }
    if (stats.isSymbolicLink()) {
      throw new SigningContractError(
        "provider_symlink_not_allowed",
        `Provider path contains a symlink: ${path}`,
      );
    }
  }
}

function pathChain(root, target) {
  const chain = [];
  let current = resolve(target);
  const stop = resolve(root);
  while (isWithinPath(current, stop)) {
    chain.push(current);
    if (current === stop) {
      break;
    }
    const parent = dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  return chain.reverse();
}

async function isRegularFile(path) {
  try {
    const stats = await lstat(path);
    return stats.isFile() && !stats.isSymbolicLink();
  } catch (error) {
    if (error?.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function isDirectory(path) {
  try {
    const stats = await lstat(path);
    return stats.isDirectory() && !stats.isSymbolicLink();
  } catch (error) {
    if (error?.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function walkFiles(root, result) {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isSymbolicLink()) {
      throw new SigningContractError(
        "provider_payload_symlink_not_allowed",
        `Provider payload contains a symlink: ${path}`,
      );
    }
    if (entry.isDirectory()) {
      await walkFiles(path, result);
    } else if (entry.isFile()) {
      result.push(path);
    } else {
      throw new SigningContractError(
        "provider_payload_entry_invalid",
        `Provider payload contains a non-regular entry: ${path}`,
      );
    }
  }
}

function pathSeparator() {
  return process.platform === "win32" ? "\\" : "/";
}
