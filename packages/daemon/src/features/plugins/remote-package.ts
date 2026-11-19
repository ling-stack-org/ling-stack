import { createHash, randomUUID, verify } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import JSZip from "jszip";
import type { LingStackRuntimePaths } from "@ling-stack/core";
import {
  validateLingPluginArtifactDescriptor,
  type LingPluginArtifactDescriptor,
} from "@ling-stack/plugin-sdk";
import { loadPluginPackageFromRoot, type LoadedPluginPackage } from "./manifest.js";
import { DEFAULT_PLUGIN_CATALOG_URL } from "./remote-catalog.js";

const DEFAULT_PLUGIN_ARTIFACT_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAzc6EyHekMm92MzFte3V2PxzAkaDtSNpJxkpiHqjjiZQ=
-----END PUBLIC KEY-----`;

const DEFAULT_MAX_PACKAGE_BYTES = 1024 * 1024 * 1024;

export interface RemotePluginInstallInput {
  readonly paths: LingStackRuntimePaths;
  readonly artifact: LingPluginArtifactDescriptor;
  readonly catalogVersion: string;
  readonly lingVersion: string;
  readonly now: string;
  readonly fetchImpl?: typeof fetch;
  readonly maxPackageBytes?: number;
  readonly artifactPublicKey?: string;
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
}

/**
 * Downloads and installs one catalog-selected package without executing any
 * package content. The package becomes visible only after all checks pass and
 * the current pointer is atomically replaced.
 */
export async function installRemotePluginArtifact(input: RemotePluginInstallInput): Promise<RemotePluginInstallResult> {
  validateLingPluginArtifactDescriptor(input.artifact);
  assertCompatibleVersion(input.artifact, input.lingVersion);

  const fetcher = input.fetchImpl ?? fetch;
  const response = await readLocalDevArtifact(input.artifact.url) ?? await fetcher(input.artifact.url, { redirect: "error" });
  if (!response.ok) {
    throw new Error(`Plugin download failed with HTTP ${response.status}.`);
  }
  const contentLength = Number(response.headers.get("content-length") ?? "0");
  const maxBytes = input.maxPackageBytes ?? DEFAULT_MAX_PACKAGE_BYTES;
  if (contentLength > maxBytes) throw new Error("Plugin package exceeds the configured size limit.");
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length === 0) throw new Error("Plugin package download was empty.");
  if (bytes.length > maxBytes) throw new Error("Plugin package exceeds the configured size limit.");

  const packageHash = createHash("sha256").update(bytes).digest("hex");
  if (packageHash !== input.artifact.sha256) {
    throw new Error("Plugin package SHA-256 verification failed.");
  }
  const artifactPublicKey = input.artifactPublicKey
    ?? process.env.LING_PLUGIN_ARTIFACT_PUBLIC_KEY
    ?? (input.artifact.url.startsWith("https://github.com/ling-stack-org/ling-stack/releases/")
      ? DEFAULT_PLUGIN_ARTIFACT_PUBLIC_KEY
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

  const packageName = packageNameFromPluginId(input.artifact.pluginId);
  const cacheRef = `official-remote/${packageName}/${input.artifact.version}/${input.artifact.platform}/${input.artifact.arch}/${packageHash.slice(0, 12)}`;
  const packageRoot = join(input.paths.pluginCacheDir, cacheRef);
  const stagingRoot = join(input.paths.pluginCacheDir, ".staging", `${packageName}-${process.pid}-${Date.parse(input.now)}-${randomUUID()}`);
  await rm(stagingRoot, { recursive: true, force: true });
  await mkdir(stagingRoot, { recursive: true });

  try {
    await extractZipSafely(bytes, stagingRoot, maxBytes);
    await verifyPackageIntegrity(stagingRoot, input.artifact);
    const stagedPlugin = loadPluginPackageFromRoot(stagingRoot);
    assertRemoteManifest(stagedPlugin, input.artifact);

    await mkdir(dirname(packageRoot), { recursive: true });
    if (!(await pathExists(packageRoot))) {
      await rename(stagingRoot, packageRoot);
    } else {
      await rm(stagingRoot, { recursive: true, force: true });
    }

    const pointerPath = join(input.paths.pluginCacheDir, "current", `${packageName}.json`);
    const previousPointer = await readCurrentPluginPointer(input.paths, input.artifact.pluginId);
    const previousVersion = previousPointer?.version;
    if (previousVersion && previousVersion !== input.artifact.version) {
      await writePointer(join(input.paths.pluginCacheDir, "rollback", `${packageName}.json`), previousPointer);
    }
    await writePointer(pointerPath, {
      pluginId: input.artifact.pluginId,
      version: input.artifact.version,
      cacheRef,
      packageHash,
      artifactId: input.artifact.artifactId,
      platform: input.artifact.platform,
      arch: input.artifact.arch,
      sourceUrl: input.artifact.url,
      catalogVersion: input.catalogVersion,
      updatedAt: input.now,
    });

    const plugin = loadPluginPackageFromRoot(packageRoot);
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
  } catch (error) {
    await rm(stagingRoot, { recursive: true, force: true });
    throw error;
  }
}

async function readLocalDevArtifact(url: string): Promise<Response | undefined> {
  const catalogFile = process.env.LING_PLUGIN_CATALOG_FILE;
  const root = process.env.LING_PLUGIN_ARTIFACT_DIR
    ?? (catalogFile ? join(dirname(catalogFile), "dist") : undefined);
  if (!root || !url.includes("/releases/download/local-dev/")) return undefined;
  const file = join(root, basename(new URL(url).pathname));
  try {
    const bytes = await readFile(file);
    return new Response(bytes, { status: 200, headers: { "content-length": String(bytes.length) } });
  } catch {
    return undefined;
  }
}

export async function readCurrentPluginPointer(paths: LingStackRuntimePaths, pluginId: string): Promise<RemotePluginPointer | undefined> {
  const path = join(paths.pluginCacheDir, "current", `${packageNameFromPluginId(pluginId)}.json`);
  try {
    return JSON.parse(await readFile(path, "utf8")) as RemotePluginPointer;
  } catch {
    return undefined;
  }
}

export async function rollbackRemotePluginArtifact(input: {
  readonly paths: LingStackRuntimePaths;
  readonly pluginId: string;
  readonly now: string;
}): Promise<{ readonly pointer: RemotePluginPointer; readonly packageRoot: string; readonly plugin: LoadedPluginPackage }> {
  const packageName = packageNameFromPluginId(input.pluginId);
  const rollbackPath = join(input.paths.pluginCacheDir, "rollback", `${packageName}.json`);
  const rollbackPointer = await readPointer(rollbackPath);
  if (!rollbackPointer?.cacheRef) throw new Error("No previous plugin version is available for rollback.");
  const packageRoot = join(input.paths.pluginCacheDir, rollbackPointer.cacheRef);
  if (!(await pathExists(packageRoot))) throw new Error("The previous plugin package is no longer present in the local cache.");
  await verifyCachedPackageIntegrity(packageRoot, rollbackPointer.artifactId);
  const plugin = loadPluginPackageFromRoot(packageRoot);
  if (!plugin.validation.ok || plugin.manifest.sourceKind !== "official-remote") throw new Error("The previous plugin package no longer passes validation.");
  if (plugin.manifest.rollbackAllowed === false) throw new Error("This plugin package does not allow rollback.");
  const currentPath = join(input.paths.pluginCacheDir, "current", `${packageName}.json`);
  const currentPointer = await readPointer(currentPath);
  if (currentPointer) await writePointer(rollbackPath, currentPointer);
  await writePointer(currentPath, { ...rollbackPointer, updatedAt: input.now });
  return { pointer: { ...rollbackPointer, updatedAt: input.now }, packageRoot, plugin };
}

async function verifyCachedPackageIntegrity(packageRoot: string, artifactId?: string): Promise<void> {
  const metadataRoot = join(packageRoot, ".ling-plugin");
  const checksums = JSON.parse(await readFile(join(metadataRoot, "checksums.json"), "utf8")) as { algorithm?: string; files?: Record<string, string> };
  const provenance = JSON.parse(await readFile(join(metadataRoot, "provenance.json"), "utf8")) as { schemaVersion?: number; artifactId?: string };
  if (checksums.algorithm !== "sha256" || !checksums.files || provenance.schemaVersion !== 1 || (artifactId && provenance.artifactId !== artifactId)) {
    throw new Error("Cached plugin integrity metadata is invalid.");
  }
  for (const [relativePath, expectedHash] of Object.entries(checksums.files)) {
    if (!isSafePackageRelativePath(relativePath) || !/^[a-f0-9]{64}$/u.test(expectedHash)) throw new Error("Cached plugin checksum metadata is invalid.");
    const actualHash = createHash("sha256").update(await readFile(resolve(packageRoot, relativePath))).digest("hex");
    if (actualHash !== expectedHash) throw new Error(`Cached plugin checksum verification failed: ${relativePath}`);
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
    const normalized = normalizeZipEntry(entryName);
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
    await writeFile(target, data, { flag: "wx" });
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

async function verifyPackageIntegrity(packageRoot: string, artifact: LingPluginArtifactDescriptor): Promise<void> {
  const metadataRoot = join(packageRoot, ".ling-plugin");
  let checksums: { readonly algorithm?: string; readonly files?: Record<string, string> };
  let provenance: { readonly schemaVersion?: number; readonly artifactId?: string };
  try {
    checksums = JSON.parse(await readFile(join(metadataRoot, "checksums.json"), "utf8")) as typeof checksums;
    provenance = JSON.parse(await readFile(join(metadataRoot, "provenance.json"), "utf8")) as typeof provenance;
  } catch (error) {
    throw new Error(`Plugin package integrity metadata is missing or invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (checksums.algorithm !== "sha256" || !checksums.files || typeof checksums.files !== "object") {
    throw new Error("Plugin package checksums.json must declare sha256 file digests.");
  }
  if (provenance.schemaVersion !== 1 || provenance.artifactId !== artifact.artifactId) {
    throw new Error("Plugin package provenance does not match the catalog artifact.");
  }
  for (const [relativePath, expectedHash] of Object.entries(checksums.files)) {
    if (!isSafePackageRelativePath(relativePath) || !/^[a-f0-9]{64}$/u.test(expectedHash)) {
      throw new Error("Plugin package checksums.json contains an unsafe path or digest.");
    }
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
  const actualFiles = await listPackageFiles(packageRoot);
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
  }
  return result;
}

function isSafePackageRelativePath(value: string): boolean {
  if (!value || value.includes("\\") || isAbsolute(value)) return false;
  const segments = value.split("/");
  return segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

function assertCompatibleVersion(artifact: LingPluginArtifactDescriptor, lingVersion: string): void {
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(lingVersion)) throw new Error("Current Ling version is not semver-compatible.");
  if (artifact.minLingVersion && compareSemver(lingVersion, artifact.minLingVersion) < 0) throw new Error("Plugin requires a newer Ling version.");
  if (artifact.maxLingVersion && compareSemver(lingVersion, artifact.maxLingVersion) > 0) throw new Error("Plugin does not support this Ling version.");
}

function compareSemver(left: string, right: string): number {
  const a = left.split(/[.+-]/u).slice(0, 3).map(Number);
  const b = right.split(/[.+-]/u).slice(0, 3).map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
}

async function writePointer(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "w" });
  await rename(temporary, path);
}

async function readPointer(path: string): Promise<RemotePluginPointer | undefined> {
  try {
    const pointer = JSON.parse(await readFile(path, "utf8")) as RemotePluginPointer;
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
