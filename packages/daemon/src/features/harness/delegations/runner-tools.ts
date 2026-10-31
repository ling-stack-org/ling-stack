import {
  delegationBudget,
  delegationId,
  delegationInteger,
  delegationRecord,
  delegationWriteFail,
} from "@ling-stack/core";
import type { DelegationBudgetV1 } from "@ling-stack/contracts";
import type { PiRunnerDelegationToolResult, PiRunnerRunOptions } from "@ling-stack/runner-pi";
import type { DelegationRuntimeObservation, DelegationRuntimeParentTools } from "./runtime-registry.js";

/** Bind the five model tools to one already-verified parent Attempt. */
export function createDelegationRunnerToolHandler(input: {
  readonly tools: DelegationRuntimeParentTools;
  readonly signal: AbortSignal;
}): NonNullable<PiRunnerRunOptions["onDelegationToolCall"]> {
  return async request => {
    const toolCallId = boundedId(request.toolCallId);
    switch (request.toolName) {
      case "spawn_agent": {
        const value = delegationRecord(request.input, ["objective", "required", "participantId", "requestedBudget"]);
        if (typeof value.required !== "boolean") return delegationWriteFail("delegation.invalid_input");
        const observation = input.tools.spawn({ spawnCallId: toolCallId,
          objective: boundedText(value.objective), requestedBudget: requestedBudget(value.requestedBudget),
          required: value.required, ...(value.participantId === undefined ? {} : { participantId: boundedId(value.participantId) }) });
        return observationResult(observation.code ? "blocked" : observation.classification === "terminal" ? "terminal" : "accepted", observation);
      }
      case "send_message": {
        const value = delegationRecord(request.input, ["reservationId", "text"]);
        const result = input.tools.message({ reservationId: boundedId(value.reservationId),
          messageCallId: toolCallId, text: boundedText(value.text) });
        return Object.freeze({ status: result.status, messageId: result.messageId });
      }
      case "wait_agent": {
        const value = delegationRecord(request.input, ["reservationId", "timeoutMs"]);
        const result = await input.tools.wait({ reservationId: boundedId(value.reservationId),
          timeoutMs: boundedInteger(value.timeoutMs, 0, 60_000), signal: input.signal });
        return observationResult(result.observation.code ? "blocked"
          : result.timedOut ? "timed_out" : result.observation.classification === "terminal" ? "terminal" : "observed",
        result.observation, { timedOut: result.timedOut });
      }
      case "interrupt_agent": {
        const value = delegationRecord(request.input, ["reservationId"]);
        const observation = input.tools.interrupt({ reservationId: boundedId(value.reservationId), callId: toolCallId });
        return observationResult(observation.code ? "blocked" : "interrupt_requested", observation);
      }
      case "resume_agent": {
        const value = delegationRecord(request.input, ["reservationId", "expectedStepRevision"]);
        const observation = input.tools.resume({ reservationId: boundedId(value.reservationId),
          expectedStepRevision: boundedInteger(value.expectedStepRevision, 1, Number.MAX_SAFE_INTEGER),
          callId: toolCallId });
        return observationResult(observation.code ? "blocked" : "resume_requested", observation);
      }
    }
  };
}

function observationResult(status: string, value: DelegationRuntimeObservation,
  extra: Pick<PiRunnerDelegationToolResult, "timedOut"> = {}): PiRunnerDelegationToolResult {
  return Object.freeze({ status, reservationId: value.reservationId, childRunId: value.childRunId,
    stepId: value.stepId, state: value.state, stepRevision: value.stepRevision,
    ...(value.code ? { code: value.code } : {}), ...extra });
}

function boundedId(value: unknown): string {
  const id = delegationId(value);
  if (id.length > 1_024) return delegationWriteFail("delegation.invalid_input");
  return id;
}

function boundedText(value: unknown): string {
  const text = delegationId(value);
  if (text.length > 16_000) return delegationWriteFail("delegation.invalid_input");
  return text;
}

function boundedInteger(value: unknown, minimum: number, maximum: number): number {
  const result = delegationInteger(value);
  if (result < minimum || result > maximum) return delegationWriteFail("delegation.invalid_input");
  return result;
}

function requestedBudget(value: unknown): DelegationBudgetV1 {
  const budget = delegationBudget(value);
  if (Object.values(budget).some(entry => entry !== undefined && entry < 1)) {
    return delegationWriteFail("delegation.invalid_input");
  }
  return budget;
}
