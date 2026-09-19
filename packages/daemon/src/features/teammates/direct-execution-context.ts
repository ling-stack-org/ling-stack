import {
  permissionModeForPreset,
  type AiTeammate,
  type AuthorizationMode,
  type LingThread,
  type PermissionConfirmation,
  type PermissionPreset,
  type RunTool,
  type RunStore,
  type SkillOptimizationMode,
  type TeammateDirectMessage,
  type TeammateDirectThread,
  type WorkspaceAccessMode,
} from "@ling-stack/core";
import type { RunRequest } from "../runs/schemas.js";
import type { DirectWorkspaceReady } from "./direct-workspace.js";

export interface TeammateDirectExecutionContext {
  readonly thread: LingThread;
  readonly runRequest: RunRequest;
}

export function resolveTeammateDirectExecutionContext(input: {
  readonly store: RunStore;
  readonly teammate: AiTeammate;
  readonly directThread: TeammateDirectThread;
  readonly sourceMessage: TeammateDirectMessage;
  readonly replyMessage: TeammateDirectMessage;
  readonly providerPresetId: string;
  readonly workspace: DirectWorkspaceReady;
  readonly prompt: string;
  readonly systemPrompt: string;
  readonly authorizationMode?: AuthorizationMode;
  readonly workspaceAccessMode?: WorkspaceAccessMode;
  readonly permissionPreset?: PermissionPreset;
  readonly permissionConfirmation?: PermissionConfirmation;
  readonly requestedSkillId?: string;
  readonly skillOptimizationMode?: SkillOptimizationMode;
  readonly continuationReason?: "queue_followup" | "interrupt_redirect";
  readonly toolsOverride?: readonly RunTool[];
  readonly idempotencyKeyOverride?: string;
}): TeammateDirectExecutionContext {
  const now = new Date().toISOString();
  const thread = ensureTeammateDirectLingThread(input.store, input.teammate, input.directThread, now);
  const permissionMode = input.permissionPreset ? permissionModeForPreset(input.permissionPreset) : undefined;
  return {
    thread,
    runRequest: {
      cwd: input.workspace.executionCwd,
      workspaceCwd: input.store.paths.cwd,
      providerPresetId: input.providerPresetId,
      teammateId: input.teammate.id,
      runnerId: input.teammate.runnerId,
      threadId: thread.id,
      sourceMessageId: input.sourceMessage.id,
      linkedMessageId: input.replyMessage.id,
      createdByActor: input.sourceMessage.authorType === "system" ? "system" : "local-user",
      requestedSkillId: input.requestedSkillId,
      skillOptimizationMode: input.skillOptimizationMode,
      tools: input.toolsOverride ?? input.teammate.allowedTools,
      approvalProfile: input.teammate.approvalProfile,
      authorizationMode: input.authorizationMode,
      workspaceAccessMode: input.workspaceAccessMode,
      permissionPreset: input.permissionPreset,
      permissionMode,
      permissionConfirmation: input.permissionConfirmation,
      thinkingLevel: "medium",
      systemPrompt: input.systemPrompt,
      skipMemoryRecall: true,
      directWorkspaceBinding: input.workspace.binding,
      directWorkspaceSnapshot: input.workspace.snapshot,
      continuationReason: input.continuationReason,
      idempotencyKey: input.idempotencyKeyOverride ?? `teammate_direct_run:${input.sourceMessage.id}:${input.replyMessage.id}`,
      task: {
        id: input.sourceMessage.id,
        title: `Private chat with ${input.teammate.displayName}`,
        prompt: input.prompt,
      },
    },
  };
}

function ensureTeammateDirectLingThread(
  store: RunStore,
  teammate: AiTeammate,
  directThread: TeammateDirectThread,
  now: string,
): LingThread {
  const existing = store.findLingThreadByOwner({ kind: "teammate_direct", teammateId: teammate.id });
  if (existing) {
    if (existing.status === "archived") {
      throw new Error(`Teammate direct Ling thread is archived: ${existing.id}`);
    }
    return existing;
  }
  return store.createLingThread({
    kind: "teammate_direct",
    teammateId: teammate.id,
    title: directThread.title || `Private chat with ${teammate.displayName}`,
    objective: `Private conversation with ${teammate.displayName}`,
    status: "open",
  }, now);
}
