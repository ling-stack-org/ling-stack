/** Managed engine downloads (managed-lifecycle P1): pinned npm package → verified binary. */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { getManagedEnginePackage, type ExternalExecutionEngineId, type ManagedEnginePackage } from "@ling-stack/contracts";
import type { LingStackUserConfigPaths } from "@ling-stack/core";
import { killOwnedProbe, probeEngineInstallation } from "./installation-probe.js";

export class ManagedInstallError extends Error {
  readonly code = "managed_install_failed";
  constructor(message: string) {
    super(message);
    this.name = "ManagedInstallError";
  }
}

export interface ManagedInstallResult {
  readonly engineId: ExternalExecutionEngineId;
  readonly version: string;
  readonly executablePath: string;
  readonly integrity: string;
  readonly installedAt: string;
}

interface PlatformTarget {
  readonly platformKey: string;
  readonly targetTriple: string;
}

function resolvePlatformTarget(platform: NodeJS.Platform, arch: string): PlatformTarget {
  const key = `${platform}-${arch}`;
  const triples: Record<string, string> = {
    "darwin-arm64": "aarch64-apple-darwin",
    "darwin-x64": "x86_64-apple-darwin",
    "linux-x64": "x86_64-unknown-linux-musl",
    "linux-arm64": "aarch64-unknown-linux-musl",
    "win32-x64": "x86_64-pc-windows-msvc",
    "win32-arm64": "aarch64-pc-windows-msvc",
  };
  const targetTriple = triples[key];
  if (!targetTriple) throw new ManagedInstallError(`managed_install_unsupported_platform:${key}`);
  return { platformKey: key, targetTriple };
}

function tarballName(packageName: string, version: string): string {
  return `${packageName.split("/").pop()}-${version}.tgz`;
}

async function fetchJson(fetchImpl: typeof fetch, url: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const response = await fetchImpl(url, { signal });
  if (!response.ok) throw new ManagedInstallError(`managed_install_registry_http_${response.status}`);
  return await response.json() as Record<string, unknown>;
}

function readDist(metadata: Record<string, unknown>): { tarball: string; integrity: string } {
  const dist = metadata.dist;
  if (!dist || typeof dist !== "object") throw new ManagedInstallError("managed_install_registry_metadata_invalid");
  const record = dist as Record<string, unknown>;
  if (typeof record.tarball !== "string" || typeof record.integrity !== "string" || !record.integrity.startsWith("sha512-")) {
    throw new ManagedInstallError("managed_install_registry_metadata_invalid");
  }
  return { tarball: record.tarball, integrity: record.integrity };
}

async function extractTarball(tarball: string, targetDir: string, spawnImpl: typeof spawn, signal?: AbortSignal): Promise<void> {
  const run = (args: string[], failureCode: string): Promise<string> => new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const child = spawnImpl("tar", args, { stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
    let stdout = "";
    let failure: unknown;
    const abort = (): void => { failure = signal?.reason; killOwnedProbe(child); };
    signal?.addEventListener("abort", abort, { once: true });
    child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.stderr?.resume();
    child.on("error", (error) => { failure ??= error; });
    child.once("exit", () => killOwnedProbe(child));
    // Keep ownership until streams and the actual child have closed, including on abort/error.
    child.once("close", (code) => {
      signal?.removeEventListener("abort", abort);
      if (failure !== undefined) reject(failure);
      else if (code === 0) resolve(stdout);
      else reject(new ManagedInstallError(failureCode));
    });
    if (signal?.aborted) abort();
  });
  const entries = await run(["-tzf", tarball], "managed_install_list_failed");
  for (const entry of entries.split("\n").filter(Boolean)) {
    if (entry.startsWith("/") || entry.includes("..") || entry.includes("\\")) {
      throw new ManagedInstallError("managed_install_archive_entry_rejected");
    }
  }
  signal?.throwIfAborted();
  await mkdir(targetDir, { recursive: true });
  await run(["-xzf", tarball, "-C", targetDir], "managed_install_extract_failed");
}

export interface InstallManagedEngineOptions {
  readonly signal?: AbortSignal;
  readonly fetchImpl?: typeof fetch;
  readonly spawnImpl?: typeof spawn;
  readonly platform?: NodeJS.Platform;
  readonly arch?: string;
  readonly now?: () => Date;
  /** Testing seam: a fixture package record with the pin matching the synthetic tarball. */
  readonly packageOverride?: ManagedEnginePackage;
}

/** Download, verify and install the pinned engine package under the user root. */
export async function installManagedEngine(
  engineId: ExternalExecutionEngineId,
  userPaths: Pick<LingStackUserConfigPaths, "rootDir">,
  options: InstallManagedEngineOptions = {},
): Promise<ManagedInstallResult> {
  options.signal?.throwIfAborted();
  const pkg = options.packageOverride ?? getManagedEnginePackage(engineId);
  if (!pkg?.installable || !pkg.install) throw new ManagedInstallError(`managed_install_unsupported_engine:${engineId}`);
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const target = resolvePlatformTarget(platform, arch);
  const fetchImpl = options.fetchImpl ?? fetch;
  const spawnImpl = options.spawnImpl ?? spawn;
  const now = options.now ?? (() => new Date());

  const binaryPackage = pkg.install.binaryPackageName(target.platformKey);
  const binaryVersion = pkg.install.binaryVersion(pkg.pinnedVersion, target.platformKey);
  const metadata = await fetchJson(fetchImpl, `https://registry.npmjs.org/${binaryPackage}/${binaryVersion}`, options.signal);
  options.signal?.throwIfAborted();
  const dist = readDist(metadata);
  const tarballUrl = new URL(dist.tarball);
  if (tarballUrl.protocol !== "https:" || tarballUrl.hostname !== "registry.npmjs.org") {
    throw new ManagedInstallError("managed_install_tarball_host_rejected");
  }
  const pinnedIntegrity = pkg.pinnedIntegrityByPlatform?.[target.platformKey];
  if (!pinnedIntegrity) throw new ManagedInstallError(`managed_install_unpinned_platform:${target.platformKey}`);

  const root = await mkdtemp(join(tmpdir(), "ling-engine-install-"));
  try {
    const tarballPath = join(root, tarballName(binaryPackage, binaryVersion));
    const response = await fetchImpl(dist.tarball, { signal: options.signal });
    if (!response.ok) throw new ManagedInstallError(`managed_install_download_http_${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    options.signal?.throwIfAborted();
    const digest = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
    if (digest !== pinnedIntegrity || digest !== dist.integrity) throw new ManagedInstallError("managed_install_integrity_mismatch");
    await writeFile(tarballPath, bytes);

    const extractDir = join(root, "extract");
    await extractTarball(tarballPath, extractDir, spawnImpl, options.signal);
    options.signal?.throwIfAborted();

    const relativeBinary = pkg.install.binaryPath(target.targetTriple);
    const binary = join(extractDir, relativeBinary);
    await access(binary, constants.X_OK).catch(async () => {
      if (platform !== "win32") await chmod(binary, 0o755);
    });
    options.signal?.throwIfAborted();

    const installRoot = join(userPaths.rootDir, "engines", engineId, pkg.pinnedVersion);
    const parent = dirname(installRoot);
    await mkdir(parent, { recursive: true });
    const marker = join(installRoot, ".ling-managed.json");
    let executablePath = join(installRoot, relativeBinary);
    let alreadyInstalled = false;
    try {
      const existing = JSON.parse(await readFile(marker, "utf8")) as Record<string, unknown>;
      alreadyInstalled = existing.integrity === dist.integrity;
    } catch {
      alreadyInstalled = false;
    }
    if (!alreadyInstalled) {
      options.signal?.throwIfAborted();
      const staged = join(parent, `.staging-${pkg.pinnedVersion}-${process.pid}`);
      await rm(staged, { recursive: true, force: true });
      await rename(extractDir, staged);
      await rm(installRoot, { recursive: true, force: true });
      await rename(staged, installRoot);
      await writeFile(marker, JSON.stringify({
        engineId, packageName: binaryPackage, version: pkg.pinnedVersion,
        binaryVersion, platformKey: target.platformKey, integrity: dist.integrity, installedAt: now().toISOString(),
      }, null, 2) + "\n");
    }

    const probe = await probeEngineInstallation(discoveryProfileFor(pkg, executablePath), { signal: options.signal, timeoutMs: 5000 });
    options.signal?.throwIfAborted();
    if (probe.status !== "installed") throw new ManagedInstallError(`managed_install_probe_failed:${probe.status}`);
    return { engineId, version: pkg.pinnedVersion, executablePath, integrity: dist.integrity, installedAt: now().toISOString() };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function discoveryProfileFor(pkg: ManagedEnginePackage, executablePath: string) {
  return {
    schemaVersion: 1 as const,
    id: `managed:${pkg.engineId}`,
    revision: 0,
    status: "configured" as const,
    configuration: { engineId: pkg.engineId, executablePath, authProfileId: "managed" },
    configurationFingerprint: "managed",
    updatedAt: new Date(0).toISOString(),
  };
}
