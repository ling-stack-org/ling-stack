import {
  isRunProviderErrorDiagnostic,
  isRunProviderRetryEvidence,
  type RunEventEnvelope,
  type RunProviderErrorDiagnostic,
} from "@ling-stack/contracts";
import type {
  ConversationTimelineDiagnosticItem,
  ConversationTimelineItem,
  TimelineRunLifecycle,
  TimelineSnapshot,
} from "@ling-stack/conversation-ui-core";
import type { Translate } from "../../i18n.js";

export interface ConversationRunFeedback {
  readonly status: "retrying" | "failed";
  readonly revision: number;
  readonly diagnostic?: RunProviderErrorDiagnostic;
  readonly retryAttempt?: number;
  readonly maxRetryAttempts?: number;
}

const liveRunStatuses = new Set(["queued", "running", "waiting_for_approval"]);
const liveItemStatuses = new Set(["pending", "running", "waiting"]);

/** The scoped adapter's facts, not the workspace run list, authorize journal reads. */
export function conversationFeedbackReadTargets(snapshot: TimelineSnapshot): readonly string[] {
  if (!snapshot.scope.threadId.trim()) return [];
  const targets = new Set<string>();
  const visit = (items: readonly ConversationTimelineItem[]): void => {
    for (const item of items) {
      if (item.runId && item.kind !== "userMessage") {
        const lifecycle = ownedLifecycle(snapshot, item.runId);
        if (lifecycle ? liveRunStatuses.has(lifecycle.status) || lifecycle.status === "failed"
          : liveItemStatuses.has(item.status ?? "")) targets.add(item.runId);
      }
      if (item.kind === "subAgentActivity") visit(item.childItems);
    }
  };
  visit(snapshot.items);
  return [...targets].sort();
}

/** SDK errors are intermediate until the Host records a terminal run outcome. */
export function projectConversationRunFeedback(
  runId: string,
  events: readonly RunEventEnvelope[],
  lifecycle?: TimelineRunLifecycle,
): ConversationRunFeedback | undefined {
  let feedback: ConversationRunFeedback | undefined;
  let modelError: RunProviderErrorDiagnostic | undefined;
  let terminal: "failed" | "succeeded" | "cancelled" | undefined;
  let revision = 0;
  const ordered = events.filter(event => event.runId === runId && Number.isSafeInteger(event.seq) && event.seq >= 0)
    .slice().sort((left, right) => left.seq - right.seq);
  for (const event of ordered) {
    revision = event.seq;
    if (event.type === "run_error") {
      terminal = "failed";
      feedback = { status: "failed", revision, diagnostic: safeDiagnostic(event.data.errorDiagnostic) };
    } else if (event.type === "run_end" || event.type === "run_cancelled") {
      terminal = event.type === "run_end" ? "succeeded" : "cancelled";
      feedback = undefined;
    } else if (event.type === "run_start" || event.type === "run_continuation_started") {
      terminal = undefined;
      modelError = undefined;
      feedback = undefined;
    } else if (!terminal && event.type === "provider_retry" && isRunProviderRetryEvidence(event.data) && event.data.scope === "assistant") {
      if (event.data.phase === "scheduled") {
        feedback = { status: "retrying", revision, diagnostic: event.data.errorDiagnostic,
          retryAttempt: event.data.retryAttempt, maxRetryAttempts: event.data.maxRetryAttempts };
      } else if (event.data.phase === "settled") {
        feedback = undefined;
        modelError = safeDiagnostic(event.data.errorDiagnostic);
      }
    } else if (!terminal && event.type === "progress" && event.data.nativeKind === "error" && typeof event.data.retrying === "boolean") {
      feedback = event.data.retrying ? { status: "retrying", revision } : undefined;
    } else if (!terminal && event.type === "message_end" && event.data.role === "assistant" && event.data.stopReason === "error") {
      modelError = safeDiagnostic(event.data.errorDiagnostic);
    } else if (!terminal && hasResponseActivity(event)) {
      feedback = undefined;
      modelError = undefined;
    }
  }
  const ownStatus = lifecycle?.id === runId ? lifecycle.status : undefined;
  if (ownStatus === "succeeded" || ownStatus === "cancelled" || ownStatus === "yielded") return undefined;
  if (ownStatus === "failed") return feedback?.status === "failed" ? feedback
    : { status: "failed", revision, diagnostic: modelError };
  if (ownStatus === "waiting_for_approval" && feedback?.status === "retrying") return undefined;
  return feedback;
}

/** One stable diagnostic per Run; empty waiting copy yields to the factual status. */
export function projectConversationFeedbackSnapshot(
  snapshot: TimelineSnapshot,
  eventsByRun: ReadonlyMap<string, readonly RunEventEnvelope[]>,
  t: Translate,
): TimelineSnapshot {
  if (!snapshot.scope.threadId.trim()) return snapshot;
  const feedbackByRun = new Map(conversationFeedbackReadTargets(snapshot).flatMap(runId => {
    const feedback = projectConversationRunFeedback(runId, eventsByRun.get(runId) ?? [], ownedLifecycle(snapshot, runId));
    return feedback ? [[runId, feedback] as const] : [];
  }));
  if (!feedbackByRun.size) return snapshot;
  const placed = new Set<string>();
  const projectItems = (source: readonly ConversationTimelineItem[]): readonly ConversationTimelineItem[] => {
    const items = source.map(item => item.kind === "subAgentActivity"
      ? { ...item, childItems: projectItems(item.childItems) } : item);
    const anchors = new Map<string, ConversationTimelineItem>();
    for (const item of items) {
      if (item.runId && item.kind !== "userMessage" && !placed.has(item.runId) && feedbackByRun.has(item.runId)) anchors.set(item.runId, item);
    }
    const result: ConversationTimelineItem[] = [];
    for (const item of items) {
      const feedback = item.runId ? feedbackByRun.get(item.runId) : undefined;
      const waiting = item.kind === "agentMessage" && (item.waitingPlaceholder || !item.markdown.trim())
        && liveItemStatuses.has(item.status ?? "");
      if (!feedback || !waiting) result.push(feedback?.status === "failed" && item.kind === "agentMessage"
        && liveItemStatuses.has(item.status ?? "") ? { ...item, status: "failed" } : item);
      if (item.runId && anchors.get(item.runId) === item) {
        placed.add(item.runId);
        result.push(feedbackItem(item, feedbackByRun.get(item.runId)!, t));
      }
    }
    return result;
  };
  const items = projectItems(snapshot.items);
  const activeFeedback = snapshot.activeRun ? feedbackByRun.get(snapshot.activeRun.runId) : undefined;
  return { ...snapshot, items,
    activeRun: activeFeedback?.status === "failed" ? null : snapshot.activeRun,
    canonicalRevision: Math.max(snapshot.canonicalRevision, ...[...feedbackByRun.values()].map(feedback => feedback.revision)) };
}

function feedbackItem(anchor: ConversationTimelineItem, feedback: ConversationRunFeedback, t: Translate): ConversationTimelineDiagnosticItem {
  const description = feedback.diagnostic ? diagnosticDescription(feedback.diagnostic, t) : undefined;
  return {
    id: `diagnostic:run-feedback:${anchor.runId}`,
    kind: "diagnostic", code: "run_feedback", runId: anchor.runId, turnId: anchor.turnId,
    participantId: anchor.participantId, revision: feedback.revision,
    threadSequence: anchor.threadSequence, partIndex: anchor.partIndex + 1,
    status: feedback.status === "failed" ? "failed" : "running",
    sourceRefs: [{ kind: "run", id: anchor.runId! }],
    title: feedback.status === "retrying" ? t("Retrying automatically...")
      : feedback.diagnostic ? t("Model response failed") : t("Response failed"),
    meta: feedback.status === "retrying" && feedback.retryAttempt !== undefined && feedback.maxRetryAttempts !== undefined
      ? t("Retry {attempt} of {maximum}", { attempt: feedback.retryAttempt, maximum: feedback.maxRetryAttempts }) : undefined,
    description, summary: description,
  };
}

function ownedLifecycle(snapshot: TimelineSnapshot, runId: string): TimelineRunLifecycle | undefined {
  const lifecycle = snapshot.runLifecycles?.get(runId);
  return lifecycle?.id === runId ? lifecycle : undefined;
}

function safeDiagnostic(value: unknown): RunProviderErrorDiagnostic | undefined {
  return isRunProviderErrorDiagnostic(value) ? value : undefined;
}

function hasResponseActivity(event: RunEventEnvelope): boolean {
  if (event.type === "assistant_text_delta" || event.type === "assistant_thinking_delta" || event.type === "assistant_reasoning_summary") return Boolean(event.data.text.trim());
  return event.type === "tool_start" || event.type === "tool_update" || event.type === "tool_end" || event.type === "approval_requested";
}

function diagnosticDescription(diagnostic: RunProviderErrorDiagnostic, t: Translate): string {
  const descriptions: Record<RunProviderErrorDiagnostic["category"], string> = {
    authentication: t("The model service rejected authentication."),
    permission_denied: t("The model service denied access."),
    invalid_request: t("The model service rejected the request."),
    context_limit: t("The model context limit was reached."),
    rate_limited: t("The model service is rate limiting requests."),
    quota_exhausted: t("The model service quota was exhausted."),
    provider_unavailable: t("The model service is unavailable."),
    timeout: t("The model request timed out."),
    network: t("The model connection was interrupted."),
    cancelled: t("The model request was cancelled."),
    unknown: t("The model service could not complete the response."),
  };
  return [descriptions[diagnostic.category], diagnostic.httpStatus === undefined ? undefined
    : t("HTTP status {status}", { status: diagnostic.httpStatus }), diagnostic.code].filter(Boolean).join(" · ");
}
