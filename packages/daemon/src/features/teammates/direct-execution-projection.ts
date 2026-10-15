import type { TeammateDirectMessage } from "@ling-stack/contracts";
import type { RunEventEnvelope, RunStore, RuntimeAttemptFenceV1, WorkUnitAttempt } from "@ling-stack/core";
import { ConversationNarrationAccumulator } from "../conversations/narration-segments.js";
import { createOwnedRunNarrationAccumulator } from "../conversations/narration-owner.js";
import type { RunExecutionSink } from "../runs/orchestrator.js";
import { projectTeammateDirectMessageNarration, projectTeammateDirectNarrationSnapshot, projectTeammateDirectReplyText } from "./direct-message-narration.js";
import type { TeammateDirectScope } from "./direct-run-owner.js";
import { teammateDirectMessageRuntimeScope } from "./direct-message-lifecycle.js";
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
  readonly fence: () => RuntimeAttemptFenceV1 | undefined;
  readonly error: () => string | undefined;
} {
  let runId: string | undefined;
  let errorMessage: string | undefined;
  let narration = new ConversationNarrationAccumulator();
  let visibleText = "";
  let visibleNarrationRevision = 0;
  let visibleSourceRevision = 0;
  let sourceFence: RuntimeAttemptFenceV1 | undefined;
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
      const fence = readReadySourceFence(data);
      if (!linkedRunId || !fence) {
        return;
      }
      if (runId === linkedRunId) return;
      const prepared = input.store.readSnapshot(() => {
        const pending = input.store.getTeammateDirectMessage(input.pendingMessageId);
        if (!pending) return undefined;
        const observation = input.store.getTeammateDirectMessageRuntimeObservation(teammateDirectMessageRuntimeScope(pending, linkedRunId));
        if (!observation) return undefined;
        if (observation.state.kind !== "active" || !matchesReadySourceFence(observation.attempt, fence)) return { observation };
        return { observation, narration: createOwnedRunNarrationAccumulator(input.store, linkedRunId, {
          threadId: input.scope.canonicalThreadId, turnId: input.scope.turnId,
          participantId: input.scope.teammateId, kind: "teammate_direct",
        }) };
      });
      const observation = prepared?.observation;
      // A late ready callback can arrive after the message was linked to a successor.
      // It has no execution capability and must not turn a stale callback into a failure.
      if (runId || !observation || observation.state.kind === "indeterminate") return;
      if (observation.message.teammateId !== input.scope.teammateId ||
        observation.message.threadId !== input.scope.directThreadId || observation.run?.threadId !== input.scope.canonicalThreadId ||
        observation.turn?.id !== input.scope.turnId) {
        throw new Error("Teammate direct live Run owner scope mismatch");
      }
      if (observation.state.kind !== "active" || !observation.attempt || !prepared?.narration) return;
      const committed = input.store.commitTeammateDirectMessageRuntime({ expected: observation,
        operation: { kind: "execution", fence, patch: { linkedRunId, status: "pending", errorMessage: null } } }, new Date().toISOString());
      if (committed.kind !== "applied" && committed.kind !== "unchanged") return;
      runId = linkedRunId;
      sourceFence = fence;
      narration = prepared.narration;
      const linked = committed.message;
      const workUnit = observation.workUnit;
      if (workUnit) {
        input.onRunLinked?.({ runId: linkedRunId, workUnitId: workUnit.id, attemptId: fence.attemptId });
      }
      if (!input.signal?.aborted) {
        input.stream?.onRunLinked?.(linked);
      }
    },
    writeEvent(_event, data) {
      const envelope = data as RunEventEnvelope;
      if (!runId || !sourceFence || envelope.runId !== runId) return;
      const pending = input.store.getTeammateDirectMessage(input.pendingMessageId);
      if (!pending) return;
      const expected = input.store.getTeammateDirectMessageRuntimeObservation(teammateDirectMessageRuntimeScope(pending, runId));
      if (!expected || expected.state.kind !== "active") return;
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
      const committed = input.store.commitTeammateDirectMessageRuntime({ expected,
        operation: { kind: "execution", fence: sourceFence, patch: { body: visibleText, status: "pending", errorMessage: null } } }, envelope.ts);
      if ((committed.kind === "applied" || committed.kind === "unchanged") && !input.signal?.aborted) {
        input.stream?.onDelta(projectTeammateDirectMessageNarration(input.store, committed.message, snapshot), visibleDelta);
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
    fence: () => sourceFence,
    error: () => errorMessage,
  };
}

/** Ready identifies its producer, never a capability borrowed from the latest owning Attempt. */
function readReadySourceFence(value: unknown): RuntimeAttemptFenceV1 | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const source = Reflect.get(value, "sourceFence");
  if (!source || typeof source !== "object" || Array.isArray(source)) return undefined;
  const workUnitId = Reflect.get(source, "workUnitId"), attemptId = Reflect.get(source, "attemptId");
  const runtimeInstanceId = Reflect.get(source, "runtimeInstanceId"), fencingToken = Reflect.get(source, "fencingToken");
  if (typeof workUnitId !== "string" || !workUnitId.trim() || typeof attemptId !== "string" || !attemptId.trim()
    || typeof runtimeInstanceId !== "string" || !runtimeInstanceId.trim() || typeof fencingToken !== "string" || !fencingToken.trim()) return undefined;
  return Object.freeze({ workUnitId, attemptId, runtimeInstanceId, fencingToken });
}

function matchesReadySourceFence(attempt: WorkUnitAttempt | undefined, source: RuntimeAttemptFenceV1): boolean {
  return Boolean(attempt && attempt.workUnitId === source.workUnitId && attempt.id === source.attemptId
    && attempt.runtimeInstanceId === source.runtimeInstanceId && attempt.fencingToken === source.fencingToken);
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
