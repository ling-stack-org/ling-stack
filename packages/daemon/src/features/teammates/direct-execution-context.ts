import {
  permissionModeForPreset,
  type AiTeammate,
  type AuthorizationMode,
  type LingThread,
  type PermissionConfirmation,
  type PermissionPreset,
  type ResponseLanguage,
  type RunTool,
  type RunStore,
  type SkillOptimizationMode,
  type TeammateDirectMessage,
  type TeammateDirectThread,
  type WorkspaceAccessMode,
} from "@ling-stack/core";
import type { RunRequest } from "../runs/schemas.js";
import type { DirectWorkspaceReady } from "./direct-workspace.js";
import { ingestTeammateDirectExecutionSource } from "./direct-execution-ingest.js";

export interface TeammateDirectExecutionContext {
  readonly thread: LingThread;
  readonly runRequest: RunRequest & { readonly turnId: string };
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
  readonly responseLanguage?: ResponseLanguage;
  readonly requestedSkillId?: string;
  readonly skillOptimizationMode?: SkillOptimizationMode;
  readonly continuationReason?: "queue_followup" | "interrupt_redirect";
  readonly toolsOverride?: readonly RunTool[];
  readonly idempotencyKeyOverride?: string;
}): TeammateDirectExecutionContext {
  if (input.directThread.teammateId !== input.teammate.id
    || [input.sourceMessage, input.replyMessage].some((message) =>
      message.threadId !== input.directThread.id || message.teammateId !== input.teammate.id)) {
    throw new Error("Teammate direct execution scope mismatch");
  }
  if (input.sourceMessage.authorType !== "local-user" && input.sourceMessage.authorType !== "system") {
    throw new Error("Teammate direct execution source must be a user or system message");
  }
  const now = new Date().toISOString();
  const thread = ensureTeammateDirectLingThread(input.store, input.teammate, input.directThread, now);
  const accepted = ingestTeammateDirectExecutionSource({
    store: input.store,
    thread,
    directThread: input.directThread,
    message: input.sourceMessage,
    title: `Private chat with ${input.teammate.displayName}`,
    executionInput: { prompt: input.prompt, systemPrompt: input.systemPrompt },
    continuationReason: input.continuationReason,
  }, now);
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
      turnId: accepted.turnId,
      teammateDirectInputRef: { id: accepted.inputSnapshot.id, fingerprint: accepted.inputSnapshot.fingerprint },
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
      responseLanguage: input.responseLanguage,
      thinkingLevel: "medium",
      systemPrompt: accepted.inputSnapshot.payload.systemPrompt,
      skipMemoryRecall: true,
      directWorkspaceBinding: input.workspace.binding,
      directWorkspaceSnapshot: input.workspace.snapshot,
      continuationReason: input.continuationReason,
      idempotencyKey: input.idempotencyKeyOverride ?? `teammate_direct_run:${input.sourceMessage.id}:${input.replyMessage.id}`,
      task: {
        id: input.sourceMessage.id,
        title: `Private chat with ${input.teammate.displayName}`,
        prompt: accepted.inputSnapshot.payload.prompt,
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
