import {
  projectConversationItemToChannelMessage,
  type ChannelMessage,
  type RunEventEnvelope,
  type RunStore,
} from "@ling-stack/core";
import type { RunExecutionSink } from "../runs/orchestrator.js";
import { updatePendingAssistantMessage } from "./conversation-item-messages.js";

export interface ChannelReplyRunProjection {
  readonly sink: RunExecutionSink;
  readonly runId: () => string | undefined;
  readonly rawText: () => string;
  readonly visibleText: () => string;
  readonly error: () => string | undefined;
  readonly promptLeakDetected: () => boolean;
}

export const CHANNEL_PROMPT_LEAK_PENDING_BODY = "AI teammate response was blocked because the runner echoed internal channel context.";
export const CHANNEL_PROMPT_LEAK_ERROR_MESSAGE = "Runner echoed internal channel context instead of an assistant reply.";

export function createChannelReplyRunProjection(input: {
  readonly store: RunStore;
  readonly pendingMessageId: string;
  readonly stream?: {
    readonly onRunLinked?: (message: ChannelMessage) => void;
    readonly onDelta: (message: ChannelMessage, delta: string) => void;
  };
  readonly onRunLinked?: (link: { readonly runId: string; readonly workUnitId: string; readonly attemptId?: string }) => void;
}): ChannelReplyRunProjection {
  let runId: string | undefined;
  let errorMessage: string | undefined;
  let rawText = "";
  let visibleText = "";
  let promptLeakDetected = false;

  const sink: RunExecutionSink = {
    kind: "detached",
    onClose() {},
    isClosed() {
      return false;
    },
    writeReady(data) {
      const linkedRunId = readRunId(data);
      if (!linkedRunId) {
        return;
      }
      runId = linkedRunId;
      const pendingItem = input.store.getConversationItem(input.pendingMessageId);
      const linked = pendingItem
        ? projectConversationItemToChannelMessage(pendingItem, { linkedRunId })
        : undefined;
      const run = input.store.getRun(linkedRunId);
      const workUnit = run?.workUnitId ? input.store.getWorkUnit(run.workUnitId) : undefined;
      if (workUnit) {
        input.onRunLinked?.({ runId: linkedRunId, workUnitId: workUnit.id, attemptId: workUnit.activeAttemptId });
      }
      if (linked) {
        input.stream?.onRunLinked?.(linked);
      }
    },
    writeEvent(_event, data) {
      const envelope = data as RunEventEnvelope;
      if (envelope.type === "assistant_text_delta") {
        const delta = readEventText(envelope.data);
        if (delta) {
          rawText += delta;
          projectVisibleMessage();
        }
        return;
      }
      if (envelope.type === "message_end" && !rawText.trim()) {
        const finalText = readEventText(envelope.data);
        if (finalText) {
          rawText = finalText;
          projectVisibleMessage();
        }
        return;
      }
      if (envelope.type === "run_error") {
        errorMessage = readErrorMessage(envelope.data);
      }
    },
    writeError(_statusCode, body) {
      errorMessage = readErrorMessage(body);
    },
    end() {},
  };

  function projectVisibleMessage(): void {
    const nextVisibleText = visibleChannelReplyTextSoFar(rawText);
    if (promptLeakDetected || isChannelReplyPromptLeak(nextVisibleText)) {
      promptLeakDetected = true;
      updatePendingBody(CHANNEL_PROMPT_LEAK_PENDING_BODY, "");
      return;
    }
    if (nextVisibleText === visibleText) {
      return;
    }
    const delta = nextVisibleText.startsWith(visibleText)
      ? nextVisibleText.slice(visibleText.length)
      : nextVisibleText;
    visibleText = nextVisibleText;
    updatePendingBody(visibleText, delta);
  }

  function updatePendingBody(body: string, delta: string): void {
    const updated = updatePendingAssistantMessage({
      store: input.store,
      itemId: input.pendingMessageId,
      body,
      status: "pending",
      errorMessage: null,
      now: new Date().toISOString(),
    });
    input.stream?.onDelta(updated, delta);
  }

  return {
    sink,
    runId: () => runId,
    rawText: () => rawText,
    visibleText: () => visibleText,
    error: () => errorMessage,
    promptLeakDetected: () => promptLeakDetected,
  };
}

export function isChannelReplyPromptLeak(raw: string): boolean {
  const text = raw.trim();
  const blockedPrefixes = [
    "Channel collaboration protocol:",
    "Recent channel context before the latest turn:",
    "Reply as the channel AI teammate. Keep the response actionable and brief.",
  ];
  if (blockedPrefixes.some((prefix) => text.startsWith(prefix))) {
    return true;
  }
  if (/^Attachments:\s*(?:none)?/u.test(text) && text.includes("Link previews:")) {
    return true;
  }
  if (text.length < 80) {
    return false;
  }
  const markers = [
    "Channel collaboration protocol:",
    "Response language:",
    "Auto reply mode:",
    "Default workflow preference:",
    "Private teammate chat, hidden prompts, provider secrets",
    "Recent channel context before the latest turn:",
    "Use this context to resolve short follow-ups",
    "Reply as the channel AI teammate. Keep the response actionable and brief.",
    "Current teammate:",
    "User message:",
    "Attachments:",
    "Link previews:",
    "Workspace file refs:",
  ];
  const matchedMarkers = markers.filter((marker) => text.includes(marker));
  const hasProtocol = text.includes("Channel collaboration protocol:");
  const hasReplyInstruction = text.includes("Reply as the channel AI teammate. Keep the response actionable and brief.");
  const hasRecentContext = text.includes("Recent channel context before the latest turn:");
  const hasEnvelopeCluster =
    (text.includes("Attachments:") || text.includes("Attachments: none")) &&
    (text.includes("Link previews:") || text.includes("Link previews: none")) &&
    (text.includes("Workspace file refs:") || text.includes("Workspace file refs: none"));
  return (
    (hasReplyInstruction && (hasProtocol || hasEnvelopeCluster || hasRecentContext)) ||
    (hasProtocol && matchedMarkers.length >= 4) ||
    (hasEnvelopeCluster && matchedMarkers.length >= 5)
  );
}

export function visibleChannelReplyTextSoFar(raw: string): string {
  const visible = stripHiddenProposalText(raw);
  if (visible.length !== raw.length) {
    return visible;
  }
  const marker = "<ling_task_proposal";
  const lower = raw.toLowerCase();
  const maxPrefixLength = Math.min(marker.length - 1, lower.length);
  for (let length = maxPrefixLength; length > 0; length -= 1) {
    if (marker.startsWith(lower.slice(-length))) {
      return raw.slice(0, raw.length - length);
    }
  }
  return raw;
}

export function visibleChannelReplyText(raw: string): string {
  return stripHiddenProposalText(raw).trim();
}

function stripHiddenProposalText(raw: string): string {
  return raw
    .replace(/<ling_task_proposal[\s\S]*?<\/ling_task_proposal>/giu, "")
    .replace(/<ling_task_proposal[\s\S]*$/iu, "");
}

function readRunId(value: unknown): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const runId = value.runId;
  return typeof runId === "string" && runId.trim() ? runId : undefined;
}

function readEventText(value: unknown): string {
  if (!isRecord(value)) {
    return "";
  }
  const text = value.text;
  return typeof text === "string" ? text : "";
}

function readErrorMessage(value: unknown): string {
  if (!isRecord(value)) {
    return "Channel reply run failed.";
  }
  const message = value.message;
  return typeof message === "string" && message.trim() ? message : "Channel reply run failed.";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
