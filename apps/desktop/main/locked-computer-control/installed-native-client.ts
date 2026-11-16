import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, open } from "node:fs/promises";
import { join } from "node:path";
import { createDarwinExecFileCommandRunner, type DarwinIdentityCommandRunner } from "../cua-driver/adapters/darwin-identity.js";
import { DarwinLockedUseNativeClient } from "./darwin-locked-use-client.js";

const COMPONENT_ROOT = "/Library/Application Support/LingStack/LockedUse";
const CLIENT_BUNDLE = join(COMPONENT_ROOT, "Client.app");
const CLIENT_PATH = join(CLIENT_BUNDLE, "Contents/MacOS/LingLockedUseClient");
const MANIFEST_PATH = join(COMPONENT_ROOT, "build-manifest.json");
const CLIENT_ARTIFACT = "Client.app/Contents/MacOS/LingLockedUseClient";
const ARTIFACTS = ["LingLockBroker", "LingLockInstaller", "Ling Guardian.app/Contents/MacOS/LingGuardian",
  CLIENT_ARTIFACT, "LingLockAuth.bundle/Contents/MacOS/LingLockAuth"];
const HASH = /^[a-f0-9]{64}$/u;

/** Release composition supplies the independently accepted manifest digest. */
export function createInstalledDarwinLockedUseClientFactory(options: {
  readonly expectedTeamId: string;
  readonly expectedBuildManifestSha256: string;
  /** Trusted fixture dependencies; production uses the fixed system tools/files. */
  readonly runner?: DarwinIdentityCommandRunner;
  readonly readInstalledFile?: (path: string, maxBytes: number) => Promise<Buffer>;
}) {
  const { expectedTeamId, expectedBuildManifestSha256 } = options;
  if (expectedTeamId.length !== 10 || !/^[A-Z0-9]{10}$/u.test(expectedTeamId) || expectedTeamId === "0000000000"
    || !isSha256(expectedBuildManifestSha256)) throw new Error("locked_use_release_identity_invalid");
  const runner = options.runner ?? createDarwinExecFileCommandRunner({
    timeoutMs: 5_000, maxOutputBytes: 64 * 1024,
    baseEnvironment: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
  });
  const read = options.readInstalledFile ?? readInstalledFile;
  const requirement = `identifier "com.lingstack.locked-use.client" and anchor apple generic`
    + ` and certificate 1[field.1.2.840.113635.100.6.2.6] exists`
    + ` and certificate leaf[field.1.2.840.113635.100.6.1.13] exists`
    + ` and certificate leaf[subject.OU] = "${expectedTeamId}"`;
  const verifyHelper = async (): Promise<void> => {
    const manifestBytes = await read(MANIFEST_PATH, 16 * 1024);
    if (digest(manifestBytes) !== expectedBuildManifestSha256) throw new Error("locked_use_manifest_digest_mismatch");
    const helperHash = parseManifest(manifestBytes, expectedTeamId);
    const verifyBytes = async (): Promise<void> => {
      if (digest(await read(CLIENT_PATH, 32 * 1024 * 1024)) !== helperHash) throw new Error("locked_use_helper_digest_mismatch");
    };
    await verifyBytes();
    await runner.run({ executable: "/usr/bin/codesign", args: ["--verify", "--strict", "--all-architectures",
      "--test-requirement", requirement, CLIENT_BUNDLE] });
    const details = await runner.run({ executable: "/usr/bin/codesign", args: ["--display", "--verbose=4", CLIENT_PATH] });
    const metadata = `${details.stdout}\n${details.stderr}`;
    const one = (prefix: string): string | undefined => {
      const values = metadata.split(/\r?\n/u).filter((line) => line.startsWith(prefix)).map((line) => line.slice(prefix.length));
      return values.length === 1 ? values[0] : undefined;
    };
    const flags = [...metadata.matchAll(/\bflags=0x([a-f0-9]+)\b/giu)];
    if (one("Identifier=") !== "com.lingstack.locked-use.client" || one("TeamIdentifier=") !== expectedTeamId
      || flags.length !== 1 || (Number.parseInt(flags[0]![1]!, 16) & 0x10000) === 0) {
      throw new Error("locked_use_helper_signing_identity_mismatch");
    }
    const entitlements = await runner.run({ executable: "/usr/bin/codesign", args: ["--display", "--entitlements", "-", "--xml", CLIENT_PATH] });
    const text = `${entitlements.stdout}\n${entitlements.stderr}`;
    const start = text.indexOf("<plist");
    if (start >= 0) {
      const end = text.indexOf("</plist>", start);
      if (end < 0) throw new Error("locked_use_helper_entitlements_invalid");
      const converted = await runner.run({ executable: "/usr/bin/plutil", args: ["-convert", "json", "-o", "-", "--", "-"],
        stdin: text.slice(start, end + "</plist>".length) });
      let value: unknown;
      try { value = JSON.parse(converted.stdout); } catch { throw new Error("locked_use_helper_entitlements_invalid"); }
      if (!record(value) || Object.keys(value).length !== 0) throw new Error("locked_use_helper_entitlements_invalid");
    } else if (entitlements.stdout.trim() !== "") {
      throw new Error("locked_use_helper_entitlements_invalid");
    }
    await verifyBytes();
    if (digest(await read(MANIFEST_PATH, 16 * 1024)) !== expectedBuildManifestSha256) throw new Error("locked_use_manifest_digest_mismatch");
  };
  return Object.freeze({
    verifyHelper,
    createClient(onRevoked: () => void) {
      return new DarwinLockedUseNativeClient({ helperPath: CLIENT_PATH, verifyHelper, onRevoked });
    },
  });
}

function parseManifest(bytes: Buffer, team: string): string {
  let value: unknown;
  try { value = JSON.parse(bytes.toString("utf8")); } catch { throw new Error("locked_use_manifest_invalid"); }
  if (!record(value) || !keys(value, ["schemaVersion", "platform", "architecture", "team", "signing", "productCapability", "nativeAcceptance", "checks", "upstreamCommit", "artifacts"])
    || value.schemaVersion !== 1 || value.platform !== "darwin" || value.architecture !== process.arch
    || value.team !== team || value.signing !== "local_identity"
    || value.productCapability !== "disabled_by_build" || value.nativeAcceptance !== "not_run"
    || typeof value.upstreamCommit !== "string" || value.upstreamCommit.length !== 40 || !/^[a-f0-9]{40}$/u.test(value.upstreamCommit)
    || !record(value.checks) || !keys(value.checks, ["policy", "authorizationPluginABI", "kernelTaskVerifier", "xctest"])
    || value.checks.policy !== "passed" || value.checks.authorizationPluginABI !== "passed"
    || value.checks.kernelTaskVerifier !== "identity_passed" || value.checks.xctest !== "separate"
    || !record(value.artifacts) || !keys(value.artifacts, ARTIFACTS)
    || Object.values(value.artifacts).some((hash) => !isSha256(hash))) {
    throw new Error("locked_use_manifest_invalid");
  }
  return value.artifacts[CLIENT_ARTIFACT] as string;
}

/** Root ownership plus access checks exclude mutable ACLs for this Desktop UID. */
async function readInstalledFile(path: string, maxBytes: number): Promise<Buffer> {
  const segments = path.split("/").filter(Boolean);
  let prefix = "";
  for (const [index, segment] of segments.entries()) {
    prefix += `/${segment}`;
    const final = index === segments.length - 1;
    const handle = await open(prefix, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
      | (final ? 0 : constants.O_DIRECTORY));
    try {
      const before = await handle.stat();
      if (before.uid !== 0 || (before.mode & 0o6022) !== 0 || (final ? !before.isFile() : !before.isDirectory())) {
        throw new Error("locked_use_installed_path_untrusted");
      }
      try {
        await access(prefix, constants.W_OK);
        throw new Error("locked_use_installed_path_writable");
      } catch (error) {
        if (!(error instanceof Error) || !("code" in error) || !["EACCES", "EPERM", "EROFS"].includes(String(error.code))) throw error;
      }
      if (final) {
        if (before.size <= 0 || before.size > maxBytes) throw new Error("locked_use_installed_file_oversized");
        const buffer = Buffer.allocUnsafe(before.size + 1);
        let offset = 0;
        while (offset < buffer.byteLength) {
          const result = await handle.read(buffer, offset, buffer.byteLength - offset, offset);
          if (result.bytesRead === 0) break;
          offset += result.bytesRead;
        }
        const after = await handle.stat();
        if (offset !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs
          || after.ctimeMs !== before.ctimeMs || after.uid !== before.uid || after.mode !== before.mode) {
          throw new Error("locked_use_installed_file_changed");
        }
        return buffer.subarray(0, offset);
      }
    } finally { await handle.close(); }
  }
  throw new Error("locked_use_installed_path_untrusted");
}

function digest(bytes: Buffer): string { return createHash("sha256").update(bytes).digest("hex"); }
function isSha256(value: unknown): value is string { return typeof value === "string" && value.length === 64 && HASH.test(value); }
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function keys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return Object.keys(value).length === expected.length && Object.keys(value).every((key) => expected.includes(key));
}
