import {
  type RunSession,
  type RunStore,
  type RuntimeAttemptFenceV1,
  type TeammateDirectMessageRuntimeObservation,
  type TeammateDirectMessageRuntimePatch,
  type TeammateDirectMessageRuntimeScope,
} from "@ling-stack/core";
import type { TeammateDirectMessage } from "@ling-stack/contracts";
import { formatServerCatalogMessage, isSupportedLocale } from "@ling-stack/localization";
import { fallbackResponseLanguage } from "../channels/response-language.js";
import { appendControlPlaneEvent, type ControlPlaneEventHub } from "../control-plane/events.js";
import { runHasConversationGeneratedMedia } from "../media/conversation-projection.js";
import { projectTeammateDirectMessageNarration } from "./direct-message-narration.js";

interface DirectMessageLifecycleView {
  readonly observation: TeammateDirectMessageRuntimeObservation;
  readonly message: TeammateDirectMessage;
  readonly terminal: boolean;
}

export interface DirectMessageLifecycleSettlement {
  readonly message: TeammateDirectMessage;
  readonly terminal: boolean;
}

interface DirectMessageLifecycleOptions {
  readonly runId?: string;
  readonly workUnitId?: string;
  readonly controlPlaneEvents?: ControlPlaneEventHub;
  readonly cancelledReason?: string;
  /** Live Runner settlement cannot borrow a successor Attempt's Host reconciliation authority. */
  readonly sourceFence?: RuntimeAttemptFenceV1;
  readonly requireSourceFence?: boolean;
}

export function teammateDirectMessageRuntimeScope(message: TeammateDirectMessage, runId?: string,
  workUnitId?: string): TeammateDirectMessageRuntimeScope {
  return { workspaceId: message.workspaceId, teammateId: message.teammateId, threadId: message.threadId,
    messageId: message.id, ...(runId ? { runId } : {}), ...(workUnitId ? { workUnitId } : {}) };
}

/** Core owns lineage/proof validation; narration, media and lifecycle share its read snapshot. */
function readLifecycleView(store: RunStore, scope: TeammateDirectMessageRuntimeScope,
  cancelledReason?: string): DirectMessageLifecycleView | undefined {
  return store.readSnapshot(() => {
    const observation = store.getTeammateDirectMessageRuntimeObservation(scope);
    if (!observation) return undefined;
    const { state, run } = observation;
    if (state.kind === "indeterminate" || state.kind === "unlinked") {
      return { observation, message: observation.message, terminal: false };
    }
    const linkedMessage = run ? { ...observation.message, linkedRunId: run.id } : observation.message;
    const narrated = projectTeammateDirectMessageNarration(store, linkedMessage);
    if (state.kind !== "terminal") {
      return { observation, message: { ...narrated, status: "pending", errorMessage: undefined }, terminal: false };
    }
    // A stored empty-result/error fallback is not model narration on the next GET/reconciliation.
    const text = narrated.narrationSegments?.length ? narrated.body.trim() : "";
    if (state.status === "cancelled") {
      const reason = cancelledReason ?? (observation.message.status === "cancelled"
        ? observation.message.errorMessage ?? "Reply stopped" : "Reply stopped");
      return { observation, message: { ...narrated, body: text || reason, status: "cancelled", errorMessage: reason }, terminal: true };
    }
    // Core permits a Run-less terminal observation only for proved pre-dispatch cancellation.
    if (!run) return { observation, message: observation.message, terminal: false };
    if (state.status === "succeeded") {
      if (text || runHasConversationGeneratedMedia(store, run.id)) {
        return { observation, message: { ...narrated, body: text, status: "ready", errorMessage: undefined }, terminal: true };
      }
      const language = run.requestSnapshot && typeof run.requestSnapshot === "object"
        ? Reflect.get(run.requestSnapshot, "responseLanguage") : undefined;
      const reason = formatServerCatalogMessage(isSupportedLocale(language) ? language : fallbackResponseLanguage(undefined),
        "daemon.conversation.empty_result");
      return { observation, message: { ...narrated, body: reason, status: "failed", errorMessage: reason }, terminal: true };
    }
    const reason = run.errorMessage || "Private execution failed.";
    return { observation, message: { ...narrated, body: text || `AI teammate is blocked: ${reason}`,
      status: "failed", errorMessage: reason }, terminal: true };
  });
}

/** Pure GET projection: neither repairs SQLite nor dispatches a continuation. */
export function projectTeammateDirectMessageLifecycle(store: RunStore, message: TeammateDirectMessage): TeammateDirectMessage {
  if (message.authorType !== "ai-teammate") return message;
  const view = readLifecycleView(store, teammateDirectMessageRuntimeScope(message));
  return view ? { ...message, ...view.message } : message;
}

function lifecyclePatch(message: TeammateDirectMessage): TeammateDirectMessageRuntimePatch {
  return { body: message.body, status: message.status, errorMessage: message.errorMessage ?? null,
    linkedRunId: message.linkedRunId };
}

/** A physical Runner return may describe an active execution or a committed logical wait. */
export function settleTeammateDirectMessage(store: RunStore, message: TeammateDirectMessage,
  options: DirectMessageLifecycleOptions = {}): DirectMessageLifecycleSettlement {
  const scope = teammateDirectMessageRuntimeScope(message, options.runId, options.workUnitId);
  const view = readLifecycleView(store, scope, options.cancelledReason);
  if (!view) return { message, terminal: false };
  if (options.requireSourceFence && !options.sourceFence
    || options.sourceFence && !matchesSourceAttempt(view.observation, options.sourceFence)) {
    return { message: view.message, terminal: false };
  }
  if (view.observation.state.kind === "indeterminate" || view.observation.state.kind === "unlinked") {
    return { message: view.message, terminal: false };
  }
  const committed = store.commitTeammateDirectMessageRuntime({ expected: view.observation,
    operation: { kind: "reconcile", patch: lifecyclePatch(view.message) } }, new Date().toISOString());
  if (committed.kind === "applied" || committed.kind === "unchanged") {
    if (committed.kind === "applied") publishDirectMessageRuntimeChange(store, committed.message, options.controlPlaneEvents);
    return { message: { ...view.message, ...committed.message, narrationSegments: view.message.narrationSegments }, terminal: view.terminal };
  }
  // Never rebase old text or an old terminal decision onto a successor Attempt.
  const current = readLifecycleView(store, teammateDirectMessageRuntimeScope(message));
  return { message: current?.message ?? store.getTeammateDirectMessage(message.id) ?? message, terminal: false };
}

function matchesSourceAttempt(observation: TeammateDirectMessageRuntimeObservation, source: RuntimeAttemptFenceV1): boolean {
  const current = observation.attempt;
  return Boolean(current && current.status !== "lost" && current.status !== "yielded"
    && current.workUnitId === source.workUnitId && current.id === source.attemptId
    && current.runtimeInstanceId === source.runtimeInstanceId && current.fencingToken === source.fencingToken);
}

/** Only the not-yet-dispatched message may receive preparation/progress updates. */
export function updateUndispatchedTeammateDirectMessage(store: RunStore, message: TeammateDirectMessage,
  patch: TeammateDirectMessageRuntimePatch): TeammateDirectMessage | undefined {
  const expected = store.getTeammateDirectMessageRuntimeObservation(teammateDirectMessageRuntimeScope(message));
  if (!expected || expected.state.kind !== "unlinked") return undefined;
  const committed = store.commitTeammateDirectMessageRuntime({ expected,
    operation: { kind: "pre_dispatch", patch } }, new Date().toISOString());
  return committed.kind === "applied" || committed.kind === "unchanged" ? committed.message : undefined;
}

/** Recovered execution closes the original reply, not the teammate's newest message. */
export function reconcileTeammateDirectRun(store: RunStore, terminalRun: RunSession,
  controlPlaneEvents?: ControlPlaneEventHub): void {
  if (!terminalRun.teammateId || terminalRun.channelId || terminalRun.workflowStepId || !terminalRun.requestSnapshot) return;
  const request = terminalRun.requestSnapshot;
  if (typeof request !== "object" || Array.isArray(request)) return;
  const messageId = Reflect.get(request, "linkedMessageId");
  if (typeof messageId !== "string") return;
  const message = store.getTeammateDirectMessage(messageId);
  if (!message || message.authorType !== "ai-teammate"
    || message.linkedRunId !== undefined && message.linkedRunId !== terminalRun.id) return;
  settleTeammateDirectMessage(store, message, { runId: terminalRun.id, controlPlaneEvents });
}

/** Bounded startup repair of pending replies after a committed terminal/crash window. */
export function recoverPendingTeammateDirectMessages(store: RunStore, controlPlaneEvents?: ControlPlaneEventHub): void {
  const candidates = store.listWorkUnits({ kind: "teammate_direct_reply", limit: 500 });
  for (const unit of candidates) {
    if (!unit.linkedMessageId) continue;
    const message = store.getTeammateDirectMessage(unit.linkedMessageId);
    if (!message || message.status !== "pending"
      || message.linkedRunId !== undefined && message.linkedRunId !== unit.linkedRunId) continue;
    if (!unit.linkedRunId) {
      if (unit.status === "cancelled") settleTeammateDirectMessage(store, message, { workUnitId: unit.id, controlPlaneEvents });
      continue;
    }
    const run = store.getRun(unit.linkedRunId);
    if (run && ["succeeded", "failed", "cancelled"].includes(run.status)) reconcileTeammateDirectRun(store, run, controlPlaneEvents);
  }
}

function publishDirectMessageRuntimeChange(store: RunStore, message: TeammateDirectMessage,
  hub: ControlPlaneEventHub | undefined): void {
  if (!hub) return;
  appendControlPlaneEvent(store, hub, { workspaceId: message.workspaceId, cwd: store.paths.cwd,
    domain: "runs", entityType: "teammate_direct_message", entityId: message.id,
    action: "teammate.direct_message_runtime_changed", data: { teammateId: message.teammateId,
      threadId: message.threadId, messageId: message.id, runId: message.linkedRunId ?? null, status: message.status } });
}
