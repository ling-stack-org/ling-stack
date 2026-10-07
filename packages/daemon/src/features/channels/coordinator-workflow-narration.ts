import type { ChannelWorkflowOrchestrationResponse } from "@ling-stack/contracts";
import type { ChannelExecutionProposal, ChannelMessage, ChannelWorkflow, RunStore } from "@ling-stack/core";
import { formatServerCatalogMessage } from "@ling-stack/localization";
import { fallbackResponseLanguage, inferUserLanguage } from "./response-language.js";

type NarrationContext = {
  readonly proposal: Pick<ChannelExecutionProposal, "responseLanguage" | "channelId">;
  readonly sourceMessage: Pick<ChannelMessage, "body">;
};

export interface CoordinatorWorkflowNarration {
  readonly body: string;
  readonly status: "ready" | "blocked" | "failed";
  readonly state: "started" | "queued" | "waiting_for_approval" | "idle" | "completed" | "blocked" | "failed" | "cancelled";
  readonly verifiedRunIds: readonly string[];
}

/** Pending delivery is an acknowledgement, never evidence that a Run started. */
export function coordinatorWorkflowCheckingBody(input: NarrationContext): string {
  return message(input, "checking");
}

/** A thrown dispatch failure follows the same language policy as other states. */
export function coordinatorWorkflowFailedBody(input: NarrationContext, error: unknown): string {
  return message(input, "failed_state", { reason: error instanceof Error ? error.message : String(error) });
}

/** Project only the current dispatch result; terminal outcomes remain owned by reports. */
export function projectCoordinatorWorkflowNarration(input: NarrationContext & {
  readonly store: Pick<RunStore, "getRun" | "getChannelWorkflowStep">;
  readonly workflow: Pick<ChannelWorkflow, "id" | "channelId">;
  readonly orchestration?: ChannelWorkflowOrchestrationResponse;
}): CoordinatorWorkflowNarration {
  const result = input.orchestration;
  const narration = (
    state: CoordinatorWorkflowNarration["state"],
    body: string,
    status: CoordinatorWorkflowNarration["status"] = "ready",
    verifiedRunIds: readonly string[] = [],
  ): CoordinatorWorkflowNarration => ({ state, body, status, verifiedRunIds });
  if (input.workflow.channelId !== input.proposal.channelId ||
    (result && (result.workflow.id !== input.workflow.id || result.workflow.channelId !== input.workflow.channelId))) {
    return narration("blocked", message(input, "unverified"), "blocked");
  }
  if (!result) return narration("idle", message(input, "not_started"));
  switch (result.status) {
    case "blocked":
      return narration("blocked", message(input, "blocked_state", { reason: result.blocker }), "blocked");
    case "failed":
      return narration("failed", message(input, "failed_state", { reason: result.blocker }), "failed");
    case "waiting_for_approval":
      return narration("waiting_for_approval", message(input, "waiting_for_approval"), "blocked");
    case "idle":
      return narration("idle", message(input, "idle", { reason: result.reason }));
    case "completed":
      return narration("completed", message(input, "completed"));
    case "started": {
      const candidates = result.startedSteps ?? [result];
      const verified = candidates.flatMap((candidate) => {
        if (!candidate.runId) return [];
        const step = input.store.getChannelWorkflowStep(candidate.workflowStep.id);
        if (!step || step.workflowId !== input.workflow.id || step.channelId !== input.workflow.channelId ||
          step.runId !== candidate.runId || step.taskId !== candidate.taskId) return [];
        const run = input.store.getRun(candidate.runId);
        if (!run || run.workflowStepId !== step.id || run.channelId !== step.channelId ||
          run.taskId !== step.taskId || run.teammateId !== step.toParticipantId) return [];
        // Other participants can advance while dispatch awaits startRun. Read the
        // durable status before startedAt so cancelled/approval Runs never queue.
        const state = run.status === "running"
          ? (run.startedAt ? "started" : "blocked")
          : run.status === "succeeded" ? "completed"
            : run.status === "queued" || run.status === "waiting_for_approval" ||
              run.status === "failed" || run.status === "cancelled" ? run.status : "blocked";
        return [{ runId: run.id, label: escapeLabel(step.toParticipantLabel || step.toParticipantId), state }];
      });
      if (verified.length === 0) return narration("blocked", message(input, "unverified"), "blocked");
      const groups = [
        ["started", "started"], ["queued", "queued"],
        ["waiting_for_approval", "runs_waiting"], ["failed", "runs_failed"],
        ["cancelled", "runs_cancelled"], ["completed", "runs_completed"], ["blocked", "unverified"],
      ] as const;
      const body = groups.flatMap(([state, key]) => {
        const participants = [...new Set(verified.filter((entry) => entry.state === state).map((entry) => entry.label))];
        return participants.length ? [message(input, key, { participants: participants.join(", ") })] : [];
      }).join("\n\n");
      const state = (["failed", "blocked", "cancelled", "waiting_for_approval", "started", "queued", "completed"] as const)
        .find((candidate) => verified.some((entry) => entry.state === candidate))!;
      const status = state === "failed" ? "failed"
        : state === "blocked" || state === "cancelled" || state === "waiting_for_approval" ? "blocked" : "ready";
      return narration(state, body, status, [...new Set(verified.map((entry) => entry.runId))]);
    }
  }
}

function message(input: NarrationContext, suffix: string, values?: Readonly<Record<string, string>>): string {
  const preference = input.proposal.responseLanguage;
  const locale = !preference || preference === "follow_user"
    ? inferUserLanguage(input.sourceMessage.body)
    : fallbackResponseLanguage(preference);
  return formatServerCatalogMessage(locale, `daemon.channel.workflow_start.${suffix}`, values);
}

function escapeLabel(label: string): string {
  return label.replace(/[\\`*_{}\[\]()<>!]/gu, "\\$&").replace(/[\r\n]+/gu, " ");
}
