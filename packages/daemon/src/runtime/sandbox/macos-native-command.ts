import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { release } from "node:os";
import type { ExecutionSandboxBackendIdentity, ExecutionSandboxPolicyV1, UnifiedExecCommand } from "@ling-stack/core";
import { buildMacosSeatbeltProfile, MACOS_DYLD_PROFILE, MACOS_SANDBOX_EXECUTABLE, MACOS_SYSTEM_READ_ROOTS } from "./macos-seatbelt-profile.js";

const hash = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
const backendVersion = "ling-seatbelt-v1";
const ownedProcessGroups = new WeakMap<ChildProcessWithoutNullStreams, number>();
const sameBackend = (first: ExecutionSandboxBackendIdentity, second: ExecutionSandboxBackendIdentity): boolean =>
  first.kind === second.kind && first.helperVersion === second.helperVersion
  && first.protocolVersion === second.protocolVersion && first.executableSha256 === second.executableSha256;

export class MacosSandboxCommandError extends Error {
  constructor(readonly code: string) { super(code); this.name = "MacosSandboxCommandError"; }
}
function requireNative(condition: unknown, code: string): asserts condition {
  if (!condition) throw new MacosSandboxCommandError(code);
}

/** Fixed system identity. A project path, PATH lookup or config verified flag is never used. */
export function readMacosSandboxBackendIdentity(): ExecutionSandboxBackendIdentity {
  requireNative(process.platform === "darwin", "macos_backend_unavailable");
  for (const path of [MACOS_SANDBOX_EXECUTABLE, MACOS_DYLD_PROFILE]) {
    const stat = lstatSync(path);
    requireNative(stat.isFile() && !stat.isSymbolicLink() && stat.uid === 0 && (stat.mode & 0o022) === 0 && realpathSync(path) === path, "macos_system_identity_invalid");
    requireNative(stat.size <= 8 * 1024 * 1024, "macos_system_identity_invalid");
  }
  return Object.freeze({ kind: "macos_seatbelt", protocolVersion: 1,
    helperVersion: `${backendVersion}:${release()}:${hash(readFileSync(MACOS_DYLD_PROFILE))}`,
    executableSha256: hash(readFileSync(MACOS_SANDBOX_EXECUTABLE)) });
}

function commandArgv(command: UnifiedExecCommand): readonly string[] {
  if (command.kind === "argv") {
    requireNative(Array.isArray(command.argv) && command.argv.length > 0 && command.argv.length <= 256
      && command.argv.every(part => typeof part === "string" && !part.includes("\0") && Buffer.byteLength(part) <= 131_072)
      && isAbsolute(command.argv[0]!), "macos_command_invalid");
    requireNative(command.argv.reduce((total, part) => total + Buffer.byteLength(part) + 1, 0) <= 131_072, "macos_command_invalid");
    return [...command.argv];
  }
  requireNative(command.kind === "shell" && typeof command.command === "string" && command.command.trim()
    && !command.command.includes("\0") && Buffer.byteLength(command.command) <= 131_072, "macos_command_invalid");
  requireNative(command.shell === undefined || command.shell === "bash" || command.shell === "/bin/bash", "macos_shell_unsupported");
  return ["/bin/bash", "--noprofile", "--norc", "-c", command.command];
}

export interface MacosCommandRuntimeProfile {
  readonly kind: "electron_node_v1";
  readonly resourceIdentitySha256: string;
}
function runtimeEnvironment(profile?: MacosCommandRuntimeProfile): "isolated_macos_v1" | MacosCommandRuntimeProfile {
  if (profile === undefined) return "isolated_macos_v1";
  requireNative(profile && Object.keys(profile).sort().join(",") === "kind,resourceIdentitySha256"
    && profile.kind === "electron_node_v1" && /^[a-f0-9]{64}$/u.test(profile.resourceIdentitySha256), "macos_runtime_profile_invalid");
  return { kind: profile.kind, resourceIdentitySha256: profile.resourceIdentitySha256 };
}

/** Exact command/cwd/environment and runtime-resource contract, bound before launch. */
export function macosSandboxCommandFingerprint(command: UnifiedExecCommand, cwd: string, temporaryRoot: string, runtimeProfile?: MacosCommandRuntimeProfile): string {
  return hash(JSON.stringify({ version: 1, argv: commandArgv(command), cwd, temporaryRoot, environment: runtimeEnvironment(runtimeProfile) }));
}

interface PathFact {
  readonly requested: string;
  readonly existing: string;
  readonly device: string;
  readonly inode: string;
  readonly mode: number;
}
function pathFact(requested: string, mustExist: boolean): PathFact {
  requireNative(isAbsolute(requested) && resolve(requested) === requested, "macos_canonical_path_required");
  let existing = requested;
  for (;;) {
    try {
      const stat = lstatSync(existing, { bigint: true });
      requireNative(!stat.isSymbolicLink() && realpathSync(existing) === existing, "macos_canonical_path_required");
      requireNative(stat.isFile() || stat.isDirectory(), "macos_path_type_unsupported");
      return { requested, existing, device: String(stat.dev), inode: String(stat.ino), mode: Number(stat.mode) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      requireNative(!mustExist && dirname(existing) !== existing, "macos_path_missing");
      existing = dirname(existing);
    }
  }
}

export interface PreparedMacosSandboxCommand {
  readonly policyHash: string;
  readonly profileHash: string;
  readonly executable: typeof MACOS_SANDBOX_EXECUTABLE;
  readonly environmentKeys: readonly string[];
  /** Observed process group only. This API does not claim escaped-descendant quiescence. */
  readonly lifecycleScope: "process_group";
  readonly descendantStopProof: "not_available";
  spawn(assertCurrentAuthority: () => void): ChildProcessWithoutNullStreams;
}

/**
 * Host-only launcher used by the restricted command runtime.
 * T2-A does NOT contain pre-existing cross-root hardlinks or detached descendants.
 * The explicit macos-boundary-smoke suite must pass before this can back restricted execution.
 * No public endpoint, no raw Host fallback, no readiness flag mutation.
 */
export function prepareMacosSandboxCommand(input: {
  readonly policy: ExecutionSandboxPolicyV1;
  readonly command: UnifiedExecCommand;
  readonly runtimeProfile?: MacosCommandRuntimeProfile;
}): PreparedMacosSandboxCommand {
  const { policy, command } = input;
  requireNative(policy.platform === "darwin" && policy.executionMode === "native_required" && policy.filesystem
    && policy.backend?.kind === "macos_seatbelt" && ["allow", "ask"].includes(policy.approvalDecision), "macos_restricted_policy_required");
  const { policyHash, ...body } = policy;
  requireNative(hash(JSON.stringify(body)) === policyHash && Object.isFrozen(policy), "macos_policy_integrity_invalid");
  const backend = readMacosSandboxBackendIdentity();
  requireNative(sameBackend(backend, policy.backend), "macos_backend_identity_changed");
  const filesystem = policy.filesystem;
  requireNative(macosSandboxCommandFingerprint(command, policy.cwd, filesystem.temporaryRoot, input.runtimeProfile) === policy.binding.operationHash, "macos_command_binding_mismatch");
  for (const root of MACOS_SYSTEM_READ_ROOTS) requireNative(filesystem.readRoots.includes(root), "macos_runtime_roots_missing");
  const requiredPaths = [...new Set([filesystem.workspaceRoot, policy.cwd, filesystem.temporaryRoot, ...filesystem.readRoots, ...filesystem.writeRoots])];
  const facts = [...requiredPaths.map(path => pathFact(path, true)), ...[...filesystem.deniedReadRoots, ...filesystem.deniedWriteRoots].map(path => pathFact(path, false))];
  const temp = lstatSync(filesystem.temporaryRoot);
  requireNative(temp.isDirectory() && temp.uid === process.getuid?.() && (temp.mode & 0o077) === 0, "macos_temporary_root_not_private");
  const argv = Object.freeze(commandArgv(command));
  const profile = buildMacosSeatbeltProfile(policy);
  requireNative(Buffer.byteLength(profile) <= 65_536, "macos_profile_too_large");
  const env = Object.freeze({ PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "en_US.UTF-8", HOME: filesystem.temporaryRoot,
    TMPDIR: filesystem.temporaryRoot + "/", PWD: policy.cwd, LING_STACK_SANDBOX: "native-macos-v1",
    ...(input.runtimeProfile ? { ELECTRON_RUN_AS_NODE: "1" } : {}) });
  let consumed = false;
  return Object.freeze({ policyHash, profileHash: hash(profile), executable: MACOS_SANDBOX_EXECUTABLE,
    environmentKeys: Object.freeze(Object.keys(env).sort()), lifecycleScope: "process_group", descendantStopProof: "not_available",
    spawn(assertCurrentAuthority: () => void): ChildProcessWithoutNullStreams {
      requireNative(!consumed && typeof assertCurrentAuthority === "function", "macos_launch_already_consumed");
      consumed = true;
      requireNative(sameBackend(readMacosSandboxBackendIdentity(), backend), "macos_backend_identity_changed");
      for (const fact of facts) requireNative(JSON.stringify(pathFact(fact.requested, fact.existing === fact.requested)) === JSON.stringify(fact), "macos_path_identity_changed");
      // Must be a synchronous, current Host fence/approval check immediately before spawning.
      const returned: unknown = assertCurrentAuthority();
      requireNative(returned === undefined, "macos_authority_check_must_be_synchronous");
      const child = spawn(MACOS_SANDBOX_EXECUTABLE, ["-p", profile, ...argv], {
        cwd: policy.cwd, env, detached: true, stdio: "pipe",
      });
      if (child.pid) ownedProcessGroups.set(child, child.pid);
      child.once("exit", () => ownedProcessGroups.delete(child));
      child.stdin.end();
      return child;
    },
  });
}

/** Signal only a still-owned live leader's group. Never guess a reaped/reused PID or claim all descendants stopped. */
export function signalMacosSandboxProcessGroup(child: ChildProcessWithoutNullStreams, signal: "SIGTERM" | "SIGKILL"): boolean {
  const pid = ownedProcessGroups.get(child);
  requireNative((signal === "SIGTERM" || signal === "SIGKILL") && pid && child.exitCode === null && child.signalCode === null, "macos_process_group_not_owned");
  try { process.kill(-pid, signal); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; throw error; }
}
