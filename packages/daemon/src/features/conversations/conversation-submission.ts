import type { ConversationStreamRequest } from "@ling-stack/contracts";
import type { LingThread, LingTurn, RunStore } from "@ling-stack/core";
import type { RunnerRegistry } from "../../runtime/runners.js";
import type { LingImageVisionSummarizer } from "../channels/materialization/registry.js";
import { buildEffectiveConfigResponse } from "../settings/effective-config.js";
import { resolveConversationExecutionSelection } from "./conversation-execution-selection.js";
import { buildConversationRunRequest } from "./conversation-run-request.js";
import { materializeInlineConversationAttachments } from "./materialization.js";
import { prepareNormalConversationInput } from "./normal-conversation-input.js";
import { saveNormalConversationPreparedRequest } from "./normal-conversation-prepared-request.js";
import { readConversationSubmission } from "./submission-receipts.js";
import { withProjectInstructions } from "./project-instructions.js";
import { assertWorkItemConversationAdmission } from "../work-items/conversation-admission.js";

export async function prepareConversationSubmission(options: {
  readonly store: RunStore;
  readonly workspaceCwd: string;
  readonly runnerRegistry: RunnerRegistry;
  readonly input: ConversationStreamRequest;
  readonly now: string;
  readonly resolveThread: () => LingThread;
  readonly title?: string;
  readonly turnKind?: LingTurn["kind"];
  readonly imageVisionSummarizer?: LingImageVisionSummarizer;
}) {
  const { store, workspaceCwd, runnerRegistry, input, now } = options;
  const accepted = input.idempotencyKey ? readConversationSubmission(store, {
    surface: "normal", idempotencyKey: input.idempotencyKey, threadId: input.threadId,
  }) : undefined;
  const selection = accepted?.status === "accepted" ? undefined : resolveConversationExecutionSelection(store, runnerRegistry, input);
  const thread = options.resolveThread();
  const acceptedTurn = accepted?.status === "accepted" && accepted.turnId ? store.getLingTurn(accepted.turnId) : undefined;
  if (!(acceptedTurn?.activeRunId || acceptedTurn?.lastRunId)) {
    assertWorkItemConversationAdmission(store, thread.id, input.idempotencyKey);
  }
  const fileRefs = input.fileRefs ?? [];
  const prepared = prepareNormalConversationInput({
    store, thread, message: input.message,
    title: options.title ?? conversationTitle(input.message || (fileRefs.some(ref => ref.annotation) ? "Please address the review feedback." : "User attached files.")),
    attachmentIds: input.attachmentIds ?? [], fileRefs, idempotencyKey: input.idempotencyKey,
    turnKind: options.turnKind, now,
  });
  const { turn, attachments } = prepared;
  if (prepared.replayRequest) return { thread, turn, attachments, runRequest: prepared.replayRequest, replayed: true };

  const attachmentMaterializations = await materializeInlineConversationAttachments({
    store, attachments, now, imageVisionSummarizer: options.imageVisionSummarizer,
  });
  const effectiveConfig = await buildEffectiveConfigResponse({ cwd: workspaceCwd, store, runnerRegistry });
  const request = buildConversationRunRequest({
    workspaceCwd, thread, turn,
    input: { ...input, ...(selection ?? resolveConversationExecutionSelection(store, runnerRegistry, input)), idempotencyKey: prepared.idempotencyKey },
    lingConversationTone: effectiveConfig.values.lingConversationTone.value,
    defaultReasoningSummary: effectiveConfig.values.reasoningSummary.value,
    attachments, attachmentMaterializations, normalConversationContext: prepared.context,
    normalConversationAcceptedSnapshotId: prepared.acceptedSnapshotId,
  });
  const runRequest = saveNormalConversationPreparedRequest(store,
    await withProjectInstructions(workspaceCwd, request, store.getWorkspaceSettings().claudeProjectRules), now);
  return { thread, turn, attachments, runRequest, replayed: accepted?.status === "accepted" };
}

export function conversationTitle(message: string): string {
  const oneLine = message.replace(/\s+/g, " ").trim();
  return oneLine.length > 48 ? `${oneLine.slice(0, 45)}...` : oneLine || "New conversation";
}
