import type { TeammateDirectMessage } from "@ling-stack/contracts";
import type { RunEventEnvelope, RunStore } from "@ling-stack/core";
import { ConversationNarrationAccumulator } from "../conversations/narration-segments.js";
import { createOwnedRunNarrationAccumulator } from "../conversations/narration-owner.js";
import type { RunExecutionSink } from "../runs/orchestrator.js";
import { projectTeammateDirectMessageNarration, projectTeammateDirectNarrationSnapshot, projectTeammateDirectReplyText } from "./direct-message-narration.js";
import { isTeammateDirectMessageInScope, resolveTeammateDirectRunOwner, type TeammateDirectScope } from "./direct-run-owner.js";
export { projectTeammateDirectReplyText } from "./direct-message-narration.js";

export interface TeammateDirectReplyStream {
  readonly onReady: (message: TeammateDirectMessage) => void;
  readonly onRunLinked?: (message: TeammateDirectMessage) => void;
  readonly onDelta: (message: TeammateDirectMessage, delta: string) => void;
  readonly onDone: (message: TeammateDirectMessage) => void;
  readonly onBlocked: (message: TeammateDirectMessage) => void;
}

export function createTeammateDirectRunProjection(input: {
  readonly store: RunStore;
  readonly pendingMessageId: string;
  readonly scope: TeammateDirectScope & { readonly canonicalThreadId: string; readonly turnId: string };
  readonly signal?: AbortSignal;
  readonly stream?: TeammateDirectReplyStream;
  readonly onRunLinked?: (link: { readonly runId: string; readonly workUnitId: string; readonly attemptId?: string }) => void;
}): {
  readonly sink: RunExecutionSink;
  readonly text: () => string;
  readonly runId: () => string | undefined;
  readonly error: () => string | undefined;
} {
  let runId: string | undefined;
  let errorMessage: string | undefined;
  let narration = new ConversationNarrationAccumulator();
  let visibleText = "";
  let visibleNarrationRevision = 0;
  let visibleSourceRevision = 0;
  const closeListeners: (() => void)[] = [];
  if (input.signal) {
    input.signal.addEventListener("abort", () => {
      for (const listener of closeListeners.splice(0)) {
        listener();
      }
    }, { once: true });
  }
  const sink: RunExecutionSink = {
    kind: "detached",
    onClose(listener) {
      if (input.signal?.aborted) {
        listener();
        return;
      }
      closeListeners.push(listener);
    },
    isClosed() {
      return input.signal?.aborted === true;
    },
    writeReady(data) {
      const linkedRunId = readRunId(data);
      if (!linkedRunId) {
        return;
      }
      if (runId === linkedRunId) return;
      const pending = input.store.getTeammateDirectMessage(input.pendingMessageId);
      const prepared = input.store.readSnapshot(() => {
        const owner = resolveTeammateDirectRunOwner(input.store, linkedRunId, { ...input.scope, replyMessageId: input.pendingMessageId });
        return owner ? { owner, narration: createOwnedRunNarrationAccumulator(input.store, linkedRunId, {
          threadId: input.scope.canonicalThreadId, turnId: input.scope.turnId,
          participantId: input.scope.teammateId, kind: "teammate_direct",
        }) } : undefined;
      });
      const owner = prepared?.owner;
      if (runId || !pending || pending.authorType !== "ai-teammate" ||
        !isTeammateDirectMessageInScope(pending, input.scope) || !owner ||
        (pending.linkedRunId && pending.linkedRunId !== linkedRunId)) {
        throw new Error("Teammate direct live Run owner scope mismatch");
      }
      runId = linkedRunId;
      narration = prepared!.narration;
      const linked = input.store.updateTeammateDirectMessageRuntime(
        input.pendingMessageId,
        { linkedRunId, status: "pending", errorMessage: null },
        new Date().toISOString(),
      );
      const { run } = owner;
      const workUnit = run?.workUnitId ? input.store.getWorkUnit(run.workUnitId) : undefined;
      if (workUnit) {
        input.onRunLinked?.({ runId: linkedRunId, workUnitId: workUnit.id, attemptId: narration.sourceLineage?.attemptId });
      }
      if (linked) {
        input.stream?.onRunLinked?.(linked);
      }
    },
    writeEvent(_event, data) {
      const envelope = data as RunEventEnvelope;
      if (!runId || envelope.runId !== runId) return;
      narration.append(envelope);
      if (envelope.type !== "assistant_text_delta" && envelope.type !== "message_end"
        && narration.sourceRevision === visibleSourceRevision) {
        return;
      }
      const snapshot = narration.snapshot();
      const projected = projectTeammateDirectNarrationSnapshot(snapshot);
      const nextVisibleText = projected.content;
      const nextRevision = projected.narrationSegments.at(-1)?.endEventSequence ?? 0;
      if (nextVisibleText === visibleText && nextRevision === visibleNarrationRevision
        && narration.sourceRevision === visibleSourceRevision) {
        return;
      }
      const visibleDelta = nextVisibleText.startsWith(visibleText)
        ? nextVisibleText.slice(visibleText.length)
        : nextVisibleText;
      visibleText = nextVisibleText;
      visibleNarrationRevision = nextRevision;
      visibleSourceRevision = narration.sourceRevision;
      const updated = input.store.updateTeammateDirectMessageRuntime(
        input.pendingMessageId,
        { body: visibleText, status: "pending", errorMessage: null },
        envelope.ts,
      );
      if (updated) {
        input.stream?.onDelta(projectTeammateDirectMessageNarration(input.store, updated, snapshot), visibleDelta);
      }
    },
    writeError(_statusCode, body) {
      errorMessage = readErrorMessage(body);
    },
    end() {},
  };
  return {
    sink,
    text: () => projectTeammateDirectReplyText(narration.snapshot().content),
    runId: () => runId,
    error: () => errorMessage,
  };
}

function readRunId(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const runId = (value as Record<string, unknown>).runId;
  return typeof runId === "string" && runId.trim() ? runId : undefined;
}

function readErrorMessage(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return "Private execution failed.";
  }
  const message = (value as Record<string, unknown>).message;
  return typeof message === "string" && message.trim() ? message : "Private execution failed.";
}
