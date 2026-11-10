import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readSync, renameSync, rmSync, writeFileSync, type Stats } from "node:fs";
import { join } from "node:path";
import { RUNNER_RELEASE_CHECKS, RUNNER_HOST_CHECKS, type RunnerAcceptanceCheck, type RunnerAcceptanceEvidence, type RunnerAcceptanceIdentity, type RunnerHostCheck } from "@ling-stack/contracts";
import type { LingStackUserConfigPaths } from "@ling-stack/core";
import { assessRunnerAcceptance } from "./runner-acceptance.js";

export function runnerAcceptanceFingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value)
    .filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
  return value;
}

/** Host-owned acceptance storage. No workspace path, HTTP writer or config flag controls it. */
export class RunnerAcceptanceStore {
  private readonly root: string;
  private readonly directories: readonly string[];
  constructor(paths: LingStackUserConfigPaths) {
    this.root = join(paths.rootDir, "state", "execution-engine-acceptance-v1");
    this.directories = [paths.rootDir, join(paths.rootDir, "state"), this.root];
  }

  read(identity: RunnerAcceptanceIdentity): unknown {
    let descriptor: number | undefined;
    try {
      const directories = this.directories.map(directory => trustedDirectory(directory));
      const path = this.path(identity), before = lstatSync(path);
      if (!trustedFile(before)) return undefined;
      descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
      const opened = fstatSync(descriptor);
      if (!trustedFile(opened) || !sameFile(before, opened)) return undefined;
      const bytes = Buffer.alloc(256 * 1024 + 1);
      const count = readSync(descriptor, bytes, 0, bytes.length, 0);
      const after = fstatSync(descriptor);
      if (count > 256 * 1024 || count !== opened.size || !sameFile(opened, after)
        || !sameFile(after, lstatSync(path)) || this.directories.some((directory, index) =>
          !sameFile(directories[index]!, trustedDirectory(directory)))) return undefined;
      return JSON.parse(bytes.subarray(0, count).toString("utf8"));
    } catch { return undefined; }
    finally { if (descriptor !== undefined) closeSync(descriptor); }
  }

  /**
   * Trusted candidate-verifier port, deliberately absent from HTTP/IPC/config.
   * The embedding must execute the named real checks; failed/missing checks never publish.
   */
  async verifyAndPublish(input: {
    readonly readCurrentIdentity: () => Promise<RunnerAcceptanceIdentity>;
    readonly verifyRelease: (check: RunnerAcceptanceCheck, identity: RunnerAcceptanceIdentity) => Promise<"passed" | "failed" | "not_run">;
    readonly verifyHost: (check: RunnerHostCheck, identity: RunnerAcceptanceIdentity) => Promise<"passed" | "failed" | "not_run">;
    readonly validityMs: number;
  }): Promise<RunnerAcceptanceEvidence> {
    if (!Number.isSafeInteger(input.validityMs) || input.validityMs <= 0 || input.validityMs > 7 * 24 * 3600_000) {
      throw new Error("verification_validity_invalid");
    }
    const identity = await input.readCurrentIdentity();
    const fingerprint = runnerAcceptanceFingerprint(identity);
    const assertCurrent = async (): Promise<void> => {
      if (runnerAcceptanceFingerprint(await input.readCurrentIdentity()) !== fingerprint) throw new Error("verification_mismatch");
    };
    const release: Partial<Record<RunnerAcceptanceCheck, "passed">> = {};
    const host: Partial<Record<RunnerHostCheck, "passed">> = {};
    for (const check of RUNNER_RELEASE_CHECKS) {
      if (await input.verifyRelease(check, identity) !== "passed") throw new Error("verification_incomplete");
      await assertCurrent(); release[check] = "passed";
    }
    for (const check of RUNNER_HOST_CHECKS) {
      if (await input.verifyHost(check, identity) !== "passed") throw new Error("verification_incomplete");
      await assertCurrent(); host[check] = "passed";
    }
    const now = Date.now(), verifiedAt = new Date(now).toISOString(), expiresAt = new Date(now + input.validityMs).toISOString();
    const { profileId: _, profileRevision: __, configurationFingerprint: ___, workspaceId: ____, ...releaseIdentity } = identity;
    const releaseId = randomUUID();
    const evidence: RunnerAcceptanceEvidence = { schemaVersion: 1, id: randomUUID(), identity, verifiedAt, expiresAt,
      checks: completedChecks(RUNNER_HOST_CHECKS, host), releaseEvidenceId: releaseId,
      release: { schemaVersion: 1, id: releaseId, identity: releaseIdentity, verifiedAt, expiresAt, checks: completedChecks(RUNNER_RELEASE_CHECKS, release) } };
    if (assessRunnerAcceptance(identity, evidence, now).status !== "accepted") throw new Error("verification_invalid");
    await assertCurrent();
    for (const directory of this.directories) { mkdirSync(directory, { recursive: true, mode: 0o700 }); trustedDirectory(directory); }
    const path = this.path(identity), temporary = `${path}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, `${JSON.stringify(evidence)}\n`, { flag: "wx", mode: 0o600 });
      renameSync(temporary, path);
    } finally { rmSync(temporary, { force: true }); }
    return evidence;
  }

  private path(identity: RunnerAcceptanceIdentity): string { return join(this.root, `${runnerAcceptanceFingerprint(identity)}.json`); }
}

function completedChecks<K extends string>(keys: readonly K[], values: Partial<Record<K, "passed">>): Record<K, "passed"> {
  if (keys.some(key => values[key] !== "passed")) throw new Error("verification_incomplete");
  return values as Record<K, "passed">;
}

function trustedDirectory(path: string): Stats {
  const info = lstatSync(path);
  if (!info.isDirectory() || info.isSymbolicLink() || process.platform !== "win32"
    && ((info.mode & 0o022) !== 0 || info.uid !== process.getuid?.())) throw new Error("verification_storage_invalid");
  return info;
}
function trustedFile(info: Stats): boolean {
  return info.isFile() && !info.isSymbolicLink() && info.nlink === 1 && info.size <= 256 * 1024
    && (process.platform === "win32" || (info.mode & 0o077) === 0 && info.uid === process.getuid?.());
}
function sameFile(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeMs === right.mtimeMs
    && left.mode === right.mode && left.uid === right.uid && !right.isSymbolicLink();
}
