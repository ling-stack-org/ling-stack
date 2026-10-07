import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { EffectiveRunPolicySnapshot, ExecutionSandboxBackendIdentity } from "@ling-stack/core";
import { captureProtectedHostStagePaths, type ProtectedHostStagePaths } from "./protected-host-stage-paths.js";
import { buildMacosSeatbeltProfile, MACOS_SYSTEM_READ_ROOTS } from "./macos-seatbelt-profile.js";
import type { PreparedMacosSandboxAuthority } from "./macos-native-command.js";
import { readProtectedHostBootstrapReadRoots } from "./protected-host-bootstrap-domain.js";

import { PROTECTED_HOST_COMMAND_ARENA_PARENT as arenaParent, PROTECTED_HOST_COMMAND_ARENA_NAME as arenaName,
  protectedHostPathInside } from "./protected-host-domain-paths.js";
export { protectedHostPathInside } from "./protected-host-domain-paths.js";
const overlap = (first: string, second: string): boolean => protectedHostPathInside(first, second) || protectedHostPathInside(second, first);
const sameRoots = (actual: readonly string[], expected: readonly string[]): boolean =>
  isDeepStrictEqual([...actual].sort(), [...new Set(expected)].sort());
function requireDomain(value: unknown): asserts value {
  if (!value) throw new Error("protected_host_actor_domain_unverified");
}

/** An over-approximation of actual owned launcher allows. It only rejects stages, never grants execution. */
export interface ProtectedHostActorDomain {
  readonly backend: ExecutionSandboxBackendIdentity;
  readonly staticReadRoots: readonly string[];
}

/** Verify every original prepared policy/profile and its real directory topology before aggregating it. */
export function captureProtectedHostActorDomain(authority: PreparedMacosSandboxAuthority, input: {
  readonly origin: string;
  readonly effectivePolicy: EffectiveRunPolicySnapshot;
  readonly protectedRoots: readonly string[];
}): ProtectedHostActorDomain {
  const policy = authority.policy, fs = policy.filesystem;
  requireDomain(fs && policy.platform === "darwin" && policy.executionMode === "native_required"
    && policy.tool === "bash" && policy.networkMode === "disabled" && policy.grants.length === 0
    && policy.fullAccessConfirmedAt === null && fs.writeRoots.length === 0
    && policy.workspaceAccessMode === "workspace_write"
    && policy.authorizationMode === input.effectivePolicy.authorizationMode
    && policy.workspacePolicyUpdatedAt === input.effectivePolicy.workspacePolicyUpdatedAt
    && policy.approvalDecision === input.effectivePolicy.toolDecisions.bash
    && isDeepStrictEqual(policy.backend, authority.backend)
    && authority.profile === buildMacosSeatbeltProfile(policy));
  const root = dirname(fs.workspaceRoot);
  requireDomain(dirname(root) === arenaParent && arenaName.test(basename(root))
    && fs.workspaceRoot === join(root, "workspace") && policy.cwd === fs.workspaceRoot
    && fs.temporaryRoot === join(root, "scratch"));
  const deniedReads = [input.origin, ...input.protectedRoots, join(fs.workspaceRoot, ".ling")];
  requireDomain(sameRoots(fs.deniedReadRoots, deniedReads) && sameRoots(fs.deniedWriteRoots,
    [...deniedReads, ...[".git", ".agents", ".codex", ".ling"].map(name => join(fs.workspaceRoot, name))]));
  const staticReadRoots = fs.readRoots.filter(path => path !== fs.workspaceRoot);
  requireDomain(sameRoots(fs.readRoots, [fs.workspaceRoot, ...staticReadRoots])
    && MACOS_SYSTEM_READ_ROOTS.every(path => staticReadRoots.includes(path))
    && staticReadRoots.every(path => !overlap(path, root)));
  // The namespace string is only a conservative upper bound after original launcher facts and FDs agree.
  const held: ProtectedHostStagePaths[] = [];
  try {
    for (const path of [root, fs.workspaceRoot, fs.temporaryRoot]) {
      held.push(captureProtectedHostStagePaths(path));
      const stat = lstatSync(path);
      requireDomain(stat.uid === process.getuid?.() && (stat.mode & 0o077) === 0);
    }
    for (const path of staticReadRoots) {
      const stat = lstatSync(path);
      requireDomain(!stat.isSymbolicLink() && (stat.isFile() || stat.isDirectory()) && realpathSync(path) === path);
    }
    for (const paths of held) paths.assertCurrent();
  } finally {
    const errors: unknown[] = [];
    for (const paths of held.reverse()) try { paths.close(); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, "protected_host_actor_domain_close_unknown");
  }
  const implicitRoots = readProtectedHostBootstrapReadRoots(authority.backend);
  return Object.freeze({ backend: authority.backend, staticReadRoots: Object.freeze([...new Set([...staticReadRoots, ...implicitRoots])]) });
}

/** All command arenas are reserved even after a leader exits; no descendant-drain or timed expiry is assumed. */
export function assertProtectedHostDomainExcludesStage(domain: ProtectedHostActorDomain, paths: ProtectedHostStagePaths): void {
  const stage = paths.stagePath, child = relative(arenaParent, stage).split("/")[0]!;
  const inArena = protectedHostPathInside(stage, arenaParent) && arenaName.test(child);
  if (inArena || protectedHostPathInside(arenaParent, stage)
    || domain.staticReadRoots.some(root => overlap(root, stage))) throw new Error("protected_host_stage_actor_conflict");
  // Any stage ancestor writable by any arena scratch would put this stage in that arena; refuse that topology.
  if (paths.ancestors.some(path => protectedHostPathInside(path, arenaParent) && arenaName.test(relative(arenaParent, path).split("/")[0]!))) {
    throw new Error("protected_host_stage_ancestor_conflict");
  }
}
