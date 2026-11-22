import { createHash, randomUUID } from "node:crypto";
import { constants, createWriteStream, linkSync } from "node:fs";
import { mkdir, open, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { Transform, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import {
  REMOTE_DEVICE_ARTIFACT_MAX_BYTES, isAndroidPackageId, isAndroidVersionCode, type DeviceDeveloperArtifactV1,
} from "@ling-stack/contracts";
import { DeviceBrokerError } from "@ling-stack/core";
import { type LocalProcessRunner } from "./adapters/local-pc-executor.js";

export interface AndroidApkTools {
  readonly javaPath: string;
  readonly apkSignerJar: string;
  readonly aapt2Path: string;
}

export type VerifiedAndroidApk = Pick<DeviceDeveloperArtifactV1, "digest" | "sizeBytes"> & {
  readonly packageId: string;
  readonly androidApk: NonNullable<DeviceDeveloperArtifactV1["androidApk"]>;
};

const digestPattern = /^sha256:[a-f0-9]{64}$/u;

export class AndroidApkLibrary {
  constructor(
    private readonly directory: string,
    private readonly tools: AndroidApkTools,
    private readonly runner: LocalProcessRunner,
  ) {}

  async importApk<T>(
    source: Readable, sizeBytes: number, authorize: () => void,
    bind: (artifact: VerifiedAndroidApk) => T,
  ): Promise<T> {
    if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 1 || sizeBytes > REMOTE_DEVICE_ARTIFACT_MAX_BYTES) {
      throw new DeviceBrokerError("invalid_request", "APK size is outside the upload budget");
    }
    const uploadSignal = AbortSignal.timeout(180_000);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const staging = join(this.directory, `.${randomUUID()}.apk`);
    try {
      const hash = createHash("sha256");
      let count = 0;
      const meter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          count += chunk.length;
          if (count > sizeBytes) return callback(new DeviceBrokerError("invalid_request", "APK upload exceeded its declared length"));
          hash.update(chunk);
          callback(null, chunk);
        },
      });
      await pipeline(source, meter, createWriteStream(staging, { flags: "wx", mode: 0o600, flush: true }), { signal: uploadSignal });
      if (count !== sizeBytes) throw new DeviceBrokerError("invalid_request", "APK size differs from the upload");
      const digest = "sha256:" + hash.digest("hex");
      const toolSignal = AbortSignal.any([uploadSignal, AbortSignal.timeout(30_000)]);
      const metadata = await this.verifyStaged(staging, digest, toolSignal);
      authorize();
      const path = this.apkPath(digest);
      try {
        linkSync(staging, path);
      } catch (error) {
        if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
        await this.withVerifiedFile(path, digest, toolSignal, async () => undefined);
        authorize();
      }
      return bind({ ...metadata, digest, sizeBytes });
    } finally {
      await rm(staging, { force: true }).catch(() => undefined);
    }
  }

  async withApk<T>(digest: string, signal: AbortSignal, send: (bytes: Readable, sizeBytes: number) => Promise<T>): Promise<T> {
    return await this.withVerifiedFile(this.apkPath(digest), digest, signal, send);
  }

  async verifyStaged(
    path: string, digest: string, signal = AbortSignal.timeout(30_000),
  ): Promise<Pick<VerifiedAndroidApk, "packageId" | "androidApk">> {
    const metadata = await this.inspect(path, signal);
    await this.withVerifiedFile(path, digest, signal, async () => undefined);
    return metadata;
  }

  private async inspect(path: string, signal: AbortSignal): Promise<Pick<VerifiedAndroidApk, "packageId" | "androidApk">> {
    const { javaPath, apkSignerJar, aapt2Path } = this.tools;
    const tools = await Promise.all([javaPath, apkSignerJar, aapt2Path].map(file => stat(file).catch(() => undefined)));
    if (!tools.every(tool => tool?.isFile())) throw new DeviceBrokerError("service_unavailable", "Android APK tools are unavailable");
    signal.throwIfAborted();
    const signature = await this.runner.run(javaPath, ["-jar", apkSignerJar, "verify", "--verbose", "--print-certs", path], signal);
    signal.throwIfAborted();
    const signers = Array.from(signature.stdout.matchAll(/^Signer #\d+ certificate SHA-256 digest: ([0-9a-f]{64})\r?$/gimu),
      match => match[1]!.toLowerCase());
    if (signature.exitCode !== 0 || !/^Verifies\r?$/mu.test(signature.stdout)
      || signers.length === 0 || new Set(signers).size !== signers.length) {
      throw new DeviceBrokerError("invalid_request", "The APK signature could not be verified");
    }
    const manifest = await this.runner.run(aapt2Path, ["dump", "xmltree", path, "--file", "AndroidManifest.xml"], signal);
    signal.throwIfAborted();
    const metadata = manifest.exitCode === 0 ? readApkManifest(manifest.stdout) : undefined;
    if (!metadata) {
      throw new DeviceBrokerError("invalid_request", "The APK does not describe a standalone Android package and version");
    }
    const { packageId, ...version } = metadata;
    return { packageId, androidApk: { ...version, signerCertificateSha256: signers.sort() } };
  }

  private apkPath(digest: string): string {
    if (!digestPattern.test(digest)) throw new DeviceBrokerError("invalid_request", "Invalid APK digest");
    return join(this.directory, digest.slice("sha256:".length) + ".apk");
  }

  private async withVerifiedFile<T>(
    path: string, digest: string, signal: AbortSignal, use: (source: Readable, sizeBytes: number) => Promise<T>,
  ): Promise<T> {
    const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)).catch(() => undefined);
    if (!file) throw new DeviceBrokerError("missing_target", "The retained APK is unavailable");
    try {
      const snapshot = await file.stat();
      if (!snapshot.isFile() || snapshot.size < 1 || snapshot.size > REMOTE_DEVICE_ARTIFACT_MAX_BYTES) {
        throw new DeviceBrokerError("target_changed", "The APK file changed");
      }
      const hash = createHash("sha256");
      const reader = file.createReadStream({ autoClose: false, start: 0, end: snapshot.size - 1, signal });
      for await (const chunk of reader) hash.update(chunk);
      const after = await file.stat();
      if ("sha256:" + hash.digest("hex") !== digest || after.size !== snapshot.size || after.mtimeMs !== snapshot.mtimeMs) {
        throw new DeviceBrokerError("target_changed", "The APK file differs from the verified digest");
      }
      signal.throwIfAborted();
      const source = file.createReadStream({ autoClose: false, start: 0, end: snapshot.size - 1 });
      try {
        return await use(source, snapshot.size);
      } finally {
        source.destroy();
      }
    } finally {
      await file.close();
    }
  }
}

function readApkManifest(xmlTree: string) {
  const lines = xmlTree.split(/\r?\n/u).map(line => line.trim());
  const root = lines.findIndex(line => /^E: manifest(?:\s|$)/u.test(line));
  if (root < 0) return undefined;
  let packageId: string | undefined;
  let versionCode: bigint | undefined;
  let major: bigint | undefined;
  for (const line of lines.slice(root + 1)) {
    if (line.startsWith("E: ")) break;
    if (line.startsWith("A: split=")) return undefined;
    packageId ??= /^A: package="([^"]+)"/u.exec(line)?.[1];
    const version = /^A: http:\/\/schemas\.android\.com\/apk\/res\/android:(versionCode|versionCodeMajor)\(0x[0-9a-f]+\)=(\S+)/u.exec(line);
    if (!version) continue;
    if (!/^(?:\d{1,10}|0x[0-9a-f]{1,8})$/iu.test(version[2]!)) return undefined;
    const component = BigInt(version[2]!);
    if (component > 0x7fffffffn) return undefined;
    if (version[1] === "versionCode") versionCode = component;
    else major = component;
  }
  if (!isAndroidPackageId(packageId) || versionCode === undefined) return undefined;
  const combined = (((major ?? 0n) << 32n) | versionCode).toString();
  if (!isAndroidVersionCode(combined)) return undefined;
  return { packageId, versionCode: combined, ...(major ? { legacyVersionCode: versionCode.toString() } : {}) };
}
