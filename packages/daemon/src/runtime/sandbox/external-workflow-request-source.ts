import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { ExecutionSandboxBackendIdentity } from "@ling-stack/core";
import { defineProtectedHostActorEntry } from "./protected-host-actor-inventory.js";
import { assertProtectedHostExternalWorkflowRequestBinding,
  type ProtectedHostActorPreparation } from "./protected-host-staging.js";
import { readMacosSandboxBackendIdentity } from "./macos-sandbox-backend.js";
import { MACOS_DYLD_PROFILE, MACOS_SANDBOX_EXECUTABLE, MACOS_SYSTEM_READ_ROOTS } from "./macos-seatbelt-profile.js";
import { EXTERNAL_WORKFLOW_REQUEST_WORKER_SOURCE } from "./external-workflow-request-worker-source.js";

const hash = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
const quote = (value: string): string => `"${value.replace(/\\/gu, "\\\\").replace(/"/gu, '\\"')}"`;
const anyPath = (roots: readonly string[]): string =>
  `(require-any ${roots.map(root => `(subpath ${quote(root)})`).join(" ")})`;
function requireRequest(value: unknown, code: string): asserts value {
  if (!value) throw new Error(code);
}
function sameBackend(first: ExecutionSandboxBackendIdentity, second: ExecutionSandboxBackendIdentity): boolean {
  return first.kind === second.kind && first.protocolVersion === second.protocolVersion
    && first.helperVersion === second.helperVersion && first.executableSha256 === second.executableSha256;
}
interface PathFact { readonly path: string; readonly device: string; readonly inode: string; readonly mode: number }
function pathFact(path: string): PathFact {
  requireRequest(isAbsolute(path) && resolve(path) === path, "external_workflow_request_path_invalid");
  const stat = lstatSync(path, { bigint: true });
  requireRequest(!stat.isSymbolicLink() && (stat.isDirectory() || stat.isFile()) && realpathSync(path) === path,
    "external_workflow_request_path_invalid");
  return { path, device: String(stat.dev), inode: String(stat.ino), mode: Number(stat.mode) };
}
export interface PreparedExternalWorkflowRequest {
  readonly backend: ExecutionSandboxBackendIdentity;
  readonly profileHash: string;
  readonly sourceHash: string;
  readonly staticReadRoots: readonly string[];
  readonly spawn: (assertCurrentAuthority: () => void,
    actor: ProtectedHostActorPreparation) => ChildProcessWithoutNullStreams;
}
interface RequestLaunch {
  readonly prepared: PreparedExternalWorkflowRequest;
  readonly actor: ProtectedHostActorPreparation;
  readonly args: readonly string[];
  readonly options: {
    readonly cwd: string;
    readonly env: Readonly<NodeJS.ProcessEnv>;
    readonly detached: true;
    readonly stdio: "pipe";
  };
}
const ownedPrepared = new WeakMap<PreparedExternalWorkflowRequest, Readonly<{
  readonly spawn: PreparedExternalWorkflowRequest["spawn"];
  readonly profile: string;
}>>();
const ownedLaunches = new WeakSet<RequestLaunch>();
const consumedLaunches = new WeakSet<RequestLaunch>();
const ownedChildren = new WeakMap<ChildProcessWithoutNullStreams, PreparedExternalWorkflowRequest>();

export const EXTERNAL_WORKFLOW_REQUEST_ACTOR_ENTRY = defineProtectedHostActorEntry("external_workflow_request",
  (launch: RequestLaunch): ChildProcessWithoutNullStreams => {
    requireRequest(consumedLaunches.delete(launch), "external_workflow_request_launch_invalid");
    assertProtectedHostExternalWorkflowRequestBinding(launch.actor, launch.prepared);
    const child = spawn(MACOS_SANDBOX_EXECUTABLE, [...launch.args], launch.options);
    ownedChildren.set(child, launch.prepared);
    return child;
  }, (launch: RequestLaunch): void => {
    requireRequest(ownedLaunches.delete(launch), "external_workflow_request_launch_invalid");
    assertProtectedHostExternalWorkflowRequestBinding(launch.actor, launch.prepared);
    consumedLaunches.add(launch);
  });

export function isOwnedExternalWorkflowRequestChild(child: ChildProcessWithoutNullStreams,
  prepared: PreparedExternalWorkflowRequest): boolean {
  return ownedChildren.get(child) === prepared;
}

export function readPreparedExternalWorkflowRequestProfile(prepared: PreparedExternalWorkflowRequest): string {
  const state = ownedPrepared.get(prepared);
  requireRequest(state && Object.getOwnPropertyDescriptor(prepared, "spawn")?.value === state.spawn,
    "external_workflow_request_preparation_invalid");
  return state.profile;
}

/**
 * Fixed, no-fork, no-network request launcher. The worker may read and write only the
 * admitted workspace plus its private scratch directory and fixed runtime resources.
 */
export function prepareExternalWorkflowRequest(input: {
  readonly root: string;
  readonly scratch: string;
  readonly executable: string;
  readonly runtimeReadRoots: readonly string[];
}): PreparedExternalWorkflowRequest {
  requireRequest(process.platform === "darwin", "external_workflow_request_platform_unavailable");
  const root = realpathSync(input.root), scratch = realpathSync(input.scratch), executable = realpathSync(input.executable);
  requireRequest(root === input.root && scratch === input.scratch && executable === input.executable,
    "external_workflow_request_path_invalid");
  const scratchStat = lstatSync(scratch);
  requireRequest(scratchStat.isDirectory() && scratchStat.uid === process.getuid?.() && (scratchStat.mode & 0o077) === 0,
    "external_workflow_request_scratch_invalid");
  requireRequest(Buffer.byteLength(EXTERNAL_WORKFLOW_REQUEST_WORKER_SOURCE) <= 96 * 1024,
    "external_workflow_request_source_invalid");
  const backend = readMacosSandboxBackendIdentity();
  const staticReadRoots = Object.freeze([...new Set([...MACOS_SYSTEM_READ_ROOTS, executable, ...input.runtimeReadRoots, root])]);
  requireRequest(staticReadRoots.length <= 128, "external_workflow_request_root_budget_exceeded");
  const profile = [
    "(version 1)", "(deny default)", `(import ${quote(MACOS_DYLD_PROFILE)})`,
    `(allow process-exec (literal ${quote(executable)}))`, "(allow sysctl-read)", "(allow signal (target same-sandbox))",
    "(allow file-read-metadata)",
    `(allow file-read* file-map-executable ${anyPath([...staticReadRoots, scratch])})`,
    `(allow file-write* ${anyPath([root, scratch])})`,
    "(allow file-read* (literal \"/dev/null\") (literal \"/dev/zero\") (literal \"/dev/random\") (literal \"/dev/urandom\"))",
    "(allow file-write-data (literal \"/dev/null\") (literal \"/dev/zero\"))",
    "(deny process-fork)", "(deny network*)",
  ].join("\n");
  requireRequest(Buffer.byteLength(profile) <= 65_536, "external_workflow_request_profile_too_large");
  const facts = [pathFact(root), pathFact(scratch), pathFact(executable), ...input.runtimeReadRoots.map(pathFact)];
  const env = Object.freeze({ PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "en_US.UTF-8", HOME: scratch,
    TMPDIR: `${scratch}/`, PWD: root, ELECTRON_RUN_AS_NODE: "1", LING_STACK_SANDBOX: "external-workflow-request-v1" });
  let consumed = false;
  const prepared: PreparedExternalWorkflowRequest = Object.freeze({ backend, profileHash: hash(profile),
    sourceHash: hash(EXTERNAL_WORKFLOW_REQUEST_WORKER_SOURCE), staticReadRoots,
    spawn(assertCurrentAuthority: () => void, actor: ProtectedHostActorPreparation): ChildProcessWithoutNullStreams {
      requireRequest(this === prepared && !consumed && typeof assertCurrentAuthority === "function",
        "external_workflow_request_launch_invalid");
      consumed = true;
      requireRequest(sameBackend(readMacosSandboxBackendIdentity(), backend), "external_workflow_request_backend_changed");
      for (const fact of facts) requireRequest(JSON.stringify(pathFact(fact.path)) === JSON.stringify(fact),
        "external_workflow_request_path_changed");
      const authorityResult: unknown = assertCurrentAuthority();
      requireRequest(authorityResult === undefined, "external_workflow_request_authority_async");
      assertProtectedHostExternalWorkflowRequestBinding(actor, prepared);
      const launch: RequestLaunch = Object.freeze({ prepared, actor,
        args: Object.freeze(["-p", profile, executable, "--eval", EXTERNAL_WORKFLOW_REQUEST_WORKER_SOURCE]),
        options: Object.freeze({ cwd: root, env, detached: true, stdio: "pipe" }) });
      ownedLaunches.add(launch);
      return EXTERNAL_WORKFLOW_REQUEST_ACTOR_ENTRY.invoke(actor, launch);
    },
  });
  ownedPrepared.set(prepared, Object.freeze({ spawn: prepared.spawn, profile }));
  return prepared;
}
