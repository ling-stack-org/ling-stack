import type { RunEventEnvelope, RunStore, TeammateDirectMessage } from "@ling-stack/core";
import type { RunExecutionSink } from "../runs/orchestrator.js";

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
  const textDeltas: string[] = [];
  let visibleText = "";
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
      runId = linkedRunId;
      const linked = input.store.updateTeammateDirectMessageRuntime(
        input.pendingMessageId,
        { linkedRunId, status: "pending", errorMessage: null },
        new Date().toISOString(),
      );
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
      if (envelope.type !== "assistant_text_delta") {
        return;
      }
      const delta = readEventText(envelope.data);
      if (!delta) {
        return;
      }
      textDeltas.push(delta);
      const nextVisibleText = projectTeammateDirectReplyText(textDeltas.join(""));
      if (nextVisibleText === visibleText) {
        return;
      }
      const visibleDelta = nextVisibleText.startsWith(visibleText)
        ? nextVisibleText.slice(visibleText.length)
        : nextVisibleText;
      visibleText = nextVisibleText;
      const updated = input.store.updateTeammateDirectMessageRuntime(
        input.pendingMessageId,
        { body: visibleText, status: "pending", errorMessage: null },
        envelope.ts,
      );
      if (updated) {
        input.stream?.onDelta(updated, visibleDelta);
      }
    },
    writeError(_statusCode, body) {
      errorMessage = readErrorMessage(body);
    },
    end() {},
  };
  return {
    sink,
    text: () => projectTeammateDirectReplyText(textDeltas.join("")),
    runId: () => runId,
    error: () => errorMessage,
  };
}

const DIRECT_RECEIPT_HEAD = String.raw`(?:(?:好的|好)[，,\s]*)?(?:已)?收到(?:了)?`;
const DIRECT_RECEIPT_ECHO = String.raw`(?:[：:,，]\s*[^。\r\n！？!?]{0,80})?`;
const DIRECT_RECEIPT_END = String.raw`[。！？!?]`;
const directReceiptLinePattern = new RegExp(
  String.raw`^${DIRECT_RECEIPT_HEAD}${DIRECT_RECEIPT_ECHO}${DIRECT_RECEIPT_END}?[\t ]*(?:\r?\n)+`,
  "u",
);
const directReceiptSentencePattern = new RegExp(
  String.raw`^${DIRECT_RECEIPT_HEAD}${DIRECT_RECEIPT_ECHO}${DIRECT_RECEIPT_END}[\t ]*(?=\S)`,
  "u",
);
const directReceiptOnlyPattern = new RegExp(
  String.raw`^${DIRECT_RECEIPT_HEAD}${DIRECT_RECEIPT_ECHO}${DIRECT_RECEIPT_END}?\s*$`,
  "u",
);
const partialDirectReceiptPattern = new RegExp(
  String.raw`^(?:好|好的|好的[，,\s]*|已|已收|收|收到(?:了)?(?:[：:,，]\s*[^。\r\n！？!?]{0,80})?)$`,
  "u",
);

export function projectTeammateDirectReplyText(value: string): string {
  const source = value.trimStart();
  const leadingReceipt = directReceiptLinePattern.exec(source) ?? directReceiptSentencePattern.exec(source);
  if (leadingReceipt) {
    return source.slice(leadingReceipt[0].length).trimStart();
  }
  if (directReceiptOnlyPattern.test(source) || partialDirectReceiptPattern.test(source)) {
    return "";
  }
  return value;
}

function readRunId(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const runId = (value as Record<string, unknown>).runId;
  return typeof runId === "string" && runId.trim() ? runId : undefined;
}

function readEventText(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return "";
  }
  const text = (value as Record<string, unknown>).text;
  return typeof text === "string" ? text : "";
}

function readErrorMessage(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return "Private execution failed.";
  }
  const message = (value as Record<string, unknown>).message;
  return typeof message === "string" && message.trim() ? message : "Private execution failed.";
}
