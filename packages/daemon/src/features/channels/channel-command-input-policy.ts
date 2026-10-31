import { createHash } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  isChannelCommandInputScopeV1,
  type ChannelCommandInputScopeV1,
} from "@ling-stack/contracts";
import {
  createChannelWorkspaceSnapshot,
  resolveSessionRunPolicy,
  type ApprovalToolDecision,
  type RunStore,
} from "@ling-stack/core";
import { resolveAiTeammateReference } from "../teammates/identity.js";
import { teammateCanWorkInEffectiveChannel } from "./channel-teammate-availability.js";
import { resolveEffectiveChannelCollaborationProtocol } from "./collaboration-protocol.js";

interface ChannelCommandInputPolicyContext {
  readonly store: RunStore;
  readonly channelId: string;
  readonly participantId: string;
  readonly operationId: string;
  readonly sourceItemId: string;
  /** The owning Store's workspace root, not the channel's execution directory. */
  readonly workspaceCwd: string;
}

/**
 * Host-only compiler. This reads canonical metadata, never project file contents,
 * and issues no authority when read needs approval. Existing plans are not callers.
 */
export function compileChannelCommandInputPolicyScope(
  input: ChannelCommandInputPolicyContext,
): ChannelCommandInputScopeV1 | undefined {
  return input.store.readSnapshot(() => {
    if (!input.channelId.trim() || !input.participantId.trim() || !input.operationId.trim()
      || !input.sourceItemId.trim()) return;
    const channel = input.store.getChannel(input.channelId);
    const owner = resolveAiTeammateReference(input.store, input.participantId);
    if (!channel || channel.status !== "active" || !channel.allowedTools.includes("read")
      || !owner || owner.status !== "active" || owner.hidden || !owner.allowedTools.includes("read")
      || owner.workspaceId !== channel.workspaceId
      || !teammateCanWorkInEffectiveChannel(input.store, channel, owner.id)) return;
    const membership = input.store.listTeammateChannelMemberships(owner.id)
      .filter(item => item.channelId === channel.id);
    const councilMembership = input.store.getEffectiveChannelCouncil(channel.id)?.specialists
      .filter(item => item.teammateId === owner.id)
      .map(item => ({ teammateId: item.teammateId, sources: item.sources, isDefault: item.isDefault }));
    const defaultTeammateId = resolveEffectiveChannelCollaborationProtocol({ store: input.store, channel })
      .protocol.defaultTeammateId;
    const workspacePolicy = input.store.getApprovalPolicy();
    if (workspacePolicy.workspaceId !== channel.workspaceId) return;
    // Workflow execution currently has no session override. Do not substitute
    // workspace settings.default* here: that can turn an actual read=ask into allow.
    const effective = resolveSessionRunPolicy({ workspacePolicy, approvalProfile: owner.approvalProfile,
      channelBoundPath: channel.boundPath });
    if (effective.approvalPolicy.toolDecisions.read !== "allow") return;

    const source = input.store.getEffectiveConversationItem(input.sourceItemId);
    if (!source || source.id !== input.sourceItemId || source.kind !== "user_message"
      || source.actorType !== "local_user" || source.status !== "committed"
      || source.channelId !== channel.id || source.workspaceId !== channel.workspaceId || !source.turnId) return;
    const turn = input.store.getLingTurn(source.turnId);
    const thread = input.store.getLingThread(source.threadId);
    const assignment = input.store.getEffectiveTurnContextAssignment(source.turnId);
    if (!turn || turn.sourceItemId !== source.id || turn.threadId !== source.threadId || turn.channelId !== channel.id
      || turn.workspaceId !== channel.workspaceId || !thread || thread.channelId !== channel.id
      || thread.workspaceId !== channel.workspaceId || !assignment || assignment.turnId !== turn.id
      || !["committed", "provisional"].includes(assignment.status)) return;
    const segment = input.store.getContextSegment(assignment.segmentId);
    if (!segment || segment.threadId !== thread.id || !["active", "provisional"].includes(segment.state)) return;

    const workspaceRoot = directoryIdentity(input.workspaceCwd);
    const storeRoot = directoryIdentity(input.store.paths.cwd);
    if (!workspaceRoot || !storeRoot || !isDeepStrictEqual(workspaceRoot, storeRoot)) return;
    const snapshot = createChannelWorkspaceSnapshot(channel, input.store.paths.cwd);
    if (snapshot.status !== "ready") return;
    const executionRoot = directoryIdentity(snapshot.executionCwd);
    if (!executionRoot) return;
    // Filesystem metadata is not covered by SQLite's read snapshot. Probe again
    // after the canonical reads, and stop if either path was replaced meanwhile.
    if (!isDeepStrictEqual(workspaceRoot, directoryIdentity(input.workspaceCwd))
      || !isDeepStrictEqual(storeRoot, directoryIdentity(input.store.paths.cwd))
      || !isDeepStrictEqual(executionRoot, directoryIdentity(snapshot.executionCwd))) return;

    const policyFingerprint = createHash("sha256").update(canonicalJson({
      workspacePolicy, effectivePolicy: effective.snapshot,
      channel: { id: channel.id, workspaceId: channel.workspaceId, status: channel.status,
        allowedTools: channel.allowedTools, runtimePolicy: channel.runtimePolicy,
        boundPath: channel.boundPath, workspaceBinding: channel.workspaceBinding, updatedAt: channel.updatedAt },
      owner: { id: owner.id, workspaceId: owner.workspaceId, status: owner.status, hidden: owner.hidden,
        allowedTools: owner.allowedTools, approvalProfile: owner.approvalProfile, updatedAt: owner.updatedAt,
        roleKey: owner.roleKey, systemRole: owner.systemRole, modelBindingMode: owner.modelBindingMode,
        providerPresetId: owner.providerPresetId, runnerId: owner.runnerId,
        systemPrompt: owner.systemPrompt, appendSystemPrompt: owner.appendSystemPrompt },
      participantId: input.participantId, operationId: input.operationId, membership, councilMembership, defaultTeammateId,
      source,
      // Do not bind to normal Run/turn lifecycle status changes. The source's
      // identity/assignment is the fence, not whether its execution has started.
      turn: { id: turn.id, threadId: turn.threadId, channelId: turn.channelId, workspaceId: turn.workspaceId,
        sourceItemId: turn.sourceItemId },
      thread: { id: thread.id, channelId: thread.channelId, workspaceId: thread.workspaceId },
      assignment, segment: { id: segment.id, threadId: segment.threadId, state: segment.state },
      workspaceRoot, executionRoot,
    })).digest("hex");
    const scope: ChannelCommandInputScopeV1 = {
      kind: "node_module_closure_v1", projectRoot: ".", sourceRefs: [],
      policyAuthority: { kind: "channel_effective_policy_v1", channelId: channel.id,
        workspaceId: channel.workspaceId, participantId: input.participantId, operationId: input.operationId,
        sourceItemId: source.id, sourceRevision: source.revision,
        workspaceCwd: workspaceRoot.path, executionCwd: executionRoot.path,
        workspaceRootIdentity: workspaceRoot.identity, executionRootIdentity: executionRoot.identity,
        channelUpdatedAt: channel.updatedAt, workspacePolicyUpdatedAt: workspacePolicy.updatedAt, policyFingerprint },
    };
    return isChannelCommandInputScopeV1(scope) ? scope : undefined;
  });
}

/** Revalidate only frozen policy scopes; never enlarge a legacy or quoted scope. */
export function assertChannelCommandInputPolicyCurrent(input: Omit<ChannelCommandInputPolicyContext, "sourceItemId"> & {
  readonly scope: ChannelCommandInputScopeV1 | undefined;
  readonly effectiveReadDecision?: ApprovalToolDecision;
}): void {
  if (!input.scope || input.scope.policyAuthority === undefined) return;
  if (input.effectiveReadDecision !== undefined && input.effectiveReadDecision !== "allow") {
    throw policyError("restricted_command_input_read_not_allowed");
  }
  if (!isChannelCommandInputScopeV1(input.scope)) throw policyError("restricted_command_input_policy_changed");
  let current: ChannelCommandInputScopeV1 | undefined;
  try {
    current = compileChannelCommandInputPolicyScope({ ...input, sourceItemId: input.scope.policyAuthority.sourceItemId });
  } catch (cause) {
    throw Object.assign(new Error("restricted_command_input_policy_changed", { cause }), {
      code: "restricted_command_input_policy_changed",
    });
  }
  if (!current || !isDeepStrictEqual(current, input.scope)) throw policyError("restricted_command_input_policy_changed");
}

function policyError(code: "restricted_command_input_policy_changed" | "restricted_command_input_read_not_allowed"): Error {
  return Object.assign(new Error(code), { code });
}

function directoryIdentity(path: string): {
  readonly path: string;
  readonly identity: { readonly device: string; readonly inode: string };
} | undefined {
  if (!isAbsolute(path)) return;
  try {
    const requested = resolve(path);
    const before = lstatSync(requested, { bigint: true });
    if (!before.isDirectory() || before.isSymbolicLink()) return;
    const canonical = realpathSync.native(requested);
    const actual = lstatSync(canonical, { bigint: true });
    const after = lstatSync(requested, { bigint: true });
    if (!actual.isDirectory() || actual.isSymbolicLink() || !after.isDirectory() || after.isSymbolicLink()
      || before.dev !== actual.dev || before.ino !== actual.ino
      || before.dev !== after.dev || before.ino !== after.ino || realpathSync.native(requested) !== canonical) return;
    return { path: canonical, identity: { device: actual.dev.toString(), inode: actual.ino.toString() } };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error
      && ["ENOENT", "ENOTDIR", "EACCES", "EPERM", "ELOOP"].includes(String(error.code))) return;
    throw error;
  }
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, current: unknown) => {
    if (current && typeof current === "object" && !Array.isArray(current)) {
      return Object.fromEntries(Object.entries(current).sort(([left], [right]) => left.localeCompare(right)));
    }
    return current;
  });
}
