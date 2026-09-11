import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { parse } from "shell-quote";
import { compileExecutionSandboxPolicy, type EffectiveRunPolicySnapshot, type RuntimeAttemptFenceV1,
  type UnifiedExecCommand, type UnifiedExecIsolationEvidence, type UnifiedExecEnvironmentSummary } from "@ling-stack/core";
import type { ChannelOperationFileBindingV1 } from "@ling-stack/contracts";
import { isChannelOperationRelativePathV1 } from "@ling-stack/contracts";
import { captureNativeCommandInput } from "./native-input-capture.js";
import { macosSandboxCommandFingerprint, prepareMacosSandboxCommand, readMacosSandboxBackendIdentity } from "./macos-native-command.js";
import { MACOS_SYSTEM_READ_ROOTS } from "./macos-seatbelt-profile.js";
import { verifyElectronNodeResources, type ElectronNodeRuntimePin } from "./electron-node-resources.js";
import type { MacosCommandRuntimeProfile } from "./macos-native-command.js";

export interface RestrictedCommandBinaryPin { readonly path: string; readonly sha256: string }
export interface RestrictedCommandExecutablePin extends RestrictedCommandBinaryPin {
  readonly runtime?: ElectronNodeRuntimePin;
}
/** Host boot configuration, never read from a project, model payload or verified=true claim. */
export interface RestrictedCommandRuntimeConfig {
  readonly inputHelper: RestrictedCommandBinaryPin & { readonly version: string };
  readonly executables: Readonly<Record<string, RestrictedCommandExecutablePin>>;
}
const ownedRuntimes = new WeakSet<NativeRestrictedCommandRuntime>();
const digest = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");
const outside = (root: string, path: string): boolean => {
  const value = relative(root, path);
  return value === ".." || value.startsWith("../") || isAbsolute(value);
};
function requireRuntime(value: unknown, code: string): asserts value {
  if (!value) throw new Error(code);
}
function verifyPin(pin: RestrictedCommandBinaryPin): string {
  requireRuntime(pin && isAbsolute(pin.path) && /^[a-f0-9]{64}$/u.test(pin.sha256), "restricted_command_binary_invalid");
  const stat = lstatSync(pin.path);
  requireRuntime(stat.isFile() && !stat.isSymbolicLink() && realpathSync(pin.path) === pin.path
    && stat.size > 0 && stat.size <= 256 * 1024 * 1024 && (stat.mode & 0o111) !== 0
    && (stat.mode & 0o022) === 0, "restricted_command_binary_invalid");
  requireRuntime(digest(readFileSync(pin.path)) === pin.sha256, "restricted_command_binary_changed");
  return pin.path;
}
export function isNativeRestrictedCommandRuntime(value: unknown): value is NativeRestrictedCommandRuntime {
  return typeof value === "object" && value !== null && ownedRuntimes.has(value as NativeRestrictedCommandRuntime);
}

export class NativeRestrictedCommandRuntime {
  readonly #config: RestrictedCommandRuntimeConfig;
  constructor(config: RestrictedCommandRuntimeConfig) {
    this.#config = structuredClone(config);
    ownedRuntimes.add(this);
  }

  /** Verify the concrete runtime and shell interpretation before admitting a typed operation. */
  assertAvailable(command: string): UnifiedExecCommand {
    return this.#resolve(command).command;
  }

  #resolve(command: string): { command: UnifiedExecCommand; readRoots: readonly string[]; runtimeProfile?: MacosCommandRuntimeProfile } {
    requireRuntime(process.platform === "darwin", "restricted_command_platform_unavailable");
    readMacosSandboxBackendIdentity();
    verifyPin(this.#config.inputHelper);
    requireRuntime(/^[\w.+-]{1,128}$/u.test(this.#config.inputHelper.version), "restricted_command_helper_version_invalid");
    // No expansion from the daemon environment. Operators/globs are not argv.
    let argv: ReturnType<typeof parse>;
    try { argv = parse(command, () => { throw new Error("restricted_command_environment_expansion"); }); }
    catch { throw new Error("restricted_command_shell_expansion_unsupported"); }
    requireRuntime(argv.length > 0 && argv.length <= 256 && argv.every(part => typeof part === "string")
      && typeof argv[0] === "string" && /^[A-Za-z0-9_-]+$/u.test(argv[0]), "restricted_command_argv_unsupported");
    const pin = this.#config.executables[argv[0] as string];
    requireRuntime(pin && Object.hasOwn(this.#config.executables, argv[0] as string), "restricted_command_executable_unavailable");
    const executable = verifyPin(pin);
    const resources = pin.runtime === undefined ? undefined : verifyElectronNodeResources(executable, pin.runtime);
    return { command: { kind: "argv", argv: [executable, ...argv.slice(1) as string[]] },
      readRoots: [executable, ...(resources?.readRoots ?? [])],
      ...(resources ? { runtimeProfile: { kind: "electron_node_v1", resourceIdentitySha256:
        digest(Buffer.from(JSON.stringify({ executableSha256: pin.sha256, resources: resources.resourceIdentitySha256 }))) } as const } : {}) };
  }

  async prepare(input: {
    readonly command: string;
    readonly cwd: string;
    readonly inputRefs: readonly ChannelOperationFileBindingV1[];
    readonly policy: EffectiveRunPolicySnapshot;
    readonly source: RuntimeAttemptFenceV1 & { readonly workspaceId: string; readonly runId: string; readonly toolCallId: string };
    readonly assertCurrentAuthority: () => void;
    readonly signal?: AbortSignal;
  }) {
    const check = () => {
      input.signal?.throwIfAborted();
      const result: unknown = input.assertCurrentAuthority();
      if (result instanceof Promise) void result.catch(() => undefined);
      requireRuntime(result === undefined, "restricted_command_authority_must_be_synchronous");
    };
    check();
    const resolved = this.#resolve(input.command), { command } = resolved, origin = realpathSync(input.cwd);
    const inputRefs = structuredClone(input.inputRefs);
    requireRuntime(inputRefs.length <= 256 && new Set(inputRefs.map(ref => ref.path)).size === inputRefs.length,
      "restricted_command_input_budget_exceeded");
    requireRuntime(resolved.readRoots.every(path => outside(origin, path)) && outside(origin, this.#config.inputHelper.path),
      "restricted_command_runtime_inside_workspace");
    const root = realpathSync(mkdtempSync("/private/tmp/ling-command-"));
    const rootFact = lstatSync(root, { bigint: true });
    const copy = join(root, "workspace"), scratch = join(root, "scratch");
    let disposed = false;
    const dispose = () => {
      if (disposed) return;
      const current = lstatSync(root, { bigint: true });
      requireRuntime(current.isDirectory() && !current.isSymbolicLink() && current.dev === rootFact.dev && current.ino === rootFact.ino,
        "restricted_command_cleanup_identity_changed");
      rmSync(root, { recursive: true }); disposed = true;
    };
    try {
      mkdirSync(copy, { mode: 0o700 }); mkdirSync(scratch, { mode: 0o700 });
      const { workspaceId, runId, workUnitId, attemptId, runtimeInstanceId, fencingToken } = input.source;
      const identity = { workspaceId, runId, workUnitId, attemptId, runtimeInstanceId, fencingToken };
      const files: UnifiedExecIsolationEvidence["inputs"][number][] = [];
      let bytes = 0;
      for (const ref of inputRefs) {
        requireRuntime(isChannelOperationRelativePathV1(ref.path) && !ref.path.split("/").includes(".ling"), "restricted_command_protected_input");
        const captured = await captureNativeCommandInput({ helper: this.#config.inputHelper, root: origin, path: ref.path,
          maxBytes: Math.min(16 * 1024 * 1024, 64 * 1024 * 1024 - bytes), identity,
          assertCurrentAuthority: check, signal: input.signal });
        bytes += captured.bytes.length;
        requireRuntime(bytes <= 64 * 1024 * 1024, "restricted_command_input_budget_exceeded");
        const target = join(copy, ref.path);
        mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
        writeFileSync(target, captured.bytes, { flag: "wx", mode: 0o400 });
        files.push({ path: ref.path, sha256: captured.sha256, sizeBytes: captured.bytes.length,
          sourceItemIds: [...new Set(ref.sourceRefs.map(source => source.itemId))] });
      }
      check();
      requireRuntime(realpathSync(input.cwd) === origin, "restricted_command_workspace_changed");
      const policy = compileExecutionSandboxPolicy({ now: new Date().toISOString(), platform: "darwin", tool: "bash",
        workspaceRoot: copy, cwd: copy, temporaryRoot: scratch, runtimeReadRoots: [...MACOS_SYSTEM_READ_ROOTS, ...resolved.readRoots],
        deniedReadRoots: [origin], protectedWriteRoots: [], backend: readMacosSandboxBackendIdentity(), grants: [],
        // A full-access session may still request a narrower typed operation. This
        // conversion only removes writes/network/environment, never adds access.
        policy: { ...input.policy, ...(input.policy.workspaceAccessMode === "full_access"
          ? { workspaceAccessMode: "workspace_write" as const, mode: "workspace_write" as const } : {}), allowedWritePaths: [] },
        binding: { ...input.source, operationHash: macosSandboxCommandFingerprint(command, copy, scratch, resolved.runtimeProfile) } });
      const prepared = prepareMacosSandboxCommand({ policy, command, runtimeProfile: resolved.runtimeProfile });
      const evidence: UnifiedExecIsolationEvidence = { backend: "macos_seatbelt", originalCwd: input.cwd, executionCwd: copy,
        actualCommand: command, policyHash: policy.policyHash, profileHash: prepared.profileHash, inputs: files };
      const environmentSummary: UnifiedExecEnvironmentSummary = { mode: "explicit", cwd: copy,
        keys: prepared.environmentKeys, redactedKeys: [], pathEntryCount: 4 };
      return { evidence, environmentSummary, dispose,
        spawn: () => prepared.spawn(() => {
          check(); this.assertAvailable(input.command);
          requireRuntime(realpathSync(input.cwd) === origin, "restricted_command_workspace_changed");
        }) };
    } catch (error) {
      try { dispose(); } catch { /* Retain an unverifiable temporary root; never delete a replacement. */ }
      throw error;
    }
  }
}
