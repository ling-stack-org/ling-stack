import { createHash } from "node:crypto";
import {
  channelOperationPlanFingerprintV1, hasExplicitChannelOperationPathQuoteV1,
  isChannelIntentExecutionPlanV1, isChannelIntentPendingOperationV1, isChannelOperationRelativePathV1,
  type ChannelIntentExecutionPlanV1, type ChannelIntentPendingOperationV1, type RequiredParticipantManifestV1,
} from "@ling-stack/contracts";
import { channelPendingOperationFingerprintV1, type RunStore } from "@ling-stack/core";
import { channelOperationContinuationContext } from "./channel-operation-sources.js";
import { listEffectiveChannelAiTeammateEntries } from "./channel-teammate-availability.js";
import { resolveEffectiveChannelCollaborationProtocol } from "./collaboration-protocol.js";
import { assertChannelOperationWorkspacePath } from "./channel-operation-bindings.js";
import { LING_AGENT_EXECUTOR_ID } from "./ling-agent-executor.js";

/** A proposal identity, not permission to execute. No provider credentials enter this snapshot. */
export function channelPendingAuthorityFingerprint(store: RunStore, channelId: string, sandbox: unknown): string {
  const channel = store.getChannel(channelId);
  if (!channel || channel.status !== "active") throw new Error("channel_pending_operation.channel_unavailable");
  const settings = store.getWorkspaceSettings();
  const { updatedAt: _protocolUpdatedAt, ...protocol } = resolveEffectiveChannelCollaborationProtocol({ store, channel }).protocol;
  const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
    : value && typeof value === "object" ? Object.fromEntries(Object.entries(value)
      .filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => [key, canonical(item)])) : value;
  return createHash("sha256").update(JSON.stringify(canonical({
    channel: { id: channel.id, status: channel.status, boundPath: channel.boundPath,
      authorityRevision: channel.updatedAt,
      workspaceBinding: channel.workspaceBinding, defaultProviderPresetId: channel.defaultProviderPresetId,
      defaultTeammateId: channel.defaultTeammateId, allowedTools: channel.allowedTools, runtimePolicy: channel.runtimePolicy },
    protocol,
    participants: [...listEffectiveChannelAiTeammateEntries(store, channel)].sort((a, b) => a.teammate.id.localeCompare(b.teammate.id)),
    executor: store.getAiTeammate(LING_AGENT_EXECUTOR_ID),
    permissions: { authorization: settings.defaultAuthorizationMode, access: settings.defaultWorkspaceAccessMode,
      mode: settings.defaultPermissionMode, preset: settings.defaultPermissionPreset, approval: store.getApprovalPolicy() },
    sandbox,
  }))).digest("hex");
}

export function freezeChannelPendingOperation(input: {
  readonly store: RunStore; readonly sourceItemId: string; readonly channelId: string;
  readonly execution: ChannelIntentExecutionPlanV1; readonly slots: unknown; readonly sandbox?: unknown;
  readonly participantManifest: RequiredParticipantManifestV1;
}): ChannelIntentPendingOperationV1 {
  const source = input.store.getEffectiveConversationItem(input.sourceItemId);
  if (!source || source.id !== input.sourceItemId || source.kind !== "user_message" || source.actorType !== "local_user"
    || source.status !== "committed" || source.channelId !== input.channelId) throw new Error("channel_pending_operation.invalid_source");
  const assignment = source.turnId && input.store.getEffectiveTurnContextAssignment(source.turnId);
  if (!assignment) throw new Error("channel_pending_operation.invalid_source");
  const candidate = { schemaVersion: 1, sourceRevision: source.revision,
    sourceAssignmentId: assignment.id, sourceAssignmentRevision: assignment.revision,
    authorityFingerprint: channelPendingAuthorityFingerprint(input.store, input.channelId, input.sandbox),
    execution: structuredClone(input.execution), slots: structuredClone(input.slots), fingerprint: "0".repeat(64) };
  const withParticipants = { ...candidate, participantManifest: structuredClone(input.participantManifest) };
  if (!isChannelIntentPendingOperationV1(withParticipants)) throw new Error("channel_pending_operation.invalid_draft");
  return { ...withParticipants, fingerprint: channelPendingOperationFingerprintV1(withParticipants) };
}

export function channelPendingOperationForAnswer(store: RunStore, sourceItemId: string) {
  const continuation = channelOperationContinuationContext({ store, sourceItemId });
  const decision = continuation && store.getChannelIntentDecision(continuation.anchor.clarificationDecisionId);
  const pending = decision?.clarification?.pendingOperation;
  return continuation && decision && pending ? { continuation, decision, pending } : undefined;
}

export interface ChannelPendingScopePatch {
  readonly operationId: string; readonly field: "project_input_root"; readonly path: string; readonly sourceQuote: string;
}

/** This payload can fill only named slots. It has no owner, command, output or policy fields. */
export interface ChannelPendingAnswerPatch {
  readonly pendingDecisionId: string; readonly draftFingerprint: string; readonly answerItemId: string;
  readonly answerRevision: number; readonly patches: readonly ChannelPendingScopePatch[];
}

function exactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && Object.keys(value).length === keys.length && Object.keys(value).every(key => keys.includes(key));
}

export function parseChannelPendingAnswerPatch(value: unknown): ChannelPendingAnswerPatch {
  if (!exactKeys(value, ["pendingDecisionId", "draftFingerprint", "answerItemId", "answerRevision", "patches"])
    || typeof value.pendingDecisionId !== "string" || !value.pendingDecisionId
    || typeof value.draftFingerprint !== "string" || !/^[a-f0-9]{64}$/u.test(value.draftFingerprint)
    || typeof value.answerItemId !== "string" || !value.answerItemId
    || !Number.isSafeInteger(value.answerRevision) || Number(value.answerRevision) < 0
    || !Array.isArray(value.patches) || !value.patches.length || value.patches.length > 64
    || !value.patches.every(patch => exactKeys(patch, ["operationId", "field", "path", "sourceQuote"])
      && typeof patch.operationId === "string" && patch.operationId && patch.field === "project_input_root"
      && typeof patch.path === "string" && typeof patch.sourceQuote === "string" && patch.sourceQuote.trim())) {
    throw new Error("channel_pending_operation.invalid_patch");
  }
  return value as unknown as ChannelPendingAnswerPatch;
}

/** Recheck inside the synchronous publication transaction too, after any model await. */
export function applyChannelPendingAnswerPatch(input: {
  readonly store: RunStore; readonly sourceItemId: string; readonly patch: ChannelPendingAnswerPatch; readonly sandbox?: unknown;
}): ChannelIntentExecutionPlanV1 {
  const context = channelPendingOperationForAnswer(input.store, input.sourceItemId);
  if (!context) throw new Error("channel_pending_operation.retired_request");
  const { continuation, decision, pending } = context;
  const answer = continuation.confirmation, patch = parseChannelPendingAnswerPatch(input.patch);
  const assignment = input.store.getEffectiveTurnContextAssignment(decision.sourceTurnId);
  if (patch.pendingDecisionId !== decision.id || patch.draftFingerprint !== pending.fingerprint
    || pending.fingerprint !== channelPendingOperationFingerprintV1(pending)
    || pending.sourceRevision !== continuation.source.revision || patch.answerItemId !== answer.itemId
    || pending.sourceAssignmentId !== assignment?.id || pending.sourceAssignmentRevision !== assignment.revision
    || patch.answerRevision !== answer.revision || pending.authorityFingerprint !== channelPendingAuthorityFingerprint(
      input.store, decision.channelId, input.sandbox)) throw new Error("channel_pending_operation.stale_patch");
  if (patch.patches.length !== pending.slots.length || new Set(patch.patches.map(item => item.operationId)).size !== patch.patches.length
    || patch.patches.some(item => !pending.slots.some(slot => slot.operationId === item.operationId && slot.field === item.field))) {
    throw new Error("channel_pending_operation.slot_mismatch");
  }
  const channel = input.store.getChannel(decision.channelId)!;
  const operations = pending.execution.operations.map(operation => {
    const slot = patch.patches.find(item => item.operationId === operation.id);
    if (!slot) return structuredClone(operation);
    const binding = operation.binding!;
    const outsideCommand = answer.body.split(binding.effectScope.exactCommands[0]!).join(" ")
      .split(binding.commandGoal?.invocation ?? "\u0000").join(" ");
    if (slot.sourceQuote !== answer.body || !isChannelOperationRelativePathV1(slot.path)
      || slot.path.split("/").some(part => part.startsWith("."))
      || !hasExplicitChannelOperationPathQuoteV1(outsideCommand, slot.path)
      || !binding.inputRefs.some(ref => ref.path.startsWith(slot.path + "/") && /\.(?:mjs|cjs|js)$/u.test(ref.path))) {
      throw new Error("channel_pending_operation.invalid_project_scope");
    }
    assertChannelOperationWorkspacePath(slot.path, channel.boundPath ?? input.store.paths.cwd);
    return { ...structuredClone(operation), binding: { ...structuredClone(binding),
      sourceRefs: [...binding.sourceRefs, { itemId: answer.itemId, revision: answer.revision,
        actorType: "local_user" as const, quote: answer.body }],
      commandInputScope: { kind: "node_module_closure_v1" as const, projectRoot: slot.path,
        sourceRefs: [{ itemId: answer.itemId, revision: answer.revision, actorType: "local_user" as const, quote: slot.path }] } } };
  });
  const execution = { bindingVersion: 1 as const, operations, fingerprint: channelOperationPlanFingerprintV1(operations) };
  if (!isChannelIntentExecutionPlanV1(execution)) throw new Error("channel_pending_operation.resolved_plan_invalid");
  return execution;
}
