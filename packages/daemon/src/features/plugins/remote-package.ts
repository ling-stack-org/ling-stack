import { createHash, randomUUID, verify } from "node:crypto";
import { comparePluginVersions } from "@ling-stack/contracts";
import { lstat, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import JSZip from "jszip";
import { resolveUserConfigPaths, type LingStackRuntimePaths, type ManagedPluginStoreFacet } from "@ling-stack/core";
import {
  isOfficialNativePluginId,
  OFFICIAL_PLUGIN_ARTIFACT_PUBLIC_KEY,
  officialPluginRuntimePointerPath,
  pluginPackageCacheDir,
  usesHostPluginCache,
  verifyOfficialRuntimeChecksumSignature,
} from "@ling-stack/core/official-plugin-runtime";
import {
  validateLingPluginArtifactDescriptor,
  type LingPluginArtifactDescriptor,
} from "@ling-stack/plugin-sdk";
import { loadPluginPackageFromRoot, type LoadedPluginPackage } from "./manifest.js";
import { downloadPluginBytes, isOfficialPluginReleaseUrl } from "./plugin-download.js";

const DEFAULT_MAX_PACKAGE_BYTES = 1024 * 1024 * 1024;
const pointerWrites = new Map<string, Promise<unknown>>();

export interface RemotePluginInstallInput {
  readonly paths: LingStackRuntimePaths;
  readonly artifact: LingPluginArtifactDescriptor;
  readonly catalogVersion: string;
  readonly lingVersion: string;
  readonly now: string;
  readonly fetchImpl?: typeof fetch;
  readonly maxPackageBytes?: number;
  readonly artifactPublicKey?: string;
  readonly requireArtifactSignature?: boolean;
}

export interface RemotePluginInstallResult {
  readonly plugin: LoadedPluginPackage;
  readonly packageRoot: string;
  readonly cacheRef: string;
  readonly packageHash: string;
  readonly previousVersion?: string;
  readonly sourceUrl: string;
  readonly artifactId: string;
  readonly platform: LingPluginArtifactDescriptor["platform"];
  readonly arch: LingPluginArtifactDescriptor["arch"];
}

export interface RemotePluginPointer {
  readonly pluginId: string;
  readonly version: string;
  readonly cacheRef?: string;
  readonly packageHash?: string;
  readonly catalogVersion?: string;
  readonly updatedAt?: string;
  readonly artifactId?: string;
  readonly platform?: LingPluginArtifactDescriptor["platform"];
  readonly arch?: LingPluginArtifactDescriptor["arch"];
  readonly sourceUrl?: string;
  readonly runtimeChecksumSignature?: string;
}

interface RemotePluginSelection extends RemotePluginPointer {
  readonly previous?: RemotePluginPointer;
}

/**
 * Downloads and installs one catalog-selected package without executing any
 * package content. The package becomes visible only after all checks pass and
 * the current pointer is atomically replaced.
 */
export async function installRemotePluginArtifact(input: RemotePluginInstallInput): Promise<RemotePluginInstallResult> {
  validateLingPluginArtifactDescriptor(input.artifact);
  assertCompatibleVersion(input.artifact, input.lingVersion);

  const maxBytes = input.maxPackageBytes ?? DEFAULT_MAX_PACKAGE_BYTES;
  if (input.artifact.sizeBytes > maxBytes) throw new Error("Plugin package exceeds the configured size limit.");
  const localBytes = await readLocalDevArtifact(input.artifact.url, maxBytes);
  const bytes = localBytes ?? await downloadPluginBytes({
    url: input.artifact.url,
    maxBytes,
    timeoutMs: 120_000,
    label: "Plugin package",
    fetchImpl: input.fetchImpl,
  });

  const packageHash = createHash("sha256").update(bytes).digest("hex");
  if (packageHash !== input.artifact.sha256) {
    throw new Error("Plugin package SHA-256 verification failed.");
  }
  if (bytes.length !== input.artifact.sizeBytes) {
    throw new Error("Plugin package size does not match the catalog artifact.");
  }
  const artifactPublicKey = input.artifactPublicKey
    ?? process.env.LING_PLUGIN_ARTIFACT_PUBLIC_KEY
    ?? ((input.requireArtifactSignature || (!localBytes && isOfficialPluginReleaseUrl(input.artifact.url)))
      ? OFFICIAL_PLUGIN_ARTIFACT_PUBLIC_KEY
      : undefined);
  if (artifactPublicKey) {
    if (!input.artifact.signature) throw new Error("Plugin package signature is required but missing.");
    const encoded = input.artifact.signature.replace(/^ed25519:/u, "");
    const signature = Buffer.from(encoded, "base64");
    if (signature.length !== 64) throw new Error("Plugin package signature is invalid.");
    if (!verify(null, bytes, artifactPublicKey, signature)) {
      throw new Error("Plugin package signature verification failed.");
    }
  }

  const { pluginId, runtimeChecksumSignature } = input.artifact;
  const hostCache = runtimeChecksumSignature !== undefined;
  if (hostCache && (!isOfficialNativePluginId(pluginId) || !artifactPublicKey)) {
    throw new Error("Native plugin runtime requires an official artifact signature.");
  }
  const packageName = packageNameFromPluginId(pluginId);
  const cacheRef = `${hostCache ? "host/" : ""}official-remote/${packageName}/${input.artifact.version}/${input.artifact.platform}/${input.artifact.arch}/${packageHash.slice(0, 12)}`;
  const cacheDir = pluginPackageCacheDir(input.paths, cacheRef);
  const packageRoot = join(cacheDir, cacheRef);
  const stagingRoot = join(cacheDir, ".staging", `${packageName}-${process.pid}-${Date.parse(input.now)}-${randomUUID()}`);
  await rm(stagingRoot, { recursive: true, force: true });
  await mkdir(stagingRoot, { recursive: true });

  try {
    await extractZipSafely(bytes, stagingRoot, maxBytes);
    await verifyPackageIntegrity(stagingRoot, input.artifact);
    const stagedPlugin = loadPluginPackageFromRoot(stagingRoot);
    assertRemoteManifest(stagedPlugin, input.artifact);
    if (runtimeChecksumSignature) {
      const checksums = await readFile(join(stagingRoot, ".ling-plugin", "checksums.json"));
      if (!verifyOfficialRuntimeChecksumSignature(checksums, runtimeChecksumSignature, artifactPublicKey)) {
        throw new Error("Official plugin runtime checksum signature is invalid.");
      }
    }

    const pointerPath = pluginPointerPath(cacheDir, pluginId, cacheRef, "current");
    const { previousVersion, plugin } = await withPointerWrite(pointerPath, async () => {
      await mkdir(dirname(packageRoot), { recursive: true });
      if (!(await pathExists(packageRoot))) {
        await rename(stagingRoot, packageRoot).catch(async (error: NodeJS.ErrnoException) => {
          if (error.code !== "EEXIST" && error.code !== "ENOTEMPTY") throw error;
          await verifyPackageIntegrity(packageRoot, input.artifact);
        });
      } else {
        await verifyPackageIntegrity(packageRoot, input.artifact);
      }
      if (runtimeChecksumSignature) {
        const checksums = await readFile(join(packageRoot, ".ling-plugin", "checksums.json"));
        if (!verifyOfficialRuntimeChecksumSignature(checksums, runtimeChecksumSignature, artifactPublicKey)) {
          throw new Error("Cached official plugin runtime checksum signature is invalid.");
        }
      }
      const plugin = loadPluginPackageFromRoot(packageRoot);
      assertRemoteManifest(plugin, input.artifact);

      const selection = await readPointer(pointerPath);
      const previous = selection?.cacheRef !== cacheRef
        ? selection && withoutPrevious(selection)
        : await readPreviousPointer(cacheDir, pluginId, cacheRef, selection);
      const pointer: RemotePluginSelection = {
        pluginId,
        version: input.artifact.version,
        cacheRef,
        packageHash,
        artifactId: input.artifact.artifactId,
        platform: input.artifact.platform,
        arch: input.artifact.arch,
        sourceUrl: input.artifact.url,
        catalogVersion: input.catalogVersion,
        updatedAt: input.now,
        runtimeChecksumSignature,
        previous,
      };
      await writePointer(pointerPath, pointer);
      return { previousVersion: previous?.version, plugin };
    });

    return {
      plugin,
      packageRoot,
      cacheRef,
      packageHash,
      previousVersion,
      sourceUrl: input.artifact.url,
      artifactId: input.artifact.artifactId,
      platform: input.artifact.platform,
      arch: input.artifact.arch,
    };
  } finally {
    await rm(stagingRoot, { recursive: true, force: true });
  }
}

async function readLocalDevArtifact(url: string, maxBytes: number): Promise<Buffer | undefined> {
  const catalogFile = process.env.LING_PLUGIN_CATALOG_FILE;
  const root = process.env.LING_PLUGIN_ARTIFACT_DIR
    ?? (catalogFile ? join(dirname(catalogFile), "dist") : undefined);
  if (!catalogFile || !root || !url.includes("/releases/download/local-dev/")) return undefined;
  const file = join(root, basename(new URL(url).pathname));
  let info;
  try {
    info = await lstat(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  if (!info.isFile() || info.size > maxBytes) throw new Error("Invalid local plugin artifact.");
  return readFile(file);
}

export async function readCurrentPluginPointer(paths: LingStackRuntimePaths, pluginId: string): Promise<RemotePluginPointer | undefined> {
  if (isOfficialNativePluginId(pluginId)) {
    const native = await readPointer(officialPluginRuntimePointerPath(resolveUserConfigPaths().pluginCacheDir, pluginId, "current"));
    if (native) return native;
  }
  return readPointer(pluginPointerPath(paths.pluginCacheDir, pluginId, undefined, "current"));
}

/** Project the verified host selection into a workspace's distribution state. */
export async function syncOfficialNativePluginPackage(
  store: ManagedPluginStoreFacet,
  pluginId: string,
  lingVersion: string,
  now: string,
): Promise<void> {
  if (!isOfficialNativePluginId(pluginId)) return;
  const cacheDir = resolveUserConfigPaths().pluginCacheDir;
  const pointerPath = officialPluginRuntimePointerPath(cacheDir, pluginId, "current");
  await withPointerWrite(pointerPath, async () => {
    const selected = await readPointer(pointerPath);
    if (!selected || selected.pluginId !== pluginId || selected.platform !== process.platform
      || selected.arch !== process.arch || !selected.runtimeChecksumSignature
      || !selected.packageHash || !/^[a-f0-9]{64}$/u.test(selected.packageHash)
      || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(selected.version)) return;
    const cacheRef = `host/official-remote/${packageNameFromPluginId(pluginId)}/${selected.version}/${selected.platform}/${selected.arch}/${selected.packageHash.slice(0, 12)}`;
    if (selected.cacheRef !== cacheRef) return;
    const previousVersion = selected.previous?.version;
    const existing = store.getManagedPluginPackage(pluginId);
    if (existing?.status === "uninstalled"
      || (existing?.cacheRef === cacheRef && existing.previousVersion === previousVersion)) return;

    const packageRoot = join(cacheDir, cacheRef);
    let plugin;
    try {
      const checksums = await readFile(join(packageRoot, ".ling-plugin", "checksums.json"));
      if (!verifyOfficialRuntimeChecksumSignature(checksums, selected.runtimeChecksumSignature,
        process.env.LING_PLUGIN_ARTIFACT_PUBLIC_KEY)) return;
      await verifyPackageIntegrity(packageRoot, selected);
      plugin = loadPluginPackageFromRoot(packageRoot);
      if (!plugin.validation.ok || plugin.id !== pluginId || plugin.manifest.sourceKind !== "official-remote"
        || plugin.manifest.version !== selected.version || plugin.manifest.artifactId !== selected.artifactId
        || plugin.manifest.platform !== selected.platform || plugin.manifest.arch !== selected.arch) return;
      assertCompatibleVersion(plugin.manifest, lingVersion);
    } catch {
      // A failed cache check must leave the workspace's package and activation records available.
      return;
    }
    store.upsertManagedPluginPackage({
      pluginId, sourceKind: "official-remote", version: selected.version, status: "installed",
      cacheRef, packageHash: selected.packageHash, manifestJson: JSON.stringify(plugin.manifest),
      artifactId: selected.artifactId, platform: selected.platform, arch: selected.arch,
      sourceUrl: selected.sourceUrl, catalogVersion: selected.catalogVersion, previousVersion,
    }, now);
  });
}

export async function rollbackRemotePluginArtifact(input: {
  readonly paths: LingStackRuntimePaths;
  readonly pluginId: string;
  readonly now: string;
  readonly cacheRef?: string;
  readonly lingVersion?: string;
}): Promise<{ readonly pointer: RemotePluginPointer; readonly packageRoot: string; readonly plugin: LoadedPluginPackage }> {
  const cacheDir = pluginPackageCacheDir(input.paths, input.cacheRef);
  const currentPath = pluginPointerPath(cacheDir, input.pluginId, input.cacheRef, "current");
  return withPointerWrite(currentPath, async () => {
    const current = await readPointer(currentPath);
    const rollbackPointer = await readPreviousPointer(cacheDir, input.pluginId, input.cacheRef, current);
    return applyPluginRollback(input, cacheDir, currentPath, current, rollbackPointer);
  });
}

async function applyPluginRollback(
  input: Parameters<typeof rollbackRemotePluginArtifact>[0],
  cacheDir: string,
  currentPath: string,
  current: RemotePluginSelection | undefined,
  rollbackPointer: RemotePluginPointer | undefined,
) {
  if (!rollbackPointer?.cacheRef) throw new Error("No previous plugin version is available for rollback.");
  const expectedRef = `${usesHostPluginCache(input.cacheRef) ? "host/" : ""}official-remote/${packageNameFromPluginId(input.pluginId)}/${rollbackPointer.version}/${rollbackPointer.platform}/${rollbackPointer.arch}/${rollbackPointer.packageHash?.slice(0, 12)}`;
  const packageRoot = resolve(cacheDir, rollbackPointer.cacheRef);
  if (rollbackPointer.pluginId !== input.pluginId || rollbackPointer.cacheRef !== expectedRef || !isPathInside(cacheDir, packageRoot)) {
    throw new Error("Invalid previous plugin cache identity.");
  }
  if (!(await pathExists(packageRoot))) throw new Error("The previous plugin package is no longer present in the local cache.");
  await verifyPackageIntegrity(packageRoot, rollbackPointer);
  if (usesHostPluginCache(input.cacheRef)) {
    const checksums = await readFile(join(packageRoot, ".ling-plugin", "checksums.json"));
    if (!rollbackPointer.runtimeChecksumSignature || !verifyOfficialRuntimeChecksumSignature(
      checksums, rollbackPointer.runtimeChecksumSignature, process.env.LING_PLUGIN_ARTIFACT_PUBLIC_KEY,
    )) throw new Error("Previous plugin runtime checksum signature is invalid.");
  }
  const plugin = loadPluginPackageFromRoot(packageRoot);
  if (!plugin.validation.ok || plugin.manifest.sourceKind !== "official-remote"
    || plugin.id !== input.pluginId || plugin.manifest.version !== rollbackPointer.version
    || plugin.manifest.artifactId !== rollbackPointer.artifactId
    || plugin.manifest.platform !== rollbackPointer.platform || plugin.manifest.arch !== rollbackPointer.arch
    || (current && (current.platform !== rollbackPointer.platform || current.arch !== rollbackPointer.arch))) {
    throw new Error("The previous plugin package no longer passes validation.");
  }
  if (input.lingVersion) assertCompatibleVersion(plugin.manifest, input.lingVersion);
  if (plugin.manifest.rollbackAllowed === false) throw new Error("This plugin package does not allow rollback.");
  const pointer = { ...withoutPrevious(rollbackPointer), updatedAt: input.now };
  await writePointer(currentPath, { ...pointer, previous: current && withoutPrevious(current) });
  return { pointer, packageRoot, plugin };
}

function withoutPrevious({ previous: _previous, ...pointer }: RemotePluginSelection): RemotePluginPointer {
  return pointer;
}

async function readPreviousPointer(
  cacheDir: string, pluginId: string, cacheRef: string | undefined, selection: RemotePluginSelection | undefined,
): Promise<RemotePluginPointer | undefined> {
  return selection?.previous ?? readPointer(pluginPointerPath(cacheDir, pluginId, cacheRef, "rollback"));
}

async function withPointerWrite<T>(path: string, operation: () => Promise<T>): Promise<T> {
  const pending = pointerWrites.get(path);
  const next = (pending ? pending.catch(() => undefined) : Promise.resolve()).then(operation);
  pointerWrites.set(path, next);
  try {
    return await next;
  } finally {
    if (pointerWrites.get(path) === next) pointerWrites.delete(path);
  }
}

async function extractZipSafely(bytes: Buffer, destination: string, maxBytes: number): Promise<void> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes, { checkCRC32: true, createFolders: false });
  } catch (error) {
    throw new Error(`Plugin package is not a valid zip: ${error instanceof Error ? error.message : String(error)}`);
  }
  let extractedBytes = 0;
  for (const [entryName, entry] of Object.entries(zip.files)) {
    const normalized = normalizeZipEntry(entry.unsafeOriginalName ?? entryName);
    if (!normalized) continue;
    const target = resolve(destination, normalized);
    if (!isPathInside(destination, target)) throw new Error("Plugin package contains a path traversal entry.");
    if (entry.dir) {
      await mkdir(target, { recursive: true });
      continue;
    }
    const data = await entry.async("nodebuffer");
    extractedBytes += data.length;
    if (extractedBytes > maxBytes) throw new Error("Plugin package expands beyond the configured size limit.");
    await mkdir(dirname(target), { recursive: true });
    const mode = typeof entry.unixPermissions === "number" ? entry.unixPermissions : 0;
    const type = mode & 0o170000;
    if (type !== 0 && type !== 0o100000) throw new Error("Plugin package contains a non-regular file.");
    await writeFile(target, data, { flag: "wx", mode: mode & 0o100 ? 0o700 : 0o600 });
  }
}

function normalizeZipEntry(entryName: string): string {
  if (entryName.includes("\\") || isAbsolute(entryName)) throw new Error("Plugin package contains an unsafe path.");
  const normalized = entryName.replace(/^\.\//u, "").replace(/\/+$/u, "");
  if (!normalized) return "";
  const segments = normalized.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error("Plugin package contains an unsafe path.");
  }
  return normalized;
}

function assertRemoteManifest(plugin: LoadedPluginPackage, artifact: LingPluginArtifactDescriptor): void {
  if (!plugin.validation.ok) {
    throw new Error(`Plugin package validation failed: ${plugin.validation.errors.join("; ")}`);
  }
  if (plugin.manifest.sourceKind !== "official-remote") throw new Error("Remote plugin packages must use sourceKind official-remote.");
  if (plugin.id !== artifact.pluginId || plugin.manifest.version !== artifact.version) {
    throw new Error("Plugin package identity does not match the catalog artifact.");
  }
  if (plugin.manifest.artifactId !== artifact.artifactId || plugin.manifest.platform !== artifact.platform || plugin.manifest.arch !== artifact.arch) {
    throw new Error("Plugin package platform or artifact identity does not match the catalog artifact.");
  }
  if (plugin.manifest.manifestVersion !== 2) {
    throw new Error("Official remote plugin packages must use manifest version 2.");
  }
}

async function verifyPackageIntegrity(packageRoot: string, artifact: { readonly artifactId?: string }): Promise<void> {
  const root = await lstat(packageRoot);
  if (!root.isDirectory()) throw new Error("Plugin package must be a regular directory.");
  const actualFiles = await listPackageFiles(packageRoot);
  const files = new Set(actualFiles);
  const metadataRoot = join(packageRoot, ".ling-plugin");
  let checksums: { readonly algorithm?: string; readonly files?: Record<string, string> };
  let provenance: { readonly schemaVersion?: number; readonly artifactId?: string };
  try {
    checksums = JSON.parse(await readFile(join(metadataRoot, "checksums.json"), "utf8")) as typeof checksums;
    provenance = JSON.parse(await readFile(join(metadataRoot, "provenance.json"), "utf8")) as typeof provenance;
  } catch (error) {
    throw new Error(`Plugin package integrity metadata is missing or invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (checksums.algorithm !== "sha256" || !checksums.files || typeof checksums.files !== "object" || Array.isArray(checksums.files)) {
    throw new Error("Plugin package checksums.json must declare sha256 file digests.");
  }
  if (provenance.schemaVersion !== 1 || (artifact.artifactId !== undefined && provenance.artifactId !== artifact.artifactId)) {
    throw new Error("Plugin package provenance does not match the catalog artifact.");
  }
  for (const [relativePath, expectedHash] of Object.entries(checksums.files)) {
    if (!isSafePackageRelativePath(relativePath) || !/^[a-f0-9]{64}$/u.test(expectedHash)) {
      throw new Error("Plugin package checksums.json contains an unsafe path or digest.");
    }
    if (!files.has(relativePath)) throw new Error(`Plugin package checksum entry is missing: ${relativePath}`);
    const filePath = resolve(packageRoot, relativePath);
    if (!isPathInside(packageRoot, filePath)) throw new Error("Plugin package checksums path escapes the package root.");
    let bytes: Buffer;
    try {
      bytes = await readFile(filePath);
    } catch {
      throw new Error(`Plugin package checksum entry is missing: ${relativePath}`);
    }
    const actualHash = createHash("sha256").update(bytes).digest("hex");
    if (actualHash !== expectedHash) throw new Error(`Plugin package file checksum verification failed: ${relativePath}`);
  }
  if (!checksums.files[".ling-plugin/plugin.json"]) {
    throw new Error("Plugin package checksums.json must cover .ling-plugin/plugin.json.");
  }
  for (const relativePath of actualFiles) {
    if (relativePath === ".ling-plugin/checksums.json" || relativePath === ".ling-plugin/provenance.json") continue;
    if (!Object.prototype.hasOwnProperty.call(checksums.files, relativePath)) {
      throw new Error(`Plugin package file is not covered by checksums.json: ${relativePath}`);
    }
  }
}

async function listPackageFiles(root: string, current = ""): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(resolve(root, current), { withFileTypes: true })) {
    const relativePath = current ? `${current}/${entry.name}` : entry.name;
    if (entry.isDirectory()) result.push(...await listPackageFiles(root, relativePath));
    else if (entry.isFile()) result.push(relativePath);
    else throw new Error(`Plugin package contains a non-regular file: ${relativePath}`);
  }
  return result;
}

function isSafePackageRelativePath(value: string): boolean {
  if (!value || value.includes("\\") || isAbsolute(value)) return false;
  const segments = value.split("/");
  return segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

function assertCompatibleVersion(artifact: Pick<LingPluginArtifactDescriptor, "minLingVersion" | "maxLingVersion">, lingVersion: string): void {
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(lingVersion)) throw new Error("Current Ling version is not semver-compatible.");
  if (artifact.minLingVersion && comparePluginVersions(lingVersion, artifact.minLingVersion) < 0) throw new Error("Plugin requires a newer Ling version.");
  if (artifact.maxLingVersion && comparePluginVersions(lingVersion, artifact.maxLingVersion) > 0) throw new Error("Plugin does not support this Ling version.");
}

async function writePointer(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

function pluginPointerPath(cacheDir: string, pluginId: string, cacheRef: string | undefined, pointer: "current" | "rollback"): string {
  if (usesHostPluginCache(cacheRef) && isOfficialNativePluginId(pluginId)) {
    return officialPluginRuntimePointerPath(cacheDir, pluginId, pointer);
  }
  return join(cacheDir, pointer, `${packageNameFromPluginId(pluginId)}.json`);
}

async function readPointer(path: string): Promise<RemotePluginSelection | undefined> {
  try {
    const pointer = JSON.parse(await readFile(path, "utf8")) as RemotePluginSelection;
    return typeof pointer.pluginId === "string" && typeof pointer.version === "string" ? pointer : undefined;
  } catch {
    return undefined;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try { await stat(path); return true; } catch { return false; }
}

function packageNameFromPluginId(pluginId: string): string {
  return pluginId.replace(/:/g, "-").replace(/[^a-zA-Z0-9._-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "") || "plugin";
}

function isPathInside(root: string, target: string): boolean {
  const relativePath = relative(root, target);
  return relativePath === "" || (relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath));
}
