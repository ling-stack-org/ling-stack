import { createHash, verify } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { comparePluginVersions } from "@ling-stack/contracts";
import { validateLingPluginPackageManifest, type LingPluginPackageManifest } from "@ling-stack/plugin-sdk";
import { resolveUserConfigPaths, type LingStackRuntimePaths } from "./runtime-paths.js";

export const OFFICIAL_PLUGIN_ARTIFACT_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAzc6EyHekMm92MzFte3V2PxzAkaDtSNpJxkpiHqjjiZQ=
-----END PUBLIC KEY-----`;
export const OFFICIAL_PLUGIN_CATALOG_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEA7ua9pbZ24GNj4qwssYOMEiwu7ypghh3pzluiMAX2xXw=
-----END PUBLIC KEY-----`;

export const OFFICIAL_PLUGIN_RUNTIME_SIGNATURE_CONTEXT = "ling-plugin-runtime-checksums/v1\0";
const nativeIds = ["official:chrome-browser", "official:office-documents", "official:cua-driver"] as const;
const metadataLimit = 512 * 1024;
const nativeFileLimit = 1024 * 1024 * 1024;
const digestPattern = /^[a-f0-9]{64}$/u;
type NativePluginId = (typeof nativeIds)[number];

export function isOfficialNativePluginId(value: string): value is NativePluginId {
  return (nativeIds as readonly string[]).includes(value);
}

export function usesHostPluginCache(cacheRef: string | undefined): boolean {
  return cacheRef?.startsWith("host/official-remote/") === true;
}

export function pluginPackageCacheDir(paths: Pick<LingStackRuntimePaths, "pluginCacheDir">, cacheRef?: string): string {
  return usesHostPluginCache(cacheRef) ? resolveUserConfigPaths().pluginCacheDir : paths.pluginCacheDir;
}

export function officialPluginRuntimePointerPath(cacheDir: string, pluginId: NativePluginId, pointer: "current" | "rollback"): string {
  return join(cacheDir, "host", pointer, `${pluginId.replace(":", "-")}.json`);
}

export function verifyOfficialRuntimeChecksumSignature(
  bytes: Uint8Array, signature: string, publicKey = OFFICIAL_PLUGIN_ARTIFACT_PUBLIC_KEY,
): boolean {
  if (!/^ed25519:[A-Za-z0-9+/]+={0,2}$/u.test(signature)) return false;
  const decoded = Buffer.from(signature.slice("ed25519:".length), "base64");
  return decoded.length === 64
    && verify(null, Buffer.concat([Buffer.from(OFFICIAL_PLUGIN_RUNTIME_SIGNATURE_CONTEXT), bytes]), publicKey, decoded);
}

/** Resolve a native tree from a Ling-signed receipt, without a network call. */
export async function readVerifiedOfficialPluginRuntime(input: {
  readonly pluginId: NativePluginId;
  readonly lingVersion: string;
  readonly executable: string;
  readonly cacheDir?: string;
  readonly platform?: string;
  readonly arch?: string;
  readonly publicKey?: string;
}): Promise<{ readonly root: string; readonly executablePath: string; readonly version: string } | undefined> {
  const cacheDir = input.cacheDir ?? resolveUserConfigPaths().pluginCacheDir;
  let pointer;
  try {
    pointer = JSON.parse(await readMetadata(officialPluginRuntimePointerPath(cacheDir, input.pluginId, "current"))) as {
      pluginId?: string; version?: string; cacheRef?: string; packageHash?: string;
      artifactId?: string; platform?: string; arch?: string; runtimeChecksumSignature?: string;
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const platform = input.platform ?? process.platform;
  const arch = input.arch ?? process.arch;
  if (pointer.pluginId !== input.pluginId || pointer.platform !== platform || pointer.arch !== arch
    || typeof pointer.version !== "string" || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(pointer.version)
    || typeof pointer.packageHash !== "string" || !digestPattern.test(pointer.packageHash)
    || typeof pointer.runtimeChecksumSignature !== "string" || !safeRuntimePath(input.executable)) {
    throw new Error("Invalid official plugin runtime receipt.");
  }
  const expectedRef = `host/official-remote/${input.pluginId.replace(":", "-")}/${pointer.version}/${platform}/${arch}/${pointer.packageHash.slice(0, 12)}`;
  if (pointer.cacheRef !== expectedRef) throw new Error("Official plugin runtime cache identity changed.");
  const cacheRoot = await realpath(cacheDir);
  const root = join(cacheRoot, expectedRef);
  if (await realpath(root) !== root) throw new Error("Official plugin runtime cache must be a regular directory.");
  const checksums = await readMetadata(join(root, ".ling-plugin", "checksums.json"));
  if (!verifyOfficialRuntimeChecksumSignature(Buffer.from(checksums), pointer.runtimeChecksumSignature, input.publicKey)) {
    throw new Error("Official plugin runtime checksum signature is invalid.");
  }
  const index = JSON.parse(checksums) as { algorithm?: string; files?: Record<string, string> };
  const manifestRef = ".ling-plugin/plugin.json";
  if (index.algorithm !== "sha256" || !index.files
    || !Object.hasOwn(index.files, manifestRef) || !Object.hasOwn(index.files, input.executable)) {
    throw new Error("Official plugin runtime checksum index is incomplete.");
  }
  const manifestText = await readMetadata(join(root, manifestRef));
  if (createHash("sha256").update(manifestText).digest("hex") !== index.files[manifestRef]) {
    throw new Error("Official plugin manifest checksum changed.");
  }
  const manifest = JSON.parse(manifestText) as LingPluginPackageManifest;
  validateLingPluginPackageManifest(manifest);
  if (manifest.id !== input.pluginId || manifest.sourceKind !== "official-remote"
    || manifest.artifactId !== pointer.artifactId || manifest.version !== pointer.version
    || manifest.platform !== platform || manifest.arch !== arch
    || (manifest.minLingVersion && comparePluginVersions(input.lingVersion, manifest.minLingVersion) < 0)
    || (manifest.maxLingVersion && comparePluginVersions(input.lingVersion, manifest.maxLingVersion) > 0)) {
    throw new Error("Official plugin runtime does not match this Ling release and platform.");
  }
  const runtimeFiles = await listRuntimeFiles(root, join(root, "runtime"));
  const expectedFiles = Object.keys(index.files).filter(safeRuntimePath);
  if (runtimeFiles.length !== expectedFiles.length) throw new Error("Official plugin runtime file inventory changed.");
  for (const key of runtimeFiles) {
    const path = join(root, key);
    const expected = index.files[key];
    const info = await lstat(path);
    if (!Object.hasOwn(index.files, key) || !digestPattern.test(expected ?? "")
      || !info.isFile() || info.size > nativeFileLimit || await realpath(path) !== path) {
      throw new Error("Official plugin runtime file is invalid.");
    }
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(path)) hash.update(chunk);
    if (hash.digest("hex") !== expected) throw new Error("Official plugin runtime checksum changed.");
  }
  const executablePath = join(root, input.executable);
  if (platform === "darwin" && !((await lstat(executablePath)).mode & 0o100)) {
    throw new Error("Official plugin runtime executable mode is missing.");
  }
  return { root, executablePath, version: pointer.version };
}

async function readMetadata(path: string): Promise<string> {
  const info = await lstat(path);
  if (!info.isFile() || info.size > metadataLimit) throw new Error("Invalid official plugin runtime metadata.");
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(await readFile(path));
}

function safeRuntimePath(value: string): boolean {
  return value.startsWith("runtime/") && !isAbsolute(value)
    && value.split("/").every((part) => /^[A-Za-z0-9_. -]+$/u.test(part) && part !== "." && part !== "..");
}

async function listRuntimeFiles(root: string, directory: string, depth = 0): Promise<string[]> {
  if (depth > 12 || await realpath(directory) !== directory) throw new Error("Invalid official plugin runtime directory.");
  const result: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await listRuntimeFiles(root, path, depth + 1));
    else if (entry.isFile()) result.push(relative(root, path).split(sep).join("/"));
    else throw new Error("Unexpected official plugin runtime path type.");
    if (result.length > 4096) throw new Error("Official plugin runtime file inventory is too large.");
  }
  return result;
}
